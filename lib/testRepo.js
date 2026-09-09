// Test-only helper. Builds a throwaway git repo that passes looksLikeGameRepo(),
// so worktree and target behaviour can be tested hermetically instead of against
// the user's real checkout — where a bug in the code under test would do real damage.

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

/**
 * A miniature src/ tree that reproduces all four compat blockers exactly.
 *
 * The drift assertions are pinned against THIS rather than the real repo: pinning
 * to the user's working tree would turn every ordinary branch switch into a red test,
 * which trains people to ignore the one signal the pinning exists to give.
 *
 * Counts here are deliberate — 2 env reads in promptContext, 1 in regionSeed.
 */
export const makeCompatFixture = (dir, { badJsx = false } = {}) => {
  const src = path.join(dir, "src");

  // Blocker 1: a .jsx file with no JSX in it, imported by the engine.
  write(
    path.join(src, "Game", "AI", "main.jsx"),
    "export const callAI = async () => 'stub';\nexport const MARKER = 'jsx-loaded';\n",
  );

  // Blocker 2: import.meta.env read at MODULE SCOPE, so the module throws on load.
  write(
    path.join(src, "Game", "AI", "promptContext.js"),
    "const CONTENT_BASE = (import.meta.env.VITE_OH_PMTILES_URL || '/assets').replace(/\\/$/, '');\n" +
      "export const CITY_SEED_URL = `${CONTENT_BASE}/cities-seed.json`;\n" +
      "export const IS_WEB = Boolean(import.meta.env.VITE_OH_WEB);\n",
  );

  // Blocker 3: JSON imported with no `with { type: "json" }`.
  write(path.join(src, "Game", "AI", "defaultPrompts.json"), JSON.stringify({ advisor: "you are an advisor" }));
  write(
    path.join(src, "Game", "AI", "gameplayPrompts.js"),
    "import DEFAULT_PROMPTS from './defaultPrompts.json';\nexport const advisorPrompt = DEFAULT_PROMPTS.advisor;\n",
  );

  // Blocker 4: import.meta.env read inside a function, so it throws only when called.
  write(
    path.join(src, "runtime", "regionSeed.js"),
    "export const loadRegionSeed = () => {\n  if (import.meta.env.VITE_OH_WEB) return 'web';\n  return 'desktop';\n};\n",
  );

  write(
    path.join(src, "Game", "AI", "gameplay.js"),
    "import { callAI, MARKER } from './main.jsx';\n" +
      "import { advisorPrompt } from './gameplayPrompts.js';\n" +
      "import { CITY_SEED_URL, IS_WEB } from './promptContext.js';\n" +
      "import { loadRegionSeed } from '../../runtime/regionSeed.js';\n" +
      "export const simulateTimelineJump = async () => ({ callAI, MARKER, advisorPrompt, CITY_SEED_URL, IS_WEB, seed: loadRegionSeed() });\n",
  );

  if (badJsx) {
    // A real React component pulled onto the engine path — what the allow-list
    // exists to refuse, because this loader does not compile JSX.
    write(
      path.join(src, "Game", "AI", "Panel.jsx"),
      "export const Panel = () => <div className='panel'>hello</div>;\n",
    );
    write(
      path.join(src, "Game", "AI", "gameplay.js"),
      "import { Panel } from './Panel.jsx';\nexport const simulateTimelineJump = async () => Panel;\n",
    );
  }

  return { dir, entry: path.join(src, "Game", "AI", "gameplay.js") };
};
