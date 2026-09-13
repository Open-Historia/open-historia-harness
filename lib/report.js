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

/**
 * A Game export's Settings record, quoted whole: every toggle the player had on
 * is a candidate for why a bug does or does not reproduce, and only the model and
 * reasoning are ever applied.
 */
export const settingsRecordSection = (text) => [
  "## Settings record",
  "",
  "What the player's game recorded in the export's settings.txt. A record, not applied — except the model " +
    "and reasoning, with live AI on the player's own provider.",
  "",
  "```text",
  String(text).trimEnd(),
  "```",
];

export const buildReport = (runDir) => {
  const state = readRunState(runDir) ?? {};
  const { records, truncated } = readJournal(runDir);
  const summary = summariseJournal(records);

  const turns = records.filter((r) => r.kind === "turn");
  const failures = records.filter((r) => r.kind === "assert" && !r.ok);
  const logs = records.filter((r) => r.kind === "log");
  const save = records.find((r) => r.kind === "run.save") ?? null;

  return { state, summary, turns, failures, logs, save, truncated, records };
};

export const renderReportMarkdown = (report) => {
  const { state, summary, turns, failures, logs, save, truncated } = report;
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
  if (save) {
    const [headline, ...detail] = save.lines ?? [];
    out.push(line("save", String(headline ?? "").replace(/^Save:\s*/, "")));
    for (const entry of detail) out.push(`  - ${entry.trim()}`);
    // Before any finding, because they change how every finding reads.
    for (const warning of save.warnings ?? []) {
      out.push("");
      out.push(`> **Warning:** ${warning}`);
    }
  }
  if (truncated) {
    out.push("");
    out.push("> The journal's final record was cut off mid-write, so this run was killed rather than stopped. Everything above is what completed.");
  }

  if (save?.importFindings?.length) {
    out.push("");
    out.push("## Import findings");
    out.push("");
    out.push(
      "The Game as the game's importer stored it differs from the Game export it was given: bugs in the " +
        "import, not in the player's Save.",
    );
    out.push("");
    for (const finding of save.importFindings) out.push(`- ${finding.summary}`);
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

  if (save?.settingsText) out.push("", ...settingsRecordSection(save.settingsText));

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
