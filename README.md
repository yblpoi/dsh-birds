# dsh-birds — DeepSeek Harness 本地鸟类识别插件

在 **不调用任何大模型** 的前提下，用本机 CPU 跑两个识别模型：

| 输入 | 模型 | 类数 | 输出 |
| --- | --- | --- | --- |
| 图片 | BirdTrace FastViT-MA36-10K（ONNX, FP32） | 10,480 | top-k 物种 + 相对置信度 |
| 录音 | BirdNET+ V3.0 preview3.1 Global 11K（ONNX, FP16） | 11,000+ | 每个物种的最高分与时间段 |
| 录音（可选） | BirdNET+ Geomodel V3.0.4 Global 14K（ONNX, FP16） | 14,082 | 按经纬度 + 周次筛掉不可能出现的物种 |

命令执行完直接返回文本，**不进入 LLM 回合、不产生 token 费用**。这首先是 DSH 命令注册表（`ctx.commands.register`）的官方能力；对「客户端把带附件的行当普通消息发」的情况，插件再用回合边界钩子 `agent/pre-step` 兜底（见 §4）。

---

## 1. 为什么这么做（而不是改 dsh-im）

先把结论摆出来，省得你也去翻一遍源码：

- `@xmanrui/dsh-im` 5.10.0 **没有**「本地回答、不进 LLM」的扩展点。它的宿主入口 `plugin-src/host/index.mjs` 只用 `ctx.provide('dshIm', …)` 暴露只读查询与主动投递（`describeConversation`、`sendChecked`、`listTargets` 等），没有命令注册钩子。
- 各渠道 bridge 的 `#processFastCommand`（`text-harness-bridge.mjs:971`、`weixin-bridge.mjs:724`、`wecom-app-bridge.mjs:514`、`wecom-bridge.mjs:1235`、`qq-bridge.mjs:1055`）只认识它自己那几个命令；**带图片的消息连命令分支都不进**，直接走 `#process`（`text-harness-bridge.mjs:1086`）提交给 Harness。
- 它执行的 `/xxx` 命令最终都通过 Typert gateway 的 `commands/execute` 转发（`plugin-src/host/harness-command-executor.mjs`），而那个注入点 `internals.commandExecutor` 只对测试开放。
- 同一个 bot token 也不能两处轮询：Telegram `getUpdates` 是单消费者，dsh-im 已经占着。

所以本插件走**独立 cordis host 插件 + DSH 命令注册**这条路：命令由 DSH 内核派发给我们的 handler，handler 在本机算完直接把文本还回去。

---

## 2. 目录结构

```
dsh-birds/
├── package.json                 插件清单（main 指向 lib/index.js，dsh.bundle.patch 指向 cordis.patch.yml）
├── cordis.patch.yml             加载补丁：- insert: - id: dsh-birds
├── lib/
│   ├── index.js                 插件入口：注册 /birds 与 /birdstatus，可选的 Telegram 桥；另有 agent/pre-step 兜底（带附件的 /birds 不发给模型）
│   ├── engine.mjs               三个模型的懒加载容器
│   ├── ort.mjs                  onnxruntime-node 封装 + IEEE-754 float16 互转
│   ├── paths.mjs                模型目录与文件名清单
│   ├── imagedecode.mjs          图片 → 384×384 RGB（sharp，回退 ffmpeg）
│   ├── imageclf.mjs             BirdTrace 图片分类
│   ├── audio/
│   │   ├── wav.mjs              RIFF/WAVE 原生解析（8/16/24/32-bit PCM、32/64-bit float）
│   │   ├── resample.mjs         加窗 sinc 重采样到 32 kHz
│   │   ├── chunk.mjs            3 秒窗口切分（末块补零）
│   │   └── birdnet.mjs          BirdNET+ 声学分类
│   ├── geo.mjs                  Geomodel 地理先验（学名 join + 阈值硬过滤）
│   ├── recognize.mjs            统一识别入口（命令与 IM 桥共用同一实现）
│   ├── format.mjs               文本排版
│   └── im/telegram.mjs          可选：Telegram 长轮询桥（媒体直接本地答复）
├── scripts/download-models.mjs  模型下载（支持断点续传）
├── docs/implementation.md       实施方案与模型核对笔记
└── test/
    ├── selftest.mjs             WAV/重采样/分块/排版 单元自测
    ├── host-mock.mjs            用 mock ctx 驱动插件，验证注册、handler 契约与 pre-step 接管
    └── imports.mjs              动态导入每个模块，防止坏导出或坏导入路径
```

