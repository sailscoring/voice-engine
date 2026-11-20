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
import { Worker } from 'node:worker_threads';
import { BUILD, ROOT, die, parseArgs } from './lib.mjs';

const { flags, rest } = parseArgs(process.argv.slice(2));
if (!rest[0]) die('usage: smoke-test.mjs <release dir> [--max-wer 0.15]');
const dir = resolve(rest[0]);
const maxWer = Number(flags['max-wer'] ?? 0.15);
const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));

/** 16-bit PCM, mono, 16 kHz, as floats. */
function readWav(file) {
  const b = readFileSync(file);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') die(`${file}: not a WAV file`);
  let at = 12;
  let fmt = null;
  while (at + 8 <= b.length) {
    const id = b.toString('ascii', at, at + 4);
    const size = b.readUInt32LE(at + 4);
    const body = at + 8;
    if (id === 'fmt ') fmt = { format: b.readUInt16LE(body), channels: b.readUInt16LE(body + 2), rate: b.readUInt32LE(body + 4), bits: b.readUInt16LE(body + 14) };
    if (id === 'data') {
      if (!fmt || fmt.format !== 1 || fmt.channels !== 1 || fmt.rate !== 16000 || fmt.bits !== 16) {
        die(`${file}: needs 16-bit PCM, mono, 16 kHz; got ${JSON.stringify(fmt)}`);
      }
      const out = new Float32Array(size / 2);
      for (let i = 0; i < out.length; i++) out[i] = b.readInt16LE(body + i * 2) / 32768;
      return out;
    }
    at = body + size + (size % 2);
  }
  die(`${file}: no data`);
}

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

function listen(model, samples) {
  return new Promise((resolvePromise, reject) => {
    const worker = new Worker(join(ROOT, 'scripts', 'node-worker.cjs'), {
      workerData: { script: join(dir, manifest.runtimes[model.runtime].worker) },
    });
    const closed = [];
    let open = [];
    let cost = 0;
    let span = 0;
    let sent = 0;
    let answered = 0;
    const done = (err, value) => {
      worker.terminate();
      if (err) reject(err);
      else resolvePromise(value);
    };
    worker.on('error', (err) => done(err));
    worker.on('message', (m) => {
      if (m.type === 'error') return done(new Error(m.message));
      if (m.type === 'ready') {
        worker.postMessage({ type: 'begin', take: 1 });
        // A tenth of a second at a time, as a microphone would, then two
        // seconds of quiet so the recogniser closes the last words.
        const all = new Float32Array(samples.length + 32000);
        all.set(samples);
        for (let i = 0; i < all.length; i += 1600) {
          const chunk = all.slice(i, i + 1600);
          worker.postMessage({ type: 'audio', samples: chunk }, [chunk.buffer]);
          sent++;
        }
        return;
      }
      if (m.type === 'words') {
        if (m.take !== 1) return done(new Error(`words for take ${m.take}, not 1`));
        cost += m.cost;
        span += m.span;
        if (m.closed) {
          closed.push(...m.words);
          open = [];
        } else open = m.words;
        if (++answered === sent) done(null, { heard: [...closed, ...open], rtf: cost / 1000 / span });
      }
    });
    worker.postMessage({ type: 'init', base: `${dir}/`, model });
  });
}

let failed = false;
for (const model of manifest.models) {
  const recording = join(BUILD, 'models', model.id, 'test.wav');
  if (!existsSync(recording)) die(`${model.id}: no test recording; run scripts/fetch-models.mjs ${model.id}`);
  const said = words(readFileSync(join(BUILD, 'models', model.id, 'test.txt'), 'utf8'));
  const { heard, rtf } = await listen(model, readWav(recording));
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
