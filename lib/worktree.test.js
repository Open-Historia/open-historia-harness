// Worktrees are the only thing the harness creates inside Mark's game repo, so
// the tests that matter most here are the ones proving it puts the repo back:
// the shared node_modules survives, and `git worktree list` ends where it began.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, afterEach, before } from "node:test";

import { runGit } from "./git.js";
import {
  configureSafety,
  installFsGuard,
  resetSafety,
  uninstallFsGuard,
} from "./safety.js";
import { makeFakeGameRepo } from "./testRepo.js";
import {
  compareLockfiles,
  ensureWorktree,
  linkSharedNodeModules,
  listWorktrees,
  pruneWorktrees,
  removeLink,
  removeWorktree,
  worktreeDirFor,
} from "./worktree.js";

let root;
let gameRepo;
let sandboxRoot;
let repo;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "oh-worktree-test-"));
  gameRepo = path.join(root, "game-repo");
  sandboxRoot = path.join(root, "sandbox");
  repo = makeFakeGameRepo(gameRepo);
  configureSafety({ sandbox: sandboxRoot, protect: [gameRepo] });
});

afterEach(() => {
  uninstallFsGuard();
});

after(() => {
  pruneWorktrees({ gameRepo, sandboxRoot });
  resetSafety();
  fs.rmSync(root, { recursive: true, force: true });
});

test("ensureWorktree checks out the requested sha, detached", () => {
  const { dir, reused } = ensureWorktree({
    gameRepo,
    ref: repo.otherBranch,
    sha: repo.otherSha,
    sandboxRoot,
  });

  assert.equal(reused, false);
  assert.equal(runGit(dir, ["rev-parse", "HEAD"]), repo.otherSha);
  // Detached, so the branch stays available in the main checkout.
  assert.equal(runGit(dir, ["rev-parse", "--abbrev-ref", "HEAD"]), "HEAD");
  assert.match(fs.readFileSync(path.join(dir, "src/Game/AI/gameplay.js"), "utf8"), /changed: true/);
});

test("ensureWorktree reuses an existing checkout at the same sha", () => {
  const first = ensureWorktree({ gameRepo, ref: repo.otherBranch, sha: repo.otherSha, sandboxRoot });
  const second = ensureWorktree({ gameRepo, ref: repo.otherBranch, sha: repo.otherSha, sandboxRoot });

  assert.equal(second.dir, first.dir);
  assert.equal(second.reused, true, "an unchanged branch must not pay to check out again");
});

test("ensureWorktree with fresh:true rebuilds the checkout", () => {
  const { dir } = ensureWorktree({ gameRepo, ref: repo.otherBranch, sha: repo.otherSha, sandboxRoot });
  const marker = path.join(dir, "scribble.txt");
  fs.writeFileSync(marker, "left over from a previous run");

  const again = ensureWorktree({
    gameRepo,
    ref: repo.otherBranch,
    sha: repo.otherSha,
    sandboxRoot,
    fresh: true,
  });

  assert.equal(again.reused, false);
  assert.equal(fs.existsSync(marker), false, "a fresh worktree must not inherit stale files");
});

test("the worktree path is keyed by sha, so two commits never collide", () => {
  const a = worktreeDirFor({ sandboxRoot, ref: "main", sha: repo.mainSha });
  const b = worktreeDirFor({ sandboxRoot, ref: "main", sha: repo.otherSha });
  assert.notEqual(a, b);
});

test("linkSharedNodeModules junctions rather than copies", () => {
  const { dir } = ensureWorktree({ gameRepo, ref: repo.otherBranch, sha: repo.otherSha, sandboxRoot });
  const result = linkSharedNodeModules({ gameRepo, worktreeDir: dir });

  assert.equal(result.linked, true);
  const dest = path.join(dir, "node_modules");
  assert.equal(fs.lstatSync(dest).isSymbolicLink(), true, "it must be a link, not 790 MB of copy");
  assert.match(fs.readFileSync(path.join(dest, "fake-dep", "index.js"), "utf8"), /shared/);
});

