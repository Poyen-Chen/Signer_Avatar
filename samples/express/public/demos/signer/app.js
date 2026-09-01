/**
 * Perxona Connect Kit — Signer Demo
 *
 * Sign language in, speech out. A Deaf signer signs to the camera; the browser
 * recognizes the words on-device; the Perxona avatar says the sentence aloud to
 * a hearing listener.
 *
 * Note which direction this runs. Connect's presenter has no per-bone,
 * blendshape or custom-motion API — playMotion() plays entries from a fixed
 * catalog — so it cannot be made to sign. What it is very good at is the other
 * half of the conversation: giving a signer a face and a voice. That is the
 * whole design here. Recognition is ours and stays on the device; speech and
 * presence are Connect's.
 *
 *   camera → HolisticLandmarker → features.js → segment.js → dtw.js
 *          → sentence.js → presenter.present()
 *
 * Zero build step, plain ESM, matching the other demos in this kit.
 */

import { frameToVector, resample, handsPresent } from "./features.js";
import { Segmenter, SegmentState } from "./segment.js";
import { classify } from "./dtw.js";
import { Vocabulary, TEMPLATE_FRAMES, MAX_SAMPLES_PER_WORD, SUGGESTED_WORDS } from "./vocab.js";
import { composeSentence } from "./sentence.js";
import { buildMotionIndex, pickMotion, describeIndex } from "./motions.js";

/**
 * Where this page's assets and API live.
 *
 * Two deployments share this file. The Express sample serves it at
 * /demos/signer/ with /vendor, /models and /api at the site root. The static
 * build (scripts/build-static-site.mjs) has no server at all: it publishes the
 * page at the root of a GitHub Pages site, reads the catalog from JSON baked in
 * at build time, and pulls the vision bundle and model from a CDN. index.html
 * is what declares which of the two this is.
 */
const STATIC = globalThis.SIGNER_STATIC ?? null;

const VISION_BUNDLE = STATIC?.visionBundle ?? "/vendor/tasks-vision/vision_bundle.mjs";
const WASM_BASE = STATIC?.wasmBase ?? "/vendor/tasks-vision/wasm";
const MODEL_URL = STATIC?.modelUrl ?? "/models/holistic_landmarker.task";

// Dynamic, because the URL is only known once STATIC has been read. This module
// already awaits at the top level for the app config, so nothing is lost.
const { FilesetResolver, HolisticLandmarker, DrawingUtils } = await import(VISION_BUNDLE);

const AUTOSPEAK_DELAY_MS = 1500;
/** Recognition needs at least this many samples of at least this many words to
 *  mean anything; below it, the classifier's nearest neighbour is noise. */
const MIN_WORDS_TO_RECOGNIZE = 2;

// ── DOM ──────────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

const video = $("video");
const overlay = $("overlay");
const cameraPlaceholder = $("camera-placeholder");
const cameraBtn = $("camera-btn");
const captureBadge = $("capture-badge");
const energyFill = $("energy-fill");
const energyThreshold = $("energy-threshold");
const fpsLabel = $("fps");
const sensitivity = $("sensitivity");
const sensitivityOut = $("sensitivity-out");

const presenter = document.querySelector("sv-presenter");
const presenterPlaceholder = $("presenter-placeholder");
const avatarSelect = $("avatar-select");
const sceneSelect = $("scene-select");
const voiceSelect = $("voice-select");
const initBtn = $("init-btn");
const statusMsg = $("status-msg");

const modeRecognize = $("mode-recognize");
const modeRecord = $("mode-record");
const recognizePanel = $("recognize-panel");
const recordPanel = $("record-panel");

const glossStrip = $("gloss-strip");
const sentencePreview = $("sentence-preview");
const speakBtn = $("speak-btn");
const clearGlossBtn = $("clear-gloss-btn");
const autospeak = $("autospeak");
const autospeakDelay = $("autospeak-delay");
const recognitionLog = $("recognition-log");
const vocabSummary = $("vocab-summary");
const motionNote = $("motion-note");
const demoPhrases = $("demo-phrases");

const wordInput = $("word-input");
const suggestedWords = $("suggested-words");
const armBtn = $("arm-btn");
const recordHint = $("record-hint");
const wordList = $("word-list");
const exportBtn = $("export-btn");
const importBtn = $("import-btn");
const importFile = $("import-file");
const clearVocabBtn = $("clear-vocab-btn");

// ── State ────────────────────────────────────────────────────────────────

const state = {
  mode: "recognize",
  /** Set once the camera and the landmarker are both live. */
  tracking: false,
  /** Record mode: the next completed segment is stored instead of classified. */
  armed: false,
  presenterReady: false,
  isLaunching: false,
  isSpeaking: false,
  /** Recognized words waiting to be spoken. */
  glosses: [],
  /** Mean segment energy, carried into the sentence's intensity. */
  lastEnergy: 0,
  autospeakTimer: null,
  /** Held so the camera can be released — see the pagehide handler. */
  stream: null,
  /** The chosen avatar's motion catalog, indexed by intent — see motions.js. */
  motionIndex: null,
  motionCursor: 0,
};

