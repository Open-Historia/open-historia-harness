// Wiring the layers together in the one order that works.
//
// The sequence below is not arbitrary; each step exists because the next one
// breaks without it:
//
//   1. configureSafety      assertSandboxed refuses to guess before this
//   2. resolveTarget        creates the worktree and the node_modules junction,
//                           which MUST precede the fs guard (that junction is the
//                           one link pointing into the game repo)
//   3. installFsGuard       before any game code can write
//   4. createSandbox        the data dir the server will resolve
//   5. startServer          importing server.js IS starting it
//   6. installGlobals       window must exist before the first game import,
//                           because assets.js freezes `origin` at module scope
//   7. installCompat        loader hooks, before the first game import
//   8. import game modules  only now
//   9. refreshLibraryCatalog  JSON_URLS are empty strings until this runs
//  10. open a Game export     only now: it is opened with the game's own code,
//                             imported through the running server
//
// A Game export's target is checked right after step 2, so a checkout that
// predates exports is refused before anything boots.

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { installCompat, uninstallCompat } from "./compat.js";
import { createFetchShim } from "./fetchShim.js";
import { assertTargetOpensExports, openGameExport } from "./gameExport.js";
import { installGlobals, uninstallGlobals } from "./globals.js";
import { configureSafety, installFsGuard, resetSafety, uninstallFsGuard } from "./safety.js";
import { createSandbox } from "./sandbox.js";
import { startServer } from "./server.js";
import { DEFAULT_GAME_REPO, findGameRepo, resolveTarget } from "./target.js";

// fileURLToPath, not URL.pathname: .pathname keeps the URL encoding, so a
// checkout under "C:\Users\Some Name" put its sandbox in "C:\Users\Some%20Name",
// which does not exist and cannot be created (EPERM). See roots.test.js.
export const DEFAULT_SANDBOX_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "sandbox",
);

const GAME_MODULES = {
  assets: "src/runtime/assets.js",
  gameState: "src/runtime/gameState.js",
  gameplay: "src/Game/AI/gameplay.js",
  library: "src/runtime/library.js",
  spycraft: "src/runtime/spycraft.js",
  units: "src/Game/Map/unitsController.js",
};

/**
 * Boot everything and hand back the live game modules.
 *
 * Returns a session with .modules (the engine), .server, .sandbox, .target,
 * .fetch (for its stats) and .dispose().
 */
export const createSession = async ({
  repo,
  branch = null,
  sandboxRoot = DEFAULT_SANDBOX_ROOT,
  fresh = false,
  geometry = "stock",
  fixture = null,
  saveZip = null,
  importScenario = true,
  hub = true,
  hubSkippedBecause,
  onProgress = null,
  ai = "off",
  aiHook,
  provider = "gemini",
  apiKey = "",
  model = "",
  reasoning = false,
  env = {},
  quiet = true,
  allowWrite = [],
} = {}) => {
  const gameRepo = findGameRepo(repo);

  // 1. Safety first. Protect the target AND the main checkout's save dir, which
  // is the only place real saves exist even when testing a branch.
  configureSafety({
    sandbox: sandboxRoot,
    protect: [gameRepo, path.join(gameRepo, "server", "data"), DEFAULT_GAME_REPO],
    // Run output lives outside the sandbox on purpose: journals and reports must
    // survive the sandbox being deleted, which is exactly what makes a killed run
    // recoverable.
    allow: allowWrite,
  });

  // 2. Worktree + junction, before the guard.
  const target = resolveTarget({ repo: gameRepo, branch, sandboxRoot, fresh });
  if (saveZip) {
    try {
      assertTargetOpensExports(target);
    } catch (error) {
      target.release();
      resetSafety();
      throw error;
    }
  }

  // 3-5.
  installFsGuard();
  const sandbox = createSandbox({ target, geometry, fixture });
  const server = await startServer({ target, sandbox, quiet });

  // 6. Globals, with the provider settings the engine reads from localStorage.
  const fetchShim = createFetchShim({ baseUrl: server.baseUrl, ai, aiHook });
  // Replay needs the shim to route provider calls to the hook even with no key,
  // since a cassette answers without the network. `ai: "replay"` is treated as
  // live for routing purposes; the hook decides what actually happens.
  if (ai === "replay") fetchShim.stats.replay = true;
  const settings = {
    api_provider: provider,
    ai_reasoning_enabled: reasoning ? "1" : "0",
    // Bound each task at 5 minutes so a wedged generation cannot sit forever.
    ai_limit_generation: "1",
  };
  if (apiKey) settings[`${provider.replace(/-/g, "_")}_api_key`] = apiKey;
  if (model) settings[`${provider.replace(/-/g, "_")}_model`] = model;

  installGlobals({ baseUrl: server.baseUrl, fetchImpl: fetchShim, settings });

  // 7. Loader hooks.
  installCompat({ targetPath: target.path, env });

  // 8. The engine.
  const modules = {};
  for (const [name, relative] of Object.entries(GAME_MODULES)) {
    modules[name] = await import(pathToFileURL(path.join(target.path, relative)).href);
  }

  // 9. Without this JSON_URLS are all "" and every read resolves to nothing. It
  // also sets the runtime asset token and makes activeCampaignId() non-empty, so
  // the campaign guard becomes live rather than silently permissive.
  await modules.library.refreshLibraryCatalog({ force: true });

  const session = {
    target,
    sandbox,
    server,
    modules,
    fetch: fetchShim,
    ai,
    baseUrl: server.baseUrl,
    // What the run was opened on. A Game export replaces this below.
    save: fixture ? { kind: "real", name: fixture } : { kind: "fresh" },
    describe: () =>
      `${target.describe()} · ${sandbox.describe()}${session.save.kind === "export" ? `, Game export ${session.save.fileName}` : ""}`,
    dispose: async ({ keep = false } = {}) => {
      await server.stop();
      uninstallGlobals();
      uninstallCompat();
      uninstallFsGuard();
      sandbox.dispose({ keep });
      target.release({ keep });
      resetSafety();
    },
  };

  // 10. The caller never gets a session back if this throws, so it must not be
  // left holding a listening server: that would keep the process alive forever.
  if (saveZip) {
    try {
      session.save = await openGameExport(session, saveZip, {
        importScenario,
        geometry,
        hub,
        hubSkippedBecause,
        ai,
        provider,
        model,
        // A hub download can take minutes; say so rather than go quiet.
        say: (text) => (onProgress ? onProgress(text) : console.log(text)),
      });
    } catch (error) {
      await session.dispose().catch(() => {});
      throw error;
    }
    if (session.save.aiPlan?.fromRecord) aiHook?.setModel?.(session.save.aiPlan.model);
  }

  return session;
};
