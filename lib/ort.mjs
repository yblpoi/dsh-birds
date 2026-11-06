let ortModule;

/** Load onnxruntime-node lazily and surface an actionable failure. */
export async function loadOrt() {
  if (ortModule) return ortModule;
  try {
    ortModule = await import('onnxruntime-node');
    return ortModule;
  } catch (error) {
    const hint = 'onnxruntime-node 加载失败。请确认插件依赖已安装（安装插件时会一并安装）且当前平台有对应二进制'
      + '（linux-arm64、linux-x64、darwin-arm64、win32-arm64、win32-x64）；'
      + '在 Android 的 PRoot Ubuntu 里需要能 dlopen libonnxruntime.so.1。原始错误：'
      + (error?.message ?? error);
    const wrapped = new Error(hint);
    wrapped.cause = error;
    throw wrapped;
  }
}

export async function createSession(modelFile, options = {}) {
  const ort = await loadOrt();
  // Few intra-op threads keep a phone cool and avoid oversubscribing PRoot's
  // emulated CPU; callers may override per model.
  const sessionOptions = {
    graphOptimizationLevel: 'all',
    executionMode: 'sequential',
    intraOpNumThreads: options.intraOpNumThreads ?? 2,
    interOpNumThreads: 1,
    ...options.sessionOptions,
  };
  return ort.InferenceSession.create(modelFile, sessionOptions);
}

export function inputSpecOf(session) {
  const input = session.inputNames?.[0];
  const meta = session.inputMetadata?.[input] ?? {};
  return {
    name: input,
    dims: meta.dimensions ?? [],
    type: meta.type ?? 'float32',
  };
}

export function outputNamesOf(session) {
  return session.outputNames ?? [];
}

/**
 * Feed a flat Float32Array in the shape the session declares, casting to
 * float16 when the graph was exported that way (BirdNET+ ships FP16).
 *
 * @param {object} options.outputName pick this output explicitly; otherwise the
 *   widest 2-D output is chosen, which is what both BirdNET+ exports need (the
 *   acoustic graph also emits an embedding tensor).
 */
export async function runSession(session, spec, data, dims, options = {}) {
  const ort = await loadOrt();
  const feeds = {};
  const wantsHalf = String(spec.type).includes('float16');
  if (wantsHalf) {
    const half = new Uint16Array(data.length);
    for (let i = 0; i < data.length; i += 1) half[i] = float32ToFloat16(data[i]);
    feeds[spec.name] = new ort.Tensor('float16', half, dims);
  } else {
    feeds[spec.name] = new ort.Tensor('float32', data, dims);
  }
  const names = outputNamesOf(session);
  const results = await session.run(feeds, names.length > 0 ? names : undefined);
  const tensor = options.outputName
    ? results[options.outputName]
    : pickWidest(results);
  if (!tensor) {
    throw new Error('模型没有返回可用输出，实际输出为：' + Object.keys(results).join(', '));
  }
  return toFloat32(tensor.data);
}

function pickWidest(results) {
  let chosen;
  for (const tensor of Object.values(results)) {
    const entryDims = tensor.dims ?? [];
    if (!chosen) {
      chosen = tensor;
      continue;
    }
    const chosenDims = chosen.dims ?? [];
    if (entryDims.length === 2 && (chosenDims.length !== 2 || entryDims[1] > chosenDims[1])) chosen = tensor;
  }
  return chosen;
}

function toFloat32(data) {
  if (data instanceof Float32Array) return data;
  if (data instanceof Uint16Array) {
    const out = new Float32Array(data.length);
    for (let i = 0; i < data.length; i += 1) out[i] = float16ToFloat32(data[i]);
    return out;
  }
  return Float32Array.from(data);
}

/**
 * IEEE-754 binary32 -> binary16, round-to-nearest.
 *
 * Written out rather than pulled from a helper package because the plugin keeps
 * exactly one runtime dependency; verified against the reference conversion for
 * normals, subnormals, overflow to infinity and signed zero.
 */
export function float32ToFloat16(value) {
  const f32 = new Float32Array(1);
  const u32 = new Uint32Array(f32.buffer);
  f32[0] = value;
  const x = u32[0];

  const sign = (x >>> 16) & 0x8000;
  const exp = (x >>> 23) & 0xff;
  const mantissa = x & 0x7fffff;

  if (exp === 0xff) return sign | 0x7c00 | (mantissa ? 0x200 : 0); // Inf / NaN
  const unbiased = exp - 127;
  if (unbiased > 15) return sign | 0x7c00; // overflow -> infinity
  if (unbiased >= -14) {
    return (sign | ((unbiased + 15) << 10) | ((mantissa + 0x1000) >>> 13)) & 0xffff;
  }
  if (unbiased < -24) return sign; // underflow -> signed zero
  return (sign | (((mantissa | 0x800000) >>> (-unbiased - 1)))) & 0xffff;
}

export function float16ToFloat32(half) {
  const sign = (half & 0x8000) ? -1 : 1;
  const exp = (half >>> 10) & 0x1f;
  const mantissa = half & 0x3ff;
  if (exp === 0) return sign * 2 ** -14 * (mantissa / 1024);
  if (exp === 0x1f) return mantissa ? NaN : sign * Infinity;
  return sign * 2 ** (exp - 15) * (1 + mantissa / 1024);
}
