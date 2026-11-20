// The notes for a GitHub release, from its manifest.
//
//   node scripts/release-notes.mjs dist/<release>

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const m = JSON.parse(readFileSync(join(process.argv[2], 'manifest.json'), 'utf8'));
const mb = (files) => (files.reduce((n, f) => n + f.bytes, 0) / 1048576).toFixed(1);
const lines = [`Protocol ${m.protocol}. Built from ${m.built.from}.`, ''];
for (const [name, r] of Object.entries(m.runtimes)) lines.push(`- Runtime **${name}**, ${mb(r.files)} MB`);
for (const x of m.models) lines.push(`- Model **${x.id}** (${x.licence}), ${mb(x.files)} MB: ${x.label}`);
lines.push('', 'What each runtime was built from:', '', '```json', JSON.stringify(m.built.runtimes, null, 2), '```');
lines.push('', '`manifest.json` lists every file, its size and its SHA-256.');
console.log(lines.join('\n'));
