// Put a release together from a built runtime and fetched models.
//
//   node scripts/assemble.mjs --release <name> [--out dist] [--models <id>,…] [--trials]
//
// Reads build/runtimes/<runtime>/ (scripts/build.sh) and build/models/<id>/
// (scripts/fetch-models.mjs) for the models models.yaml's `release` lists,
// and writes (--models picks other shippable models instead):
//
//   <out>/<name>/                 the files as an app serves them, with
//                                 manifest.json describing them
//   <out>/<name>-assets/          the same files under flat names, for a
//                                 GitHub release (manifest.json included)
//
// Refuses a model not marked shippable, unless --trials: then the result is
// marked `trialsOnly`, for the bench and the check page, and the app refuses
// it. A release CI publishes never has it.

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { BUILD, MODEL_FILE_NAMES, ROOT, die, parseArgs, readModels, sha256OfFile } from './lib.mjs';

const PROTOCOL = 1;

const { flags } = parseArgs(process.argv.slice(2));
const release = flags.release;
if (!release || release === true) die('usage: assemble.mjs --release <name> [--out dist]');
const outRoot = join(ROOT, flags.out ?? 'dist');
const dir = join(outRoot, release);
const assetsDir = join(outRoot, `${release}-assets`);
rmSync(dir, { recursive: true, force: true });
rmSync(assetsDir, { recursive: true, force: true });
mkdirSync(assetsDir, { recursive: true });

/** Copy a file into the release, and describe it for the manifest. */
async function place(from, path) {
  const to = join(dir, path);
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  const asset = path.replaceAll('/', '.');
  copyFileSync(from, join(assetsDir, asset));
  return { path, asset, bytes: statSync(from).size, sha256: await sha256OfFile(from) };
}

const doc = readModels();
const ids = typeof flags.models === 'string' ? flags.models.split(',') : doc.release;
const models = ids.map((id) => {
  const m = doc.models[id];
  if (!m) die(`no model ${id} in models.yaml`);
  if (m.shippable !== true && flags.trials !== true) die(`${id} isn't marked shippable in models.yaml (--trials to try it anyway)`);
  return m;
});

const runtimes = {};
const built = {};
const notices = [];
for (const name of new Set(models.map((m) => m.runtime))) {
  const from = join(BUILD, 'runtimes', name);
  if (!existsSync(join(from, 'build.json'))) die(`no build of ${name} in ${from}: run scripts/build.sh ${name}`);
  const files = [];
  for (const f of readdirSync(from).sort()) {
    if (/\.(js|wasm)$/.test(f)) files.push(await place(join(from, f), `${name}/${f}`));
  }
  files.push(await place(join(ROOT, 'runtimes', name, 'worker.js'), `${name}/worker.js`));
  for (const f of readdirSync(join(from, 'licences')).sort()) {
    notices.push(await place(join(from, 'licences', f), `licences/${name}/${f}`));
  }
  runtimes[name] = { worker: `${name}/worker.js`, files };
  built[name] = JSON.parse(readFileSync(join(from, 'build.json'), 'utf8'));
}

const modelEntries = [];
for (const m of models) {
  const from = join(BUILD, 'models', m.id);
  const files = [];
  for (const role of Object.keys(m.files)) {
    const name = MODEL_FILE_NAMES[role];
    if (!existsSync(join(from, name))) die(`no ${name} for ${m.id}: run scripts/fetch-models.mjs`);
    files.push({ role, ...(await place(join(from, name), `models/${m.id}/${name}`)) });
  }
  if (m.licenceFile) notices.push(await place(join(ROOT, 'licences', m.licenceFile), `licences/models/${m.id}.txt`));
  modelEntries.push({
    id: m.id,
    label: m.label,
    runtime: m.runtime,
    licence: m.licence,
    source: { url: m.source.url, sha256: m.source.sha256, about: m.source.about },
    lagSeconds: m.lagSeconds,
    config: m.config,
    files,
  });
}

let commit = null;
try {
  commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim();
  if (dirty) commit += '-dirty';
} catch {
  // Not a checkout: the manifest says so.
}

const manifest = {
  protocol: PROTOCOL,
  release,
  ...(models.some((m) => m.shippable !== true) ? { trialsOnly: true } : {}),
  built: { from: commit, runtimes: built },
  runtimes,
  models: modelEntries,
  notices,
};
const json = `${JSON.stringify(manifest, null, 2)}\n`;
writeFileSync(join(dir, 'manifest.json'), json);
writeFileSync(join(assetsDir, 'manifest.json'), json);

const total = [...Object.values(runtimes).flatMap((r) => r.files), ...modelEntries.flatMap((m) => m.files)].reduce(
  (n, f) => n + f.bytes,
  0,
);
console.log(`${release}: ${dir} (${(total / 1048576).toFixed(1)} MB for a phone)`);
