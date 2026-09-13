// Finding a Game export by name and checking the file before anything boots.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

import { GameExportError, inspectZipFile, listGameExports, resolveSaveZip } from "./gameExport.js";
import { runWritableRoots } from "./runner.js";
import { assertSandboxed, configureSafety, resetSafety } from "./safety.js";

let dir;
let elsewhere;

// Starts with the zip magic; nothing here parses past it.
const ZIPISH = Buffer.from("PK\x03\x04harness-test", "latin1");

before(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oh-exports-"));
  dir = path.join(root, "game-exports");
  elsewhere = path.join(root, "downloads");
  for (const folder of [path.join(dir, "harness"), elsewhere]) fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(dir, "modern-day-session-game.zip"), ZIPISH);
  fs.writeFileSync(path.join(dir, "notes.txt"), "not an export");
  fs.writeFileSync(path.join(dir, "harness", "round-trip.zip"), ZIPISH);
  fs.writeFileSync(path.join(elsewhere, "attached.zip"), ZIPISH);
  fs.writeFileSync(path.join(elsewhere, "log.txt"), "OPEN HISTORIA — DIAGNOSTICS LOG\n");
});

after(() => fs.rmSync(path.dirname(dir), { recursive: true, force: true }));

test("lists the exports in the folder, the harness's own under harness/", () => {
  assert.deepEqual(listGameExports(dir), ["harness/round-trip", "modern-day-session-game"]);
});

test("an empty or absent folder lists nothing", () => {
  assert.deepEqual(listGameExports(path.join(dir, "nope")), []);
});

test("a short name finds the zip in the folder, with or without .zip", () => {
  const expected = path.join(dir, "modern-day-session-game.zip");
  assert.equal(resolveSaveZip("modern-day-session-game", { dir }), expected);
  assert.equal(resolveSaveZip("modern-day-session-game.zip", { dir }), expected);
});

test("harness/<name> finds a zip the harness made", () => {
  assert.equal(resolveSaveZip("harness/round-trip", { dir }), path.join(dir, "harness", "round-trip.zip"));
});

test("a path to a zip anywhere else is used as it is", () => {
  const file = path.join(elsewhere, "attached.zip");
  assert.equal(resolveSaveZip(file, { dir }), file);
  assert.equal(resolveSaveZip("attached.zip", { dir, cwd: elsewhere }), file);
});

test("an unknown name fails, saying where it looked and what is there", () => {
  assert.throws(
    () => resolveSaveZip("medieval-1200", { dir }),
    (error) =>
      error instanceof GameExportError &&
      error.message.includes("medieval-1200") &&
      error.message.includes(dir) &&
      error.message.includes("modern-day-session-game"),
  );
});

test("inspecting a zip gives its name, size and fingerprint", () => {
  const info = inspectZipFile(path.join(elsewhere, "attached.zip"));
  assert.equal(info.fileName, "attached.zip");
  assert.equal(info.bytes, 16);
  assert.equal(info.sha256, "40321aab055c7e76c826c48ee8ab1ce4ecd5bd3fd9bdbc93701a17978dc1bfbd");
  assert.equal(info.shortSha, "40321aab055c");
});

test("a file that is not a zip is refused by name, before anything boots", () => {
  const file = path.join(elsewhere, "log.txt");
  assert.throws(
    () => inspectZipFile(file),
    (error) => error instanceof GameExportError && error.message.includes(file) && /not a zip/i.test(error.message),
  );
});

test("a run may write its own exports into game-exports/harness/, and nowhere else in game-exports/", () => {
  const previous = process.env.OH_HARNESS_EXPORTS_DIR;
  process.env.OH_HARNESS_EXPORTS_DIR = dir;
  try {
    configureSafety({ sandbox: path.join(path.dirname(dir), "sandbox"), allow: runWritableRoots() });
    assert.doesNotThrow(() => assertSandboxed(path.join(dir, "harness", "round-trip.zip")));
    assert.throws(() => assertSandboxed(path.join(dir, "modern-day-session-game.zip")), /outside the sandbox/);
    assert.throws(() => assertSandboxed(path.join(dir, "harness-evil", "x.zip")), /outside the sandbox/);
  } finally {
    resetSafety();
    if (previous === undefined) delete process.env.OH_HARNESS_EXPORTS_DIR;
    else process.env.OH_HARNESS_EXPORTS_DIR = previous;
  }
});

test("a missing file is refused by name", () => {
  const file = path.join(elsewhere, "gone.zip");
  assert.throws(
    () => inspectZipFile(file),
    (error) => error instanceof GameExportError && error.message.includes(file) && /no such file|does not exist/i.test(error.message),
  );
});
