// Being killed is the normal exit path, not an exceptional one.
//
// When I hit a session or weekly limit this process dies without warning. Three
// things must not happen: an orphaned Node process quietly playing turns and
// burning Gemini quota; a git worktree stranded inside the user's repo; and a run
// losing everything it had achieved.
//
// Four independent stoppers, because on Windows a killed parent usually just
// orphans the child rather than signalling it:
//
//   1. signals          SIGINT/SIGTERM/SIGBREAK/SIGHUP
//   2. orphan detection the parent pid stops existing -> my session died
//   3. wall-clock cap   an absolute ceiling regardless of state
//   4. idle timeout     no completed step for N minutes -> assume wedged
//
// All four converge on one shutdown path, so cleanup is written once.

import fs from "node:fs";
import path from "node:path";

import { RUN_STATUS, readHeartbeat, readJournal, readRunState, summariseJournal } from "./journal.js";

export const STALE_HEARTBEAT_MS = 30_000;

/** Is a pid still alive? Signal 0 checks existence without delivering anything. */
export const processAlive = (pid) => {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to someone else — still alive.
    return error.code === "EPERM";
  }
};

/**
 * Install the four stoppers.
 *
 * `onShutdown(reason)` runs at most once and should do the actual cleanup:
 * finalize the journal, stop the server, release the worktree.
 */
export const installLifecycle = ({
  journal,
  onShutdown,
  maxRuntimeMs = 30 * 60 * 1000,
  idleTimeoutMs = 5 * 60 * 1000,
  orphanCheckMs = 5000,
  parentPid = process.ppid,
  exit = true,
} = {}) => {
  let shuttingDown = false;
  const timers = [];
  const signalHandlers = [];

  const finish = async (reason, code) => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const timer of timers) clearInterval(timer);
    for (const [signal, handler] of signalHandlers) process.off(signal, handler);

    // Record WHY before doing anything that might itself fail, so an unexpected
    // shutdown is always explainable rather than mysterious.
    try {
      journal?.log("warn", `shutting down: ${reason}`);
    } catch {
      // A dying journal must not block cleanup.
    }

    try {
      await onShutdown?.(reason);
    } finally {
      try {
        journal?.finalize(
          reason === "complete" ? RUN_STATUS.complete : RUN_STATUS.interrupted,
          { reason },
        );
      } catch {
        // Nothing left to do about it.
      }
      if (exit) process.exit(code);
    }
  };

  for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"]) {
    const handler = () => {
      // A second Ctrl-C must always kill, even if the first is stuck in cleanup.
      if (shuttingDown) process.exit(130);
      void finish(`received ${signal}`, 6);
    };
    try {
      process.on(signal, handler);
      signalHandlers.push([signal, handler]);
    } catch {
      // SIGBREAK/SIGHUP are not available everywhere.
    }
  }

  // The one that actually stops runaway quota burn. If my session dies, this
  // process is reparented or orphaned and its original parent no longer exists —
  // which is the only reliable cross-platform signal that nobody is watching.
  if (parentPid) {
    const timer = setInterval(() => {
      if (!processAlive(parentPid)) void finish(`parent process ${parentPid} is gone`, 6);
    }, orphanCheckMs);
    timer.unref?.();
    timers.push(timer);
  }

  if (maxRuntimeMs > 0) {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - startedAt > maxRuntimeMs) {
        void finish(`exceeded max runtime of ${Math.round(maxRuntimeMs / 60000)} min`, 6);
      }
    }, Math.min(orphanCheckMs, maxRuntimeMs));
    timer.unref?.();
    timers.push(timer);
  }

  if (idleTimeoutMs > 0 && journal) {
    // Catches a wedged provider call that signals and heartbeats would both sit
    // through: the process is alive and responsive, it simply is not progressing.
    const timer = setInterval(() => {
      const last = readHeartbeat(journal.runDir);
      if (last && Date.now() - last > idleTimeoutMs) {
        void finish(`idle for over ${Math.round(idleTimeoutMs / 60000)} min`, 6);
      }
    }, Math.min(orphanCheckMs, idleTimeoutMs));
    timer.unref?.();
    timers.push(timer);
  }

  return {
    shutdown: (reason = "complete", code = 0) => finish(reason, code),
    get shuttingDown() {
      return shuttingDown;
    },
  };
};

