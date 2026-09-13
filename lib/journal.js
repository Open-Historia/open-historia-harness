// Progress on disk, written as it happens.
//
// The agent driving a run hits session and weekly limits, and when that happens
// this process is killed without warning. So nothing is held in memory waiting for a tidy ending: every
// completed step is appended to journal.jsonl and fsynced, and the report is
// REGENERATED from that journal rather than buffered. A run killed at turn 8 of 20
// still has eight complete turns, a valid report and an accurate AI-call count.
//
// The journal is append-only and line-delimited precisely because a kill can land
// mid-write. A truncated final line loses one record; it cannot corrupt the ones
// before it, which is the property a single big JSON document would not have.

import fs from "node:fs";
import path from "node:path";

export const RUN_STATUS = {
  running: "running",
  complete: "complete",
  interrupted: "interrupted",
  failed: "failed",
};

const nowIso = () => new Date().toISOString();

/** Timestamped, filesystem-safe, and sorts chronologically. */
export const makeRunId = (label = "run", now = new Date()) =>
  `${now.toISOString().replace(/[:.]/g, "-").slice(0, 19)}-${label}`;

const writeJsonAtomic = (file, value) => {
  // state.json is read by recovery in another process, possibly while this one is
  // dying. Write-then-rename means a reader sees the old file or the new one,
  // never a half-written one.
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temp, file);
};

export const createJournal = ({ runsDir, id, meta = {} }) => {
  const runDir = path.join(runsDir, id);
  fs.mkdirSync(path.join(runDir, "turns"), { recursive: true });

  const journalPath = path.join(runDir, "journal.jsonl");
  const statePath = path.join(runDir, "state.json");
  const heartbeatPath = path.join(runDir, "heartbeat");

  // Kept open for the life of the run: reopening per record would triple the
  // syscalls on the hot path for no benefit.
  const fd = fs.openSync(journalPath, "a");
  let seq = 0;

  const state = {
    id,
    status: RUN_STATUS.running,
    pid: process.pid,
    // Recorded so recovery can tell "my parent died" from "still going". This is
    // what lets an orphaned run stop instead of burning quota unattended.
    ppid: process.ppid,
    startedAt: nowIso(),
    updatedAt: nowIso(),
    lastStep: null,
    counts: { turns: 0, assertions: 0, assertionFailures: 0, aiCalls: 0, fallbacks: 0 },
    ...meta,
  };

  const saveState = () => {
    state.updatedAt = nowIso();
    writeJsonAtomic(statePath, state);
  };

  const beat = () => {
    try {
      fs.writeFileSync(heartbeatPath, String(Date.now()));
    } catch {
      // A failed heartbeat must never take the run down; recovery treats a stale
      // one exactly as it treats a missing one.
    }
  };

  const append = (kind, payload = {}) => {
    seq += 1;
    const record = { seq, t: nowIso(), kind, ...payload };
    // fsync, not just write: the whole point is surviving a kill, and buffered
    // output that never reached the disk would defeat it.
    fs.writeSync(fd, `${JSON.stringify(record)}\n`);
    try {
      fs.fsyncSync(fd);
    } catch {
      // Some filesystems refuse fsync on append handles; the write still landed.
    }
    state.lastStep = { seq, kind, at: record.t };
    beat();
    return record;
  };

  const journal = {
    id,
    runDir,
    journalPath,
    statePath,
    heartbeatPath,
    get state() {
      return state;
    },

    start(payload) {
      append("run.start", payload);
      saveState();
      return journal;
    },

    /** What the run was opened on, as the report shows it (gameExport.js saveForReport). */
    save(payload) {
      return append("run.save", payload);
    },

    scenario(name, payload = {}) {
      return append("scenario.start", { scenario: name, ...payload });
    },

    /** One completed turn, with its before/after/diff written beside the journal. */
    turn(index, { before, after, diff, generation, ms, providerCalls, task }) {
      const dir = path.join(runDir, "turns");
      const stem = String(index).padStart(2, "0");
      const files = {};
      for (const [name, value] of Object.entries({ before, after, diff })) {
        if (value === undefined) continue;
        const file = path.join(dir, `${stem}-${name}.json`);
        fs.writeFileSync(file, JSON.stringify(value, null, 2));
        files[name] = path.relative(runDir, file);
      }

      state.counts.turns += 1;
      if (generation?.source === "fallback") state.counts.fallbacks += 1;
      state.counts.aiCalls += providerCalls ?? 0;

      const record = append("turn", {
        index,
        task,
        ms,
        providerCalls: providerCalls ?? 0,
        generation: generation ?? null,
        mapTruth: diff?.reconciliation?.mapTruthScore ?? null,
        transferred: diff?.regions?.transferred?.length ?? 0,
        events: diff?.events?.count ?? 0,
        files,
      });
      saveState();
      return record;
    },

    assertion({ ok, message, detail = null }) {
      state.counts.assertions += 1;
      if (!ok) state.counts.assertionFailures += 1;
      return append("assert", { ok, message, detail });
    },

    aiCall(payload) {
      state.counts.aiCalls += 1;
      return append("ai.call", payload);
    },

    log(level, message, detail = null) {
      return append("log", { level, message, detail });
    },

    beat,

    /** Mark the run finished. Idempotent, because shutdown can arrive twice. */
    finalize(status = RUN_STATUS.complete, payload = {}) {
      if (state.status !== RUN_STATUS.running) return state;
      state.status = status;
      state.finishedAt = nowIso();
      append("run.end", { status, ...payload });
      saveState();
      try {
        fs.closeSync(fd);
      } catch {
        // Already closed.
      }
      try {
        fs.rmSync(heartbeatPath, { force: true });
      } catch {
        // Nothing depends on the heartbeat surviving.
      }
      return state;
    },
  };

  saveState();
  beat();
  return journal;
};

