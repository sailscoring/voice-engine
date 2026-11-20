# The check page

A release on a real phone. One page that listens to sail numbers being
called and takes them down, with the recogniser and the model from a
release of this repo and the app's own reading of calls. Nothing leaves the
phone unless you save it. It answers what the bench can't: does a phone
keep up, does listening survive the screen locking or a phone call, and how
it feels in the hand.

```
node scripts/assemble.mjs --release trials --models zipformer-en-70M,kroko-en --trials
node check/serve.mjs dist/trials --app ../sailscoring
```

It serves over HTTPS, since a phone's browser gives a page the microphone
only then, with a certificate it makes itself in `build/`. Open the address
it prints for the local network on a phone on the same Wi-Fi and accept the
warning about the certificate. On the water there is no Wi-Fi: load the page
ashore, keep it open, and it carries on working.

Then:

1. Replace the entry list with real sail numbers and names, one boat a line.
2. Pick a model.
3. **Listen**, and call boats: "sixteen thirteen … now".
4. **Stop**, and settle the lines it wasn't sure of. ▶ plays each call back.
5. **Save the recording** and **Save the list of calls**. A recording of a
   real finish, with the paper sheet beside it, is what the bench most
   needs.

**Run a recording…** puts a sound file through the same ears, faster than
real time.

## What to watch for

- Does **Listen** start at all? iPhone needs iOS 16.4 or later.
- The last line of the sheet says how long recognising took for each second
  of sound. Above about 0.7, the phone can't keep up with that model.
- Lock the phone or take a call while it listens. The page should come back
  saying when it wasn't listening.
- A headset: does the page name it, and do the tones come through it?
- Wind.
