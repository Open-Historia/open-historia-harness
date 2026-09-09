// The guard everything else sits behind, so it is tested for the ways containment
// checks actually leak rather than only the happy path: prefix collisions,
// Windows case variants, traversal, and cross-drive paths.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { afterEach, before, after } from "node:test";

import {
  assertSandboxed,
  configureSafety,
  copyIn,
  installFsGuard,
  isFsGuardInstalled,
  isInside,
  isSandboxed,
  resetSafety,
  uninstallFsGuard,
} from "./safety.js";

let root;
let sandboxDir;
let protectedDir;
let protectedFile;
let outsideDir;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "oh-safety-test-"));
  sandboxDir = path.join(root, "sandbox");
  protectedDir = path.join(root, "game-repo");
  outsideDir = path.join(root, "elsewhere");
  fs.mkdirSync(protectedDir, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
  protectedFile = path.join(protectedDir, "world.json");
  fs.writeFileSync(protectedFile, '{"real":"save"}');

  configureSafety({ sandbox: sandboxDir, protect: [protectedDir] });
});

afterEach(() => {
  // No test may leak a patched fs into the next one.
  uninstallFsGuard();
});

after(() => {
  resetSafety();
  fs.rmSync(root, { recursive: true, force: true });
});

test("isInside treats a directory as inside itself", () => {
  assert.equal(isInside(sandboxDir, sandboxDir), true);
});

test("isInside accepts a nested path and rejects a parent", () => {
  assert.equal(isInside(path.join(sandboxDir, "a", "b.json"), sandboxDir), true);
  assert.equal(isInside(root, sandboxDir), false);
});

test("isInside rejects a prefix collision", () => {
  // The bug a startsWith() check would let straight through: a SIBLING whose
  // name merely begins with the root's name.
  assert.equal(isInside(`${sandboxDir}-evil`, sandboxDir), false);
  assert.equal(isInside(path.join(`${sandboxDir}-evil`, "x.json"), sandboxDir), false);
});

test("isInside rejects traversal back out of the root", () => {
  assert.equal(isInside(path.join(sandboxDir, "..", "elsewhere", "x"), sandboxDir), false);
  assert.equal(isInside(path.join(sandboxDir, "a", "..", "..", "x"), sandboxDir), false);
});

test("isInside accepts a child whose name merely starts with dots", () => {
  // ".." is traversal; "..hidden" is an ordinary file and must not be confused
  // with it.
  assert.equal(isInside(path.join(sandboxDir, "..hidden"), sandboxDir), true);
});

test("isInside is case-insensitive on Windows only", { skip: process.platform !== "win32" }, () => {
  assert.equal(isInside(sandboxDir.toUpperCase(), sandboxDir.toLowerCase()), true);
  assert.equal(isInside(path.join(sandboxDir.toUpperCase(), "A.JSON"), sandboxDir), true);
});

test("isInside rejects a different drive", { skip: process.platform !== "win32" }, () => {
  const otherDrive = sandboxDir.startsWith("C:") ? sandboxDir.replace(/^C:/i, "D:") : "C:\\x";
  assert.equal(isInside(otherDrive, sandboxDir), false);
});

test("assertSandboxed allows a path inside the sandbox", () => {
  const target = path.join(sandboxDir, "run-1", "world.json");
  assert.equal(assertSandboxed(target), path.resolve(target));
});

test("assertSandboxed refuses the protected tree by name", () => {
  assert.throws(
    () => assertSandboxed(protectedFile, "test write"),
    /inside a protected tree/,
    "a write into the real save dir must be refused",
  );
  assert.throws(() => assertSandboxed(protectedDir), /inside a protected tree/);
});

test("assertSandboxed refuses a path outside the sandbox", () => {
  assert.throws(() => assertSandboxed(path.join(outsideDir, "x.json")), /outside the sandbox/);
});

test("assertSandboxed refuses traversal out of the sandbox", () => {
  const escape = path.join(sandboxDir, "..", "game-repo", "world.json");
  assert.throws(() => assertSandboxed(escape), /protected tree|outside the sandbox/);
});

test("isSandboxed answers without throwing", () => {
  assert.equal(isSandboxed(path.join(sandboxDir, "ok.json")), true);
  assert.equal(isSandboxed(protectedFile), false);
});

test("configureSafety refuses a sandbox nested inside a protected tree", () => {
  // Restored by the outer configureSafety call at the end, so later tests still
  // see the shared configuration.
  assert.throws(
    () => configureSafety({ sandbox: path.join(protectedDir, "sandbox"), protect: [protectedDir] }),
    /sandbox root is inside a protected tree/,
  );
  configureSafety({ sandbox: sandboxDir, protect: [protectedDir] });
});

