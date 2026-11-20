// The bench: how well a release's models take down called sail numbers.
//
//   node bench/run.mjs <release dir> [--sessions <dir>] [--app <checkout>]
//                      [--filter <regex>] [--out <file>] [--baseline <file>]
//                      [--jobs <n>] [--show <n>]
//
// Each model hears each session through the release's own worker and
// WebAssembly, in Node, several sessions at once. What it heard is read as
// calls by the app's own reading of words, lib/voice/calls.ts in a Sail
// Scoring checkout (default ../sailscoring), and scored against what was
// really called.
//
// --sessions defaults to build/sessions/sessions-synthetic-1
//   (node scripts/fetch-sessions.mjs fetches it).
// --out writes the results as JSON; --baseline compares with results written
//   earlier and fails if any model puts more boats down wrong without a
//   mark, in any set of sessions both cover. Hearing fewer boats right is
//   reported, not failed: it is a trade to weigh, not a fault.
// --show prints the first n calls each model got wrong or missed in each set.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join, resolve } from 'node:path';
import { BUILD, die, parseArgs } from '../scripts/lib.mjs';
import { readWav, startListener } from '../scripts/listener.mjs';
import { appDir as findApp, loadCalls } from '../scripts/app-calls.mjs';

const { flags, rest } = parseArgs(process.argv.slice(2));
if (!rest[0]) die('usage: bench/run.mjs <release dir> [--sessions <dir>] [--app <checkout>] [--out <file>] [--baseline <file>]');
const releaseDir = resolve(rest[0]);
const sessionsDir = resolve(flags.sessions ?? join(BUILD, 'sessions', 'sessions-synthetic-1'));
const appDir = findApp(flags.app);
const jobs = Number(flags.jobs ?? Math.max(1, availableParallelism() - 1));
const show = Number(flags.show ?? 0);

const { callsFrom, prepare } = await loadCalls(appDir).catch((err) => die(err.message));
if (!existsSync(sessionsDir)) die(`${sessionsDir} is missing: run node scripts/fetch-sessions.mjs`);

const manifest = JSON.parse(readFileSync(join(releaseDir, 'manifest.json'), 'utf8'));
const filter = new RegExp(flags.filter ?? '.');
const sessions = readdirSync(sessionsDir)
  .filter((f) => f.endsWith('.json') && filter.test(f))
  .map((f) => JSON.parse(readFileSync(join(sessionsDir, f), 'utf8')))
  .filter((s) => Array.isArray(s.truth))
  .sort((a, b) => a.name.localeCompare(b.name));
if (sessions.length === 0) die(`no sessions in ${sessionsDir}`);

/** The lines the app would make of these words, as the bench scores them. */
function rowsFrom(words, session) {
  return callsFrom(words, prepare(session.entries, { minEnding: 3 })).map((c) => ({
    id: c.entry ? c.entry.id : null,
    sure: c.how === 'whole' || c.how === 'ending',
    t: c.t,
    markAt: c.markAt,
    note: `${c.words.join(' ')} [${c.how} ${c.digits ?? ''}${c.entry ? ` -> ${c.entry.sailNumber}` : ''}]`,
  }));
}

/**
 * A call is right when a row near it names its boat. Only then are the
 * leftover rows looked at: one close to a call still unanswered is that
 * call got wrong, or left open.
 */
function score(truth, rows, kind) {
  const used = new Set();
  const answered = new Map();
  const s = { calls: truth.length, right: 0, rightAsSuggestion: 0, wrong: 0, wrongAsSuggestion: 0, leftOpen: 0, notHeard: 0, fromTalk: 0, nows: 0, markLate: [], misses: [] };
  for (const h of truth) {
    if (h.tNow != null) s.nows++;
    const lo = h.tStart - 1.0;
    const hi = (h.tNow ?? h.tEnd) + 2.5;
    const i = rows.findIndex((r, j) => !used.has(j) && r.id === h.id && r.t >= lo && r.t <= hi);
    if (i < 0) continue;
    used.add(i);
    answered.set(h, rows[i]);
    s.right++;
    if (rows[i].sure === false) s.rightAsSuggestion++;
    if (kind === 'timed' && rows[i].markAt != null && h.tNow != null) s.markLate.push(rows[i].markAt - h.tNow);
  }
  for (const h of truth) {
    if (answered.has(h)) continue;
    const i = rows.findIndex((r, j) => !used.has(j) && r.t >= h.tStart - 0.5 && r.t <= h.tEnd + 1.0);
    if (i < 0) {
      s.notHeard++;
      s.misses.push(`${h.text} -> (nothing)`);
      continue;
    }
    used.add(i);
    if (rows[i].id == null) {
      s.leftOpen++;
      s.misses.push(`${h.text} -> ? ${rows[i].note}`);
    } else {
      s.wrong++;
      if (rows[i].sure === false) s.wrongAsSuggestion++;
      s.misses.push(`${h.text} -> WRONG ${rows[i].note}`);
    }
  }
  s.fromTalk = rows.length - used.size;
  return s;
}

const SUMS = ['calls', 'right', 'rightAsSuggestion', 'wrong', 'wrongAsSuggestion', 'leftOpen', 'notHeard', 'fromTalk', 'nows'];
const setOf = (s) => `${s.kind} ${s.snrDb ?? 'clean'}`;

