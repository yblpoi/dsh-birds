# 实施方案：DSH 本地鸟类识别插件

> 目标：用户在 IM / DSH 会话里发「识鸟」+ 图片或录音 → 本机跑 AI → 直接拿到结果，**不经过大模型、不花 token**。
> 部署环境：Android 上的 DSH Go（内置 PRoot Ubuntu + Node.js，aarch64）。

---

## 1. 结论先行

做了四件事：

1. **定位了第一层扩展点**：DSH 内核自带人类命令注册表 `ctx.commands.register`（`@deepseek-ai/dsh-commands`），命令 handler 直接返回文本，**整个执行过程不启动 agent 回合**。
2. **发现注册表有覆盖不到的入口**：注册表只管**客户端主动路由过来的行**。DSH Go 的 composer 在带附件时整行当普通 prompt 投给 `session/prompt`（`chat_screen.dart:486-493`），服务端 prompt 不做命令路由，于是 `/birds` + 照片仍会进 LLM。补一层回合边界钩子 `agent/pre-step` 兜底（见 §2.1）。
3. **否掉了「让 dsh-im 帮忙路由命令」的路子**：`@xmanrui/dsh-im` 5.10.0 没有本地命令扩展点，带图片的消息一定进 LLM（见 §3 证据）；只有「引用图片」这一处另打了补丁（`scripts/patch-dsh-im.mjs`，见 §2.2），命令路由本身仍靠宿主钩子。
4. **写出了完整插件** `dsh-birds`：图片走 BirdTrace FastViT-MA36，声音走 BirdNET+ V3 11K，地理先验走 Geomodel V3.0.4，三者都在本机 ONNX Runtime 里跑。

---

## 2. 数据流

```
用户: /birds  + 一张照片
        │
        ▼
DSH 内核 commands 服务
  ├─ parseCommand("/birds")             ← @deepseek-ai/dsh-commands/lib/index.js
  ├─ 按 input.attachments: true 收附件
  │    └─ admitCommandAttachments → AttachmentStore 落盘（content-addressed）
  ├─ 记录 command/run 事件
  ▼
dsh-birds 的 handler(invocation)
  ├─ invocation.attachments[i].attachment  →  ctx.get('attachments').imageHostPath(ref)
  ├─ decodeImageToRgb(file, 384)      ← sharp，缺失时回退 ffmpeg
  ├─ ImageClassifier.classify(rgb)    ← onnxruntime-node 跑 model.onnx
  │     输入 [1,3,384,384] float32，值域 [0,1]（图内已内嵌 mean/std）
  │     输出 visual_logits → softmax → top-5
  ├─ formatImageResult(...)           ← 拼中文文本
  └─ return { kind: 'success', text }
        │
        ▼
DSH 内核 settle → 记录 command/done → 把 text 显示给用户
（全程 0 次模型请求）
```

录音同一条链路，只是中段换成：`readAudio` → 重采样 32 kHz → 3 秒分块 → `AcousticClassifier.analyze` → 可选 Geomodel 过滤。

> **附件没有扩展名**：`admitCommandAttachments` 落盘是内容寻址的（`~/.dsh/attachments/v1/objects/<xx>/<sha256>`），文件名只有哈希。所以路由不能只看后缀：`classifyFile()` 先按扩展名分，未知时读前 64 字节按 magic 判断（JPEG/PNG/GIF/WebP/BMP/TIFF/HEIF→image，WAV/MP3/FLAC/OGG/AAC-ADTS/M4A/AMR/WMA/AIFF→audio）。踩过的坑：早期只按扩展名，手机直传的照片必然报 `无法判断文件类型：5ce3a0e2…`，现在由 `test/selftest.mjs` 的无扩展名用例钉住。

### 2.1 兜底：`agent/pre-step` 接管（客户端的坑）

DSH Go（Flutter 客户端）的 `chat_screen.dart:486-493` 里写着：

```dart
// With attachments or a quote the line is a message, even if it starts with "/"
if (drafts.isEmpty && quote == null && generate == null) { ... _slashFor(text) ... }
```

即**只要带了附件（或引用、或生成模式），整行就按普通消息发送**，不再走 `_runSlash`。而服务端 `session/prompt`（`dsh-api-session-controller/lib/index.js:831-874`）**不做任何命令路由**，`/birds` 在那里只是普通文本。结果是客户端的这个判断直接决定了「带图发送 = 烧一个模型回合」。

