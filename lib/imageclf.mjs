import fs from 'node:fs/promises';
import { createSession, inputSpecOf, runSession } from './ort.mjs';
import { modelPath } from './paths.mjs';
import { bindLabels, chineseName, labelDigest } from './names.mjs';

/**
 * BirdTrace FastViT-MA36-10K image classifier.
 *
 * Contract, verified against the published ONNX and preprocessor_config.json:
 *   input   "image"          float32 [1, 3, 384, 384]  (batch fixed at 1)
 *   output  "visual_logits"  float32 [1, 10480]        (raw logits, no softmax)
 *
 * The graph embeds (x - mean) / std with mean [0.485, 0.456, 0.406] and
 * std [0.229, 0.224, 0.225], but it does NOT embed the /255 rescale, so the
 * caller divides by 255 and must not subtract the mean again.
 */
export const IMAGE_SIZE = 384;

export class ImageClassifier {
  #modelsDir;
  #logger;
  #session;
  #spec;
  #classes;
  #loading;

  constructor({ modelsDir, logger } = {}) {
    this.#modelsDir = modelsDir;
    this.#logger = logger;
  }

  get ready() {
    return Boolean(this.#session);
  }

  get classCount() {
    return this.#classes?.length ?? 0;
  }

  async #loadClasses() {
    const raw = await fs.readFile(modelPath(this.#modelsDir, 'imageClasses'), 'utf8');
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : (parsed.classes ?? []);
    if (!Array.isArray(list) || list.length === 0) {
      throw new Error('classes.json 结构不是预期的数组');
    }
    // The Chinese names are stored by row index, so they are only usable when
    // this is exactly the label file they were generated from.
    bindLabels('image', labelDigest(raw), this.#logger);
    return list.map((entry, index) => {
      if (typeof entry === 'string') return { index, speciesId: entry, scientific: entry, common: '' };
      return {
        index: Number.isInteger(entry?.index) ? entry.index : index,
        speciesId: String(entry?.species_id ?? ''),
        // The release stores an underscore-joined English common name in
        // species_name and ships no scientific name, so it is shown verbatim
        // rather than guessed at.
        scientific: String(entry?.species_name ?? ''),
        common: String(entry?.common_name ?? ''),
      };
    });
  }

  /** Load once; concurrent first calls share one session. */
  async load() {
    if (this.#session) return this;
    this.#loading ??= (async () => {
      const [session, classes] = await Promise.all([
        createSession(modelPath(this.#modelsDir, 'imageModel')),
        this.#loadClasses(),
      ]);
      this.#session = session;
      this.#spec = inputSpecOf(session);
      this.#classes = classes;
      this.#logger?.info?.(
        `图片模型就绪：input=${this.#spec.name} dims=[${this.#spec.dims}] type=${this.#spec.type} classes=${classes.length}`,
      );
      return this;
    })();
    try {
      return await this.#loading;
    } finally {
      this.#loading = undefined;
    }
  }

  /**
   * Run one interleaved RGB buffer through the model.
   * @param {Buffer|Uint8Array} rgb width*height*3 bytes, values 0..255
   * @returns top-k candidates, sorted by descending probability
   */
  async classify(rgb, { size = IMAGE_SIZE, topK = 5 } = {}) {
    await this.load();
    const plane = size * size;
    const tensor = new Float32Array(3 * plane);
    for (let pixel = 0; pixel < plane; pixel += 1) {
      const base = pixel * 3;
      // NCHW layout, [0, 1] range. Dividing by 255 is the rescale the graph
      // does not do; the embedded normalization handles everything else.
      tensor[pixel] = rgb[base] / 255;
      tensor[plane + pixel] = rgb[base + 1] / 255;
      tensor[2 * plane + pixel] = rgb[base + 2] / 255;
    }
    const logits = await runSession(this.#session, this.#spec, tensor, [1, 3, size, size], {
      outputName: 'visual_logits',
    });
    return this.#toCandidates(logits, topK);
  }

  /** Softmax over raw logits, then top-k. The graph emits logits, not scores. */
  #toCandidates(logits, topK) {
    const classes = this.#classes;
    let max = -Infinity;
    for (let i = 0; i < logits.length; i += 1) {
      if (logits[i] > max) max = logits[i];
    }
    const probabilities = new Float32Array(logits.length);
    let sum = 0;
    for (let i = 0; i < logits.length; i += 1) {
      const value = Math.exp(logits[i] - max);
      probabilities[i] = value;
      sum += value;
    }
    if (sum > 0) {
      for (let i = 0; i < probabilities.length; i += 1) probabilities[i] /= sum;
    }

    // A bounded insertion keeps the top-k hot path allocation-free for the
    // 10480-way output; sorting the whole array on a phone is measurably slower.
    const count = Math.max(1, Math.min(topK, probabilities.length));
    const bestIndex = new Int32Array(count).fill(-1);
    const bestScore = new Float32Array(count);
    for (let i = 0; i < probabilities.length; i += 1) {
      const score = probabilities[i];
      if (score <= bestScore[count - 1] && bestIndex[count - 1] !== -1) continue;
      let slot = count - 1;
      while (slot > 0 && (bestIndex[slot - 1] === -1 || score > bestScore[slot - 1])) {
        bestIndex[slot] = bestIndex[slot - 1];
        bestScore[slot] = bestScore[slot - 1];
        slot -= 1;
      }
      bestIndex[slot] = i;
      bestScore[slot] = score;
    }

    const out = [];
    for (let slot = 0; slot < count; slot += 1) {
      const index = bestIndex[slot];
      if (index < 0) continue;
      const entry = classes[index] ?? {};
      out.push({
        index,
        score: bestScore[slot],
        speciesId: entry.speciesId ?? '',
        scientific: entry.scientific ?? '',
        common: entry.common ?? '',
        chinese: chineseName('image', index),
      });
    }
    return out;
  }
}
