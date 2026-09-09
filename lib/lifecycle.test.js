// The interruption story, proved by actually killing things.
//
// The user asked for this directly: when I hit a session or weekly limit, runs must
// resolve cleanly rather than leaving an orphan burning quota and a half-written
// report. Asserting that from a happy-path unit test would prove nothing, so this
// spawns real processes and SIGKILLs them.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";

import { createJournal, RUN_STATUS, readJournal, readRunState, summariseJournal } from "./journal.js";
import { isAbandoned, listRuns, processAlive, recoverStaleRuns, STALE_HEARTBEAT_MS } from "./lifecycle.js";

const LIB = path.dirname(fileURLToPath(import.meta.url));
let root;
let runsDir;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "oh-lifecycle-test-"));
  runsDir = path.join(root, "runs");
  fs.mkdirSync(runsDir, { recursive: true });
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

test("processAlive answers honestly about this process and a dead one", () => {
  assert.equal(processAlive(process.pid), true);
  assert.equal(processAlive(0), false);
  // A pid far above any plausible live process.
  assert.equal(processAlive(0x7ffffff0), false);
});

test("a journal survives being truncated mid-record", () => {
  // The exact shape of a kill landing mid-write. Losing the last line must not
  // cost the hundreds before it.
  const journal = createJournal({ runsDir, id: "truncated", meta: { target: "test" } });
  journal.start({ scenario: "smoke" });
  journal.assertion({ ok: true, message: "first" });
  journal.assertion({ ok: true, message: "second" });

  fs.appendFileSync(journal.journalPath, '{"seq":99,"kind":"assert","ok":fal');

  const { records, truncated } = readJournal(journal.runDir);
  assert.equal(truncated, true, "the tail is reported as lost");
  const summary = summariseJournal(records);
  assert.equal(summary.assertions, 2, "the intact records all survive");
});

test("the report can be rebuilt from the journal alone", () => {
  const journal = createJournal({ runsDir, id: "rebuildable", meta: { target: "test" } });
  journal.start({ scenario: "turn-basic" });
  journal.scenario("turn-basic");
  journal.turn(1, {
    before: { game: { round: 1 } },
    after: { game: { round: 2 } },
    diff: { reconciliation: { mapTruthScore: 0.8 }, regions: { transferred: [1, 2] }, events: { count: 3 } },
    generation: { source: "ai" },
    ms: 1200,
    providerCalls: 1,
    task: "jumpForward",
  });
  journal.turn(2, {
    diff: { reconciliation: { mapTruthScore: 1 }, regions: { transferred: [] }, events: { count: 2 } },
    generation: { source: "fallback", fallbackReason: "no key" },
    ms: 300,
    providerCalls: 0,
    task: "jumpForward",
  });
  journal.assertion({ ok: false, message: "Bavaria should belong to France" });

  const summary = summariseJournal(readJournal(journal.runDir).records);
  assert.equal(summary.turns, 2);
  assert.equal(summary.aiCalls, 1);
  assert.equal(summary.fallbacks, 1, "a silent fallback is counted, not swallowed");
  assert.equal(summary.assertionFailures, 1);
  assert.deepEqual(summary.failures, ["Bavaria should belong to France"]);
  assert.equal(summary.mapTruth, 0.9);

  // The per-turn artefacts are on disk beside the journal.
  assert.equal(fs.existsSync(path.join(journal.runDir, "turns", "01-diff.json")), true);
});

test("a live run is NOT treated as abandoned", () => {
  // Requiring both a stale heartbeat and a dead pid is what stops recovery
  // killing a healthy run.
  const journal = createJournal({ runsDir, id: "live", meta: {} });
  journal.start({});
  assert.equal(isAbandoned(journal.runDir), false, "fresh heartbeat, live pid");

  // Stale heartbeat but the pid (ours) is alive: still not abandoned.
  fs.writeFileSync(journal.heartbeatPath, String(Date.now() - STALE_HEARTBEAT_MS * 3));
  assert.equal(isAbandoned(journal.runDir), false, "a busy run may miss a heartbeat");
});

