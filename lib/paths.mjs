import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/** Expand a leading ~ and resolve relative to $HOME when not absolute. */
export function resolveModelsDir(configured) {
  const raw = configured || '~/.dsh/models/bird';
  const expanded = raw.startsWith('~') ? path.join(os.homedir(), raw.slice(1)) : raw;
  return path.resolve(expanded);
}

export const MODEL_FILES = Object.freeze({
  // BirdTrace FastViT-MA36 image classifier (10,480 species)
  imageModel: 'BirdTrace-FastViT-MA36-10K.onnx',
  imageClasses: 'BirdTrace-FastViT-MA36-10K.classes.json',
  // BirdNET+ V3.0 preview 3.1 acoustic classifier (11K species)
  audioModel: 'BirdNET+_V3.0-preview3.1_Global_11K_FP16_pruned.onnx',
  audioLabels: 'BirdNET+_V3.0-preview3.1_Global_11K_Labels.csv',
  // BirdNET+ Geomodel V3.0.4 (14,082 taxa)
  geoModel: 'BirdNET+_Geomodel_V3.0.4_Global_14K_FP16.onnx',
  geoLabels: 'BirdNET+_Geomodel_V3.0.4_Global_14K_Labels.txt',
});

export function modelPath(modelsDir, key) {
  return path.join(modelsDir, MODEL_FILES[key]);
}

export function fileExists(file) {
  try {
    return fs.statSync(file).size > 0;
  } catch {
    return false;
  }
}

/** Which model files are present, so /birdstatus can explain what is missing. */
export function modelStatus(modelsDir) {
  const out = {};
  for (const [key, name] of Object.entries(MODEL_FILES)) {
    const filePath = path.join(modelsDir, name);
    let size = 0;
    try {
      size = fs.statSync(filePath).size;
    } catch {
      size = 0;
    }
    out[key] = { path: filePath, present: size > 0, size };
  }
  return out;
}
