# The check page

A release on a real phone. One page that records sail numbers being called
out, and reads the recording into a timeline the way the app does: the
recogniser and the model from a release of this repo, and the app's own
modules (`lib/voice/calls.ts`, `timeline.ts` and the ones beside them) for
everything after that. Nothing leaves the phone unless you save it. It
answers what the bench can't: does a phone keep up, does recording survive
the screen locking or a phone call, and how it feels in the hand.

```
node scripts/assemble.mjs --release trials --models zipformer-en-70M,kroko-en --trials
node check/serve.mjs dist/trials --app ../sailscoring
```

`--app` is a Sail Scoring checkout with the voice modules in it (the app's
`voice-recording` branch, until it is merged); the page reads them afresh
on every reload. It serves over HTTPS, since a phone's browser gives a page the microphone
only then, with a certificate it makes itself in `build/`. Open the address
it prints for the local network on a phone on the same Wi-Fi and accept the
warning about the certificate. On the water there is no Wi-Fi: load the page
ashore, keep it open, and it carries on working.

Then:

1. Replace the entry list with real ones: a sail number and boat name per
   line.
2. Pick a model.
3. **Record**, and call out sail numbers: "sixteen thirteen … now", or
   press **NOW** as they finish. The timeline builds as you go.
4. **Stop recording**. The timeline opens: **Accept** the suggested
   finishes, and check the rest with **Next to check**. Tapping a row plays
   it; the strip moves the playhead. **Finish sheet** shows the result.
5. **Save the recording** and **Save the timeline**. A recording of a real
   finish, with the paper sheet beside it, is what the bench most needs.

**Run a recording…** puts a sound file through the same ears, faster than
real time.

## What to watch for

- Does **Record** start at all? iPhone needs iOS 16.4 or later.
- After a recording, the page says how long recognising took for each
  second of sound. Above about 0.7, the phone can't keep up with that model.
- Lock the phone or take a call while it records. The page should come back
  saying when it wasn't recording.
- A headset: does the page name it, and do the tones come through it?
- Wind.
