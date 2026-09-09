// One place that shells out to git, so every call gets the same argument-array
// invocation (never a shell string), the same timeout, and the same error text.

import { execFileSync } from "node:child_process";

/**
 * Run git inside `repoPath`. Returns trimmed stdout.
 *
 * `allowFailure` turns a non-zero exit into null, for the many probes where "no"
 * is a legitimate answer rather than a problem (is this a repo, does this ref
 * exist, is this worktree registered).
 */
export const runGit = (repoPath, args, { allowFailure = false, timeout = 60_000 } = {}) => {
  try {
    return execFileSync("git", ["-C", repoPath, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      timeout,
    }).trim();
  } catch (error) {
    if (allowFailure) return null;
    const stderr = String(error.stderr ?? "").trim();
    throw new Error(`git ${args.join(" ")} failed in ${repoPath}${stderr ? `: ${stderr}` : ""}`);
  }
};

export const isGitRepo = (dir) => runGit(dir, ["rev-parse", "--git-dir"], { allowFailure: true }) !== null;

/** Resolve any ref (branch, tag, sha, upstream/foo) to a full commit sha, or null. */
export const resolveSha = (repoPath, ref) =>
  runGit(repoPath, ["rev-parse", "--verify", `${ref}^{commit}`], { allowFailure: true });

/** The checked-out branch, or null when detached. */
export const currentBranch = (repoPath) => {
  const name = runGit(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"], { allowFailure: true });
  return !name || name === "HEAD" ? null : name;
};

/** True when tracked files are modified or the index is dirty. Untracked files do not count. */
export const isDirty = (repoPath) =>
  runGit(repoPath, ["status", "--porcelain", "--untracked-files=no"], { allowFailure: true })
    ? true
    : false;
