/**
 * Perxona Connect Kit — Signer Demo · Sign segmentation
 *
 * Decides where one sign starts and stops, from the movement energy of the
 * hands alone. This is what lets the signer just sign, instead of pressing a
 * button before and after every word.
 *
 * It is a deliberately simple rule — signs are separated by a moment of
 * stillness — and that is exactly the assumption fluent continuous signing
 * breaks, since one sign flows straight into the next with no pause between
 * them. Within this demo's scope (isolated words, signed one at a time) it
 * holds; that boundary is the demo's, not a bug in the rule.
 */

import { frameDelta, handsPresent } from "./features.js";

export const SegmentState = {
  IDLE: "idle",
  ACTIVE: "active",
};

const DEFAULTS = {
  /** How far above the measured noise floor movement must rise to open a
   *  segment. A multiple, not an absolute energy: the floor depends on the
   *  camera, the lighting and how far away the signer is, and an absolute
   *  threshold tuned on one setup silently fails on the next. Measured on a
   *  synthetic take, the floor sat at 0.004–0.008 while still against
   *  0.015–0.021 mid-sign — a ratio that holds even when both numbers move. */
  startMultiple: 2.0,
  /** Where the segment closes, as a multiple of the same floor. Deliberately
   *  above 1.0 and close to startMultiple: with one threshold, energy hovering
   *  at the boundary flips the state every other frame and chops one sign into
   *  several — but set too far below, it lands under the noise floor, the
   *  energy never reaches it, and a segment that opens never closes at all.
   *  That failure mode is silent (no segments are ever emitted) which is why
   *  the gap here is narrow rather than the usual generous hysteresis. */
  stopMultiple: 1.65,
  /** Seed for the floor, used until enough idle frames have been seen. */
  initialFloor: 0.006,
  /** How fast the floor tracks. Slow, so that a sign held still mid-movement
   *  does not get absorbed into the floor. */
  floorAdapt: 0.05,
  /** Consecutive above-threshold frames needed to open a segment. */
  startFrames: 3,
  /** Consecutive still frames that close one. ~0.35s at 30fps — long enough to
   *  ride out the brief stillness at the turning point of a movement, short
   *  enough not to feel laggy. */
  stopFrames: 8,
  /** Shorter than this is a twitch, not a sign. */
  minFrames: 8,
  /** Longer than this is someone gesturing at their coffee. Force it closed
   *  rather than growing the buffer forever. */
  maxFrames: 150,
  /** Frames kept before the start trigger fires, so the run-up into the sign —
   *  which the trigger by definition only notices after it has begun — is not
   *  clipped off the front. */
  preRoll: 5,
  /** Smoothing applied to the feature vector before differencing it.
   *
   *  It has to happen here rather than on the energy number afterwards. Energy
   *  is a norm, so independent landmark jitter raises its floor by a positive
   *  amount that never averages back out — smoothing the energy afterwards
   *  smooths a signal whose floor has already been raised. Smoothing the
   *  vectors first attacks the jitter while it can still cancel.
   */
  vectorSmoothing: 0.35,
  /** A light smoothing pass on the energy number itself, on top of the above. */
  smoothing: 0.4,
  /** Frames without a hand visible that close an open segment. */
  handsLostFrames: 6,
};

export class Segmenter {
  /** @param {Partial<typeof DEFAULTS>} [options] */
  constructor(options = {}) {
    this.options = { ...DEFAULTS, ...options };
    this.reset();
  }

  reset() {
    this.state = SegmentState.IDLE;
    this.energy = 0;
    /** Running estimate of the energy of a hand that is not moving. */
    this.floor = this.options.initialFloor;
    /** EMA of the feature vector — the energy signal only, never the stored
     *  template, which keeps the unsmoothed detail DTW needs. */
    this.smoothed = null;
    this.previousSmoothed = null;
    this.buffer = [];
    this.preRollBuffer = [];
    this.aboveCount = 0;
    this.quietCount = 0;
    this.handsLostCount = 0;
  }

