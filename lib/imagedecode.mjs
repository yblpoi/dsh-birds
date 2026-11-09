import fs from 'node:fs/promises';
import { runFfmpeg } from './ffmpeg.mjs';

let sharpModule;
let sharpError;

/** Whether sharp is loaded right now, so callers can tell if ffmpeg is next. */
export function sharpAvailable() {
  return sharpModule !== undefined;
}

/**
 * Whether sharp can be used at all. handleBirds asks this before deciding a
 * photo needs the ffmpeg fallback downloaded first.
 */
export async function sharpUsable() {
  try {
    await loadSharp();
    return true;
  } catch {
    return false;
  }
}

/**
 * Load sharp lazily. It is an optional dependency with official linux-arm64
 * prebuilds, so a host without it must degrade to the ffmpeg path instead of
 * failing at plugin load time.
 */
async function loadSharp() {
  if (sharpModule) return sharpModule;
  if (sharpError) throw sharpError;
  try {
    const mod = await import('sharp');
    sharpModule = mod.default ?? mod;
    return sharpModule;
  } catch (error) {
    sharpError = new Error('sharp 不可用：' + (error?.message ?? error));
    throw sharpError;
  }
}

/** Resize + convert to raw RGB with ffmpeg, used when sharp is missing. */
async function decodeWithFfmpeg(file, size) {
  try {
    const { stdout } = await runFfmpeg([
      '-nostdin', '-v', 'error', '-i', file,
      // Force square output and strip alpha so the buffer is exactly
      // size*size*3 bytes; -frames:v 1 avoids reading multi-frame files.
      '-vf', `scale=${size}:${size}:force_original_aspect_ratio=disable,format=rgb24`,
      '-frames:v', '1', '-f', 'rawvideo', 'pipe:1',
    ], { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 });
    const expected = size * size * 3;
    if (stdout.length !== expected) {
      throw new Error(`ffmpeg 输出的 RGB 大小不符：期望 ${expected} 字节，实际 ${stdout.length}`);
    }
    return { data: stdout, width: size, height: size, channels: 3 };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(
        '缺少图片解码能力：sharp 不可用，插件自带的 ffmpeg 也没能就绪。'
        + '重新加载插件会重试下载，/birdstatus 会显示当前状态。',
      );
    }
    throw new Error('ffmpeg 解码图片失败：' + (error?.stderr?.toString?.() ?? error?.message ?? error));
  }
}

/**
 * Where a source image lands inside a square letterbox canvas.
 *
 * The gate detector needs this twice - once to build the padded canvas and once
 * to map its boxes back to source pixels - so it lives here, next to the code
 * that actually pads, and both halves read the same numbers.
 */
export function letterboxGeometry(size, srcWidth, srcHeight) {
  const scale = Math.min(size / srcWidth, size / srcHeight);
  const drawnWidth = Math.max(1, Math.round(srcWidth * scale));
  const drawnHeight = Math.max(1, Math.round(srcHeight * scale));
  return {
    scale,
    drawnWidth,
    drawnHeight,
    padLeft: Math.floor((size - drawnWidth) / 2),
    padTop: Math.floor((size - drawnHeight) / 2),
  };
}

/**
 * Decode any image the platform can read into interleaved RGB, resized to
 * size x size.
 *
 * BirdTrace's preprocessing contract is "already prepared 384x384 RGB": the
 * ONNX graph embeds (x - mean) / std, but NOT the /255 rescale, so callers must
 * divide by 255 themselves and must not subtract mean or divide by std again.
 *
 * The model release does not specify crop or interpolation, so this uses a
 * bilinear fit to the square (letterbox-free), which keeps the whole subject
 * visible - a bird at the edge of frame survives a fit better than a crop.
 */
