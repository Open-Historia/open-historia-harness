// The throwaway data directory a run plays in.
//
// OH_DATA_DIR is the whole isolation story: point it at a temp tree and the game's
// every store follows, because server/dataDir.js resolves it once and every store
// reads from there. OH_ASSETS_DIR points back at the game repo's public/assets
// READ-ONLY, so all targets share one copy of the 223 MB of pmtiles.
//
// Seeding has to be cheap, because a slow sandbox makes the whole harness not
// worth reaching for. The expensive thing in the game's data dir is
// regions.geojson at 55 MB, and the trick that avoids it rests on two facts in
// libraryStore.js, both verified in source:
//
//   1. :2271 — the "borrow Modern Day geometry" fallback only fires for a
//      scenario whose id is NOT "default". Naming ours "harness" takes that
//      branch, and since no `default` scenario exists in the sandbox the lookup
//      finds nothing and the route returns an empty FeatureCollection instantly.
//   2. :1019 — ensureDefaultScenario() returns early when scenario-manifest.json
//      exists but the scenario directory does not. Writing the manifest BEFORE
//      the server boots means no `default` scenario is ever seeded.
//
// Total seed is about 460 KB and a few milliseconds. Region NAMES still resolve,
// because ownership overrides key on stock GADM ids (RUS.3_1) that come from
// regions.pmtiles — the geojson only ever carried geometry for rendering, which a
// headless run has no use for.

import fs from "node:fs";
import path from "node:path";

import { assertSandboxed, copyIn, getSandboxRoot } from "./safety.js";

/** The sandbox scenario is deliberately NOT called "default". See note 1 above. */
export const SANDBOX_SCENARIO_ID = "harness";

/**
 * The game seeded alongside it.
 *
 * A scenario alone is not enough: runtime assets resolve from the ACTIVE GAME, so
 * a scenario-only sandbox 404s every read until something writes. The server does
 * auto-create a game on the first write (libraryStore.js:2445), but depending on
 * that implicit side effect means the first read of a run behaves differently
 * from every read after it. Seeding the game outright makes the sandbox usable
 * the moment it exists, and saves a run the token rotation that creating a game
 * would otherwise cost before its first turn.
 */
export const SANDBOX_GAME_ID = "harness-run";

// Seed files that live in the scenario directory. All ten are tracked in git, so
// they are present in every worktree, not just the main checkout.
const SEED_FILES = [
  "world.json",
  "colors.json",
  "prompts.json",
  "game.json",
  "storage/actions.json",
  "storage/advisor.json",
  "storage/chat.json",
  "storage/events.json",
];

// Runtime-only assets the server would otherwise create on demand. Seeding them
// empty keeps the first read of each off the "file missing" path.
const RUNTIME_ONLY_SEED = {
  "storage/snapshots.json": [],
  "storage/intercepts.json": {},
};

const writeJson = (file, value) => {
  assertSandboxed(file, "sandbox seed file");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};

const readJson = (file, fallback = null) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
};

export const seedSourceDir = (targetPath) =>
  path.join(targetPath, "server", "data", "scenarios", "default");

export const builtInSeedDir = (targetPath) =>
  path.join(targetPath, "server", "seed", "default");

// Where a sandbox is seeded from. The game now ships its built-in scenario in
// server/seed/default (tracked, so a --branch worktree has it too). Older
// checkouts only had the gitignored server/data/scenarios/default, which a
// worktree never has; that, like fixture saves, can still come from the main
// checkout (read-only). Null when none of them has a world.
export const seedCandidates = (target) =>
  [
    builtInSeedDir(target.path),
    seedSourceDir(target.path),
    target.gameRepo ? seedSourceDir(target.gameRepo) : null,
  ].filter(Boolean);

export const resolveSeedSource = (target) =>
  seedCandidates(target).find((dir) => fs.existsSync(path.join(dir, "world.json"))) ?? null;

export const assetsDirFor = (targetPath) => path.join(targetPath, "public", "assets");

/**
 * Copy the 55 MB regions.geojson into a cache under the sandbox root ONCE, then
 * hard-link it per run.
 *
 * Never link the game repo's own copy. writeScenarioAsset would writeFileSync
 * THROUGH the link and truncate the real file in place, which is precisely the
 * class of accident this harness exists to make impossible. Linking a cache we
 * own means the worst case is a corrupt cache, fixed by --refresh-cache.
 */
export const ensureGeometryCache = ({ targetPath, refresh = false }) => {
  const source = path.join(seedSourceDir(targetPath), "regions.geojson");
  if (!fs.existsSync(source)) return null;

  const cache = assertSandboxed(path.join(getSandboxRoot(), "cache", "regions.geojson"), "geometry cache");
  if (refresh && fs.existsSync(cache)) fs.rmSync(cache);
  if (!fs.existsSync(cache)) {
    fs.mkdirSync(path.dirname(cache), { recursive: true });
    fs.copyFileSync(source, cache);
  }
  return cache;
};

