// Game exports: a player's Game packed as one .zip by the game's Export or
// Attach game, and how a run is opened on one.
//
// The zip is opened with the game's OWN reader and imported through the game's
// OWN routes, in the order the Games tab uses — never unpacked or translated
// here. A second implementation would drift from the real one, and then the
// harness would be testing an import no player ever gets. See ADR-0001.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { gameModuleUrl } from "./globals.js";
import { fetchHubScenario } from "./hubScenario.js";
import { SANDBOX_SCENARIO_ID } from "./sandbox.js";
import { planAiSettings, readSettingsRecord } from "./settingsRecord.js";

const HARNESS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Where Game exports live: gitignored, so a player's campaign can sit here
 * without ever reaching the public repo. Player zips at the top are read-only to
 * the harness; the only part it writes is harness/. The tests point it at a
 * temp folder with OH_HARNESS_EXPORTS_DIR.
 */
export const exportsDir = () => process.env.OH_HARNESS_EXPORTS_DIR || path.join(HARNESS_ROOT, "game-exports");
export const harnessExportsDir = (dir = exportsDir()) => path.join(dir, "harness");

/** A problem with the file itself. Its message is the whole story: no stack is shown. */
export class GameExportError extends Error {
  constructor(message) {
    super(message);
    this.name = "GameExportError";
    this.harnessExport = true;
  }
}

/** The target predates Game exports. Exit 5, like any target that cannot run what was asked. */
export class TargetCannotOpenExportsError extends Error {
  constructor(message) {
    super(message);
    this.name = "TargetCannotOpenExportsError";
    this.harnessCompat = true;
  }
}

/**
 * Refuse, before anything boots, a target without the game's own export code.
 * Checked on the module the harness actually needs, not guessed from a branch
 * name. Never quietly switched to a branch that has it: testing something other
 * than what the user asked for is worse than stopping.
 */
export const assertTargetOpensExports = (target) => {
  if (fs.existsSync(path.join(target.path, "src", "runtime", "gameZip.js"))) return;
  throw new TargetCannotOpenExportsError(
    `This target cannot import Game exports: ${target.describe?.() ?? target.path} predates them ` +
      "(it has no src/runtime/gameZip.js). Add --branch upstream/beta, or another branch that has them.",
  );
};

const zipsIn = (folder, prefix = "") => {
  try {
    return fs
      .readdirSync(folder, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".zip"))
      .map((entry) => `${prefix}${entry.name.slice(0, -".zip".length)}`);
  } catch {
    return [];
  }
};

/** Short names of every export in the folder, harness-made ones as harness/<name>. */
export const listGameExports = (dir = exportsDir()) =>
  [...zipsIn(dir), ...zipsIn(harnessExportsDir(dir), "harness/")].sort();

/**
 * Turn a --save-zip value into a file. A path that exists is used as it is;
 * anything else is a short name in the exports folder, with or without .zip.
 */
export const resolveSaveZip = (option, { dir = exportsDir(), cwd = process.cwd() } = {}) => {
  const value = String(option ?? "").trim();
  if (!value) throw new GameExportError("--save-zip needs a path to a Game export, or its name in game-exports/.");

  const direct = path.resolve(cwd, value);
  if (fs.existsSync(direct) && fs.statSync(direct).isFile()) return direct;

  const named = path.join(dir, ...value.replace(/\.zip$/i, "").split(/[\\/]/));
  if (fs.existsSync(`${named}.zip`)) return `${named}.zip`;

  const available = listGameExports(dir);
  throw new GameExportError(
    `No Game export called "${value}": it is not a file, and there is no ${path.basename(named)}.zip in ${dir}. ` +
      (available.length ? `Exports there: ${available.join(", ")}.` : "That folder has no exports in it."),
  );
};

/**
 * Check a file is a zip at all, before any of the harness boots, and say what
 * it is: name, size, and a fingerprint two people can compare without either
 * showing the other their file path.
 */
export const inspectZipFile = (file) => {
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch (error) {
    const why = error.code === "ENOENT" ? "no such file" : error.message;
    throw new GameExportError(`Cannot read the Game export ${file}: ${why}.`);
  }

  // By magic bytes, not extension — the same rule the game's own import uses.
  const isZip = bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
  if (!isZip) {
    throw new GameExportError(
      `${file} is not a zip file, so it cannot be a Game export. Export one from the game's Games tab, ` +
        "or attach one from Settings → Diagnostics.",
    );
  }

  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  return { file, fileName: path.basename(file), bytes: bytes.length, sha256, shortSha: sha256.slice(0, 12) };
};

// ---------------------------------------------------------------------------
// Inside a booted session: the game's own zip code and import routes
// ---------------------------------------------------------------------------