/**
 * Read a journal back.
 *
 * Skips unparseable lines rather than throwing: the LAST line of a killed run is
 * routinely half-written, and losing one record must never cost the other
 * hundreds.
 */
export const readJournal = (runDir) => {
  const file = path.join(runDir, "journal.jsonl");
  if (!fs.existsSync(file)) return { records: [], truncated: false };

  const lines = fs.readFileSync(file, "utf8").split("\n");
  const records = [];
  let truncated = false;
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      truncated = true; // almost certainly the tail of an interrupted write
    }
  }
  return { records, truncated };
};

export const readRunState = (runDir) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(runDir, "state.json"), "utf8"));
  } catch {
    return null;
  }
};

export const readHeartbeat = (runDir) => {
  try {
    return Number(fs.readFileSync(path.join(runDir, "heartbeat"), "utf8")) || 0;
  } catch {
    return 0;
  }
};

/** Recompute the run's totals from the journal alone, ignoring state.json. */
export const summariseJournal = (records) => {
  const summary = {
    turns: 0,
    assertions: 0,
    assertionFailures: 0,
    aiCalls: 0,
    fallbacks: 0,
    scenarios: [],
    mapTruthValues: [],
    failures: [],
    status: null,
    startedAt: null,
    finishedAt: null,
  };

  for (const record of records) {
    switch (record.kind) {
      case "run.start":
        summary.startedAt = record.t;
        break;
      case "scenario.start":
        summary.scenarios.push(record.scenario);
        break;
      case "turn":
        summary.turns += 1;
        summary.aiCalls += record.providerCalls ?? 0;
        if (record.generation?.source === "fallback") summary.fallbacks += 1;
        if (typeof record.mapTruth === "number") summary.mapTruthValues.push(record.mapTruth);
        break;
      case "assert":
        summary.assertions += 1;
        if (!record.ok) {
          summary.assertionFailures += 1;
          summary.failures.push(record.message);
        }
        break;
      case "ai.call":
        summary.aiCalls += 1;
        break;
      case "run.end":
        summary.status = record.status;
        summary.finishedAt = record.t;
        break;
      default:
        break;
    }
  }

  summary.mapTruth = summary.mapTruthValues.length
    ? Number((summary.mapTruthValues.reduce((a, b) => a + b, 0) / summary.mapTruthValues.length).toFixed(3))
    : null;

  return summary;
};
