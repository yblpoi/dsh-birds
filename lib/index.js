import path from 'node:path';
import { BirdEngines } from './engine.mjs';
import { recognizeFile, resolveExistingFile, kindOf } from './recognize.mjs';
import { formatStatus } from './format.mjs';
import { resolveModelsDir, modelStatus } from './paths.mjs';
import { TelegramBirdBridge } from './im/telegram.mjs';

export const name = 'dsh-birds';
export const inject = ['commands'];

const BIRD_DEFINITION = 'dsh-birds/birdid';
const STATUS_DEFINITION = 'dsh-birds/status';

const USAGE = [
  '用法：/birdid 附带一张鸟的照片或一段录音；也可以 /birdid <文件绝对路径>。',
  '图片：jpg、png、webp、gif、bmp、tiff、avif、heic。',
  '音频：wav、mp3、m4a、aac、flac、ogg、opus（非 wav 需要系统里有 ffmpeg）。',
  '查看模型状态：/birdstatus。',
].join('\n');

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

  async function runRecognition(files) {
    const results = [];
    for (const file of files) {
      results.push({ file, ...(await recognizeFile(engines, file, { ...tuning, logger })) });
    }
    if (results.length === 1) return results[0].text;
    return results
      .map((result, index) => `【${index + 1}】${path.basename(result.file)}\n${result.text}`)
      .join('\n\n');
  }

  async function handleBirdId(invocation) {
    const raw = (invocation?.rawInput ?? '').trim();
    const files = attachmentPaths(invocation);

    if (files.length === 0 && raw) {
      const candidate = raw.replace(/^["']|["']$/g, '').trim();
      try {
        const resolved = await resolveExistingFile(candidate);
        if (kindOf(resolved) === 'unknown') return { kind: 'error', text: USAGE };
        files.push(resolved);
      } catch {
        return { kind: 'error', text: USAGE };
      }
    }

    if (files.length === 0) {
      return {
        kind: 'error',
        text: '没有收到图片或录音。把照片/录音和 /birdid 一起发送，或用 /birdid <文件绝对路径>。',
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
      logger.error?.('birdid failed: ' + (error?.stack ?? error));
      return { kind: 'error', text: '识别失败：' + (error?.message ?? String(error)) };
    }
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
      name: 'birdid',
      description: '本地识鸟：附带图片或录音，直接在这台机器上跑模型，不消耗 token',
      input: { hint: '可留空（附带图片/录音），或填文件绝对路径', attachments: true },
      handler: handleBirdId,
    });

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