const vocab = Vocabulary.load();
const segmenter = new Segmenter();
let landmarker = null;
let drawing = null;

function setStatus(text, kind = "") {
  statusMsg.textContent = text;
  statusMsg.className = `status${kind ? ` is-${kind}` : ""}`;
}

/**
 * <sv-presenter>'s connectedCallback() sets `this.style.display = "block"` as
 * an inline style and never reads `hidden` back. An inline style beats the UA
 * stylesheet's `[hidden] { display: none }` whatever the specificity, so
 * `el.hidden = true` is simply a no-op on this element — the avatar stays
 * visible over the placeholder. Setting display directly is the way to hide it,
 * and touches only that one property, leaving the width/height/position the
 * element also sets inline alone.
 */
function hidePresenter(hide) {
  presenter.style.display = hide ? "none" : "block";
}

// ── Presenter engine bootstrap ───────────────────────────────────────────

async function loadPresenterEngine(presenterUrl) {
  // DEMO-ONLY, matching the other demos: presenterUrl is trusted without host
  // validation. A production integration should check it against an allowlist.
  await new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.type = "module";
    script.src = presenterUrl;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Failed to load presenter engine from ${presenterUrl}`));
    document.head.append(script);
  });
}

const appConfig = await request("/api/config");
let presenterEngineReady = false;

/**
 * Map a server API route onto the file the static build baked for it.
 * `/api/avatars/cc069.../motions` → `api/motions/cc069....json`, everything
 * else → `api/<name>.json`. Relative, because a project site is served from a
 * subpath (…/Signer_Avatar/) where an absolute /api/… would miss.
 */
function staticApiPath(path) {
  const motions = path.match(/^\/api\/avatars\/([^/]+)\/motions$/);
  return motions ? `api/motions/${motions[1]}.json` : `api/${path.replace(/^\/api\//, "")}.json`;
}

/** Shared fetch wrapper — same contract as the studio demo's. */
async function request(path, { method = "GET", body } = {}) {
  if (STATIC) path = new URL(staticApiPath(path), document.baseURI).href;
  const res = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const message =
      (Array.isArray(data.detail) ? data.detail[0]?.msg : data.detail) ??
      data.details ??
      data.error ??
      res.statusText;
    throw Object.assign(new Error(message), { status: res.status, data });
  }
  if (res.status === 204) return null;
  return res.json();
}

// ── Catalog + launch ─────────────────────────────────────────────────────

/**
 * @param {RegExp} [prefer] pick the first item whose name matches, instead of
 *   simply the first item in the catalog. The catalog order is arbitrary and
 *   the defaults it lands on are actively bad for this demo — the first avatar
 *   has 6 motions and no semantic tags, and the first voice turned out to be a
 *   French multilingual model reading English.
 */
function fillSelect(select, items, emptyLabel, prefer) {
  select.replaceChildren(
    Object.assign(document.createElement("option"), { value: "", textContent: emptyLabel }),
    ...items.map((item) => {
      const opt = document.createElement("option");
      opt.value = item.id;
      opt.textContent = item.name;
      return opt;
    }),
  );
  const preferred = prefer && items.find((item) => prefer.test(item.name));
  select.value = (preferred ?? items[0])?.id ?? "";
}

// The cc069 and cc076 avatar families are the ones carrying the full 25-intent
// motion layer — 6 of the 33 avatars have it and 18 have none at all, so
// landing on one by luck is unlikely. See motions.js.
const PREFERRED_AVATAR = /^cc069|^cc076/;
// Voices are not tagged with a language, only named, and several are explicitly
// scoped to Chinese or Japanese. Match the ones that say English.
const PREFERRED_VOICE = /english/i;

function updateInitBtn() {
  initBtn.disabled =
    appConfig.mock ||
    !presenterEngineReady ||
    !avatarSelect.value ||
    !sceneSelect.value ||
    state.isLaunching;
}

async function loadCatalog() {
  try {
    const [avatars, scenes, voices] = await Promise.all([
      request("/api/avatars"),
      request("/api/scenes"),
      request("/api/voices"),
    ]);
    fillSelect(avatarSelect, avatars.items ?? [], "Choose an avatar", PREFERRED_AVATAR);
    fillSelect(sceneSelect, scenes.items ?? [], "Choose a scene");
    fillSelect(voiceSelect, voices.items ?? [], "No built-in voice", PREFERRED_VOICE);
    updateInitBtn();
    // Report what the preselected avatar can express straight away. Selecting a
    // value from script fires no change event, so without this the capability
    // note stays blank until the reader touches the picker — which is exactly
    // when they would already have chosen blind.
    if (avatarSelect.value) await loadMotionIndex(avatarSelect.value);
  } catch (err) {
    setStatus(`Could not load catalog: ${err.message}`, "error");
  }
}

/**
 * Load and index the chosen avatar's motions.
 *
 * The platform documents a Motion Director that reads the text and picks a
 * matching body motion automatically. It picks nothing: posting to
 * /connect/presentation returns `performance_manifest: {}` and
 * `posture_style: null` for every message tried — short, long, with `emotion`,
 * with `intensity`. The same request with an explicit `[MOTION <id>:1]` cue
 * comes back with the motion resolved, so the machinery works and only the
 * automatic selection is inert. `emotion` still drives the face; it just never
 * moves the body. Left alone the avatar stands perfectly still and lip-syncs,
 * which reads as broken next to someone who has just signed a sentence.
 */
async function loadMotionIndex(avatarId) {
  try {
    const page = await request(`/api/avatars/${encodeURIComponent(avatarId)}/motions`);
    state.motionIndex = buildMotionIndex(page.items ?? []);
    state.motionCursor = 0;
    reportMotionCapability();
  } catch {
    // A missing catalog costs a gesture, not the sentence. Speech is the point;
    // going silent because the avatar cannot wave would be the worse failure.
    state.motionIndex = null;
    motionNote.textContent = "";
  }
}

/**
 * Say what this avatar can actually express. Only 6 of the 33 avatars in the
 * catalog carry the `intent:` tags this mapping runs on and 18 carry none, so
 * an avatar picked for its looks will silently gesture generically forever.
 * That is worth one line on screen rather than a mystery.
 */
function reportMotionCapability() {
  const info = describeIndex(state.motionIndex);
  motionNote.textContent = info.semantic
    ? `This avatar has ${info.intents.length} semantic gestures and will match them to meaning.`
    : `This avatar has no semantic motion tags (only ${info.talking} generic talking gestures) — gestures will not match meaning.`;
  motionNote.classList.toggle("is-warn", !info.semantic);
}

const STATUS_LABELS = { Uninitialized: "", Initializing: "Initializing avatar\u2026", Ready: "\u2713 Avatar ready" };

presenter.addEventListener("PRESENTER_STATUS", (e) => {
  const { status } = e.detail;
  setStatus(STATUS_LABELS[status] ?? status, status === "Ready" ? "ok" : "");
  if (status !== "Ready") {
    // A re-initialization (an avatar or scene switch) has begun. Hide the old
    // scene rather than leaving it lit and alone during the gap.
    if (state.presenterReady) {
      state.presenterReady = false;
      hidePresenter(true);
      presenterPlaceholder.hidden = false;
      updateSpeakBtn();
    }
    return;
  }
  state.presenterReady = true;
  state.isLaunching = false;
  presenterPlaceholder.hidden = true;
  hidePresenter(false);
  // The default 90° vertical FOV frames the avatar far too tightly for a
  // half-screen stage.
  presenter.updateCameraFOV?.({ distance: 1, vertical: 0, horizontal: 4.5 });
  // The presenter scales its canvas from a ResizeObserver. On first launch,
  // 0x0 → visible is itself a resize and fires it; on a re-launch the element
  // is already visible at the same size, so nothing fires and the canvas keeps
  // a stale scale. Nudge the width by a pixel and back in two separate tasks,
  // so the observer is guaranteed to see a change between them.
  //
  // setTimeout, not the nested requestAnimationFrame this is adapted from: by
  // the time Ready fires the presenter is already rendering, and its Cocos
  // renderer starves rAF to a standstill — the nudge would simply never run.
  setTimeout(() => {
    presenter.style.width = "calc(100% - 1px)";
    setTimeout(() => {
      presenter.style.width = "100%";
    }, 32);
  }, 0);
  updateInitBtn();
  updateSpeakBtn();
  void loadMotionIndex(avatarSelect.value);
  // Tell the avatar someone is signing to it, so it waits attentively instead
  // of idling as if nothing were happening.
  if (state.tracking) presenter.setListening?.(true);
});

// A refused key has no refresh path — it is revoked, expired, or was never
// granted the scope. The call that triggered this already failed; the key has
// to be fixed and the presenter launched again.
presenter.addEventListener("CONNECT_KEY_REJECTED", () => {
  state.presenterReady = false;
  state.isLaunching = false;
  setStatus("Connect key rejected — revoked, expired, or missing a scope. Check PERXONA_CONNECT_PUBLISHABLE_KEY.", "error");
  updateInitBtn();
  updateSpeakBtn();
});

presenter.addEventListener("ALL_PERFORMANCE_FINISHED", () => {
  state.isSpeaking = false;
  presenter.setThinking?.(false);
  if (state.tracking) presenter.setListening?.(true);
  updateSpeakBtn();
});

/**
 * Bring the avatar up with whatever the pickers currently hold.
 *
 * Called from the Launch button and, on the public build, straight after the
 * catalog loads: a visitor who has to press a button before there is any avatar
 * on screen has no way to tell the page apart from a broken one. Audio is the
 * reason the button still exists — see resumeAudioPlayback below.
 */
async function launchAvatar() {
  if (appConfig.mock) {
    setStatus("Mock mode has no upstream credentials — the avatar cannot launch.", "warn");
    return;
  }
  state.isLaunching = true;
  updateInitBtn();
  setStatus("Fetching connect key\u2026");
  try {
    // Must run inside the click itself — browser autoplay policy only unlocks
    // audio from a direct user gesture, and an await before this would put it
    // outside that gesture. On the auto-launch path there is no gesture to be
    // inside of, which is why every demo phrase button unlocks audio again.
    await presenter.resumeAudioPlayback?.();
    const { connect_key } = await request("/api/connect-key");
    setStatus("Initializing\u2026");
    await presenter.initializeWithConnectKey(connect_key, {
      avatarId: avatarSelect.value,
      sceneId: sceneSelect.value,
      voiceId: voiceSelect.value || undefined,
    });
    // PRESENTER_STATUS drives the label from here.
  } catch (err) {
    setStatus(`Launch failed: ${err.message}`, "error");
    state.isLaunching = false;
    updateInitBtn();
  }
}

initBtn.addEventListener("click", launchAvatar);

for (const select of [avatarSelect, sceneSelect, voiceSelect]) {
  select.addEventListener("change", updateInitBtn);
}
// The motion catalog is per-avatar and differs enormously between them, so it
// is worth reporting before launch, not only after.
avatarSelect.addEventListener("change", () => {
  if (avatarSelect.value) void loadMotionIndex(avatarSelect.value);
});

// ── Vision bootstrap ─────────────────────────────────────────────────────

async function startTracking() {
  cameraBtn.disabled = true;
  try {
    setStatus("Loading recognition model\u2026");
    const fileset = await FilesetResolver.forVisionTasks(WASM_BASE);
    landmarker = await HolisticLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
      runningMode: "VIDEO",
    });

    // getUserMedia does not settle until the permission prompt is answered, so
    // say so — otherwise a reader who missed the dialog sees "Starting camera"
    // forever with a disabled button and no hint that the browser is waiting
    // on them.
    setStatus("Starting camera\u2014 allow camera access when the browser asks.");
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
      audio: false,
    });
    state.stream = stream;
    video.srcObject = stream;
    await video.play();

    overlay.width = video.videoWidth;
    overlay.height = video.videoHeight;
    drawing = new DrawingUtils(overlay.getContext("2d"));

    cameraPlaceholder.hidden = true;
    state.tracking = true;
    if (state.presenterReady) presenter.setListening?.(true);
    setStatus("Watching for gestures", "ok");
    startRenderLoop();
  } catch (err) {
    cameraBtn.disabled = false;
    // Distinguishing these matters: a denied permission is fixed in the
    // browser's own UI, a missing model is fixed on disk, and telling the
    // reader "camera failed" for both sends them to the wrong place.
    const reason =
      err?.name === "NotAllowedError"
        ? "Camera permission denied — re-allow it from the padlock menu in the address bar."
        : err?.name === "NotFoundError"
          ? "No camera found."
          : `Could not start recognition: ${err.message}`;
    setStatus(reason, "error");
  }
}

