// Game exports end to end, through the CLI: one process per run, because the
// game's server starts on import and can only start once per process.
//
// The round-trip scenario runs first and writes a real zip, made by the game's
// own export code from a sandbox Game. Every later case opens that zip or a
// variant of it, so no zip is committed and nothing from a real Save enters the
// repo.
//
// Needs a game checkout with Game exports: the working tree if it has them, or
// upstream/beta in a worktree. Skipped when neither is available.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";

import { DEFAULT_GAME_REPO, looksLikeGameRepo } from "./target.js";
import { makeFakeGameRepo } from "./testRepo.js";

const HARNESS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(HARNESS_ROOT, "cli.js");

const git = (...args) => spawnSync("git", ["-C", DEFAULT_GAME_REPO, ...args], { encoding: "utf8" });

/** The flags that point a run at a checkout that can export and import Games. */
const exportCapableTarget = () => {
  if (!looksLikeGameRepo(DEFAULT_GAME_REPO)) return null;
  if (process.env.OH_HARNESS_EXPORT_BRANCH) return ["--branch", process.env.OH_HARNESS_EXPORT_BRANCH];
  if (fs.existsSync(path.join(DEFAULT_GAME_REPO, "src", "runtime", "gameZip.js"))) return [];
  if (git("cat-file", "-e", "upstream/beta:src/runtime/gameZip.js").status === 0) return ["--branch", "upstream/beta"];
  return null;
};

const target = exportCapableTarget();
const skip = target ? false : "no game checkout with Game exports (set OH_HARNESS_EXPORT_BRANCH to one)";

let exportsDir;

const run = (args, { env = {}, targetFlags = target } = {}) => {
  const result = spawnSync(process.execPath, [CLI, ...args, ...targetFlags], {
    cwd: HARNESS_ROOT,
    encoding: "utf8",
    env: { ...process.env, OH_HARNESS_EXPORTS_DIR: exportsDir, ...env },
    timeout: 5 * 60 * 1000,
  });
  return { code: result.status, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
};

before(() => {
  exportsDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-game-exports-"));
});

after(() => fs.rmSync(exportsDir, { recursive: true, force: true }));

const roundTripZip = () => path.join(exportsDir, "harness", "round-trip.zip");

/**
 * A variant of the round-trip zip, written as <name>.zip in the exports folder.
 * Built with the game's own JSZip, so the harness gains no zip dependency.
 * `change(entries)` edits { entryName: text } in place; delete an entry to drop it.
 */
const makeVariant = async (name, change) => {
  const JSZip = createRequire(path.join(DEFAULT_GAME_REPO, "package.json"))("jszip");
  const source = await JSZip.loadAsync(fs.readFileSync(roundTripZip()));
  const entries = {};
  for (const entry of Object.keys(source.files)) entries[entry] = await source.file(entry).async("string");
  change(entries);
  const zip = new JSZip();
  for (const [entry, text] of Object.entries(entries)) zip.file(entry, text);
  const file = path.join(exportsDir, `${name}.zip`);
  fs.writeFileSync(file, await zip.generateAsync({ type: "nodebuffer" }));
  return file;
};

const editBundle = (edit) => (entries) => {
  const bundle = JSON.parse(entries["game.json"]);
  edit(bundle);
  entries["game.json"] = JSON.stringify(bundle);
};

/** The report.md a scenario run names on its summary line. */
const reportOf = (out) => {
  const relative = /report=(\S+report\.md)/.exec(out)?.[1];
  const file = relative && path.join(HARNESS_ROOT, relative);
  assert.ok(file && fs.existsSync(file), `the run names its report:\n${out}`);
  return fs.readFileSync(file, "utf8");
};

/** A failure a person can act on: exit 2, the file named, no stack trace. */
const assertRefused = ({ code, out }, file, pattern) => {
  assert.equal(code, 2, out);
  assert.ok(out.includes(file), `names the file ${file}:\n${out}`);
  assert.match(out, pattern);
  assert.doesNotMatch(out, /^\s+at .+:\d+:\d+\)?$/m, "no stack trace");
};

test("the round trip exports a played Game through the game's own zip, and imports it back faithfully", { skip }, () => {
  const { code, out } = run(["export-round-trip"]);
  assert.equal(code, 0, out);
  assert.ok(fs.existsSync(path.join(exportsDir, "harness", "round-trip.zip")), "the zip is kept for later runs");
});