export async function decodeImageToRgb(file, size = 384) {
  let sharp;
  try {
    sharp = await loadSharp();
  } catch {
    return decodeWithFfmpeg(file, size);
  }
  try {
    const pipeline = sharp(file, { failOn: 'error', limitInputPixels: 64_000_000 });
    const meta = await pipeline.metadata();
    const { data, info } = await pipeline
      .rotate() // honour EXIF orientation: a sideways bird is still a bird
      .resize(size, size, { fit: 'fill', kernel: 'linear' })
      .removeAlpha()
      .toColourspace('srgb')
      .raw()
      .toBuffer({ resolveWithObject: true });
    return {
      data,
      width: info.width,
      height: info.height,
      channels: info.channels,
      sourceWidth: meta.width,
      sourceHeight: meta.height,
    };
  } catch (error) {
    // A corrupt or exotic file still deserves the ffmpeg attempt: libvips and
    // ffmpeg do not share decoders, so one of them often succeeds where the
    // other refuses.
    try {
      return await decodeWithFfmpeg(file, size);
    } catch {
      throw new Error('图片解码失败：' + (error?.message ?? error));
    }
  }
}
/** Pad the scaled frame onto a square canvas of the detector's pad colour. */
async function letterboxWithFfmpeg(file, size, geo) {
  const filter = [
    `scale=${geo.drawnWidth}:${geo.drawnHeight}:force_original_aspect_ratio=disable`,
    `pad=${size}:${size}:${geo.padLeft}:${geo.padTop}:color=0x727272`,
    'format=rgb24',
  ].join(',');
  try {
    const { stdout } = await runFfmpeg([
      '-nostdin', '-v', 'error', '-i', file,
      '-vf', filter, '-frames:v', '1', '-f', 'rawvideo', 'pipe:1',
    ], { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 });
    const expected = size * size * 3;
    if (stdout.length !== expected) {
      throw new Error(`ffmpeg 输出的 RGB 大小不符：期望 ${expected} 字节，实际 ${stdout.length}`);
    }
    return stdout;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(
        '缺少图片解码能力：sharp 不可用，插件自带的 ffmpeg 也没能就绪。'
        + '重新加载插件会重试下载，/birdstatus 会显示当前状态。',
      );
    }
    throw new Error('ffmpeg 解码图片失败：' + (error?.stderr?.toString?.() ?? error?.message ?? error));
  }
}

/**
 * Decode an image onto a square letterbox canvas, preserving aspect ratio.
 *
 * This is deliberately different from decodeImageToRgb, which stretches. The gate
 * detector has to map boxes back to the original pixels, and a stretch makes
 * that mapping lossy; letterboxing keeps one scalar to undo. Empty margins are
 * filled with RGB 114, the value YOLO's own preprocessor uses.
 */
export async function decodeImageLetterbox(file, size = 640) {
  let sharp;
  try {
    sharp = await loadSharp();
  } catch {
    const meta = await probeSizeWithFfmpeg(file);
    const geo = letterboxGeometry(size, meta.width, meta.height);
    const data = await letterboxWithFfmpeg(file, size, geo);
    return { data, width: size, height: size, channels: 3, sourceWidth: meta.width, sourceHeight: meta.height, ...geo };
  }
  try {
    const pipeline = sharp(file, { failOn: 'error', limitInputPixels: 64_000_000 }).rotate();
    const meta = await pipeline.metadata();
    const sourceWidth = meta.autoOrient?.width ?? meta.width;
    const sourceHeight = meta.autoOrient?.height ?? meta.height;
    const geo = letterboxGeometry(size, sourceWidth, sourceHeight);
    const { data } = await pipeline
      .resize(geo.drawnWidth, geo.drawnHeight, { fit: 'fill', kernel: 'linear' })
      .extend({
        top: geo.padTop,
        bottom: size - geo.drawnHeight - geo.padTop,
        left: geo.padLeft,
        right: size - geo.drawnWidth - geo.padLeft,
        background: { r: 114, g: 114, b: 114 },
      })
      .removeAlpha()
      .toColourspace('srgb')
      .raw()
      .toBuffer({ resolveWithObject: true });
    return { data, width: size, height: size, channels: 3, sourceWidth, sourceHeight, ...geo };
  } catch (error) {
    try {
      const meta = await probeSizeWithFfmpeg(file);
      const geo = letterboxGeometry(size, meta.width, meta.height);
      const data = await letterboxWithFfmpeg(file, size, geo);
      return { data, width: size, height: size, channels: 3, sourceWidth: meta.width, sourceHeight: meta.height, ...geo };
    } catch {
      throw new Error('图片解码失败：' + (error?.message ?? error));
    }
  }
}