/** The game's zip modules, from the target checkout. Only loadable once the engine is. */
export const loadGameZip = async (session) => ({
  ...(await import(gameModuleUrl(session.target.path, "src/runtime/gameZip.js"))),
  ...(await import(gameModuleUrl(session.target.path, "src/runtime/bundleZip.js"))),
});

export const readLibraryCatalog = async (session) => {
  const response = await fetch(`${session.baseUrl}/api/library`);
  if (!response.ok) throw new Error(`[harness] the library catalog answered ${response.status}`);
  return response.json();
};

const STAND_IN_WARNING =
  "Played on the Stand-in scenario, not the Game's own map. Findings about regions may not be real.";

/**
 * Put an opened Game export into the library, in the Games tab's order
 * (libraryBar.jsx handleImportGameFile): the Scenario first, so the Game's
 * scenario id resolves the moment it lands; then the Game, pointed at that
 * Scenario; then its Roll-back points as the raw text they arrived as.
 *
 * Never activates — an import must not switch the game being played, in the
 * game or here. The caller decides.
 *
 * `opened` is readGameZip's result. Returns the new Game's id, the bundle as it
 * was actually sent (the import check compares against that), and which map case
 * applied.
 */
export const placeExport = async (
  session,
  opened,
  { importScenario = true, geometry = "stock", hub = true, hubSkippedBecause = "--no-hub", say = () => {} } = {},
) => {
  const library = session.modules.library;
  const ref = opened.bundle?.scenarioRef ?? {};
  const known = new Set(((await readLibraryCatalog(session)).scenarios ?? []).map((entry) => entry.id));
  const name = ref.scenarioName ?? ref.scenarioId ?? "the map";

  const standIn = (kind, warning) => ({ kind, scenarioId: SANDBOX_SCENARIO_ID, standIn: true, warning });
  let map;
  if (opened.scenarioBundle && importScenario) {
    // Only when this library does not already hold that id, exactly as the game
    // does: importing regardless would mint a second copy of the same map.
    if (known.has(ref.scenarioId)) {
      map = { kind: "embedded", scenarioId: ref.scenarioId, standIn: false, warning: null, alreadyHere: true };
    } else {
      const imported = await library.importScenarioBundle(opened.scenarioBundle);
      map = { kind: "embedded", scenarioId: imported.scenario.id, standIn: false, warning: null, alreadyHere: false };
    }
  } else if (opened.scenarioBundle) {
    map = standIn("embedded-skipped", `The zip carries its map, and --no-embedded-scenario left it out. ${STAND_IN_WARNING}`);
  } else if (ref.builtIn) {
    // Every install ships this map, and the Stand-in serves the same stock regions.
    map = standIn("built-in", null);
  } else if (ref.hubOrigin && !hub) {
    map = standIn("hub-skipped", `"${name}" is on the community hub and was not downloaded (${hubSkippedBecause}). ${STAND_IN_WARNING}`);
  } else if (ref.hubOrigin) {
    try {
      const fetched = await fetchHubScenario(session, ref.hubOrigin, { name, say });
      const imported = await library.importScenarioBundle(fetched.bundle);
      map = {
        kind: fetched.cached ? "hub-cached" : "hub-downloaded",
        scenarioId: imported.scenario.id,
        standIn: false,
        warning: fetched.drift.ok
          ? null
          : `The game's hub download has changed since the harness copied it (${fetched.drift.reason}). ` +
            "This map was fetched the old way and may not be what a player gets; update lib/hubScenario.js.",
      };
    } catch (error) {
      map = standIn("hub-failed", `Downloading "${name}" from the community hub failed (${error.message}). ${STAND_IN_WARNING}`);
      map.error = error.message;
    }
  } else if (ref.missing) {
    map = standIn("missing", `The player did not have this Game's map either. ${STAND_IN_WARNING}`);
  } else {
    map = standIn(
      "not-carried",
      `The map was not in the zip (too large to travel, or exported before maps did). ${STAND_IN_WARNING}`,
    );
  }
  map.scenarioName = ref.scenarioName ?? ref.scenarioId ?? null;

  // The same rewrite the game makes when a Scenario lands under a new id. On the
  // Stand-in, the world also stops claiming custom regions the sandbox does not
  // serve — as it does for Real saves.
  const data = { ...(opened.bundle?.data ?? {}) };
  if (map.standIn && geometry !== "full" && data.world?.customRegions) {
    data.world = { ...data.world, customRegions: false };
  }
  const sent = { ...opened.bundle, data, scenarioRef: { ...ref, scenarioId: map.scenarioId } };

  const details = await library.importGameBundle(sent);
  const gameId = details.game.id;
  if (opened.snapshotsText) await library.writeGameSnapshotsText(gameId, opened.snapshotsText);

  return { gameId, sent, map };
};