cameraBtn.addEventListener("click", startTracking);

// Release the camera when leaving the page. Without this the tracks stay live
// in the discarded document, the indicator light stays on, and the next load's
// getUserMedia can block behind the stream this page never gave back.
addEventListener("pagehide", () => {
  state.tracking = false;
  state.stream?.getTracks().forEach((track) => track.stop());
  state.stream = null;
});

// ── Render loop ──────────────────────────────────────────────────────────

let lastVideoTime = -1;
let frameCount = 0;
let fpsClock = performance.now();

/**
 * Drive the loop from the camera, not from the page's animation frames.
 *
 * requestAnimationFrame is the obvious choice and it is the wrong one here.
 * Once the Perxona presenter is live, its Cocos renderer saturates the
 * compositor and rAF stops firing for this page entirely — measured at
 * **0 frames in 3 seconds** while the tab was visible and focused, with
 * requestVideoFrameCallback still delivering a clean 30. Recognition silently
 * dies the moment the avatar appears, which is exactly when it is needed.
 *
 * requestVideoFrameCallback is also the better fit on its own merits: it fires
 * once per decoded camera frame, so there are no duplicate frames to filter and
 * `mediaTime` gives the landmarker a precise, monotonic per-frame timestamp
 * instead of a wall clock that may or may not line up with the frame in hand.
 */
