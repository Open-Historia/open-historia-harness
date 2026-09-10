// Where the harness keeps things: its sandbox, runs/ and scenarios/.
//
// All three hang off import.meta.url, which is a URL, not a path. Reading it
// through `new URL(import.meta.url).pathname` kept the URL encoding, so a
// checkout under "C:\Users\Some Name" went looking in "C:\Users\Some%20Name":
// --list found no scenarios, every run stopped before it started, and
// createSession failed with EPERM creating a sandbox in a folder that does not
// exist. fileURLToPath decodes.
//
// A checkout whose path needs no encoding cannot show the bug, so the second
// test copies lib/ into a folder whose name does, and loads it from there.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as runner from "./runner.js";
import * as session from "./session.js";
import * as target from "./target.js";

const LIB = path.dirname(fileURLToPath(import.meta.url));
let root;

before(() => {
  // A space, a percent sign and a hash: each is spelled differently in a file
  // URL than on disk.
  root = fs.mkdtempSync(path.join(os.tmpdir(), "oh roots 100% #"));
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const assertRootsIn = (modules, harness) => {
  assert.equal(modules.runner.HARNESS_ROOT, harness);
  assert.equal(modules.target.HARNESS_ROOT, harness);
  assert.equal(modules.runner.RUNS_DIR, path.join(harness, "runs"));
  assert.equal(modules.runner.SCENARIOS_DIR, path.join(harness, "scenarios"));
  assert.equal(modules.session.DEFAULT_SANDBOX_ROOT, path.join(harness, "sandbox"));
};

test("the roots are this checkout's own directories", () => {
  assertRootsIn({ runner, session, target }, path.dirname(LIB));
});

test("a checkout under a path with a space, % or # still finds its own directories", async () => {
  const lib = path.join(root, "lib");
  fs.cpSync(LIB, lib, { recursive: true, filter: (source) => !source.endsWith(".test.js") });
  const load = (file) => import(pathToFileURL(path.join(lib, file)).href);

  // Node loads a module from its real path, so compare against that: on macOS
  // the temp dir sits behind a symlink (/var -> /private/var).
  assertRootsIn(
    { runner: await load("runner.js"), session: await load("session.js"), target: await load("target.js") },
    fs.realpathSync(root),
  );
});
