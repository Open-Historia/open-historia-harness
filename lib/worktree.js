// Throwaway git worktrees, so the harness can play any branch without ever
// touching the checkout the user is working in.
//
// Two things make this cheap enough to do per branch:
//
//   - worktrees are keyed by commit sha, so re-running an unchanged branch reuses
//     the checkout instead of spending ~5 s recreating it;
//   - node_modules (790 MB) is a junction, never a copy.
//
// The junction is the one place the harness deliberately points at the game repo.
// It follows the same one-way rule as copyIn(): the DESTINATION is asserted, the
// source is a read-only reference we never write through. That is only true while
// the junction and a real `npm ci` are mutually exclusive, which linkSharedNodeModules
// enforces, and while it is created before the fs guard is installed — also
// enforced, rather than left as a comment for someone to violate later.

import fs from "node:fs";
import path from "node:path";

import { runGit } from "./git.js";
import { assertSandboxed, isFsGuardInstalled } from "./safety.js";

const slugify = (ref) =>
  ref
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "ref";

export const worktreeDirFor = ({ sandboxRoot, ref, sha }) =>
  path.join(sandboxRoot, "worktrees", `${slugify(ref)}-${sha.slice(0, 7)}`);

/**
 * Remove a symlink or Windows junction WITHOUT following it.
 *
 * Verified on this machine: fs.rmSync(junction, {recursive:true}) unlinks the
 * junction and leaves the target intact. This still avoids the recursive form —
 * the cost of being explicit is nil, and the cost of being wrong is 790 MB of
 * someone else's node_modules.
 */
export const removeLink = (linkPath) => {
  let stats;
  try {
    stats = fs.lstatSync(linkPath);
  } catch {
    return false; // already gone
  }
  if (!stats.isSymbolicLink()) {
    throw new Error(`[harness worktree] refusing to remove ${linkPath}: it is a real directory, not a link`);
  }
  try {
    fs.unlinkSync(linkPath);
  } catch {
    fs.rmdirSync(linkPath); // Windows junctions unlink as directories
  }
  return true;
};

/**
 * Junction the main checkout's node_modules into a worktree.
 *
 * Returns {linked, reused, reason} rather than throwing on the "no modules to
 * share" case, so a caller can report it and carry on.
 */
export const linkSharedNodeModules = ({ gameRepo, worktreeDir }) => {
  if (isFsGuardInstalled()) {
    // Ordering is load-bearing: this is the one link that points into the game
    // repo, and it is only legitimate because it happens during setup, before
    // any game code can run. If the guard is already up we are being called from
    // the wrong phase, and silently allowing it would put a writable alias to the
    // real node_modules inside a live sandbox.
    throw new Error(
      "[harness worktree] linkSharedNodeModules must run BEFORE installFsGuard() — " +
        "worktree setup belongs in the target phase, not the session phase",
    );
  }

  const source = path.join(gameRepo, "node_modules");
  const dest = assertSandboxed(path.join(worktreeDir, "node_modules"), "node_modules link");

  if (!fs.existsSync(source)) {
    return { linked: false, reused: false, reason: `${source} does not exist — run npm install in the game repo` };
  }

  const existing = fs.existsSync(dest) ? fs.lstatSync(dest) : null;
  if (existing?.isSymbolicLink()) return { linked: true, reused: true, source, dest };
  if (existing) {
    // A real directory here means someone ran --npm-ci for this worktree. Leave
    // it: replacing a real install with a junction would silently change which
    // dependency tree the run uses.
    return { linked: false, reused: true, reason: "the worktree has its own node_modules", dest };
  }

  fs.symlinkSync(source, dest, "junction");
  return { linked: true, reused: false, source, dest };
};

/**
 * Compare the two lockfiles. A junctioned node_modules is only honest when the
 * branch under test wants the same dependency tree as the checkout it borrows
 * from; otherwise the run silently exercises the wrong versions.
 */