test("a finished run is never recovered", () => {
  const journal = createJournal({ runsDir, id: "finished", meta: {} });
  journal.start({});
  journal.finalize(RUN_STATUS.complete);
  assert.equal(isAbandoned(journal.runDir), false);
  assert.deepEqual(recoverStaleRuns({ runsDir: path.join(root, "empty") }), []);
});

test("SIGKILL leaves a run that the NEXT startup recovers", async () => {
  // The real thing: a child process writing a journal, killed with no chance to
  // clean up — exactly what a session limit does to me.
  const id = "killed";
  const script = `
    import { createJournal } from ${JSON.stringify(pathToUrl(path.join(LIB, "journal.js")))};
    const journal = createJournal({ runsDir: ${JSON.stringify(runsDir)}, id: ${JSON.stringify(id)}, meta: { target: "victim" } });
    journal.start({ scenario: "stress" });
    journal.turn(1, { diff: { reconciliation: { mapTruthScore: 1 }, regions: { transferred: [] }, events: { count: 1 } }, generation: { source: "ai" }, ms: 10, providerCalls: 2, task: "jumpForward" });
    console.log("READY");
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });

  await new Promise((resolve, reject) => {
    // unref'd, and cleared on success: an un-cleared 15 s timer held the whole
    // test file open long after its assertions had passed.
    const bail = setTimeout(() => reject(new Error("child never became ready")), 15000);
    bail.unref?.();
    child.stdout.on("data", (chunk) => {
      if (!String(chunk).includes("READY")) return;
      clearTimeout(bail);
      resolve();
    });
    child.on("error", (error) => {
      clearTimeout(bail);
      reject(error);
    });
  });

  const runDir = path.join(runsDir, id);
  assert.equal(readRunState(runDir).status, RUN_STATUS.running);

  child.kill("SIGKILL");
  await new Promise((resolve) => child.on("exit", resolve));

  // Age the heartbeat rather than sleeping 30 s in a test.
  fs.writeFileSync(path.join(runDir, "heartbeat"), String(Date.now() - STALE_HEARTBEAT_MS * 2));

  assert.equal(isAbandoned(runDir), true, "dead pid plus stale heartbeat");

  let released = null;
  const recovered = recoverStaleRuns({ runsDir, onRelease: (state) => { released = state.id; } });

  const mine = recovered.find((entry) => entry.id === id);
  assert.ok(mine, "the killed run was recovered");
  assert.equal(mine.state.status, RUN_STATUS.interrupted);
  assert.equal(mine.summary.turns, 1, "the work it DID complete survives");
  assert.equal(mine.summary.aiCalls, 2, "and so does what it spent");
  assert.equal(released, id, "the caller got a chance to release its sandbox and worktree");

  // A literal runbook, per the user's standing preference for handovers.
  const resume = fs.readFileSync(path.join(runDir, "RESUME.md"), "utf8");
  assert.match(resume, /oh-harness --resume killed/);
  assert.match(resume, /turns completed: 1/);
  assert.match(resume, /AI calls spent: 2/);

  // Recovery is idempotent: running it again must not re-recover a run it fixed.
  assert.equal(recoverStaleRuns({ runsDir }).some((entry) => entry.id === id), false);
});

test("listRuns reports each run's state, newest first", () => {
  const runs = listRuns(runsDir);
  assert.ok(runs.length >= 3);
  const byId = Object.fromEntries(runs.map((run) => [run.id, run]));
  assert.equal(byId.finished.state.status, RUN_STATUS.complete);
  assert.equal(byId.killed.state.status, RUN_STATUS.interrupted);
  assert.equal(byId.killed.live, false);
});

function pathToUrl(p) {
  return `file://${p.replace(/\\/g, "/").replace(/^([A-Za-z]:)/, "/$1")}`;
}
