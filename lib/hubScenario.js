// Hub scenarios: fetching a Game export's map from the community hub.
//
// The one place the harness repeats game logic. The game's downloadHubBundle
// lives in communityHub.jsx, and the loader compiles no JSX, so it cannot be
// imported. What it DOES is short and made entirely of calls into plain .js game
// modules, so the harness makes the same calls in the same order (ADR-0001).
//
// That copy can drift. So before each download the target's own source is read
// and its sequence of game calls compared with the one copied here; a change is
// reported loudly rather than tested against silently.

import fs from "node:fs";
import path from "node:path";

import { gameModuleUrl } from "./globals.js";
import { assertSandboxed, getSandboxRoot } from "./safety.js";

/** The game functions downloadHubBundle calls, in order, as of beta 2633ae0. */
export const COPIED_HUB_CALLS = [
  "unzipBundle",
  "embedScenarioBundleImage",
  "embedScenarioBundleVector",
  "resolveScenarioBundleBackground",
];
const HUB_PROXY = "/api/hub/file";
const FUNCTION_NAME = "downloadHubBundle";

/** Every name a module imports, from `import X, { a, b as c } from "..."`. */
const importedNames = (source) => {
  const names = new Set();
  for (const match of source.matchAll(/import\s+([\s\S]*?)\s+from\s+["'][^"']+["']/g)) {
    const clause = match[1];
    const braces = /\{([\s\S]*?)\}/.exec(clause);
    if (braces) {
      for (const part of braces[1].split(",")) {
        const local = part.trim().split(/\s+as\s+/).pop()?.trim();
        if (local) names.add(local);
      }
    }
    const fallback = clause.replace(/\{[\s\S]*?\}/, "").replace(/,/g, " ").trim();
    if (fallback && !fallback.startsWith("*")) names.add(fallback.split(/\s+/)[0]);
  }
  return names;
};

/** The text of `export const downloadHubBundle = ... => { ... }`, braces matched. */
const functionBody = (source) => {
  const start = source.search(new RegExp(`export\\s+const\\s+${FUNCTION_NAME}\\s*=`));
  if (start === -1) return null;
  const open = source.indexOf("{", source.indexOf("=>", start));
  if (open === -1) return null;
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open, index + 1);
    }
  }
  return null;
};

/**
 * Compare the target's downloadHubBundle with the copy the harness makes.
 * Only calls into imported game modules count, so rewording a message is not
 * drift; a new step, a dropped one or a reordering is.
 */
export const checkHubDownloadDrift = (source) => {
  const body = functionBody(String(source ?? ""));
  if (!body) {
    return { ok: false, reason: `the game no longer has ${FUNCTION_NAME}, which the harness's hub download copies` };
  }
  if (!body.includes(HUB_PROXY)) {
    return { ok: false, reason: `${FUNCTION_NAME} no longer fetches through ${HUB_PROXY}` };
  }

  const imported = importedNames(source);
  const calls = [...body.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)]
    .map((match) => match[1])
    .filter((name) => imported.has(name));
  const same = calls.length === COPIED_HUB_CALLS.length && calls.every((name, index) => name === COPIED_HUB_CALLS[index]);
  if (!same) {
    return {
      ok: false,
      reason: `${FUNCTION_NAME} now calls ${calls.join(" → ") || "nothing"}; the harness copies ${COPIED_HUB_CALLS.join(" → ")}`,
    };
  }
  return { ok: true, reason: null };
};

const HUB_SOURCE = path.join("src", "Game", "GameUI", "communityHub.jsx");
const SERVER_SOURCE = path.join("server", "server.js");

/**
 * The hosts the game server's hub proxy may fetch from (its HUB_DOWNLOAD_HOSTS),
 * read from the target's own source rather than copied, so the harness never
 * lets through less — or more — than the game does.
 */
export const readHubHosts = (serverSource) => {
  const list = /HUB_DOWNLOAD_HOSTS\s*=\s*new Set\(\[([\s\S]*?)\]\)/.exec(String(serverSource ?? ""))?.[1];
  return list ? [...list.matchAll(/["']([^"']+)["']/g)].map((match) => match[1]) : [];
};

export const hubCacheDir = () => path.join(getSandboxRoot() ?? "", "cache", "hub");

