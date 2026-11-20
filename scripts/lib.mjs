// What the scripts share: where things are, the model list, checksums.

import { createHash } from 'node:crypto';
import { createReadStream, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const BUILD = join(ROOT, 'build');

/** The roles a model's files play, and the names they take in a release. */
export const MODEL_FILE_NAMES = {
  encoder: 'encoder.onnx',
  decoder: 'decoder.onnx',
  joiner: 'joiner.onnx',
  tokens: 'tokens.txt',
};

export function readModels() {
  const doc = parse(readFileSync(join(ROOT, 'models', 'models.yaml'), 'utf8'));
  for (const [id, m] of Object.entries(doc.models)) m.id = id;
  return doc;
}

export function sha256OfFile(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (d) => hash.update(d))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

/** `--name value` and bare arguments. */
export function parseArgs(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[a.slice(2)] = true;
      else flags[a.slice(2)] = argv[++i];
    } else rest.push(a);
  }
  return { flags, rest };
}

export function die(message) {
  console.error(message);
  process.exit(1);
}
