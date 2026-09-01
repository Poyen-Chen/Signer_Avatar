/**
 * Perxona Connect Kit — Signer Demo · ASL gloss → spoken English
 *
 * ASL is not English on the hands. It is topic-comment, question words land at
 * the end, there is no copula and no articles, and verbs are not inflected —
 * so reading the recognized glosses out in signing order gives a hearing
 * listener something to decode rather than something to understand.
 * "POTTY WHERE" is a fluent question in ASL and a word salad in English.
 *
 * What is here is a small rule pass, not a translator — enough to make the
 * demo sound like speech instead of a word list. It is the obvious place to put
 * an LLM later (the kit's own /api/chat route, on your own key); it is kept as
 * rules for now so the whole pipeline stays free, offline and predictable.
 */

/**
 * How each sign becomes English.
 *
 * `kind` drives sentence construction, because the same gloss cannot be slotted
 * in blindly: a state needs a copula English requires and ASL omits ("HUNGRY" →
 * "I am hungry"), a noun needs an article ASL has none of, and a question word
 * has to move from the end of the ASL sentence to the front of the English one.
 */
const WORDS = new Map([
  // Set phrases — complete utterances on their own.
  ["hello", { kind: "phrase", text: "Hello" }],
  ["bye", { kind: "phrase", text: "Goodbye" }],
  ["thankyou", { kind: "phrase", text: "Thank you" }],
  ["yes", { kind: "phrase", text: "Yes" }],

  // Grammatical operators.
  ["no", { kind: "negation" }],
  ["please", { kind: "please" }],
  ["where", { kind: "wh", text: "Where" }],
  ["who", { kind: "wh", text: "Who" }],
  ["why", { kind: "wh", text: "Why" }],

  // States — English inserts "I am", ASL does not.
  ["hungry", { kind: "state", text: "hungry" }],
  ["thirsty", { kind: "state", text: "thirsty" }],
  ["sick", { kind: "state", text: "sick" }],
  ["owie", { kind: "state", text: "hurt" }],
  ["sleepy", { kind: "state", text: "tired" }],
  ["hot", { kind: "state", text: "hot" }],
  ["happy", { kind: "state", text: "happy" }],
  ["sad", { kind: "state", text: "sad" }],
  ["mad", { kind: "state", text: "angry" }],
  ["finish", { kind: "state", text: "finished" }],

  // Nouns, carrying the article and number English needs.
  ["water", { kind: "noun", text: "water", verb: "is" }],
  ["food", { kind: "noun", text: "food", verb: "is" }],
  ["potty", { kind: "noun", text: "the bathroom", verb: "is" }],
  ["home", { kind: "noun", text: "home", verb: "is" }],
  ["police", { kind: "noun", text: "the police", verb: "are" }],
  ["mom", { kind: "noun", text: "my mom", verb: "is" }],
  ["dad", { kind: "noun", text: "my dad", verb: "is" }],

  // Verbs.
  ["drink", { kind: "verb", text: "drink" }],
  ["go", { kind: "verb", text: "go" }],
  ["wait", { kind: "verb", text: "wait" }],
  ["callonphone", { kind: "verb", text: "call", transitive: true }],
]);

/**
 * Emotion hints per sign, fed to PresentOptions so the avatar's face matches
 * what it is saying. Only values PresentationEmotion accepts.
 */
