// A release's worker, run in Node through the messages in PROTOCOL.md, for
// the smoke test and the bench. One worker hears any number of recordings,
// each as its own take.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { ROOT } from './lib.mjs';

const SR = 16000;
/** A tenth of a second at a time, as a microphone sends it. */
const CHUNK = SR / 10;
/** Quiet after a recording, so the recogniser closes its last words. */
const TAIL = 2 * SR;

/** Start the worker for one of the release's models. */
export function startListener(releaseDir, model) {
  const manifest = JSON.parse(readFileSync(join(releaseDir, 'manifest.json'), 'utf8'));
  const runtime = manifest.runtimes[model.runtime];
  const worker = new Worker(join(ROOT, 'scripts', 'node-worker.cjs'), {
    workerData: { script: join(releaseDir, runtime.worker) },
  });
  let onMessage = () => {};
  let onError = () => {};
  worker.on('message', (m) => onMessage(m));
  worker.on('error', (err) => onError(err));

  const ready = new Promise((resolve, reject) => {
    onMessage = (m) => {
      if (m.type === 'ready') resolve();
      else if (m.type === 'error') reject(new Error(m.message));
    };
    onError = reject;
  });
  worker.postMessage({ type: 'init', base: `${releaseDir}/`, model });

  let take = 0;
  return {
    ready,
    /**
     * Hear a whole recording as one take. Resolves with every word, on the
     * take's clock, and the computing it cost.
     */
    hear(samples) {
      take += 1;
      const thisTake = take;
      return new Promise((resolve, reject) => {
        const closed = [];
        let open = [];
        let cost = 0;
        let span = 0;
        let sent = 0;
        let answered = 0;
        onError = reject;
        onMessage = (m) => {
          if (m.type === 'error') return reject(new Error(m.message));
          if (m.type !== 'words') return;
          if (m.take !== thisTake) return reject(new Error(`words for take ${m.take} while hearing ${thisTake}`));
          cost += m.cost;
          span += m.span;
          if (m.closed) {
            closed.push(...m.words);
            open = [];
          } else open = m.words;
          if (++answered === sent) resolve({ words: [...closed, ...open], cost, span });
        };
        worker.postMessage({ type: 'begin', take: thisTake });
        const all = new Float32Array(samples.length + TAIL);
        all.set(samples);
        for (let i = 0; i < all.length; i += CHUNK) {
          const chunk = all.slice(i, i + CHUNK);
          worker.postMessage({ type: 'audio', samples: chunk }, [chunk.buffer]);
          sent++;
        }
      });
    },
    close: () => worker.terminate(),
  };
}

/** 16-bit PCM, mono, 16 kHz, as floats. */
export function readWav(file) {
  const b = readFileSync(file);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error(`${file}: not a WAV file`);
  let at = 12;
  let fmt = null;
  while (at + 8 <= b.length) {
    const id = b.toString('ascii', at, at + 4);
    const size = b.readUInt32LE(at + 4);
    const body = at + 8;
    if (id === 'fmt ') {
      fmt = { format: b.readUInt16LE(body), channels: b.readUInt16LE(body + 2), rate: b.readUInt32LE(body + 4), bits: b.readUInt16LE(body + 14) };
    }
    if (id === 'data') {
      if (!fmt || fmt.format !== 1 || fmt.channels !== 1 || fmt.rate !== SR || fmt.bits !== 16) {
        throw new Error(`${file}: needs 16-bit PCM, mono, 16 kHz; got ${JSON.stringify(fmt)}`);
      }
      const n = Math.min(size, b.length - body) >> 1;
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = b.readInt16LE(body + i * 2) / 32768;
      return out;
    }
    at = body + size + (size % 2);
  }
  throw new Error(`${file}: no data`);
}
