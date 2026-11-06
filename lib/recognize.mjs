import fs from 'node:fs/promises';
import path from 'node:path';
import { decodeImageToRgb } from './imagedecode.mjs';
import { readAudio } from './audio/wav.mjs';
import { filterByAllowedSpecies, normaliseSpeciesName } from './geo.mjs';
import { formatImageResult, formatAudioResult } from './format.mjs';

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tif', '.tiff', '.avif', '.heic']);
const AUDIO_EXT = new Set(['.wav', '.mp3', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.amr', '.wma', '.mp4', '.m4b']);

/** Classify a file by extension so one entry point can route it. */
export function kindOf(file) {
  const ext = path.extname(file).toLowerCase();
  if (IMAGE_EXT.has(ext)) return 'image';
  if (AUDIO_EXT.has(ext)) return 'audio';
  return 'unknown';
}

/**
 * Run local recognition for one file and return chat-ready text.
 *
 * This is the single implementation shared by the /birds command and the IM
 * bridge, which is what guarantees the two paths can never drift apart.
 */
export async function recognizeFile(engines, file, options = {}) {
  const {
    topK = 5,
    minConfidence = 0.15,
    chunkSeconds = 3,
    overlapSeconds = 0,
    maxAudioSeconds = 600,
    geo = null,
    geoThreshold = 0.03,
    logger,
    forceKind,
  } = options;

  const kind = forceKind ?? kindOf(file);
  const started = Date.now();

  if (kind === 'image') {
    const rgb = await decodeImageToRgb(file, 384);
    const candidates = await engines.image.classify(rgb.data, { size: 384, topK });
    return {
      kind,
      text: formatImageResult({
        candidates,
        elapsedMs: Date.now() - started,
        topK,
        file: path.basename(file),
      }),
      candidates,
    };
  }

  if (kind !== 'audio') {
    throw new Error(
      `无法判断文件类型：${path.basename(file)}。支持图片（jpg/png/webp…）与音频（wav/mp3/m4a/flac/ogg…）。`,
    );
  }

  const { samples, sampleRate } = await readAudio(file, { logger });
  let pcm = samples;
  const seconds = samples.length / sampleRate;
  if (seconds > maxAudioSeconds) {
    logger?.warn?.(`音频 ${seconds.toFixed(0)} 秒超过上限，只分析前 ${maxAudioSeconds} 秒`);
    pcm = samples.subarray(0, Math.floor(maxAudioSeconds * sampleRate));
  }

  const analysis = await engines.audio.analyze(pcm, sampleRate, {
    chunkSeconds,
    overlapSeconds,
    minConfidence,
    topPerWindow: topK,
  });

  let detections = analysis.detections;
  let geoApplied = false;
  let geoMessage = '';
  if (geo && Number.isFinite(geo.lat) && Number.isFinite(geo.lon)) {
    try {
      const week = geo.week ?? isoWeek(new Date());
      const allowed = await engines.geo.allowedSpecies(geo.lat, geo.lon, week, { threshold: geoThreshold });
      if (allowed) {
        const filtered = filterByAllowedSpecies(detections, allowed);
        detections = filtered.kept;
        geoApplied = filtered.applied;
        geoMessage = filtered.applied
          ? `地理先验：${geo.lat}, ${geo.lon} 第 ${week} 周，允许 ${allowed.size} 个物种，滤除 ${filtered.dropped} 个`
          : '';
      } else {
        geoMessage = engines.geo.unavailable ?? '';
      }
    } catch (error) {
      logger?.warn?.('地理先验失败，继续用纯声学结果：' + (error?.message ?? error));
    }
  }

  return {
    kind: 'audio',
    text: formatAudioResult({
      detections,
      windows: analysis.windowCount,
      durationSec: analysis.durationSec,
      elapsedMs: Date.now() - started,
      topK,
      minConfidence,
      geoApplied,
      geoMessage,
      truncated: analysis.truncated,
    }),
    detections,
    truncated: analysis.truncated,
  };
}

/** ISO-8601 week number (1..53), clamped into the geomodel's 1..48 range. */
export function isoWeek(date) {
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNumber = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNumber + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const firstDayNumber = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNumber + 3);
  const week = 1 + Math.round((target - firstThursday) / (7 * 24 * 3600 * 1000));
  return Math.min(48, Math.max(1, week));
}

/** Resolve a user-supplied path, expanding ~ and rejecting directories. */
export async function resolveExistingFile(raw) {
  const expanded = raw.startsWith('~') ? path.join(process.env.HOME ?? '', raw.slice(1)) : raw;
  const absolute = path.resolve(expanded);
  const stat = await fs.stat(absolute);
  if (!stat.isFile()) throw new Error('不是文件：' + absolute);
  return absolute;
}

export { normaliseSpeciesName };
