const percent = (score) => (Number.isFinite(score) ? (score * 100).toFixed(1) + '%' : '?');

/**
 * "中文名（English）" when both halves are known.
 *
 * Chinese names come from the IOC list shipped with the plugin. Species the
 * list does not cover — BirdNET also labels insects, frogs and other taxa — keep
 * their English name and fall back to the scientific name, so a reply never
 * shows a Chinese name that belongs to a different bird.
 */
function speciesLabel({ chinese, english, scientific }) {
  const zh = String(chinese ?? '').trim();
  const en = String(english ?? '').replace(/_/gu, ' ').trim();
  const sci = String(scientific ?? '').replace(/_/gu, ' ').trim();
  if (zh && en) return `${zh}（${en}）`;
  if (zh && sci) return `${zh}（${sci}）`;
  if (en && sci && en.toLowerCase() !== sci.toLowerCase()) return `${en}（${sci}）`;
  return en || sci || '未知物种';
}

/**
 * Render the reply for a photo the gate decided is not a bird.
 *
 * This is the honest answer BirdTrace could never give: handed a car it still
 * returned a species, because nothing upstream ever asked whether a bird was
 * there. The gate knows better, so the reply names the COCO object it found
 * instead of inventing a bird.
 */
export function formatNonBirdResult({ detections, elapsedMs, file, gate }) {
  const lines = ['图片识别结果：画面里没有检测到鸟', ''];
  const seen = new Set();
  const rows = [];
  for (const det of detections) {
    if (seen.has(det.classIndex)) continue;
    seen.add(det.classIndex);
    rows.push(det);
    if (rows.length >= 3) break;
  }
  if (rows.length === 0) {
    lines.push('前置检测模型没有在画面里找到任何可识别的物体。');
  } else {
    lines.push('识别到的内容：');
    for (const [index, det] of rows.entries()) {
      lines.push(`${index + 1}. ${det.label}　${percent(det.score)}`);
    }
  }
  lines.push('');
  lines.push(`耗时 ${(elapsedMs / 1000).toFixed(2)} s｜未调用大模型｜0 token`);
  if (file) lines.push(`文件：${file}`);
  lines.push('判断依据：前置模型 YOLO26n-seg 的 COCO 80 类检测；未检出 bird 类时才给出这个结论。');
  lines.push('COCO 只有 80 个常见类别，老虎、狐狸、麻雀以外的多数物种会被归到最接近的一类（例如猫科归为 cat）。');
  lines.push('如果你确定画面里有鸟（比如鸟太小或只露出局部），可以裁一裁再发，或改用声音识别。');
  return lines.join('\n');
}

/**
 * Render the reply for a photo the gate could say nothing about.
 *
 * An empty detection set is evidence about this photo, not about the world: a
 * bird smaller than the 960 pass can see looks exactly like a bare landscape.
 * BirdTrace still answers either way and answers confidently — a poppy meadow
 * came back as 「圭亚那冠伞鸟 97.5%」 — so the classifier is not asked at all.
 * Refusing to answer would be the other failure: the same reply is also what a
 * frame with a real, tiny bird in it gets. So the reply states the silence, says
 * plainly that it does not know what the picture is, and spends its words on how
 * to get an answer instead of on a guess.
 */
export function formatNoBirdFound({ elapsedMs, file }) {
  const lines = [
    '图片识别结果：前置模型没在这张图里检出鸟，也说不准画面里是什么',
    '',
    '前置模型 YOLO26n-seg 先按 640 找了一遍，没检出鸟；再按 960 复看一次，还是没检出。',
    '没检出鸟就不调用识鸟模型：让它硬猜，得到的只会是一个看着很像的物种名。',
    '',
    '如果你确定画面里有鸟（多半是鸟太小、太远，或只露出局部）：',
    '把多余的背景裁掉，让鸟在画面里占得大一些，再发一次。',
    '也可以改用声音识别：发一段鸟叫录音，加 /birds。',
    '',
    `耗时 ${(elapsedMs / 1000).toFixed(2)} s｜未调用大模型｜0 token`,
  ];
  if (file) lines.push(`文件：${file}`);
  lines.push('判断依据：前置模型两遍都没有检出 bird 类，也没有检出其他 COCO 物体；没有鸟就不给物种。');
  lines.push('COCO 只有 80 个常见类别，画面里的东西也可能属于它没有的类（比如花草、昆虫、远处的人造物）。');
  return lines.join('\n');
}

