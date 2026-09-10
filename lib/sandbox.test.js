// Seeding, and the trick that makes it cheap.
//
// The load-bearing claim is that a sandbox needs none of the 55 MB
// regions.geojson, because a scenario NOT called "default" routes the geojson
// lookup down a branch that finds nothing. That is a claim about the game's own
// libraryStore, so it is tested against the real server rather than reasoned
// about — which means booting it, once, for the whole file.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

import { createSandbox, resolveSeedSource, SANDBOX_GAME_ID, SANDBOX_SCENARIO_ID } from "./sandbox.js";
import { configureSafety, installFsGuard, resetSafety, uninstallFsGuard } from "./safety.js";
import { startServer } from "./server.js";
import { DEFAULT_GAME_REPO, looksLikeGameRepo, resolveTarget } from "./target.js";

const available = fs.existsSync(DEFAULT_GAME_REPO) && looksLikeGameRepo(DEFAULT_GAME_REPO);

let sandboxRoot;
let target;
let sandbox;
let server;

before(async (t) => {
  if (!available) return;
  sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), "oh-sandbox-test-"));
  configureSafety({ sandbox: sandboxRoot, protect: [DEFAULT_GAME_REPO] });
  target = resolveTarget({});
  installFsGuard();
  sandbox = createSandbox({ target });
  server = await startServer({ target, sandbox });
});

after(async () => {
  await server?.stop();
  uninstallFsGuard();
  sandbox?.dispose();
  resetSafety();
  if (sandboxRoot) fs.rmSync(sandboxRoot, { recursive: true, force: true });
});

const api = async (route) => {
  const response = await fetch(`${server.baseUrl}${route}`);
  return { status: response.status, body: await response.json() };
};

test("the seed is small — no 55 MB geojson anywhere in it", { skip: !available }, () => {
  const sizeOf = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).reduce((total, entry) => {
      const full = path.join(dir, entry.name);
      return total + (entry.isDirectory() ? sizeOf(full) : fs.statSync(full).size);
    }, 0);

  const bytes = sizeOf(sandbox.dataDir);
  assert.ok(bytes < 2_000_000, `the seeded data dir should be well under 2 MB, was ${bytes}`);
  assert.equal(fs.existsSync(path.join(sandbox.scenarioDir, "regions.geojson")), false);
});

test("stock geometry turns OFF customRegions in the seeded world", { skip: !available }, () => {
  // The real seed world declares customRegions:true. Leaving that set while the
  // server serves an empty FeatureCollection would be an incoherent state to test
  // against — the world claims geometry that does not exist.
  const source = JSON.parse(fs.readFileSync(path.join(resolveSeedSource(target), "world.json"), "utf8"));
  assert.equal(source.customRegions, true, "the upstream seed still declares custom regions");

  const seeded = JSON.parse(fs.readFileSync(path.join(sandbox.scenarioDir, "world.json"), "utf8"));
  assert.equal(seeded.customRegions, false);
  assert.equal(
    Object.keys(seeded.regionOwnershipOverrides).length,
    Object.keys(source.regionOwnershipOverrides).length,
    "ownership is preserved — only the geometry flag changed",
  );
});

test("the server resolves DATA_DIR into the sandbox", { skip: !available }, () => {
  // startServer asserts this too; restating it here is the point of the test.
  assert.equal(path.resolve(server.dataDir), path.resolve(sandbox.dataDir));
  assert.ok(server.port > 0, "an ephemeral port was allocated");
});

test("the library lists exactly the harness scenario and its game", { skip: !available }, async () => {
  const { status, body } = await api("/api/library");
  assert.equal(status, 200);

  assert.deepEqual(
    (body.scenarios ?? []).map((s) => s.id),
    [SANDBOX_SCENARIO_ID],
    "no `default` scenario may be seeded behind our back",
  );
  assert.deepEqual((body.games ?? []).map((g) => g.id), [SANDBOX_GAME_ID]);
});

test("the seeded game is active, so the first READ works", { skip: !available }, async () => {
  // Without a seeded game every read 404s until something writes, because the
  // server only auto-creates a game on the write path. That made the first read of
  // a run behave differently from every read after it.
  const { status, body } = await api("/api/runtime/json/game");
  assert.equal(status, 200);
  assert.equal(body.gameDate, "2016-01-01");
  assert.equal(sandbox.gameId, SANDBOX_GAME_ID);
});

test("regionsGeojson returns an EMPTY collection, instantly", { skip: !available }, async () => {
  // This is the whole cheap-seeding trick: scenario id !== "default" takes the
  // borrow-Modern-Day branch (libraryStore.js:2271), finds no default scenario in
  // the sandbox, and returns empty instead of reading 55 MB off disk.
  const started = Date.now();
  const { status, body } = await api("/api/runtime/json/regionsGeojson");
  const elapsed = Date.now() - started;

  assert.equal(status, 200);
  assert.equal(body.type, "FeatureCollection");
  assert.deepEqual(body.features, []);
  assert.ok(elapsed < 1000, `should be instant, took ${elapsed}ms`);
});

test("world and game read back through the real routes", { skip: !available }, async () => {
  const world = await api("/api/runtime/json/world");
  assert.equal(world.status, 200);
  assert.ok(
    Object.keys(world.body.regionOwnershipOverrides ?? {}).length > 3000,
    "the real Modern Day ownership map is present, so region assertions have something to bite on",
  );

  const game = await api("/api/runtime/json/game");
  assert.equal(game.status, 200);
  assert.equal(game.body.gameDate, "2016-01-01");
});

test("prompts.json is the REAL prompt pack, not a stub", { skip: !available }, async () => {
  // AI-quality results are meaningless if the harness plays with different
  // prompts than the game ships.
  const { status, body } = await api("/api/runtime/json/prompts");
  assert.equal(status, 200);
  assert.ok(Object.keys(body).length > 5, "the seeded pack should carry the real task prompts");
});

test("writes land in the sandbox and nowhere else", { skip: !available }, async () => {
  const response = await fetch(`${server.baseUrl}/api/runtime/json/events`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify([{ id: "e1", title: "harness wrote this" }]),
  });
  assert.equal(response.status, 200);

  const { body } = await api("/api/runtime/json/events");
  assert.equal(body[0].title, "harness wrote this");

  // And the real scenario seed it was copied from is untouched.
  const sourceEvents = fs.readFileSync(path.join(resolveSeedSource(target), "storage/events.json"), "utf8");
  assert.doesNotMatch(sourceEvents, /harness wrote this/);
});

test("dispose removes the run directory", { skip: !available }, () => {
  const second = createSandbox({ target });
  const dir = second.dir;
  assert.equal(fs.existsSync(dir), true);
  second.dispose();
  assert.equal(fs.existsSync(dir), false);
});

test("an unknown fixture says where the real saves live", { skip: !available }, () => {
  assert.throws(
    () => createSandbox({ target, fixture: "no-such-save" }),
    /no fixture save at .*server.data.games/s,
  );
});