test("removeLink drops the junction and LEAVES THE SHARED MODULES INTACT", () => {
  // The 790 MB question. If this is ever wrong, cleaning up after a run destroys
  // the main checkout's dependencies.
  const { dir } = ensureWorktree({ gameRepo, ref: repo.otherBranch, sha: repo.otherSha, sandboxRoot });
  linkSharedNodeModules({ gameRepo, worktreeDir: dir });

  removeLink(path.join(dir, "node_modules"));

  assert.equal(fs.existsSync(path.join(dir, "node_modules")), false, "the link is gone");
  assert.equal(
    fs.readFileSync(path.join(gameRepo, "node_modules", "fake-dep", "index.js"), "utf8").trim(),
    "export default 'shared';",
    "the real node_modules must survive untouched",
  );
});

test("removeLink refuses to delete a real directory", () => {
  const realDir = path.join(sandboxRoot, "not-a-link");
  fs.mkdirSync(realDir, { recursive: true });
  assert.throws(() => removeLink(realDir), /it is a real directory, not a link/);
});

test("linkSharedNodeModules refuses to run once the fs guard is up", () => {
  const { dir } = ensureWorktree({ gameRepo, ref: repo.mainBranch, sha: repo.mainSha, sandboxRoot });
  removeLink(path.join(dir, "node_modules"));

  installFsGuard();
  assert.throws(
    () => linkSharedNodeModules({ gameRepo, worktreeDir: dir }),
    /must run BEFORE installFsGuard/,
    "the one link into the game repo is only legitimate during setup",
  );
});

test("removeWorktree leaves the game repo's worktree list exactly as it was", () => {
  // Start from a known list: earlier tests leave worktrees registered, and a
  // reused checkout would not change the count at all.
  pruneWorktrees({ gameRepo, sandboxRoot });
  const before = listWorktrees(gameRepo);

  const { dir } = ensureWorktree({ gameRepo, ref: repo.otherBranch, sha: repo.otherSha, sandboxRoot });
  linkSharedNodeModules({ gameRepo, worktreeDir: dir });
  assert.equal(listWorktrees(gameRepo).length, before.length + 1, "the worktree registered");

  removeWorktree({ gameRepo, dir });

  assert.equal(fs.existsSync(dir), false);
  assert.deepEqual(listWorktrees(gameRepo), before, "no stranded worktree in the game repo");
  assert.equal(fs.existsSync(path.join(gameRepo, "node_modules", "fake-dep")), true);
});

test("removeWorktree is safe to call twice", () => {
  const { dir } = ensureWorktree({ gameRepo, ref: repo.mainBranch, sha: repo.mainSha, sandboxRoot });
  assert.equal(removeWorktree({ gameRepo, dir }), true);
  assert.equal(removeWorktree({ gameRepo, dir }), true, "recovery may re-run this after a crash");
});

test("pruneWorktrees clears everything and can keep one", () => {
  const a = ensureWorktree({ gameRepo, ref: repo.mainBranch, sha: repo.mainSha, sandboxRoot });
  const b = ensureWorktree({ gameRepo, ref: repo.otherBranch, sha: repo.otherSha, sandboxRoot });

  pruneWorktrees({ gameRepo, sandboxRoot, keep: [b.dir] });

  assert.equal(fs.existsSync(a.dir), false);
  assert.equal(fs.existsSync(b.dir), true, "the live run's own worktree is kept");

  pruneWorktrees({ gameRepo, sandboxRoot });
  assert.equal(fs.existsSync(b.dir), false);
});

test("a worktree path outside the sandbox is refused", () => {
  assert.throws(
    () => ensureWorktree({ gameRepo, ref: "main", sha: repo.mainSha, sandboxRoot: path.join(root, "elsewhere") }),
    /outside the sandbox/,
  );
});

test("compareLockfiles reports a mismatch between branch and main checkout", () => {
  const { dir } = ensureWorktree({ gameRepo, ref: repo.mainBranch, sha: repo.mainSha, sandboxRoot });
  assert.deepEqual(compareLockfiles({ gameRepo, worktreeDir: dir }), { comparable: true, matches: true });

  fs.writeFileSync(path.join(dir, "package-lock.json"), '{"lockfileVersion":3,"changed":true}');
  assert.deepEqual(compareLockfiles({ gameRepo, worktreeDir: dir }), { comparable: true, matches: false });
});
