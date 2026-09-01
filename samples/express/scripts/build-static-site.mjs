/**
 * Build the public, server-free version of the Signer demo.
 *
 * The demo normally needs server.mjs: it proxies the Connect catalog with the
 * secret key and hands the browser the publishable one. A hackathon submission
 * needs a URL anyone can open, and a static host has no server to run — so this
 * freezes every catalog read this demo makes into JSON at build time and ships
 * the page with `SIGNER_STATIC` set, which is what tells app.js to read those
 * files instead of calling /api. Only the publishable key ships; the secret key
 * stays here.
 *
 * The catalog is read through the running dev server rather than the Connect
 * API directly, so the responses are exactly the shapes app.js already handles
 * (the avatar id normalization in particular).
 *
 *   npm start                                  # in another terminal
 *   node --env-file=.env scripts/build-static-site.mjs
 *
 * Output lands in dist/ — publish that directory as the site root.
 */
import { mkdir, rm, copyFile, writeFile, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const SERVER = process.env.BUILD_FROM || `http://localhost:${process.env.PORT || 8083}`;
const SRC = "public/demos/signer";
const OUT = process.env.OUT_DIR || "dist";

// Vendored locally by the Express sample; served from a CDN here so the
// published site stays a few hundred KB instead of 48 MB of wasm and model.
const TASKS_VISION = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/holistic_landmarker/holistic_landmarker/float16/latest/holistic_landmarker.task";

async function api(path) {
  const res = await fetch(`${SERVER}${path}`);
  const body = await res.text();
  if (!res.ok) {
    throw new Error(
      `GET ${path} → HTTP ${res.status}: ${body.slice(0, 200)}\n` +
        (res.status === 401
          ? "The Connect API key in .env is not valid. Issue a new pair in the Perxona Console " +
            "(console.perxona.ai/asia → API keys) and update .env before building.\n"
          : ""),
    );
  }
  return JSON.parse(body);
}

// ── Catalog ─────────────────────────────────────────────────────────────────
console.log(`Reading the catalog through ${SERVER}…`);
const [config, connectKey, avatars, scenes, voices] = await Promise.all([
  api("/api/config"),
  api("/api/connect-key"),
  api("/api/avatars"),
  api("/api/scenes"),
  api("/api/voices"),
]);

if (!connectKey.connect_key) throw new Error("No publishable Connect key to bake in.");
console.log(`  ${avatars.items.length} avatars, ${scenes.items.length} scenes, ${voices.items.length} voices`);

// Every avatar's motions, so switching avatars on the published page still
// reports what that one can express.
const motions = Object.fromEntries(
  await Promise.all(
    avatars.items.map(async (a) => [a.id, await api(`/api/avatars/${encodeURIComponent(a.id)}/motions`)]),
  ),
);
console.log(`  motions for ${Object.keys(motions).length} avatars`);

// ── Layout ──────────────────────────────────────────────────────────────────
await rm(OUT, { recursive: true, force: true });
await mkdir(join(OUT, "api", "motions"), { recursive: true });

for (const file of await readdir(SRC)) {
  if (file.endsWith(".js") || file.endsWith(".css")) await copyFile(join(SRC, file), join(OUT, file));
}

const write = (p, data) => writeFile(join(OUT, p), JSON.stringify(data));
await write("api/config.json", config);
await write("api/connect-key.json", connectKey);
await write("api/avatars.json", avatars);
await write("api/scenes.json", scenes);
await write("api/voices.json", voices);
for (const [id, page] of Object.entries(motions)) await write(`api/motions/${id}.json`, page);

// The vocabulary is offered as an import on the published page too.
await mkdir(join(OUT, "vocabulary"), { recursive: true });
await copyFile(join(SRC, "vocabulary/poyen.json"), join(OUT, "vocabulary/poyen.json"));

// ── index.html ──────────────────────────────────────────────────────────────
// One injected script is the whole difference between the two deployments.
const html = (await readFile(join(SRC, "index.html"), "utf8")).replace(
  '<script type="module" src="app.js"></script>',
  `<script>
      // Static build — see the SIGNER_STATIC comment in app.js.
      window.SIGNER_STATIC = ${JSON.stringify({
        visionBundle: `${TASKS_VISION}/vision_bundle.mjs`,
        wasmBase: `${TASKS_VISION}/wasm`,
        modelUrl: MODEL_URL,
        autoLaunch: true,
      })};
    </script>
    <script type="module" src="app.js"></script>`,
);
await writeFile(join(OUT, "index.html"), html);

// GitHub Pages runs Jekyll over the branch otherwise, which is a build step
// this site has no use for and one more thing that can fail.
await writeFile(join(OUT, ".nojekyll"), "");

console.log(`\nBuilt ${OUT}/ — publish it as the site root.`);
