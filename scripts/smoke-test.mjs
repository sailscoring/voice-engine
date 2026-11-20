// Check a release works: for each of its models, run the release's own worker
// and WebAssembly (in Node) over the model's test recording, through the
// messages in PROTOCOL.md, and compare what it heard with what was said.
//
//   node scripts/smoke-test.mjs dist/<release> [--max-wer 0.15]
//
// The recordings come from build/models/<id>/ (scripts/fetch-models.mjs).
// This says the build runs and hears English. How well it hears sail numbers
// is the bench's question.

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { BUILD, die, parseArgs } from './lib.mjs';
import { readWav, startListener } from './listener.mjs';

const { flags, rest } = parseArgs(process.argv.slice(2));
if (!rest[0]) die('usage: smoke-test.mjs <release dir> [--max-wer 0.15]');
const dir = resolve(rest[0]);
const maxWer = Number(flags['max-wer'] ?? 0.15);
const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));

const words = (s) => s.toUpperCase().replace(/[^A-Z0-9' ]/g, ' ').split(/\s+/).filter(Boolean);

function wordErrorRate(said, heard) {
  const d = Array.from({ length: said.length + 1 }, (_, i) => [i, ...Array(heard.length).fill(0)]);
  for (let j = 1; j <= heard.length; j++) d[0][j] = j;
  for (let i = 1; i <= said.length; i++) {
    for (let j = 1; j <= heard.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (said[i - 1] === heard[j - 1] ? 0 : 1));
    }
  }
  return d[said.length][heard.length] / said.length;
}

let failed = false;
for (const model of manifest.models) {
  const recording = join(BUILD, 'models', model.id, 'test.wav');
  if (!existsSync(recording)) die(`${model.id}: no test recording; run scripts/fetch-models.mjs ${model.id}`);
  const said = words(readFileSync(join(BUILD, 'models', model.id, 'test.txt'), 'utf8'));
  const listener = startListener(dir, model);
  await listener.ready;
  const { words: heard, cost, span } = await listener.hear(readWav(recording));
  listener.close();
  const rtf = cost / 1000 / span;
  const times = heard.map((w) => w.t);
  if (times.some((t, i) => !(t >= 0) || (i > 0 && t < times[i - 1]))) {
    console.log(`${model.id}: FAIL, word times out of order: ${times.join(' ')}`);
    failed = true;
    continue;
  }
  const wer = wordErrorRate(said, words(heard.map((w) => w.w).join(' ')));
  const ok = wer <= maxWer;
  failed ||= !ok;
  console.log(`${model.id}: ${ok ? 'ok' : 'FAIL'}, word error rate ${(wer * 100).toFixed(1)}%, ${rtf.toFixed(3)} s of computing a second`);
  console.log(`  heard: ${heard.map((w) => w.w).join(' ')}`);
}
process.exit(failed ? 1 : 0);
