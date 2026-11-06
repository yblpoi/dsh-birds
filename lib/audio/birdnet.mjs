import fs from 'node:fs/promises';
import { createSession, inputSpecOf, runSession } from '../ort.mjs';
import { modelPath } from '../paths.mjs';
import { planChunks, sliceChunk } from './chunk.mjs';
import { resampleTo } from './resample.mjs';

const SAMPLE_RATE = 32000;

/**
 * BirdNET+ V3.0 acoustic classifier.
 *
 * Unlike V2 the V3 export consumes the raw waveform: the graph contains its own
 * front end (framing, windowing, log-mel), so no STFT has to be computed in JS.
 * That also means the model accepts variable-length audio; a fixed 3 s window is
 * only the default analysis unit.
 *
 * Labels come from a semicolon-separated CSV with an id;sci_name;com_name;gbif;
 * class;order header, and index i of the prediction tensor maps to row i.
 */
export class AcousticClassifier {
  #modelsDir;
  #session;
  #input;
  #labels;
  #logger;

  constructor({ modelsDir, logger } = {}) {
    this.#modelsDir = modelsDir;
    this.#logger = logger;
  }

  get ready() {
    return Boolean(this.#session);
  }

  get labelCount() {
    return this.#labels?.length ?? 0;
  }

  async #loadLabels() {
    if (this.#labels) return this.#labels;
    const text = await fs.readFile(modelPath(this.#modelsDir, 'audioLabels'), 'utf8');
    const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
    if (lines.length === 0) throw new Error('BirdNET 标签 CSV 为空');
    const header = splitCsvLine(lines[0]);
    const sciIndex = header.indexOf('sci_name');
    const comIndex = header.indexOf('com_name');
    const idIndex = header.indexOf('id');
    const rows = [];
    for (let i = 1; i < lines.length; i += 1) {
      const cells = splitCsvLine(lines[i]);
      const scientific = (cells[sciIndex >= 0 ? sciIndex : 1] ?? '').trim();
      const common = (cells[comIndex >= 0 ? comIndex : 2] ?? '').trim();
      if (!scientific && !common) continue;
      rows.push({
        index: rows.length,
        id: idIndex >= 0 ? (cells[idIndex] ?? '').trim() : String(rows.length),
        scientific,
        common,
      });
    }
    this.#labels = rows;
    return rows;
  }

  async load() {
    if (this.#session) return this;
    const [session, labels] = await Promise.all([
      createSession(modelPath(this.#modelsDir, 'audioModel')),
      this.#loadLabels(),
    ]);
    this.#session = session;
    this.#input = inputSpecOf(session);
    this.#logger?.info?.(
      `bird acoustic model ready: input=${this.#input.name} dims=[${this.#input.dims}] type=${this.#input.type} labels=${labels.length}`,
    );
    return this;
  }

  /**
   * Analyse one audio buffer at any sample rate.
   * @returns per-window and per-species detections above minConfidence.
   */
  async analyze(samples, sourceRate, {
    chunkSeconds = 3,
    overlapSeconds = 0,
    minConfidence = 0.15,
    maxWindows = 400,
    topPerWindow = 5,
  } = {}) {
    await this.load();
    const mono = resampleTo(samples, sourceRate, SAMPLE_RATE);
    const { chunks, chunkSamples } = planChunks(mono.length, {
      sampleRate: SAMPLE_RATE,
      chunkSeconds,
      overlapSeconds,
    });
    const windows = [];
    const perSpecies = new Map();
    const limited = chunks.slice(0, maxWindows);
    for (let i = 0; i < limited.length; i += 1) {
      const chunk = limited[i];
      const pcm = sliceChunk(mono, chunk, chunkSamples);
      const scores = await runSession(this.#session, this.#input, pcm, [1, chunkSamples]);
      const startSec = chunk.start / SAMPLE_RATE;
      const endSec = chunk.end / SAMPLE_RATE;
      const top = topIndices(scores, topPerWindow);
      windows.push({
        index: i,
        startSec,
        endSec,
        top: top.map(([index, score]) => ({
          index,
          score,
          scientific: this.#labels[index]?.scientific ?? '',
          common: this.#labels[index]?.common ?? '',
        })),
      });
      for (let index = 0; index < scores.length; index += 1) {
        const score = scores[index];
        if (score < minConfidence) continue;
        const current = perSpecies.get(index);
        if (!current || score > current.score) {
          perSpecies.set(index, {
            index,
            score,
            scientific: this.#labels[index]?.scientific ?? '',
            common: this.#labels[index]?.common ?? '',
            firstSeenSec: startSec,
            lastSeenSec: endSec,
            hits: (current?.hits ?? 0) + 1,
          });
        } else {
          current.lastSeenSec = endSec;
          current.hits += 1;
        }
      }
    }
    const detections = [...perSpecies.values()].sort((a, b) => b.score - a.score);
    return {
      sampleRate: SAMPLE_RATE,
      durationSec: mono.length / SAMPLE_RATE,
      windowCount: windows.length,
      truncated: chunks.length > limited.length,
      windows,
      detections,
      // Raw per-window score matrix is intentionally not returned: the caller
      // only renders text, and keeping 400 x 11K floats alive on a phone is waste.
    };
  }
}

/** Split one semicolon CSV row, honouring double quotes. */
function splitCsvLine(line) {
  const cells = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (char === ';' && !quoted) {
      cells.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  cells.push(current);
  return cells;
}

function topIndices(scores, count) {
  const best = [];
  for (let i = 0; i < scores.length; i += 1) {
    const score = scores[i];
    if (best.length < count) {
      best.push([i, score]);
      best.sort((a, b) => b[1] - a[1]);
    } else if (score > best[best.length - 1][1]) {
      best[best.length - 1] = [i, score];
      best.sort((a, b) => b[1] - a[1]);
    }
  }
  return best;
}
