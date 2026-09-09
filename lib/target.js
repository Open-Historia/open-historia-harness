// Resolving WHAT to test: the working tree as it sits, or any branch via a
// throwaway worktree.
//
// Every report carries the answer this module produces, so a result is never
// ambiguous about which source it came from — including whether the working tree
// had uncommitted changes at the time.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { currentBranch, isDirty, isGitRepo, resolveSha } from "./git.js";
import {
  compareLockfiles,
  ensureWorktree,
  linkSharedNodeModules,
  removeWorktree,
} from "./worktree.js";

export const HARNESS_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..");

/** Files that together mean "this really is the Open Historia game repo". */
export const GAME_MARKERS = ["package.json", "server/server.js", "src/Game/AI/gameplay.js"];

export const DEFAULT_GAME_REPO = path.resolve(HARNESS_ROOT, "..", "open-historia");

export const looksLikeGameRepo = (dir) => {
  if (!GAME_MARKERS.every((marker) => fs.existsSync(path.join(dir, marker)))) return false;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    return pkg.name === "open-historia";
  } catch {
    return false;
  }
};

/**
 * Locate the game repo, failing with a message that says what to do rather than
 * what went wrong.
 */
export const findGameRepo = (explicit) => {
  const candidate = path.resolve(explicit || DEFAULT_GAME_REPO);
  if (!fs.existsSync(candidate)) {
    throw new Error(
      `[harness target] no game repo at ${candidate}. Pass --repo <path>, or clone open-historia ` +
        `next to this one so the default (${DEFAULT_GAME_REPO}) resolves.`,
    );
  }
  if (!looksLikeGameRepo(candidate)) {
    throw new Error(
      `[harness target] ${candidate} does not look like the Open Historia repo ` +
        `(expected ${GAME_MARKERS.join(", ")} and package name "open-historia").`,
    );
  }
  return candidate;
};

/** Commit identity of a checkout, for the report header. */
export const readGitInfo = (dir) => {
  if (!isGitRepo(dir)) return { sha: null, shortSha: null, branch: null, dirty: false };
  const sha = resolveSha(dir, "HEAD");
  return {
    sha,
    shortSha: sha ? sha.slice(0, 7) : null,
    branch: currentBranch(dir),
    dirty: isDirty(dir),
  };
};

const describeTarget = (target) => {
  const at = target.shortSha ? `@${target.shortSha}` : "";
  if (target.mode === "worktree") return `${target.ref}${at}`;
  const branch = target.branch ? ` (${target.branch}${at})` : at;
  return `working tree${branch}${target.dirty ? ", dirty" : ""}`;
};

/**
 * Resolve a target to a directory the harness can import game source from.
 *
 * MUST run after configureSafety() (the worktree path is asserted) and BEFORE
 * installFsGuard() — linkSharedNodeModules enforces the second half, since that
 * is the one link pointing into the game repo.
 *
 * Returns a target object with a release() that puts the game repo back exactly
 * as it was found.
 */
export const resolveTarget = ({
  repo,
  branch = null,
  sandboxRoot,
  fresh = false,
  linkModules = true,
} = {}) => {
  const gameRepo = findGameRepo(repo);

  if (!branch) {
    const info = readGitInfo(gameRepo);
    const target = {
      mode: "working-tree",
      path: gameRepo,
      gameRepo,
      ref: info.branch ?? "HEAD",
      ...info,
      reused: false,
      lockfile: { comparable: false, matches: null },
      release: () => {},
    };
    target.describe = () => describeTarget(target);
    return target;
  }

  if (!sandboxRoot) throw new Error("[harness target] branch mode needs a sandboxRoot");

  const sha = resolveSha(gameRepo, branch);
  if (!sha) {
    throw new Error(
      `[harness target] no such ref "${branch}" in ${gameRepo}. ` +
        `Fetch it first (git fetch upstream) or check the name with git branch -a.`,
    );
  }

  const { dir, reused } = ensureWorktree({ gameRepo, ref: branch, sha, sandboxRoot, fresh });

  const modules = linkModules ? linkSharedNodeModules({ gameRepo, worktreeDir: dir }) : { linked: false };
  const lockfile = compareLockfiles({ gameRepo, worktreeDir: dir });

  const target = {
    mode: "worktree",
    path: dir,
    gameRepo,
    ref: branch,
    sha,
    shortSha: sha.slice(0, 7),
    branch,
    // A detached worktree at a fixed sha is clean by construction.
    dirty: false,
    reused,
    modules,
    lockfile,
    // Warnings the caller must surface. A silent dependency mismatch is the
    // failure mode worth shouting about: the run would look valid while
    // exercising the wrong tree.
    warnings: [
      ...(lockfile.comparable && !lockfile.matches
        ? [
            `package-lock.json differs between ${branch} and the main checkout, but node_modules is ` +
              `shared from the main checkout. This run may exercise the wrong dependency versions. ` +
              `Use --npm-ci for a real install into the worktree.`,
          ]
        : []),
      ...(modules.linked === false && modules.reason ? [`node_modules: ${modules.reason}`] : []),
    ],
    release: ({ keep = false } = {}) => {
      if (keep) return false;
      return removeWorktree({ gameRepo, dir });
    },
  };
  target.describe = () => describeTarget(target);
  return target;
};
