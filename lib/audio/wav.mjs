import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Minimal RIFF/WAVE reader. Supports PCM (8/16/24/32-bit integer) and
 * IEEE float (32/64-bit), which is what Telegram/telephone recorders,
 * Audacity exports and BirdNET examples produce. Anything else falls back
 * to ffmpeg when it is installed.
 */
export function parseWav(buffer) {
  if (buffer.length < 44) throw new Error('不是有效的 WAV：文件过短');
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('不是有效的 WAV：缺少 RIFF/WAVE 头');
  }
  let offset = 12;
  let fmt = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      fmt = {
        audioFormat: buffer.readUInt16LE(body),
        channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        byteRate: buffer.readUInt32LE(body + 8),
        blockAlign: buffer.readUInt16LE(body + 12),
        bitsPerSample: buffer.readUInt16LE(body + 14),
      };
      if (fmt.audioFormat === 0xfffe && size >= 40) {
        fmt.audioFormat = buffer.readUInt16LE(body + 24); // SubFormat GUID's first word
      }
    } else if (id === 'data') {
      if (!fmt) throw new Error('WAV 缺少 fmt 块');
      const end = Math.min(body + size, buffer.length);
      return { ...fmt, samples: decodePcm(buffer.subarray(body, end), fmt) };
    }
    offset = body + size + (size % 2);
  }
  throw new Error('WAV 缺少 data 块');
}

function decodePcm(bytes, fmt) {
  const { bitsPerSample, audioFormat, channels } = fmt;
  const frames = Math.floor(bytes.length / (fmt.blockAlign || ((bitsPerSample / 8) * channels)));
  const out = new Float32Array(frames);
  const read = (index) => {
    if (audioFormat === 3) {
      if (bitsPerSample === 32) return bytes.readFloatLE(index * 4);
      if (bitsPerSample === 64) return bytes.readDoubleLE(index * 8);
      throw new Error('不支持的浮点位深：' + bitsPerSample);
    }
    if (bitsPerSample === 8) return (bytes[index] - 128) / 128;
    if (bitsPerSample === 16) return bytes.readInt16LE(index * 2) / 32768;
    if (bitsPerSample === 24) {
      const lo = bytes[index * 3];
      const mid = bytes[index * 3 + 1];
      const hi = bytes[index * 3 + 2];
      let value = (hi << 16) | (mid << 8) | lo;
      if (value & 0x800000) value -= 0x1000000;
      return value / 8388608;
    }
    if (bitsPerSample === 32) return bytes.readInt32LE(index * 4) / 2147483648;
    throw new Error('不支持的整数位深：' + bitsPerSample);
  };
  // Downmix to mono by averaging channels: BirdNET+ expects one channel.
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      sum += read(frame * channels + channel);
    }
    out[frame] = sum / channels;
  }
  return out;
}

/** Decode any audio file ffmpeg understands into mono float samples. */
async function decodeWithFfmpeg(file, sampleRate) {
  try {
    const { stdout } = await execFileAsync('ffmpeg', [
      '-nostdin', '-v', 'error', '-i', file,
      '-f', 'f32le', '-ac', '1', '-ar', String(sampleRate), 'pipe:1',
    ], { encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 });
    const buffer = stdout;
    const samples = new Float32Array(buffer.length / 4);
    for (let i = 0; i < samples.length; i += 1) samples[i] = buffer.readFloatLE(i * 4);
    return { samples, sampleRate, channels: 1 };
  } catch (error) {
    const message = error?.code === 'ENOENT'
      ? '系统没有 ffmpeg，无法解码该音频格式。请在手机上转换后发 WAV，或安装 ffmpeg（PRoot Ubuntu 里执行 apt install -y ffmpeg）。'
      : 'ffmpeg 解码失败：' + (error?.stderr?.toString?.() ?? error?.message ?? error);
    throw new Error(message);
  }
}

/**
 * Read an audio file at any sample rate and return mono Float32 samples.
 * WAV is parsed natively; every other container goes through ffmpeg.
 */
export async function readAudio(file, { sampleRate = 32000, logger } = {}) {
  const buffer = await fs.readFile(file);
  const isWav = buffer.length > 12
    && buffer.toString('ascii', 0, 4) === 'RIFF'
    && buffer.toString('ascii', 8, 12) === 'WAVE';
  if (isWav) {
    try {
      const wav = parseWav(buffer);
      logger?.debug?.(`wav: ${wav.channels}ch ${wav.sampleRate}Hz ${wav.bitsPerSample}bit ${wav.samples.length} frames`);
      return { samples: wav.samples, sampleRate: wav.sampleRate, channels: wav.channels };
    } catch (error) {
      logger?.warn?.('native WAV parse failed, falling back to ffmpeg: ' + (error?.message ?? error));
    }
  }
  return decodeWithFfmpeg(file, sampleRate);
}