插件侧无法改客户端，所以在**回合边界**兜底。核对过宿主源码后的关键事实：

| 事实 | 出处 |
| --- | --- |
| `agent/pre-step` 是 waterfall，不调 `next()` 即否决整条链（含内建行为） | `cordis/lib/index.js:896-921`（注释 846-852） |
| 返回 `{kind:'enter', messages: []}` 时，代码走 `if (phase.step === 0 && decision.messages.length === 0) { turnEnds = {kind:'completed'}; return false; }`；但 `messages` 可被外层包装器追加，撑成真实一步 | `dsh-agent-loop/lib/index.js:753-757` |
| 返回 `{kind:'reject'}` 时走 `if (decision.kind === "reject") { turnEnds = {kind:"blocked"}; return false; }`，不进入 `step()` | `dsh-agent-loop/lib/index.js:747-751` |
| `user/message` 是在 `step()` 里才 append 的，位于 pre-step **之后** | `dsh-agent-loop/lib/index.js:861-868` |
| `command/run`、`command/done` 在 `KNOWN_SESSION_EVENT_TYPES` 内、**不在** `SURFACE_EVENT_TYPES` 内，可两参 `session.append` | `dsh-session/lib/index.js` |
| 客户端 `CommandLog` 只认 `data['commandId']` 的 `command/run` + `command/done` 对 | `chat_state.dart:1969-2040` |
| turn 以 `completed` 结束时，optimistic 气泡静默消失；只有 `error/aborted/interrupted` 才显示失败卡片；`blocked` 会在结果下方标一行「本轮已被拦截」，不算失败 | `chat_state.dart:936-955` |
| 监听器顺序由 `options.prepend` 决定（`unshift` 到表头，`waterfall` 从头 `shift()` 取，所以表头＝最外层） | `cordis/lib/index.js:903-916`（`register` 的 `method` 选择）、`:927-933` |
| 内建监听器 `dsh-time-context` 先 `await next()`，再把 time-context 消息 `push` 进 `decision.messages` | `dsh-time-context/lib/index.js:249-253` |

实现（`lib/index.js` 的 `interceptBirds`）：

1. `step !== 1`、signal 已中止、或这一批不是**恰好一条**消息 → `next()`，交回正常链路。
2. 扫描消息里**所有** text part（不是只取第一个），用与内核相同的行语法 `^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])` 解析；命令名不是 `birds` → 放行。
3. 判来源：消息里有 `<dsh_im_*>` 信封 → 走**聊天桥分支**（见下），否则走客户端分支。
4. 客户端分支：自己 mint `cmd-<8位随机>-<自增>`，`session.append('command/run', {commandId, name, args?, source:{kind:'user'}})`；复用命令 handler 的识别逻辑算出文本，再 `append('command/done', {commandId, kind, text})`；`return { kind: 'reject' }`。
5. 聊天桥分支：算出文本后按 `session.id` 暂存 `{text, messageId, at}`，`return next()` 让回合正常开始；随后 `llm/stream` 钩子（`prepend: true`）以 `{type:'text-delta', index:0, text}` + `{type:'finish', reason:{kind:'stop'}}` 接管这次请求，完成后从暂存表删除。

**收口必须用 `reject`（两次实测踩过）**：第一版返回 `{kind:'enter', messages: []}`、默认注册位置，真机上 `command/done` 之后仍紧跟 `step/start` → `request/header`；原因是 `dsh-time-context` 这类监听器跑在外层，`await next()` 拿到空 `enter` 后往里追加了一条 time-context 消息，内核看到 `messages.length === 1` 就走了正常 step。改成 `prepend: true` 后一度在「上下文已送过」的旧会话里成功，但**新会话第一次仍复发**：`dsh-time-context` 自己也用 `{ prepend: true }` 注册且在 profile 插件之后加载，unshift 后仍可能排到我们外面，而新会话第一步必然要追加 time-context / runtime-context 快照。最终改成 `{ kind: 'reject' }`：rejection 不带消息列表，内建包装器（time-context / agent-instructions / action-cards / plan-mode / goal-round-driver / tmux-context / agent / compaction-basic，逐个核对过）要么显式透传 reject、要么只 `return next()`，没人能把回合重新打开。真机复测两次（都带照片）：① 11:05 既有会话的下一回合，`agent/inbox/spliced inserted=1` → `turn/start{turn:2}` → `spliced removed=1` → `command/run` → `command/done{kind:'success'}` → `spliced` → `turn/end{kind:'blocked'}`；② 11:10 全新会话第一步（这一发正是过去会复发的场景），`spliced inserted=1` → `turn/start{turn:1}` → `spliced` → `command/run` → `command/done{kind:'success'}` → `spliced` → `turn/end{kind:'blocked'}`。两次全段都没有 `step/start`、没有 `request/header`、没有 `user/message`；UI 显示识别结果 + 一行「本轮已被拦截」。另外 `test/host-mock.mjs` 里用 `composeWaterfall([timeContextLike, preStep[0]])` 把包装器摆在钩子外层，断言拿到的仍是 `{kind:'reject'}` 且不带 `messages`，把这个不变量钉住。

