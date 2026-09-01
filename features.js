/**
 * Perxona Connect Kit — Signer Demo · Feature extraction
 *
 * Turns one HolisticLandmarkerResult frame into a fixed-length numeric vector
 * that DTW can compare across people, distances and camera setups.
 *
 * The four classic sign parameters map onto the layout like this:
 *   handshape   → the 20 finger landmarks, re-anchored at the wrist and scaled
 *                 by hand size, so a small hand far away matches a big hand up
 *                 close
 *   orientation → implicit in those same re-anchored landmarks (no rotation is
 *                 removed on purpose — palm-up and palm-down must not match)
 *   location    → the wrist, relative to the shoulder midpoint and scaled by
 *                 shoulder width, so "at the chin" stays "at the chin"
 *   movement    → left to DTW, which sees the whole sequence of these vectors
 *
 * Everything is body-relative: no absolute image coordinates survive, so the
 * signer can move around the frame between recording and recognition.
 */

// MediaPipe pose landmark indices we rely on.
const POSE_LEFT_SHOULDER = 11;
const POSE_RIGHT_SHOULDER = 12;

// Hand landmark indices: 0 is the wrist, 9 the middle-finger MCP knuckle. The
// wrist→MCP span is the most stable "size of this hand" measure available —
// unlike fingertips it barely moves as the hand opens and closes.
const HAND_WRIST = 0;
const HAND_MIDDLE_MCP = 9;

/** Landmarks per hand, and how many survive into the vector (the wrist is the anchor, so it drops out). */
const HAND_POINTS = 21;
const SHAPE_POINTS = HAND_POINTS - 1;

/** 1 presence flag + 3 location + 20×3 shape. */
export const PER_HAND_DIMS = 1 + 3 + SHAPE_POINTS * 3;
/** Left hand then right hand. */
export const FEATURE_DIMS = PER_HAND_DIMS * 2;

// Block weights, applied here rather than inside DTW so the distance stays a
// plain euclidean one.
//
// Each block is first divided by the square root of its own dimension count.
// Without that the weights would not mean what they say: shape has 60 numbers
// per hand against location's 3, and a euclidean distance sums squares, so
// shape would contribute twenty times its share no matter what weight was
// written here. Measured on real vectors before this normalization, moving a
// hand from the chest to the waist scored *four times smaller* than changing
// the handshape in place — location, one of the four things that distinguish
// one sign from another, was effectively being ignored.
//
// After the normalization a full handshape change and a full location change
// come out at roughly 1.0 and 0.68, which is the intended balance: handshape
// carries a little more, but a sign made in the wrong place no longer matches.
const LOCATION_WEIGHT = 1.5 / Math.sqrt(3);
const SHAPE_WEIGHT = 1.0 / Math.sqrt(SHAPE_POINTS * 3);
// MediaPipe's z is a rough relative depth from a single camera. It carries real
// information (front/back of the signing space) but is far noisier than x/y.
const Z_WEIGHT = 0.4;

/**
 * Scale factor that makes x comparable to y. Normalized landmarks are in image
 * space [0,1] on both axes, so on a 16:9 frame one unit of x is a much longer
 * real-world distance than one unit of y. Without this, horizontal movement
 * counts for less than vertical movement of the same size.
 */
function aspectOf(video) {
  const w = video?.videoWidth ?? 0;
  const h = video?.videoHeight ?? 0;
  return h > 0 ? w / h : 1;
}

function distance2d(a, b, aspect) {
  const dx = (a.x - b.x) * aspect;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy);
}

/**
 * Write one hand's slice into `out` at `offset`.
 * An absent hand leaves the slice at zero — which is meaningful, not missing
 * data: a one-handed sign and a two-handed one should not match each other.
 */
function writeHand(out, offset, hand, anchor, shoulderSpan, aspect) {
  if (!hand || hand.length < HAND_POINTS || !anchor) return;

  const wrist = hand[HAND_WRIST];
  out[offset] = 1; // present

  // Location — where the hand is on the body, in shoulder-widths.
  out[offset + 1] = (((wrist.x - anchor.x) * aspect) / shoulderSpan) * LOCATION_WEIGHT;
  out[offset + 2] = ((wrist.y - anchor.y) / shoulderSpan) * LOCATION_WEIGHT;
  out[offset + 3] =
    (((wrist.z ?? 0) - (anchor.z ?? 0)) / shoulderSpan) * LOCATION_WEIGHT * Z_WEIGHT;

  // Shape — the fingers, re-anchored at the wrist and scaled by hand size, so
  // this slice says nothing about where the hand is, only how it is held.
  const handSpan = Math.max(distance2d(wrist, hand[HAND_MIDDLE_MCP], aspect), 1e-4);
  let i = offset + 4;
  for (let p = 1; p < HAND_POINTS; p += 1) {
    const lm = hand[p];
    out[i] = (((lm.x - wrist.x) * aspect) / handSpan) * SHAPE_WEIGHT;
    out[i + 1] = ((lm.y - wrist.y) / handSpan) * SHAPE_WEIGHT;
    out[i + 2] = (((lm.z ?? 0) - (wrist.z ?? 0)) / handSpan) * SHAPE_WEIGHT * Z_WEIGHT;
    i += 3;
  }
}

