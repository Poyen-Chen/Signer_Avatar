/**
 * Perxona Connect Kit — Signer Demo · Vocabulary store
 *
 * Templates the user recorded, held in localStorage. They never leave the
 * device — no camera frame and no landmark is ever uploaded anywhere; the whole
 * recognition path runs in this tab.
 *
 * localStorage is a per-browser convenience, not durable storage: a cleared
 * site-data, a different browser or a private window all start empty. Recording
 * a vocabulary is half an hour of someone's time, so export() writes the same
 * data to a file and that is the copy worth keeping.
 */

const STORAGE_KEY = "perxona-signer-vocab-v1";

/** Every capture is stretched to this many frames before storage. See resample(). */
export const TEMPLATE_FRAMES = 32;

/** Beyond this, extra samples of the same word cost storage without adding much. */
export const MAX_SAMPLES_PER_WORD = 6;

/**
 * Decimal places kept per number. Three is well inside the noise floor of the
 * landmarks themselves and roughly halves the JSON against full float text —
 * which matters, because a 15-word vocabulary is already megabytes and
 * localStorage typically stops at five.
 */
const PRECISION = 3;

/**
 * A starter set, drawn from the 250-sign PopSign vocabulary used by Google's
 * Isolated Sign Language Recognition dataset — so anything recorded here stays
 * compatible with that data if the pre-trained model path (see asl.js) is ever
 * revived.
 *
 * Chosen for what someone actually needs to say to a hearing stranger: a
 * greeting, a thank-you, a yes and a no, and the handful of needs that are
 * urgent when you cannot say them — water, food, the toilet, pain, illness.
 */
export const SUGGESTED_WORDS = [
  "hello", "bye", "thankyou", "please", "yes", "no",
  "water", "drink", "food", "hungry", "thirsty",
  "sick", "owie", "sleepy", "hot", "potty",
  "happy", "sad", "mad", "wait", "finish",
  "where", "who", "why",
  "mom", "dad", "police", "callonphone", "home", "go",
];

/** @typedef {{label: string, frames: Float32Array[], recordedAt: number}} Template */

function reviveFrames(rows) {
  return rows.map((row) => Float32Array.from(row));
}

function serializeFrames(frames) {
  return frames.map((frame) =>
    Array.from(frame, (v) => Number(v.toFixed(PRECISION))),
  );
}

export class Vocabulary {
  constructor() {
    /** @type {Map<string, Template[]>} */
    this.words = new Map();
  }

  /** @returns {string[]} labels, in insertion order */
  labels() {
    return [...this.words.keys()];
  }

  samples(label) {
    return this.words.get(label) ?? [];
  }

  /** Total recorded samples across every word. */
  size() {
    let n = 0;
    for (const list of this.words.values()) n += list.length;
    return n;
  }

  /** Flat list for the classifier. */
  templates() {
    const out = [];
    for (const [label, list] of this.words) {
      for (const t of list) out.push({ label, frames: t.frames });
    }
    return out;
  }

  /**
   * @param {string} label
   * @param {Float32Array[]} frames already resampled to TEMPLATE_FRAMES
   * @returns {{ok: boolean, count: number, dropped: boolean}} dropped is true
   *   when the oldest sample was evicted to stay under the per-word cap
   */
  add(label, frames) {
    const list = this.words.get(label) ?? [];
    list.push({ label, frames, recordedAt: Date.now() });
    let dropped = false;
    while (list.length > MAX_SAMPLES_PER_WORD) {
      list.shift();
      dropped = true;
    }
    this.words.set(label, list);
    return { ok: true, count: list.length, dropped };
  }

  removeSample(label, index) {
    const list = this.words.get(label);
    if (!list || index < 0 || index >= list.length) return false;
    list.splice(index, 1);
    if (list.length === 0) this.words.delete(label);
    return true;
  }

  removeWord(label) {
    return this.words.delete(label);
  }

  toJSON() {
    return {
      version: 1,
      frames: TEMPLATE_FRAMES,
      words: Object.fromEntries(
        [...this.words].map(([label, list]) => [
          label,
          list.map((t) => ({ recordedAt: t.recordedAt, frames: serializeFrames(t.frames) })),
        ]),
      ),
    };
  }

  /**
   * @param {object} data
   * @returns {Vocabulary}
   * @throws {Error} when the file is not a vocabulary, or was recorded with a
   *   different frame count — its templates would silently misalign against the
   *   current ones rather than fail, which is worse than refusing to load.
   */
  static fromJSON(data) {
    if (!data || typeof data !== "object" || !data.words) {
      throw new Error("Not a signer vocabulary file");
    }
    if (data.frames && data.frames !== TEMPLATE_FRAMES) {
      throw new Error(
        `Vocabulary was recorded at ${data.frames} frames per sign; this build uses ${TEMPLATE_FRAMES}`,
      );
    }
    const vocab = new Vocabulary();
    for (const [label, list] of Object.entries(data.words)) {
      vocab.words.set(
        label,
        list.map((t) => ({
          label,
          recordedAt: t.recordedAt ?? 0,
          frames: reviveFrames(t.frames),
        })),
      );
    }
    return vocab;
  }

  /**
   * @returns {{ok: boolean, error?: string}} a full store is reported, not
   *   thrown past: the recording just made is still in memory and still usable
   *   this session, and the honest fix is to export and prune rather than to
   *   lose the take.
   */
  save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.toJSON()));
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error:
          err?.name === "QuotaExceededError"
            ? "Browser storage is full — export the vocabulary to a file, then delete some samples."
            : `Could not save: ${err?.message ?? err}`,
      };
    }
  }

  static load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return new Vocabulary();
      return Vocabulary.fromJSON(JSON.parse(raw));
    } catch {
      // A vocabulary that will not parse is not worth blocking startup over;
      // the export file is the real backup.
      return new Vocabulary();
    }
  }

  static clearStored() {
    localStorage.removeItem(STORAGE_KEY);
  }
}
