import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

let sharpModule;
let sharpError;

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
    const { stdout } = await execFileAsync('ffmpeg', [
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
        '缺少图片解码能力：既没有 sharp，也没有 ffmpeg。'
        + '在手机 PRoot Ubuntu 里执行 apt install -y ffmpeg；可选的 sharp 可重新安装插件让它一并装上。',
      );
    }
    throw new Error('ffmpeg 解码图片失败：' + (error?.stderr?.toString?.() ?? error?.message ?? error));
  }
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