---

## 3. 安装

插件**没有发布到 npm registry，也不需要 npm 账号**：GitHub 仓库本身就是安装源。下面命令里的 `npm` 只是包管理器，用来拉取仓库并安装依赖。

### 3.1 装进 DSH profile

方式 A：让包管理器直接从仓库安装（一条命令，依赖会一起装好）：

```bash
# 在装有 DSH 的那台机器（桌面端，或 DSH Go 的 PRoot Ubuntu）里
cd ~/.dsh/profiles/desktop
npm install github:yblpoi/dsh-birds
```

方式 B：clone 到任意目录再软链进 profile，方便之后 `git pull` 更新：

```bash
git clone https://github.com/yblpoi/dsh-birds.git ~/src/dsh-birds
cd ~/src/dsh-birds && npm install --omit=dev
ln -sfn ~/src/dsh-birds ~/.dsh/profiles/desktop/node_modules/dsh-birds
```

也可以直接把仓库 clone 到 `~/.dsh/profiles/desktop/node_modules/dsh-birds`，再进插件目录安装依赖；效果和方式 B 一样，只是没有软链。

然后编辑 `~/.dsh/profiles/desktop/cordis.patch.yml`，在顶层数组追加：

```yaml
- insert:
    - id: dsh-birds
      name: dsh-birds
      config:
        modelsDir: ~/.dsh/models/bird
        topK: 5
        minConfidence: 0.15
        # geo:                     # 可选，配了就启用地理先验
        #   lat: 39.9042
        #   lon: 116.4074
```

重启 Host（桌面端的「重启」或 `dsh` 重启）。命令面板里应能看到 `/birds` 与 `/birdstatus`。

更新插件时，方式 A 重跑一次安装命令；方式 B 在 clone 目录 `git pull && npm install --omit=dev`，重启 Host 即可。

> 注意：命令名必须匹配 `^[a-z][a-z0-9_-]*$`（DSH 命令注册表的硬性校验），所以是 `/birds` 而不是 `/鸟`。

### 3.2 依赖说明

插件只有一个必装依赖：`onnxruntime-node`，安装插件时会自动装好。`sharp` 是**可选依赖**，装不上不影响使用：图片解码会自动回退到 `ffmpeg`。

**关于 onnxruntime-node 的平台问题**：它的 `package.json` 里 `os` 字段只写了 `["win32","darwin","linux"]`，看起来像「不支持 Android」。但实际上——

- 主包里就带着 `bin/napi-v6/linux/arm64/onnxruntime_binding.node`（551,752 字节）和 `libonnxruntime.so.1`（25,266,408 字节），**不需要任何额外下载**；
- `os` 字段只是包管理器的安装守卫，用 `--force` 或手工解包即可绕过；
- `lib/binding.js` 用 `require(`../bin/napi-v6/${process.platform}/${process.arch}/onnxruntime_binding.node`)` 拼路径。DSH Go 内置的 PRoot Ubuntu 里 `process.platform === 'linux'`、`process.arch === 'arm64'`，**路径天然命中**。

所以 Android 上也是直接装依赖即可。若安装时被平台字段挡住，可以：

```bash
npm install --force
```

或者把包下载下来手工解包到 `node_modules/onnxruntime-node`。

### 3.3 模型与 ffmpeg：装好插件就已经装好

