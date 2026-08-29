/**
 * Perxona Connect Kit — Signer Demo · Semantic motion selection
 *
 * Picks a body motion that matches what the avatar is about to say.
 *
 * No model and no learning is involved, and none is needed: this app knows the
 * word before it speaks it. The recognized gloss *is* the semantics, so the
 * mapping is a lookup, not an inference — which also makes it deterministic and
 * debuggable, unlike anything that would guess intent back out of the finished
 * sentence.
 *
 * The platform already ships the other half. Motions in the catalog carry
 * `intent:` tags — 25 of them across the library (greeting, goodbye, apology,
 * agreement, thinking, confusion, explaining, celebration…) — plus a
 * `duration:` in milliseconds. What the platform does not do is apply them:
 * /connect/presentation returns an empty performance manifest for every
 * message, so nothing gets chosen unless the caller chooses it.
 *
 * The catch is that the tags are not on every avatar. Of 33 avatars, 6 carry
 * the full 25-intent layer and 18 carry none at all — so this module reports
 * what an avatar can actually express (see `describeIndex`) rather than
 * silently degrading to a shrug.
 */

/**
 * Gloss → how to gesture it.
 *
 * `rank` decides which sign in a sentence drives the gesture, and it is not
 * signing order. A question word or a negation changes the speech act of the
 * whole sentence, so "POTTY WHERE" is a question and should look like one —
 * asking where the bathroom is, not explaining what a bathroom is. Scanning in
 * signing order picked the noun and made the avatar lecture instead of ask.
 *
 * `intents` are tried in order against the avatar's own catalog. `namePattern`
 * is the fallback for meanings the library's 25 intents do not cover — there is
 * no "disagreement" or "negation" among them, though some avatars carry a
 * head-shake under `category:emotion`.
 *
 * These keys are ASL glosses and the intents are the platform's own English
 * tags, so the two line up directly — no translation step in between to lose
 * meaning in.
 */
const GESTURE_BY_GLOSS = new Map([
  // Rank 0 — rewrites the whole sentence's intent.
  ["no", { rank: 0, namePattern: /shaking head no|head shake/i }],
  ["where", { rank: 0, intents: ["confusion", "uncertainty", "thinking"] }],
  ["who", { rank: 0, intents: ["confusion", "uncertainty"] }],
  ["why", { rank: 0, intents: ["confusion", "thinking", "uncertainty"] }],

  // Rank 1 — set phrases that are the whole utterance and carry their own gesture.
  ["hello", { rank: 1, intents: ["greeting", "welcome"] }],
  ["bye", { rank: 1, intents: ["goodbye", "greeting"] }],
  ["thankyou", { rank: 1, intents: ["approval", "positive_confirmation", "celebration"] }],
  ["yes", { rank: 1, intents: ["agreement", "approval", "positive_confirmation"] }],

  // Rank 2 — content signs, used only when nothing above appears.
  ["please", { rank: 2, intents: ["offering_options", "sharing"] }],
  ["happy", { rank: 2, intents: ["celebration", "cheering", "encouragement"] }],
  ["sad", { rank: 2, intents: ["emphasis", "magnitude"] }],
  ["mad", { rank: 2, intents: ["emphasis", "contrast"] }],
  ["owie", { rank: 2, intents: ["emphasis", "magnitude"] }],
  ["sick", { rank: 2, intents: ["emphasis", "magnitude"] }],
  ["police", { rank: 2, intents: ["emphasis", "magnitude"] }],
  ["hungry", { rank: 2, intents: ["emphasis", "explaining"] }],
  ["thirsty", { rank: 2, intents: ["emphasis", "explaining"] }],
  ["sleepy", { rank: 2, intents: ["explaining", "elaboration"] }],
  ["hot", { rank: 2, intents: ["emphasis", "magnitude"] }],
  ["finish", { rank: 2, intents: ["positive_confirmation", "agreement"] }],
  ["wait", { rank: 2, intents: ["magnitude", "emphasis"] }],
  ["water", { rank: 2, intents: ["explaining", "sharing"] }],
  ["food", { rank: 2, intents: ["explaining", "sharing"] }],
  ["drink", { rank: 2, intents: ["explaining", "sharing"] }],
  ["potty", { rank: 2, intents: ["explaining", "sharing"] }],
  ["home", { rank: 2, intents: ["explaining", "sharing"] }],
  ["go", { rank: 2, intents: ["explaining", "elaboration"] }],
  ["mom", { rank: 2, intents: ["sharing", "explaining"] }],
  ["dad", { rank: 2, intents: ["sharing", "explaining"] }],
  ["callonphone", { rank: 2, intents: ["sharing", "confidential_sharing"] }],
]);

/**
 * Keywords scanned *inside* a label, for when the label is a phrase rather than
 * a single gloss.
 *
 * Recording "Goodbye. See you then." against one gesture is a legitimate way to
 * use this demo — arguably a better one than assembling a sentence sign by
 * sign, since it sidesteps both the grammar rules and the need to recognize
 * several signs in a row correctly. But an exact-match lookup finds nothing in
 * a phrase, so every phrase fell to the same generic talking gesture and the
 * avatar looked identical whether greeting someone or saying goodbye.
 */