function startRenderLoop() {
  if (typeof video.requestVideoFrameCallback === "function") {
    const onFrame = (_now, metadata) => {
      if (!state.tracking) return;
      processFrame(metadata.mediaTime * 1000);
      video.requestVideoFrameCallback(onFrame);
    };
    video.requestVideoFrameCallback(onFrame);
    return;
  }
  // Firefox has no requestVideoFrameCallback. setTimeout rather than rAF for
  // the same starvation reason; the camera caps the useful rate anyway, so
  // polling a little above it costs nothing and duplicate frames are skipped
  // by the currentTime check.
  const poll = () => {
    if (!state.tracking) return;
    if (video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime;
      processFrame(performance.now());
    }
    setTimeout(poll, 16);
  };
  poll();
}

function processFrame(timestampMs) {
  const result = landmarker.detectForVideo(video, timestampMs);
  drawOverlay(result);

  const vector = frameToVector(result, video);
  const segment = segmenter.push(vector, result);
  updateMeters();

  if (segment) onSegment(segment);

  frameCount += 1;
  const now = performance.now();
  if (now - fpsClock >= 1000) {
    fpsLabel.textContent = `${Math.round((frameCount * 1000) / (now - fpsClock))} fps`;
    frameCount = 0;
    fpsClock = now;
  }
}

