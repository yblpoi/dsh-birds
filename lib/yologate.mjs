/**
 * YOLO26n-seg COCO detector — the gate in front of the bird classifier.
 *
 * Why this exists: BirdTrace always answers *something*. Handed a photograph of
 * a car it still emits a confident-looking species, because the graph has never
 * been asked "is there a bird here at all". This detector answers that question
 * first, and hands back a crop of the bird so the classifier sees a subject that
 * fills the frame instead of a bird the size of a thumbnail.
 *
 * Contract, verified against unileon-robotics/YOLO26-ONNX dynamic export:
 *   input   "images"   float32 [1, 3, H, W]     (dynamic; we use 640x640)
 *   output0 "output0"  float32 [1, 4+nc+nm, anchors]  (raw, no NMS applied)
 *   output1 "output1"  float32 [1, 32, H/4, W/4]      (mask prototype planes)
 *
 * output0 is stored channel-major, so one anchor's numbers are strided by
 * "anchors", not contiguous. Getting that wrong silently yields nonsense boxes.
 *
 * License: the weights are AGPL-3.0 (see NOTICE in LICENSE). They are fetched
 * at runtime by provision.mjs and never vendored into this repository.
 */

import { createSession, inputSpecOf, loadOrt } from './ort.mjs';
import { letterboxGeometry } from './imagedecode.mjs';
import { modelPath } from './paths.mjs';

export { letterboxGeometry };

/** Detection resolution. 640 is what the COCO export was trained for. */
export const GATE_SIZE = 640;

/**
 * Second-pass resolution, used only when the first pass finds nothing at all.
 *
 * Measured on a 1600x1200 frame with a bird pasted at a known size: 640 catches
 * a bird 19% of the frame wide and misses one at 10%; 960 catches the 10% bird.
 * Re-running everything at 960 would double the latency of the common case, so
 * the retry is spent only where the first pass has no answer to give - and a
 * frame with nothing in it is exactly the frame that used to end in a confident
 * hallucinated species. 1280 was measured too and found no further birds.
 */
export const GATE_RETRY_SIZE = 960;

/**
 * A bird detection below this score is not worth cropping for.
 *
 * The retry above is only a partial answer: a lizard at 640 produced "bird 0.30"
 * with no real bird in the frame at all, which is neither an empty frame nor a
 * bird, and would otherwise be cropped and answered with a 15%-confident
 * species. Genuine birds measured here score 0.70 and up even when they occupy
 * a few tenths of a percent of the frame, so 0.5 separates the two populations
 * with room to spare, and the retry decides what the weak hit really was.
 */
export const GATE_WEAK_BIRD = 0.5;

/** The COCO class this plugin is actually about. */
export const BIRD_CLASS = 14;

/** Letterbox padding colour; the YOLO convention, not white. */
const PAD = 114;

/**
 * COCO-80 class names, in label order.
 *
 * Kept here rather than in a JSON file: the list is fixed by the dataset, it is
 * 80 short strings, and shipping it inline means a gate model can never be
 * paired with the wrong label table.
 */
export const COCO_CLASSES = Object.freeze([
  'person', 'bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck', 'boat',
  'traffic light', 'fire hydrant', 'stop sign', 'parking meter', 'bench', 'bird', 'cat',
  'dog', 'horse', 'sheep', 'cow', 'elephant', 'bear', 'zebra', 'giraffe', 'backpack',
  'umbrella', 'handbag', 'tie', 'suitcase', 'frisbee', 'skis', 'snowboard', 'sports ball',
  'kite', 'baseball bat', 'baseball glove', 'skateboard', 'surfboard', 'tennis racket',
  'bottle', 'wine glass', 'cup', 'fork', 'knife', 'spoon', 'bowl', 'banana', 'apple',
  'sandwich', 'orange', 'broccoli', 'carrot', 'hot dog', 'pizza', 'donut', 'cake', 'chair',
  'couch', 'potted plant', 'bed', 'dining table', 'toilet', 'tv', 'laptop', 'mouse',
  'remote', 'keyboard', 'cell phone', 'microwave', 'oven', 'toaster', 'sink',
  'refrigerator', 'book', 'clock', 'vase', 'scissors', 'teddy bear', 'hair drier',
  'toothbrush',
]);

