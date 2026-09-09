// Recording, replay and — the one that matters most — proof that a real API key
// never reaches disk. Mark's key is a free-tier key, but a key committed to a repo
// is a key committed to a repo.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

import { cassetteKey, createCassette, promoteCassette } from "./cassette.js";
import { createQuota, QuotaExhausted } from "./quota.js";
import { redact, redactDeep, stripUrlKey } from "./redact.js";

// Fake, but shaped exactly like a real Google key so the redactors are tested
// against the thing they actually have to catch.
const FAKE_KEY = "AIzaSyD-fake0000000000000000000000000000";

let root;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "oh-cassette-test-"));
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

test("redact catches a Google key, a bearer header and a key= parameter", () => {
  assert.doesNotMatch(redact(`key is ${FAKE_KEY}`), /AIzaSy/);
  assert.doesNotMatch(redact(`Authorization: Bearer sk-abcdefgh12345678`), /abcdefgh/);
  assert.doesNotMatch(stripUrlKey(`https://x.test/v1?key=${FAKE_KEY}&model=a`), /AIzaSy/);
  assert.match(stripUrlKey(`https://x.test/v1?key=${FAKE_KEY}&model=a`), /model=a/, "the rest survives");
});

test("redactDeep strips auth headers by name, whatever their value", () => {
  const cleaned = redactDeep({
    headers: { "x-goog-api-key": FAKE_KEY, authorization: `Bearer ${FAKE_KEY}`, "content-type": "application/json" },
    body: { note: `remember ${FAKE_KEY}` },
  });
  assert.equal(cleaned.headers["x-goog-api-key"], "[redacted]");
  assert.equal(cleaned.headers["content-type"], "application/json", "innocent headers survive");
  assert.doesNotMatch(JSON.stringify(cleaned), /AIzaSy/);
});

test("the cassette key ignores object key order but not content", () => {
  const a = cassetteKey({ url: "https://x.test/v1/models/m:generateContent", body: { a: 1, b: [2, 3] }, model: "m" });
  const b = cassetteKey({ url: "https://x.test/v1/models/m:generateContent", body: { b: [2, 3], a: 1 }, model: "m" });
  const c = cassetteKey({ url: "https://x.test/v1/models/m:generateContent", body: { a: 1, b: [3, 2] }, model: "m" });

  assert.equal(a, b, "key order must not change the hash — a turn interleaves tasks");
  assert.notEqual(a, c, "but content must");
});

test("the cassette key ignores the API key in the URL", () => {
  // Otherwise a recording would be both secret and unusable on another machine.
  const base = { body: { prompt: "hi" }, model: "m" };
  const withKey = cassetteKey({ ...base, url: `https://x.test/v1/m:generateContent?key=${FAKE_KEY}` });
  const without = cassetteKey({ ...base, url: "https://x.test/v1/m:generateContent" });
  assert.equal(withKey, without);
});

test("record then replay round-trips, and the key never reaches disk", async () => {
  const dir = path.join(root, "cassettes", "run-1");
  const recorder = createCassette({ dir, mode: "record" });

  const request = {
    url: `https://generativelanguage.googleapis.com/v1beta/models/m:generateContent?key=${FAKE_KEY}`,
    body: JSON.stringify({ contents: [{ parts: [{ text: "simulate a turn" }] }] }),
    model: "gemini-3.5-flash-lite",
    task: "jumpForward",
  };
  const response = new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "{}" }] } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

  await recorder.record(request, response);
  assert.equal(recorder.stats.recorded, 1);

  // Every byte written, checked.
  for (const file of fs.readdirSync(dir)) {
    const contents = fs.readFileSync(path.join(dir, file), "utf8");
    assert.doesNotMatch(contents, /AIzaSy/, `${file} must not contain the API key`);
    assert.match(contents, /redacted/, "and it should say so rather than silently dropping it");
  }

  const player = createCassette({ dir, mode: "replay" });
  const replayed = player.lookup(request);
  assert.ok(replayed, "the recorded response replays");
  assert.equal(player.stats.hits, 1);
  const body = await replayed.json();
  assert.equal(body.candidates[0].content.parts[0].text, "{}");
});

test("strict replay fails loudly on a miss, because that IS the signal", () => {
  const dir = path.join(root, "cassettes", "strict");
  const player = createCassette({ dir, mode: "replay", strict: true });
  assert.throws(
    () => player.lookup({ url: "https://x.test/v1", body: "{}", model: "m", task: "jumpForward" }),
    /cassette miss for jumpForward.*prompt has\s+changed/s,
  );
});

test("auto replay returns null on a miss so the caller can fall through", () => {
  const dir = path.join(root, "cassettes", "auto");
  const player = createCassette({ dir, mode: "replay", strict: false });
  assert.equal(player.lookup({ url: "https://x.test/v1", body: "{}", model: "m" }), null);
  assert.equal(player.stats.misses, 1);
});

test("promote copies a cassette into fixtures for committing", () => {
  const from = path.join(root, "cassettes", "run-1");
  const to = path.join(root, "fixtures", "cassettes", "baseline");
  const count = promoteCassette({ from, to });
  assert.equal(count, 1);
  assert.equal(fs.readdirSync(to).length, 1);
});

test("quota reserves BEFORE spending, so a kill over-counts rather than under", () => {
  const file = path.join(root, "quota.json");
  const quota = createQuota({ file, perDay: 3 });

  quota.reserve("jumpForward");
  // The ledger is on disk already — before any request could have been made.
  const ledger = JSON.parse(fs.readFileSync(file, "utf8"));
  const day = new Date().toISOString().slice(0, 10);
  assert.equal(ledger[day].calls, 1, "the call is counted before it is made");

  quota.reserve();
  quota.reserve();
  assert.throws(() => quota.reserve(), QuotaExhausted, "the daily ceiling is enforced");
});

test("quota survives a process restart", () => {
  const file = path.join(root, "quota-restart.json");
  createQuota({ file, perDay: 2 }).reserve();
  // A brand new instance, as if the harness had been killed and rerun.
  const revived = createQuota({ file, perDay: 2 });
  assert.equal(revived.spentToday(), 1, "yesterday's process still counts against today's budget");
  revived.reserve();
  assert.throws(() => revived.reserve(), QuotaExhausted);
});

test("a per-run budget is separate from the daily one", () => {
  const file = path.join(root, "quota-run.json");
  const quota = createQuota({ file, perDay: 100, perRun: 2 });
  quota.reserve();
  quota.reserve();
  assert.throws(() => quota.reserve(), /run budget of 2/);
});

test("a refund gives back a call that never left the machine", () => {
  const file = path.join(root, "quota-refund.json");
  const quota = createQuota({ file, perDay: 1 });
  quota.reserve();
  quota.refund();
  assert.doesNotThrow(() => quota.reserve(), "a cassette hit must not consume budget");
});
