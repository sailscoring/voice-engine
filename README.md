# voice-engine

The speech recogniser [Sail Scoring](https://github.com/sailscoring/sailscoring)
runs on a phone to take finishes by voice: a caller on the finish boat says
the sail numbers, and the recorder's phone writes them down. Recognition
happens on the phone, with no signal needed once the files are there.

This repo builds, tests and publishes what that needs: a speech recognition
library compiled to WebAssembly, the models it runs, and the worker that
runs them. It knows nothing about boats or races. Reading the words as sail
numbers is the app's job.

## The one interface

An app starts a worker, sends it sound, and gets words with times back. The
messages are in [PROTOCOL.md](PROTOCOL.md). Any recogniser that sends words
with times can sit behind them, so a newer model or a different library is a
new release here, not a change to the app.

## What a release is

A GitHub release, tagged `v<N>`, made by CI and never by hand. Its
`manifest.json` lists every file with its size and SHA-256, the protocol it
speaks, what each runtime was built from, and each model's settings. One of
those settings is `lagSeconds`, how long after a word is said its time lands,
which the app subtracts.

The app pins a release, and its build downloads the files, checks them
against the manifest and serves them from its own domain. A phone downloads
them once, about 82 MB for the current release, and keeps them.

```
<release>/
  manifest.json
  sherpa-onnx/        worker.js and the compiled library
  models/<id>/        encoder.onnx, decoder.onnx, joiner.onnx, tokens.txt
  licences/           what is compiled in, and each model's licence
```

## What's here

| Path | What it is |
|------|------------|
| `PROTOCOL.md` | The worker's messages. |
| `runtimes/sherpa-onnx/` | [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)'s streaming recogniser: `versions.env` (what it's built from, pinned), `build.sh`, `patches/`, `worker.js`. |
| `models/models.yaml` | Every model we know of: where it comes from (pinned by SHA-256), its licence, whether a release may carry it, its settings, and which ones the next release carries. |
| `licences/` | Licence texts models refer to. |
| `scripts/` | Build, fetch models, assemble a release, smoke-test it. |
| `bench/` | How well a release takes down called sail numbers, scored with the app's own reading of calls, and the baseline CI holds each build to. See [bench/README.md](bench/README.md). |
| `check/` | A page to try a release on a real phone. See [check/README.md](check/README.md). |

## Building one

Needs podman or docker, Node 24, `tar` and `bzip2`.

```
npm ci
scripts/build.sh                                 # the runtime, in its pinned container: a few minutes
node scripts/fetch-models.mjs                    # the models the release lists (--all for every one)
node scripts/assemble.mjs --release dev          # dist/dev/ and dist/dev-assets/
node scripts/smoke-test.mjs dist/dev             # each model hears its test recording
```

The smoke test runs the release's own worker and WebAssembly in Node, through
the messages in `PROTOCOL.md`, over a recording that ships with each model,
and fails on a word error rate above 15%. It says the build runs and hears
English. How well it hears sail numbers is the [bench](bench/README.md)'s
question, which CI also asks of every build.

To try a build in the app: `pnpm voice:sync --from <this repo>/dist/dev` in
the app's checkout. On a phone without the app: the [check page](check/README.md).

## Making a release

Change what needs changing, let CI pass on `main`, then tag:

```
git tag v2 && git push origin v2
```

CI builds, smoke-tests, benches and publishes the release. The app then pins
it.

## Models and licences

A model goes into a release only if `models.yaml` marks it `shippable`, and
`scripts/assemble.mjs` refuses anything else. Marking one shippable is a
decision about its licence: the commit says why. A model that isn't
shippable can still be benched and tried: `--trials` assembles it into a
bundle marked `trialsOnly`, which the app refuses to serve.

| Model | Licence | Shippable |
|-------|---------|-----------|
| Zipformer English, 2023-06-26 | Apache 2.0 | yes, in the current release |
| Zipformer English 20M, 2023-02-17 | Apache 2.0 | yes |
| Kroko English, 2025-08-06 | CC BY-SA | not decided |

## Licence

The code here is MIT. What a release carries keeps its own licence: see the
`licences/` directory of each release.
