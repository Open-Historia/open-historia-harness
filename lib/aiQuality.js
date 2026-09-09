// "Are the AI responses any good?" — answered from state and telemetry rather
// than opinion, wherever that is possible.
//
// Four of the five measures here cost nothing extra: they fall out of the turns a
// run was already going to play. Only the rubric judge (judge.js) spends more
// quota, which is why it is opt-in.

const asArray = (value) => (Array.isArray(value) ? value : []);

/**
 * Per-task telemetry from a run's journal.
 *
 * The useful signal is buried in the call count: runJsonTask makes a second
 * provider call only when the first answer failed schema or semantic validation,
 * so two calls attributed to one task means the model got it wrong first time.
 */
export const taskTelemetry = (records) => {
  const byTask = {};
  for (const record of records) {
    if (record.kind !== "turn") continue;
    const task = record.task ?? "unknown";
    byTask[task] ??= { runs: 0, ai: 0, fallback: 0, retried: 0, msValues: [], mapTruthValues: [] };
    const entry = byTask[task];
    entry.runs += 1;
    if (record.generation?.source === "fallback") entry.fallback += 1;
    else entry.ai += 1;
    if ((record.providerCalls ?? 0) > 1) entry.retried += 1;
    if (Number.isFinite(record.ms)) entry.msValues.push(record.ms);
    if (typeof record.mapTruth === "number") entry.mapTruthValues.push(record.mapTruth);
  }

  const median = (values) => {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  };

  return Object.entries(byTask).map(([task, entry]) => ({
    task,
    runs: entry.runs,
    ai: entry.ai,
    fallback: entry.fallback,
    retried: entry.retried,
    medianMs: median(entry.msValues),
    medianMapTruth: median(entry.mapTruthValues),
  }));
};

export const renderTelemetry = (rows) => {
  if (!rows.length) return "no AI tasks recorded";
  const out = ["task              runs  ai   fallback  retry  medianMs  mapTruth"];
  for (const row of rows) {
    out.push(
      `${row.task.padEnd(18)}${String(row.runs).padEnd(6)}${String(row.ai).padEnd(5)}` +
        `${String(row.fallback).padEnd(10)}${String(row.retried).padEnd(7)}` +
        `${String(row.medianMs ?? "-").padEnd(10)}${row.medianMapTruth ?? "-"}`,
    );
  }
  return out.join("\n");
};

/**
 * Objective faults in one generated turn, all checkable from state.
 *
 * These target the specific failure modes the game's own prompt directives were
 * written to fight — which means they were previously only observable by a human
 * noticing something looked wrong.
 */
export const auditTurn = ({ diff, before, after, minEvents = null, maxEvents = null }) => {
  const faults = [];
  const events = asArray(diff?.events?.added);

  // [Map Truth]: territory narrated but never moved.
  const unapplied = asArray(diff?.reconciliation?.transfers?.unapplied);
  if (unapplied.length) {
    faults.push({
      kind: "unapplied-transfer",
      count: unapplied.length,
      detail: unapplied.slice(0, 5),
      note: "the story claims territory changed hands but the map did not move",
    });
  }

  // [Unit Coordinates]: troops narrated but never placed, or placed at null island.
  for (const shortfall of asArray(diff?.reconciliation?.unitOps?.shortfalls)) {
    faults.push({ kind: "unapplied-unitop", ...shortfall });
  }
  const nullIsland = asArray(after?.world?.units).filter(
    (unit) => Math.abs(Number(unit.lng) || 0) < 0.01 && Math.abs(Number(unit.lat) || 0) < 0.01,
  );
  if (nullIsland.length) {
    faults.push({ kind: "null-island-unit", count: nullIsland.length, detail: nullIsland.map((u) => u.id) });
  }

  // [Polity Names]: owners must be full country names, never 3-letter codes.
  const codeLike = new Set();
  for (const move of asArray(diff?.regions?.transferred)) {
    for (const owner of [move.from, move.to]) {
      if (typeof owner === "string" && /^[A-Z]{2,3}$/.test(owner)) codeLike.add(owner);
    }
  }
  if (codeLike.size) {
    faults.push({
      kind: "owner-is-a-code",
      detail: [...codeLike],
      note: "an owner that looks like a country code mints a phantom country beside the real one",
    });
  }

  // Event count against what the engine actually asked for.
  if (minEvents !== null && events.length < minEvents) {
    faults.push({ kind: "too-few-events", count: events.length, expected: `${minEvents}-${maxEvents}` });
  }
  if (maxEvents !== null && events.length > maxEvents) {
    faults.push({ kind: "too-many-events", count: events.length, expected: `${minEvents}-${maxEvents}` });
  }

  // Dates outside the window the jump covered.
  const from = before?.game?.gameDate;
  const to = after?.game?.gameDate;
  if (from && to) {
    const strays = events.filter((event) => event.date && (event.date < from || event.date > to));
    if (strays.length) {
      faults.push({
        kind: "event-outside-window",
        count: strays.length,
        detail: strays.slice(0, 5).map((e) => ({ date: e.date, title: e.title })),
        window: [from, to],
      });
    }
  }

  // Events that restate one another — the failure dedupeEventLog exists to catch.
  const titles = events.map((e) => String(e.title ?? "").toLowerCase().trim()).filter(Boolean);
  const duplicates = titles.filter((title, index) => titles.indexOf(title) !== index);
  if (duplicates.length) {
    faults.push({ kind: "restated-event", count: duplicates.length, detail: [...new Set(duplicates)] });
  }

  return { faults, eventCount: events.length, clean: faults.length === 0 };
};

/**
 * Spread across N generations from IDENTICAL starting state.
 *
 * Reported as a distribution rather than a pass/fail, because "the model varies"
 * is the honest finding — a single sample would flatter or condemn it at random.
 */
export const summariseConsistency = (audits) => {
  const counts = audits.map((audit) => audit.eventCount);
  const byKind = {};
  for (const audit of audits) {
    for (const fault of audit.faults) byKind[fault.kind] = (byKind[fault.kind] ?? 0) + 1;
  }
  return {
    runs: audits.length,
    clean: audits.filter((a) => a.clean).length,
    eventCounts: counts,
    medianEvents: counts.length ? [...counts].sort((a, b) => a - b)[Math.floor(counts.length / 2)] : null,
    faultsByKind: byKind,
  };
};