function drawOverlay(result) {
  const ctx = overlay.getContext("2d");
  ctx.save();
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  // Match the video's CSS mirror, so the skeleton lands on the person.
  ctx.translate(overlay.width, 0);
  ctx.scale(-1, 1);

  const pose = result.poseLandmarks?.[0];
  if (pose) {
    drawing.drawConnectors(pose, HolisticLandmarker.POSE_CONNECTIONS, { color: "#ffffff55", lineWidth: 2 });
  }
  for (const hand of [result.leftHandLandmarks?.[0], result.rightHandLandmarks?.[0]]) {
    if (!hand) continue;
    drawing.drawConnectors(hand, HolisticLandmarker.HAND_CONNECTIONS, { color: "#6a5ae0", lineWidth: 3 });
    drawing.drawLandmarks(hand, { color: "#ffffff", radius: 2.5 });
  }
  ctx.restore();
}

function updateMeters() {
  const { state: segState, energy, startEnergy } = segmenter.telemetry;
  // The bar tops out at 3× the trigger threshold: the interesting range is
  // around the threshold, and a scale set by the loudest possible flail would
  // leave every real sign as a stub near zero.
  const scale = Math.max(startEnergy * 3, 1e-6);
  energyFill.style.width = `${Math.min((energy / scale) * 100, 100)}%`;
  energyThreshold.style.left = `${Math.min((startEnergy / scale) * 100, 100)}%`;
  captureBadge.hidden = segState !== SegmentState.ACTIVE;
}

// The slider sets how far above the measured noise floor a movement has to
// rise, not an absolute energy. That is the number worth exposing: the floor
// itself depends on the camera, the lighting and how far away the signer is,
// and the segmenter already tracks it, so a multiple carries across setups
// where a raw energy value would have to be re-tuned for each one.
sensitivity.addEventListener("input", () => {
  const startMultiple = Number(sensitivity.value);
  sensitivityOut.textContent = `${startMultiple.toFixed(1)}×`;
  segmenter.options.startMultiple = startMultiple;
  // Hold the gap between opening and closing proportional. Too wide and the
  // close threshold falls under the noise floor, where energy never reaches it
  // and a segment that opens never closes — a silent failure in which nothing
  // is ever recognized at all.
  segmenter.options.stopMultiple = startMultiple * 0.82;
});

// ── Segment handling ─────────────────────────────────────────────────────

function onSegment({ frames, reason }) {
  const normalized = resample(frames, TEMPLATE_FRAMES);
  state.lastEnergy = segmenter.telemetry.energy;

  if (state.mode === "record") {
    if (!state.armed) return;
    const label = wordInput.value.trim();
    if (!label) return;
    const { count, dropped } = vocab.add(label, normalized);
    const saved = vocab.save();
    state.armed = false;
    armBtn.classList.remove("is-armed");
    armBtn.textContent = "Record next take";
    recordHint.textContent = saved.ok
      ? `Saved "${label}" take ${count}${dropped ? ` (over ${MAX_SAMPLES_PER_WORD}, oldest take dropped)` : ""}`
      : saved.error;
    renderWordList();
    return;
  }

  const templates = vocab.templates();
  if (vocab.labels().length < MIN_WORDS_TO_RECOGNIZE) return;

  const verdict = classify(normalized, templates);
  logRecognition(verdict, frames.length, reason);
  if (!verdict.label) {
    askToRepeat(verdict);
    return;
  }

  addGloss(verdict.label);
}

