// Serve the check page over HTTPS on this machine and the local network,
// with a release of this repo beside it, so a phone on the same network can
// try that release.
//
//   node check/serve.mjs [release dir] [--app <checkout>] [--port 8443]
//
// The release defaults to dist/dev (scripts/assemble.mjs). The page reads
// calls with the app's own lib/voice/calls.ts, from a Sail Scoring checkout
// (default ../sailscoring), served as calls.js with its types stripped.
//
// A phone's browser gives a page the microphone only over HTTPS, so this
// makes itself a certificate (in build/, not committed) the first time it
// runs. The phone will warn about it: that is expected.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { appDir, callsSource } from '../scripts/app-calls.mjs';
import { BUILD, ROOT, die, parseArgs } from '../scripts/lib.mjs';

const { flags, rest } = parseArgs(process.argv.slice(2));
const page = path.join(ROOT, 'check');
const release = path.resolve(rest[0] ?? path.join(ROOT, 'dist', 'dev'));
if (!fs.existsSync(path.join(release, 'manifest.json'))) die(`${release} has no manifest.json: assemble a release first`);
const app = appDir(flags.app);
const calls = callsSource(app);
const port = Number(flags.port ?? 8443);

const key = path.join(BUILD, 'check-cert', 'key.pem');
const cert = path.join(BUILD, 'check-cert', 'cert.pem');
const addresses = Object.values(os.networkInterfaces())
  .flat()
  .filter((a) => a && a.family === 'IPv4' && !a.internal)
  .map((a) => a.address);
if (!fs.existsSync(key) || !fs.existsSync(cert)) {
  fs.mkdirSync(path.dirname(key), { recursive: true });
  const names = ['DNS:localhost', 'IP:127.0.0.1', ...addresses.map((a) => `IP:${a}`)].join(',');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '30', '-subj', '/CN=voice-engine-check', '-addext', `subjectAltName=${names}`, '-keyout', key, '-out', cert], { stdio: 'ignore' });
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8',
  '.wav': 'audio/wav',
};

/** A file under `dir`, or null for anything outside it. */
function inside(dir, rel) {
  const file = path.join(dir, rel);
  return file.startsWith(dir + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile() ? file : null;
}

https
  .createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'https://x').pathname);
    if (rel === '/calls.js') {
      res.writeHead(200, { 'Content-Type': TYPES['.js'], 'Cache-Control': 'no-store' });
      res.end(calls);
      return;
    }
    const file = rel.startsWith('/release/')
      ? inside(release, rel.slice('/release/'.length))
      : inside(page, rel === '/' ? 'index.html' : rel.slice(1));
    if (!file || file.endsWith('serve.mjs')) {
      res.writeHead(404).end('Not found');
      return;
    }
    // The engine and models are large and never change under one release.
    const big = /\.(onnx|wasm)$/.test(file);
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream',
      'Content-Length': fs.statSync(file).size,
      'Cache-Control': big ? 'public, max-age=86400' : 'no-store',
    });
    fs.createReadStream(file).pipe(res);
  })
  .listen(port, '0.0.0.0', () => {
    console.log(`Checking ${release}, reading calls with ${app}. Open one of:`);
    console.log(`  https://localhost:${port}/`);
    for (const a of addresses) console.log(`  https://${a}:${port}/      (from a phone on the same network)`);
  });