**不需要手动下载模型，也不需要 `apt install ffmpeg`。** 插件加载时会在后台自动完成这两件事：

1. 把 6 个模型文件下到 `modelsDir`（默认 `~/.dsh/models/bird`）；
2. 把当前平台（linux/darwin/win32 × arm64/x64）的静态 ffmpeg 二进制下到 `<modelsDir>/bin/ffmpeg`——手机上的 PRoot 环境因此不需要包管理器。

如果宿主机的 `PATH` 里本来就有可用的 `ffmpeg`，插件会直接借它，不再下这 50 MB 的自带副本（`/birdstatus` 会写明用的是哪一份）。自带副本始终优先，所以装过系统 ffmpeg 也不会改变解码行为。

进度随时看 `/birdstatus`：

```
下载任务：后台进行中 3/7 个文件，正在下 BirdNET+_V3.0-preview3.1_Global_11K_FP16_pruned.onnx（88.4 / 309.6 MB，28%）
```

第一次 `/birds` 落在下载没完成的时候，会直接回一句「正在后台下载 x/y 个文件」，不会报模型缺失，也不会去调大模型。下载完成后重发即可；中断过的文件按 `.part` 续传，落盘前会同时校验字节数与 SHA-256。

线路抖动导致有文件没下完时，插件会自己重试（2 分钟、10 分钟、30 分钟各一次），不需要人盯着；`/birdstatus` 会把没下成功的文件名和原因写出来。

> 为什么不用 npm 的 `postinstall`：npm 会把带安装脚本的 git 依赖判定为需要人工放行（`EALLOWSCRIPTS`），手机 profile 里没人能点那个确认，安装会直接失败。所以自动安装放在插件加载时，安装命令保持纯粹。

想手动重跑（可选，等价入口）：`dsh-birds-models`（profile 的 `node_modules/.bin/` 里），或

```bash
cd ~/.dsh/profiles/desktop/node_modules/dsh-birds
node scripts/download-models.mjs
# 只补 ffmpeg：node scripts/download-models.mjs --ffmpeg
# 换个存放位置：node scripts/download-models.mjs --dir=/data/models/bird
```

下载内容：

| 文件 | 大小 | 来源 |
| --- | --- | --- |
| `BirdTrace-FastViT-MA36-10K.onnx` | 222,385,590 B | `https://hf-mirror.com/warden123/BirdTrace-FastViT-MA36-10K/resolve/main/model.onnx` |
| `BirdTrace-FastViT-MA36-10K.classes.json` | 1,000,770 B | 同上 `classes.json` |
| `BirdNET+_V3.0-preview3.1_Global_11K_FP16_pruned.onnx` | 71,528,628 B | `https://zenodo.org/records/20703646/files/…?download=1` |
| `BirdNET+_V3.0-preview3.1_Global_11K_Labels.csv` | 809,172 B | 同上 |
| `BirdNET+_Geomodel_V3.0.4_Global_14K_FP16.onnx` | 7,885,053 B | `https://github.com/birdnet-team/geomodel/releases/download/v3.0.4/…` → `https://gh-proxy.com/<原地址>` |
| `BirdNET+_Geomodel_V3.0.4_Global_14K_Labels.txt` | 671,823 B | 同上 |
| `bin/ffmpeg`（静态二进制） | 45–81 MB，按平台 | `ffmpeg-static` b6.0：`cdn.npmmirror.com` → GitHub Releases → `gh-proxy.com` |

> **为什么要用 hf-mirror**：`huggingface.co`、`cdn.jsdelivr.net`、`raw.githubusercontent.com` 在部分网络环境下直连超时，而 `hf-mirror.com`、`zenodo.org`、`github.com` 通常可用。Zenodo 与 GitHub Releases 都支持 Range 请求，所以脚本能断点续传，手机上一次下不完可以再跑一次。
>
> **GitHub Releases 也可能整条不通**：Geomodel 只在 GitHub Releases 上有，而某些移动网络下 `github.com` 会连续 `UND_ERR_CONNECT_TIMEOUT`（实测手机上约 10 秒必超时）。所以每个 GitHub 资源都额外挂了一条 `https://gh-proxy.com/<原地址>` 中转线路——它返回的是同一份字节，大小与 SHA-256 校验不变，只在前一条线路失败时启用。

