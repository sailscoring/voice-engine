// The check page: a release of this repo on a real phone. One page, nothing
// saved unless asked, nothing sent. The recogniser is the release's own
// worker, spoken to through PROTOCOL.md; reading its words is the app's:
// lib/voice/timeline.ts and the modules beside it, which serve.mjs hands
// over under /app/, so the page shows a recording the way the app does.
// This file is the microphone, the screens and the sounds.

import { digitsOf } from './app/calls.js';
import { createLiveReader } from './app/live.js';
import { checkText, readTimeline, suggestFinishes, timeFromText } from './app/timeline.js';
import { callsNear, competitorMatches, finishUsing, nowsNear, relative, rowKeyOf, timelineRows } from './app/timeline-rows.js';

const SR = 16000;
let LAG = 0.5; // the recogniser writes a word about this long after it was said: the model's lagSeconds

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const SAMPLE = `IRL 1613 Kestrel
IRL 1631 Fulmar
IRL 2016 Saoirse
IRL 2060 Petrel
IRL 8338 Gannet
IRL 4078 Dunlin
IRL 4087 Curlew
IRL 1141 Tern
IRL 3939 Shearwater
IRL 7111 Skua
IRL 5522 Whimbrel
IRL 1333 Guillemot
IRL 9970 Razorbill
IRL 3061 Turnstone
IRL 811 Puffin
IRL 2129 Kittiwake
IRL 6001 Sanderling
IRL 1975 Redshank`;

// ---- the entry list ---------------------------------------------------------
function parseEntries(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const m = line.trim().match(/^((?:[A-Za-z]{1,3}\s*)?\d[\dA-Za-z]*)\s*(.*)$/);
    if (m) out.push({ id: `e${out.length}`, sailNumber: m[1].replace(/\s+/g, ' ').toUpperCase(), name: m[2].trim() });
  }
  return out;
}

// ---- the recogniser ---------------------------------------------------------
let worker = null;
let release = null;
let ready = false;
let waitingForWords = null;
let takeNo = 0;

function startWorker() {
  if (worker) worker.terminate();
  ready = false;
  setReady();
  const model = release.models.find((x) => x.id === $('model').value);
  if (!model) return;
  LAG = model.lagSeconds;
  const mb = model.files.reduce((n, f) => n + f.bytes, 0) / 1048576;
  $('modelnote').textContent = `${model.licence}, ${mb.toFixed(0)} MB. Its words land about ${LAG} s after they are said.`;
  $('loadnote').textContent = 'Loading the recogniser…';
  worker = new Worker(`release/${release.runtimes[model.runtime].worker}`);
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'ready') { ready = true; setReady(); $('loadnote').textContent = 'Ready. Sail numbers are recognised on this device.'; }
    else if (m.type === 'error') $('loadnote').textContent = `The recognition model couldn’t be loaded (${m.message}). Reload the page to try again.`;
    else if (m.type === 'words' && m.take === takeNo) {
      if (S && S.reader) {
        S.cpu += m.cost;
        S.span += m.span;
        S.reader.heard(m);
        if (S.mode === 'mic') scheduleLive();
      }
      if (waitingForWords) { const f = waitingForWords; waitingForWords = null; f(); }
    }
  };
  worker.onerror = (e) => { $('loadnote').textContent = `The recogniser failed to start (${e.message}).`; };
  worker.postMessage({ type: 'init', base: new URL('release/', location.href).href, model });
}
function setReady() {
  $('record').disabled = !ready;
  $('pick').disabled = !ready;
}

// ---- a recording: from Record (or a file) to Stop ---------------------------------
let S = null;

function begin(mode) {
  const entries = parseEntries($('entries').value);
  S = {
    mode, entries, timed: $('timed').checked, model: $('model').value,
    startedAt: null, // wall clock, ms, of the recording's first sample; 0 for a file
    pcm: [], captured: 0,
    levels: [], levelSum: 0, levelN: 0, // loudness, a tenth of a second at a time
    gaps: [], presses: [], finishes: [], dismissals: [],
    cpu: 0, span: 0, stopped: false,
    reader: createLiveReader({ entries, lagSeconds: LAG, onCue: sound }),
  };
  takeNo += 1;
  worker.postMessage({ type: 'begin', take: takeNo });
}

