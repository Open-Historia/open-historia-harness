// Running unmodified game source under Node.
//
// The game is built by Vite for a browser. Four things about that stop plain Node
// from importing the turn engine, and this module fixes all four IN MEMORY so the
// harness can play any branch — including a pristine upstream/main — without a
// single edit to the game repo.
//
//   1. src/Game/AI/gameplay.js imports ./main.jsx. That file contains no JSX at
//      all, but Node refuses the extension outright.
//   2. src/Game/AI/promptContext.js reads import.meta.env at module scope, which
//      is undefined outside Vite, so the module throws on load.
//   3. src/Game/AI/gameplayPrompts.js imports defaultPrompts.json with no
//      `with { type: "json" }` attribute.
//   4. src/runtime/regionSeed.js reads import.meta.env inside loadRegionCatalog.
//      This one is easy to miss and expensive: assets.js swallows the throw and
//      then deliberately clears its own memo, so the region catalog is re-decoded
//      on every single prompt build and every custom scenario name is lost.
//
// The rewrite is blunt on purpose, so the guard rails matter more than the trick:
// only the target's own src/ is touched, .jsx is allow-listed to the one file
// known to be JSX-free, and every rewrite is counted so a branch that drifts is
// reported rather than silently mistranslated.

import fs from "node:fs";
import path from "node:path";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

// The token the rewrite points at. Deliberately obscure: it must never collide
// with anything the game itself defines.
export const ENV_GLOBAL = "__OH_HARNESS_ENV__";

const ENV_TOKEN = "import.meta.env";

// The only .jsx file allowed onto the gameplay path. Anything else means the
// branch has pulled real JSX in, which this loader cannot compile and must not
// pretend to.
const JSX_ALLOWLIST = ["src/Game/AI/main.jsx"];

let handle = null;
let roots = [];
const rewrites = new Map();
const jsxLoaded = new Set();

const toPosix = (p) => p.split(path.sep).join("/");

const rootUrlFor = (targetPath) => pathToFileURL(path.join(targetPath, "src") + path.sep).href;

const isGameSource = (url) => {
  if (!url.startsWith("file:")) return false;
  if (url.includes("/node_modules/")) return false;
  return roots.some((root) => url.startsWith(root));
};

let rootPaths = [];

/**
 * Install the loader hooks. Call BEFORE importing any game module.
 *
 * `env` populates the object that import.meta.env is rewritten to, so a harness
 * run can simulate the web build (`{ VITE_OH_WEB: "1" }`) rather than guessing at
 * what the flag would have done.
 */
export const installCompat = ({ targetPath, env = {} } = {}) => {
  if (!targetPath) throw new Error("[harness compat] installCompat needs a targetPath");

  const resolvedTarget = path.resolve(targetPath);
  const root = rootUrlFor(resolvedTarget);
  if (!roots.includes(root)) {
    roots.push(root);
    rootPaths.push(resolvedTarget);
  }

  globalThis[ENV_GLOBAL] = { ...(globalThis[ENV_GLOBAL] ?? {}), ...env };

  if (handle) return handle;

  handle = registerHooks({
    resolve(specifier, context, nextResolve) {
      const result = nextResolve(specifier, context);
      // gameplayPrompts.js imports defaultPrompts.json bare. Vite is happy with
      // that; Node demands the attribute.
      if (result.url.endsWith(".json") && isGameSource(result.url)) {
        result.importAttributes = { ...result.importAttributes, type: "json" };
      }
      return result;
    },

    load(url, context, nextLoad) {
      if (!isGameSource(url)) return nextLoad(url, context);

      // JSON goes through untouched. The resolve hook above already attached the
      // attribute it needs, and forcing format:"module" here would contradict it.
      if (url.endsWith(".json")) return nextLoad(url, context);

      if (url.endsWith(".jsx")) {
        // URLs are already slash-separated, so the allow-list entries compare directly.
        const allowed = JSX_ALLOWLIST.some((entry) => url.endsWith(entry));
        if (!allowed) {
          throw new Error(
            `[harness compat] ${url} is a .jsx file on the gameplay path and is not on the ` +
              `allow-list. This loader treats .jsx as plain ESM — it does NOT compile JSX. ` +
              `The branch under test has pulled a React component into the engine, so the ` +
              `harness would be running something other than what it claims. ` +
              `Allow-list: ${JSX_ALLOWLIST.join(", ")}`,
          );
        }
        jsxLoaded.add(url);
      }

      // Forcing the format is what gets .jsx past Node's extension check. The
      // file is ordinary ESM; only its name is unusual.
      const result = nextLoad(url, { ...context, format: "module" });
      const source = String(result.source);

      if (!source.includes(ENV_TOKEN)) {
        return { ...result, format: "module", source };
      }

      // Counted, not just replaced: compat.test.js pins these numbers so a branch
      // that adds or removes an import.meta.env read is reported instead of
      // silently mistranslated.
      const count = source.split(ENV_TOKEN).length - 1;
      rewrites.set(url, count);

      return {
        ...result,
        format: "module",
        source: source.replaceAll(ENV_TOKEN, `globalThis.${ENV_GLOBAL}`),
      };
    },
  });

  return handle;
};

