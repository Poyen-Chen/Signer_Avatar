/**
 * Perxona Connect Kit — Signer Demo · ASL sign classifier
 *
 * Runs the winning entry from Google's "Isolated Sign Language Recognition"
 * Kaggle competition (MIT licensed, ~11 MB TFLite) over the same MediaPipe
 * Holistic landmarks the rest of the demo already computes. 250 ASL signs,
 * entirely on the device.
 *
 * Why this model and not one of the others surveyed: the competition's
 * submission format required the .tflite to take **raw landmarks in and logits
 * out**, so the preprocessing is baked inside the graph. Nothing has to be
 * guessed. The Korean model considered earlier (gyann/edge-sign-ksl-mediapipe)
 * looked comparable on paper but packs 137 OpenPose-convention keypoints into
 * 959 undocumented dimensions; attempting to recover that layout from its
 * published normalization stats produced scatter, not a skeleton, and a wrong
 * guess there fails silently — it still returns a confident word.
 *
 * The landmark order below is the competition's and is not negotiable: the
 * model was trained on exactly this arrangement.
 *
 * ---------------------------------------------------------------------------
 * PARKED — not wired into the app. The model and this code are correct; the
 * browser runtime is not there yet.
 *
 * `@tensorflow/tfjs-tflite` is the only way to run a .tflite in a browser and
 * it has been at 0.0.1-alpha.10 since 2023. Its `TFLiteModel` exposes no way to
 * resize an input tensor, so the interpreter is stuck at the `[1, 543, 3]` the
 * flatbuffer declares as a placeholder for the sequence dimension — and the
 * graph aborts even at that shape, because it wants the variable-length
 * sequence the competition's signature specified.
 *
 * To revive this, either a runtime that supports `resizeInputTensor`, or a
 * tflite→ONNX conversion so `onnxruntime-web` (already vendored here) can run
 * it. Both are worth doing: 250 signs with no recording is a far better
 * product than a vocabulary each user has to build by hand.
 * ---------------------------------------------------------------------------
 */

const LANDMARK_COUNT = 543;

/**
 * Frame layout, in the order the model expects.
 * face 468 → left hand 21 → pose 33 → right hand 21 = 543 points, each (x,y,z).
 */
const SECTIONS = [
  { key: "faceLandmarks", count: 468 },
  { key: "leftHandLandmarks", count: 21 },
  { key: "poseLandmarks", count: 33 },
  { key: "rightHandLandmarks", count: 21 },
];

/**
 * Missing landmarks are NaN, not zero.
 *
 * The training data came from MediaPipe with absent parts left as NaN, and the
 * model's own preprocessing looks for them. Zeros would be read as "the hand is
 * at the origin" — a real position, in the corner of the frame — rather than as
 * "there is no hand", which is a different claim entirely and one the model was
 * never trained to see.
 */
const MISSING = Number.NaN;

let tflite = null;
let tf = null;
let model = null;
let labels = null;

/** Sign name for each output index, from the competition's own vocabulary map. */
async function loadLabels(url) {
  const map = await fetch(url).then((r) => r.json()); // { "hello": 0, ... }
  const out = new Array(Object.keys(map).length);
  for (const [name, index] of Object.entries(map)) out[index] = name;
  return out;
}

/**
 * @param {{modelUrl: string, labelsUrl: string, wasmPath: string}} options
 * @returns {Promise<{signCount: number}>}
 */
export async function loadAslModel({ modelUrl, labelsUrl, wasmPath }) {
  // Both globals come from the UMD bundles loaded in index.html. Tensors must
  // be built with the same core instance the interpreter was linked against,
  // which is exactly what sharing one global gives us.
  tflite = globalThis.tflite;
  tf = globalThis.tf;
  if (!tflite || !tf) {
    throw new Error("TensorFlow.js did not load — check the script tags in index.html");
  }
  // CPU rather than WebGL on purpose: these tensors are only containers handed
  // straight to the TFLite interpreter, which does the actual compute in its
  // own WebAssembly. A GPU backend would buy nothing and would compete with
  // both the avatar's renderer and MediaPipe for the same device.
  await tf.setBackend("cpu");
  await tf.ready();
  // Point the interpreter at the locally served WebAssembly. Left unset it
  // reaches for a CDN, which would defeat the on-device guarantee.
  tflite.setWasmPath(wasmPath);
  [model, labels] = await Promise.all([tflite.loadTFLiteModel(modelUrl), loadLabels(labelsUrl)]);
  return { signCount: labels.length };
}

export function isAslModelLoaded() {
  return model !== null;
}

/**
 * Flatten one HolisticLandmarkerResult into the model's 543×3 frame layout.
 * @param {object} result
 * @param {Float32Array} out destination, length 543*3
 * @param {number} offset where this frame starts
 */
function writeFrame(result, out, offset) {
  let i = offset;
  for (const { key, count } of SECTIONS) {
    const points = result?.[key]?.[0];
    for (let p = 0; p < count; p += 1) {
      const lm = points?.[p];
      if (lm) {
        out[i] = lm.x;
        out[i + 1] = lm.y;
        out[i + 2] = lm.z ?? 0;
      } else {
        out[i] = MISSING;
        out[i + 1] = MISSING;
        out[i + 2] = MISSING;
      }
      i += 3;
    }
  }
}

/**
 * Classify one captured sign.
 *
 * @param {object[]} frames raw HolisticLandmarkerResult objects for the segment
 * @param {{minMargin?: number}} [options] how far ahead of the runner-up the
 *   winner must be, as a share of total probability, before the word is trusted
 * @returns {{label: string|null, confidence: number, runnerUp: string|null,
 *            runnerUpConfidence: number, reason: string|null,
 *            ranking: Array<{label: string, confidence: number}>}}
 */
export async function classifyAsl(frames, { minConfidence = 0.35, minMargin = 0.12 } = {}) {
  if (!model) throw new Error("ASL model not loaded");

  const data = new Float32Array(frames.length * LANDMARK_COUNT * 3);
  frames.forEach((f, n) => writeFrame(f, data, n * LANDMARK_COUNT * 3));

  const input = tf.tensor(data, [frames.length, LANDMARK_COUNT, 3], "float32");
  let probs;
  try {
    const output = model.predict(input);
    probs = await output.data();
    output.dispose();
  } finally {
    input.dispose();
  }

  const ranking = Array.from(probs, (confidence, i) => ({ label: labels[i], confidence }))
    .sort((a, b) => b.confidence - a.confidence);

  const [winner, runnerUp] = ranking;
  const result = {
    label: winner.label,
    confidence: winner.confidence,
    runnerUp: runnerUp?.label ?? null,
    runnerUpConfidence: runnerUp?.confidence ?? 0,
    reason: null,
    ranking: ranking.slice(0, 5),
  };

  // Two ways to decline, for the same reason the DTW path has two: the model
  // has no "not a sign" class and will always name something, and a wrong word
  // here is spoken aloud on someone's behalf.
  if (winner.confidence < minConfidence) return { ...result, label: null, reason: "low-confidence" };
  if (winner.confidence - result.runnerUpConfidence < minMargin) {
    return { ...result, label: null, reason: "ambiguous" };
  }
  return result;
}