const two = (n) => String(n).padStart(2, '0');
/** A time on the recording's clock: the phone's, or seconds into a file. */
function clock(at, tenths = false) {
  if (S.mode === 'file') {
    const t = Math.max(0, at) / 1000;
    const m = Math.floor(t / 60);
    const s = t - m * 60;
    return `${m}:${tenths ? s.toFixed(1).padStart(4, '0') : two(Math.floor(s))}`;
  }
  const r = tenths ? Math.round(at / 100) * 100 : Math.round(at / 1000) * 1000;
  const d = new Date(r);
  const hms = `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
  return tenths ? `${hms}.${Math.round(r / 100) % 10}` : hms;
}
const takes = () => (S.startedAt == null ? [] : [{ index: 0, startedAt: S.startedAt, samples: S.captured }]);
const now = () => S.startedAt + (S.captured / SR) * 1000;
const nameOf = (id) => S.entries.find((e) => e.id === id);
const full = (id) => { const e = nameOf(id); return e ? `${e.sailNumber} ${e.name}`.trim() : '?'; };
const short = (id) => { const e = nameOf(id); return e ? `${digitsOf(e.sailNumber) || e.sailNumber} ${e.name}`.trim() : '?'; };

/** The timeline as the app reads it, and what it suggests. */
function reading() {
  const tl = readTimeline({ words: S.reader.words(), presses: S.presses, gaps: S.gaps }, S.entries, { lagSeconds: LAG });
  const sg = suggestFinishes(tl, { finishes: S.finishes, dismissals: S.dismissals, takesTime: () => S.timed });
  return { tl, sg };
}

// ---- decisions -------------------------------------------------------------------
function finishOf(s) {
  return { id: crypto.randomUUID(), competitorId: s.competitorId, sailNumber: s.competitorId ? null : s.sailNumber, at: s.at, timeFrom: s.timeFrom, pressId: s.pressId, calledAt: s.calledAt, removed: false };
}
function conflict(competitorId, finishId) {
  const f = S.finishes.find((x) => !x.removed && x.competitorId === competitorId && x.id !== finishId);
  return f ? `They already have a finish at ${clock(f.at)}. Change that one first.` : null;
}
function acceptAll() {
  const { sg } = reading();
  for (const s of sg.suggestions) if (!s.check && s.competitorId) S.finishes.push(finishOf(s));
  redraw();
}
function save(edit) {
  const was = edit.finishId ? S.finishes.find((f) => f.id === edit.finishId) : null;
  const f = { id: was?.id ?? crypto.randomUUID(), competitorId: edit.competitorId, sailNumber: edit.competitorId ? null : edit.sailNumber, at: edit.at, timeFrom: edit.timeFrom, pressId: edit.pressId, calledAt: edit.calledAt, removed: false };
  S.finishes = [...S.finishes.filter((x) => x.id !== f.id), f];
  redraw();
}
function dismiss(target) {
  if (target.finishId) S.finishes = S.finishes.map((f) => (f.id === target.finishId ? { ...f, removed: true } : f));
  else S.dismissals.push(target.dismissal);
  redraw();
}

// ---- the timeline as a list ----------------------------------------------------
function chip(c) {
  if (c.how === 'whole' || c.how === 'ending') return `<span class="chip"><b>${esc(short(c.competitorId).split(' ')[0])}</b>${esc(nameOf(c.competitorId)?.name ?? '')}</span>`;
  if (c.how === 'sounds') return `<span class="chip close"><b>${esc(short(c.competitorId).split(' ')[0])}</b>${esc(nameOf(c.competitorId)?.name ?? '')} · close match</span>`;
  if (c.how === 'ambiguous') return `<span class="chip unknown"><b>${esc(c.digits)}</b> could be ${c.couldBe.length}</span>`;
  return `<span class="chip unknown"><b>${esc(c.digits || '?')}</b> not on the entry list</span>`;
}
function who(competitorId, sailNumber) {
  return competitorId ? short(competitorId) : sailNumber ? `${sailNumber} ?` : 'no sail number';
}
function pill(finish, suggestion) {
  if (finish) return `<span class="fin ok">✓ ${esc(who(finish.competitorId, finish.sailNumber))}</span>`;
  if (suggestion?.check) return `<span class="fin look">${esc(who(suggestion.competitorId, suggestion.sailNumber))}</span>`;
  if (suggestion) return `<span class="fin sug"><small>suggested</small> ${esc(who(suggestion.competitorId, suggestion.sailNumber))}</span>`;
  return '';
}
function words(sn) {
  const inCall = (i) => sn.calls.some((c) => i >= c.from && i < c.to);
  return sn.words.map((w, i) => `<span class="${inCall(i) ? 'num' : ''}${i === sn.nowWord ? ' nowword' : ''}">${esc(w)}</span>`).join(' ');
}
function rowHTML(r, { sel, newest }) {
  const cls = (k) => `r ${k}${sel === r.key ? ' sel' : ''}${newest ? ' newest' : ''}`;
  switch (r.kind) {
    case 'snippet': {
      const talk = r.snippet.calls.length === 0;
      const again = r.snippet.calls.some((c) => c.again) ? '<span class="again">called again</span>' : '';
      return `<div class="${cls(talk ? 'talk' : 'call')}" data-row="${r.key}"><span class="t">${clock(r.at)}</span><span class="b"><span>${words(r.snippet)}</span>${r.snippet.calls.map((c) => `<span data-call="${c.key}">${chip(c)}</span>`).join('')}${again}</span></div>`;
    }
    case 'now': {
      const st = r.state;
      const src = r.now.pressId ? (r.now.word ? `pressed · heard “${esc(r.now.word)}”` : 'pressed') : `heard “${esc(r.now.word)}”`;
      let fin = '';
      let why = '';
      if (st.kind === 'finish') fin = pill(st.finish);
      else if (st.kind === 'suggestion') { fin = pill(null, st.suggestion); if (st.suggestion.check) why = checkText(st.suggestion, full); }
      else if (st.kind === 'offers') { fin = `<span class="fin look">${st.calls.length} sail numbers</span>`; why = `One NOW for ${st.calls.length} sail numbers: ${st.calls.map((c) => (c.competitorId ? full(c.competitorId) : c.digits)).join(' and ')}`; }
      else fin = '<span class="fin off">not a finish</span>';
      return `<div class="${cls(`nowrow${r.now.pressId ? '' : ' sp'}`)}" data-row="${r.key}"><span class="t">${clock(r.at, true)}</span><span class="b"><span class="nowtag">NOW</span><span class="src">${src}</span><span class="spacer"></span>${fin}</span>${why ? `<span class="why">${esc(why)}</span>` : ''}</div>`;
    }
    case 'pin': {
      const why = r.suggestion?.check ? `<span class="why">${esc(checkText(r.suggestion, full))}</span>` : '';
      const from = timeFromText((r.finish ?? r.suggestion).timeFrom).toLowerCase();
      return `<div class="${cls('pin')}" data-row="${r.key}"><span class="t">${clock(r.at, true)}</span><span class="b">⚑ ${pill(r.finish, r.suggestion)}<span class="src" style="background:none">${esc(from)}</span></span>${why}</div>`;
    }
    case 'gap':
      return `<div class="r gaprow"><span class="t">${clock(r.at)}</span><span>Not recording from ${clock(r.gap.from)} to ${clock(r.gap.to)}. Anything called out then was not recorded.</span></div>`;
    case 'quiet':
      return `<div class="r q" data-row="${r.key}" data-middle="${r.middle}">· ${r.seconds} s quiet ·</div>`;
    case 'open':
      return `<div class="${cls('talk')}" style="cursor:default"><span class="t">${clock(r.at)}</span><span class="partial">${esc(r.words.join(' '))}…</span></div>`;
  }
  return '';
}

// ---- while recording ----------------------------------------------------------
let live = { following: true, editor: null, frame: 0 };
function scheduleLive() {
  if (live.frame) return;
  live.frame = requestAnimationFrame(() => { live.frame = 0; renderLive(); });
}
function renderLive() {
  if (!S || S.stopped) return;
  const { tl, sg } = reading();
  const rows = timelineRows({ timeline: tl, suggested: sg, finishes: S.finishes, dismissals: S.dismissals, open: S.reader.open(), lagSeconds: LAG });
  const list = $('livelist');
  list.innerHTML = rows.length
    ? rows.map((r, i) => rowHTML(r, { newest: i === rows.length - 1 })).join('')
    : '<p class="muted" style="padding:16px">Call out the first sail number, then “now” as they finish, or press NOW.</p>';
  if (live.following) list.scrollTop = list.scrollHeight;
  const known = new Set(tl.calls.filter((c) => c.competitorId).map((c) => c.competitorId)).size;
  const unknown = tl.calls.filter((c) => !c.competitorId).length;
  $('counts').textContent = `${known} sail number${known === 1 ? '' : 's'} recognised${unknown ? ` · ${unknown} not on the entry list` : ''} · ${tl.nows.length} NOW`;
  if (live.editor) renderEditor(live.editor.host);
}

// ---- the editor: Competitor and Time, set separately ----------------------------
let E = null;

function targetOf(row, callKey, tl, sg) {
  if (!row) return null;
  if (row.kind === 'now') {
    if (row.state.kind === 'finish') return { kind: 'finish', finish: row.state.finish };
    if (row.state.kind === 'suggestion') return { kind: 'suggestion', suggestion: row.state.suggestion };
    return { kind: 'now', now: row.now, offers: sg.offers[row.now.key] };
  }
  if (row.kind === 'pin') return row.finish ? { kind: 'finish', finish: row.finish } : { kind: 'suggestion', suggestion: row.suggestion };
  if (row.kind === 'snippet') {
    const c = row.snippet.calls.find((x) => x.key === callKey) ?? row.snippet.calls[0];
    if (!c) return null;
    const f = finishUsing(S.finishes, { call: c });
    if (f) return { kind: 'finish', finish: f };
    const s = sg.suggestions.find((x) => x.callKey === c.key);
    if (s) return { kind: 'suggestion', suggestion: s };
    return { kind: 'call', call: c };
  }
  return null;
}

function openEditor(target, host) {
  const t = target;
  const text = (id, sn) => (id ? full(id) : sn ?? '');
  let st;
  if (t.kind === 'finish') st = { competitorId: t.finish.competitorId, query: text(t.finish.competitorId, t.finish.sailNumber), at: t.finish.at, timeFrom: t.finish.timeFrom, pressId: t.finish.pressId, calledAt: t.finish.calledAt };
  else if (t.kind === 'suggestion') st = { competitorId: t.suggestion.competitorId, query: text(t.suggestion.competitorId, t.suggestion.sailNumber), at: t.suggestion.at, timeFrom: t.suggestion.timeFrom, pressId: t.suggestion.pressId, calledAt: t.suggestion.calledAt };
  else if (t.kind === 'now') st = { competitorId: null, query: '', at: t.now.at, timeFrom: t.now.pressId ? 'press' : 'spoken', pressId: t.now.pressId, calledAt: null };
  else if (t.kind === 'call') {
    const named = ['whole', 'ending', 'sounds'].includes(t.call.how) ? t.call.competitorId : null;
    st = { competitorId: named, query: text(named, t.call.digits), at: t.call.at, timeFrom: 'called', pressId: null, calledAt: t.call.at };
  } else st = { competitorId: null, query: '', at: t.at, timeFrom: 'hand', pressId: null, calledAt: null };
  E = { target: t, host, ...st };
  if (host === 'liveeditor') live.editor = { host };
  renderEditor(host);
}
function closeEditor() {
  if (E) $(E.host).innerHTML = '';
  E = null;
  live.editor = null;
}

function matchesHTML() {
  if (E.competitorId) return '';
  const q = E.query.trim();
  if (!q) return '';
  const ms = competitorMatches(q, S.entries);
  if (!ms.length) return `<p class="muted small">No competitor on the entry list matches “${esc(q)}”. Saving keeps it as a competitor not on the entry list.</p>`;
  const has = (id) => S.finishes.some((f) => !f.removed && f.competitorId === id && f.id !== (E.target.kind === 'finish' ? E.target.finish.id : null));
  return `<div class="ac">${ms.map(({ competitor: c, why }) => `<button data-act="pick" data-id="${c.id}"><b class="mono">${esc(c.sailNumber)}</b> ${esc(c.name)}<span class="muted">${esc([why, has(c.id) ? 'has a finish' : ''].filter(Boolean).join(' · '))}</span></button>`).join('')}</div>`;
}

function renderEditor(host) {
  if (!E || E.host !== host) return;
  const { tl, sg } = reading();
  const t = E.target;
  const finishId = t.kind === 'finish' ? t.finish.id : null;
  const ref = E.at;
  const why = t.kind === 'suggestion' && t.suggestion.check
    ? checkText(t.suggestion, full)
    : t.kind === 'now' ? (t.offers ? `One NOW for ${t.offers.length} sail numbers. Play it, then choose.` : 'Time recorded, but no sail number') : '';
  const origin = t.kind === 'finish' ? `Finish at ${clock(t.finish.at, true)}`
    : t.kind === 'suggestion' ? (t.suggestion.heard ? `Suggested from “${t.suggestion.heard}”` : `Suggested from the NOW at ${clock(t.suggestion.at, true)}`)
      : t.kind === 'now' ? `From the NOW at ${clock(t.now.at, true)}`
        : t.kind === 'call' ? `From “${t.call.heard}” at ${clock(t.call.at, true)}` : `At the playhead, ${clock(t.at, true)}`;
  const near = callsNear(tl, ref).map((c) => (c.competitorId
    ? `<button class="opt" data-act="pick" data-id="${c.competitorId}" aria-pressed="${E.competitorId === c.competitorId}"><b class="mono">${esc(nameOf(c.competitorId)?.sailNumber)}</b> ${esc(nameOf(c.competitorId)?.name)} <span class="muted">· ${relative(c.at, ref)}${S.finishes.some((f) => !f.removed && f.competitorId === c.competitorId && f.id !== finishId) ? ' · has a finish' : ''}</span></button>`
    : `<button class="opt" data-act="query" data-q="${esc(c.digits)}"><b class="mono">${esc(c.digits)}</b> <span class="muted">· heard “${esc(c.heard)}” · ${relative(c.at, ref)}</span></button>`)).join('');
  const nows = nowsNear(tl, ref).map((n) => {
    const used = finishUsing(S.finishes, { now: n });
    const by = used && used.id !== finishId ? (used.competitorId ? nameOf(used.competitorId)?.sailNumber : used.sailNumber) : null;
    const on = E.pressId ? E.pressId === n.pressId : E.timeFrom === 'spoken' && E.at === n.at;
    return `<button class="opt" data-act="time" data-at="${n.at}" data-from="${n.pressId ? 'press' : 'spoken'}" data-press="${n.pressId ?? ''}" aria-pressed="${on}">NOW ${clock(n.at, true)}<span class="muted">${n.pressId ? '' : ` · heard “${esc(n.word)}”`}${by ? ` · used by ${esc(by)}` : ''}</span></button>`;
  }).join('');
  const called = E.calledAt != null ? `<button class="opt" data-act="time" data-at="${E.calledAt}" data-from="called" data-press="" aria-pressed="${E.timeFrom === 'called' && E.at === E.calledAt}">When called out ${clock(E.calledAt, true)}</button>` : '';
  const ph = host !== 'liveeditor' ? `<button class="opt" data-act="time" data-at="${R.ph}" data-from="hand" data-press="" aria-pressed="false">Playhead ${clock(R.ph, true)}</button>` : '';
  const clash = E.competitorId ? conflict(E.competitorId, finishId) : null;
  const canSave = E.at != null && (E.competitorId || E.query.trim()) && !clash;
  $(host).innerHTML = `<div class="ed" role="dialog" aria-label="Finish">
    <div class="eh"><strong>Finish</strong><span class="o">${esc(origin)}</span><button class="sm ghost" data-act="close" aria-label="Close">✕</button></div>
    ${why ? `<p class="why">${esc(why)}</p>` : ''}
    <div class="fld"><label class="lab" for="ed-competitor" style="margin:0">Competitor</label>
      <input type="text" id="ed-competitor" placeholder="Sail number or name" autocomplete="off" spellcheck="false" value="${esc(E.query)}">
      <div id="ed-matches">${matchesHTML()}</div>
      ${clash ? `<p class="problem">${esc(clash)}</p>` : ''}
      ${near ? `<span class="muted small">Called out nearby</span><div class="opts">${near}</div>` : ''}
    </div>
    <div class="fld"><span class="lab">Time</span>
      <div><span class="tbig">${E.at != null ? clock(E.at, true) : 'Not chosen'}</span> <span class="muted small">${esc(timeFromText(E.timeFrom))}</span></div>
      <div class="opts">${nows}${called}${ph}</div>
      <div class="opts">
        <button class="opt mono" data-act="nudge" data-ms="-1000">−1 s</button><button class="opt mono" data-act="nudge" data-ms="-100">−0.1 s</button>
        <button class="opt mono" data-act="nudge" data-ms="100">+0.1 s</button><button class="opt mono" data-act="nudge" data-ms="1000">+1 s</button>
        ${host !== 'liveeditor' ? '<button class="opt" data-act="play">▶ Play</button>' : ''}
      </div>
    </div>
    <div class="foot">${t.kind !== 'time' ? '<button class="ghost" data-act="dismiss">Not a finish</button>' : '<span></span>'}<button class="primary" data-act="save" ${canSave ? '' : 'disabled'}>Save finish</button></div>
  </div>`;
}

function editorClick(e) {
  const b = e.target.closest('[data-act]');
  if (!b || !E) return;
  const act = b.dataset.act;
  const finishId = E.target.kind === 'finish' ? E.target.finish.id : null;
  if (act === 'close') return closeEditor();
  if (act === 'pick') { E.competitorId = b.dataset.id; E.query = full(b.dataset.id); }
  else if (act === 'query') { E.competitorId = null; E.query = b.dataset.q; }
  else if (act === 'time') { E.at = Number(b.dataset.at); E.timeFrom = b.dataset.from; E.pressId = b.dataset.press || null; }
  else if (act === 'nudge') { if (E.at == null) return; E.at += Number(b.dataset.ms); E.timeFrom = 'hand'; E.pressId = null; }
  else if (act === 'play') return void play(E.at - 2000, E.at + 2000);
  else if (act === 'save') {
    const q = E.query.trim();
    save({ finishId, competitorId: E.competitorId, sailNumber: E.competitorId ? null : q.toUpperCase(), at: E.at, timeFrom: E.timeFrom, pressId: E.pressId, calledAt: E.calledAt });
    return closeEditor();
  } else if (act === 'dismiss') {
    const t = E.target;
    if (finishId) dismiss({ finishId });
    else if (t.kind === 'suggestion') dismiss({ dismissal: { pressId: t.suggestion.pressId, spokenAt: t.suggestion.timeFrom === 'spoken' ? t.suggestion.at : null, calledAt: t.suggestion.calledAt } });
    else if (t.kind === 'now') dismiss({ dismissal: { pressId: t.now.pressId, spokenAt: t.now.pressId ? null : t.now.at, calledAt: null } });
    else if (t.kind === 'call') dismiss({ dismissal: { pressId: null, spokenAt: null, calledAt: t.call.at } });
    return closeEditor();
  }
  renderEditor(E.host);
}
function editorInput(e) {
  if (!E || e.target.id !== 'ed-competitor') return;
  E.query = e.target.value;
  E.competitorId = null;
  $('ed-matches').innerHTML = matchesHTML();
  const save = $(E.host).querySelector('[data-act="save"]');
  if (save) save.disabled = !(E.at != null && E.query.trim());
}
function editorKey(e) {
  if (!E || e.target.id !== 'ed-competitor' || e.key !== 'Enter') return;
  const first = $(E.host).querySelector('.ac button');
  if (first) { e.preventDefault(); first.click(); }
}
for (const host of ['liveeditor', 'revieweditor', 'sheeteditor']) {
  $(host).addEventListener('click', editorClick);
  $(host).addEventListener('input', editorInput);
  $(host).addEventListener('keydown', editorKey);
}

// ---- afterwards: the timeline and the sheet --------------------------------------
const R = { view: 'timeline', ph: 0, sel: null, playing: null };

function openReview(view = 'timeline') {
  R.view = view;
  if (!R.ph) R.ph = S.startedAt ?? 0;
  $('review').hidden = false;
  redraw();
}
function redraw() {
  if (S && !S.stopped) { scheduleLive(); return; }
  if (!$('review').hidden) renderReview();
  showDone();
}

function stripSVG(width) {
  const span = (width >= 600 ? 40 : 24) * 1000;
  const from = R.ph - span / 2;
  const to = from + span;
  const pps = width / span;
  const x = (t) => ((t - from) * pps).toFixed(1);
  const { tl, sg } = reading();
  let g = '';
  for (const gap of tl.gaps) if (gap.to > from && gap.from < to) g += `<rect class="gapr" x="${x(Math.max(gap.from, from))}" y="18" width="${((Math.min(gap.to, to) - Math.max(gap.from, from)) * pps).toFixed(1)}" height="52"/>`;
  const bw = Math.max(0.8, pps * 100 * 0.6).toFixed(2);
  for (let t = Math.ceil(from / 100) * 100; t < to; t += 100) {
    const i = Math.floor((t - S.startedAt) / 100);
    if (i < 0 || i >= S.levels.length) continue;
    const h = Math.max(1.2, S.levels[i] * 48);
    g += `<rect class="wv" x="${x(t)}" y="${(44 - h / 2).toFixed(1)}" width="${bw}" height="${h.toFixed(1)}"/>`;
  }
  for (const n of tl.nows) if (n.at >= from && n.at <= to) g += `<line class="nw" x1="${x(n.at)}" x2="${x(n.at)}" y1="15" y2="73"${n.pressId ? '' : ' stroke-dasharray="3 3"'}/>`;
  for (const c of tl.calls) if (c.at >= from - 2000 && c.at <= to) g += `<text class="lb${c.how === 'whole' || c.how === 'ending' ? '' : ' doubt'}" x="${x(c.at)}" y="11">${esc(c.competitorId ? digitsOf(nameOf(c.competitorId)?.sailNumber ?? '') : c.digits)}</text>`;
  const flags = [
    ...S.finishes.filter((f) => !f.removed).map((f) => [f.at, 'ok']),
    ...sg.suggestions.map((s) => [s.at, s.check ? 'look' : 'sug']),
  ];
  for (const [at, k] of flags) if (at >= from && at <= to) g += `<line class="fp ${k}" x1="${x(at)}" x2="${x(at)}" y1="73" y2="85"/><path class="${k}" d="M${x(at)} 73.5l7 3.2-7 3.2z"/>`;
  const px = (width / 2).toFixed(1);
  g += `<line class="phd" x1="${px}" x2="${px}" y1="2" y2="86"/><circle class="phc" cx="${px}" cy="4" r="3.2"/>`;
  return `<svg viewBox="0 0 ${width} 86" preserveAspectRatio="none">${g}</svg>`;
}
function drawStrip() {
  const w = Math.max(200, Math.round($('strip').getBoundingClientRect().width || 340));
  $('strip').innerHTML = stripSVG(w);
  $('playhead').textContent = clock(R.ph, true);
}

function renderReview() {
  $('v-timeline').setAttribute('aria-pressed', R.view === 'timeline');
  $('v-sheet').setAttribute('aria-pressed', R.view === 'sheet');
  $('tlview').style.display = R.view === 'timeline' ? 'flex' : 'none';
  $('sheetview').style.display = R.view === 'sheet' ? 'flex' : 'none';
  const { tl, sg } = reading();
  const accepted = S.finishes.filter((f) => !f.removed).length;
  const clear = sg.suggestions.filter((s) => !s.check && s.competitorId).length;
  const toCheck = sg.suggestions.filter((s) => s.check).length;
  const sum = `<span><b>${accepted}</b> accepted · <b>${clear}</b> suggested · <span class="${toCheck ? 'attn' : ''}">${toCheck} to check</span></span><span class="spacer"></span>${clear ? `<button class="sm primary" data-act="acceptall">Accept ${clear} suggested finish${clear === 1 ? '' : 'es'}</button>` : ''}<button class="sm" data-act="next" ${toCheck ? '' : 'disabled'}>Next to check ›</button>`;
  if (R.view === 'timeline') {
    drawStrip();
    $('tlsum').innerHTML = sum;
    const list = $('reviewlist');
    const top = list.scrollTop;
    const rows = timelineRows({ timeline: tl, suggested: sg, finishes: S.finishes, dismissals: S.dismissals, lagSeconds: LAG });
    list.innerHTML = rows.map((r) => rowHTML(r, { sel: R.sel })).join('') || '<p class="muted" style="padding:16px">Nothing was recorded.</p>';
    list.scrollTop = top;
  } else {
    $('sheetsum').innerHTML = sum;
    $('sheetlist').innerHTML = sheetHTML(sg);
  }
  if (E && E.host !== 'liveeditor') renderEditor(E.host);
}

function sheetHTML(sg) {
  const items = [
    ...S.finishes.filter((f) => !f.removed).map((f) => ({ at: f.at, finish: f })),
    ...sg.suggestions.map((s) => ({ at: s.at, suggestion: s })),
  ].sort((a, b) => a.at - b.at);
  const taken = new Set(items.map((i) => (i.finish ?? i.suggestion).competitorId).filter(Boolean));
  const rows = items.map((i, n) => {
    const x = i.finish ?? i.suggestion;
    const num = x.competitorId ? nameOf(x.competitorId)?.sailNumber : x.sailNumber ?? '—';
    const name = x.competitorId ? nameOf(x.competitorId)?.name : x.sailNumber ? 'Not on the entry list' : 'Time recorded, but no sail number';
    const tag = i.finish ? '<span class="tag ok">✓</span>' : i.suggestion.check ? '<span class="tag look">check</span>' : '<span class="tag sug">suggested</span>';
    const why = i.suggestion?.check && (x.competitorId || x.sailNumber) ? ` · <span class="attn">${esc(checkText(i.suggestion, full))}</span>` : '';
    return `<div class="srow${i.suggestion?.check ? ' look' : ''}" data-item="${n}"><span class="mono">${S.timed ? clock(i.at) : '—'}</span><span><b class="mono">${esc(num)}</b> ${esc(name)}</span>${tag}<span class="sub">${esc(timeFromText(x.timeFrom))}${why}</span></div>`;
  });
  const nyr = S.entries.filter((e) => !taken.has(e.id));
  R.sheetItems = items;
  return rows.join('') + `<div class="nyr"><b>Not yet recorded (${nyr.length})</b><br>${nyr.map((e) => `${esc(e.sailNumber)} ${esc(e.name)}`).join(' · ')}</div>`;
}

function reviewClick(e) {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'acceptall') return acceptAll();
  if (act === 'next') {
    const { sg } = reading();
    const toCheck = sg.suggestions.filter((s) => s.check);
    if (!toCheck.length) return;
    const from = E ? E.at ?? -Infinity : -Infinity;
    const s = toCheck.find((x) => x.at > from + 1) ?? toCheck[0];
    R.ph = s.at;
    const { tl } = reading();
    R.sel = rowKeyOf({ kind: 'suggestion', key: s.key }, timelineRows({ timeline: tl, suggested: sg, finishes: S.finishes, dismissals: S.dismissals }));
    openEditor({ kind: 'suggestion', suggestion: s }, R.view === 'timeline' ? 'revieweditor' : 'sheeteditor');
    renderReview();
    scrollToSel();
  }
}
function scrollToSel() {
  const list = $('reviewlist');
  const row = R.sel ? list.querySelector(`[data-row="${CSS.escape(R.sel)}"]`) : null;
  if (row) list.scrollTop = Math.max(0, row.offsetTop - list.clientHeight / 4);
}
$('tlsum').addEventListener('click', reviewClick);
$('sheetsum').addEventListener('click', reviewClick);

function listClick(e, host) {
  const rowEl = e.target.closest('[data-row]');
  if (!rowEl || !S) return;
  const { tl, sg } = reading();
  const rows = timelineRows({ timeline: tl, suggested: sg, finishes: S.finishes, dismissals: S.dismissals, open: host === 'liveeditor' ? S.reader.open() : [], lagSeconds: LAG });
  const row = rows.find((r) => r.key === rowEl.dataset.row);
  if (!row) return;
  const callKey = e.target.closest('[data-call]')?.dataset.call;
  if (host === 'revieweditor') {
    R.sel = row.key;
    const at = row.kind === 'quiet' ? row.middle : row.at;
    R.ph = at;
    void play(at - 2000, at + 3000);
  }
  const target = targetOf(row, callKey, tl, sg);
  if (target) openEditor(target, host);
  else if (E && E.host === host) closeEditor();
  if (host === 'revieweditor') renderReview();
}
$('livelist').addEventListener('click', (e) => listClick(e, 'liveeditor'));
$('reviewlist').addEventListener('click', (e) => listClick(e, 'revieweditor'));
$('sheetlist').addEventListener('click', (e) => {
  const el = e.target.closest('[data-item]');
  const item = el && R.sheetItems?.[Number(el.dataset.item)];
  if (!item) return;
  openEditor(item.finish ? { kind: 'finish', finish: item.finish } : { kind: 'suggestion', suggestion: item.suggestion }, 'sheeteditor');
});
$('livelist').addEventListener('scroll', () => {
  const el = $('livelist');
  live.following = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  $('backtolive').hidden = live.following;
});
$('backtolive').onclick = () => { live.following = true; $('backtolive').hidden = true; renderLive(); };

// The strip: drag it, or use the arrow keys, to move the playhead.
let drag = null;
$('strip').addEventListener('pointerdown', (e) => {
  stopPlaying();
  const w = $('strip').getBoundingClientRect().width;
  drag = { x: e.clientX, ph: R.ph, msPerPx: ((w >= 600 ? 40 : 24) * 1000) / w };
  $('strip').setPointerCapture(e.pointerId);
});
$('strip').addEventListener('pointermove', (e) => {
  if (!drag) return;
  R.ph = clampPh(Math.round((drag.ph - (e.clientX - drag.x) * drag.msPerPx) / 100) * 100);
  drawStrip();
});
const endDrag = () => { if (drag) { drag = null; renderReview(); } };
$('strip').addEventListener('pointerup', endDrag);
$('strip').addEventListener('pointercancel', endDrag);
$('strip').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  e.preventDefault();
  stopPlaying();
  R.ph = clampPh(R.ph + (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 1000 : 100));
  drawStrip();
});
const clampPh = (t) => Math.min(now(), Math.max(S.startedAt ?? 0, t));
for (const b of document.querySelectorAll('[data-nudge]')) {
  b.onclick = () => { stopPlaying(); R.ph = clampPh(R.ph + Number(b.dataset.nudge)); drawStrip(); };
}
$('playbtn').onclick = () => (R.playing ? stopPlaying() : void play(R.ph, R.ph + 8000));
$('here').onclick = () => { stopPlaying(); R.sel = null; openEditor({ kind: 'time', at: Math.round(R.ph / 100) * 100 }, 'revieweditor'); renderReview(); };
$('v-timeline').onclick = () => { closeEditor(); R.view = 'timeline'; renderReview(); };
$('v-sheet').onclick = () => { closeEditor(); R.view = 'sheet'; renderReview(); };
$('closereview').onclick = () => { stopPlaying(); closeEditor(); $('review').hidden = true; showDone(); };

// ---- sounds ------------------------------------------------------------------
const TONES = { ok: [[880, 0.09]], check: [[880, 0.09], [520, 0.12]], doubt: [[330, 0.12], [330, 0.12]], mark: [[1320, 0.04]] };
function sound(kind) {
  const ctx = S?.ctx;
  if (!ctx || ctx.state !== 'running') return;
  let t = ctx.currentTime + 0.01;
  for (const [f, d] of TONES[kind]) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.25, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    o.connect(g).connect(ctx.destination);
    o.start(t);
    o.stop(t + d + 0.02);
    t += d + 0.05;
  }
}

// ---- the microphone ----------------------------------------------------------
const WORKLET = URL.createObjectURL(new Blob([`
class Tap extends AudioWorkletProcessor {
  constructor() { super(); this.parts = []; this.n = 0; this.want = Math.round(sampleRate / 10); }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      this.parts.push(ch.slice()); this.n += ch.length;
      if (this.n >= this.want) {
        const out = new Float32Array(this.n); let o = 0;
        for (const p of this.parts) { out.set(p, o); o += p.length; }
        this.port.postMessage(out, [out.buffer]); this.parts = []; this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor('tap', Tap);`], { type: 'text/javascript' }));

/** Any rate down to 16 kHz: average over the step, then pick. Speech survives it. */
function resampler(from) {
  if (from === SR) return (x) => x;
  const step = from / SR;
  const width = Math.max(1, Math.round(step));
  let carry = new Float32Array(0);
  let pos = 0;
  return (x) => {
    const buf = new Float32Array(carry.length + x.length);
    buf.set(carry); buf.set(x, carry.length);
    const n = Math.max(0, Math.floor((buf.length - width - pos) / step));
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const at = Math.floor(pos + i * step);
      let sum = 0;
      for (let k = 0; k < width; k++) sum += buf[at + k];
      out[i] = sum / width;
    }
    const used = Math.floor(pos + n * step);
    pos = pos + n * step - used;
    carry = buf.slice(used);
    return out;
  };
}

function store(samples) {
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i];
    pcm[i] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
    S.levelSum += v * v;
    S.levelN += 1;
    if (S.levelN === SR / 10) {
      S.levels.push(Math.min(1, Math.sqrt(S.levelSum / S.levelN) * 5));
      S.levelSum = 0;
      S.levelN = 0;
    }
  }
  S.pcm.push(pcm);
  S.captured += samples.length;
}

function onAudio(block) {
  if (!S || S.stopped) return;
  const samples = S.resample(block);
  if (!samples.length) return;
  const wall = Date.now();
  if (S.startedAt == null) {
    S.startedAt = wall - (samples.length / SR) * 1000;
    S.reader.beginTake(S.startedAt);
  }
  // The recording's clock is the phone's clock. If the microphone stopped for
  // a while (a call, another app, the screen off), say so and keep the two in
  // step by leaving the gap in the recording, silent.
  const missing = (wall - S.startedAt) / 1000 - (S.captured + samples.length) / SR;
  if (missing > 1.5) {
    const from = now();
    const n = Math.round(missing * SR);
    store(new Float32Array(n));
    for (let at = 0; at < n; at += SR) worker.postMessage({ type: 'audio', samples: new Float32Array(Math.min(SR, n - at)) });
    S.gaps.push({ from, to: now() });
    $('gap').hidden = false;
    $('gaptext').textContent = `Not recording from ${clock(from)} to ${clock(now())}. Anything called out then was not recorded.`;
  }
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  $('level').style.width = `${Math.min(100, Math.sqrt(sum / samples.length) * 500)}%`;
  store(samples);
  worker.postMessage({ type: 'audio', samples }, [samples.buffer]);
}

async function record() {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: true, autoGainControl: true } });
  } catch (err) {
    $('loadnote').textContent = `The microphone isn’t available (${err.name}). Allow it for this page, then press Record again.`;
    return;
  }
  begin('mic');
  let ctx;
  try { ctx = new AudioContext({ sampleRate: SR, latencyHint: 'interactive' }); } catch { ctx = new AudioContext(); }
  await ctx.resume();
  await ctx.audioWorklet.addModule(WORKLET);
  const node = new AudioWorkletNode(ctx, 'tap');
  const quiet = ctx.createGain();
  quiet.gain.value = 0;
  ctx.createMediaStreamSource(stream).connect(node).connect(quiet).connect(ctx.destination);
  Object.assign(S, { ctx, stream, resample: resampler(ctx.sampleRate), mic: stream.getAudioTracks()[0]?.label ?? '' });
  node.port.onmessage = (e) => onAudio(e.data);
  ctx.onstatechange = () => {
    $('dot').classList.toggle('off', ctx.state !== 'running');
    $('state').textContent = ctx.state === 'running' ? 'Recording' : 'Not recording';
  };
  await keepAwake();
  live = { following: true, editor: null, frame: 0 };
  $('gap').hidden = true;
  $('state').textContent = 'Recording';
  $('stopbar').hidden = false;
  $('stopconfirm').hidden = true;
  $('recording').hidden = false;
  renderLive();
  S.tick = setInterval(() => {
    if (S.startedAt == null) return;
    $('clock').textContent = clock(Date.now());
    const s = Math.floor((Date.now() - S.startedAt) / 1000);
    $('elapsed').textContent = `${two(Math.floor(s / 60))}:${two(s % 60)}`;
  }, 250);
}

let wakeLock = null;
async function keepAwake() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { wakeLock = null; }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !S || S.stopped || S.mode !== 'mic') return;
  keepAwake();
  S.ctx?.resume();
});

function pressNow() {
  if (!S || S.stopped || S.startedAt == null) return;
  S.presses.push({ id: crypto.randomUUID(), at: Date.now() });
  sound('mark');
  renderLive();
}

function stop() {
  if (!S || S.stopped) return;
  S.stopped = true;
  clearInterval(S.tick);
  S.stream?.getTracks().forEach((t) => t.stop());
  S.ctx?.close();
  wakeLock?.release?.();
  // Give the recogniser a moment to hand over its last words.
  setTimeout(() => {
    S.reader.endTake();
    closeEditor();
    $('recording').hidden = true;
    $('lock').hidden = true;
    R.ph = S.startedAt ?? 0;
    showDone();
    openReview('timeline');
  }, 400);
}

// ---- a recording run through the same ears -----------------------------------
async function runFile(file) {
  $('loadnote').textContent = `Reading ${file.name}…`;
  const ac = new AudioContext();
  const audio = await ac.decodeAudioData(await file.arrayBuffer());
  ac.close();
  const off = new OfflineAudioContext(1, Math.ceil(audio.duration * SR), SR);
  const src = off.createBufferSource();
  src.buffer = audio;
  src.connect(off.destination);
  src.start();
  const x = (await off.startRendering()).getChannelData(0);
  begin('file');
  S.startedAt = 0;
  S.reader.beginTake(0);
  for (let at = 0; at < x.length; at += 1600) {
    const samples = x.slice(at, at + 1600);
    store(samples);
    const answered = new Promise((res) => { waitingForWords = res; });
    worker.postMessage({ type: 'audio', samples }, [samples.buffer]);
    await answered;
    if (at % 160000 === 0) $('loadnote').textContent = `Listening to ${file.name}: ${Math.round((100 * at) / x.length)}%`;
  }
  S.reader.endTake();
  S.stopped = true;
  $('loadnote').textContent = `Listened to ${file.name}.`;
  R.ph = 0;
  showDone();
  openReview('timeline');
}

// ---- hearing it again -----------------------------------------------------------
let player = null;
async function play(fromAt, toAt) {
  stopPlaying();
  const from = Math.max(0, Math.floor(((fromAt - S.startedAt) / 1000) * SR));
  const to = Math.min(S.captured, Math.floor(((toAt - S.startedAt) / 1000) * SR));
  if (to <= from) return;
  const out = new Float32Array(to - from);
  let at = 0;
  for (const chunk of S.pcm) {
    const lo = Math.max(from, at);
    const hi = Math.min(to, at + chunk.length);
    for (let i = lo; i < hi; i++) out[i - from] = chunk[i - at] / 32768;
    at += chunk.length;
    if (at >= to) break;
  }
  player?.close();
  player = new AudioContext();
  const buf = player.createBuffer(1, out.length, SR);
  buf.copyToChannel(out, 0);
  const source = player.createBufferSource();
  source.buffer = buf;
  source.connect(player.destination);
  const began = player.currentTime;
  const start = S.startedAt + (from / SR) * 1000;
  const ctx = player;
  R.playing = { source };
  $('playbtn').textContent = '❚❚';
  source.onended = () => { if (R.playing?.source === source) stopPlaying(); };
  source.start();
  const step = () => {
    if (R.playing?.source !== source) return;
    R.ph = start + (ctx.currentTime - began) * 1000;
    if (!$('review').hidden) drawStrip();
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
function stopPlaying() {
  if (!R.playing) return;
  const { source } = R.playing;
  R.playing = null;
  try { source.stop(); } catch { /* already ended */ }
  R.ph = Math.round(R.ph / 100) * 100;
  $('playbtn').textContent = '▶';
}

// ---- after a recording ----------------------------------------------------------
function showDone() {
  if (!S || !S.stopped) return;
  const { sg } = reading();
  const accepted = S.finishes.filter((f) => !f.removed).length;
  const toCheck = sg.suggestions.filter((s) => s.check).length;
  $('summary').textContent = `${accepted} accepted · ${sg.suggestions.length - toCheck} suggested · ${toCheck} to check${S.gaps.length ? ` · ${S.gaps.length} gap${S.gaps.length === 1 ? '' : 's'} in recording` : ''}`;
  $('stats').textContent = S.span
    ? `Recognising took ${(S.cpu / 1000 / S.span).toFixed(2)} seconds for each second of sound. Model: ${S.model}.${S.mic ? ` Microphone: ${S.mic}.` : ''}`
    : '';
  $('done').hidden = false;
}

function saveFile(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
const stamp = () => new Date(S.mode === 'file' ? Date.now() : S.startedAt).toISOString().slice(0, 19).replace(/[:T]/g, '-');
$('savewav').onclick = () => {
  const head = new DataView(new ArrayBuffer(44));
  const bytes = S.captured * 2;
  const w = (o, s) => [...s].forEach((c, i) => head.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); head.setUint32(4, 36 + bytes, true); w(8, 'WAVEfmt '); head.setUint32(16, 16, true);
  head.setUint16(20, 1, true); head.setUint16(22, 1, true); head.setUint32(24, SR, true); head.setUint32(28, SR * 2, true);
  head.setUint16(32, 2, true); head.setUint16(34, 16, true); w(36, 'data'); head.setUint32(40, bytes, true);
  saveFile(`finishes-${stamp()}.wav`, new Blob([head, ...S.pcm], { type: 'audio/wav' }));
};
$('savelog').onclick = () => {
  const { sg } = reading();
  const log = {
    what: 'Sail Scoring voice engine check: a recording’s timeline',
    startedAt: S.mode === 'file' ? null : new Date(S.startedAt).toISOString(),
    release: release.release, built: release.built.from,
    seconds: S.captured / SR, model: S.model, microphone: S.mic ?? null, timed: S.timed, lagAssumed: LAG,
    userAgent: navigator.userAgent, realTimeFactor: S.span ? S.cpu / 1000 / S.span : null,
    entries: S.entries, takes: takes(), gaps: S.gaps, presses: S.presses, words: S.reader.words(),
    finishes: S.finishes.map((f) => ({ ...f, competitor: f.competitorId ? full(f.competitorId) : null, time: clock(f.at, true) })),
    dismissals: S.dismissals,
    suggested: sg.suggestions.map((s) => ({ ...s, competitor: s.competitorId ? full(s.competitorId) : null, time: clock(s.at, true) })),
  };
  saveFile(`finishes-${stamp()}.json`, new Blob([JSON.stringify(log, null, 1)], { type: 'application/json' }));
};

// ---- controls ----------------------------------------------------------------
$('record').onclick = record;
$('pick').onclick = () => $('file').click();
$('file').onchange = (e) => { const f = e.target.files[0]; if (f) runFile(f); e.target.value = ''; };
$('now').onclick = pressNow;
$('stop').onclick = () => { $('stopbar').hidden = true; $('stopconfirm').hidden = false; };
$('keep').onclick = () => { $('stopbar').hidden = false; $('stopconfirm').hidden = true; };
$('stopyes').onclick = stop;
$('gapok').onclick = () => { $('gap').hidden = true; };
$('opentl').onclick = () => openReview('timeline');
$('opensheet').onclick = () => openReview('sheet');
$('model').onchange = startWorker;
$('lockbtn').onclick = () => { $('lock').hidden = false; };
let holding = null;
const letGo = () => { clearTimeout(holding); };
$('lock').addEventListener('pointerdown', () => { holding = setTimeout(() => { $('lock').hidden = true; }, 900); });
$('lock').addEventListener('pointerup', letGo);
$('lock').addEventListener('pointercancel', letGo);

$('entries').value = SAMPLE;
fetch('release/manifest.json').then((r) => r.json()).then((manifest) => {
  release = manifest;
  $('model').innerHTML = manifest.models.map((x) => `<option value="${esc(x.id)}">${esc(x.label)}</option>`).join('');
  startWorker();
}).catch(() => {
  $('loadnote').textContent = 'No release here. See check/README.md: assemble one, then start serve.mjs with it.';
});