**聊天桥会把命令行夹在中间（真机踩过）**：dsh-im 接的 QQ / 微信不直接发用户那一行，而是把一条消息拆成多个 text part —— `<dsh_im_source>{...}</dsh_im_source>` 信封、每张图的 `图片 1（原图文件：…）` 说明、`<dsh_im_files>{...}` 文件清单，用户输入的 `/birds` 只是其中一个 part。第一版用 `content.find(part => part.type === 'text')` 取第一个 text part，拿到的必然是信封文本，命令行永远解析不到，于是 QQ 里的照片 + `/birds` 被当成普通 prompt 送进模型（真机 session：`command/done` 不存在，直接 `request/header{provider:'deepseek-account', model:'deepseek-flash'}`，模型自己调 bash/read_image）。修法是遍历全部 text part 找命令行，附件仍从 `type:'image'|'file'` 且带 `attachment` 的 part 取；`test/host-mock.mjs` 用一份 QQ 形态的消息（信封 + `/birds` + 图注 + image + 清单）钉住这个行为。

**为什么只认单条批次**：`inbox.claim()` 在 pre-step 之前就把这批消息从待发队列里取走了，且不可撤销。若同批还有用户排队的别的 prompt，一起吞掉就是丢输入。所以宁可在多消息批次上放行（退回旧行为），也不冒吞消息的风险。

**结果不止英文**：名表按标签行号对齐（图片 10480 行、声音 11560 行），每份都记着生成时标签文件的 SHA-256；分类器读完标签先 `bindLabels(kind, labelDigest(text))`，指纹不符就停用名表退回英文名（否则行号一错就会把别种鸟的中文名贴上来）。名表来自 IOC World Bird List 15.1 / 14.2（经 SuperPicky 的 `ioc/birdname.db` 整理），覆盖率图片 9826/10480、声音 9794/11560，未覆盖的是 BirdNET 里昆虫/蛙等非鸟群。排版在 `format.mjs` 的 `speciesLabel()`：有中文就「中文名（English）」，没有就英文名，声音再退学名。

**聊天桥为什么必须换一种收口（11:16 真机踩过）**：dsh-im 的 bundle 里 `command/done` 出现 **0 次** —— 它只转发 assistant 文本（`assistant/chunk` 的 `text-delta` 与 `assistant/message` 的 content，`turn/end` 时按 turn 取出推送），并且把 `turn/end` 的 reason 映射成错误码：`turn-blocked → TURN_BLOCKED`、`turn-interrupted/turn-aborted → TURN_INTERRUPTED`，只有 `reason.kind === 'completed'` 的回合才会把 assistant 文本发给 QQ。所以在 QQ 里发「照片 + /birds」时，`reject` 的结果是机器人回一句「本轮处理被阻止，未能完成。错误码：TURN_BLOCKED」，识别结果整个丢失。

修法：桥来的消息不 reject，而是把结果暂存、让回合正常跑，然后用 `llm/stream` 短路模型调用。

**为什么桥用 `llm/stream` 而不算伪造**：短路点在 `dsh-llm/lib/index.js:2398-2402` 的 `ctx.waterfall(this, 'llm/stream', options, () => this.adapterStream(options, prepared))`，不调 `next()` 就不会走 adapter、不发网络请求。chunk 是 provider-neutral 协议，内核的 assembler 消费后由 `step()` **自己** `createAssistantMessage(...)` 并 `append('assistant/message', …)`（`dsh-agent-loop/lib/index.js:941-955`），`source: {provider, model}` 也由内核填 —— 插件只提供流，不写事件，重放校验（要求 `source.kind === 'model'` 与 provider/model）天然成立。代价是 ① 日志里必然有 `request/header` / `request/context`（`buildRequest` 里就记账，`:1017-1044`），但没有真实请求、没有用量；② 回合必须以 `completed` 结束，桥才会推送。