**下载失败时先跑自检**，它只发 `Range: bytes=0-0` 探测每条线路，不写任何文件：

```bash
node scripts/download-models.mjs --check
# 每个文件逐条打印 ✓/✗、HTTP 状态、最终落到哪个 CDN、文件大小与耗时
```

常用参数：`--only=<文件名片段>` 只下一个文件、`--hf=<镜像地址>` 换镜像、`--dir=<目录>` 换存放位置、`--retry=<次数>`、`--force` 重下、`--ua=<User-Agent>` 覆盖 UA。下载中断后重跑会从 `.part` 续传，只有大小与 SHA-256 都校验通过才会重命名成正式文件。

> **Zenodo 的 403 坑**：Zenodo 会对**不带 User-Agent 头**的请求直接返回 403。Node 的全局 `fetch` 默认不发 UA，所以早期版本在手机上必失败（报 `HTTP 403 Forbidden`）。脚本现在给每个请求都带上 `User-Agent`，正常情况下不会再触发；如果你自己写脚本拉 Zenodo，记得手动加 UA。

---

## 4. 用法

在 DSH 的任意会话里：

```
/birds              ← 和一张鸟照片一起发送
/birds              ← 和一段录音一起发送
/birds /sdcard/DCIM/bird.jpg
/birdstatus
```

回复长这样：

```
声音识别结果（BirdNET+ V3.0 preview3.1 Global 11K · 本地推理）

1. 大山雀 / Parus major　77.3%　0.0–3.0s　命中 1 段
2. 白头鹎 / Pycnonotus sinensis　21.4%　3.0–6.0s　命中 1 段

共 2 个 3 秒窗口（6.0 s）｜耗时 2.41 s｜未调用大模型｜0 token
```

命令的 `input` 声明了 `attachments: true`，所以 DSH 会把附件经 `@deepseek-ai/dsh-attachment` 存储后传给你；插件用 `ctx.get('attachments').imageHostPath(ref)` / `fileHostPath(ref)` 拿到 Host 侧绝对路径再喂给模型。

**附件没有扩展名**：DSH 的附件是内容寻址的（`~/.dsh/attachments/v1/objects/<xx>/<sha256>`），文件名就是一串哈希。所以插件不只看后缀 —— `classifyFile()` 先按扩展名分类，扩展名不认识（包括完全没有扩展名）时读文件头 64 字节按 magic 判断：JPEG / PNG / GIF / WebP / BMP / TIFF / HEIF / AVIF 当图片，WAV / MP3 / FLAC / OGG / AAC(ADTS) / M4A / AMR / WMA / AIFF 当音频。早期版本只看扩展名，手机直传的照片会报「无法判断文件类型：5ce3a0e2…」，现在这条已经堵住。

### 为什么带附件时也不会烧 token

命令注册表只负责**客户端主动路由过来的行**。有的客户端（例如 DSH Go 的 composer）遇到「带附件的消息」会整行当普通 prompt 发给模型，根本不查命令表，于是 `/birds` + 一张照片就白烧一个回合。

插件因此在回合边界上加了一道兜底钩子 `agent/pre-step`：命中 `/birds` 时自己算完，写回与命令注册表完全相同的一对 `command/run` + `command/done` 事件，然后返回 `{ kind: 'enter', messages: [] }` —— 内核看到「进入一个空 step」就直接把这一回合标成 completed，**不 append `user/message`、不建请求、不花 token**，UI 里照常出现一条命令结果。

