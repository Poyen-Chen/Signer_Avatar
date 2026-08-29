# Signer — your gestures, spoken

A person who can hear but cannot speak makes a gesture of their own to the
camera; the browser recognizes it on-device; a Perxona avatar says the sentence
they taught it, aloud, with a matching expression and body gesture.

The gestures are **the user's own**, not sign language. Most hearing mute people
(laryngectomy, ALS, cerebral palsy) do not sign, and should not have to learn a
language to get a voice — any distinct movement, three takes, and it speaks.
The ASL vocabulary offered in the picker is a suggestion list, nothing more.

## Why this direction

Connect's presenter has no per-bone, blendshape or custom-motion API —
`IPresentationWidget` has 13 methods and the motion end is `playMotion(motionId)`
against a read-only catalog; `POST /assets/vrm/upload` uploads a *character* and
there is no matching write endpoint for animations. Sign language needs
frame-level control of handshape, orientation, location and movement path, so
**the avatar cannot be made to sign.**

Run it the other way and it lands exactly in the SDK's intent: give a signer a
face and a voice. Recognition is ours and stays on the device; speech and
presence are Connect's.

```
camera → HolisticLandmarker → features.js → segment.js → dtw.js
       → sentence.js → motions.js → presenter.present() + playMotion()
```

## How it works, in one sentence

Record a gesture against the sentence it should say; from then on, making that
gesture makes the avatar say it — aloud, with a matching body gesture and facial
expression.

A recorded label can be a single sign (`water` → "I need water.") or a whole
phrase (`Goodbye. See you then.` → spoken as-is). The phrase form is the simplest
way to demo: one gesture, one complete sentence, no grammar assembly in between.

## Privacy

No camera frame, and no landmark derived from one, leaves the device. MediaPipe's
WASM is served locally from `/vendor/tasks-vision`, the model from
`/models/holistic_landmarker.task`, and recorded signs live in `localStorage`.
The only outbound request is the finished sentence handed to `present()`.

## Getting started

1. Set up `.env` per [`samples/express/README.md`](../../../README.md) (two Connect keys).
2. `npm run fetch:signer-model` — downloads the 13 MB MediaPipe Holistic model (once).
3. `npm run dev`, open <http://localhost:8083/demos/signer/>, allow camera access.
4. **Record signs first.** Under *Record signs*, type a sign, press *Record next
   take*, sign it once, stop — it saves itself. Do 3–5 takes each, varying speed
   and distance. Recognition needs at least two signs to mean anything.
5. Switch to *Recognize*, launch the avatar, and sign.
6. *Export JSON* to keep a copy — `localStorage` is not durable.

The suggested vocabulary is drawn from the 250-sign **PopSign** set used by
Google's Isolated Sign Language Recognition dataset, so recordings stay
compatible with that data if the pre-trained model path is ever revived.

## Design notes

**Why DTW rather than a trained model.** It needs no training data and absorbs
the thing that makes frame-by-frame comparison useless — nobody signs at the
same speed twice. The cost is explicit: it recognizes *isolated* signs from a
small vocabulary. Continuous signing, where signs blend and word boundaries are
unmarked, needs a sequence model and the data this approach exists to avoid.

**Feature block weights.** Each block is divided by the square root of its own
dimension count, or the weights would not mean what they say: handshape has 60
numbers per hand against location's 3, and euclidean distance sums squares, so
handshape would outweigh location twentyfold. Measured before the fix, moving a
hand from chest to waist scored *four times smaller* than changing handshape in
place — location, one of the four parameters that distinguish signs, was being
ignored. It is now roughly 0.68 against 1.0.

**Motion energy uses two different measures.** Location is a plain 3-D norm;
handshape is a root-mean-square across its 60 numbers, not a norm. A norm grows
with the square root of its dimension count, so jitter across 60 numbers builds
a floor ~8× larger than any single one, while a hand travelling with still
fingers moves only the 3 location numbers. With one norm over all 63, a still
hand scored 0.15 against a mid-sign 0.19 — a signal-to-noise ratio of 1.3, which
no threshold splits.