  /** The energy at which a segment opens, given the floor measured so far. */
  get startEnergy() {
    return this.floor * this.options.startMultiple;
  }

  get stopEnergy() {
    return this.floor * this.options.stopMultiple;
  }

  /** Live values for the UI meter. */
  get telemetry() {
    return {
      state: this.state,
      energy: this.energy,
      frames: this.buffer.length,
      floor: this.floor,
      startEnergy: this.startEnergy,
      stopEnergy: this.stopEnergy,
    };
  }

  /**
   * Feed one frame.
   * @param {Float32Array|null} vector from frameToVector(); null when the body
   *   was not visible
   * @param {object} result the raw holistic result, for hand presence
   * @returns {{frames: Float32Array[], reason: string}|null} a finished segment,
   *   or null if none ended on this frame
   */
  push(vector, result) {
    const o = this.options;

    if (!vector) {
      // No body, no normalization, no usable frame. An open segment ends rather
      // than resuming later with a hole in the middle of it.
      return this.state === SegmentState.ACTIVE ? this.#close("body-lost") : null;
    }

    if (this.smoothed === null) {
      this.smoothed = Float32Array.from(vector);
    } else {
      const a = o.vectorSmoothing;
      for (let i = 0; i < vector.length; i += 1) {
        this.smoothed[i] = this.smoothed[i] * (1 - a) + vector[i] * a;
      }
    }
    const raw = frameDelta(this.previousSmoothed, this.smoothed);
    this.energy = this.energy * (1 - o.smoothing) + raw * o.smoothing;
    // A copy, not a reference: this.smoothed is mutated in place every frame.
    this.previousSmoothed = Float32Array.from(this.smoothed);

    const hands = handsPresent(result);
    this.handsLostCount = hands ? 0 : this.handsLostCount + 1;

    if (this.state === SegmentState.IDLE) {
      this.preRollBuffer.push(vector);
      if (this.preRollBuffer.length > o.preRoll) this.preRollBuffer.shift();

      // Adapt the floor only while idle and only downward-ish: this is what a
      // still hand costs on this camera, at this distance, in this light.
      // Tracking it upward as well would let a slow drift raise the floor until
      // nothing ever triggers, so a rise is followed far more slowly than a fall.
      const adapt = this.energy < this.floor ? o.floorAdapt : o.floorAdapt * 0.1;
      this.floor = this.floor * (1 - adapt) + this.energy * adapt;

      if (hands && this.energy > this.startEnergy) {
        this.aboveCount += 1;
        if (this.aboveCount >= o.startFrames) {
          this.state = SegmentState.ACTIVE;
          this.buffer = [...this.preRollBuffer];
          this.preRollBuffer = [];
          this.quietCount = 0;
        }
      } else {
        this.aboveCount = 0;
      }
      return null;
    }

    // ACTIVE
    this.buffer.push(vector);

    if (this.handsLostCount >= o.handsLostFrames) return this.#close("hands-lost");
    if (this.buffer.length >= o.maxFrames) return this.#close("max-length");

    if (this.energy < this.stopEnergy) {
      this.quietCount += 1;
      if (this.quietCount >= o.stopFrames) return this.#close("still");
    } else {
      this.quietCount = 0;
    }
    return null;
  }

  #close(reason) {
    const o = this.options;
    // Drop the trailing stillness that triggered the close — it is the gap
    // after the sign, and leaving it in stretches the tail of every template.
    const trim = reason === "still" ? Math.max(this.quietCount - 2, 0) : 0;
    const frames = this.buffer.slice(0, Math.max(this.buffer.length - trim, 0));

    this.state = SegmentState.IDLE;
    this.buffer = [];
    this.preRollBuffer = [];
    this.aboveCount = 0;
    this.quietCount = 0;

    if (frames.length < o.minFrames) return null;
    return { frames, reason };
  }
}