/**
 * Ask ffmpeg for the frame size. ffprobe would be a second binary to ship.
 *
 * Two details cost an afternoon each if you get them wrong:
 *
 * - `-v error` prints no stream banner at all, so the size has to be read at
 *   `-v info`. That also means stderr must be collected on success, not only
 *   from a rejected promise.
 * - ffmpeg autorotates from EXIF by default, so the decoded frame is not the
 *   size the container header claims (a 600x400 file with orientation=6 decodes
 *   to 400x600). Crop and letterbox filters run after that rotation, so the
 *   geometry has to be measured in the rotated frame - which is what showinfo
 *   reports, and why it is preferred over the stream banner.
 */
async function probeSizeWithFfmpeg(file) {
  const { runFfmpeg } = await import('./ffmpeg.mjs');
  const args = [
    '-nostdin', '-v', 'info', '-i', file,
    '-vf', 'showinfo', '-frames:v', '1', '-f', 'null', '-',
  ];
  let stderr = '';
  try {
    const result = await runFfmpeg(args, { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 });
    stderr = String(result?.stderr ?? '');
  } catch (error) {
    stderr = String(error?.stderr ?? '');
    if (!stderr) throw new Error('无法读取图片尺寸：' + (error?.message ?? error));
  }
  const shown = stderr.match(/\bs:(\d{2,5})x(\d{2,5})\b/u);
  if (shown) return { width: Number(shown[1]), height: Number(shown[2]) };
  // Older builds without the showinfo line still print the stream banner; it is
  // the pre-rotation size, so it is a fallback rather than the first choice.
  const banner = stderr.match(/Stream #0:0[^\n]*?,\s*(\d{2,5})x(\d{2,5})[,\s]/u);
  if (banner) return { width: Number(banner[1]), height: Number(banner[2]) };
  throw new Error('无法读取图片尺寸：ffmpeg 没有报告宽高');
}

/**
 * Decode one rectangular region of an image into size x size RGB.
 *
 * Used for the bird crop: the detector found the bird, this cuts exactly that
 * region out and resamples it to what BirdTrace expects.
 */
export async function decodeImageCrop(file, box, size = 384) {
  const width = Math.max(1, Math.round(box.x2 - box.x1));
  const height = Math.max(1, Math.round(box.y2 - box.y1));
  const left = Math.max(0, Math.round(box.x1));
  const top = Math.max(0, Math.round(box.y1));

  let sharp;
  try {
    sharp = await loadSharp();
  } catch {
    return cropWithFfmpeg(file, { left, top, width, height }, size);
  }
  try {
    const { data, info } = await sharp(file, { failOn: 'error', limitInputPixels: 64_000_000 })
      .rotate()
      .extract({ left, top, width, height })
      .resize(size, size, { fit: 'fill', kernel: 'linear' })
      .removeAlpha()
      .toColourspace('srgb')
      .raw()
      .toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height, channels: info.channels, box: { left, top, width, height } };
  } catch (error) {
    try {
      return await cropWithFfmpeg(file, { left, top, width, height }, size);
    } catch {
      throw new Error('图片裁剪失败：' + (error?.message ?? error));
    }
  }
}

async function cropWithFfmpeg(file, { left, top, width, height }, size) {
  const filter = `crop=${width}:${height}:${left}:${top},scale=${size}:${size}:force_original_aspect_ratio=disable,format=rgb24`;
  try {
    const { stdout } = await runFfmpeg([
      '-nostdin', '-v', 'error', '-i', file,
      '-vf', filter, '-frames:v', '1', '-f', 'rawvideo', 'pipe:1',
    ], { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 });
    const expected = size * size * 3;
    if (stdout.length !== expected) {
      throw new Error(`ffmpeg 输出的 RGB 大小不符：期望 ${expected} 字节，实际 ${stdout.length}`);
    }
    return { data: stdout, width: size, height: size, channels: 3, box: { left, top, width, height } };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error('缺少图片解码能力：sharp 不可用，插件自带的 ffmpeg 也没能就绪。');
    }
    throw new Error('ffmpeg 裁剪图片失败：' + (error?.stderr?.toString?.() ?? error?.message ?? error));
  }
}
