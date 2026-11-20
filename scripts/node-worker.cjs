// Run a release's browser worker in Node, for tests: enough of a worker's
// globals (self, postMessage, importScripts, fetch of local paths) for
// worker.js and the Emscripten glue it loads. The release's `base` is a
// directory path ending in `/`.

const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

globalThis.self = globalThis;
// What the Emscripten glue and sherpa-onnx-asr.js reach for under Node.
globalThis.require = require;
globalThis.module = { exports: {} };

self.postMessage = (m) => parentPort.postMessage(m);
self.importScripts = (...files) => {
  for (const f of files) {
    globalThis.__dirname = path.dirname(f);
    globalThis.__filename = f;
    vm.runInThisContext(fs.readFileSync(f, 'utf8'), { filename: f });
  }
};
const networkFetch = globalThis.fetch;
globalThis.fetch = async (url) =>
  typeof url === 'string' && url.startsWith('/') ? new Response(fs.readFileSync(url)) : networkFetch(url);

vm.runInThisContext(fs.readFileSync(workerData.script, 'utf8'), { filename: workerData.script });
parentPort.on('message', (data) => self.onmessage({ data }));
