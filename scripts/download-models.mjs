#!/usr/bin/env node
/**
 * Fetch every model bundle into the models directory.
 *
 * Endpoint choices are deliberate for a phone in mainland China:
 *   - huggingface.co and cdn.jsdelivr.net are unreachable, hf-mirror.com is not;
 *   - Zenodo and GitHub Releases both work and both honour Range requests,
 *     which is what makes an interrupted mobile download resumable.
 *
 * Re-running is safe: finished files are skipped and partial ones resume.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const args = new Map();
for (const arg of process.argv.slice(2)) {
  const [key, value] = arg.replace(/^--/, '').split('=');
  args.set(key, value ?? 'true');
}

const modelsDir = path.resolve(
  (args.get('dir') ?? process.env.DSH_BIRD_MODELS ?? path.join(os.homedir(), '.dsh', 'models', 'bird'))
    .replace(/^~/, os.homedir()),
);

const HF = args.get('hf') ?? 'https://hf-mirror.com';
const ZENODO = 'https://zenodo.org/records/20703646/files';
const GEOMODEL = 'https://github.com/birdnet-team/geomodel/releases/download/v3.0.4';

const TARGETS = [
  {
    file: 'BirdTrace-FastViT-MA36-10K.onnx',
    url: `${HF}/warden123/BirdTrace-FastViT-MA36-10K/resolve/main/model.onnx`,
    bytes: 222_385_590,
    sha256: '0f2c0259',
    note: 'BirdTrace FastViT-MA36 图片分类（10,480 类，FP32）',
  },
  {
    file: 'BirdTrace-FastViT-MA36-10K.classes.json',
    url: `${HF}/warden123/BirdTrace-FastViT-MA36-10K/resolve/main/classes.json`,
    bytes: 1_000_770,
    note: '图片分类标签表（10480 条 {index, species_id, species_name}）',
  },
  {
    file: 'BirdNET+_V3.0-preview3.1_Global_11K_FP16_pruned.onnx',
    url: `${ZENODO}/BirdNET+_V3.0-preview3.1_Global_11K_FP16_pruned.onnx?download=1`,
    note: 'BirdNET+ V3 声学分类（11K 物种，FP16，32 kHz 输入）',
  },
  {
    file: 'BirdNET+_V3.0-preview3.1_Global_11K_Labels.csv',
    url: `${ZENODO}/BirdNET+_V3.0-preview3.1_Global_11K_Labels.csv?download=1`,
    note: '声学分类标签表（分号分隔，列 id;sci_name;com_name;gbif;class;order）',
  },
  {
    file: 'BirdNET+_Geomodel_V3.0.4_Global_14K_FP16.onnx',
    url: `${GEOMODEL}/BirdNET+_Geomodel_V3.0.4_Global_14K_FP16.onnx`,
    bytes: 7_885_053,
    sha256: '80e410f8',
    note: 'Geomodel V3.0.4 地理先验（14,082 分类群，FP16）',
  },
  {
    file: 'BirdNET+_Geomodel_V3.0.4_Global_14K_Labels.txt',
    url: `${GEOMODEL}/BirdNET+_Geomodel_V3.0.4_Global_14K_Labels.txt`,
    bytes: 671_823,
    note: 'Geomodel 标签表（TAB 分隔：species_code / scientific_name / common_name）',
  },
];

async function sizeOf(file) {
  try {
    return (await fsp.stat(file)).size;
  } catch {
    return 0;
  }
}

/** Resume when a .part exists; restart when the server ignores Range. */
async function download(target) {
  const destination = path.join(modelsDir, target.file);
  const temporary = destination + '.part';

  const finished = await sizeOf(destination);
  if (finished > 1_000_000 || (target.bytes && finished === target.bytes)) {
    console.log(`skip  ${target.file}`);
    return;
  }

  let have = await sizeOf(temporary);
  const headers = have > 0 ? { Range: `bytes=${have}-` } : {};
  const response = await fetch(target.url, { headers, redirect: 'follow' });
  if (!response.ok && response.status !== 206) {
    throw new Error(`${target.file}: HTTP ${response.status} ${response.statusText}`);
  }
  if (have > 0 && response.status !== 206) have = 0;

  const contentLength = Number(response.headers.get('content-length') ?? 0);
  const total = target.bytes ?? contentLength + have;
  const sink = fs.createWriteStream(temporary, { flags: have > 0 ? 'a' : 'w' });

  let received = have;
  let lastReport = 0;
  const body = Readable.fromWeb(response.body);
  body.on('data', (chunk) => {
    received += chunk.length;
    const now = Date.now();
    if (now - lastReport > 1000) {
      lastReport = now;
      const progress = total ? ((received / total) * 100).toFixed(1) + '%' : '?';
      process.stdout.write(
        `\r  ${target.file}  ${(received / 1048576).toFixed(1)} MB / ${(total / 1048576).toFixed(0)} MB  ${progress}`,
      );
    }
  });
  await pipeline(body, sink);
  process.stdout.write('\n');

  if (target.bytes && received !== target.bytes) {
    console.warn(`warn  ${target.file}: 期望 ${target.bytes} 字节，实际收到 ${received} 字节，已保留 .part 供续传`);
    return;
  }
  await fsp.rename(temporary, destination);
  console.log(`done  ${target.file}`);
}

await fsp.mkdir(modelsDir, { recursive: true });
console.log(`模型目录：${modelsDir}\n`);
for (const target of TARGETS) {
  console.log(`== ${target.note}`);
  await download(target);
}
console.log('\n全部完成。运行 /birdstatus 确认模型都已就绪。');
console.log('许可证提醒：BirdTrace 为 CC-BY-NC-4.0（仅非商用），BirdNET+ 使用需遵守其 TERMS_OF_USE。');