/**
 * Build the frame vector.
 * @param {object} result HolisticLandmarkerResult for one frame
 * @param {HTMLVideoElement} video source, for its aspect ratio
 * @returns {Float32Array|null} null when no torso is visible — there is no body
 *   to be relative to, so the frame cannot be normalized and is better dropped
 *   than guessed at.
 */
export function frameToVector(result, video) {
  const pose = result?.poseLandmarks?.[0];
  if (!pose) return null;

  const ls = pose[POSE_LEFT_SHOULDER];
  const rs = pose[POSE_RIGHT_SHOULDER];
  if (!ls || !rs) return null;

  const aspect = aspectOf(video);
  const shoulderSpan = Math.max(distance2d(ls, rs, aspect), 1e-3);
  const anchor = {
    x: (ls.x + rs.x) / 2,
    y: (ls.y + rs.y) / 2,
    z: ((ls.z ?? 0) + (rs.z ?? 0)) / 2,
  };

  const out = new Float32Array(FEATURE_DIMS);
  writeHand(out, 0, result.leftHandLandmarks?.[0], anchor, shoulderSpan, aspect);
  writeHand(out, PER_HAND_DIMS, result.rightHandLandmarks?.[0], anchor, shoulderSpan, aspect);
  return out;
}

/** Whether either hand was detected in this frame. */
export function handsPresent(result) {
  return Boolean(result?.leftHandLandmarks?.[0] || result?.rightHandLandmarks?.[0]);
}

/**
 * Movement energy between two frame vectors — the signal the segmenter
 * thresholds on to find where one sign starts and stops.
 *
 * The two blocks are measured differently, and the difference is the whole
 * point. Location is a plain 3-dimensional norm: it is where the hand is, and
 * all three numbers matter together. Shape is a root-mean-square, not a norm,
 * across its 60 numbers.
 *
 * Why RMS there: a norm grows with the square root of however many dimensions
 * it spans, so independent landmark jitter in 60 numbers accumulates into a
 * floor √60 ≈ 8× larger than the jitter in any one of them — while a hand
 * travelling with the fingers held still moves only the 3 location numbers.
 * Measured with a plain norm over all 63, a still hand scored 0.15 against a
 * mid-sign 0.19: a signal-to-noise ratio of 1.3, which no threshold can split.
 * RMS divides that accumulation back out, so the shape term reports the typical
 * per-landmark change and stays flat as dimensions are added.
 *
 * Presence flags are excluded, and a hand missing from either frame is skipped
 * entirely, so a hand entering the frame is not itself a burst of movement.
 */
const SHAPE_ENERGY_WEIGHT = 0.6;

export function frameDelta(a, b) {
  if (!a || !b) return 0;
  let sum = 0;
  let hands = 0;
  for (let hand = 0; hand < 2; hand += 1) {
    const base = hand * PER_HAND_DIMS;
    // Both frames must have the hand for a delta to mean anything.
    if (a[base] === 0 || b[base] === 0) continue;

    let locSquare = 0;
    for (let i = base + 1; i <= base + 3; i += 1) {
      const d = a[i] - b[i];
      locSquare += d * d;
    }

    let shapeSquare = 0;
    for (let i = base + 4; i < base + PER_HAND_DIMS; i += 1) {
      const d = a[i] - b[i];
      shapeSquare += d * d;
    }

    sum +=
      Math.sqrt(locSquare) +
      SHAPE_ENERGY_WEIGHT * Math.sqrt(shapeSquare / (SHAPE_POINTS * 3));
    hands += 1;
  }
  // Averaged, not summed: a two-handed sign should not read as twice the
  // movement of a one-handed one at the same speed.
  return hands === 0 ? 0 : sum / hands;
}

/**
 * Resample a variable-length capture to a fixed frame count by linear
 * interpolation. Two things depend on this: storage stays bounded, and DTW's
 * cost drops to a constant per comparison instead of growing with how slowly
 * the sign was made. DTW still absorbs the *within*-sign timing differences
 * this uniform stretch cannot.
 * @param {Float32Array[]} seq
 * @param {number} length
 * @returns {Float32Array[]}
 */
export function resample(seq, length) {
  if (seq.length === 0) return [];
  if (seq.length === 1) return Array.from({ length }, () => seq[0].slice());

  const out = [];
  const dims = seq[0].length;
  for (let i = 0; i < length; i += 1) {
    const pos = (i * (seq.length - 1)) / (length - 1);
    const lo = Math.floor(pos);
    const hi = Math.min(lo + 1, seq.length - 1);
    const t = pos - lo;
    const frame = new Float32Array(dims);
    for (let d = 0; d < dims; d += 1) {
      frame[d] = seq[lo][d] * (1 - t) + seq[hi][d] * t;
    }
    out.push(frame);
  }
  return out;
}
