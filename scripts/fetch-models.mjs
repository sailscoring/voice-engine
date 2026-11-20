// Fetch models from upstream, check them against models.yaml, and unpack the
// files a release needs into build/models/<id>/ under their role names, with
// the smoke test's recording beside them.
//
//   node scripts/fetch-models.mjs              the models the release lists
//   node scripts/fetch-models.mjs --all        every model
//   node scripts/fetch-models.mjs <id> …       just these
//
// Archives are kept in build/archives/ and not fetched again while their
// checksum matches.

import { execFileSync } from 'node:child_process';
import { copyFileSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { BUILD, MODEL_FILE_NAMES, die, parseArgs, readModels, sha256OfFile } from './lib.mjs';

const { flags, rest } = parseArgs(process.argv.slice(2));
const doc = readModels();
const ids = rest.length ? rest : flags.all ? Object.keys(doc.models) : doc.release;

const archives = join(BUILD, 'archives');
mkdirSync(archives, { recursive: true });

async function fetchArchive(model) {
  const file = join(archives, basename(new URL(model.source.url).pathname));
  if (existsSync(file) && (await sha256OfFile(file)) === model.source.sha256) return file;
  console.log(`${model.id}: fetching ${model.source.url}`);
  const res = await fetch(model.source.url);
  if (!res.ok) die(`${model.id}: ${res.status} ${res.statusText}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(file));
  const got = await sha256OfFile(file);
  if (got !== model.source.sha256) {
    rmSync(file);
    die(`${model.id}: the archive's SHA-256 is ${got}, not the ${model.source.sha256} models.yaml pins`);
  }
  return file;
}

for (const id of ids) {
  const model = doc.models[id];
  if (!model) die(`no model ${id} in models.yaml`);
  const archive = await fetchArchive(model);
  const top = basename(archive).replace(/\.tar\.bz2$/, '');
  const wanted = Object.values(model.files);
  if (model.test) wanted.push(model.test.wav);
  const tmp = mkdtempSync(join(BUILD, 'unpack-'));
  try {
    execFileSync('tar', ['xjf', archive, '-C', tmp, ...wanted.map((f) => `${top}/${f}`)]);
    const out = join(BUILD, 'models', id);
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    for (const [role, name] of Object.entries(model.files)) {
      if (!MODEL_FILE_NAMES[role]) die(`${id}: unknown file role ${role}`);
      copyFileSync(join(tmp, top, name), join(out, MODEL_FILE_NAMES[role]));
    }
    if (model.test) {
      copyFileSync(join(tmp, top, model.test.wav), join(out, 'test.wav'));
      writeFileSync(join(out, 'test.txt'), `${model.test.text}\n`);
    }
    console.log(`${id}: ${out}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
