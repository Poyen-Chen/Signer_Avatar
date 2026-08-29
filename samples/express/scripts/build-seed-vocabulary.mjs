#!/usr/bin/env node
/**
 * Build a seed vocabulary for the signer demo from pre-extracted MediaPipe
 * landmark sequences, so the demo can be tried without recording anything first.
 *
 * Input is a directory of per-sign folders of NumPy `.npy` files, each holding
 * one signing of that word as `(frames, 1629)` float64 — the classic MediaPipe
 * Holistic layout: pose 33×3, face 468×3, left hand 21×3, right hand 21×3.
 *
 *   seed-source/
 *     hello/27172.npy
 *     hello/27173.npy
 *     water/...
 *
 * Output is a file the demo's "Import JSON" accepts, produced by running the
 * landmarks through the *same* `features.js` the live camera path uses. That is
 * the whole point: a template only matches if it was built by the identical
 * normalization, so this script imports that module rather than reimplementing
 * it.
 *
 *   node scripts/build-seed-vocabulary.mjs <source-dir> [output.json]
 *
 * Licensing is on you. Landmark sets derived from video corpora often inherit
 * research-only terms from the source videos; check before shipping one.
 *
 * ---------------------------------------------------------------------------
 * MEASURED RESULT — read before using the output as a vocabulary.
 *
 * Run against WLASL-derived pose data (16 signs, 5 takes each from different
 * signers), the templates carry real signal but not enough of it:
 *
 *   same-label mean DTW distance   0.423
 *   diff-label mean DTW distance   0.652   (ratio 0.649; 1.0 would be no signal)
 *   leave-one-out 1-NN accuracy    42%     vs a 6% random baseline
 *   precision when it speaks       ~50%    at every rejection threshold tried
 *
 * Seven times chance is a real effect, and the confusions are linguistically
 * sensible — drink/water, food/home, hurt/sick are genuine near-neighbours in
 * ASL — so the conversion is sound. But 50% precision means the avatar says the
 * wrong word half the times it speaks, and tightening the thresholds only
 * rejects more without improving it.
 *
 * The reason is structural, not a bug: DTW nearest-neighbour compares a capture
 * against stored examples, so it works when the person signing is the person
 * who recorded them — same body, camera, framing and style — and falls apart
 * across signers, where between-signer variation exceeds between-word
 * variation. Generalizing across signers is what a trained model is for; it is
 * why the Kaggle competition this demo's parked model came from exists at all.
 *
 * So: useful for experiments and for measuring, not as a shipped vocabulary.
 * A user's own three takes beat all 76 of these.
 * ---------------------------------------------------------------------------
 */

import { readdir, readFile, writeFile, stat } from "node:fs/promises";
import { join, basename } from "node:path";

const signerDir = new URL("../public/demos/signer/", import.meta.url);
const { frameToVector, resample } = await import(new URL("features.js", signerDir));
const { TEMPLATE_FRAMES, MAX_SAMPLES_PER_WORD } = await import(new URL("vocab.js", signerDir));

/** Segment sizes in the 1629-wide frame vector. */
const POSE = 33 * 3;
const FACE = 468 * 3;
const HAND = 21 * 3;
const FRAME_WIDTH = POSE + FACE + HAND + HAND;

/**
 * Assumed aspect ratio of the source video.
 *
 * features.js multiplies x by width/height to make horizontal and vertical
 * distances comparable — normalized landmarks run 0..1 on both axes, so on a
 * 16:9 frame one unit of x covers far more of the world than one unit of y.
 * The source videos' true aspect is not recorded here, and guessing wrong
 * stretches x relative to what the webcam produces: 16:9 assumed against a 4:3
 * source is a 33% error on every horizontal distance. 16:9 matches both the
 * demo's own capture request and the majority of the source corpus, so it is
 * the least-wrong single answer — but it is an assumption, and the first thing
 * to revisit if seeded templates match poorly against live signing.
 */
const SOURCE_VIDEO = { videoWidth: 1280, videoHeight: 720 };

/** Minimal `.npy` reader: magic, version, header dict, then raw values. */
function readNpy(buffer) {
  if (buffer.subarray(0, 6).toString("latin1") !== "\x93NUMPY") {
    throw new Error("not a .npy file");
  }
  const major = buffer[6];
  const headerLength = major === 1 ? buffer.readUInt16LE(8) : buffer.readUInt32LE(8);
  const headerStart = major === 1 ? 10 : 12;
  const header = buffer.subarray(headerStart, headerStart + headerLength).toString("latin1");

  const shape = header.match(/'shape':\s*\((\d+),\s*(\d+)\)/);
  const descr = header.match(/'descr':\s*'([^']+)'/);
  if (!shape) throw new Error(`unexpected shape in header: ${header.trim()}`);
  if (descr?.[1] !== "<f8") throw new Error(`expected little-endian float64, got ${descr?.[1]}`);
  if (/'fortran_order':\s*True/.test(header)) throw new Error("fortran_order not supported");

  const rows = Number(shape[1]);
  const cols = Number(shape[2]);
  if (cols !== FRAME_WIDTH) {
    throw new Error(`expected ${FRAME_WIDTH} values per frame (pose+face+hands), got ${cols}`);
  }
  const data = buffer.subarray(headerStart + headerLength);
  return { rows, cols, read: (r, c) => data.readDoubleLE((r * cols + c) * 8) };
}

