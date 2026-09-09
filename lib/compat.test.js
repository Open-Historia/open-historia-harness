// The compat shim is the load-bearing bet of this whole harness: it says the game
// needs no source changes to be testable. These prove that claim and, just as
// importantly, prove it fails LOUDLY when a branch drifts far enough that the
// rewrite would quietly be translating something other than what it thinks.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test, { after, before } from "node:test";

import {
  ENV_GLOBAL,
  compatReport,
  detectBlockers,
  installCompat,
  isCompatInstalled,
  uninstallCompat,
} from "./compat.js";
import { DEFAULT_GAME_REPO, looksLikeGameRepo } from "./target.js";
import { makeCompatFixture } from "./testRepo.js";

let root;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "oh-compat-test-"));
});

after(() => {
  uninstallCompat();
  fs.rmSync(root, { recursive: true, force: true });
});

const importEntry = (entry) => import(pathToFileURL(entry).href);

test("the fixture reproduces all four blockers", () => {
  const dir = path.join(root, "detect");
  makeCompatFixture(dir);
  const blockers = detectBlockers(dir);

  assert.deepEqual(
    blockers.filter((b) => b.present).map((b) => b.id).sort(),
    ["json-import-attribute", "jsx-extension", "prompt-context-env", "region-seed-env"],
  );
});

test("a target with none of the blockers reports none", () => {
  const dir = path.join(root, "already-fixed");
  makeCompatFixture(dir);
  // Simulate a branch that fixed all four upstream.
  fs.renameSync(path.join(dir, "src/Game/AI/main.jsx"), path.join(dir, "src/Game/AI/main.js"));
  fs.writeFileSync(path.join(dir, "src/Game/AI/gameplay.js"), "import './main.js';\n");
  fs.writeFileSync(
    path.join(dir, "src/Game/AI/gameplayPrompts.js"),
    "import P from './defaultPrompts.json' with { type: 'json' };\nexport default P;\n",
  );
  fs.writeFileSync(path.join(dir, "src/Game/AI/promptContext.js"), "export const X = 1;\n");
  fs.writeFileSync(path.join(dir, "src/runtime/regionSeed.js"), "export const Y = 2;\n");

  assert.deepEqual(detectBlockers(dir).filter((b) => b.present), []);
});

test("the engine imports, and every blocker is neutralised", async () => {
  const dir = path.join(root, "import");
  const { entry } = makeCompatFixture(dir);

  installCompat({ targetPath: dir });
  assert.equal(isCompatInstalled(), true);

  const mod = await importEntry(entry);
  const result = await mod.simulateTimelineJump();

  assert.equal(result.MARKER, "jsx-loaded", "the .jsx file loaded as plain ESM");
  assert.equal(result.advisorPrompt, "you are an advisor", "the bare JSON import resolved");
  assert.equal(result.CITY_SEED_URL, "/assets/cities-seed.json", "module-scope env read fell back");
  assert.equal(result.IS_WEB, false);
  assert.equal(result.seed, "desktop", "the in-function env read did not throw");
});

test("env values can be injected to simulate the web build", async () => {
  const dir = path.join(root, "web-mode");
  const { entry } = makeCompatFixture(dir);

  installCompat({ targetPath: dir, env: { VITE_OH_WEB: "1", VITE_OH_PMTILES_URL: "https://cdn.example/tiles/" } });

  const mod = await importEntry(entry);
  const result = await mod.simulateTimelineJump();

  assert.equal(result.IS_WEB, true, "rewriting to a real object beats leaving env undefined");
  assert.equal(result.seed, "web");
  assert.equal(result.CITY_SEED_URL, "https://cdn.example/tiles/cities-seed.json");
});

test("rewrite counts are pinned, so a drifting branch is reported not mistranslated", async () => {
  const dir = path.join(root, "drift");
  const { entry } = makeCompatFixture(dir);

  uninstallCompat();
  installCompat({ targetPath: dir });
  await importEntry(entry);

  const report = compatReport();
  assert.deepEqual(report.envRewrites, [
    { file: "src/Game/AI/promptContext.js", rewrites: 2 },
    { file: "src/runtime/regionSeed.js", rewrites: 1 },
  ]);
  assert.equal(report.totalEnvRewrites, 3);
  assert.deepEqual(report.jsxLoaded, ["src/Game/AI/main.jsx"]);
});

test("a .jsx file off the allow-list is refused by name", async () => {
  const dir = path.join(root, "bad-jsx");
  const { entry } = makeCompatFixture(dir, { badJsx: true });

  uninstallCompat();
  installCompat({ targetPath: dir });

  // The loader does not compile JSX. Silently trying would either explode with an
  // opaque syntax error or, worse, appear to work against something that is not
  // the real component.
  await assert.rejects(importEntry(entry), (error) => {
    assert.match(error.message, /Panel\.jsx/, "the error names the offending file");
    assert.match(error.message, /does NOT compile JSX/);
    assert.match(error.message, /allow-list/);
    return true;
  });
});

test("files outside the target's src are left alone", async () => {
  const dir = path.join(root, "scoped");
  makeCompatFixture(dir);
  // Same token, but outside src/ — the shim must not touch it.
  const outside = path.join(dir, "outside.js");
  fs.writeFileSync(outside, `export const raw = typeof import.meta.env;\n`);

  uninstallCompat();
  installCompat({ targetPath: dir });

  const mod = await importEntry(outside);
  assert.equal(mod.raw, "undefined", "an untouched file still sees the real (absent) import.meta.env");
  assert.equal(compatReport().envRewrites.length, 0, "and it is not counted as a rewrite");
});

test("uninstall removes the injected global", () => {
  installCompat({ targetPath: path.join(root, "import"), env: { A: "1" } });
  assert.ok(globalThis[ENV_GLOBAL]);
  uninstallCompat();
  assert.equal(globalThis[ENV_GLOBAL], undefined);
  assert.equal(isCompatInstalled(), false);
});

// The reality check. Pinned assertions live on the fixture above; this one only
// asserts that the real engine, on whatever branch is checked out right now,
// actually loads — which is the claim the harness rests on.
test("the REAL turn engine imports from the working tree", async (t) => {
  if (!fs.existsSync(DEFAULT_GAME_REPO) || !looksLikeGameRepo(DEFAULT_GAME_REPO)) {
    t.skip(`no game repo at ${DEFAULT_GAME_REPO}`);
    return;
  }

  uninstallCompat();
  installCompat({ targetPath: DEFAULT_GAME_REPO });

  const gameplay = await importEntry(path.join(DEFAULT_GAME_REPO, "src/Game/AI/gameplay.js"));

  for (const name of ["simulateTimelineJump", "simulateAutoJump", "applyGameMasterCommand", "rollBackToSnapshot"]) {
    assert.equal(typeof gameplay[name], "function", `${name} must be callable headlessly`);
  }

  const units = await importEntry(path.join(DEFAULT_GAME_REPO, "src/Game/Map/unitsController.js"));
  for (const name of ["deployUnit", "moveUnitTo", "startUnitsSync", "subscribeUnits", "getUnits"]) {
    assert.equal(typeof units[name], "function", `${name} must be callable headlessly`);
  }

  assert.deepEqual(compatReport().jsxLoaded, ["src/Game/AI/main.jsx"]);
});