/** Render an image classification result as the chat reply. */
export function formatImageResult({ candidates, elapsedMs, topK, file, gate }) {
  if (!candidates || candidates.length === 0) {
    return '没有识别出结果：模型返回为空。换一张鸟更清楚、鸟占比更大的照片试试。';
  }
  const lines = ['图片识别结果（BirdTrace FastViT-MA36 · 10480 类 · 本地推理）', ''];
  for (const [index, item] of candidates.slice(0, topK).entries()) {
    const names = speciesLabel({ chinese: item.chinese, english: item.scientific || item.common });
    lines.push(`${index + 1}. ${names}　${percent(item.score)}`);
  }
  lines.push('');
  lines.push(`耗时 ${(elapsedMs / 1000).toFixed(2)} s｜未调用大模型｜0 token`);
  if (file) lines.push(`文件：${file}`);
  lines.push('名称：中文名（English）对照；没有对应中文名的物种只显示英文名。');
  lines.push('分数是模型 logits 归一化后的相对置信度，不是校准概率。');
  if (gate?.bird) {
    let how;
    if (gate.cropped) {
      const bird = `${gate.boxWidth}×${gate.boxHeight}，占原图 ${percent(gate.boxShare)}`;
      const sent = gate.cropWidth
        ? `；送进识鸟模型的是外扩后的 ${gate.cropWidth}×${gate.cropHeight}（占 ${percent(gate.cropShare)}）`
        : '';
      how = `已按前置模型 YOLO26n-seg 检出的鸟框（${bird}）裁剪后再识别${sent}`;
    } else {
      how = '前置模型没检出足够大的鸟框，按整图识别';
    }
    lines.push(`${how}；画面里确有 bird 类，置信度 ${percent(gate.score)}。`);
  }
  return lines.join('\n');
}

/** Render an acoustic result as the chat reply. */
export function formatAudioResult({
  detections,
  windows,
  durationSec,
  elapsedMs,
  topK,
  minConfidence,
  geoApplied,
  geoMessage,
  truncated,
}) {
  const lines = ['声音识别结果（BirdNET+ V3.0 preview3.1 Global 11K · 本地推理）', ''];
  if (detections.length === 0) {
    lines.push(`在 ${durationSec.toFixed(1)} 秒音频里没有超过 ${percent(minConfidence)} 的物种。`);
    lines.push('建议：离鸟更近、减少风噪与人声，或录更长时间。');
  } else {
    for (const [index, item] of detections.slice(0, topK).entries()) {
      const names = speciesLabel({
        chinese: item.chinese,
        english: item.common,
        scientific: item.scientific,
      });
      const span = item.firstSeenSec === item.lastSeenSec
        ? `${item.firstSeenSec.toFixed(1)}s`
        : `${item.firstSeenSec.toFixed(1)}–${item.lastSeenSec.toFixed(1)}s`;
      lines.push(`${index + 1}. ${names}　${percent(item.score)}　${span}　命中 ${item.hits} 段`);
    }
  }
  lines.push('');
  lines.push(
    `共 ${windows} 个 3 秒窗口（${durationSec.toFixed(1)} s）｜耗时 ${(elapsedMs / 1000).toFixed(2)} s｜未调用大模型｜0 token`,
  );
  lines.push('名称：中文名（English）对照；未收录的类群（昆虫、蛙类等）显示英文名与学名。');
  if (geoApplied && geoMessage) lines.push(geoMessage);
  if (truncated) lines.push('音频较长，只分析了前一部分窗口。');
  return lines.join('\n');
}