这个钩子必须注册在**最外层**（`ctx.on('agent/pre-step', interceptBirds, { prepend: true })`）。宿主自带的监听器（`dsh-time-context`、`dsh-agent-instructions`、`dsh-plan-mode` 等）都是先 `await next()` 再往 `decision.messages` 里追加自己的 context 消息；如果插在里层，返回的空 `enter` 会被它们撑成「一条消息」的 decision，内核于是照常建请求，白烧一个回合——这个坑真机复现过，`prepend` 是承重的。

几个刻意的边界：

- 只在 `step === 1` 且这一批**恰好只有这一条消息**时接管。同批还有别的 prompt（排队消息）、或行是在回合中途进来的，一律放行给正常链路，避免吞掉用户的其他输入。
- 只认 `/birds`，`/birdstatus` 之类仍走注册表。
- 不伪造 `assistant/message`：那种事件下次加载会话时会被校验出 `source.kind !== 'model'` 而整段失败。
- 注册顺序同样是契约：`prepend: true` 让钩子跑在瀑布最外层，否则宿主的 context 包装器会把空 `enter` 变回一个真实 step。

### 可选：Telegram 桥

如果你希望**照片在进入 Harness 之前就被本地消化掉**（连 `/birds` 都不用打），在 config 里加：

```yaml
- insert:
    - id: dsh-birds
      name: dsh-birds
      config:
        telegram:
          token: "123456:ABC..."      # 用独立的 bot，别和 dsh-im 复用同一个 token
          allowedUserIds: [123456789]
          triggerWords: ["鸟", "bird", "识别"]
          # recognizeEveryMedia: true  # 关掉触发词，所有媒体都本地识别
        geo: { lat: 39.9042, lon: 116.4074 }
```

桥只处理带触发词的媒体，其余照旧交给 dsh-im，两条链路互不打架。

---

## 5. 模型细节（都是核对过的，不是抄 README）

### BirdTrace FastViT-MA36-10K

- 输入 `image`：`float32 [1, 3, 384, 384]`，**batch 固定为 1**（dim_value 硬编码，不是符号维）。
- 输出 `visual_logits`：`float32 [1, 10480]`，**raw logits，无 softmax**。
- 预处理：`preprocessor_config.json` 里写着 `do_rescale=true, rescale_factor=1/255`、`mean=[0.485,0.456,0.406]`、`std=[0.229,0.224,0.225]`，但 ONNX 段注明 `normalization: "embedded"`。
  对导出的图逐节点解析可见首节点链是 `sub(birdtrace_input_norm_mean) → div(birdtrace_input_norm_std) → conv2d`，常量 0.485/0.456/0.406、0.229/0.224/0.225 确实在文件里；**但图内没有 ÷255**。
  → 所以 JS 端**必须自己 /255**，**绝不能**再减 mean 除 std。`lib/imageclf.mjs` 就是这么做的。
- `classes.json`：10480 个 `{index, species_id, species_name}` 的顺序数组，第 i 维对应第 i 条；`species_name` 是下划线连接的英文俗名（如 `Abbotts_Babbler`），没有学名。
- 精度（官方自测，非第三方）：Micro Top-1 90.92% / Top-3 96.53%，Macro Top-1 86.74% / Top-3 93.18%。
- **没有 fp16 / int8 变体**，官方只有这一个 ONNX。
- **许可证 CC-BY-NC-4.0：禁止商用**。商用需另行授权。架构受 Apple ml-fastvit 条款约束。

### BirdNET+ V3.0 preview3.1 Global 11K

