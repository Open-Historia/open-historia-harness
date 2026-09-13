// The drift check on the one piece of game logic the harness repeats: the
// Community tab's hub download, which lives in a JSX file the loader refuses.

import assert from "node:assert/strict";
import test from "node:test";

import { checkHubDownloadDrift, readHubHosts } from "./hubScenario.js";

// The imports and the function as the game has them (communityHub.jsx on beta).
const IMPORTS = `import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  exportScenarioBundle,
  importScenarioBundle,
  useLibraryState,
} from "../../runtime/library.js";
import {
  dedupeScenarioBundleBackground,
  embedScenarioBundleImage,
  embedScenarioBundleVector,
  resolveScenarioBundleBackground,
  splitScenarioBundleImage,
} from "../../runtime/communityBasemaps.js";
import { unzipBundle, zipBundle } from "../../runtime/bundleZip.js";
`;

const BODY = `export const downloadHubBundle = async (bundleUrl) => {
  const response = await fetch(\`/api/hub/file?url=\${encodeURIComponent(bundleUrl)}\`);
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || \`Download failed (HTTP \${response.status}).\`);
  }
  let bundle;
  if (/\\.zip(\\?|$)/i.test(bundleUrl)) {
    const zip = await unzipBundle(await response.arrayBuffer());
    const scenarioText = await zip.text("scenario.json");
    if (!scenarioText) throw new Error("That .zip is missing scenario.json.");
    bundle = JSON.parse(scenarioText);
    const imageName = zip.names().find((n) => /(^|\\/)basemap\\.(png|jpe?g|webp|gif|svg)$/i.test(n));
    if (imageName) {
      embedScenarioBundleImage(bundle, await zip.bytes(imageName), imageName);
    } else {
      const vectorName = zip.names().find((n) => /(^|\\/)basemap\\.geojson$/i.test(n));
      if (vectorName) embedScenarioBundleVector(bundle, await zip.bytes(vectorName));
    }
  } else {
    bundle = await response.json();
  }
  await resolveScenarioBundleBackground(bundle);
  return bundle;
};

const saveBlobToDisk = (blob, fileName) => {
  zipBundle({});
};
`;

const SOURCE = `${IMPORTS}\n${BODY}`;

test("the game's hub download as the harness copied it passes", () => {
  assert.deepEqual(checkHubDownloadDrift(SOURCE), { ok: true, reason: null });
});

test("a reworded message is not drift", () => {
  const result = checkHubDownloadDrift(SOURCE.replace("That .zip is missing scenario.json.", "No scenario.json in that zip."));
  assert.equal(result.ok, true);
});

test("a new step calling another game function is drift", () => {
  const result = checkHubDownloadDrift(
    SOURCE.replace("  await resolveScenarioBundleBackground(bundle);", "  await resolveScenarioBundleBackground(bundle);\n  dedupeScenarioBundleBackground(bundle);"),
  );
  assert.equal(result.ok, false);
  assert.match(result.reason, /dedupeScenarioBundleBackground/);
});

test("the same steps in a different order are drift", () => {
  const moved = SOURCE.replace("  await resolveScenarioBundleBackground(bundle);\n", "").replace(
    "  let bundle;",
    "  let bundle;\n  await resolveScenarioBundleBackground(bundle);",
  );
  assert.equal(checkHubDownloadDrift(moved).ok, false);
});

test("fetching from somewhere other than the game's hub proxy is drift", () => {
  const result = checkHubDownloadDrift(SOURCE.replace("/api/hub/file", "/api/hub/download"));
  assert.equal(result.ok, false);
  assert.match(result.reason, /\/api\/hub\/file/);
});

test("the hosts a hub download may reach come from the game server's own list", () => {
  const server = `const HUB_DOWNLOAD_HOSTS = new Set([
  "github.com",
  "objects.githubusercontent.com",
  "github-production-user-asset-6210df.s3.amazonaws.com",
]);
const HUB_MAX_BUNDLE_BYTES = 200 * 1024 * 1024;`;
  assert.deepEqual(readHubHosts(server), [
    "github.com",
    "objects.githubusercontent.com",
    "github-production-user-asset-6210df.s3.amazonaws.com",
  ]);
});

test("a server without that list reads as no hosts", () => {
  assert.deepEqual(readHubHosts("const somethingElse = 1;"), []);
});

test("a function that is gone or renamed is drift", () => {
  const result = checkHubDownloadDrift(SOURCE.replace("downloadHubBundle", "fetchHubBundle"));
  assert.equal(result.ok, false);
  assert.match(result.reason, /downloadHubBundle/);
});
