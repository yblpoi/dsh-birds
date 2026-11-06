# dsh-bird — DeepSeek Harness 本地鸟类识别插件

在 **不调用任何大模型** 的前提下，用本机 CPU 跑两个识别模型：

| 输入 | 模型 | 类数 | 输出 |
| --- | --- | --- | --- |
| 图片 | BirdTrace FastViT-MA36-10K（ONNX, FP32） | 10,480 | top-k 物种 + 相对置信度 |
| 录音 | BirdNET+ V3.0 preview3.1 Global 11K（ONNX, FP16） | 11,000+ | 每个物种的最高分与时间段 |
| 录音（可选） | BirdNET+ Geomodel V3.0.4 Global 14K（ONNX, FP16） | 14,082 | 按经纬度 + 周次筛掉不可能出现的物种 |

命令执行完直接返回文本，**不进入 LLM 回合、不产生 token 费用**。这是 DSH 命令注册表（`ctx.commands.register`）的官方能力，不是对 dsh-im 的 hack。

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
dsh-bird/
├── package.json                 插件清单（main 指向 lib/index.js，dsh.bundle.patch 指向 cordis.patch.yml）
├── cordis.patch.yml             加载补丁：- insert: - id: dsh-bird
├── lib/
│   ├── index.js                 插件入口：注册 /birdid 与 /birdstatus，可选的 Telegram 桥
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
└── test/
    ├── selftest.mjs             WAV/重采样/分块/排版 单元自测
    └── host-mock.mjs            用 mock ctx 驱动插件，验证注册与 handler 契约
```

---

## 3. 安装

### 3.1 放进 DSH profile

```bash
# 在装有 DSH 的那台机器（桌面端，或 DSH Go 的 PRoot Ubuntu）里
cd ~/.dsh/profiles/desktop
npm install dsh-bird          # 或者把本仓库软链/复制进 node_modules
```

然后编辑 `~/.dsh/profiles/desktop/cordis.patch.yml`，在顶层数组追加：

```yaml
- insert:
    - id: dsh-bird
      name: dsh-bird
      config:
        modelsDir: ~/.dsh/models/bird
        topK: 5
        minConfidence: 0.15
        # geo:                     # 可选，配了就启用地理先验
        #   lat: 39.9042
        #   lon: 116.4074
```

重启 Host（桌面端的「重启」或 `dsh` 重启）。命令面板里应能看到 `/birdid` 与 `/birdstatus`。

> 注意：命令名必须匹配 `^[a-z][a-z0-9_-]*$`（DSH 命令注册表的硬性校验），所以是 `/birdid` 而不是 `/鸟`。

### 3.2 装依赖

```bash
cd ~/.dsh/profiles/desktop/node_modules/dsh-bird
npm install --omit=dev            # 装 onnxruntime-node；sharp 是 optional
```

**关于 onnxruntime-node 的平台问题（这条值得单独说）**：它的 `package.json` 里 `os` 字段只写了 `["win32","darwin","linux"]`，看起来像「不支持 Android」。但实际上——

- 主包里就带着 `bin/napi-v6/linux/arm64/onnxruntime_binding.node`（551,752 字节）和 `libonnxruntime.so.1`（25,266,408 字节），**不需要任何额外下载**；
- `os` 字段只是 npm 的安装守卫，用 `--force` 或手工解包即可绕过；
- `lib/binding.js` 用 `require(`../bin/napi-v6/${process.platform}/${process.arch}/onnxruntime_binding.node`)` 拼路径。DSH Go 内置的 PRoot Ubuntu 里 `process.platform === 'linux'`、`process.arch === 'arm64'`，**路径天然命中**。

所以直接 `npm install onnxruntime-node` 就行。若安装时被 `os` 字段挡住：

```bash
npm pack onnxruntime-node && tar xzf onnxruntime-node-*.tgz
mv package node_modules/onnxruntime-node
```

### 3.3 下载模型

```bash
npm run download-models
# 或指定目录：node scripts/download-models.mjs --dir=/data/models/bird
```

脚本会拉到：

| 文件 | 大小 | 来源 |
| --- | --- | --- |
| `BirdTrace-FastViT-MA36-10K.onnx` | 222,385,590 B | `https://hf-mirror.com/warden123/BirdTrace-FastViT-MA36-10K/resolve/main/model.onnx` |
| `BirdTrace-FastViT-MA36-10K.classes.json` | 1,000,770 B | 同上 `classes.json` |
| `BirdNET+_V3.0-preview3.1_Global_11K_FP16_pruned.onnx` | — | `https://zenodo.org/records/20703646/files/…?download=1` |
| `BirdNET+_V3.0-preview3.1_Global_11K_Labels.csv` | — | 同上 |
| `BirdNET+_Geomodel_V3.0.4_Global_14K_FP16.onnx` | 7,885,053 B | `https://github.com/birdnet-team/geomodel/releases/download/v3.0.4/…` |
| `BirdNET+_Geomodel_V3.0.4_Global_14K_Labels.txt` | 671,823 B | 同上 |