export const uninstallCompat = () => {
  handle?.deregister?.();
  handle = null;
  roots = [];
  rootPaths = [];
  rewrites.clear();
  jsxLoaded.clear();
  delete globalThis[ENV_GLOBAL];
};

export const isCompatInstalled = () => Boolean(handle);

/**
 * What the shim actually had to do for this target — the data behind
 * --verify-compat.
 *
 * A branch that fixes one of these upstream shows up here as a no-op rather than
 * quietly continuing to be patched, which is how the harness reports that it is
 * no longer needed instead of hiding it.
 */
export const compatReport = () => {
  const files = [...rewrites.entries()]
    .map(([url, count]) => ({ file: toPosix(url).replace(/^.*\/src\//, "src/"), rewrites: count }))
    .sort((a, b) => a.file.localeCompare(b.file));

  return {
    envRewrites: files,
    totalEnvRewrites: files.reduce((sum, entry) => sum + entry.rewrites, 0),
    jsxLoaded: [...jsxLoaded].map((url) => toPosix(url).replace(/^.*\/src\//, "src/")).sort(),
    env: { ...(globalThis[ENV_GLOBAL] ?? {}) },
  };
};

/**
 * Which of the four blockers this target still has. Read statically, so it can
 * run before anything is imported and can answer for a branch the harness has
 * not played yet.
 */
export const detectBlockers = (targetPath) => {
  const read = (rel) => {
    try {
      return fs.readFileSync(path.join(targetPath, rel), "utf8");
    } catch {
      return null;
    }
  };
  const exists = (rel) => fs.existsSync(path.join(targetPath, rel));

  const gameplay = read("src/Game/AI/gameplay.js") ?? "";
  const prompts = read("src/Game/AI/gameplayPrompts.js") ?? "";

  return [
    {
      id: "jsx-extension",
      present: exists("src/Game/AI/main.jsx") && /from\s+["']\.\/main\.jsx["']/.test(gameplay),
      note: "gameplay.js imports ./main.jsx; Node refuses the extension",
    },
    {
      id: "prompt-context-env",
      present: (read("src/Game/AI/promptContext.js") ?? "").includes(ENV_TOKEN),
      note: "promptContext.js reads import.meta.env at module scope",
    },
    {
      id: "json-import-attribute",
      present: /import\s+\w+\s+from\s+["']\.\/defaultPrompts\.json["']\s*;/.test(prompts),
      note: "gameplayPrompts.js imports JSON without `with { type: \"json\" }`",
    },
    {
      id: "region-seed-env",
      present: (read("src/runtime/regionSeed.js") ?? "").includes(ENV_TOKEN),
      note: "regionSeed.js reads import.meta.env inside loadRegionCatalog",
    },
  ];
};