**客户端路径则不需要这么做**：DSH 客户端本来就渲染 `command/run` + `command/done`，用 `reject` 更省（不建请求、不产生 request/header、结果卡片下方标「本轮已被拦截」）。两条路径共用同一份识别逻辑，只是投递方式不同。

**correlation 与清理**：暂存键是 `sessionId`，兑现前核对请求里的 user 消息 id 是否就是被接管的那条（不是就不动，留给真正的回合），兑现即删除；120 s 内没等到请求就作废。teardown 时整表清空。`test/host-mock.mjs` 用 `driveModelCall()` 驱动 `llm/stream` 钩子，钉住：桥消息→不写 command 事件、下次请求拿到本地文本、只消费一次、不串会话、不串回合。

**「引用」的消息只剩文件名**：dsh-im 的 QQ 适配器取引用时只映射 `{kind, name}`（bundle 里的 `function iY(n)`：`attachments.map(r => { const s = ei(r?.filename); return { kind: Qne(r), ...s ? { name: s } : {} }; })`），平台 CDN 的 `url` 在进 Harness 之前就丢了；引用摘要 `zNe(n)` → `WNe(n)` 被序列化成 `<dsh_im_reply_to>…</dsh_im_reply_to>` 的 text part，被引用的图**也不会**出现在本条消息的 `images` 里（`Tv(n,{deferImages:true})` 算完文本就 `return s`）。所以 QQ 里「引用一张鸟图 + /birds」，插件拿到的只有一行 JSON 和一个文件名，回「没有收到图片或录音」。

字节其实在本机：dsh-im 把群聊抄进 `~/.dsh/integrations/dsh-im/group-history.sqlite`，附件行是 `attachments(id, message_id, source_attachment_key, name, mime_type, size_bytes, relative_path, status, last_error)`，实体文件在同目录的 `group-files/<groupId>/<messageId>/<attachmentId>`；它收到的图也落在工作区 `.dsh-im/inbound/<时间>-<随机>/01-1-<name>`。两处都以平台文件名索引，正好是信封里保留下来的那个字段，于是 `lib/im/quoted.mjs` 的 `resolveQuotedMedia()` 按名回查：① `<dsh_im_source>` 的 `channel` + `chatId` 对上 `groups(channel, platform_group_id)`，在库里找 `status='ready'`、`relative_path` 非空且文件仍在的同名附件（`order by m.sent_at desc limit 3`，认最新的）；② 落空就扫 `.dsh-im/inbound/**`，接受 `name` 或 `-<name>` 后缀；③ 都没有就返回 `unresolved`，文案明说「只有发给过机器人的图片才会被存下来」。取到的文件仍要过 `recognizeFile` 的 `classifyFile()` 内容嗅探。

安全边界：`DatabaseSync(path, { readOnly: true })` 只读打开（`node:sqlite` 在 Node 22+ 内置，动态 import 失败就跳过这一步只走 inbound），查询参数只有文件名与群标识，路径由库里的 `relative_path` 拼出且 `stat` 校验 `isFile`、`size > 0`；`size_bytes` 与磁盘不符只 warn 并以磁盘字节为准。不会顺着信封读任意路径 —— 群里别人的原图本来就不在库里。

**url 其实在推送里，是 dsh-im 丢的（5.8.0 与 5.10.0 实测）**：QQ 推送的 `msg_elements[0].attachments[i]` 带 `content_type` / `url` / `filename`，`@tencent-connect/qqbot-nodejs` 的 `QuotedAttachment` 类型就是照这个写的（`src/middleware/quote-ref.ts`），dsh-im 的 `qqReplyReference()`（`src/channels/qq/qq-bridge.mjs:190`）也读同一个对象，只是 `map` 成 `{kind, name}` 时把 `url` 扔了；5.10.0 的 `FY` 与 5.8.0 的 `iY` 行为一致，升级不解决。所以「按名回查」只是无补丁时的降级路径。

