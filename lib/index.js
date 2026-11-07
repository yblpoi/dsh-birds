import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BirdEngines } from './engine.mjs';
import { recognizeFile, resolveExistingFile, classifyFile, isAttachmentBlob } from './recognize.mjs';
import { formatStatus } from './format.mjs';
import { resolveModelsDir, modelStatus } from './paths.mjs';
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
  '音频：wav、mp3、m4a、aac、flac、ogg、opus（非 wav 需要系统里有 ffmpeg）。',
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
  const text = message.content.find((part) => part?.type === 'text' && typeof part.text === 'string');
  if (text === undefined) return undefined;
  const match = COMMAND_LINE.exec(text.text);
  if (match === null || match[1] !== INTERCEPTED_COMMAND) return undefined;
  return { rawInput: text.text.slice(match[0].length), content: message.content };
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
   * The turn boundary is the last point before a request is built, and the Host
   * ends the turn unprompted when the plugin enters a step with no messages. So
   * record the same command/run + command/done pair the registry would have
   * written — that pair is what every DSH client renders — then enter an empty
   * step: no user echo, no request, no token.
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
    return { kind: 'enter', messages: [] };
  }

  async function handleStatus() {
    return {
      kind: 'success',
      text: formatStatus({
        modelsDir,
        status: modelStatus(modelsDir),
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        available: await engines.probeOrt(),
      }),
    };
  }

  let bridge;

  ctx.effect(function* birdPluginLifecycle() {
    // Teardown first: a stop signal arriving while commands are still mounted
    // must not leave the Telegram long-poll running.
    yield async () => {
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
    yield ctx.on('agent/pre-step', interceptBirds);

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
  }, 'dsh-birds lifecycle');
}

export default { name, inject, apply };