/** English -> Chinese for the COCO-80 list, same order. */
export const COCO_ZH = Object.freeze([
  '人', '自行车', '汽车', '摩托车', '飞机', '公交车', '火车', '卡车', '船',
  '红绿灯', '消防栓', '停车标志牌', '停车计时器', '长椅', '鸟', '猫',
  '狗', '马', '羊', '牛', '大象', '熊', '斑马', '长颈鹿', '背包',
  '雨伞', '手提包', '领带', '行李箱', '飞盘', '滑雪板', '单板滑雪', '球',
  '风筝', '棒球棒', '棒球手套', '滑板', '冲浪板', '网球拍',
  '瓶子', '红酒杯', '杯子', '叉子', '刀', '勺子', '碗', '香蕉', '苹果',
  '三明治', '橙子', '西兰花', '胡萝卜', '热狗', '披萨', '甜甜圈', '蛋糕', '椅子',
  '沙发', '盆栽', '床', '餐桌', '马桶', '电视', '笔记本电脑', '鼠标',
  '遥控器', '键盘', '手机', '微波炉', '烤箱', '烤面包机', '水槽',
  '冰箱', '书', '时钟', '花瓶', '剪刀', '泰迪熊', '吹风机',
  '牙刷',
]);

/** "鸟" when both halves are known, otherwise whichever one exists. */
export function className(index) {
  const en = COCO_CLASSES[index];
  const zh = COCO_ZH[index];
  return { en: en ?? `class ${index}`, zh: zh ?? '' };
}

/** Human label for a detected class, Chinese with the English in brackets. */
export function classLabel(index) {
  const { en, zh } = className(index);
  return zh ? `${zh}（${en}）` : en;
}

/**
 * Intersection-over-union of two boxes in xyxy form.
 * Exported because the NMS tests assert against it directly.
 */