**补 dsh-im 一处洞：`scripts/patch-dsh-im.mjs`**。脚本改的是 dsh-im 构建产物里 QQ inbound 构造器（`function rY(n,{fetchImpl:t=fetch}={}){…}`，紧跟 `let e=iY(n);return{content:aC(n),images:o,files:a,…}`）：把引用附件里能用的图片同样 push 进本条消息的 `images`。这样引用图走的就是**普通图片那条 Harness 附件通道**（dsh-im 自己的 `hs()` 下载 + 平台 CDN 白名单 `kVe`，成功后由 `inbound-file` 暂存并 admit 成 image part），插件与模型都能看到；失败也只是这张图当没引，不影响其他附件。

约束与风险，全部写进了脚本头和 README：

- 只搬运**图片**（`content_type` 以 `image/` 开头，或文件名是图片后缀），要求 `https` 地址，并按 `url` 去重（同一条消息已经带了的附件不重复搬）；语音/文件仍按元数据处理。
- 按 5.8.0 的压缩产物写死两处锚点，**各命中一次才动手**；认不出就抛 `UnsupportedBundleError` 并拒绝修改，宁可不改。
- 先备份成 `lib/index.js.orig-xxxxxxxx`（带内容摘要，重装后再打不会覆盖备份），`--restore=` 可还原；重复执行是幂等的。
- 改的是**第三方插件的构建产物**：dsh-im 升级或 profile 重装会覆盖，需要重跑脚本；因此它只作为「引用图」的补丁，不承担命令路由。
- `test/selftest.mjs` 用一份含两处锚点的小样本验证：改写生效、幂等、认不出时抛错；再用 `new Function` 把生成的 `__qbQuotedMedia` 装进桩 `hs`/`kVe` 跑真实入参 —— 引用图变成附件、`load()` 走平台白名单、重复/无 url/非图片/非白名单域名都不搬。

**设置里的入口：`client.js` + `lib/im-patch-api.mjs`（1.0.0 起）**。变换本体在 `lib/dsh-im-patch.mjs`，`scripts/patch-dsh-im.mjs` 只是它的终端外壳——运行时（宿主半体）不能 import `scripts/`，有的装机方式只搬 `lib/`，那样插件会整块 import 失败（1.0.0 首次真机部署踩到：`ERR_MODULE_NOT_FOUND .../dsh-birds/scripts/patch-dsh-im.mjs`，diagnostics 里多一条 did not activate）。宿主 0.2.x 的插件管理页**只提供布局**，卡片本身要插件自带浏览器半体：`package.json` 里声明 `dsh.manifestVersion: 1`、`dsh.client: { platform: 'web', inject: [] }` 和 `exports['./client']`（只声明 client 却没有这个 export，`dsh-client-modules` 会直接抛错），`client.js` 用 `window.__ModuleLoader__.load({ id: 'dsh-birds', factory })` 包成单文件，`exports.inject = ['slots']`，在 `apply` 里注册三处槽：

| 槽 | key | 说明 |
| --- | --- | --- |
| `plugins.bundle.config` | `dsh-birds` | 当前宿主插件管理页的「包配置」区（`renderSlot('plugins.bundle.config', { view: 'page' }, { entryKey: pkg.name })`） |
| `plugins.row.config` | `dsh-birds#dsh-birds` / `dsh-birds#birds` | 行级配置区，key 由 bundle 名 + `cordis.patch.yml` 的行 id 拼成；历史行 id 也注册一份，未命中的只是留在 ledger 里 |
| `settings.plugin.item` | `dsh-birds` | 旧宿主（≤0.1.5）的设置页槽，向后兼容 |

keyed 槽的 key 是共享命名空间，**同一个 key 注册两次会抛错**，而客户端 `apply` 抛错等于整个插件起不来 —— 所以这里只用自己的包名。卡片本身是普通 React：`view === 'summary'` 时返回 `null`（折叠行里不塞整张卡），否则画标题、状态行、每个 bundle 的路径/版本/备份、以及「注入补丁 / 还原 / 刷新」三个按钮，并 fetch 三条本机路由：