async function benchModel(model) {
  const queue = [...sessions];
  const heard = new Map();
  const workers = Array.from({ length: Math.min(jobs, queue.length) }, async () => {
    const listener = startListener(releaseDir, model);
    await listener.ready;
    for (let s = queue.shift(); s; s = queue.shift()) {
      heard.set(s.name, await listener.hear(readWav(join(sessionsDir, `${s.name}.wav`))));
    }
    listener.close();
  });
  await Promise.all(workers);

  const sets = new Map();
  for (const s of sessions) {
    const h = heard.get(s.name);
    const sc = score(s.truth, rowsFrom(h.words, s), s.kind);
    const key = setOf(s);
    const a = sets.get(key) ?? { ...Object.fromEntries(SUMS.map((k) => [k, 0])), markLate: [], cost: 0, span: 0, misses: [] };
    for (const k of SUMS) a[k] += sc[k];
    a.markLate.push(...sc.markLate);
    a.cost += h.cost;
    a.span += h.span;
    a.misses.push(...sc.misses.map((x) => `${s.name}: ${x}`));
    sets.set(key, a);
  }
  return [...sets].sort(([p], [q]) => p.localeCompare(q)).map(([set, a]) => {
    const late = a.markLate.slice().sort((p, q) => p - q);
    return {
      model: model.id,
      set,
      calls: a.calls,
      right: a.right,
      rightAsSuggestion: a.rightAsSuggestion,
      wrong: a.wrong,
      wrongAsSuggestion: a.wrongAsSuggestion,
      leftOpen: a.leftOpen,
      notHeard: a.notHeard,
      fromTalk: a.fromTalk,
      nowsCaught: a.markLate.length,
      nows: a.nows,
      // How long after "now" was said its time landed: what lagSeconds is for.
      markLateMean: a.markLate.length ? +(a.markLate.reduce((p, q) => p + q, 0) / a.markLate.length).toFixed(3) : null,
      markLateP95: late.length ? +late[Math.min(late.length - 1, Math.floor(late.length * 0.95))].toFixed(3) : null,
      secondsPerSecond: +(a.cost / 1000 / a.span).toFixed(3),
      misses: a.misses,
    };
  });
}

const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(1)}%` : '–');
const unmarkedWrong = (r) => r.wrong - r.wrongAsSuggestion;

const results = [];
for (const model of manifest.models) {
  const t0 = performance.now();
  const rows = await benchModel(model);
  results.push(...rows);
  console.error(`${model.id}: ${sessions.length} sessions in ${((performance.now() - t0) / 1000).toFixed(0)} s`);
}

const lines = [
  `Release ${manifest.release} (${manifest.built.from ?? 'local'}), ${sessions.length} sessions from ${sessionsDir.split('/').pop()}, read by ${appDir.split('/').pop()}/lib/voice/calls.ts`,
  '',
  '| Model | Set | Calls | Right | of which by sound | Wrong, unmarked | Wrong, marked | Left open | Not heard | From talk | "Now" caught | "Now" late (mean, p95) | s per s |',
  '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ...results.map((r) =>
    [
      r.model, r.set, r.calls, pct(r.right, r.calls), r.rightAsSuggestion, unmarkedWrong(r), r.wrongAsSuggestion, r.leftOpen, r.notHeard, r.fromTalk,
      r.nows ? `${r.nowsCaught}/${r.nows}` : '–',
      r.markLateMean == null ? '–' : `${r.markLateMean.toFixed(2)}, ${r.markLateP95.toFixed(2)}`,
      r.secondsPerSecond.toFixed(3),
    ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'),
  ),
];
console.log(lines.join('\n'));
if (show) {
  for (const r of results) {
    console.log(`\n${r.model}, ${r.set}:`);
    for (const m of r.misses.slice(0, show)) console.log(`  ${m}`);
  }
}

if (typeof flags.out === 'string') {
  const out = {
    release: manifest.release,
    built: manifest.built.from,
    sessions: sessionsDir.split('/').pop(),
    results: results.map(({ misses, ...r }) => r),
  };
  writeFileSync(resolve(flags.out), `${JSON.stringify(out, null, 2)}\n`);
}

if (typeof flags.baseline === 'string') {
  const base = JSON.parse(readFileSync(resolve(flags.baseline), 'utf8'));
  const before = new Map(base.results.map((r) => [`${r.model} | ${r.set}`, r]));
  let worse = false;
  console.log(`\nAgainst ${flags.baseline} (release ${base.release}):`);
  for (const r of results) {
    const b = before.get(`${r.model} | ${r.set}`);
    if (!b) continue;
    const dw = unmarkedWrong(r) - unmarkedWrong(b);
    const dr = r.right - b.right;
    if (dw > 0) worse = true;
    if (dw !== 0 || dr !== 0) console.log(`  ${r.model}, ${r.set}: right ${dr >= 0 ? '+' : ''}${dr}, wrong unmarked ${dw >= 0 ? '+' : ''}${dw}${dw > 0 ? '  ← worse' : ''}`);
  }
  if (worse) die('More boats went down wrong without a mark than in the baseline.');
  console.log('  No model puts more boats down wrong without a mark.');
}