/** Show which motion was chosen and why — the mapping is a lookup, so it should
 *  be readable rather than mysterious when a gesture looks wrong. */
function appendMotionLog(motion) {
  const li = document.createElement("li");
  li.className = "hit";
  li.textContent = `🤟 ${motion.name} (${motion.why})`;
  recognitionLog.prepend(li);
  while (recognitionLog.childElementCount > 50) recognitionLog.lastElementChild.remove();
}

function logRecognition(verdict, frameCountIn, reason) {
  const li = document.createElement("li");
  if (verdict.label) {
    li.className = "hit";
    li.textContent = `${verdict.label} \u00b7 d=${verdict.distance.toFixed(2)} \u00b7 runner-up ${verdict.runnerUp ?? "\u2014"} ${verdict.runnerUpDistance === Infinity ? "" : verdict.runnerUpDistance.toFixed(2)} \u00b7 ${frameCountIn}f`;
  } else {
    li.className = "miss";
    const why = { "too-far": "nothing close", ambiguous: "two gestures too alike", "no-templates": "nothing taught yet" }[verdict.reason] ?? verdict.reason;
    li.textContent = `no match (${why}) \u00b7 nearest ${verdict.ranking[0]?.label ?? "\u2014"} d=${verdict.distance === Infinity ? "\u221e" : verdict.distance.toFixed(2)} \u00b7 ${frameCountIn}f \u00b7 ${reason}`;
  }
  recognitionLog.prepend(li);
  while (recognitionLog.childElementCount > 50) recognitionLog.lastElementChild.remove();
}

// ── Missed gesture ───────────────────────────────────────────────────────

/** Not before this long since the last ask, so a run of misses is one ask. */
const REPEAT_ASK_COOLDOWN_MS = 6000;
let lastRepeatAsk = 0;

/**
 * When a gesture is not recognized, the avatar says so.
 *
 * For a mute user the avatar is their voice, so it asking "could you do that
 * again?" is the user asking — in character, and nothing a listener would find
 * odd. The alternative, silence, leaves the signer standing there with no idea
 * whether anything happened, and a listener with no idea they were being
 * addressed. A wrong guess spoken aloud would be worse than either.
 */
function askToRepeat(verdict) {
  const now = performance.now();
  if (now - lastRepeatAsk < REPEAT_ASK_COOLDOWN_MS) return;
  // "no-templates" is a setup state, not a missed gesture; there is nothing to
  // repeat until something has been recorded.
  if (verdict.reason === "no-templates") return;
  if (!state.presenterReady || state.isSpeaking) return;
  lastRepeatAsk = now;

  const nearest = verdict.ranking[0]?.label;
  // If it nearly matched something, say what, so a listener hears the likely
  // meaning even while the signer redoes it.
  const line =
    verdict.reason === "ambiguous" && nearest
      ? `Sorry, I didn't quite catch that. Was it "${nearest}"? Let me try again.`
      : "Sorry, I didn't catch that. Let me try again.";
  setStatus("Didn't catch that \u2014 sign it again.", "warn");
  presenter.present(line, { emotion: "embarrassment", intensity: "low" });
}

// ── Gloss buffer ─────────────────────────────────────────────────────────

function addGloss(label) {
  state.glosses.push(label);
  renderGlosses();
  scheduleAutospeak();
}

function removeGloss(index) {
  state.glosses.splice(index, 1);
  renderGlosses();
  scheduleAutospeak();
}

function renderGlosses() {
  if (state.glosses.length === 0) {
    glossStrip.replaceChildren(
      Object.assign(document.createElement("span"), {
        className: "hint",
        textContent: "Make a gesture \u2014 what it says appears here.",
      }),
    );
    sentencePreview.textContent = "";
    updateSpeakBtn();
    return;
  }

  glossStrip.replaceChildren(
    ...state.glosses.map((label, i) => {
      const chip = document.createElement("span");
      chip.className = "gloss";
      chip.append(label);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "×";
      remove.title = `Remove "${label}"`;
      remove.addEventListener("click", () => removeGloss(i));
      chip.append(remove);
      return chip;
    }),
  );
  sentencePreview.textContent = composeSentence(state.glosses, { energy: state.lastEnergy }).text;
  updateSpeakBtn();
}

function scheduleAutospeak() {
  clearTimeout(state.autospeakTimer);
  if (!autospeak.checked || state.glosses.length === 0) return;
  state.autospeakTimer = setTimeout(speak, AUTOSPEAK_DELAY_MS);
}

function updateSpeakBtn() {
  speakBtn.disabled = !state.presenterReady || state.glosses.length === 0 || state.isSpeaking;
}