/** JSON with object keys sorted, so two equal values always print the same. */
const canonical = (value) =>
  JSON.stringify(value, (_key, entry) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(Object.keys(entry).sort().map((key) => [key, entry[key]]))
      : entry,
  );

/** The first path at which two values differ, for a report a person can act on. */
const firstDifference = (sent, stored, at = "") => {
  if (canonical(sent) === canonical(stored)) return null;
  const bothObjects = sent && stored && typeof sent === "object" && typeof stored === "object";
  if (!bothObjects || Array.isArray(sent) !== Array.isArray(stored)) {
    const show = (value) => (value === undefined ? "nothing" : JSON.stringify(value)?.slice(0, 80));
    return { at: at || "(whole value)", sent: show(sent), stored: show(stored) };
  }
  if (Array.isArray(sent) && sent.length !== stored.length) {
    return { at: at || "(whole value)", sent: `${sent.length} items`, stored: `${stored.length} items` };
  }
  for (const key of new Set([...Object.keys(sent), ...Object.keys(stored)])) {
    const found = firstDifference(sent[key], stored[key], at ? `${at}.${key}` : key);
    if (found) return found;
  }
  return null;
};

const countRollbackPoints = (text) => {
  if (!text || !text.trim()) return 0;
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed.length : 0;
};

/**
 * Did the importer store what it was given? Each part of the Game's data as the
 * server now serves it is compared with the bundle as sent, and the Roll-back
 * points are counted on both sides. A difference is an Import finding: blamed
 * on the game's importer, never on the player's Save.
 *
 * Counting parses the Roll-back points once, here in Node. The rule against
 * parsing them was about passing them along, not about checking them.
 */
export const checkImport = async (session, { gameId, sent, snapshotsText }) => {
  const library = session.modules.library;
  const stored = await library.exportGameBundle(gameId);
  const mismatches = [];

  for (const key of Object.keys(sent.data ?? {})) {
    const difference = firstDifference(sent.data[key], stored.data?.[key]);
    if (difference) {
      mismatches.push({
        key,
        ...difference,
        summary: `The imported Game's ${key} is not what the export carried (at ${difference.at}: sent ${difference.sent}, stored ${difference.stored})`,
      });
    }
  }

  const rollbackPoints = {
    zip: countRollbackPoints(snapshotsText),
    imported: countRollbackPoints(await library.readGameSnapshotsText(gameId)),
  };
  if (rollbackPoints.zip !== rollbackPoints.imported) {
    mismatches.push({
      key: "roll-back points",
      at: "snapshots",
      sent: `${rollbackPoints.zip}`,
      stored: `${rollbackPoints.imported}`,
      summary: `The zip carried ${rollbackPoints.zip} Roll-back points; the imported Game has ${rollbackPoints.imported}`,
    });
  }

  return { ok: mismatches.length === 0, mismatches, rollbackPoints };
};

/** The game's own reader failed: say which file, and in words a person can act on. */
const unreadable = (file, error) => {
  const why =
    error instanceof SyntaxError
      ? `a JSON file inside it is damaged (${error.message})`
      : String(error?.message ?? error);
  return new GameExportError(`Cannot open the Game export ${file}: ${why}`);
};

/**
 * Open a Game export and make it the Game the run plays: read it with the
 * game's own reader, place it in the library, activate it, check the import,
 * and apply what the Settings record says (only with live AI, and only on the
 * player's own provider).
 *
 * Returns the Save's description, which the report and the scenarios read.
 */
