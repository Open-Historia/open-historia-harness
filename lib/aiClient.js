// What happens to a provider call: pace it, replay it, budget it, make it, record it.
//
// This sits behind the fetch shim's single choke point, so none of it required a
// change to src/Game/AI.
//
// The rule that runs through all of it: a rate limit must never be mistaken for a
// bad answer. Both would otherwise show up as "the turn fell back", which is the
// single most misleading thing an AI-quality harness could report.

import { QuotaExhausted } from "./quota.js";
import { stripUrlKey } from "./redact.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Seconds from a Retry-After header, or null. */
const retryAfterMs = (response) => {
  const header = response.headers?.get?.("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
};

/** Google returns its own backoff hint inside the error body. */
const googleRetryMs = (body) => {
  const detail = body?.error?.details?.find?.((entry) => String(entry["@type"] ?? "").includes("RetryInfo"));
  const delay = detail?.retryDelay;
  if (typeof delay !== "string") return null;
  const seconds = Number(delay.replace(/s$/, ""));
  return Number.isFinite(seconds) ? seconds * 1000 : null;
};

export const createAiHook = ({
  cassette = null,
  quota = null,
  minGapMs = 6500,
  maxRetries = 3,
  model = "",
  journal = null,
  onCall = null,
} = {}) => {
  // concurrency 1: free tiers are rated per minute, and parallel calls are the
  // fastest way to trip a limit that then looks like a quality problem.
  let chain = Promise.resolve();
  let lastCallAt = 0;

  const paced = (work) => {
    const next = chain.then(async () => {
      const wait = Math.max(0, lastCallAt + minGapMs - Date.now());
      if (wait > 0) await sleep(wait);
      lastCallAt = Date.now();
      return work();
    });
    // Keep the chain alive even when one call rejects, or every later call in the
    // run inherits that rejection.
    chain = next.then(
      () => {},
      () => {},
    );
    return next;
  };

  return async ({ url, init, realFetch, task }) => {
    const request = { url, body: init?.body, model, task };

    // 1. Replay first: a cassette hit costs nothing and must not touch the budget.
    const replayed = cassette?.lookup(request);
    if (replayed) {
      journal?.log("info", `cassette hit for ${task ?? "task"}`);
      return replayed;
    }

    return paced(async () => {
      let attempt = 0;
      for (;;) {
        attempt += 1;

        // 2. Reserve BEFORE the call. A kill mid-flight then over-counts by one
        // rather than under-counting.
        let reservation = null;
        try {
          reservation = quota?.reserve(task) ?? null;
        } catch (error) {
          if (error instanceof QuotaExhausted) {
            journal?.log("error", error.message, error.detail);
            throw error;
          }
          throw error;
        }

        const startedAt = Date.now();
        let response;
        try {
          response = await realFetch(url, init);
        } catch (error) {
          journal?.log("warn", `provider request failed: ${error.message}`, { url: stripUrlKey(url), task });
          throw error;
        }
        const ms = Date.now() - startedAt;

        onCall?.({ task, ms, status: response.status, attempt, reservation });

        if (response.status !== 429 && response.status < 500) {
          journal?.log("info", `provider ${response.status} for ${task ?? "task"} in ${ms}ms`);
          return cassette ? cassette.record({ ...request, ms }, response) : response;
        }

        // 3. Rate limited or transiently broken. Honour the server's own hint.
        let body = null;
        try {
          body = await response.clone().json();
        } catch {
          body = null;
        }
        const hinted = retryAfterMs(response) ?? googleRetryMs(body);
        const backoff = hinted ?? Math.min(60_000, 2 ** attempt * 1000);

        if (attempt > maxRetries) {
          // Surfaced as its OWN failure, never as a fallback turn. "We ran out of
          // quota" and "the model answered badly" need different reactions, and
          // conflating them makes every quality number untrustworthy.
          const error = new QuotaExhausted(
            `[harness] provider returned ${response.status} after ${maxRetries} retries — rate limited or out of quota`,
            { status: response.status, task, body },
          );
          journal?.log("error", error.message, error.detail);
          throw error;
        }

        journal?.log(
          "warn",
          `provider ${response.status} for ${task ?? "task"}; retrying in ${Math.round(backoff / 1000)}s ` +
            `(attempt ${attempt}/${maxRetries})`,
        );
        await sleep(backoff);
      }
    });
  };
};