> **为什么要用 hf-mirror**：`huggingface.co`、`cdn.jsdelivr.net`、`raw.githubusercontent.com` 在部分网络环境下直连超时，而 `hf-mirror.com`、`zenodo.org`、`github.com` 通常可用。Zenodo 与 GitHub Releases 都支持 Range 请求，所以脚本能断点续传，手机上一次下不完可以再跑一次。

---

## 4. 用法

在 DSH 的任意会话里：

```
/birdid              ← 和一张鸟照片一起发送
/birdid              ← 和一段录音一起发送
/birdid /sdcard/DCIM/bird.jpg
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

### 可选：Telegram 桥

如果你希望**照片在进入 Harness 之前就被本地消化掉**（连 `/birdid` 都不用打），在 config 里加：

```yaml
- insert:
    - id: dsh-bird
      name: dsh-bird
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

# 2) 装 ffmpeg（mp3/m4a/ogg 解码与图片兜底解码都要它）
apt update && apt install -y ffmpeg

# 3) 装插件
cd ~/.dsh/profiles/desktop && npm install dsh-bird

# 4) 下模型（约 250 MB，可断点续传）
cd ~/.dsh/profiles/desktop/node_modules/dsh-bird && npm run download-models

# 5) 重启 DSH，然后 /birdstatus 检查
```

### 真机上的性能与内存

| 项目 | 数值/说明 |
| --- | --- |
| 图片模型常驻内存 | 约 212 MB 权重 + 中间激活；一次 384×384 前向在 8 核手机上约 1–3 s |
| 声学模型常驻内存 | 约 30–50 MB；每个 3 秒窗口约 0.2–0.5 s |
| Geomodel | 约 8 MB，一次前向毫秒级 |
| 并发线程 | 默认 `intraOpNumThreads: 2`，避免 PRoot 里把 CPU 打死；可调 |

两个模型都是**首次用到才加载**（`lib/engine.mjs`），插件卸载时 `release()` 释放。手机上如果内存吃紧，把 `maxAudioSeconds` 调小（默认 600 秒）。

### 已知风险（先看这里再排查）

1. **`dlopen libonnxruntime.so.1` 失败**：PRoot 里的 glibc 版本太老。DSH Go 自带的 Ubuntu 一般没问题；万一不行，用 `onnxruntime-node@1.26.0`（同版本线更老、依赖更少）或退回 wasm 方案。
2. **`sharp` 装不上**：它只是可选依赖，插件会自动回退到 `ffmpeg` 解码图片。两条路都不通时才会报错，报错文案里写清了怎么修。
3. **下载中断**：脚本保留 `.part`，重跑即续传。
4. **`ffmpeg` 缺失 + 非 WAV 音频**：报错会直接告诉你去 `apt install -y ffmpeg`。

---

## 7. 自测

```bash
npm run selftest          # WAV 解析 / 重采样 / 分块 / ISO 周 / 文本排版
npm run hosttest          # 用 mock ctx 验证命令注册、handler 契约、生命周期
```

在 Node.js v22+ 上 `selftest` 22 项 + `hosttest` 26 项 + `imports` 11 项，共 59 项断言全部 PASS。

`hosttest` 尤其重要：它证明 handler 返回的永远是合法的 `CommandResult`（`kind: 'success' | 'error'` + `text`），模型缺文件、附件解析失败、sharp 缺失都不会让命令抛异常，只会返回一句人话。

---

## 8. 许可与合规

- **BirdTrace FastViT-MA36-10K：CC-BY-NC-4.0，禁止商业使用。**
- **BirdNET+ V3.0 preview3.1**：Developer Preview，模型与标签会变；使用需遵守其 `TERMS_OF_USE`（Zenodo record 20703646 内附）。
- **BirdNET+ Geomodel V3.0.4**：另有 `LICENSE-MODELS.md` / `ACCEPTABLE_USE.md`。
- 本插件代码本身由你自行决定许可。

识别结果是统计模型的输出，**不是鉴定结论**；用于科研、观鸟记录请自行复核，不要用于法律、检疫、保护执法等场景。