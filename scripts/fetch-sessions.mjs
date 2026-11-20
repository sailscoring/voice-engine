// Fetch a set of bench sessions, checked against bench/sessions.json, into
// build/sessions/<name>/.
//
//   node scripts/fetch-sessions.mjs [name]        default: sessions-synthetic-1
//
// A set is never regenerated: it is published once, as a release asset under
// its own tag, so every release is scored on the same sound.

import { execFileSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { BUILD, ROOT, die, sha256OfFile } from './lib.mjs';

const name = process.argv[2] ?? 'sessions-synthetic-1';
const sets = JSON.parse(readFileSync(join(ROOT, 'bench', 'sessions.json'), 'utf8'));
const set = sets[name];
if (!set) die(`no set ${name} in bench/sessions.json`);

const dir = join(BUILD, 'sessions');
const archive = join(dir, `${name}.tar.xz`);
mkdirSync(dir, { recursive: true });
if (!existsSync(archive) || (await sha256OfFile(archive)) !== set.sha256) {
  console.log(`${name}: fetching ${set.url}`);
  const res = await fetch(set.url);
  if (!res.ok) die(`${name}: ${res.status} ${res.statusText}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(archive));
  const got = await sha256OfFile(archive);
  if (got !== set.sha256) {
    rmSync(archive);
    die(`${name}: the archive's SHA-256 is ${got}, not the ${set.sha256} bench/sessions.json pins`);
  }
}
rmSync(join(dir, name), { recursive: true, force: true });
execFileSync('tar', ['xJf', archive, '-C', dir]);
console.log(`${name}: ${join(dir, name)}`);
