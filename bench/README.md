# The bench

How well a release takes down called sail numbers. Each model hears each
session through the release's own worker and WebAssembly, the same files a
phone runs, and what it heard is read as calls by the app's own
`lib/voice/calls.ts`. Every call is then scored as one of:

- **right**: a line names the boat that was called, near when it was called.
  "Of which by sound" counts the ones the app only suggested, which a person
  confirms.
- **wrong, unmarked**: a line names another boat and the app was sure. This
  is the number that matters most: nothing tells the scorer to look.
- **wrong, marked**: a line names another boat, as a suggestion.
- **left open**: a line the app couldn't settle, for a person.
- **not heard**: no line at all.

"From talk" counts lines made from conversation rather than a call. For
timed sessions it also measures how long after "now" was said the line's
time landed, which is what a model's `lagSeconds` in `models/models.yaml`
should be set from.

## Running it

```
node scripts/fetch-sessions.mjs                     # build/sessions/sessions-synthetic-1
node bench/run.mjs dist/<release> --app ../sailscoring --baseline bench/baseline.json
```

`--app` is a Sail Scoring checkout with finishes by voice in it (default
`../sailscoring`). `--filter <regex>` keeps some sessions, `--show <n>` lists
what went wrong, `--out <file>` writes the results. To bench models a
release can't carry, assemble with `--trials`
(`node scripts/assemble.mjs --release trials --models zipformer-en-70M,kroko-en --trials`).

CI benches every build and fails if any model puts more boats down wrong
without a mark than `baseline.json` records, so a release can't make that
worse unnoticed. Hearing fewer boats right is reported, not failed: it is a
trade to weigh. When a release is meant to change the numbers, rewrite the
baseline with `--out bench/baseline.json` in the same commit and say why.

## Sessions

A session is a 16 kHz mono 16-bit WAV and a JSON file beside it: the entry
list, and for each call the boat, what was said, and when (`tStart`, `tEnd`,
and `tNow` for the word that gives its time). A set of sessions is
published once, as a release asset under its own tag, pinned in
`sessions.json`, and never regenerated, so every release is scored on the
same sound.

- **sessions-synthetic-1**: 48 synthetic sessions, the ones behind the first
  bench. `gen/` is what made them. A changed generator makes a new set.

Recordings of real callers are people's voices, so they never go here. The
bench takes any directory (`--sessions <dir>`), and a recording made on the
check page becomes a session by writing its JSON from the paper sheet.
