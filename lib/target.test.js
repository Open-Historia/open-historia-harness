// What a run says it tested. A report whose target is ambiguous — which branch,
// which commit, were there uncommitted edits — is worse than no report, so the
// identity this module produces is asserted rather than assumed.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

import { configureSafety, resetSafety } from "./safety.js";
import {
  DEFAULT_GAME_REPO,
  findGameRepo,
  looksLikeGameRepo,
  readGitInfo,
  resolveTarget,
} from "./target.js";
import { makeFakeGameRepo } from "./testRepo.js";
import { pruneWorktrees } from "./worktree.js";

let root;
let gameRepo;
let sandboxRoot;
let repo;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "oh-target-test-"));
  gameRepo = path.join(root, "game-repo");
  sandboxRoot = path.join(root, "sandbox");
  repo = makeFakeGameRepo(gameRepo);
  configureSafety({ sandbox: sandboxRoot, protect: [gameRepo] });
});

after(() => {
  pruneWorktrees({ gameRepo, sandboxRoot });
  resetSafety();
  fs.rmSync(root, { recursive: true, force: true });
});

test("looksLikeGameRepo needs the markers AND the package name", () => {
  assert.equal(looksLikeGameRepo(gameRepo), true);

  const impostor = path.join(root, "impostor");
  fs.mkdirSync(path.join(impostor, "server"), { recursive: true });
  fs.mkdirSync(path.join(impostor, "src/Game/AI"), { recursive: true });
  fs.writeFileSync(path.join(impostor, "server/server.js"), "");
  fs.writeFileSync(path.join(impostor, "src/Game/AI/gameplay.js"), "");
  fs.writeFileSync(path.join(impostor, "package.json"), JSON.stringify({ name: "something-else" }));

  assert.equal(looksLikeGameRepo(impostor), false, "the markers alone are not enough");
});

test("findGameRepo explains what to do when the path is wrong", () => {
  assert.throws(() => findGameRepo(path.join(root, "nope")), /Pass --repo <path>/);
  assert.throws(() => findGameRepo(root), /does not look like the Open Historia repo/);
});

test("findGameRepo defaults to the sibling checkout", () => {
  // The real one, next to this repo. This is the path every ordinary run uses.
  assert.equal(fs.existsSync(DEFAULT_GAME_REPO), true, `expected the game repo at ${DEFAULT_GAME_REPO}`);
  assert.equal(findGameRepo(), DEFAULT_GAME_REPO);
});

test("readGitInfo reports sha, branch and cleanliness", () => {
  const info = readGitInfo(gameRepo);
  assert.equal(info.sha, repo.mainSha);
  assert.equal(info.shortSha, repo.mainSha.slice(0, 7));
  assert.equal(info.branch, "main");
  assert.equal(info.dirty, false);
});

test("readGitInfo notices uncommitted changes to tracked files", () => {
  const tracked = path.join(gameRepo, "src/Game/AI/gameplay.js");
  const original = fs.readFileSync(tracked, "utf8");
  fs.writeFileSync(tracked, `${original}\n// scribble\n`);
  try {
    assert.equal(readGitInfo(gameRepo).dirty, true);
  } finally {
    fs.writeFileSync(tracked, original);
  }
  assert.equal(readGitInfo(gameRepo).dirty, false);
});

test("working-tree mode points straight at the checkout and never removes it", () => {
  const target = resolveTarget({ repo: gameRepo });

  assert.equal(target.mode, "working-tree");
  assert.equal(target.path, gameRepo);
  assert.equal(target.branch, "main");
  assert.equal(target.describe(), `working tree (main@${repo.mainSha.slice(0, 7)})`);

  target.release();
  assert.equal(fs.existsSync(gameRepo), true, "release must never touch the real checkout");
});

test("branch mode checks out the ref into the sandbox", () => {
  const target = resolveTarget({ repo: gameRepo, branch: "feature", sandboxRoot });

  assert.equal(target.mode, "worktree");
  assert.equal(target.sha, repo.otherSha);
  assert.equal(target.dirty, false, "a detached worktree at a fixed sha is clean by construction");
  assert.equal(target.describe(), `feature@${repo.otherSha.slice(0, 7)}`);
  assert.notEqual(path.resolve(target.path), path.resolve(gameRepo));
  assert.match(fs.readFileSync(path.join(target.path, "src/Game/AI/gameplay.js"), "utf8"), /changed: true/);

  // The branch source is what we asked for, and node_modules came along shared.
  assert.equal(target.modules.linked, true);
  assert.equal(fs.lstatSync(path.join(target.path, "node_modules")).isSymbolicLink(), true);

  target.release();
  assert.equal(fs.existsSync(target.path), false);
});

test("branch mode resolves a sha as readily as a branch name", () => {
  const target = resolveTarget({ repo: gameRepo, branch: repo.mainSha, sandboxRoot });
  assert.equal(target.sha, repo.mainSha);
  target.release();
});

test("an unknown ref says how to fix it", () => {
  assert.throws(
    () => resolveTarget({ repo: gameRepo, branch: "upstream/does-not-exist", sandboxRoot }),
    /no such ref .* Fetch it first/s,
  );
});

test("release({keep:true}) leaves the worktree for inspection", () => {
  const target = resolveTarget({ repo: gameRepo, branch: "feature", sandboxRoot });
  target.release({ keep: true });
  assert.equal(fs.existsSync(target.path), true);
  target.release();
  assert.equal(fs.existsSync(target.path), false);
});

test("a lockfile mismatch becomes a loud warning, not a silent wrong run", () => {
  // The failure worth shouting about: the run looks valid while exercising the
  // main checkout's dependency versions instead of the branch's.
  const divergent = path.join(root, "divergent-repo");
  const other = makeFakeGameRepo(divergent, { lockfile: '{"lockfileVersion":3,"different":true}' });
  configureSafety({ sandbox: sandboxRoot, protect: [gameRepo, divergent] });

  const target = resolveTarget({ repo: divergent, branch: other.otherBranch, sandboxRoot });
  try {
    // Both lockfiles inside that repo agree, so first prove the clean case.
    assert.equal(target.warnings.length, 0);

    fs.writeFileSync(path.join(target.path, "package-lock.json"), '{"lockfileVersion":3,"branch":true}');
    const again = resolveTarget({ repo: divergent, branch: other.otherBranch, sandboxRoot });
    assert.equal(again.lockfile.matches, false);
    assert.match(again.warnings.join("\n"), /may exercise the wrong dependency versions/);
    assert.match(again.warnings.join("\n"), /--npm-ci/);
  } finally {
    target.release();
    pruneWorktrees({ gameRepo: divergent, sandboxRoot });
    configureSafety({ sandbox: sandboxRoot, protect: [gameRepo] });
  }
});

test("branch mode refuses to write outside the sandbox", () => {
  assert.throws(
    () => resolveTarget({ repo: gameRepo, branch: "feature", sandboxRoot: path.join(root, "not-the-sandbox") }),
    /outside the sandbox/,
  );
});
