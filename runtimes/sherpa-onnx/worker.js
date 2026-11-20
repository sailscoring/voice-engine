// sherpa-onnx's streaming recogniser, as WebAssembly, behind the worker
// messages in PROTOCOL.md (protocol 1): 16 kHz sound in, words with times
// out. A classic worker, because the engine's glue script expects a global
// Module.

/* global importScripts, createOnlineRecognizer */

const SR = 16000;

let base = '';
let cacheName = null;
let model = null;
let recognizer = null;
let stream = null;
let take = 0;
let fed = 0; // samples given to the recogniser since the take began
let segmentStart = 0; // seconds: where the recogniser's own clock last restarted

async function bytesOf(url) {
  let res;
  if (cacheName) {
    try {
      res = await (await caches.open(cacheName)).match(url);
    } catch {
      // No cache storage here: the network will do.
    }
  }
  if (!res) res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

const fileFor = (role) => {
  const f = model.files.find((x) => x.role === role);
  if (!f) throw new Error(`model ${model.id} has no ${role}`);
  return f;
};

async function load() {
  const roles = ['encoder', 'decoder', 'joiner', 'tokens'];
  for (const role of roles) {
    self.Module.FS.writeFile(`/${role}`, await bytesOf(base + fileFor(role).path));
  }
  const c = model.config;
  if (c.type !== 'transducer') throw new Error(`sherpa-onnx worker: no support for ${c.type} models`);
  recognizer = createOnlineRecognizer(self.Module, {
    featConfig: { sampleRate: SR, featureDim: c.featureDim },
    modelConfig: {
      transducer: { encoder: '/encoder', decoder: '/decoder', joiner: '/joiner' },
      paraformer: { encoder: '', decoder: '' },
      zipformer2Ctc: { model: '' },
      nemoCtc: { model: '' },
      toneCtc: { model: '' },
      tokens: '/tokens',
      numThreads: 1,
      provider: 'cpu',
      debug: 0,
      modelType: '',
      modelingUnit: 'cjkchar',
      bpeVocab: '',
    },
    decodingMethod: 'greedy_search',
    maxActivePaths: 4,
    enableEndpoint: 1,
    rule1MinTrailingSilence: c.endpoint.rule1MinTrailingSilence,
    rule2MinTrailingSilence: c.endpoint.rule2MinTrailingSilence,
    rule3MinUtteranceLength: c.endpoint.rule3MinUtteranceLength,
    hotwordsFile: '',
    hotwordsScore: 1.5,
    ctcFstDecoderConfig: { graph: '', maxActive: 3000 },
    ruleFsts: '',
    ruleFars: '',
  });
  // The engine has its own copy now: free the files' memory.
  for (const role of roles) self.Module.FS.unlink(`/${role}`);
  begin(0);
  self.postMessage({ type: 'ready' });
}

function begin(nextTake) {
  if (stream) stream.free();
  stream = recognizer.createStream();
  take = nextTake;
  fed = 0;
  segmentStart = 0;
}

/** Word pieces with times to words with times, on the take's clock. */
function wordsOf(tokens, times) {
  const words = [];
  tokens.forEach((tok, i) => {
    if (/^[▁ ]/.test(tok) || words.length === 0) words.push({ w: tok.replace(/^[▁ ]/, ''), t: segmentStart + times[i] });
    else words[words.length - 1].w += tok;
  });
  return words.filter((x) => x.w);
}

function accept(samples) {
  const t0 = performance.now();
  stream.acceptWaveform(SR, samples);
  fed += samples.length;
  while (recognizer.isReady(stream)) recognizer.decode(stream);
  const r = recognizer.getResult(stream);
  const words = r.tokens && r.tokens.length ? wordsOf(r.tokens, r.timestamps) : [];
  const closed = recognizer.isEndpoint(stream);
  if (closed) {
    recognizer.reset(stream);
    segmentStart = fed / SR;
  }
  self.postMessage({ type: 'words', take, words, closed, heard: fed / SR, cost: performance.now() - t0, span: samples.length / SR });
}

const fail = (err) => self.postMessage({ type: 'error', message: String((err && err.message) || err) });

// Sound that arrives while the model is still loading waits for it.
const pending = [];

self.onmessage = (e) => {
  const m = e.data;
  try {
    if (m.type === 'init') {
      base = m.base;
      model = m.model;
      cacheName = m.cache || null;
      const dir = `${base}${model.runtime}/`;
      self.Module = {
        locateFile: (path) => dir + path,
        print: () => {},
        printErr: () => {},
        onRuntimeInitialized: () =>
          load()
            .then(() => pending.splice(0).forEach((x) => self.onmessage({ data: x })))
            .catch(fail),
      };
      importScripts(`${dir}sherpa-onnx-wasm-main-asr.js`, `${dir}sherpa-onnx-asr.js`);
    } else if (!recognizer) pending.push(m);
    else if (m.type === 'begin') begin(m.take);
    else if (m.type === 'audio') accept(m.samples);
  } catch (err) {
    fail(err);
  }
};