/**
 * Read one landmark group out of a row.
 * @returns {Array|undefined} undefined when the group is absent, which the
 *   source marks with NaN. That distinction matters: features.js reads a
 *   missing hand as "no hand" and leaves its slice at zero with the presence
 *   flag clear, whereas NaN coordinates would propagate through every
 *   subsequent distance and quietly poison the template.
 */
function readGroup(npy, row, offset, count) {
  const points = [];
  for (let p = 0; p < count; p += 1) {
    const x = npy.read(row, offset + p * 3);
    const y = npy.read(row, offset + p * 3 + 1);
    const z = npy.read(row, offset + p * 3 + 2);
    if (Number.isNaN(x) || Number.isNaN(y)) return undefined;
    points.push({ x, y, z });
  }
  return points;
}

/** Shape one row as the HolisticLandmarkerResult that features.js expects. */
function rowToResult(npy, row) {
  const pose = readGroup(npy, row, 0, 33);
  const left = readGroup(npy, row, POSE + FACE, 21);
  const right = readGroup(npy, row, POSE + FACE + HAND, 21);
  return {
    poseLandmarks: pose ? [pose] : undefined,
    leftHandLandmarks: left ? [left] : undefined,
    rightHandLandmarks: right ? [right] : undefined,
  };
}

/** One `.npy` → one template, or null if too little of it was usable. */
function fileToTemplate(buffer) {
  const npy = readNpy(buffer);
  const vectors = [];
  for (let row = 0; row < npy.rows; row += 1) {
    const vector = frameToVector(rowToResult(npy, row), SOURCE_VIDEO);
    // frameToVector returns null when no torso is visible — there is nothing to
    // be relative to, so the frame is dropped rather than guessed at.
    if (vector) vectors.push(vector);
  }
  // A clip that lost most of its frames to a missing torso is not a sign, it is
  // a tracking failure; seeding a template from it would poison the vocabulary.
  if (vectors.length < npy.rows * 0.5 || vectors.length < 8) return null;

  // Trim frames where neither hand is visible. Source clips are cut to fixed
  // length and usually open and close on the signer at rest with hands down,
  // which the live segmenter would never have included in a capture.
  const handsVisible = (v) => v[0] === 1 || v[v.length / 2] === 1;
  let start = 0;
  let end = vectors.length - 1;
  while (start < end && !handsVisible(vectors[start])) start += 1;
  while (end > start && !handsVisible(vectors[end])) end -= 1;
  const trimmed = vectors.slice(start, end + 1);
  if (trimmed.length < 8) return null;

  return resample(trimmed, TEMPLATE_FRAMES);
}

const [sourceDir, outPath = "seed-vocabulary.json"] = process.argv.slice(2);
if (!sourceDir) {
  console.error("usage: node scripts/build-seed-vocabulary.mjs <source-dir> [output.json]");
  process.exit(1);
}

const words = {};
let kept = 0;
let skipped = 0;

for (const entry of await readdir(sourceDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const label = entry.name.replace(/_/g, " ");
  const dir = join(sourceDir, entry.name);
  const files = (await readdir(dir)).filter((f) => f.endsWith(".npy")).sort();

  const takes = [];
  for (const file of files.slice(0, MAX_SAMPLES_PER_WORD)) {
    const path = join(dir, file);
    if ((await stat(path)).size < 1000) continue;
    let template;
    try {
      template = fileToTemplate(await readFile(path));
    } catch (err) {
      console.warn(`  skip ${entry.name}/${file}: ${err.message}`);
      skipped += 1;
      continue;
    }
    if (!template) {
      skipped += 1;
      continue;
    }
    takes.push({
      recordedAt: 0,
      frames: template.map((f) => Array.from(f, (v) => Number(v.toFixed(3)))),
    });
    kept += 1;
  }
  if (takes.length) words[label] = takes;
}

const out = { version: 1, frames: TEMPLATE_FRAMES, words };
await writeFile(outPath, JSON.stringify(out));
const bytes = (await stat(outPath)).size;

console.log(
  `\n${Object.keys(words).length} signs, ${kept} takes (${skipped} skipped) → ${outPath} ` +
    `(${(bytes / 1024).toFixed(0)} KB)`,
);
for (const [label, takes] of Object.entries(words)) {
  console.log(`  ${label.padEnd(14)} ${takes.length} takes`);
}