/** One file per map version: a hub post re-synced is a different map. */
const cacheFile = (origin) =>
  path.join(hubCacheDir(), `${Number(origin.postId) || "post"}-${String(origin.syncedAt ?? "").replace(/[^0-9A-Za-z]/g, "")}.json`);

const megabytes = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;

/**
 * Fetch a Hub scenario's bundle, ready to import: the game's downloadHubBundle,
 * step for step, plus the hubOrigin stamp its "Import & play" adds.
 *
 * Downloads go through the game server's own /api/hub/file proxy, which only
 * fetches from GitHub, so the harness reaches nowhere a player's install would
 * not. Cached per map version, since a hub map can run to hundreds of MB.
 *
 * Returns { bundle, cached, drift }: `drift` is the drift check's result, so the
 * caller can say when this copy may be out of date.
 */
export const fetchHubScenario = async (session, origin, { name = "the map", say = () => {} } = {}) => {
  const source = fs.readFileSync(path.join(session.target.path, HUB_SOURCE), "utf8");
  const drift = checkHubDownloadDrift(source);

  const cached = cacheFile(origin);
  if (fs.existsSync(cached)) {
    say(`"${name}" is in the hub cache; not downloading it again.`);
    return { bundle: JSON.parse(fs.readFileSync(cached, "utf8")), cached: true, drift };
  }

  const load = (relative) => import(gameModuleUrl(session.target.path, relative));
  const { unzipBundle } = await load("src/runtime/bundleZip.js");
  const { embedScenarioBundleImage, embedScenarioBundleVector, resolveScenarioBundleBackground } = await load(
    "src/runtime/communityBasemaps.js",
  );

  const bundleUrl = String(origin.bundleUrl ?? "");
  const hosts = readHubHosts(fs.readFileSync(path.join(session.target.path, SERVER_SOURCE), "utf8"));
  if (!hosts.length) throw new Error("the game server no longer lists which hosts its hub proxy may fetch from");
  const closeHub = session.fetch.openHubRoute(hosts);
  let bundle;
  try {
    const response = await fetch(`${session.baseUrl}/api/hub/file?url=${encodeURIComponent(bundleUrl)}`);
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || `Download failed (HTTP ${response.status}).`);
    }
    const length = Number(response.headers.get("content-length"));
    say(`downloading "${name}" from the community hub${length > 0 ? ` (${megabytes(length)})` : ""}...`);

    if (/\.zip(\?|$)/i.test(bundleUrl)) {
      const zip = await unzipBundle(await response.arrayBuffer());
      const scenarioText = await zip.text("scenario.json");
      if (!scenarioText) throw new Error("That .zip is missing scenario.json.");
      bundle = JSON.parse(scenarioText);
      const imageName = zip.names().find((n) => /(^|\/)basemap\.(png|jpe?g|webp|gif|svg)$/i.test(n));
      if (imageName) {
        embedScenarioBundleImage(bundle, await zip.bytes(imageName), imageName);
      } else {
        const vectorName = zip.names().find((n) => /(^|\/)basemap\.geojson$/i.test(n));
        if (vectorName) embedScenarioBundleVector(bundle, await zip.bytes(vectorName));
      }
    } else {
      bundle = await response.json();
    }
    await resolveScenarioBundleBackground(bundle);
  } finally {
    closeHub();
  }

  // As the game's "Import & play" does: without it the map reads as
  // editor-made, and a later export would try to carry the whole thing.
  bundle.hubOrigin = { bundleUrl, postId: origin.postId, syncedAt: origin.syncedAt };

  const file = assertSandboxed(cached, "hub cache");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(bundle));
  return { bundle, cached: false, drift };
};

/** Drop cached hub maps older than `keepDays`, as --prune does for sandboxes. */
export const pruneHubCache = ({ keepDays = 14, now = Date.now() } = {}) => {
  if (!getSandboxRoot()) return [];
  const dir = hubCacheDir();
  if (!fs.existsSync(dir)) return [];
  const cutoff = now - keepDays * 24 * 60 * 60 * 1000;
  const removed = [];
  for (const entry of fs.readdirSync(dir)) {
    const file = path.join(dir, entry);
    try {
      if (fs.statSync(file).mtimeMs >= cutoff) continue;
    } catch {
      continue;
    }
    fs.rmSync(assertSandboxed(file, "stale hub cache entry"), { force: true });
    removed.push(file);
  }
  return removed;
};
