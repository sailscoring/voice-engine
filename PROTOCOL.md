# The worker's messages

**Protocol 1.** An app talks to a recogniser through one dedicated worker:
sound goes in, words with times come out. This is everything the app may rely
on. A runtime that implements these messages can replace another without the
app changing. A change that would break an app that follows this page makes a
new protocol number, and a release says which one it speaks
(`manifest.json`'s `protocol`).

## Starting a worker

A release's `manifest.json` names each runtime's worker script and each
model's files. The app starts the worker for the model's runtime with
`new Worker(base + runtime.worker)`, where `base` is the URL the release's
files are served under, ending in `/`. It is a classic worker, not a module
worker.

## Messages in

| Message | Fields | Meaning |
|---------|--------|---------|
| `init` | `base`, `model`, `cache?` | Load the runtime and the model. `base` as above. `model` is the model's entry from `manifest.json`, as it stands. `cache` names a Cache Storage cache to read files from before the network, for an app that keeps the files there to work with no signal. |
| `begin` | `take` | A new take: an unbroken run of sound. The times of the words that follow start again from 0, and words from an earlier take are never sent again. `take` is the app's number for it and comes back on every `words`. |
| `audio` | `samples` | Sound: a `Float32Array` of mono samples at 16 kHz, in the range −1 to 1. Transfer its buffer rather than copy it. Sound sent before the first `begin` belongs to take 0. |

## Messages out

| Message | Fields | Meaning |
|---------|--------|---------|
| `ready` | | The model is loaded; send sound. Sent once, after `init`. |
| `words` | `take`, `words`, `closed`, `heard`, `cost`, `span` | What the recogniser makes of the take so far, sent after each `audio`. |
| `error` | `message` | Something failed. Before `ready`, the worker is no use and the app should end it. |

In `words`:

- `words`: `[{ w, t }]`. Each word as written (case as the model writes it)
  and the time it began, in seconds since its take began. The time is when
  the recogniser placed the word, which is later than it was said by about
  the model's `lagSeconds`. Subtracting that is the app's job.
- `closed`: the recogniser has finished with these words. The next `words`
  starts a new list. Until a list is closed, each `words` replaces the last
  one: a word may change, or be taken back, as more sound arrives.
- `heard`: seconds of sound in this take so far.
- `cost`, `span`: milliseconds the recogniser spent on the sound this message
  answers, and how many seconds of sound that was. `cost / 1000 / span` above
  about 0.7 means the device isn't keeping up with this model.

## What a worker never does

It never sends the sound or the words anywhere. It reads only the files its
`init` named, from `cache` or from `base`.
