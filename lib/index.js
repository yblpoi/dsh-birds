import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BirdEngines } from './engine.mjs';
import { recognizeFile, resolveExistingFile, classifyFile, isAttachmentBlob } from './recognize.mjs';
import { formatStatus } from './format.mjs';
import { resolveModelsDir, modelPath, modelStatus } from './paths.mjs';
import { bindLabels, labelDigest, nameTableStatus } from './names.mjs';
import { Provisioner, mb } from './provision.mjs';
import { configureFfmpeg, describeFfmpeg, ffmpegAvailable, ffmpegInfo } from './ffmpeg.mjs';
import { sharpUsable } from './imagedecode.mjs';
import { TelegramBirdBridge } from './im/telegram.mjs';

export const name = 'dsh-birds';
export const inject = ['commands'];

const BIRD_DEFINITION = 'dsh-birds/birds';
const STATUS_DEFINITION = 'dsh-birds/status';

/** The same line grammar the Host's command registry parses. */
const COMMAND_LINE = /^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/u;
const INTERCEPTED_COMMAND = 'birds';

const USAGE = [
  '用法：/birds 附带一张鸟的照片或一段录音；也可以 /birds <文件绝对路径>。',
  '图片：jpg、png、webp、gif、bmp、tiff、avif、heic。',
  '音频：wav、mp3、m4a、aac、flac、ogg、opus（非 wav 由插件自带的 ffmpeg 解码）。',
  '查看模型状态：/birdstatus。',
].join('\n');

/**
 * Recognise the exact `/birds` line the Host's command registry would parse.
 *
 * Some clients hand a line that carries an attachment to the model instead of
 * to the command registry (dsh-Go's composer does exactly that), so `/birds`
 * plus a photo would bill a model turn before the handler ever ran. The Host
 * lets a plugin take such a line over at the turn boundary, before any request
 * is built, so answering it there costs nothing.
 */
function birdsLine(message) {
  if (!message || message.role !== 'user' || !Array.isArray(message.content)) return undefined;
  // Every text part has to be considered, not just the first one. A chat bridge
  // (dsh-im and friends) prepends its own envelope — <dsh_im_source>…, a caption
  // for each image, a <dsh_im_files> manifest — as separate text parts, so the
  // user's line is somewhere in the middle. Looking only at content[0] made a
  // QQ photo plus /birds look like an ordinary prompt and billed a model turn.
  for (const part of message.content) {
    if (part?.type !== 'text' || typeof part.text !== 'string') continue;
    const match = COMMAND_LINE.exec(part.text);
    if (match === null || match[1] !== INTERCEPTED_COMMAND) continue;
    return { rawInput: part.text.slice(match[0].length), content: message.content };
  }
  return undefined;
}

/**
 * Local bird recognition for DSH.
 *
 * Every reply this plugin produces is computed on the host: the command handler
 * returns its text straight to the UI, so no model turn is started and no token
 * is billed. The image graph (BirdTrace FastViT-MA36, 10480 classes) and the
 * acoustic graph (BirdNET+ V3, 11K species) are loaded lazily on first use so a
 * phone does not pay for two sessions it may not need.
 */
