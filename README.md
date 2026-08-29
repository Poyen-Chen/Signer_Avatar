# Signer — your gestures, spoken by an avatar

> **Perxona Taipei Hackathon 2026.** A person who can hear but cannot speak teaches
> an avatar their own gestures. The avatar becomes their voice.

## The idea

There are people who understand you perfectly and cannot answer you: after a
laryngectomy, with ALS, with cerebral palsy, with severe dysarthria. They *hear*.
They just have no voice.

Today their options are typing on a phone and pressing play. It is slow, and it
turns a conversation into an operation — the other person looks down at a screen
and listens to a machine, not at a person who is speaking to them.

Signer gives them a voice with a face:

1. **Teach.** Make any gesture you like — your own, not a sign language — and
   type the sentence it should say. Three takes. Thirty seconds.
2. **Speak.** From then on, that gesture makes a Perxona avatar say the sentence
   out loud, with a matching expression and body gesture: it raises a hand for a
   greeting, nods for a thank-you, and if it didn't catch the gesture it says
   *"Sorry, I didn't catch that. Let me try again."* — because for a mute user,
   the avatar asking to repeat **is** the user asking.

The other person sees a face that is talking to them. The mute person, for the
first time in that conversation, is someone who is *speaking* rather than
someone who is *typing*.

## Why an avatar, not a speaker

Take the avatar away and what is left is a keyboard and a loudspeaker — that has
existed for forty years. The avatar is what turns text-to-speech into a person:

- **A body that matches the meaning.** The Perxona motion catalog carries
  `intent:` tags (greeting, goodbye, apology, agreement, confusion…). Signer looks
  the spoken sentence up against them, so the body says what the mouth says.
- **A face the listener looks at.** People address faces. A listener talks *to*
  the avatar, and therefore to the person behind it — not to a phone screen.
- **In-character repair.** A recognition miss becomes the avatar politely asking
  again, which is what a person does, instead of a silent failure.

## Why personal gestures, not sign language

Sign language belongs to the Deaf community. Most hearing mute people do not sign
and should not have to learn a language to get a voice. Signer matches **the
user's own movements** against takes they recorded themselves, so:

- there is nothing to learn — any distinct movement works;
- it is private by construction — recognition runs entirely in the browser
  (MediaPipe Holistic + DTW template matching); no video and no landmark ever
  leaves the device. The only thing sent anywhere is the finished sentence,
  handed to the avatar to speak.

## Demo

- Launch an avatar, enable the camera.
- **Teach gestures** → type a sentence → *Record next take* → make the gesture →
  stop. Three times, varying speed and distance.
- **Speak** → make the gesture → the avatar says it.

The demo is at [`samples/express/public/demos/signer/`](samples/express/public/demos/signer/)
— see its [README](samples/express/public/demos/signer/README.md) for how it
works and what was measured, and the [run of show](https://claude.ai/code/artifact/46e55517-8f4f-4033-839a-cc7136ad0e0f)
for the five-minute stage script.

### Run it

```bash
cd samples/express
cp .env.example .env        # add your Perxona Connect secret + publishable keys
npm install
npm run fetch:signer-model  # 13 MB MediaPipe Holistic model, once
npm run dev                 # http://localhost:8083/demos/signer/
```

Needs Node ≥ 22, Chrome, a webcam, and a [Perxona Console](https://console.perxona.ai)
account (asia region) for the avatar. Recognition itself needs no account and no
network.

## What is honest about it

- Recognition matches against the user's own recordings, so it is good for the
  person who recorded them and poor across people (measured: 42% cross-signer).
  For personal gestures that is the right trade — nobody needs to perform
  someone else's movement.
- Today's vocabulary is whatever the user has taught it. A pre-trained
  250-sign ASL model (Kaggle ISLR winner, MIT) is wired up in `asl.js` but
  parked: the only browser TFLite runtime cannot resize its input tensor.
  Converting it to ONNX is the next step.
- The avatar's automatic motion selection returns nothing on this account, so
  Signer picks body gestures itself from the catalog's intent tags. Only 6 of
  33 avatars carry those tags; the picker preselects one that does.

## Built on

The [Perxona Connect Kit](https://github.com/XRSPACE-Inc/perxona-connect-kit)
samples (Apache-2.0). Everything under `samples/express/` other than
`public/demos/signer/`, `scripts/fetch-signer-model.mjs`,
`scripts/build-seed-vocabulary.mjs` and small server/landing-page edits is
XRSPACE's original sample code — see their
[README](samples/express/README.md) for the Connect API, keys, and the
`<sv-presenter>` component.