const linkOrCopy = (source, dest) => {
  assertSandboxed(dest, "geometry link");
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    fs.linkSync(source, dest); // same volume: instant
  } catch {
    fs.copyFileSync(source, dest); // different volume: pay the copy
  }
};

/**
 * Build an isolated data directory and return the handles a session needs.
 *
 * `geometry: "stock"` (default) ships no custom geometry and flips the seed
 * world's customRegions flag off, because a world claiming custom regions while
 * the server serves an empty FeatureCollection is an incoherent state to test
 * against. `geometry: "full"` links the real geojson and leaves the flag alone.
 */
export const createSandbox = ({
  target,
  geometry = "stock",
  fixture = null,
  fixtureSource = null,
  refreshCache = false,
  seedGame = true,
} = {}) => {
  const root = getSandboxRoot();
  if (!root) throw new Error("[harness sandbox] configureSafety() must run first");

  const runsRoot = assertSandboxed(path.join(root, "runs"), "sandbox runs root");
  fs.mkdirSync(runsRoot, { recursive: true });
  const dir = assertSandboxed(fs.mkdtempSync(path.join(runsRoot, "run-")), "sandbox run directory");

  const dataDir = path.join(dir, "data");
  const outDir = path.join(dir, "out");
  const scenarioDir = path.join(dataDir, "scenarios", SANDBOX_SCENARIO_ID);
  fs.mkdirSync(path.join(scenarioDir, "storage"), { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });

  const source = resolveSeedSource(target);
  if (!source) {
    throw new Error(
      `[harness sandbox] no seed scenario at ${seedCandidates(target).join(" or ")}. ` +
        "The target checkout looks incomplete.",
    );
  }

  for (const relative of SEED_FILES) {
    const from = path.join(source, relative);
    if (fs.existsSync(from)) copyIn(from, path.join(scenarioDir, relative));
  }
  for (const [relative, value] of Object.entries(RUNTIME_ONLY_SEED)) {
    writeJson(path.join(scenarioDir, relative), value);
  }

  // The scenario's identity. Its id is what routes the geojson lookup away from
  // the 55 MB file (note 1 at the top of this module).
  const sourceMeta = readJson(path.join(source, "scenario.json"), {}) ?? {};
  const now = new Date().toISOString();
  writeJson(path.join(scenarioDir, "scenario.json"), {
    ...sourceMeta,
    id: SANDBOX_SCENARIO_ID,
    name: "Harness Sandbox",
    subtitle: "Throwaway scenario for headless test runs",
    description: "Seeded by open-historia-harness. Nothing here is a real save.",
    countryNameOverrides: sourceMeta.countryNameOverrides ?? {},
    createdAt: now,
    updatedAt: now,
  });

  let geometryCache = null;
  if (geometry === "full") {
    geometryCache = ensureGeometryCache({ targetPath: target.path, refresh: refreshCache });
    if (geometryCache) linkOrCopy(geometryCache, path.join(scenarioDir, "regions.geojson"));
  } else {
    // Stock rendering. The seed world declares customRegions, which would leave
    // the game expecting geometry the sandbox deliberately does not ship.
    const worldPath = path.join(scenarioDir, "world.json");
    const world = readJson(worldPath, {}) ?? {};
    if (world.customRegions) {
      world.customRegions = false;
      writeJson(worldPath, world);
    }
  }

  // Written BEFORE the server boots. This is what stops ensureDefaultScenario()
  // seeding a `default` scenario behind our back (note 2 at the top).
  writeJson(path.join(dataDir, "scenario-manifest.json"), {
    activeScenarioId: SANDBOX_SCENARIO_ID,
    order: [SANDBOX_SCENARIO_ID],
    selectedScenarioId: SANDBOX_SCENARIO_ID,
    version: 2,
  });

  const games = [];
  let activeGameId = "";

  if (!fixture && seedGame) {
    // A game is a copy of the scenario's runtime files plus an identity record.
    // Copying from the scenario directory we just wrote means it inherits the
    // stock-geometry fix above rather than re-deriving it.
    const gameDir = assertSandboxed(path.join(dataDir, "games", SANDBOX_GAME_ID), "seeded game");
    fs.mkdirSync(path.join(gameDir, "storage"), { recursive: true });

    for (const relative of [...SEED_FILES, ...Object.keys(RUNTIME_ONLY_SEED)]) {
      const from = path.join(scenarioDir, relative);
      if (fs.existsSync(from)) copyIn(from, path.join(gameDir, relative));
    }

    writeJson(path.join(gameDir, "game-instance.json"), {
      accentColor: sourceMeta.accentColor ?? "#7c3aed",
      coverImageContentType: null,
      createdAt: now,
      description: "Seeded by open-historia-harness. Nothing here is a real save.",
      eyebrow: "Game",
      heroSubtitle: "Headless test run",
      heroTitle: "Harness Run",
      id: SANDBOX_GAME_ID,
      lastPlayedAt: now,
      name: "Harness Run",
      playCount: 0,
      scenarioId: SANDBOX_SCENARIO_ID,
      subtitle: "Throwaway",
      updatedAt: now,
    });

    games.push(SANDBOX_GAME_ID);
    activeGameId = SANDBOX_GAME_ID;
  }

  if (fixture) {
    // Fixture saves are gitignored, so they exist only in the main checkout —
    // never in a worktree. Read-only, and copied rather than linked.
    const from = path.join(fixtureSource ?? target.gameRepo, "server", "data", "games", fixture);
    if (!fs.existsSync(from)) {
      throw new Error(
        `[harness sandbox] no fixture save at ${from}. Available saves live in the main ` +
          `checkout's server/data/games/.`,
      );
    }
    const to = assertSandboxed(path.join(dataDir, "games", fixture), "fixture destination");
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.cpSync(from, to, { recursive: true });

    // A real save records scenarioId "default", but the sandbox deliberately has
    // no scenario by that name — that is the trick that avoids copying the 55 MB
    // geojson. Left alone, every scenario-scoped asset lookup (pmtiles included)
    // resolves against a scenario that does not exist and 404s, so region names
    // silently never resolve for fixture runs.
    // Real saves point at scenarios that do not exist here: "default" (the one we
    // deliberately never create) or an author's own, like "new-scenario". Either
    // way every scenario-scoped asset lookup 404s, and region names silently stop
    // resolving. Some saves have no game-instance.json at all — that case has to
    // be CREATED rather than skipped, or the fallback puts us right back on
    // "default".
    const instancePath = path.join(to, "game-instance.json");
    const instance = readJson(instancePath, null);
    const stamp = new Date().toISOString();
    writeJson(instancePath, {
      accentColor: sourceMeta.accentColor ?? "#7c3aed",
      coverImageContentType: null,
      createdAt: stamp,
      description: `Copied read-only from the ${fixture} save by open-historia-harness.`,
      eyebrow: "Game",
      heroSubtitle: "Headless test run",
      heroTitle: fixture,
      name: fixture,
      playCount: 0,
      subtitle: "Throwaway",
      updatedAt: stamp,
      ...(instance ?? {}),
      // These two are ours to set regardless of what the save said.
      id: fixture,
      scenarioId: SANDBOX_SCENARIO_ID,
    });

    // The fixture's own world may declare custom geometry it no longer has access
    // to, for the same reason.
    if (geometry !== "full") {
      const fixtureWorldPath = path.join(to, "world.json");
      const fixtureWorld = readJson(fixtureWorldPath, null);
      if (fixtureWorld?.customRegions) {
        writeJson(fixtureWorldPath, { ...fixtureWorld, customRegions: false });
      }
    }

    games.push(fixture);
    activeGameId = fixture;
  }

  writeJson(path.join(dataDir, "game-manifest.json"), { activeGameId, order: games, version: 2 });

  const sandbox = {
    dir,
    dataDir,
    outDir,
    scenarioId: SANDBOX_SCENARIO_ID,
    scenarioDir,
    gameId: activeGameId || null,
    gameDir: activeGameId ? path.join(dataDir, "games", activeGameId) : null,
    geometry,
    geometryCache,
    fixture,
    // Read-only. Shared by every target so the 223 MB of pmtiles is never copied.
    assetsDir: assetsDirFor(target.gameRepo),
    env: {
      OH_DATA_DIR: dataDir,
      OH_ASSETS_DIR: assetsDirFor(target.gameRepo),
    },
    dispose: ({ keep = false } = {}) => {
      if (keep) return false;
      assertSandboxed(dir, "sandbox run directory");
      fs.rmSync(dir, { recursive: true, force: true });
      return true;
    },
  };

  sandbox.describe = () =>
    `${path.basename(dir)} (${geometry} geometry${fixture ? `, fixture ${fixture}` : ""})`;

  return sandbox;
};

/** Delete run directories older than `keepDays`. Reports are kept elsewhere; these are bulk. */
export const pruneSandboxes = ({ keepDays = 14, now = Date.now() } = {}) => {
  const runsRoot = path.join(getSandboxRoot() ?? "", "runs");
  if (!getSandboxRoot() || !fs.existsSync(runsRoot)) return [];

  const cutoff = now - keepDays * 24 * 60 * 60 * 1000;
  const removed = [];
  for (const entry of fs.readdirSync(runsRoot)) {
    const dir = path.join(runsRoot, entry);
    let stats;
    try {
      stats = fs.statSync(dir);
    } catch {
      continue;
    }
    if (stats.mtimeMs >= cutoff) continue;
    assertSandboxed(dir, "stale sandbox");
    fs.rmSync(dir, { recursive: true, force: true });
    removed.push(dir);
  }
  return removed;
};
