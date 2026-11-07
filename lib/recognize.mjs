import fs from 'node:fs/promises';
import path from 'node:path';
import { decodeImageToRgb } from './imagedecode.mjs';
import { readAudio } from './audio/wav.mjs';
import { filterByAllowedSpecies, normaliseSpeciesName } from './geo.mjs';
import { formatImageResult, formatAudioResult } from './format.mjs';

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tif', '.tiff', '.avif', '.heic']);
const AUDIO_EXT = new Set(['.wav', '.mp3', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.amr', '.wma', '.mp4', '.m4b']);

/** Classify a file by extension alone. Callers that only hold a name use this. */
export function kindOf(file) {
  const ext = path.extname(file).toLowerCase();
  if (IMAGE_EXT.has(ext)) return 'image';
  if (AUDIO_EXT.has(ext)) return 'audio';
  return 'unknown';
}

/** Prefix length read when a file has no usable extension. */
const SNIFF_BYTES = 64;

/** ISO base media brands that are still images rather than audio containers. */
const ISO_IMAGE_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1', 'avif', 'avis']);

/**
 * Classify a container from its leading bytes.
 *
 * Chat attachments arrive as content-addressed blobs with no extension at all —
 * a JPEG lands in ~/.dsh/attachments/v1/objects/5c/5ce3a0e2… — so routing on the
 * extension alone rejected perfectly good images as "unidentifiable".
 */
export function sniffKind(buffer) {
  if (!buffer || buffer.length < 4) return 'unknown';
  const text = (start, end) => buffer.toString('latin1', start, Math.min(end, buffer.length));

  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image'; // JPEG
  if (buffer[0] === 0x89 && text(1, 4) === 'PNG') return 'image'; // PNG
  if (text(0, 6) === 'GIF87a' || text(0, 6) === 'GIF89a') return 'image'; // GIF
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) return 'image'; // BMP
  if (buffer[0] === 0x49 && buffer[1] === 0x49 && buffer[2] === 0x2a && buffer[3] === 0x00) return 'image'; // TIFF LE
  if (buffer[0] === 0x4d && buffer[1] === 0x4d && buffer[2] === 0x00 && buffer[3] === 0x2a) return 'image'; // TIFF BE

  if (text(0, 4) === 'RIFF') {
    const form = text(8, 12);
    if (form === 'WEBP') return 'image';
    if (form === 'WAVE') return 'audio';
    return 'unknown';
  }
  if (text(0, 4) === 'FORM' && (text(8, 12) === 'AIFF' || text(8, 12) === 'AIFC')) return 'audio';

  if (text(4, 8) === 'ftyp') {
    const brand = text(8, 12).trim();
    // HEIF/AVIF brands are images; every other ISO-BMFF brand (m4a, mp4, aac,
    // qt) goes to ffmpeg, which pulls the audio track out.
    return ISO_IMAGE_BRANDS.has(brand) ? 'image' : 'audio';
  }

  if (text(0, 3) === 'ID3') return 'audio'; // MP3 carrying an ID3v2 tag
  if (text(0, 4) === 'fLaC') return 'audio';
  if (text(0, 4) === 'OggS') return 'audio';
  if (text(0, 5) === '#!AMR') return 'audio';
  if (text(0, 4) === 'caff') return 'audio';
  if (buffer[0] === 0x30 && buffer[1] === 0x26 && buffer[2] === 0xb2 && buffer[3] === 0x75) return 'audio'; // ASF/WMA
  if (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) {
    // MPEG audio frame sync (layer bits 01/10/11) or AAC ADTS (0xF1/0xF9).
    const layer = (buffer[1] >> 1) & 0x03;
    if (layer !== 0 || buffer[1] === 0xf1 || buffer[1] === 0xf9) return 'audio';
  }

  return 'unknown';
}

/**
 * True for Host attachment blobs: content-addressed, no extension, and named by
 * a hash rather than by anything a human wants to read in a reply.
 */
export function isAttachmentBlob(file) {
  return /^[0-9a-f]{40,64}$/iu.test(path.basename(file));
}

/**
 * Classify a file for routing: the extension wins when it is meaningful, and
 * otherwise the leading bytes decide, so extension-less attachments still work.
 */
export async function classifyFile(file) {
  const byExtension = kindOf(file);
  if (byExtension !== 'unknown') return byExtension;

  let handle;
  try {
    handle = await fs.open(file, 'r');
    const buffer = Buffer.alloc(SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, SNIFF_BYTES, 0);
    return sniffKind(buffer.subarray(0, bytesRead));
  } catch {
    return 'unknown';
  } finally {
    try {
      await handle?.close();
    } catch {
      // The sniff already answered; a failing close must not mask it.
    }
  }
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

  const kind = forceKind ?? (await classifyFile(file));
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
        file: isAttachmentBlob(file) ? undefined : path.basename(file),
      }),
      candidates,
    };
  }

  if (kind !== 'audio') {
    throw new Error(
      `无法判断文件类型：${path.basename(file)}（已按扩展名和文件开头字节判断）。支持图片（jpg/png/webp…）与音频（wav/mp3/m4a/flac/ogg…）。`,
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