| 路由 | 作用 |
| --- | --- |
| `GET /api/dsh-birds/dsh-im` | 找到哪些 `profiles/*/node_modules/@xmanrui/dsh-im/lib/index.js`、各自是否已打补丁、备份列表、插件版本 |
| `POST /api/dsh-birds/dsh-im/patch` | 调 `patchDshImSource()` 写回（先备份 `index.js.orig-<sha8>`；幂等；认不出就报错不写） |
| `POST /api/dsh-birds/dsh-im/restore` | 用最近的备份还原；内容已一致时不动文件（连续点两次是幂等的） |

路由用 `ctx.inject(['webServer'], scoped => scoped.effect(...))` 注册，三条都是 `{ kind: 'exact', path }`；处理器只接受回环请求（`remoteAddress` + `Host` + `Sec-Fetch-Site`），写入类端点还要求同源证据（`Sec-Fetch-Site: same-origin` 或 `Origin` 与 Host 相符，桌面壳转发链则认宿主 Cookie）。写盘走「临时文件 + rename」并保留原 mode，避免宿主读到半截 bundle。宿主没有 `webServer`（无界面的组合）时整段静默跳过。

手机侧能显示这张卡：DSH Go 的 `app/lib/plugins/seams/slot_catalog.dart` 把 `plugins.bundle.config` / `plugins.row.config` 都列进 `Slots.seated`（策略 `SeatPolicy.p0BundleConfig`，`inference: SlotInference.bundleConfig`），`plugin_detail_sheet.dart` 的 `configSeated` 分支会把它作为 **page 岛**（WebView 渲染 DSH Web 的该片段）放进插件详情页，所以卡片要按窄屏设计（按钮够大、状态行可换行、不依赖 hover）。

---

## 3. 为什么不能改 dsh-im（证据）

| 事实 | 出处 |
| --- | --- |
| 宿主只暴露只读查询与主动投递服务 | `plugin-src/host/index.mjs`：`ctx.provide('dshIm', …)` 里只有 `consumeInbound`/`describeConversation`/`send`/`listTargets` 等 |
| 命令最终都转给内核 | `plugin-src/host/harness-command-executor.mjs`：`gateway.invoke({namespace:'commands', method:'execute'})` |
| 注入点是测试专用 | 同上：`internals.commandExecutor` 只在测试里传 |
| 带图片的消息进不了命令分支 | `src/channels/shared/text-harness-bridge.mjs:466` 的 `commandRunner` 选择逻辑；`#process`（1086 行）只本地处理 `/help`、`/status`、workspace 系列、`/new`、`/compact` |
| 同一 token 不能两处轮询 | Telegram `getUpdates` 单消费者语义 |

所以：**新写一个独立 cordis host 插件**，用 DSH 的命令注册表落地；需要「连 /birds 都不打」时，插件可选起一条自己的 Telegram 长轮询桥（用独立 bot token），媒体在进入 Harness 之前就被消化掉。

---

## 4. 模型接入细节（全部核对过）

### 4.1 BirdTrace FastViT-MA36-10K（图片）

| 项 | 值 |
| --- | --- |
| 输入 | `image`，float32，`[1, 3, 384, 384]`，batch 硬编码为 1 |
| 输出 | `visual_logits`，float32，`[1, 10480]`，**raw logits** |
| 归一化 | 图内已含 `(x - mean) / std`（mean 0.485/0.456/0.406，std 0.229/0.224/0.225），**不含 ÷255** |
| 标签 | `classes.json`，10480 条 `{index, species_id, species_name}`，下标即输出维 |
| 体积 | 222,385,590 B |
| 许可 | **CC-BY-NC-4.0（禁商用）** |

代码里 `lib/imageclf.mjs` 只做 `/255`，然后直接 `runSession`，最后 softmax —— 三处最容易踩的坑都写在注释里了。

### 4.2 BirdNET+ V3.0 preview3.1 Global 11K（声音）

| 项 | 值 |
| --- | --- |
| 采样率 | **32 kHz 单声道**（V2 是 48 kHz） |
| 输入 | 原始波形，**STFT / 梅尔谱在图内**，所以插件里没有 FFT 代码 |
| 输出 | predictions + embeddings 两个张量，取宽的那个 2-D |
| 标签 | `…_Labels.csv`，**分号分隔**，列 `id;sci_name;com_name;gbif;class;order` |
| 默认参数 | chunk 3.0 s、overlap 0、min_conf 0.15 |
| 权重 | **FP16**，输入必须按 `inputMetadata[x].type` 转 float16 |