export const compareLockfiles = ({ gameRepo, worktreeDir }) => {
  const read = (dir) => {
    try {
      return fs.readFileSync(path.join(dir, "package-lock.json"), "utf8");
    } catch {
      return null;
    }
  };
  const main = read(gameRepo);
  const branch = read(worktreeDir);
  if (main === null || branch === null) return { comparable: false, matches: null };
  return { comparable: true, matches: main === branch };
};

const worktreeHeadSha = (dir) =>
  runGit(dir, ["rev-parse", "HEAD"], { allowFailure: true });

const isUsableWorktree = (dir, sha) =>
  fs.existsSync(path.join(dir, ".git")) && worktreeHeadSha(dir) === sha;

/**
 * Create (or reuse) a detached worktree at `sha`.
 * Returns {dir, reused}.
 */
export const ensureWorktree = ({ gameRepo, ref, sha, sandboxRoot, fresh = false }) => {
  const dir = assertSandboxed(worktreeDirFor({ sandboxRoot, ref, sha }), "worktree directory");

  if (fresh && fs.existsSync(dir)) removeWorktree({ gameRepo, dir });
  if (isUsableWorktree(dir, sha)) return { dir, reused: true };

  // A leftover directory that is not a healthy worktree (an interrupted run, a
  // half-removed checkout) would make `worktree add` fail on a path that already
  // exists, so clear it first.
  if (fs.existsSync(dir)) removeWorktree({ gameRepo, dir });

  fs.mkdirSync(path.dirname(dir), { recursive: true });
  // --detach: the harness must never check a branch OUT, which would make that
  // branch unavailable in the main checkout.
  runGit(gameRepo, ["worktree", "add", "--detach", dir, sha]);
  return { dir, reused: false };
};

/**
 * Remove a worktree and leave the game repo's worktree list exactly as it was.
 * Safe to call on a directory that is already gone.
 */
export const removeWorktree = ({ gameRepo, dir }) => {
  assertSandboxed(dir, "worktree directory");

  // The junction goes first. `git worktree remove` would refuse over an
  // "untracked" node_modules anyway, and the explicit unlink is what keeps the
  // shared modules out of any recursive delete below.
  try {
    removeLink(path.join(dir, "node_modules"));
  } catch {
    // A real node_modules (from --npm-ci) is removed with the directory below.
  }

  const removed = runGit(gameRepo, ["worktree", "remove", "--force", dir], { allowFailure: true });
  if (removed === null && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });

  // Always prune: git keeps administrative files under .git/worktrees even after
  // the checkout is gone, and leaving those behind is the "stranded worktree in
  // the user's repo" failure this whole module exists to avoid.
  runGit(gameRepo, ["worktree", "prune"], { allowFailure: true });
  return !fs.existsSync(dir);
};

/**
 * Drop every harness worktree the game repo still knows about, plus any stale
 * directory under the sandbox. Used by --prune and by crash recovery.
 */
export const pruneWorktrees = ({ gameRepo, sandboxRoot, keep = [] }) => {
  const keepResolved = new Set(keep.map((p) => path.resolve(p)));
  const removed = [];

  const worktreesDir = path.join(sandboxRoot, "worktrees");
  if (fs.existsSync(worktreesDir)) {
    for (const entry of fs.readdirSync(worktreesDir)) {
      const dir = path.join(worktreesDir, entry);
      if (keepResolved.has(path.resolve(dir))) continue;
      removeWorktree({ gameRepo, dir });
      removed.push(dir);
    }
  }

  runGit(gameRepo, ["worktree", "prune"], { allowFailure: true });
  return removed;
};

/** Worktree paths the game repo currently has registered. For assertions and --doctor. */
export const listWorktrees = (gameRepo) => {
  const raw = runGit(gameRepo, ["worktree", "list", "--porcelain"], { allowFailure: true }) ?? "";
  return raw
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => path.resolve(line.slice("worktree ".length).trim()));
};
