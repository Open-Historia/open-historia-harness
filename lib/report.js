// report.json and report.md, regenerated from the journal after every step.
//
// Derived artefacts, never buffered. That is what lets a killed run still have a
// valid report covering everything it managed to do, and it means recovery in a
// LATER process can rebuild the report of a run it never witnessed.

import fs from "node:fs";
import path from "node:path";

import { readJournal, readRunState, summariseJournal } from "./journal.js";
import { renderSummaryLine } from "./render.js";

const line = (label, value) => `- **${label}:** ${value}`;

export const buildReport = (runDir) => {
  const state = readRunState(runDir) ?? {};
  const { records, truncated } = readJournal(runDir);
  const summary = summariseJournal(records);

  const turns = records.filter((r) => r.kind === "turn");
  const failures = records.filter((r) => r.kind === "assert" && !r.ok);
  const logs = records.filter((r) => r.kind === "log");

  return { state, summary, turns, failures, logs, truncated, records };
};

export const renderReportMarkdown = (report) => {
  const { state, summary, turns, failures, logs, truncated } = report;
  const out = [];

  out.push(`# Harness run — ${state.id ?? "unknown"}`);
  out.push("");
  out.push(line("status", state.status ?? "unknown"));
  out.push(line("target", state.target ?? "unknown"));
  out.push(line("scenario", (summary.scenarios ?? []).join(", ") || "none"));
  out.push(line("started", summary.startedAt ?? state.startedAt ?? "?"));
  if (summary.finishedAt) out.push(line("finished", summary.finishedAt));
  out.push(line("turns", summary.turns));
  out.push(line("assertions", `${summary.assertions - summary.assertionFailures}/${summary.assertions} passed`));
  out.push(line("AI calls", summary.aiCalls));
  out.push(line("fallbacks", summary.fallbacks));
  out.push(line("map truth", summary.mapTruth === null ? "n/a" : summary.mapTruth));
  if (truncated) {
    out.push("");
    out.push("> The journal's final record was cut off mid-write, so this run was killed rather than stopped. Everything above is what completed.");
  }

  if (failures.length) {
    out.push("");
    out.push("## Failures");
    out.push("");
    for (const failure of failures) {
      out.push(`### ${failure.message}`);
      out.push("");
      if (failure.detail) {
        out.push("```json");
        out.push(JSON.stringify(failure.detail, null, 2).slice(0, 4000));
        out.push("```");
        out.push("");
      }
    }
  }

  if (turns.length) {
    out.push("");
    out.push("## Turns");
    out.push("");
    out.push("| # | task | generation | ms | AI calls | transfers | events | map truth |");
    out.push("|---|---|---|---|---|---|---|---|");
    for (const turn of turns) {
      const generation =
        turn.generation?.source === "fallback"
          ? `**fallback**`
          : (turn.generation?.source ?? "?");
      out.push(
        `| ${turn.index} | ${turn.task ?? ""} | ${generation} | ${turn.ms ?? "?"} | ` +
          `${turn.providerCalls ?? 0} | ${turn.transferred ?? 0} | ${turn.events ?? 0} | ` +
          `${turn.mapTruth === null || turn.mapTruth === undefined ? "n/a" : turn.mapTruth} |`,
      );
    }

    const fellBack = turns.filter((t) => t.generation?.source === "fallback");
    if (fellBack.length) {
      out.push("");
      out.push("### Fallbacks");
      out.push("");
      out.push("A fallback turn looks like a success from the outside — the round advances and events appear — but the model never answered.");
      out.push("");
      for (const turn of fellBack) {
        out.push(`- turn ${turn.index}: ${turn.generation?.fallbackReason ?? "unknown reason"}`);
      }
    }
  }

  const warnings = logs.filter((entry) => entry.level === "warn" || entry.level === "error");
  if (warnings.length) {
    out.push("");
    out.push("## Warnings");
    out.push("");
    for (const entry of warnings) out.push(`- ${entry.message}`);
  }

  out.push("");
  return out.join("\n");
};

/** Write report.json and report.md. Called after every step, so it is cheap on purpose. */
export const writeReport = (runDir) => {
  const report = buildReport(runDir);
  fs.writeFileSync(
    path.join(runDir, "report.json"),
    `${JSON.stringify({ state: report.state, summary: report.summary, turns: report.turns, failures: report.failures }, null, 2)}\n`,
  );
  fs.writeFileSync(path.join(runDir, "report.md"), renderReportMarkdown(report));
  return report;
};

export const summaryLineFor = (report, { target, ms, reportPath }) =>
  renderSummaryLine({
    target,
    scenarios: report.summary.scenarios.length || 1,
    pass: report.summary.assertionFailures === 0 ? 1 : 0,
    fail: report.summary.assertionFailures === 0 ? 0 : 1,
    assertionsPassed: report.summary.assertions - report.summary.assertionFailures,
    assertionsTotal: report.summary.assertions,
    aiCalls: report.summary.aiCalls,
    fallbacks: report.summary.fallbacks,
    mapTruth: report.summary.mapTruth,
    ms,
    report: reportPath,
  });