- 与 V2 的关键差异：**32 kHz**（V2 是 48 kHz）、**variable-length 输入**（取消固定 3 秒）、新架构。
- 只提供 FP32 TorchScript（`.pt`）与 **FP16 pruned ONNX**（就是本插件用的这个）。
- 输入是**原始波形**，STFT / 梅尔谱在模型图内部完成——所以插件里没有一段 FFT 代码，这跟 web-demo 的 `spectrogram.ts` 只是渲染用的不一样。
- 标签：`BirdNET+_V3.0-preview3.1_Global_11K_Labels.csv`，**分号分隔**，列 `id;sci_name;com_name;gbif;class;order`。
- 分析参数：chunk 3.0 s、overlap 0、`min_conf` 0.15（`analyze.py` 默认；web-demo 默认 0.25）。
- 输出两个张量（predictions + embeddings），插件取宽的那个 2-D 输出。
- FP16 权重意味着**输入按 session 声明的类型走**：`lib/ort.mjs` 检查 `inputMetadata[x].type` 里有没有 `float16`，有就做 float32→float16 转换（转换函数是手写的 IEEE-754 規格实现，已用 12 个边界值验证：0 / ±1 / 0.5 / 0.1 / π / 65504 / 1e-5 / 1000 / 6e-8 全部无漂移）。

### BirdNET+ Geomodel V3.0.4

这是最容易搞错的一个，规格来自对官方 ONNX 的实际解析：

- 输入 `input`：`float32 [batch, 3]` = **`[lat, lon, week]` 原始度数**，`lat ∈ [-90, 90]`、`lon ∈ [-180, 180]`、`week ∈ [1, 48]`。
  **不要**做 `lat+90` / `lon+180` 那套归一化——那是旧的 v2.4 MData 模型的做法，V3 由图内的 circular encoding 自己处理。
- 输出 `probabilities`：`float32 [batch, 14082]`，**图内已含 sigmoid**，出来就是概率，不要再套 softmax。
- 14,082 类 = 鸟 + 昆虫 + 两栖 + 哺乳，**与声学模型的 11K 既不同长也不同序**，绝不能按下标相乘。
- 官方用法是**阈值硬过滤**，不是加权：`birdnet_analyzer/analyze/core.py` 里 `run_geomodel(lat, lon, week, threshold=0.03)` 得到物种集合，作为 `custom_species_list` 传给声学推理，不在集合里的直接丢弃。`birdnet-go` 也只是布尔门。
  → 本插件默认复刻硬过滤（`lib/geo.mjs` 的 `allowedSpecies` + `filterByAllowedSpecies`），按**学名** join。
- 没配 `geo`、或模型文件缺失时，**静默跳过**，纯声学结果照常返回。

---

## 6. 在 Android（DSH Go）上部署

DSH Go 内置 PRoot Ubuntu + Node.js，插件跑在那个环境里。步骤：

```bash
# 1) 进入 DSH Go 的 Linux 环境（App 里有入口），确认架构
uname -m            # 期望 aarch64
node -v             # 期望 v22.19 以上

# 2) 装插件（从 GitHub 仓库装，不需要 npm 账号）
#    不用先 apt install ffmpeg：插件加载时会下自带的静态二进制
#    DSH Go 的 profile 目录名是 web（桌面端通常是 desktop），先 ls ~/.dsh/profiles 确认
cd ~/.dsh/profiles/web && npm install github:yblpoi/dsh-birds

# 3) 重启 DSH：模型（约 250 MB）和静态 ffmpeg（约 50 MB）会自己下好
#    /birdstatus 里能看到进度，不需要 apt，也不需要跑脚本
# 4) /birdstatus 检查，看到 6 个 ✓ 和 ffmpeg 一行就绪即可
```

### 真机上的性能与内存

实测机型：OPPO PKX110，Android 16，aarch64（DSH Go 内置 PRoot Ubuntu，Node v24.22.1）。

| 项目 | 数值/说明 |
| --- | --- |
| 图片模型常驻内存 | 约 212 MB 权重 + 中间激活；一次 384×384 前向在这台机器上约 1.0 s |
| 声学模型常驻内存 | 约 30–50 MB；每个 3 秒窗口约 0.4 s |
| Geomodel | 约 8 MB，一次前向约 0.07 s |
| 三个模型全部 createSession | 约 0.8 s |
| `/birds` 音频端到端（3 s WAV） | 约 0.6 s（含 WAV 解析、分块、声学推理、地理先验、排版） |
| 并发线程 | 默认 `intraOpNumThreads: 2`，避免 PRoot 里把 CPU 打死；可调 |