test("a scenario opens on a Game export by short name, and says what it opened", { skip }, () => {
  const { code, out } = run(["smoke", "--save-zip", "harness/round-trip"]);
  assert.equal(code, 0, out);
  assert.match(out, /Save: Game export round-trip\.zip \(\d+ KB, sha256 [0-9a-f]{12}\)/);
  assert.match(out, /Game: "Harness Run" — round \d+, 2016-/);
  assert.match(out, /Roll-back points: 1 came with it/);
  assert.match(out, /Scenario: its own Scenario "Harness Sandbox", carried in the zip/);
  assert.match(out, /Settings record: none in the zip/);
  assert.match(out, /Import check: ok/);
});

test("Roll-back points a zip carried can be rolled back to", { skip }, () => {
  const { code, out } = run(["rollback", "--save-zip", "harness/round-trip"]);
  assert.equal(code, 0, out);
  assert.match(out, /rolled back to the newest carried Roll-back point: round 1, 2016-01-01/);
});

test("what the importer stores differently is an Import finding, and fails the run", { skip }, async () => {
  // The game stores a null events list as [] — faithful to its defaults, not to
  // what was sent, which is exactly what the check exists to notice.
  const file = await makeVariant("null-events", editBundle((bundle) => { bundle.data.events = null; }));
  const { code, out } = run(["smoke", "--save-zip", file]);
  assert.equal(code, 1, out);
  assert.match(out, /Import check: FAILED — 1 difference/);
  assert.match(out, /Import finding: The imported Game's events is not what the export carried/);
  assert.doesNotMatch(out, /Import finding: .*(world|game|chat)\b/, "only the part that changed");

  const report = reportOf(out);
  assert.match(report, /- \*\*save:\*\* Game export null-events\.zip/);
  const importSection = /## Import findings([\s\S]*?)(\n## |$)/.exec(report)?.[1] ?? "";
  assert.match(importSection, /events is not what the export carried/);
});

test("a zip without Roll-back points opens, and says none came with it", { skip }, async () => {
  const file = await makeVariant("no-rollback", (entries) => delete entries["snapshots.json"]);
  const { code, out } = run(["smoke", "--save-zip", file]);
  assert.equal(code, 0, out);
  assert.match(out, /Roll-back points: none came with it/);
  assert.match(out, /Import check: ok/);
});

test("a map the zip carries under a new id is imported for the Game to play on", { skip }, async () => {
  const file = await makeVariant("player-map", editBundle((bundle) => { bundle.scenarioRef.scenarioId = "player-map"; }));
  const { code, out } = run(["smoke", "--save-zip", file]);
  assert.equal(code, 0, out);
  assert.match(out, /Scenario: its own Scenario "Harness Sandbox", carried in the zip$/m);
  assert.doesNotMatch(out, /WARNING: Played on the Stand-in/);
});

test("--no-embedded-scenario plays on the Stand-in instead, and warns", { skip }, () => {
  const { code, out } = run(["smoke", "--save-zip", "harness/round-trip", "--no-embedded-scenario"]);
  assert.equal(code, 0, out);
  assert.match(out, /Scenario: the Stand-in scenario: the zip carries "Harness Sandbox", but --no-embedded-scenario left it out/);
  assert.match(out, /WARNING: .*Findings about regions may not be real/);
});

const withoutMap = (ref) => (entries) => {
  delete entries["scenario.json"];
  editBundle((bundle) => {
    bundle.scenarioRef = { ...bundle.scenarioRef, scenarioId: "default", embedded: false, ...ref };
  })(entries);
};

test("a Game on a built-in map plays on the Stand-in without a warning", { skip }, async () => {
  const file = await makeVariant("built-in", withoutMap({ builtIn: true, scenarioName: "Modern Day" }));
  const { code, out } = run(["smoke", "--save-zip", file]);
  assert.equal(code, 0, out);
  assert.match(out, /Scenario: the Stand-in scenario, standing in for the built-in "Modern Day"/);
  assert.doesNotMatch(out, /WARNING: .*Stand-in/);
});

test("a Game whose map the player never had plays on the Stand-in, and warns", { skip }, async () => {
  const file = await makeVariant("missing-map", withoutMap({ scenarioId: "lost-map", missing: true, scenarioName: "Lost Map" }));
  const { code, out } = run(["smoke", "--save-zip", file]);
  assert.equal(code, 0, out);
  assert.match(out, /Scenario: the Stand-in scenario: the player did not have "Lost Map" either/);
  assert.match(out, /WARNING: The player did not have this Game's Scenario either/);
});

test("a hub map left undownloaded by --no-hub plays on the Stand-in, and warns", { skip }, async () => {
  const hubOrigin = { postId: 7, bundleUrl: "https://github.com/example/maps/releases/download/v1/map.zip", syncedAt: "2026-08-01T00:00:00.000Z" };
  const file = await makeVariant("hub-map", withoutMap({ scenarioId: "hub-map", hubOrigin, scenarioName: "Hub Map" }));
  const { code, out } = run(["smoke", "--save-zip", file, "--no-hub"]);
  assert.equal(code, 0, out);
  assert.match(out, /Scenario: the Stand-in scenario: "Hub Map" is on the community hub, and it was not downloaded/);
  assert.match(out, /WARNING: .*--no-hub/);
});

test("the Settings record is quoted, and with AI off nothing from it is applied", { skip }, async () => {
  const file = await makeVariant("with-settings", (entries) => {
    entries["settings.txt"] =
      "-- Settings when this file was saved --\nAI:\n  Provider: OpenAI\n  Model: gpt-5-mini\n  Model reasoning: off\n";
  });
  const { code, out } = run(["smoke", "--save-zip", file]);
  assert.equal(code, 0, out);
  assert.match(out, /Settings record: OpenAI, gpt-5-mini, reasoning off/);
  assert.doesNotMatch(out, /Played with the player's settings/);

  const settingsSection = /## Settings record([\s\S]*?)(\n## |$)/.exec(reportOf(out))?.[1] ?? "";
  assert.match(settingsSection, /-- Settings when this file was saved --\s+AI:\s+Provider: OpenAI/, "quoted in full");
});

test("a Stand-in warning comes before everything else in a scenario run's report", { skip }, () => {
  const { code, out } = run(["smoke", "--save-zip", "harness/round-trip", "--no-embedded-scenario"]);
  assert.equal(code, 0, out);
  const report = reportOf(out);
  const warning = report.indexOf("> **Warning:**");
  assert.ok(warning > 0 && warning < report.indexOf("## "), `the warning is at the top:\n${report}`);
});

const bugReportOf = (out) => {
  const file = /^Bug report: (.+BUG-REPORT\.md)$/m.exec(out)?.[1];
  assert.ok(file && fs.existsSync(file), `the hunt names its report:\n${out}`);
  return fs.readFileSync(file, "utf8");
};

test("a bug hunt on a Game export writes a report naming the zip, and how to rerun it", { skip }, () => {
  const { code, out } = run(["--hunt", "--level", "1", "--turns", "2", "--seed", "5", "--save-zip", "harness/round-trip"]);
  assert.equal(code, 0, out);
  const report = bugReportOf(out);
  assert.match(report, /\*\*Save:\*\* Game export round-trip\.zip \(\d+ KB, sha256 [0-9a-f]{12}\)/);
  assert.match(report, /Game: "Harness Run"/);
  assert.match(report, /Roll-back points: 1 came with it/);
  assert.match(report, /Settings record: none in the zip/);
  assert.match(report, /Import check: ok/);
  const rerun = /## Reproducing this\s+```\s*(.+)\s*```/.exec(report)?.[1] ?? "";
  assert.match(rerun, /--save-zip harness\/round-trip/);
  assert.match(rerun, /--seed 5/);
  for (const flag of target) assert.ok(rerun.includes(flag), `the rerun keeps ${flag}: ${rerun}`);
});

test("in a hunt, an Import finding has its own section and is never blamed on the Save", { skip }, () => {
  const { code, out } = run(["--hunt", "--level", "1", "--turns", "1", "--save-zip", path.join(exportsDir, "null-events.zip")]);
  assert.equal(code, 1, out);
  const report = bugReportOf(out);
  const importSection = /## Import findings([\s\S]*?)(\n## |$)/.exec(report)?.[1] ?? "";
  assert.match(importSection, /events is not what the export carried/);
  const inherited = /## Already present before the run started([\s\S]*?)(\n## |$)/.exec(report)?.[1] ?? "";
  assert.doesNotMatch(inherited, /not what the export carried/);
});

test("--check-exports opens every export in the folder without playing, and says how each went", { skip }, () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "oh-check-exports-"));
  try {
    for (const name of ["null-events", "hub-map"]) fs.copyFileSync(path.join(exportsDir, `${name}.zip`), path.join(folder, `${name}.zip`));
    fs.mkdirSync(path.join(folder, "harness"));
    fs.copyFileSync(roundTripZip(), path.join(folder, "harness", "round-trip.zip"));

    const { code, out } = run(["--check-exports"], { env: { OH_HARNESS_EXPORTS_DIR: folder } });
    assert.equal(code, 1, `an Import finding fails the check:\n${out}`);
    assert.match(out, /Checked 3 Game exports/);
    assert.match(out, /^\s+harness\/round-trip\s+opens · import ok · 1 Roll-back point · scenario: embedded · \d+ findings already in the Save$/m);
    assert.match(out, /^\s+null-events\s+opens · 1 IMPORT FINDING/m);
    assert.match(out, /^\s+hub-map\s+opens · import ok · 1 Roll-back point · scenario: hub-skipped/m);
    assert.doesNotMatch(out, /downloading/, "a quick check never downloads a hub map");
    assert.match(out, /turns played: 0/i);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test("--levels lists the Game exports beside the Real saves", { skip }, () => {
  const { code, out } = run(["--levels"], { targetFlags: [] });
  assert.equal(code, 0, out);
  assert.match(out, /Game exports to open with --save-zip <name>/);
  assert.match(out, /^\s+harness\/round-trip$/m);
});

test("--help and --list point at the new options", () => {
  const help = run(["--help"], { targetFlags: [] }).out;
  for (const flag of ["--save-zip", "--no-embedded-scenario", "--no-hub", "--check-exports"]) assert.ok(help.includes(flag), flag);
  const list = run(["--list"], { targetFlags: [] });
  assert.equal(list.code, 0, list.out);
  assert.match(list.out, /^\s+export-round-trip$/m);
  assert.match(list.out, /--save-zip/);
});

test("a file that is not a zip is refused by name", { skip }, () => {
  const file = path.join(exportsDir, "notes.txt");
  fs.writeFileSync(file, "OPEN HISTORIA — DIAGNOSTICS LOG\n");
  assertRefused(run(["smoke", "--save-zip", file]), file, /not a zip file/);
});

test("a name with no export behind it is refused, saying where it looked", { skip }, () => {
  const result = run(["smoke", "--save-zip", "no-such-game"]);
  assert.equal(result.code, 2, result.out);
  assert.match(result.out, /No Game export called "no-such-game"/);
  assert.ok(result.out.includes(exportsDir), result.out);
});

test("a zip with no game.json is refused by name", { skip }, async () => {
  const file = await makeVariant("scenario-only", (entries) => delete entries["game.json"]);
  assertRefused(run(["smoke", "--save-zip", file]), file, /missing game\.json/);
});

test("a Game bundle in a schema the game does not accept is refused by name", { skip }, async () => {
  const file = await makeVariant("future-schema", editBundle((bundle) => { bundle.schema = "open-historia-game-bundle/99"; }));
  assertRefused(run(["smoke", "--save-zip", file]), file, /Unsupported game bundle schema/);
});

test("a zip whose JSON is damaged is refused by name", { skip }, async () => {
  const file = await makeVariant("damaged", (entries) => {
    entries["game.json"] = entries["game.json"].slice(0, 200);
  });
  assertRefused(run(["smoke", "--save-zip", file]), file, /damaged/);
});

test("--save-zip cannot be combined with another Save", { skip }, () => {
  const { code, out } = run(["smoke", "--save-zip", "harness/round-trip", "--fixture", "modern-day-session"]);
  assert.equal(code, 2, out);
  assert.match(out, /cannot be combined with --saves or --fixture/);
});

test("a target that predates Game exports stops with exit 5, naming the branch to use", { skip }, () => {
  const { dir: oldGame } = makeFakeGameRepo(fs.mkdtempSync(path.join(os.tmpdir(), "oh-old-game-")));
  try {
    const { code, out } = run(["smoke", "--save-zip", "harness/round-trip", "--repo", oldGame], { targetFlags: [] });
    assert.equal(code, 5, out);
    assert.match(out, /cannot import Game exports/);
    assert.match(out, /--branch upstream\/beta/);
  } finally {
    fs.rmSync(oldGame, { recursive: true, force: true });
  }
});
