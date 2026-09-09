// Recording real model responses so a run can be replayed without burning quota.
//
// Keyed on a hash of the model plus the CANONICAL request body, so the key is
// deterministic and order-independent — which matters because a turn interleaves
// several tasks and their responses must not be able to swap places.
//
// Raw cassettes are gitignored: a single system prompt is 50-200 KB, so a ten-turn
// run is megabytes. `promote` copies a curated one into fixtures/ to be committed
// as a regression fixture, which honours the game's own "real transcribed fixtures
// over invented ones" convention without bloating the repo.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { redactDeep, stripUrlKey } from "./redact.js";

/** Stable stringify: object key order must not change the hash. */
const canonical = (value) => {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
};

const parseBody = (body) => {
  if (!body) return null;
  if (typeof body === "string") {
    try {
      return JSON.parse(body);
    } catch {
      return body;
    }
  }
  return body;
};

/**
 * The cassette key.
 *
 * Built from the request body and the model, NOT the URL: the URL carries the
 * API key as a query parameter, so including it would make the key both secret
 * and unstable across machines.
 */
export const cassetteKey = ({ url, body, model }) => {
  const parsed = parseBody(body);
  const endpoint = (() => {
    try {
      const u = new URL(url);
      return `${u.host}${u.pathname}`;
    } catch {
      return String(url);
    }
  })();
  return crypto
    .createHash("sha256")
    .update(`${model ?? ""}\n${endpoint}\n${canonical(parsed)}`)
    .digest("hex")
    .slice(0, 32);
};

export const createCassette = ({ dir, mode = "off", strict = false } = {}) => {
  const stats = { hits: 0, misses: 0, recorded: 0 };
  if (mode !== "off") fs.mkdirSync(dir, { recursive: true });

  const fileFor = (key) => path.join(dir, `${key}.json`);

  return {
    mode,
    stats,

    /** A recorded response for this request, or null. */
    lookup(request) {
      if (mode !== "replay") return null;
      const key = cassetteKey(request);
      const file = fileFor(key);
      if (!fs.existsSync(file)) {
        stats.misses += 1;
        if (strict) {
          // Failing loudly IS the point of strict replay: a miss means the prompt
          // changed, and detecting that is why the recording exists.
          throw new Error(
            `[harness] cassette miss for ${request.task ?? "task"} (${key}). The prompt has ` +
              `changed since this cassette was recorded. Re-record with --record, or use ` +
              `--replay-mode auto to fall through to the network.`,
          );
        }
        return null;
      }
      stats.hits += 1;
      const record = JSON.parse(fs.readFileSync(file, "utf8"));
      return new Response(JSON.stringify(record.responseBody), {
        status: record.status ?? 200,
        headers: { "Content-Type": "application/json" },
      });
    },

    /** Store a response. Redacted before anything reaches disk. */
    async record(request, response) {
      if (mode !== "record") return response;
      const key = cassetteKey(request);
      const clone = response.clone();
      let responseBody = null;
      try {
        responseBody = await clone.json();
      } catch {
        responseBody = { _raw: await response.clone().text() };
      }

      const entry = redactDeep({
        recordedAt: new Date().toISOString(),
        url: stripUrlKey(request.url),
        model: request.model ?? null,
        task: request.task ?? null,
        status: response.status,
        requestBody: parseBody(request.body),
        responseBody,
        ms: request.ms ?? null,
      });

      fs.writeFileSync(fileFor(key), `${JSON.stringify(entry, null, 2)}\n`);
      stats.recorded += 1;
      return response;
    },
  };
};

/** Copy a curated cassette into fixtures/ so it can be committed. */
export const promoteCassette = ({ from, to }) => {
  fs.mkdirSync(to, { recursive: true });
  let count = 0;
  for (const file of fs.readdirSync(from)) {
    if (!file.endsWith(".json")) continue;
    fs.copyFileSync(path.join(from, file), path.join(to, file));
    count += 1;
  }
  return count;
};