export const openGameExport = async (
  session,
  file,
  {
    importScenario = true,
    geometry = "stock",
    hub = true,
    hubSkippedBecause = "--no-hub",
    ai = "off",
    provider = "gemini",
    model = "",
    say = () => {},
  } = {},
) => {
  const info = inspectZipFile(file);
  const buffer = fs.readFileSync(file);
  const zip = await loadGameZip(session);

  let opened;
  try {
    opened = await zip.readGameZip(buffer);
  } catch (error) {
    throw unreadable(file, error);
  }
  const settingsText = await (await zip.unzipBundle(buffer)).text("settings.txt").catch(() => null);

  let placed;
  try {
    placed = await placeExport(session, opened, { importScenario, geometry, hub, hubSkippedBecause, say });
  } catch (error) {
    throw new GameExportError(`The game refused to import ${file}: ${error?.message ?? error}`);
  }

  const library = session.modules.library;
  await library.activateGame(placed.gameId);
  await library.refreshLibraryCatalog({ force: true });

  const importCheck = await checkImport(session, {
    gameId: placed.gameId,
    sent: placed.sent,
    snapshotsText: opened.snapshotsText,
  });

  const { PROVIDER_OPTIONS = [] } = await import(gameModuleUrl(session.target.path, "src/Game/AI/providerConfig.js"));
  const settings = readSettingsRecord(settingsText, { providers: PROVIDER_OPTIONS });
  const aiPlan = planAiSettings({ record: settings, ai, provider, model });
  if (aiPlan.fromRecord) {
    // The engine reads its provider settings from localStorage at call time, so
    // setting them now is in time for the first turn.
    const storageKey = provider.replace(/-/g, "_");
    globalThis.localStorage?.setItem(`${storageKey}_model`, aiPlan.model);
    if (aiPlan.reasoning !== null) globalThis.localStorage?.setItem("ai_reasoning_enabled", aiPlan.reasoning ? "1" : "0");
  }

  const game = opened.bundle?.data?.game ?? {};
  return {
    kind: "export",
    ...info,
    gameId: placed.gameId,
    gameName: opened.bundle?.game?.name ?? null,
    round: game.round ?? null,
    gameDate: game.gameDate ?? null,
    exportedAt: opened.bundle?.exportedAt ?? null,
    rollbackPoints: importCheck.rollbackPoints.zip,
    map: placed.map,
    settings,
    aiPlan,
    importCheck,
    warnings: [placed.map.warning, ...aiPlan.warnings].filter(Boolean),
  };
};

const kilobytes = (bytes) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1048576).toFixed(1)} MB`);

const MAP_WORDS = {
  embedded: (map) => `its own Scenario "${map.scenarioName}", carried in the zip${map.alreadyHere ? " (already in the library)" : ""}`,
  "embedded-skipped": (map) => `the Stand-in scenario: the zip carries "${map.scenarioName}", but --no-embedded-scenario left it out`,
  "built-in": (map) => `the Stand-in scenario, standing in for the built-in "${map.scenarioName}"`,
  "hub-downloaded": (map) => `its own Scenario "${map.scenarioName}", downloaded from the community hub`,
  "hub-cached": (map) => `its own Scenario "${map.scenarioName}", from the hub cache`,
  "hub-skipped": (map) => `the Stand-in scenario: "${map.scenarioName}" is on the community hub, and it was not downloaded`,
  "hub-failed": (map) => `the Stand-in scenario: downloading "${map.scenarioName}" from the hub failed (${map.error})`,
  missing: (map) => `the Stand-in scenario: the player did not have "${map.scenarioName}" either`,
  "not-carried": (map) => `the Stand-in scenario: "${map.scenarioName}" was not in the zip`,
};

/** What a run was opened on, as lines for the terminal and the reports. */
export const describeSaveLines = (save) => {
  if (!save || save.kind === "fresh") return ["Save: fresh scenario"];
  if (save.kind === "real") return [`Save: Real save ${save.name}`];

  const lines = [`Save: Game export ${save.fileName} (${kilobytes(save.bytes)}, sha256 ${save.shortSha})`];
  const when = [save.round === null ? null : `round ${save.round}`, save.gameDate].filter(Boolean).join(", ");
  lines.push(`  Game: "${save.gameName ?? "unnamed"}"${when ? ` — ${when}` : ""}${save.exportedAt ? `, exported ${save.exportedAt}` : ""}`);
  lines.push(
    `  Roll-back points: ${save.rollbackPoints ? `${save.rollbackPoints} came with it` : "none came with it"}`,
  );
  lines.push(`  Map: ${(MAP_WORDS[save.map.kind] ?? (() => save.map.kind))(save.map)}`);

  const record = save.settings;
  lines.push(
    record
      ? `  Settings record: ${record.providerLabel ?? "provider not recorded"}, ${record.model ?? "model not recorded"}` +
          (record.reasoning === null ? "" : `, reasoning ${record.reasoning ? "on" : "off"}`)
      : "  Settings record: none in the zip",
  );
  for (const note of save.aiPlan?.notes ?? []) lines.push(`  ${note}`);

  const check = save.importCheck;
  lines.push(
    check.ok
      ? `  Import check: ok — every part of the Game's data arrived as exported` +
          (check.rollbackPoints.zip === 1
            ? ", and its Roll-back point"
            : check.rollbackPoints.zip
              ? `, and all ${check.rollbackPoints.zip} Roll-back points`
              : "")
      : `  Import check: FAILED — ${check.mismatches.length} difference${check.mismatches.length === 1 ? "" : "s"}, ` +
          "each an Import finding (the game's importer, not the player's Save)",
  );
  return lines;
};