export function apply(ctx, config = {}) {
  const logger = typeof ctx.logger === 'function' ? ctx.logger('dsh-birds') : (ctx.logger ?? console);
  const modelsDir = resolveModelsDir(config.modelsDir);
  const engines = new BirdEngines({ modelsDir, logger });

  /**
   * Models and the ffmpeg binary are this plugin's own responsibility.
   *
   * Install scripts cannot carry that job: npm refuses a git dependency that
   * declares one unless a human allowlists it, and a phone profile has no way
   * to answer that prompt. So loading the plugin *is* the install step — the
   * download starts here, in the background, and /birds waits for it instead
   * of telling the user to go run something.
   */
  const autoDownload = config.autoDownload !== false;
  const provisioner = new Provisioner({
    modelsDir,
    logger,
    hfMirror: config.hfMirror,
    userAgent: config.userAgent,
    retry: config.downloadRetries,
    idleMs: config.downloadIdleMs,
  });
  configureFfmpeg({ modelsDir, explicitPath: config.ffmpegPath, provisioner, logger });

  const tuning = {
    topK: Number(config.topK) > 0 ? Math.floor(Number(config.topK)) : 5,
    minConfidence: Number.isFinite(Number(config.minConfidence)) ? Number(config.minConfidence) : 0.15,
    chunkSeconds: Number(config.chunkSeconds) > 0 ? Number(config.chunkSeconds) : 3,
    overlapSeconds: Number(config.overlapSeconds) >= 0 ? Number(config.overlapSeconds) : 0,
    maxAudioSeconds: Number(config.maxAudioSeconds) > 0 ? Number(config.maxAudioSeconds) : 600,
    geo: config.geo ?? null,
    geoStrength: Number(config.geoStrength) >= 0 ? Number(config.geoStrength) : 0.6,
  };

  /** Map command attachments to on-disk paths this process can read. */
  function attachmentPaths(invocation) {
    const store = typeof ctx.get === 'function' ? ctx.get('attachments') : undefined;
    const paths = [];
    for (const block of invocation?.attachments ?? []) {
      try {
        const hostPath = block.type === 'image'
          ? store?.imageHostPath?.(block.attachment)
          : store?.fileHostPath?.(block.attachment);
        if (hostPath) paths.push(hostPath);
      } catch (error) {
        logger.warn?.(`无法解析附件路径：${error?.message ?? error}`);
      }
    }
    return paths;
  }

  /** A short label for a file; attachment blobs are named by a content hash. */
  function describeFile(file) {
    const base = path.basename(file);
    return isAttachmentBlob(file) ? `附件 ${base.slice(0, 8)}` : base;
  }

  async function runRecognition(files) {
    const results = [];
    for (const file of files) {
      results.push({ file, ...(await recognizeFile(engines, file, { ...tuning, logger })) });
    }
    if (results.length === 1) return results[0].text;
    return results
      .map((result, index) => `【${index + 1}】${describeFile(result.file)}\n${result.text}`)
      .join('\n\n');
  }

  /** A compact "where is the download right now" line for chat replies. */
  function progressSummary(state) {
    if (!state.running && state.finishedAt === null) return '尚未开始';
    const files = `${state.doneFiles}/${state.totalFiles} 个文件`;
    const bytes = `${mb(state.doneBytes)}/${mb(state.totalBytes)} MB`;
    const current = state.running && state.current ? `，当前 ${state.current}` : '';
    return files + current + '（' + bytes + '）';
  }

  // A first install on a phone regularly meets one flaky route; retry the
  // leftovers on our own instead of waiting for the user to notice.
  const retryDelaysMs = [120_000, 600_000, 1_800_000];
  let retryIndex = 0;
  let retryTimer = null;

  function scheduleRetry(failed) {
    if (!autoDownload || retryIndex >= retryDelaysMs.length) return;
    if (retryTimer !== null) return;
    const delay = retryDelaysMs[retryIndex];
    retryIndex += 1;
    logger.info?.(`bird 有 ${failed} 个文件没下完，${Math.round(delay / 1000)} 秒后自动重试`);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      startMissing('retry');
    }, delay);
    // Never keep the Host alive just for a download timer.
    retryTimer.unref?.();
  }

  function startProvisioning(reason, scope = {}) {
    if (!autoDownload) return;
    provisioner.start(scope)
      .then((state) => {
        const failed = state?.errors?.length ?? 0;
        if (failed > 0) scheduleRetry(failed);
        else retryIndex = 0;
      })
      .catch((error) => {
        logger.error?.(`birds provisioning (${reason}) failed: ${error?.stack ?? error}`);
        scheduleRetry(1);
      });
  }

  /**
   * Download whatever is actually missing. A host that already has ffmpeg on
   * PATH keeps it: fetching a second copy would only cost 50 MB.
   */
  function startMissing(reason) {
    if (!autoDownload) return;
    const plan = provisioner.plan();
    const missingModels = plan.modelsMissing.length > 0;
    void (async () => {
      const missingFfmpeg = plan.ffmpegMissing && !(await ffmpegAvailable());
      if (!missingModels && !missingFfmpeg) return;
      logger.info?.(`bird 待下载：${missingModels ? `${plan.modelsMissing.length} 个模型` : '模型已就绪'}`
        + `${missingFfmpeg ? '，' + mb(plan.ffmpegTarget.bytes) + ' MB ffmpeg' : ''}`);
      startProvisioning(reason, { models: missingModels, ffmpeg: missingFfmpeg });
    })().catch((error) => {
      logger.error?.('bird 后台下载失败: ' + (error?.stack ?? error));
    });
  }

  async function headBytes(file, length) {
    const handle = await fs.open(file, 'r');
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, 0);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  /** True when decoding these files needs an ffmpeg the host does not have yet. */
  async function needsFfmpeg(files) {
    for (const file of files) {
      const kind = await classifyFile(file);
      if (kind === 'audio') {
        let head;
        try {
          head = await headBytes(file, 12);
        } catch {
          continue;
        }
        const isWav = head.length >= 12
          && head.toString('ascii', 0, 4) === 'RIFF'
          && head.toString('ascii', 8, 12) === 'WAVE';
        if (!isWav) return true;
      } else if (kind === 'image' && !(await sharpUsable())) {
        return true;
      }
    }
    return false;
  }

  /**
   * Everything /birds needs arrives by itself: models in the models directory,
   * ffmpeg next to them. This only has to say what is still missing, and make
   * sure the download is actually running, so a first-run user gets a sentence
   * they can act on instead of a model-not-found stack trace.
   */
  async function ensureInputs(files) {
    const plan = provisioner.plan();
    if (plan.modelsMissing.length > 0) {
      startProvisioning('models', { models: true, ffmpeg: false });
      if (!autoDownload) {
        return `模型文件缺失（${plan.modelsMissing.length} 个：${plan.modelsMissing.map((entry) => entry.file).join('、')}）。`
          + '自动下载已在配置里关闭，在插件目录运行 node scripts/download-models.mjs 补齐即可。';
      }
      const state = provisioner.status();
      if (!state.running && state.error) {
        return `模型下载还没成功：${state.error}。会在下次 /birds 或重启 Host 时继续（已下部分会续传），失败线路见 /birdstatus。`;
      }
      return `模型还没准备好：正在后台下载 ${progressSummary(state)}。插件会自动下完，完成后直接重发 /birds 就行（进度看 /birdstatus）。`;
    }

    if (plan.ffmpegMissing && !(await ffmpegAvailable()) && (await needsFfmpeg(files))) {
      startProvisioning('ffmpeg', { models: false, ffmpeg: true });
      if (plan.ffmpegTarget?.unsupported) {
        return `这个平台（${process.platform}/${process.arch}）没有随插件分发的 ffmpeg，而这次的文件需要它解码。`
          + '可以发 WAV 录音，或自行装一个 ffmpeg 后再试。';
      }
      const state = provisioner.status();
      return `这次的文件要用 ffmpeg 解码，插件正在后台下载自带的那份（${mb(plan.ffmpegTarget.bytes)} MB）：${progressSummary(state)}。下好后重发 /birds 即可。`;
    }
    return undefined;
  }

  async function handleBirds(invocation) {
    const raw = (invocation?.rawInput ?? '').trim();
    const files = attachmentPaths(invocation);

    if (files.length === 0 && raw) {
      const candidate = raw.replace(/^["']|["']$/g, '').trim();
      try {
        const resolved = await resolveExistingFile(candidate);
        if ((await classifyFile(resolved)) === 'unknown') return { kind: 'error', text: USAGE };
        files.push(resolved);
      } catch {
        return { kind: 'error', text: USAGE };
      }
    }

    if (files.length === 0) {
      return {
        kind: 'error',
        text: '没有收到图片或录音。把照片/录音和 /birds 一起发送，或用 /birds <文件绝对路径>。',
      };
    }

    const blocked = await ensureInputs(files);
    if (blocked !== undefined) return { kind: 'error', text: blocked };

    if (!(await engines.probeOrt())) {
      return {
        kind: 'error',
        text: 'onnxruntime-node 不可用，无法本地推理。请检查插件日志；常见原因是安装时跳过了 onnxruntime-node，'
          + '或者当前平台没有对应二进制（支持 linux-arm64、linux-x64、darwin-arm64、win32-arm64、win32-x64）。',
      };
    }

    try {
      return { kind: 'success', text: await runRecognition(files) };
    } catch (error) {
      logger.error?.('birds failed: ' + (error?.stack ?? error));
      return { kind: 'error', text: '识别失败：' + (error?.message ?? String(error)) };
    }
  }

  // Command ids must stay unique inside one session; the Host's registry mints
  // its own under a separate random token, so these cannot collide with it.
  const instanceToken = randomUUID().slice(0, 8);
  let commandSeq = 0;

  /**
   * Answer a `/birds` line that a client handed to the model instead of to the
   * command registry.
   *
   * The turn boundary is the last point before a request is built. Record the
   * same command/run + command/done pair the registry would have written — that
   * pair is what every DSH client renders — then end the turn with a rejection:
   * no user echo, no request, no token.
   *
   * The rejection is load-bearing. Entering a step with an empty message list
   * also ends a turn, but several built-in listeners wrap this event from the
   * outside and append their own context (dsh-time-context and
   * dsh-agent-instructions both register with `prepend` after the profile
   * plugins load, and they add snapshots whenever the session needs one). Any
   * non-empty list turns the empty enter into an ordinary step, which is
   * exactly how a fresh session billed a model turn even though the reply was
   * already written. A rejection carries no message list, and every built-in
   * wrapper passes it through untouched, so nothing can reopen the turn.
   *
   * Only a first step whose whole batch is that one line is claimed. A queued
   * prompt travelling in the same batch, or a line arriving mid-turn, is left
   * alone so the ordinary path still owns it.
   */
  async function interceptBirds(payload, next) {
    const messages = payload?.messages;
    if (payload?.step !== 1 || payload?.signal?.aborted === true) return next();
    if (!Array.isArray(messages) || messages.length !== 1) return next();
    const line = birdsLine(messages[0]);
    if (line === undefined) return next();
    const session = payload?.agent?.session;
    if (typeof session?.append !== 'function') return next();

    const commandId = `cmd-${instanceToken}-${++commandSeq}`;
    try {
      session.append('command/run', {
        commandId,
        name: INTERCEPTED_COMMAND,
        ...(line.rawInput ? { args: line.rawInput } : {}),
        source: { kind: 'user' },
      });
    } catch (error) {
      logger.error?.('birds could not start its command: ' + (error?.stack ?? error));
      return next();
    }

    let result;
    try {
      result = await handleBirds({
        rawInput: line.rawInput,
        attachments: line.content.filter((part) => part?.attachment !== undefined
          && (part?.type === 'image' || part?.type === 'file')),
      });
    } catch (error) {
      logger.error?.('birds failed: ' + (error?.stack ?? error));
      result = { kind: 'error', text: '识别失败：' + (error?.message ?? String(error)) };
    }

    try {
      session.append('command/done', {
        commandId,
        kind: result.kind,
        ...(typeof result.text === 'string' ? { text: result.text } : {}),
      });
    } catch (error) {
      // The work is already done and the line is already consumed; ending the
      // turn is still cheaper and more honest than replaying it as a prompt.
      logger.error?.('birds could not record its result: ' + (error?.stack ?? error));
    }
    // A rejection, not an empty `enter`: see the note above — wrappers append
    // context messages to an accepted step and would reopen this turn.
    return { kind: 'reject' };
  }

  /** Where the ffmpeg for decoding non-WAV audio would come from today. */
  async function ffmpegStatusText() {
    const info = ffmpegInfo();
    if (info.path) return describeFfmpeg(info);
    if (await ffmpegAvailable()) return '系统 PATH 中的 ffmpeg';
    return describeFfmpeg(info);
  }

  /**
   * Bind the Chinese name tables for /birdstatus.
   *
   * The classifiers bind them when they load, which has not happened yet on a
   * freshly started host. Hashing the two label files here is a megabyte of
   * local reads and tells the user whether the reply will be bilingual.
   */
  async function nameTables() {
    for (const [kind, key] of [['image', 'imageClasses'], ['audio', 'audioLabels']]) {
      try {
        const text = await fs.readFile(modelPath(modelsDir, key), 'utf8');
        bindLabels(kind, labelDigest(text), logger);
      } catch {
        // Missing models are already reported line by line; nothing to add.
      }
    }
    return nameTableStatus();
  }

  async function handleStatus() {
    const plan = provisioner.plan();
    return {
      kind: 'success',
      text: formatStatus({
        modelsDir,
        status: modelStatus(modelsDir),
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        available: await engines.probeOrt(),
        ffmpeg: await ffmpegStatusText(),
        ffmpegPath: plan.ffmpegPath,
        names: await nameTables(),
        provisioning: {
          ...provisioner.status(),
          autoDownload,
          pendingFiles: (plan.modelsMissing?.length ?? 0) + (plan.ffmpegMissing ? 1 : 0),
          missingBytes: plan.missingBytes,
        },
      }),
    };
  }

  let bridge;

  ctx.effect(function* birdPluginLifecycle() {
    // Teardown first: a stop signal arriving while commands are still mounted
    // must not leave the Telegram long-poll running.
    yield async () => {
      if (retryTimer !== null) clearTimeout(retryTimer);
      retryTimer = null;
      await bridge?.stop?.();
      engines.release();
    };

    yield ctx.commands.register({
      definitionId: BIRD_DEFINITION,
      name: 'birds',
      description: '本地识鸟：附带图片或录音，直接在这台机器上跑模型，不消耗 token',
      input: { hint: '可留空（附带图片/录音），或填文件绝对路径', attachments: true },
      handler: handleBirds,
    });

    // The registry only owns a line the client routes there. This boundary owns
    // the rest, so an attachment never turns into a billed model turn.
    //
    // `prepend` is load-bearing. Built-in listeners such as dsh-time-context
    // await next() and then append their own context message to whatever the
    // inner chain decided, so an empty `enter` from an inner listener comes
    // back as a one-message decision and the kernel starts a real step. Running
    // outermost keeps that wrapper from ever seeing this turn.
    yield ctx.on('agent/pre-step', interceptBirds, { prepend: true });

    yield ctx.commands.register({
      definitionId: STATUS_DEFINITION,
      name: 'birdstatus',
      description: '查看鸟类识别插件的模型文件与推理引擎状态',
      handler: handleStatus,
    });

    // The Telegram bridge is opt-in: it lets a phone answer bird photos before
    // they ever reach the Harness, which is the point of this plugin.
    const telegram = config.telegram;
    if (telegram?.token) {
      bridge = new TelegramBirdBridge({
        token: String(telegram.token),
        engines,
        logger,
        options: {
          allowedUserIds: Array.isArray(telegram.allowedUserIds) ? telegram.allowedUserIds.map(Number) : [],
          triggerWords: Array.isArray(telegram.triggerWords) ? telegram.triggerWords : undefined,
          recognizeEveryMedia: telegram.recognizeEveryMedia === true,
          geo: config.geo ?? null,
          topK: tuning.topK,
          minConfidence: tuning.minConfidence,
          maxFileBytes: Number(telegram.maxFileBytes) > 0 ? Number(telegram.maxFileBytes) : undefined,
        },
      });
      bridge.start().catch((error) => {
        logger.error?.('telegram bridge failed to start: ' + (error?.stack ?? error));
      });
    }

    // Loading the plugin is the whole setup step: the models and the bundled
    // ffmpeg are fetched here, in the background, so a fresh install becomes
    // usable without anyone running a script or touching apt.
    startMissing('startup');
  }, 'dsh-birds lifecycle');
}

export default { name, inject, apply };