/** A run directory looks abandoned when its heartbeat is stale AND its pid is dead. */
export const isAbandoned = (runDir, { now = Date.now() } = {}) => {
  const state = readRunState(runDir);
  if (!state || state.status !== RUN_STATUS.running) return false;

  const heartbeat = readHeartbeat(runDir);
  const stale = !heartbeat || now - heartbeat > STALE_HEARTBEAT_MS;
  // BOTH conditions, deliberately. A busy run can miss a heartbeat; a recycled
  // pid can look alive. Requiring both makes a false positive much harder, and a
  // false positive here means killing a healthy run.
  return stale && !processAlive(state.pid);
};

/**
 * Recover every abandoned run: mark it interrupted, salvage its report from the
 * journal, and release what it was holding.
 *
 * Runs at startup, so the next thing I type cleans up after the last cut-off —
 * even if that was a week ago.
 */
export const recoverStaleRuns = ({ runsDir, onRelease, now = Date.now() } = {}) => {
  if (!runsDir || !fs.existsSync(runsDir)) return [];

  const recovered = [];
  for (const entry of fs.readdirSync(runsDir)) {
    const runDir = path.join(runsDir, entry);
    try {
      if (!fs.statSync(runDir).isDirectory()) continue;
    } catch {
      continue;
    }
    if (!isAbandoned(runDir, { now })) continue;

    const state = readRunState(runDir);
    const { records, truncated } = readJournal(runDir);
    const summary = summariseJournal(records);

    const next = {
      ...state,
      status: RUN_STATUS.interrupted,
      interruptedAt: new Date(now).toISOString(),
      recoveredFrom: "stale heartbeat and dead pid",
      journalTruncated: truncated,
      counts: {
        turns: summary.turns,
        assertions: summary.assertions,
        assertionFailures: summary.assertionFailures,
        aiCalls: summary.aiCalls,
        fallbacks: summary.fallbacks,
      },
    };
    fs.writeFileSync(path.join(runDir, "state.json"), `${JSON.stringify(next, null, 2)}\n`);
    fs.rmSync(path.join(runDir, "heartbeat"), { force: true });
    writeResumeNote(runDir, next, summary);

    try {
      onRelease?.(next);
    } catch {
      // Releasing a sandbox or worktree is best-effort; the run is already marked.
    }

    recovered.push({ id: entry, runDir, state: next, summary });
  }

  return recovered;
};

/**
 * A literal runbook for picking the run back up: what it was doing, how far it
 * got, what it cost, and the exact command to continue — one command per line.
 */
export const writeResumeNote = (runDir, state, summary) => {
  const lines = [
    `# Resume ${state.id}`,
    "",
    `This run was interrupted (${state.recoveredFrom ?? "unknown reason"}).`,
    "",
    "## Where it got to",
    "",
    `- target: ${state.target ?? "unknown"}`,
    `- scenario: ${(summary.scenarios ?? []).join(", ") || "none recorded"}`,
    `- turns completed: ${summary.turns}`,
    `- assertions: ${summary.assertions - summary.assertionFailures}/${summary.assertions} passed`,
    `- AI calls spent: ${summary.aiCalls}`,
    `- fallbacks: ${summary.fallbacks}`,
    summary.mapTruth === null ? "- map truth: n/a" : `- map truth: ${summary.mapTruth}`,
    state.journalTruncated ? "- NOTE: the journal's last record was cut off mid-write." : null,
    "",
    "## To continue",
    "",
    "```",
    `oh-harness --resume ${state.id}`,
    "```",
    "",
    "## To see what it found",
    "",
    "```",
    `oh-harness --status`,
    "```",
    "",
    "Full detail is in report.md beside this file.",
    "",
  ].filter((line) => line !== null);

  fs.writeFileSync(path.join(runDir, "RESUME.md"), `${lines.join("\n")}\n`);
};

/** Every run this harness knows about, newest first. For --status. */
export const listRuns = (runsDir) => {
  if (!runsDir || !fs.existsSync(runsDir)) return [];
  return fs
    .readdirSync(runsDir)
    .map((entry) => {
      const runDir = path.join(runsDir, entry);
      const state = readRunState(runDir);
      if (!state) return null;
      const live = state.status === RUN_STATUS.running && processAlive(state.pid);
      return { id: entry, runDir, state, live, summary: summariseJournal(readJournal(runDir).records) };
    })
    .filter(Boolean)
    .sort((a, b) => String(b.state.startedAt).localeCompare(String(a.state.startedAt)));
};
