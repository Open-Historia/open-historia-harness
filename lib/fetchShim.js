// The single choke point for every request the engine makes.
//
// Two jobs. First, resolution: library.js:100 and logClient.js:26 hard-code
// root-relative paths with no origin at all, so even with `window` shimmed those
// need turning into absolute URLs against the sandbox server.
//
// Second, and more useful: anything NOT addressed to the sandbox server is, by
// construction, a model provider call. That makes this the one place to count,
// rate-limit, record, replay and refuse AI traffic — with no change whatsoever to
// src/Game/AI, which is exactly why the harness never had to touch the game's
// provider code.

/** Thrown for a provider call in --no-ai mode. */
export class NoAiError extends Error {
  constructor(url) {
    super(`[harness] AI is disabled for this run (blocked call to ${new URL(url).host})`);
    this.name = "NoAiError";
    this.harnessNoAi = true;
  }
}

const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return "unknown";
  }
};

/**
 * Build the fetch replacement.
 *
 * `ai` decides what happens to provider traffic:
 *   "off"     reject, so runJsonTask falls through to its deterministic fallback
 *   "live"    pass through to aiHook, which paces, budgets and records it
 *   "replay"  same routing as live; the hook answers from cassettes instead of
 *             the network, so a recorded run needs no key and costs no quota
 */
export const createFetchShim = ({ baseUrl, realFetch = globalThis.fetch, ai = "off", aiHook } = {}) => {
  if (!baseUrl) throw new Error("[harness fetch] createFetchShim needs a baseUrl");

  const stats = {
    api: 0,
    ai: 0,
    aiByHost: {},
    blocked: 0,
    // Set by the driver around each verb, so a call can be attributed to the task
    // that made it. Two calls tagged to one task means the first answer failed
    // validation and the engine retried.
    currentTask: null,
    aiByTask: {},
  };

  const shim = async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : (input?.url ?? String(input));

    // Root-relative. Not optional even with window shimmed, because the callers
    // above emit these with no origin.
    if (url.startsWith("/")) {
      stats.api += 1;
      return realFetch(new URL(url, baseUrl), init);
    }

    if (url.startsWith(baseUrl)) {
      stats.api += 1;
      return realFetch(input, init);
    }

    // Everything else leaves this machine.
    const host = hostOf(url);
    stats.aiByHost[host] = (stats.aiByHost[host] ?? 0) + 1;

    if (ai !== "live" && ai !== "replay") {
      stats.blocked += 1;
      // A plain Error, deliberately NOT an AbortError: gameplay.js treats abort
      // as "the user cancelled" and re-throws, while any other failure falls back
      // to the canned turn. The canned turn is what --no-ai wants.
      throw new NoAiError(url);
    }

    stats.ai += 1;
    if (stats.currentTask) {
      stats.aiByTask[stats.currentTask] = (stats.aiByTask[stats.currentTask] ?? 0) + 1;
    }

    if (!aiHook) return realFetch(input, init);
    return aiHook({ url, init, realFetch, task: stats.currentTask });
  };

  shim.stats = stats;
  shim.resetStats = () => {
    stats.api = 0;
    stats.ai = 0;
    stats.blocked = 0;
    stats.aiByHost = {};
    stats.aiByTask = {};
  };
  /** Attribute subsequent provider calls to a named task. Returns a restore fn. */
  shim.withTask = (task) => {
    const previous = stats.currentTask;
    stats.currentTask = task;
    return () => {
      stats.currentTask = previous;
    };
  };

  return shim;
};
