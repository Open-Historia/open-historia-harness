// Test-only helper. Builds a throwaway git repo that passes looksLikeGameRepo(),
// so worktree and target behaviour can be tested hermetically instead of against
// Mark's real checkout — where a bug in the code under test would do real damage.

import fs from "node:fs";
import path from "node:path";

import { runGit } from "./git.js";

const write = (file, contents) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
};

/**
 * Create a fake game repo at `dir` with two commits on two branches.
 * Returns { dir, mainBranch, otherBranch, mainSha, otherSha }.
 */
export const makeFakeGameRepo = (dir, { lockfile = '{"lockfileVersion":3}' } = {}) => {
  fs.mkdirSync(dir, { recursive: true });

  write(path.join(dir, "package.json"), JSON.stringify({ name: "open-historia", version: "0.0.0" }, null, 2));
  write(path.join(dir, "package-lock.json"), lockfile);
  write(path.join(dir, "server", "server.js"), "export const httpServer = null;\n");
  write(path.join(dir, "src", "Game", "AI", "gameplay.js"), "export const simulateTimelineJump = async () => ({});\n");
  write(path.join(dir, ".gitignore"), "node_modules/\n");

  // Not committed — this stands in for the 790 MB the real repo shares by junction.
  write(path.join(dir, "node_modules", "fake-dep", "index.js"), "export default 'shared';\n");

  runGit(dir, ["init", "-q", "--initial-branch=main"]);
  runGit(dir, ["config", "user.name", "Harness Test"]);
  runGit(dir, ["config", "user.email", "harness@example.invalid"]);
  runGit(dir, ["add", "-A"]);
  runGit(dir, ["commit", "-q", "-m", "initial"]);
  const mainSha = runGit(dir, ["rev-parse", "HEAD"]);

  runGit(dir, ["checkout", "-q", "-b", "feature"]);
  write(path.join(dir, "src", "Game", "AI", "gameplay.js"), "export const simulateTimelineJump = async () => ({ changed: true });\n");
  runGit(dir, ["add", "-A"]);
  runGit(dir, ["commit", "-q", "-m", "feature change"]);
  const otherSha = runGit(dir, ["rev-parse", "HEAD"]);

  runGit(dir, ["checkout", "-q", "main"]);

  return { dir, mainBranch: "main", otherBranch: "feature", mainSha, otherSha };
};