### 4.3 BirdNET+ Geomodel V3.0.4（地理先验）

| 项 | 值 |
| --- | --- |
| 输入 | `input`，float32 `[batch, 3]` = **`[lat, lon, week]` 原始度数**（lat ±90、lon ±180、week 1..48），**不做 +90/+180 归一化** |
| 输出 | `probabilities`，float32 `[batch, 14082]`，**已含 sigmoid** |
| 与声学模型的关系 | 14K 与 11K **不同长不同序**，必须按**学名** join |
| 官方用法 | **阈值硬过滤**（`sf_thresh = 0.03`），不是加权相乘 |

`lib/geo.mjs` 按官方口径实现：`allowedSpecies(lat, lon, week, {threshold})` 返回允许集合，`filterByAllowedSpecies` 按学名归一化后过滤；模型缺失时静默降级。

> **踩过的坑：tensor dims 不能写 `null`**。图里 batch 是 symbolic 的，所以最初按图声明传了 `[null, 3]`，结果 onnxruntime-node 直接抛 `TypeError: dims[0] must be an integer, got: null`。因为 `recognize.mjs` 用 try/catch 包住地理先验（失败只 warn），这个错误会**静默吞掉整个地理过滤**。现在固定传 `[1, 3]`，并在 `test/selftest.mjs` 里加了断言钉死形状。

---

## 5. Android / DSH Go 部署步骤

```bash
# ① 进 DSH Go 的 Linux 环境
uname -m                       # 应为 aarch64
node -v                        # 应为 v22.19+

# ② 装插件（从 GitHub 仓库装，不需要 npm 账号）
#    运行时依赖只有 onnxruntime-node，随 npm install 一起装好；
#    ffmpeg 不再需要 apt —— 插件加载时自己下静态二进制
cd ~/.dsh/profiles/web                   # DSH Go 的 profile 叫 web；桌面端通常是 desktop
npm install github:yblpoi/dsh-birds      # 从仓库装进 node_modules/dsh-birds
# 在 cordis.patch.yml 顶层追加：
#   - insert:
#       - id: dsh-birds
#         name: dsh-birds
#         config: { modelsDir: ~/.dsh/models/bird }

# ③ 重启 DSH：模型（约 250 MB）与静态 ffmpeg（约 50 MB）由插件自动下载，
#    进度看 /birdstatus；不需要手动跑脚本
#    宿主机 PATH 里已有 ffmpeg 时只补模型，不再下那 50 MB 自带副本
#    Geomodel 只在 GitHub Releases 上，某些移动网络直连会连续超时，
#    因此它额外挂了 https://gh-proxy.com/<原地址> 中转线路（同一份字节，校验不变）

# ④ 在会话里敲（两个命令都应出现在命令面板里）
/birdstatus          # 六个模型文件与推理引擎状态
/birds               # 附带图片或录音，本机识别
```

### onnxruntime-node 为什么能在 Android 跑

包里就带着 `bin/napi-v6/linux/arm64/onnxruntime_binding.node`（551 KB）与 `libonnxruntime.so.1`（25 MB）；`os` 字段只是包管理器的安装守卫；`lib/binding.js` 用 `process.platform`/`process.arch` 拼路径，PRoot 里是 `linux`/`arm64`，天然命中。**不需要重编译，也不需要 wasm 兜底**（wasm 只是文档里留的后路）。

### 从 Android 侧进 PRoot（调试用）

DSH Go 的 Linux 环境是 app 内置的 `libproot.so` 拉起来的，Android 侧没有可以直接 `sh` 进去的入口。手动进入需要复刻它的环境变量（这些值在 `/proc/<proot pid>/environ` 里能直接读到）：

| 变量 | 作用 | 缺失时的报错 |
| --- | --- | --- |
| `LD_LIBRARY_PATH` | 指向 app 的 `lib/arm64` | `CANNOT LINK EXECUTABLE: library "libtalloc.so" not found` |
| `PROOT_LOADER` | `libproot-loader.so` 的绝对路径 | loader 拉起失败 |
| `PROOT_L2S_DIR` | `<rootfs>/root/.l2s` | link2symlink 失效 |
| `PROOT_TMP_DIR` | app cache 下的临时目录 | `proot error: can't create glue rootfs` |