test("the fs guard blocks a write into the protected tree", () => {
  installFsGuard();
  assert.equal(isFsGuardInstalled(), true);

  assert.throws(
    () => fs.writeFileSync(protectedFile, "clobbered"),
    /harness safety/,
    "writeFileSync into server/data must throw once guarded",
  );
  assert.throws(() => fs.rmSync(protectedFile), /harness safety/);
  assert.throws(() => fs.unlinkSync(protectedFile), /harness safety/);
  assert.throws(() => fs.mkdirSync(path.join(protectedDir, "new")), /harness safety/);

  assert.equal(fs.readFileSync(protectedFile, "utf8"), '{"real":"save"}', "the file is untouched");
});

test("the fs guard allows writes inside the sandbox", () => {
  installFsGuard();
  const target = path.join(sandboxDir, "allowed.json");
  fs.mkdirSync(sandboxDir, { recursive: true });
  fs.writeFileSync(target, "ok");
  assert.equal(fs.readFileSync(target, "utf8"), "ok");
});

test("the fs guard leaves reads of the protected tree alone", () => {
  installFsGuard();
  // Seeding depends on this: the source of a copy is read, never written.
  assert.equal(fs.readFileSync(protectedFile, "utf8"), '{"real":"save"}');
  assert.doesNotThrow(() => fs.statSync(protectedFile));
  assert.doesNotThrow(() => fs.readdirSync(protectedDir));
});

test("the fs guard blocks a rename whose SOURCE is protected", () => {
  installFsGuard();
  // rename destroys the source, so guarding only the destination would let a
  // real save be moved out from under the game.
  assert.throws(
    () => fs.renameSync(protectedFile, path.join(sandboxDir, "stolen.json")),
    /harness safety/,
  );
  assert.equal(fs.existsSync(protectedFile), true);
});

test("the fs guard blocks a hard link or symlink pointing INTO the protected tree", () => {
  installFsGuard();
  // This is the regions.geojson hazard: a link into real data turns a later
  // innocent write in the sandbox into an in-place truncation of the original.
  assert.throws(
    () => fs.linkSync(protectedFile, path.join(sandboxDir, "aliased.json")),
    /harness safety/,
  );
  assert.throws(
    () => fs.symlinkSync(protectedFile, path.join(sandboxDir, "linked.json")),
    /harness safety/,
  );
});

test("copyIn reads from the protected tree and writes into the sandbox", () => {
  installFsGuard();
  // The one-way seeding path has to keep working with the guard installed,
  // otherwise the sandbox cannot be built at all.
  const dest = copyIn(protectedFile, path.join(sandboxDir, "seeded", "world.json"));
  assert.equal(fs.readFileSync(dest, "utf8"), '{"real":"save"}');
});

test("copyIn still refuses a destination outside the sandbox", () => {
  installFsGuard();
  assert.throws(
    () => copyIn(protectedFile, path.join(protectedDir, "copy.json")),
    /harness safety/,
  );
});

test("the fs guard covers fs.promises, and REJECTS rather than throwing", async () => {
  installFsGuard();

  // The shape matters as much as the refusal: a caller doing
  // `fs.promises.writeFile(...).catch(handle)` must get its rejection, not a
  // synchronous throw from a line that never throws in the real API.
  const promise = fs.promises.writeFile(protectedFile, "clobbered");
  assert.ok(promise instanceof Promise, "the guard must still return a promise");
  await assert.rejects(promise, /harness safety/);

  await assert.rejects(fs.promises.rm(protectedFile), /harness safety/);
  await assert.doesNotReject(fs.promises.writeFile(path.join(sandboxDir, "p.json"), "ok"));
  assert.equal(fs.readFileSync(protectedFile, "utf8"), '{"real":"save"}', "the file is untouched");
});

test("the fs guard rejects a promise-form open() with write flags", async () => {
  installFsGuard();
  await assert.rejects(fs.promises.open(protectedFile, "w"), /harness safety/);

  const handle = await fs.promises.open(protectedFile, "r");
  await handle.close();
});

test("the fs guard only blocks open() when the flags ask to write", async () => {
  installFsGuard();
  assert.throws(() => fs.openSync(protectedFile, "w"), /harness safety/);
  assert.throws(() => fs.openSync(protectedFile, "a"), /harness safety/);

  // A read open of protected data is exactly what seeding does.
  const fd = fs.openSync(protectedFile, "r");
  fs.closeSync(fd);
});

test("uninstalling restores the real fs", () => {
  installFsGuard();
  uninstallFsGuard();
  assert.equal(isFsGuardInstalled(), false);

  // Prove the wrapper is gone by writing somewhere it would have refused, then
  // putting the file back exactly as it was.
  const scratch = path.join(outsideDir, "restored.json");
  fs.writeFileSync(scratch, "ok");
  assert.equal(fs.readFileSync(scratch, "utf8"), "ok");
  fs.rmSync(scratch);
});