const EMOTION_BY_GLOSS = new Map([
  ["thankyou", "gratitude"],
  ["hello", "joy"],
  ["bye", "caring"],
  ["happy", "joy"],
  ["sad", "sadness"],
  ["mad", "annoyance"],
  ["owie", "sadness"],
  ["sick", "sadness"],
  ["where", "curiosity"],
  ["who", "curiosity"],
  ["why", "confusion"],
  ["police", "excitement"],
]);

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Add a full stop only if the text does not already end in punctuation. */
function terminate(text) {
  return /[.?!]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`;
}

/**
 * Emotion keywords, scanned inside a label rather than matched against the
 * whole of it, so a recorded phrase like "Goodbye. See you then." still gets a
 * face to go with it.
 */
const EMOTION_KEYWORDS = [
  [/\b(thank|thanks|thank you)\b/i, "gratitude"],
  [/\b(hi|hello|hey|good morning)\b/i, "joy"],
  [/\b(bye|goodbye|see you|later)\b/i, "caring"],
  [/\b(sorry|apolog)/i, "embarrassment"],
  [/\b(happy|great|wonderful|glad)\b/i, "joy"],
  [/\b(sad|sorry to hear)\b/i, "sadness"],
  [/\b(hurt|pain|sick|help)\b/i, "sadness"],
  [/\b(where|who|what|how|when)\b/i, "curiosity"],
  [/\b(why|confus)/i, "confusion"],
  [/\b(wow|amazing|wtf)\b/i, "surprise"],
];

function emotionFromText(text) {
  return EMOTION_KEYWORDS.find(([re]) => re.test(text))?.[1];
}

/**
 * @param {string[]} glosses recognized signs, in the order they were signed
 * @param {{energy?: number}} [context] mean sign energy, used only for intensity
 * @returns {{text: string, emotion: string|undefined, intensity: string}}
 */
export function composeSentence(glosses, context = {}) {
  const signs = glosses.filter((g) => WORDS.has(g));
  const unknown = glosses.filter((g) => !WORDS.has(g));

  // Exact gloss first, then keywords inside the label, so both a single sign
  // and a recorded phrase get an expression.
  const emotion =
    glosses.map((g) => EMOTION_BY_GLOSS.get(g)).find(Boolean) ??
    emotionFromText(glosses.join(" "));
  const energy = context.energy ?? 0;
  const intensity = energy > 0.02 ? "high" : energy < 0.008 ? "low" : "neutral";
  const done = (text) => ({ text, emotion, intensity });

  if (signs.length === 0) {
    // A label the rules do not cover is still better spoken than swallowed — a
    // listener can work with "Toothbrush." where silence tells them nothing.
    //
    // The label may also be a whole phrase rather than a gloss. Recording
    // "Goodbye. See you then." against one gesture is a perfectly good way to
    // use this — arguably better than assembling a sentence word by word — so
    // punctuation it already carries is left alone rather than having another
    // period stapled on.
    return done(unknown.length ? terminate(capitalize(unknown.join(" "))) : "");
  }

  const by = (kind) => signs.filter((g) => WORDS.get(g).kind === kind);
  const first = (kind) => by(kind)[0];

  const wh = first("wh");
  const negation = by("negation").length > 0;
  const polite = by("please").length > 0;
  const state = first("state");
  const verb = first("verb");
  const noun = first("noun");
  const phrases = by("phrase");

  let core = "";

  if (wh) {
    // ASL puts the question word last; English puts it first.
    const w = WORDS.get(wh);
    if (noun) {
      const n = WORDS.get(noun);
      core = `${w.text} ${n.verb} ${n.text}?`;
    } else if (verb) {
      core = `${w.text} do I ${WORDS.get(verb).text}?`;
    } else {
      core = `${w.text}?`;
    }
  } else if (state) {
    core = `I am ${negation ? "not " : ""}${WORDS.get(state).text}.`;
  } else if (verb) {
    const v = WORDS.get(verb);
    const object = noun ? ` ${WORDS.get(noun).text}` : "";
    // "no" before a verb is a refusal, not a negated fact.
    core = negation ? `I don't want to ${v.text}${object}.` : `I want to ${v.text}${object}.`;
  } else if (noun) {
    core = negation ? `I don't want ${WORDS.get(noun).text}.` : `I need ${WORDS.get(noun).text}.`;
  } else if (negation) {
    core = "No.";
  }

  // "please" softens a request rather than standing alone.
  if (polite && core) {
    core = core.replace(/\.$/, ", please.").replace(/\?$/, ", please?");
  } else if (polite && !core) {
    core = "Please.";
  }

  const spoken = [...phrases.map((g) => WORDS.get(g).text), ...(core ? [core] : [])];
  let text = spoken
    .map((part, i) => (i < spoken.length - 1 && !/[.?!]$/.test(part) ? `${part}.` : part))
    .join(" ");
  text = text ? terminate(text) : text;

  // Anything the rules did not recognize is appended rather than dropped.
  if (unknown.length) text = `${text} ${terminate(capitalize(unknown.join(" ")))}`.trim();

  return done(text);
}