Magisk 的 `su` 可以用；`adb root` 和 `run-as` 在 production build 上都会被拒。写进 rootfs 的文件要 `chown` 成 app 的 uid，否则插件读不到。

---

## 6. 验收清单

| 检查 | 命令 | 期望 |
| --- | --- | --- |
| 命令注册 | 会话里输入 `/` | 出现 `birds`、`birdstatus` |
| 模型状态 | `/birdstatus` | 六个文件都是 ✓，推理引擎可用 |
| 图片识别 | `/birds` + 鸟照 | 返回 top-5，含「0 token」字样 |
| 录音识别 | `/birds` + 3 秒以上鸟鸣 | 返回物种 + 时间段 + 命中段数 |
| 带附件不走模型 | `/birds` + 附件在 DSH Go 里发送 | 只出现一条命令结果，**没有 user 气泡进模型、没有新的 assistant 回复** |
| token 计量 | 观察会话的 usage | **该回合没有模型请求** |
| 多消息批次不误吞 | 排队一条普通 prompt 后紧接 `/birds` | 两条都被正常处理，普通 prompt 照常进模型 |
| 单元自测 | `node test/selftest.mjs`、`node test/host-mock.mjs`、`node test/imports.mjs`、`node test/settings.mjs` | 139 + 72 + 20 + 67 = 298 条断言全 PASS |
| 引用图片回查 | selftest 用临时 `group-history.sqlite` + `group-files/` 造同名附件，驱动 `resolveQuotedMedia()` | 命中 → 拿到实体文件并嗅探为 image；未收到过的图 → `unresolved`；纯文本引用 → 空 |
| dsh-im 补丁 | selftest 用两处锚点的小样本跑 `patchDshImSource()`，再以桩 `hs`/`kVe` 执行生成的 `__qbQuotedMedia` | 改写生效且幂等；认不出抛 `UnsupportedBundleError`；引用图变成附件并走平台白名单，重复/无 url/非图片/非白名单域名不搬 |
| 聊天桥形态的消息 | host-mock 里用 QQ 形态（信封 + `/birds` + 图注 + image + 文件清单）驱动 pre-step | 被接管、写出 command/run + command/done、不落到模型 |
| 中英对照名表 | selftest 校验名表行数、抽样中文名、指纹不符时停用 | 图片 9826/10480、声音 9794/11560 |
| 设置卡路由 | settings 测试：假 dsh-im 安装目录 + 假 req/res 驱动三条路由 | 状态 200、打补丁 changed=1 且写入成功、二次 patch 幂等、还原回原文、非回环/跨站/方法不符/缺同源证据都拒绝、认不出的产物不改 |
| 设置卡浏览器半体 | settings 测试：桩 `window.__ModuleLoader__` + 桩 `require('react')` 加载 `client.js` | 注册 `plugins.bundle.config`（key `dsh-birds`）、`plugins.row.config`（两个行 id）、旧 `settings.plugin.item`；summary 返回 null；各种状态文案与按钮可用性正确 |
| 版本与清单 | `package.json` | `version` 1.0.0，且 `dsh.manifestVersion`、`dsh.client`、`exports['./client']` 齐备 |

---

## 7. 已知限制

1. BirdTrace **不判断「画面里有没有鸟」**，它永远给 10480 类里的 top-k。拍只猫也会得到一个「最像的鸟」。
2. BirdNET+ V3 是 **Developer Preview**，官方明说物种表待清理、不检测人声、对雨/风/引擎鲁棒性有限。
3. 分数**不是校准概率**；同一物种在不同录音里分数不可横向比较。
4. 手机内存：图片模型约 212 MB 权重常驻，声学模型 30–50 MB。两个都懒加载，卸载时释放。
5. Geomodel 需要经纬度；不配就只用声学结果。
6. 许可证：BirdTrace **CC-BY-NC-4.0 禁商用**；BirdNET+ 按其 TERMS_OF_USE。

---

## 8. 后续可做

- 批量：一条消息多张图/多段录音已支持（handler 遍历附件）。
- 自定义物种白名单：把 `geo.allowedSpecies` 换成静态集合即可复用同一套过滤。
- 结果落盘：handler 里加 `fs.writeFile` 写 CSV，配合 dsh-im 的文件回传能力发回合。
- 量化：BirdTrace 官方无 fp16/int8 变体，若要省内存可自行做 QDQ 动态量化，但需要验证 Top-1 掉点。