const megabytes = (bytes) => (Number.isFinite(bytes) ? (bytes / 1048576).toFixed(1) : '?');

/** One line describing where the automatic download stands. */
export function formatProvisioning(provisioning) {
  if (provisioning === undefined) return undefined;
  const { running, doneFiles, totalFiles, doneBytes, totalBytes, current, error, autoDownload, pendingFiles, errors } = provisioning;
  if (totalFiles === 0 && pendingFiles > 0) {
    return `下载任务：还有 ${pendingFiles} 个文件没开始${autoDownload ? '，会自动开始' : '，自动下载已关闭（config.autoDownload=false）'}。`;
  }
  if (totalFiles === 0) {
    return doneFiles === 0
      ? '下载任务：模型与 ffmpeg 都已经在本地，无需下载。'
      : `下载任务：已完成（${doneFiles} 个文件）`;
  }
  if (running) {
    const pct = totalBytes > 0 ? Math.floor((doneBytes / totalBytes) * 100) : 0;
    const part = current ? `，正在下 ${current}` : '';
    return `下载任务：后台进行中 ${doneFiles}/${totalFiles} 个文件${part}（${megabytes(doneBytes)} / ${megabytes(totalBytes)} MB，${pct}%）`;
  }
  if (error) {
    const names = Array.isArray(errors) && errors.length
      ? `（${errors.map((entry) => entry.file).join('、')}）`
      : '';
    return `下载任务：上次没成功${names} —— ${error}。插件稍后会自动重试；重发 /birds 或重启 Host 也会接着下（已下的部分会续传）。`;
  }
  if (pendingFiles > 0) {
    return `下载任务：还有 ${pendingFiles} 个文件没开始${autoDownload ? '，会自动开始' : '，自动下载已关闭（config.autoDownload=false）'}。`;
  }
  return `下载任务：已完成（${doneFiles} 个文件）`;
}

/** Render the /birdstatus reply. */
export function formatStatus({
  modelsDir,
  status,
  platform,
  arch,
  node,
  available,
  ffmpeg,
  ffmpegPath,
  provisioning,
  names,
}) {
  const lines = [
    '鸟类识别插件状态',
    `运行环境：node ${node}｜${platform}/${arch}`,
    `模型目录：${modelsDir}`,
    '',
  ];
  for (const [key, entry] of Object.entries(status)) {
    const size = entry.size ? `　${(entry.size / 1048576).toFixed(1)} MB` : '';
    lines.push(`${entry.present ? '✓' : '✗'} ${key}${size}`);
    if (!entry.present) lines.push(`　　${entry.path}`);
  }
  lines.push('');
  lines.push(available
    ? '推理引擎：onnxruntime-node 已加载，可以本地推理。'
    : '推理引擎：不可用，请看 Host 日志里 onnxruntime-node 的报错。');
  if (ffmpeg) lines.push(`ffmpeg：${ffmpeg}`);
  else if (ffmpegPath) lines.push(`ffmpeg：未就绪（${ffmpegPath}）`);
  if (names) {
    const parts = [];
    if (names.image?.bound) parts.push(`图片 ${names.image.named}/${names.image.count}`);
    if (names.audio?.bound) parts.push(`声音 ${names.audio.named}/${names.audio.count}`);
    lines.push(parts.length === 2
      ? `中文名表：已启用（${parts.join('、')}，IOC 世界鸟类名录）`
      : '中文名表：未启用（会退回英文名；标签文件与名字表指纹不一致时也会这样）');
  }
  const line = formatProvisioning(provisioning);
  if (line) lines.push(line);
  lines.push('');
  lines.push('用法：/birds 附带图片或录音；或 /birds <文件绝对路径>。');
  lines.push('模型和 ffmpeg 由插件自动下载，装好插件即完成安装；');
  lines.push('想手动重跑可以执行 node scripts/download-models.mjs（可选）。');
  return lines.join('\n');
}
