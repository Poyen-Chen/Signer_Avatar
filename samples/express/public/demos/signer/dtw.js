/**
 * Perxona Connect Kit — Signer Demo · DTW nearest-neighbour classifier
 *
 * Why DTW and not a trained model: Taiwanese Sign Language has almost no public
 * dataset, so there is nothing to train on. DTW needs no training at all — it
 * compares a capture directly against a handful of examples the user recorded
 * themselves, and it absorbs the thing that makes naive frame-by-frame
 * comparison useless, namely that nobody makes the same sign at the same speed
 * twice.
 *
 * The trade is explicit: this recognizes ISOLATED signs, one at a time, from a
 * small vocabulary. Continuous signing — where signs blend into each other and
 * the word boundaries are not marked — is a different problem needing a
 * sequence model and the data this approach exists to avoid needing.
 */

/**
 * Fraction of the sequence length the warping path may stray from the diagonal
 * (a Sakoe-Chiba band). It bounds the cost, and more importantly it stops the
 * path from matching one long pause against an entire other sign — unbounded
 * DTW will happily do that and report a flatteringly small distance.
 */
const BAND_FRACTION = 0.25;

function euclidean(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

/**
 * Length-normalized DTW distance between two frame sequences.
 * @param {Float32Array[]} a
 * @param {Float32Array[]} b
 * @returns {number} mean per-step distance along the best warping path
 */
export function dtwDistance(a, b) {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return Infinity;

  const band = Math.max(Math.floor(Math.max(n, m) * BAND_FRACTION), Math.abs(n - m) + 1);

  // Two rolling rows rather than the full n×m matrix: the path itself is never
  // needed, only its cost.
  let prev = new Float64Array(m + 1).fill(Infinity);
  let curr = new Float64Array(m + 1).fill(Infinity);
  prev[0] = 0;

  for (let i = 1; i <= n; i += 1) {
    curr.fill(Infinity);
    const jStart = Math.max(1, i - band);
    const jEnd = Math.min(m, i + band);
    for (let j = jStart; j <= jEnd; j += 1) {
      const cost = euclidean(a[i - 1], b[j - 1]);
      const best = Math.min(prev[j], curr[j - 1], prev[j - 1]);
      curr[j] = cost + best;
    }
    const swap = prev;
    prev = curr;
    curr = swap;
  }

  // Divide by the path's rough length so long and short captures compare on the
  // same scale.
  return prev[m] / (n + m);
}

/**
 * Nearest-neighbour classification with two independent ways to say "I don't
 * know". Silence is the correct answer far more often than any word is, and a
 * classifier that always names its closest template will happily put random
 * hand-waving into the sentence the avatar is about to say out loud.
 *
 * @param {Float32Array[]} seq the capture, already resampled
 * @param {Array<{label: string, frames: Float32Array[]}>} templates
 * @param {{threshold?: number, marginRatio?: number}} [options]
 *   threshold   — reject outright above this distance (nothing looks like it)
 *   marginRatio — reject when the runner-up label is within this ratio of the
 *                 winner (two words look equally like it, so picking is a coin
 *                 flip)
 *
 * The defaults come from measuring both distributions on a synthetic signer:
 * two takes of the same word landed at 0.19–0.29 apart, two different words at
 * 0.22–1.02. Those overlap slightly, and they overlap exactly where you would
 * expect — on minimal pairs like 吃/喝, made in the same place with a similar
 * handshape and differing mainly in path. That is what marginRatio is for: the
 * threshold catches "this looks like nothing", the margin catches "this looks
 * equally like two things", and only the second of those describes a minimal
 * pair.
 * @returns {{label: string|null, distance: number, runnerUp: string|null,
 *            runnerUpDistance: number, reason: string|null,
 *            ranking: Array<{label: string, distance: number}>}}
 */
export function classify(seq, templates, { threshold = 0.45, marginRatio = 0.88 } = {}) {
  const empty = {
    label: null,
    distance: Infinity,
    runnerUp: null,
    runnerUpDistance: Infinity,
    reason: null,
    ranking: [],
  };
  if (seq.length === 0 || templates.length === 0) {
    return { ...empty, reason: "no-templates" };
  }

  // Best (smallest) distance per label — a word with five recorded samples must
  // not beat a word with two just by having more chances.
  const bestByLabel = new Map();
  for (const template of templates) {
    const d = dtwDistance(seq, template.frames);
    const prev = bestByLabel.get(template.label);
    if (prev === undefined || d < prev) bestByLabel.set(template.label, d);
  }

  const ranking = [...bestByLabel.entries()]
    .map(([label, distance]) => ({ label, distance }))
    .sort((x, y) => x.distance - y.distance);

  const winner = ranking[0];
  const runnerUp = ranking[1] ?? null;
  const result = {
    label: winner.label,
    distance: winner.distance,
    runnerUp: runnerUp?.label ?? null,
    runnerUpDistance: runnerUp?.distance ?? Infinity,
    reason: null,
    ranking,
  };

  if (winner.distance > threshold) {
    return { ...result, label: null, reason: "too-far" };
  }
  if (runnerUp && winner.distance / runnerUp.distance > marginRatio) {
    return { ...result, label: null, reason: "ambiguous" };
  }
  return result;
}