async function speak() {
  clearTimeout(state.autospeakTimer);
  if (state.glosses.length === 0) return;
  const spoken = [...state.glosses];
  const { text, emotion, intensity } = composeSentence(spoken, { energy: state.lastEnergy });

  if (!state.presenterReady) {
    setStatus(`Avatar not launched — not spoken: "${text}"`, "warn");
    return;
  }

  state.isSpeaking = true;
  updateSpeakBtn();
  presenter.setListening?.(false);
  presenter.setThinking?.(true);

  // Cue the gesture separately from the speech rather than inlining a
  // `[MOTION id:1]` tag in the text. A cued motion stops when its accompanying
  // speech ends, and these sentences are short — "Goodbye." measures under 2s — so a
  // markup cue is cut off almost as soon as it starts. playMotion() runs
  // independently of the speech queue and survives the whole utterance.
  // Deliberately not awaited: the gesture should start alongside the speech,
  // not delay it.
  //
  // `spoken`, not state.glosses: the buffer is cleared on success below, and
  // the motion is chosen from the words this sentence was actually built from.
  const motion = state.motionIndex && pickMotion(state.motionIndex, spoken, state.motionCursor);
  if (motion) {
    state.motionCursor += 1;
    appendMotionLog(motion);
    Promise.resolve(presenter.playMotion(motion.id)).catch(() => {
      // A motion that will not play is not a reason to withhold the sentence.
    });
  }

  // present() resolves rather than rejects on failure — a thrown error would be
  // something else entirely, so both paths have to be handled.
  let result;
  try {
    result = await presenter.present(text, { emotion, intensity });
  } catch (err) {
    state.isSpeaking = false;
    presenter.setThinking?.(false);
    updateSpeakBtn();
    setStatus(`Playback failed: ${err.message}`, "error");
    return;
  }

  if (result?.success) {
    state.glosses = [];
    renderGlosses();
    setStatus(`Spoke: "${text}"`, "ok");
  } else {
    // Nothing was queued, so ALL_PERFORMANCE_FINISHED is never coming and
    // nothing else would release the button.
    state.isSpeaking = false;
    presenter.setThinking?.(false);
    updateSpeakBtn();
    setStatus(`Could not play (${result?.code ?? "?"}): ${result?.message ?? "unknown"}`, "error");
  }
}

speakBtn.addEventListener("click", speak);

// ── Try it without a camera ──────────────────────────────────────────────

/**
 * Sentences a first-time visitor can hear the avatar say without recording
 * anything. They are labels from the author's own recorded vocabulary, so each
 * one is a real gesture in the demo rather than a made-up line, and each maps
 * to a different `intent:` in the motion catalog — which is the point worth
 * seeing: greeting waves, thanks nods, apology shrugs.
 *
 * Deliberately routed through the gloss buffer and speak(), not straight into
 * present(): a phrase button and a recognized gesture then travel the identical
 * path, so what a visitor sees is what the camera path does.
 */
const DEMO_PHRASES = [
  "Hello",
  "Nice to meet you",
  "How are you?",
  "Thank you.",
  "Please",
  "Sorry",
  "Yes",
  "No",
  "I love you",
  "Goodbye",
];

function buildDemoPhrases() {
  demoPhrases.replaceChildren(
    ...DEMO_PHRASES.map((label) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "demo-phrase";
      btn.textContent = label;
      btn.addEventListener("click", async () => {
        if (!state.presenterReady) {
          // The avatar is still coming up (or failed to). Launching from inside
          // this click is also what unlocks audio, so the press is not wasted.
          await launchAvatar();
          return;
        }
        // Autoplay policy again: the auto-launch happened without a gesture, so
        // this click is the first chance to unlock the audio context.
        await presenter.resumeAudioPlayback?.();
        clearTimeout(state.autospeakTimer);
        state.glosses = [label];
        renderGlosses();
        await speak();
      });
      return btn;
    }),
  );
}

buildDemoPhrases();
clearGlossBtn.addEventListener("click", () => {
  state.glosses = [];
  renderGlosses();
  clearTimeout(state.autospeakTimer);
});
autospeak.addEventListener("change", scheduleAutospeak);
autospeakDelay.textContent = (AUTOSPEAK_DELAY_MS / 1000).toFixed(1);

// ── Record mode ──────────────────────────────────────────────────────────

function setMode(mode) {
  state.mode = mode;
  const recording = mode === "record";
  modeRecord.classList.toggle("is-active", recording);
  modeRecognize.classList.toggle("is-active", !recording);
  modeRecord.setAttribute("aria-selected", String(recording));
  modeRecognize.setAttribute("aria-selected", String(!recording));
  recordPanel.hidden = !recording;
  recognizePanel.hidden = recording;
  state.armed = false;
  armBtn.classList.remove("is-armed");
  armBtn.textContent = "Record next take";
}

