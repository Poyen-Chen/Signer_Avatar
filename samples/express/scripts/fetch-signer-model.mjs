#!/usr/bin/env node
// Downloads the MediaPipe Holistic model the signer demo runs on.
//
// Kept out of the repository (13 MB binary) and fetched once, on demand. It is
// served from public/models/ afterwards, so the recognition path stays entirely
// local: no camera frame and no landmark derived from one ever leaves the
// device, and the demo keeps working offline once this has run.
import { mkdir, writeFile, stat } from "node:fs/promises";

const URL_ =
  "https://storage.googleapis.com/mediapipe-models/holistic_landmarker/holistic_landmarker/float16/latest/holistic_landmarker.task";
const DEST = "public/models/holistic_landmarker.task";

try {
  const { size } = await stat(DEST);
  console.log(`${DEST} already present (${(size / 1e6).toFixed(1)} MB) — nothing to do.`);
  process.exit(0);
} catch {
  // Not there yet; fall through and fetch it.
}

console.log(`Downloading holistic_landmarker.task (~13 MB)…`);
const res = await fetch(URL_);
if (!res.ok) {
  console.error(`ERROR: download failed with HTTP ${res.status} ${res.statusText}\n${URL_}`);
  process.exit(1);
}
await mkdir("public/models", { recursive: true });
await writeFile(DEST, Buffer.from(await res.arrayBuffer()));
const { size } = await stat(DEST);
console.log(`Wrote ${DEST} (${(size / 1e6).toFixed(1)} MB).`);
