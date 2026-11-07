# 实施方案：DSH 本地鸟类识别插件

> 目标：用户在 IM / DSH 会话里发「识鸟」+ 图片或录音 → 本机跑 AI → 直接拿到结果，**不经过大模型、不花 token**。
> 部署环境：Android 上的 DSH Go（内置 PRoot Ubuntu + Node.js，aarch64）。

---

## 1. 结论先行

做了四件事：

1. **定位了第一层扩展点**：DSH 内核自带人类命令注册表 `ctx.commands.register`（`@deepseek-ai/dsh-commands`），命令 handler 直接返回文本，**整个执行过程不启动 agent 回合**。
2. **发现注册表有覆盖不到的入口**：注册表只管**客户端主动路由过来的行**。DSH Go 的 composer 在带附件时整行当普通 prompt 投给 `session/prompt`（`chat_screen.dart:486-493`），服务端 prompt 不做命令路由，于是 `/birds` + 照片仍会进 LLM。补一层回合边界钩子 `agent/pre-step` 兜底（见 §2.1）。
3. **否掉了改 dsh-im 的路子**：`@xmanrui/dsh-im` 5.10.0 没有本地命令扩展点，带图片的消息一定进 LLM（见 §3 证据）。
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
3. 自己 mint `cmd-<8位随机>-<自增>`，`session.append('command/run', {commandId, name, args?, source:{kind:'user'}})`。
4. 复用命令 handler 的识别逻辑算出文本，再 `append('command/done', {commandId, kind, text})`。
5. `return { kind: 'reject' }`。

**收口必须用 `reject`（两次实测踩过）**：第一版返回 `{kind:'enter', messages: []}`、默认注册位置，真机上 `command/done` 之后仍紧跟 `step/start` → `request/header`；原因是 `dsh-time-context` 这类监听器跑在外层，`await next()` 拿到空 `enter` 后往里追加了一条 time-context 消息，内核看到 `messages.length === 1` 就走了正常 step。改成 `prepend: true` 后一度在「上下文已送过」的旧会话里成功，但**新会话第一次仍复发**：`dsh-time-context` 自己也用 `{ prepend: true }` 注册且在 profile 插件之后加载，unshift 后仍可能排到我们外面，而新会话第一步必然要追加 time-context / runtime-context 快照。最终改成 `{ kind: 'reject' }`：rejection 不带消息列表，内建包装器（time-context / agent-instructions / action-cards / plan-mode / goal-round-driver / tmux-context / agent / compaction-basic，逐个核对过）要么显式透传 reject、要么只 `return next()`，没人能把回合重新打开。真机复测两次（都带照片）：① 11:05 既有会话的下一回合，`agent/inbox/spliced inserted=1` → `turn/start{turn:2}` → `spliced removed=1` → `command/run` → `command/done{kind:'success'}` → `spliced` → `turn/end{kind:'blocked'}`；② 11:10 全新会话第一步（这一发正是过去会复发的场景），`spliced inserted=1` → `turn/start{turn:1}` → `spliced` → `command/run` → `command/done{kind:'success'}` → `spliced` → `turn/end{kind:'blocked'}`。两次全段都没有 `step/start`、没有 `request/header`、没有 `user/message`；UI 显示识别结果 + 一行「本轮已被拦截」。另外 `test/host-mock.mjs` 里用 `composeWaterfall([timeContextLike, preStep[0]])` 把包装器摆在钩子外层，断言拿到的仍是 `{kind:'reject'}` 且不带 `messages`，把这个不变量钉住。

**聊天桥会把命令行夹在中间（真机踩过）**：dsh-im 接的 QQ / 微信不直接发用户那一行，而是把一条消息拆成多个 text part —— `<dsh_im_source>{...}</dsh_im_source>` 信封、每张图的 `图片 1（原图文件：…）` 说明、`<dsh_im_files>{...}` 文件清单，用户输入的 `/birds` 只是其中一个 part。第一版用 `content.find(part => part.type === 'text')` 取第一个 text part，拿到的必然是信封文本，命令行永远解析不到，于是 QQ 里的照片 + `/birds` 被当成普通 prompt 送进模型（真机 session：`command/done` 不存在，直接 `request/header{provider:'deepseek-account', model:'deepseek-flash'}`，模型自己调 bash/read_image）。修法是遍历全部 text part 找命令行，附件仍从 `type:'image'|'file'` 且带 `attachment` 的 part 取；`test/host-mock.mjs` 用一份 QQ 形态的消息（信封 + `/birds` + 图注 + image + 清单）钉住这个行为。

**为什么只认单条批次**：`inbox.claim()` 在 pre-step 之前就把这批消息从待发队列里取走了，且不可撤销。若同批还有用户排队的别的 prompt，一起吞掉就是丢输入。所以宁可在多消息批次上放行（退回旧行为），也不冒吞消息的风险。

**结果不止英文**：名表按标签行号对齐（图片 10480 行、声音 11560 行），每份都记着生成时标签文件的 SHA-256；分类器读完标签先 `bindLabels(kind, labelDigest(text))`，指纹不符就停用名表退回英文名（否则行号一错就会把别种鸟的中文名贴上来）。名表来自 IOC World Bird List 15.1 / 14.2（经 SuperPicky 的 `ioc/birdname.db` 整理），覆盖率图片 9826/10480、声音 9794/11560，未覆盖的是 BirdNET 里昆虫/蛙等非鸟群。排版在 `format.mjs` 的 `speciesLabel()`：有中文就「中文名（English）」，没有就英文名，声音再退学名。

**为什么不用 `llm/stream` 伪造窗口**：那条路也能短路（`api-catalog.js:5019-5024`），但 yield 出来的 chunk 会被写进 `assistant/message`，属于伪造模型输出；而 `assistant/message` 的重放校验要求 `source.kind === 'model'` 与 provider/model，下次加载 session 会直接失败。`command/run` + `command/done` 才是客户端本来就渲染、且没有任何伪造嫌疑的通道。

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
| 单元自测 | `node test/selftest.mjs`、`node test/host-mock.mjs`、`node test/imports.mjs` | 120 + 56 + 17 = 193 条断言全 PASS |
| 聊天桥形态的消息 | host-mock 里用 QQ 形态（信封 + `/birds` + 图注 + image + 文件清单）驱动 pre-step | 被接管、写出 command/run + command/done、不落到模型 |
| 中英对照名表 | selftest 校验名表行数、抽样中文名、指纹不符时停用 | 图片 9826/10480、声音 9794/11560 |

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
