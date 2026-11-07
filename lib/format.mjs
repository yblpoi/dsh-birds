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

/** Render an image classification result as the chat reply. */
export function formatImageResult({ candidates, elapsedMs, topK, file }) {
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
  lines.push('分数是模型 logits 归一化后的相对置信度，不是校准概率；该模型不检测「画面里有没有鸟」。');
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
