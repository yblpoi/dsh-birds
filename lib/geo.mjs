import fs from 'node:fs/promises';
import { createSession, inputSpecOf, runSession } from './ort.mjs';
import { modelPath, fileExists } from './paths.mjs';

/** Species absent from the local list are dropped; 0.03 is the official default. */
export const DEFAULT_GEO_THRESHOLD = 0.03;

/**
 * BirdNET+ Geomodel V3.0.4 (Global, 14K taxa).
 *
 * Contract, verified against the published ONNX:
 *   input   "input"          float32 [batch, 3]   = [lat, lon, week]
 *   output  "probabilities"  float32 [batch, 14082], sigmoid already embedded
 *
 * lat/lon are plain degrees (-90..90 / -180..180) and week is 1..48; the model
 * builds its own circular encodings, so no shifting into [0, 1] happens here.
 * The 14K taxonomy is neither the same length nor the same order as the 11K
 * acoustic list, so results are joined by scientific name and never by index.
 */
export class GeoPrior {
  #modelsDir;
  #logger;
  #session;
  #spec;
  #labels;
  #loaded = false;
  #unavailableReason;

  constructor({ modelsDir, logger } = {}) {
    this.#modelsDir = modelsDir;
    this.#logger = logger;
  }

  get ready() {
    return Boolean(this.#session);
  }

  get unavailable() {
    return this.#unavailableReason;
  }

  async #loadLabels() {
    if (this.#labels) return this.#labels;
    const file = modelPath(this.#modelsDir, 'geoLabels');
    if (!fileExists(file)) return null;
    const text = await fs.readFile(file, 'utf8');
    const labels = new Map();
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const cells = line.split('\t');
      if (cells.length < 2) continue;
      const scientific = (cells[1] ?? '').trim();
      const common = (cells[2] ?? '').trim();
      if (!scientific) continue;
      labels.set(scientific.toLowerCase(), { scientific, common, code: (cells[0] ?? '').trim() });
    }
    this.#labels = labels;
    return labels;
  }

  async load() {
    if (this.#loaded) return this;
    this.#loaded = true;
    const file = modelPath(this.#modelsDir, 'geoModel');
    if (!fileExists(file)) {
      this.#unavailableReason = '未找到 Geomodel 文件，已跳过地理筛物种';
      this.#logger?.debug?.(this.#unavailableReason);
      return this;
    }
    try {
      this.#session = await createSession(file);
      this.#spec = inputSpecOf(this.#session);
      await this.#loadLabels();
      this.#logger?.info?.(
        `geomodel ready: input=${this.#spec.name} dims=[${this.#spec.dims}] type=${this.#spec.type}`,
      );
    } catch (error) {
      this.#unavailableReason = 'Geomodel 加载失败：' + (error?.message ?? error);
      this.#logger?.warn?.(this.#unavailableReason);
      this.#session = undefined;
    }
    return this;
  }

  /**
   * Per-taxon occurrence probabilities for one place and week.
   * @returns {{ probabilities: Float32Array, labels: Map<string, object> } | null}
   */
  async predict(lat, lon, week = 24) {
    await this.load();
    if (!this.#session) return null;
    const normalisedWeek = Math.min(48, Math.max(1, week));
    const input = Float32Array.from([lat, lon, normalisedWeek]);
    // The graph declares a symbolic batch dimension, but onnxruntime-node
    // rejects a non-integer dim, so the concrete [1, 3] shape is passed instead.
    const probabilities = await runSession(this.#session, this.#spec, input, [1, 3], {
      outputName: 'probabilities',
    });
    return { probabilities, labels: this.#labels ?? new Map() };
  }

  /**
   * The official shape of this model's contribution: a boolean gate. Species
   * whose occurrence probability does not clear the threshold are dropped from
   * the acoustic candidate list, exactly as BirdNET-Analyzer does.
   *
   * @returns {Set<string>} lowercased scientific names allowed at this place/week
   */
  async allowedSpecies(lat, lon, week, { threshold = DEFAULT_GEO_THRESHOLD } = {}) {
    const prediction = await this.predict(lat, lon, week);
    if (!prediction) return null;
    const { probabilities, labels } = prediction;
    const indexToName = [...labels.keys()];
    const allowed = new Set();
    for (let i = 0; i < probabilities.length; i += 1) {
      if (probabilities[i] < threshold) continue;
      const name = indexToName[i];
      if (name) allowed.add(name);
    }
    return allowed;
  }
}

/**
 * Drop detections whose species the geomodel rules out.
 *
 * The acoustic list (11K) and the geomodel list (14K) are joined on the
 * scientific name, because they are different taxonomies; a detection with no
 * scientific name is kept, since aliasing would otherwise discard everything.
 */
export function filterByAllowedSpecies(detections, allowed) {
  if (!allowed || allowed.size === 0) return { kept: detections, dropped: 0, applied: false };
  const kept = [];
  let dropped = 0;
  for (const detection of detections) {
    const name = (detection.scientific ?? '').toLowerCase().trim();
    const key = name.replace(/[\s_]+/g, ' ');
    if (!key) {
      kept.push(detection);
      continue;
    }
    if (allowed.has(key)) kept.push(detection);
    else dropped += 1;
  }
  return { kept, dropped, applied: true };
}

/** Species names in the acoustic list normalised to the geomodel's spacing. */
export function normaliseSpeciesName(name) {
  return String(name ?? '').toLowerCase().trim().replace(/[\s_]+/g, ' ');
}
