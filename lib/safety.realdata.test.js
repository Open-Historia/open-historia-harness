// The test that actually proves it.
//
// Everything else in safety.test.js checks the guard in isolation. This one runs a
// FULL session against the real game repo — boot, turns, a GM-style world write,
// unit deploy, rollback — and fingerprints Mark's real save directory before and
// after. If a single byte, size or mtime moves, it fails.
//
// A test server pointed at the real data directory destroyed a player's rollback
// snapshots on this machine once. This is the test I would point at if that fear
// ever came back.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { after, before } from "node:test";

import { createDriver } from "./driver.js";
import { createSession, DEFAULT_SANDBOX_ROOT } from "./session.js";
import { DEFAULT_GAME_REPO, looksLikeGameRepo } from "./target.js";

const REAL_DATA = path.join(DEFAULT_GAME_REPO, "server", "data");
const available = fs.existsSync(DEFAULT_GAME_REPO) && looksLikeGameRepo(DEFAULT_GAME_REPO);
const hasSaves = available && fs.existsSync(path.join(REAL_DATA, "games"));

/** Every file under a tree, with its size and modification time. */
const fingerprint = (dir) => {
  const entries = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      const stats = fs.statSync(full);
      entries.push(`${path.relative(dir, full)}\t${stats.size}\t${stats.mtimeMs}`);
    }
  };
  walk(dir);
  return entries.sort().join("\n");
};

let session;

after(async () => {
  await session?.dispose();
});

test(
  "a full --no-ai session leaves the real save directory byte-identical",
  { skip: !hasSaves ? "no real saves to protect on this machine" : false },
  async () => {
    const before = fingerprint(REAL_DATA);
    const savedGames = fs.readdirSync(path.join(REAL_DATA, "games"));
    assert.ok(savedGames.length > 0, "there are real saves here to protect");

    // ONE session for the whole file. server.js starts on import and is cached
    // per process, so a second createSession here would find a closed listener
    // whose 'listening' event can never fire again.
    session = await createSession({
      ai: "off",
      sandboxRoot: DEFAULT_SANDBOX_ROOT,
      quiet: true,
    });
    const { game, world, units } = await createDriver(session);

    // Belt and braces, while the session is live: prove the fence is actually UP,
    // not merely that nothing happened to try it.
    const victim = path.join(REAL_DATA, "harness-should-never-write-this.json");
    assert.throws(() => fs.writeFileSync(victim, "{}"), /harness safety/);
    assert.equal(fs.existsSync(victim), false);

    // Exercise every write path the harness has: turns, a direct world write,
    // unit deployment, and a rollback.
    await game.turn(30);
    await world.setOwner("RUS.3_1", "France");
    await units.sync();
    await units.deploy({ type: "infantry", strength: 100, name: "Fingerprint Brigade", lng: 2.35, lat: 48.87 });
    await game.turn(30);
    const snapshots = await game.snapshots();
    if (Array.isArray(snapshots) && snapshots.length) await game.rollback(0);

    await session.dispose();
    session = null;

    const after = fingerprint(REAL_DATA);
    assert.equal(after, before, "the harness must not touch server/data");
  },
);