const PHRASE_KEYWORDS = [
  { pattern: /\b(bye|goodbye|see you|see ya|later|farewell)\b/i, intents: ["goodbye", "greeting"] },
  { pattern: /\b(hi|hello|hey|good morning|good afternoon|what's up|whats up)\b/i, intents: ["greeting", "welcome"] },
  { pattern: /\b(thank you|thanks|thank)\b/i, intents: ["approval", "positive_confirmation", "celebration"] },
  { pattern: /\b(sorry|apologi[sz]e|my bad|excuse me)\b/i, intents: ["apology"] },
  { pattern: /\b(why|confus|don't understand|dont understand)\b/i, intents: ["confusion", "thinking"] },
  { pattern: /\b(where|who|what|how|when)\b/i, intents: ["confusion", "uncertainty", "thinking"] },
  { pattern: /\b(yes|yeah|sure|okay|ok|agree|of course)\b/i, intents: ["agreement", "approval"] },
  { pattern: /\b(no|not|don't|dont|never)\b/i, namePattern: /shaking head no|head shake/i },
  { pattern: /\b(help|please)\b/i, intents: ["sharing", "offering_options"] },
  { pattern: /\b(great|awesome|amazing|wonderful|congrat)\b/i, intents: ["celebration", "cheering"] },
  { pattern: /\b(wait|hold on|one moment)\b/i, intents: ["magnitude", "emphasis"] },
  { pattern: /\b(hurt|pain|sick|emergency|urgent)\b/i, intents: ["emphasis", "magnitude"] },
];

/**
 * Parse one catalog entry into the shape the picker wants.
 * @param {{motion_id: string, name: string, tags: string[]}} m
 */
function parseMotion(m) {
  const tags = m.tags ?? [];
  const tagged = (prefix) =>
    tags.filter((t) => t.startsWith(prefix)).map((t) => t.slice(prefix.length));
  const duration = Number(tagged("duration:")[0]);
  return {
    id: m.motion_id,
    name: m.name,
    intents: tagged("intent:"),
    categories: tagged("category:"),
    poses: tagged("pose:"),
    engines: tagged("engine:"),
    // Absent on many entries; Infinity so a motion of unknown length never wins
    // a "shortest match" contest against one we can actually measure.
    durationMs: Number.isFinite(duration) ? duration : Infinity,
  };
}

/**
 * @param {Array} items raw `GET /api/avatars/:id/motions` items
 */
export function buildMotionIndex(items = []) {
  const motions = items.map(parseMotion);
  const byIntent = new Map();
  for (const m of motions) {
    for (const intent of m.intents) {
      if (!byIntent.has(intent)) byIntent.set(intent, []);
      byIntent.get(intent).push(m);
    }
  }
  // Shortest first. Every motion in the library runs 3–9 seconds while a signed
  // sentence speaks in under two, so the pick is always the one that overstays
  // least — a gesture still going long after the voice stopped reads as a
  // freeze, not as expression.
  for (const list of byIntent.values()) list.sort((a, b) => a.durationMs - b.durationMs);

  const talking = motions
    .filter((m) => m.categories.includes("talking"))
    .sort((a, b) => a.durationMs - b.durationMs);

  return { motions, byIntent, talking };
}

/** What this avatar can actually express — for telling the user, not for logic. */
export function describeIndex(index) {
  return {
    total: index.motions.length,
    intents: [...index.byIntent.keys()].sort(),
    talking: index.talking.length,
    semantic: index.byIntent.size > 0,
  };
}

/**
 * Choose a motion for a sentence.
 *
 * @param {object} index from buildMotionIndex()
 * @param {string[]} glosses the recognized words, in signing order
 * @param {number} [rotation] cycles the fallback so consecutive sentences with
 *   no semantic match don't repeat one gesture
 * @returns {{id: string, name: string, why: string}|null}
 */
export function pickMotion(index, glosses, rotation = 0) {
  // Most salient word first, signing order breaking ties within a rank.
  const candidates = glosses
    .map((gloss, i) => ({ gloss, i, rule: GESTURE_BY_GLOSS.get(gloss) }))
    .filter((c) => c.rule)
    .sort((a, b) => a.rule.rank - b.rule.rank || a.i - b.i);

  for (const { gloss, rule } of candidates) {
    for (const intent of rule.intents ?? []) {
      const match = index.byIntent.get(intent)?.[0];
      if (match) return { id: match.id, name: match.name, why: `${gloss} → intent:${intent}` };
    }
    if (rule.namePattern) {
      const match = index.motions.find((m) => rule.namePattern.test(m.name));
      if (match) return { id: match.id, name: match.name, why: `${gloss} → name match` };
    }
  }

  // No exact gloss matched. The label may be a whole phrase, so look inside it.
  const text = glosses.join(" ");
  for (const rule of PHRASE_KEYWORDS) {
    if (!rule.pattern.test(text)) continue;
    for (const intent of rule.intents ?? []) {
      const match = index.byIntent.get(intent)?.[0];
      if (match) {
        return { id: match.id, name: match.name, why: `phrase ~ ${intent}` };
      }
    }
    if (rule.namePattern) {
      const match = index.motions.find((m) => rule.namePattern.test(m.name));
      if (match) return { id: match.id, name: match.name, why: "phrase ~ negation" };
    }
  }

  // Nothing semantic matched. A generic talking gesture still beats standing
  // frozen, which is what the avatar does when handed no motion at all.
  if (index.talking.length > 0) {
    const m = index.talking[rotation % index.talking.length];
    return { id: m.id, name: m.name, why: "fallback: category:talking" };
  }
  return null;
}
