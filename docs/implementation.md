# 实施方案：DSH 本地鸟类识别插件

> 目标：用户在 IM / DSH 会话里发「识鸟」+ 图片或录音 → 本机跑 AI → 直接拿到结果，**不经过大模型、不花 token**。
> 部署环境：Android 上的 DSH Go（内置 PRoot Ubuntu + Node.js，aarch64）。

---

## 1. 结论先行

做了三件事：

1. **定位了唯一可行的扩展点**：DSH 内核自带人类命令注册表 `ctx.commands.register`（`@deepseek-ai/dsh-commands`），命令 handler 直接返回文本，**整个执行过程不启动 agent 回合**。这就是「不花 token」的官方口径。
2. **否掉了改 dsh-im 的路子**：`@xmanrui/dsh-im` 5.10.0 没有本地命令扩展点，带图片的消息一定进 LLM（见 §3 证据）。
3. **写出了完整插件** `dsh-birds`：图片走 BirdTrace FastViT-MA36，声音走 BirdNET+ V3 11K，地理先验走 Geomodel V3.0.4，三者都在本机 ONNX Runtime 里跑。

---

## 2. 数据流

```
用户: /birdid  + 一张照片
        │
        ▼
DSH 内核 commands 服务
  ├─ parseCommand("/birdid")            ← @deepseek-ai/dsh-commands/lib/index.js
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

---

## 3. 为什么不能改 dsh-im（证据）

| 事实 | 出处 |
| --- | --- |
| 宿主只暴露只读查询与主动投递服务 | `plugin-src/host/index.mjs`：`ctx.provide('dshIm', …)` 里只有 `consumeInbound`/`describeConversation`/`send`/`listTargets` 等 |
| 命令最终都转给内核 | `plugin-src/host/harness-command-executor.mjs`：`gateway.invoke({namespace:'commands', method:'execute'})` |
| 注入点是测试专用 | 同上：`internals.commandExecutor` 只在测试里传 |
| 带图片的消息进不了命令分支 | `src/channels/shared/text-harness-bridge.mjs:466` 的 `commandRunner` 选择逻辑；`#process`（1086 行）只本地处理 `/help`、`/status`、workspace 系列、`/new`、`/compact` |
| 同一 token 不能两处轮询 | Telegram `getUpdates` 单消费者语义 |

所以：**新写一个独立 cordis host 插件**，用 DSH 的命令注册表落地；需要「连 /birdid 都不打」时，插件可选起一条自己的 Telegram 长轮询桥（用独立 bot token），媒体在进入 Harness 之前就被消化掉。

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

---

## 5. Android / DSH Go 部署步骤

```bash
# ① 进 DSH Go 的 Linux 环境
uname -m                       # 应为 aarch64
node -v                        # 应为 v22.19+

# ② 装运行时依赖
apt update && apt install -y ffmpeg

# ③ 装插件（从 GitHub 仓库装，不需要 npm 账号）
cd ~/.dsh/profiles/desktop
npm install github:yblpoi/dsh-birds      # 从仓库装进 node_modules/dsh-birds
# 在 cordis.patch.yml 顶层追加：
#   - insert:
#       - id: dsh-birds
#         name: dsh-birds
#         config: { modelsDir: ~/.dsh/models/bird }

# ④ 下模型（约 250 MB，断点续传）
cd node_modules/dsh-birds && node scripts/download-models.mjs

# ⑤ 重启 DSH，在会话里敲
/birdstatus
```

### onnxruntime-node 为什么能在 Android 跑

包里就带着 `bin/napi-v6/linux/arm64/onnxruntime_binding.node`（551 KB）与 `libonnxruntime.so.1`（25 MB）；`os` 字段只是包管理器的安装守卫；`lib/binding.js` 用 `process.platform`/`process.arch` 拼路径，PRoot 里是 `linux`/`arm64`，天然命中。**不需要重编译，也不需要 wasm 兜底**（wasm 只是文档里留的后路）。

---

## 6. 验收清单

| 检查 | 命令 | 期望 |
| --- | --- | --- |
| 命令注册 | 会话里输入 `/` | 出现 `birdid`、`birdstatus` |
| 模型状态 | `/birdstatus` | 六个文件都是 ✓，推理引擎可用 |
| 图片识别 | `/birdid` + 鸟照 | 返回 top-5，含「0 token」字样 |
| 录音识别 | `/birdid` + 3 秒以上鸟鸣 | 返回物种 + 时间段 + 命中段数 |
| token 计量 | 观察会话的 usage | **该回合没有模型请求** |
| 单元自测 | `node test/selftest.mjs`、`node test/host-mock.mjs`、`node test/imports.mjs` | 全部断言 PASS |

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