export function iou(a, b) {
  const x1 = Math.max(a.x1, b.x1);
  const y1 = Math.max(a.y1, b.y1);
  const x2 = Math.min(a.x2, b.x2);
  const y2 = Math.min(a.y2, b.y2);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  if (inter <= 0) return 0;
  const areaA = Math.max(0, a.x2 - a.x1) * Math.max(0, a.y2 - a.y1);
  const areaB = Math.max(0, b.x2 - b.x1) * Math.max(0, b.y2 - b.y1);
  const union = areaA + areaB - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * Class-wise non-maximum suppression.
 *
 * output0 carries no NMS, so a single bird produces a dozen overlapping boxes.
 * Suppressing per class (not globally) is what keeps a dog sitting next to a
 * bird from deleting the bird.
 */
export function nonMaxSuppression(detections, threshold = 0.45) {
  const kept = [];
  const byClass = new Map();
  for (const det of detections) {
    const list = byClass.get(det.classIndex);
    if (list) list.push(det);
    else byClass.set(det.classIndex, [det]);
  }
  for (const list of byClass.values()) {
    list.sort((a, b) => b.score - a.score);
    const survivors = [];
    for (const det of list) {
      if (survivors.every((other) => iou(other, det) <= threshold)) survivors.push(det);
    }
    kept.push(...survivors);
  }
  kept.sort((a, b) => b.score - a.score);
  return kept;
}

/**
 * Scale one detection from letterboxed model space back to source pixels.
 *
 * The inverse of the letterbox: subtract the pad, undo the uniform scale, then
 * clamp into the source frame so a box that bled into the padding still maps to
 * a legal crop.
 */
export function unletterboxBox(box, { size, srcWidth, srcHeight }) {
  const { padLeft, padTop, scale } = letterboxGeometry(size, srcWidth, srcHeight);
  const x1 = (box.x1 - padLeft) / scale;
  const y1 = (box.y1 - padTop) / scale;
  const x2 = (box.x2 - padLeft) / scale;
  const y2 = (box.y2 - padTop) / scale;
  return {
    x1: clamp(x1, 0, srcWidth),
    y1: clamp(y1, 0, srcHeight),
    x2: clamp(x2, 0, srcWidth),
    y2: clamp(y2, 0, srcHeight),
  };
}

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

/**
 * Decode raw YOLO-seg output into scored boxes.
 *
 * @param {Float32Array} output0 raw [1, 4+nc+nm, anchors] data
 * @param {{anchors:number, channels:number, classCount:number}} shape
 * @param {{confidence:number}} options
 */
export function decodeOutput(output0, { anchors, channels, classCount }, { confidence = 0.25 } = {}) {
  const maskCoeffs = channels - 4 - classCount;
  const detections = [];
  for (let a = 0; a < anchors; a += 1) {
    // Find the best class for this anchor. Scores are already 0..1 — the export
    // applies sigmoid internally, so applying it again would be wrong.
    let bestClass = -1;
    let bestScore = 0;
    for (let c = 0; c < classCount; c += 1) {
      const score = output0[(4 + c) * anchors + a];
      if (score > bestScore) {
        bestScore = score;
        bestClass = c;
      }
    }
    if (bestClass < 0 || bestScore < confidence) continue;
    const cx = output0[a];
    const cy = output0[anchors + a];
    const w = output0[2 * anchors + a];
    const h = output0[3 * anchors + a];
    const coeffs = new Float32Array(maskCoeffs);
    for (let k = 0; k < maskCoeffs; k += 1) {
      coeffs[k] = output0[(4 + classCount + k) * anchors + a];
    }
    detections.push({
      classIndex: bestClass,
      score: bestScore,
      // Kept as centre/size through NMS; converted to corners by toBox().
      cx,
      cy,
      w,
      h,
      x1: cx - w / 2,
      y1: cy - h / 2,
      x2: cx + w / 2,
      y2: cy + h / 2,
      maskCoeffs: coeffs,
    });
  }
  return detections;
}

/**
 * Squash mask coefficients through the protos into a boolean mask.
 *
 * Only computed for the handful of detections that survive NMS, because
 * materialising 32 channels x H/4 x W/4 for all 8400 anchors is the one thing
 * that would make this slow on a phone.
 */
export function buildMask(coeffs, protos, { protoHeight, protoWidth }) {
  const plane = protoHeight * protoWidth;
  const mask = new Uint8Array(plane);
  for (let i = 0; i < plane; i += 1) {
    let sum = 0;
    for (let k = 0; k < coeffs.length; k += 1) {
      sum += coeffs[k] * protos[k * plane + i];
    }
    mask[i] = sum > 0 ? 1 : 0;
  }
  return mask;
}

/**
 * Expand a box outward before cropping, so wings and tails are not clipped.
 *
 * The detector box hugs the body; feeding exactly that to BirdTrace amputates
 * the parts a classifier uses for species. The margin is applied toward the
 * source edges rather than uniformly, so a crop never extends past the frame
 * and introduces a grey band the classifier would have to ignore.
 */
export function expandBox(box, { margin = 0.25, srcWidth, srcHeight }) {
  const w = box.x2 - box.x1;
  const h = box.y2 - box.y1;
  const dx = w * margin;
  const dy = h * margin;
  return {
    x1: clamp(Math.floor(box.x1 - dx), 0, srcWidth),
    y1: clamp(Math.floor(box.y1 - dy), 0, srcHeight),
    x2: clamp(Math.ceil(box.x2 + dx), 0, srcWidth),
    y2: clamp(Math.ceil(box.y2 + dy), 0, srcHeight),
  };
}

/**
 * Which pass' detections to believe, given a first look and an optional second.
 *
 * The retry exists because 640 misses birds below roughly a fifth of the frame
 * width; it is spent only when the first pass has no bird worth trusting (see
 * needsRetry). This function is the whole decision, kept pure so the rule can be
 * tested without an ONNX session:
 *
 *   - a trustworthy bird in either pass wins, and brings its own frame size
 *     with it (the two passes are letterboxed from the same source image, so
 *     the sizes agree, but only the winning pass' boxes are in its own model
 *     coordinates and must be unletterboxed against its own size);
 *   - otherwise the retry is trusted for the bird question only: downscaling
 *     further also loses small *other* objects, so the object inventory comes
 *     from whichever pass actually saw something, with the rejected bird class
 *     removed from it.
 *
 * Returns { sourceWidth, sourceHeight, detections, bird }, where bird is the
 * trusted BIRD_CLASS detection or undefined.
 */
export function resolveGatePasses({ first, second = null, weakBird = GATE_WEAK_BIRD }) {
  const trustworthy = (pass) => {
    const best = strongestBird(pass.detections);
    return best !== undefined && best.score >= weakBird ? best : undefined;
  };

  const firstBird = trustworthy(first);
  if (firstBird !== undefined) {
    return { ...first, detections: first.detections, bird: firstBird };
  }
  if (second === null) {
    // No retry was run: the first pass is all the information there is, and its
    // weak bird is not to be acted on, but its other objects still stand.
    return { ...first, detections: dropBirds(first.detections), bird: undefined };
  }

  const secondBird = trustworthy(second);
  if (secondBird !== undefined) {
    return { ...second, detections: second.detections, bird: secondBird };
  }
  const source = second.detections.length > 0 ? second : first;
  return { ...source, detections: dropBirds(source.detections), bird: undefined };
}

/** Whether a first pass with these detections deserves a closer look. */
export function needsRetry(detections, weakBird = GATE_WEAK_BIRD) {
  if (detections.length === 0) return true;
  const bird = strongestBird(detections);
  return bird !== undefined && bird.score < weakBird;
}

/** The highest-scoring BIRD_CLASS detection, or undefined. */
export function strongestBird(detections) {
  return detections
    .filter((det) => det.classIndex === BIRD_CLASS)
    .reduce((top, det) => (top === undefined || det.score > top.score ? det : top), undefined);
}

const dropBirds = (detections) => detections.filter((det) => det.classIndex !== BIRD_CLASS);

/**
 * The detector wrapper.
 *
 * One session per host, built on first use, matching the lazy pattern the other
 * engines use: a host that only ever sends audio never pays for these weights.
 */
export class BirdGate {
  #modelsDir;
  #logger;
  #session;
  #spec;
  #outputs;
  #loading;

  constructor({ modelsDir, logger } = {}) {
    this.#modelsDir = modelsDir;
    this.#logger = logger;
  }

  get ready() {
    return Boolean(this.#session);
  }

  async load() {
    if (this.#session) return this;
    this.#loading ??= (async () => {
      const session = await createSession(modelPath(this.#modelsDir, 'gateModel'));
      this.#session = session;
      this.#spec = inputSpecOf(session);
      this.#outputs = session.outputNames ?? [];
      this.#logger?.info?.(
        `门控模型就绪：input=${this.#spec.name} outputs=${this.#outputs.join(',')}`,
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
   * Detect every COCO object in one letterboxed RGB buffer.
   *
   * @param {Uint8Array} rgb interleaved RGB, size*size*3, values 0..255
   * @param {{size?:number, confidence?:number, iouThreshold?:number}} options
   */
  async detect(rgb, { size = GATE_SIZE, confidence = 0.25, iouThreshold = 0.45 } = {}) {
    await this.load();
    const plane = size * size;
    const tensor = new Float32Array(3 * plane);
    for (let pixel = 0; pixel < plane; pixel += 1) {
      const base = pixel * 3;
      // YOLO wants [0,1] with no mean/std normalisation at all — unlike
      // BirdTrace, whose graph embeds those constants.
      tensor[pixel] = rgb[base] / 255;
      tensor[plane + pixel] = rgb[base + 1] / 255;
      tensor[2 * plane + pixel] = rgb[base + 2] / 255;
    }

    const ort = await loadOrt();
    const feeds = { [this.#spec.name]: new ort.Tensor('float32', tensor, [1, 3, size, size]) };
    const results = await this.#session.run(feeds);

    const out0 = results[this.#outputs[0]];
    const out1 = results[this.#outputs[1]];
    if (!out0) throw new Error('门控模型没有返回 output0，实际输出：' + Object.keys(results).join(', '));

    const [, channels, anchors] = out0.dims;
    const classCount = COCO_CLASSES.length;
    const detections = decodeOutput(
      Float32Array.from(out0.data),
      { anchors, channels, classCount },
      { confidence },
    );
    const kept = nonMaxSuppression(detections, iouThreshold);

    const protoDims = out1?.dims ?? [];
    return {
      size,
      detections: kept,
      protoDims,
      protos: out1 ? Float32Array.from(out1.data) : undefined,
    };
  }
}