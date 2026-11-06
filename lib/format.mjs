const percent = (score) => (Number.isFinite(score) ? (score * 100).toFixed(1) + '%' : '?');

/** Render an image classification result as the chat reply. */
export function formatImageResult({ candidates, elapsedMs, topK, file }) {
  if (!candidates || candidates.length === 0) {
    return '没有识别出结果：模型返回为空。换一张鸟更清楚、鸟占比更大的照片试试。';
  }
  const lines = ['图片识别结果（BirdTrace FastViT-MA36 · 10480 类 · 本地推理）', ''];
  for (const [index, item] of candidates.slice(0, topK).entries()) {
    const names = [item.scientific, item.common].filter(Boolean).join(' / ') || '未知物种';
    lines.push(`${index + 1}. ${names}　${percent(item.score)}`);
  }
  lines.push('');
  lines.push(`耗时 ${(elapsedMs / 1000).toFixed(2)} s｜未调用大模型｜0 token`);
  if (file) lines.push(`文件：${file}`);
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
      const names = [item.common, item.scientific].filter(Boolean).join(' / ') || '未知物种';
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
  if (geoApplied && geoMessage) lines.push(geoMessage);
  if (truncated) lines.push('音频较长，只分析了前一部分窗口。');
  return lines.join('\n');
}

/** Render the /birdstatus reply. */
export function formatStatus({ modelsDir, status, platform, arch, node, available }) {
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
  lines.push('');
  lines.push('用法：/birds 附带图片或录音；或 /birds <文件绝对路径>。');
  lines.push('缺失模型文件：在插件目录运行 node scripts/download-models.mjs 下载。');
  return lines.join('\n');
}