两个模型都是**首次用到才加载**（`lib/engine.mjs`），插件卸载时 `release()` 释放。手机上如果内存吃紧，把 `maxAudioSeconds` 调小（默认 600 秒）。

### 已知风险（先看这里再排查）

1. **`dlopen libonnxruntime.so.1` 失败**：PRoot 里的 glibc 版本太老。DSH Go 自带的 Ubuntu 一般没问题；万一不行，用 `onnxruntime-node@1.26.0`（同版本线更老、依赖更少）或退回 wasm 方案。
2. **`sharp` 装不上**：它只是可选依赖，插件会自动回退到 `ffmpeg` 解码图片。两条路都不通时才会报错，报错文案里写清了怎么修。
3. **下载中断**：保留 `.part`，下次加载插件或重发 `/birds` 会自动续传；全线路不通时用 `node scripts/download-models.mjs --check` 看是哪一层网络拦了。
4. **`ffmpeg` 没就绪 + 非 WAV 音频**：插件自带的那份还在下载（`/birdstatus` 会显示进度）。下载失败时可以先发 WAV，或自己装一个系统 ffmpeg 顶一下（`config.ffmpegPath` / `$DSH_BIRDS_FFMPEG` 也能指定现成的二进制）。
5. **模型下完但 `/birds` 仍说没模型**：模型目录是按运行插件的那个用户的 `$HOME` 解析的。用 root 手动跑过下载脚本，模型就落在 `/root/.dsh/models/bird`；如果 DSH 以别的用户运行，需要 `chown` 或显式传 `DSH_BIRDS_MODELS`/`--dir`。
6. **在 proot 里手动跑命令**：从 Android 侧直接执行 `libproot.so` 会因为找不到 `libtalloc.so` 和临时目录而失败，必须先导出 `LD_LIBRARY_PATH`、`PROOT_LOADER`、`PROOT_L2S_DIR`、`PROOT_TMP_DIR`（这些值可以在 `/proc/<proot pid>/environ` 里看到）。用 Magisk 的 `su` 可以这样进：`su -c '<rootfs 里的 bash> -lc "cd /root && node ..."'`。

---

## 7. 自测

```bash
node test/selftest.mjs    # WAV 解析 / 重采样 / 分块 / ISO 周 / 文本排版 / 地理先验门控 / 下载清单与 ffmpeg 查找顺序
node test/host-mock.mjs   # 用 mock ctx 验证命令注册、handler 契约、pre-step 接管、生命周期
node test/imports.mjs     # 动态导入每个模块，防止坏导出或坏路径
```

在 Node.js v22+ 上 `selftest` 102 项 + `hosttest` 50 项 + `imports` 16 项，共 168 项断言全部 PASS。

`hosttest` 尤其重要，它证明两件事：handler 返回的永远是合法的 `CommandResult`（`kind: 'success' | 'error'` + `text`），模型缺文件、附件解析失败、sharp 缺失都不会让命令抛异常；以及 `agent/pre-step` 只接管「整批恰好一条 `/birds`」的情形 —— 裸 `/birds`、带图片的 `/birds` 会被接管，普通 prompt、`/birdstatus`、`/birdsomething`、同批带排队消息、回合中途的行都原样放行。

---

## 8. 许可与合规

- 本插件代码：MIT（见 `LICENSE`）。
- **BirdTrace FastViT-MA36-10K：CC-BY-NC-4.0，禁止商业使用。**
- **BirdNET+ V3.0 preview3.1**：Developer Preview，模型与标签会变；使用需遵守其 `TERMS_OF_USE`（Zenodo record 20703646 内附）。
- **BirdNET+ Geomodel V3.0.4**：另有 `LICENSE-MODELS.md` / `ACCEPTABLE_USE.md`。

识别结果是统计模型的输出，**不是鉴定结论**；用于科研、观鸟记录请自行复核，不要用于法律、检疫、保护执法等场景。