modeRecognize.addEventListener("click", () => setMode("recognize"));
modeRecord.addEventListener("click", () => setMode("record"));

armBtn.addEventListener("click", () => {
  if (!state.tracking) {
    recordHint.textContent = "Enable the camera first.";
    return;
  }
  if (!wordInput.value.trim()) {
    recordHint.textContent = "Type what the gesture should say first.";
    wordInput.focus();
    return;
  }
  state.armed = !state.armed;
  armBtn.classList.toggle("is-armed", state.armed);
  armBtn.textContent = state.armed ? "Cancel" : "Record next take";
  recordHint.textContent = state.armed ? "Make the gesture — it saves itself when you stop." : "";
});

function renderWordList() {
  const labels = vocab.labels();
  vocabSummary.textContent =
    labels.length === 0
      ? "No signs yet — record some under Record signs."
      : `${labels.length} gestures \u00b7 ${vocab.size()} takes`;

  wordList.replaceChildren(
    ...labels.map((label) => {
      const li = document.createElement("li");
      const name = document.createElement("span");
      name.className = "label";
      name.textContent = label;

      const dots = document.createElement("span");
      dots.className = "dots";
      const samples = vocab.samples(label);
      for (let i = 0; i < MAX_SAMPLES_PER_WORD; i += 1) {
        const dot = document.createElement("i");
        // Filled dots below three stay "weak": one sample recognizes only the
        // exact take it was recorded from, and the count is the single biggest
        // lever the reader has on accuracy.
        dot.className = `dot${i < samples.length ? "" : " weak"}`;
        dots.append(dot);
      }

      const count = document.createElement("span");
      count.className = "count";
      count.textContent = samples.length < 3 ? `${samples.length} takes \u2014 3 or more recommended` : `${samples.length} takes`;

      const del = document.createElement("button");
      del.type = "button";
      del.className = "danger";
      del.textContent = "Delete";
      del.addEventListener("click", () => {
        vocab.removeWord(label);
        vocab.save();
        renderWordList();
      });

      li.append(name, dots, count, del);
      return li;
    }),
  );
}

exportBtn.addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(vocab.toJSON())], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "signer-vocabulary.json";
  a.click();
  URL.revokeObjectURL(url);
});

importBtn.addEventListener("click", () => importFile.click());
importFile.addEventListener("change", async () => {
  const file = importFile.files?.[0];
  if (!file) return;
  try {
    const loaded = Vocabulary.fromJSON(JSON.parse(await file.text()));
    // Merge rather than replace: importing a shared vocabulary should not
    // silently delete the samples this person just spent time recording.
    for (const label of loaded.labels()) {
      for (const t of loaded.samples(label)) vocab.add(label, t.frames);
    }
    const saved = vocab.save();
    recordHint.textContent = saved.ok ? `Imported ${loaded.labels().length} gestures.` : saved.error;
    renderWordList();
  } catch (err) {
    recordHint.textContent = `Import failed: ${err.message}`;
  }
  importFile.value = "";
});

clearVocabBtn.addEventListener("click", () => {
  if (!confirm("Delete every recorded gesture? Export first if you want them back.")) return;
  for (const label of vocab.labels()) vocab.removeWord(label);
  Vocabulary.clearStored();
  renderWordList();
  recordHint.textContent = "All gestures deleted.";
});

// ── Bootstrap ────────────────────────────────────────────────────────────

suggestedWords.replaceChildren(
  ...SUGGESTED_WORDS.map((w) => Object.assign(document.createElement("option"), { value: w })),
);
sensitivityOut.textContent = `${Number(sensitivity.value).toFixed(1)}×`;
renderWordList();
renderGlosses();
if (!STATIC && vocab.labels().length === 0) setMode("record");

await loadCatalog();

// Loaded last, and outside the top-level await chain that must not fail: a
// rejection here would abort module evaluation and leave every handler above
// unregistered. The recognition half works without the presenter.
try {
  await loadPresenterEngine(appConfig.presenterUrl);
  presenterEngineReady = true;
  updateInitBtn();
  // Only now does <sv-presenter> have initializeWithConnectKey on it, so the
  // public build's auto-launch belongs here rather than next to the catalog.
  if (STATIC?.autoLaunch && avatarSelect.value && sceneSelect.value) {
    // The placeholder tells the reader to pick an avatar and press Launch,
    // which on this build has already happened. Say what is actually going on
    // instead — a cold first load spends the better part of a minute pulling
    // the 3D scene down, and a silent black rectangle for that long is
    // indistinguishable from a page that is broken.
    presenterPlaceholder.querySelector("p").textContent =
      "Starting the Perxona avatar\u2026 the first load pulls down the 3D scene and can take up to a minute.";
    await launchAvatar();
  }
} catch (err) {
  setStatus(`Avatar engine failed to load: ${err.message} (recognition still works)`, "warn");
}