**Thresholds are relative, not absolute.** The noise floor depends on camera,
lighting and distance; an absolute threshold tuned on one setup fails silently on
the next. The segmenter tracks the floor continuously and the thresholds are
multiples of it (open at 2.0×, close at 1.65×). The gap between them is
deliberately narrow: a close threshold below the noise floor is never reached, so
a segment that opens never closes — and that failure is silent, showing up as no
recognitions at all.

**Two ways to decline.** A distance threshold rejects "this looks like nothing";
a margin threshold rejects "this looks equally like two things". Only the second
describes a minimal pair. Silence is far more often the right answer than any
word, and a wrong word gets spoken aloud on someone's behalf.

**The loop runs off `requestVideoFrameCallback`, not `requestAnimationFrame`.**
While the presenter loads, its Cocos renderer starves rAF — measured at 0 frames
in 3 seconds with the tab visible and focused, while rVFC held a clean 30. It is
also the better fit: one callback per decoded camera frame, no duplicate frames
to filter, and a precise `mediaTime` for the landmarker.

**Gestures are matched to meaning by lookup, not inference.** The app knows the
sign before it speaks it, so the gloss *is* the semantics. The platform ships the
other half — motions carry `intent:` tags (25 across the library: greeting,
goodbye, apology, agreement, thinking, confusion, explaining, celebration…) plus
a `duration:` — but never applies them: `/connect/presentation` returns an empty
performance manifest for every message, with or without `emotion`. `emotion`
drives the face only. See `motions.js`.

Ranking matters more than signing order: a question word or negation rewrites the
speech act of the whole sentence, so "POTTY WHERE" is a question, not an
explanation of bathrooms.

### Avatar choice is not cosmetic

Of 33 avatars, **6 carry the full 25-intent layer and 18 carry none**. The picker
preselects the `cc069`/`cc076` families for that reason, and the page states what
the chosen avatar can express — otherwise gestures silently never match meaning.

Known gap: none of the 25 intents covers **negation**, so "no" falls back to
matching a motion by name, and the avatars carrying the full intent layer have no
head-shake.

## What is verified

Against a synthetic signer (six signs, four speed/distance/position variants,
including a deliberate minimal pair):

- Classification: **14/14 correct** on everything that segmented, distances
  0.045–0.074 against a 0.45 threshold
- Segmentation: **~78%**; every failure was segmentation, not classification
- **Zero wrong words** — nothing incorrect was ever put in the avatar's mouth
- Random hand-waving: rejected outright

On real hardware: camera at 30 fps with the avatar rendering simultaneously,
`present()` returning `success: true`, and the full performance lifecycle
(`PERFORMANCE_START` → `Talking` → `PLAYING_SPEECH_TEXT` →
`ALL_PERFORMANCE_FINISHED`) firing as the code depends on.

**Thresholds were tuned on synthetic noise and need re-tuning on your camera** —
that is what the sensitivity slider is for. Watch the amber tick on the motion
meter: if signing does not cross it, lower the sensitivity; if sitting still
keeps the *capturing* badge lit, raise it.

## Parked: the pre-trained ASL model

`asl.js` wires up [`sign/kaggle-asl-signs-1st-place`][kaggle] — the MIT-licensed
winner of Google's Isolated Sign Language Recognition competition, 250 ASL signs
in an 11 MB TFLite that takes MediaPipe Holistic landmarks natively
(`[n, 543, 3]`) with preprocessing baked into the graph. It would remove the
need to record anything.

It does not run: `@tensorflow/tfjs-tflite` is the only way to run a `.tflite` in
a browser, has been at `0.0.1-alpha.10` since 2023, exposes no way to resize an
input tensor, and the graph aborts at the fixed `[1, 543, 3]` its flatbuffer
declares. Reviving it needs either a runtime with `resizeInputTensor` or a
tflite→ONNX conversion so the already-vendored `onnxruntime-web` can run it.

A Korean model (`gyann/edge-sign-ksl-mediapipe`, 2,771 signs) was evaluated and
rejected for a different reason worth recording: it packs 137 OpenPose-convention
keypoints into 959 undocumented dimensions, and recovering that layout from its
published normalization stats produced scatter rather than a skeleton. A wrong
guess there fails silently — the model still returns a confident word.

[kaggle]: https://huggingface.co/sign/kaggle-asl-signs-1st-place
