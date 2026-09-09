// The bug report, rewritten after every single finding.
//
// The agent driving this can time out, hit a usage limit, or be killed mid-run.
// So the report is never assembled at the end — it is rewritten from scratch each
// time something is added, and it is valid at every moment in between. If the run
// dies after finding three bugs, the file on disk describes three bugs.
//
// It is written for a human to act on: what happened, how to reproduce it, and
// how much it matters.

import fs from "node:fs";
import path from "node:path";

import { redact } from "./redact.js";
import { SEVERITY_ORDER, sortFindings } from "./invariants.js";

const SEVERITY_LABEL = {
  critical: "CRITICAL",
  high: "HIGH",
  medium: "MEDIUM",
  low: "LOW",
};

export const createBugReport = ({ file, meta }) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const state = {
    meta: { ...meta, startedAt: new Date().toISOString() },
    findings: [],
    crashes: [],
    timeline: [],
    status: "running",
    counts: { turns: 0, actions: 0, aiCalls: 0, fallbacks: 0 },
  };

  const seen = new Set();

  const flush = () => {
    // Rewritten in full, not appended: the file must be coherent at every instant,
    // and a half-appended section is not.
    fs.writeFileSync(file, render(state));
  };

  const api = {
    file,
    get state() {
      return state;
    },
    get findings() {
      return [...state.findings];
    },

    /**
     * Record a finding. Deduplicated by id plus summary, because a fuzz run will
     * hit the same invariant fifty times and a report listing it fifty times is
     * one nobody reads.
     */
    add(finding, { step = null } = {}) {
      const key = `${finding.id}::${finding.summary}`;
      const existing = state.findings.find((entry) => entry.key === key);
      if (existing) {
        existing.occurrences += 1;
        if (step && existing.steps.length < 5) existing.steps.push(step);
        flush();
        return existing;
      }
      const entry = {
        key,
        ...finding,
        occurrences: 1,
        firstSeenAt: new Date().toISOString(),
        steps: step ? [step] : [],
      };
      state.findings.push(entry);
      seen.add(key);
      flush();
      return entry;
    },

    /** An exception that escaped the engine. Always worth reporting verbatim. */
    crash(error, { step = null, context = null } = {}) {
      state.crashes.push({
        at: new Date().toISOString(),
        message: redact(error?.message ?? String(error)),
        stack: redact(error?.stack ?? "").split("\n").slice(0, 12).join("\n"),
        step,
        context,
      });
      flush();
    },

    /** What the run did, so a finding can be traced back to the action that caused it. */
    step(description, detail = null) {
      state.timeline.push({ at: new Date().toISOString(), description, detail });
      // Keep the timeline bounded: a level-5 run makes hundreds of moves and the
      // last fifty are the ones that matter.
      if (state.timeline.length > 200) state.timeline.splice(0, state.timeline.length - 200);
      flush();
    },

    count(key, delta = 1) {
      state.counts[key] = (state.counts[key] ?? 0) + delta;
    },

    finish(status = "complete", note = null) {
      state.status = status;
      state.finishedAt = new Date().toISOString();
      if (note) state.note = note;
      flush();
      return state;
    },
  };

  flush();
  return api;
};

const severityCounts = (findings) => {
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const finding of findings) counts[finding.severity] = (counts[finding.severity] ?? 0) + 1;
  return counts;
};

export const render = (state) => {
  const out = [];
  const findings = sortFindings(state.findings);
  const counts = severityCounts(findings);

  out.push(`# Bug report — Open Historia`);
  out.push("");
  out.push(`**Status:** ${state.status}${state.status === "running" ? " (this file is rewritten as the run progresses)" : ""}`);
  out.push(`**Level:** ${state.meta.level} — ${state.meta.levelName}`);
  out.push(`**Target:** ${state.meta.target}`);
  out.push(`**Save:** ${state.meta.fixture ?? "fresh scenario"}`);
  out.push(`**AI:** ${state.meta.ai === "live" ? `${state.meta.provider} (${state.meta.model || "default"})` : "off — deterministic fallback"}`);
  out.push(`**Seed:** ${state.meta.seed} (rerun with \`--seed ${state.meta.seed}\` to reproduce)`);
  out.push(`**Started:** ${state.meta.startedAt}`);
  if (state.finishedAt) out.push(`**Finished:** ${state.finishedAt}`);
  out.push("");

  const causedFindings = findings.filter((f) => !f.preExisting);
  const inheritedCount = findings.length - causedFindings.length;
  const causedCounts = severityCounts(causedFindings);
  out.push(
    `**Caused by this run:** ${causedCounts.critical} critical · ${causedCounts.high} high · ` +
      `${causedCounts.medium} medium · ${causedCounts.low} low · ` +
      `${state.crashes.length} crash${state.crashes.length === 1 ? "" : "es"}`,
  );
  if (inheritedCount) {
    out.push("");
    out.push(
      `**Already in the save:** ${inheritedCount} — listed separately below, because they were true ` +
        `before anything here ran.`,
    );
  }
  out.push("");
  out.push(
    `Played ${state.counts.turns} turns and ${state.counts.actions} other actions` +
      (state.meta.ai === "live" ? `, using ${state.counts.aiCalls} model calls (${state.counts.fallbacks} fell back).` : "."),
  );
  out.push("");

  if (!causedFindings.length && !state.crashes.length) {
    out.push(
      state.status === "running"
        ? "No problems found yet."
        : inheritedCount
          ? "**Nothing was broken by this run.** Every invariant that held at the start still held at the end."
          : "**No problems found.** Every invariant held for the whole run.",
    );
    out.push("");
  }

  if (state.crashes.length) {
    out.push("## Crashes");
    out.push("");
    out.push("An exception escaped the engine. These are always worth looking at, whatever the level.");
    out.push("");
    for (const crash of state.crashes.slice(0, 20)) {
      out.push(`### ${crash.message}`);
      out.push("");
      if (crash.step) out.push(`Doing: \`${crash.step}\``);
      out.push("");
      out.push("```");
      out.push(crash.stack);
      out.push("```");
      out.push("");
    }
  }

  const caused = findings.filter((f) => !f.preExisting);
  const inherited = findings.filter((f) => f.preExisting);

  if (caused.length) {
    out.push("## Findings");
    out.push("");
    out.push("Problems that appeared during this run.");
    out.push("");
    for (const finding of caused) {
      out.push(`### ${SEVERITY_LABEL[finding.severity] ?? finding.severity}: ${finding.summary}`);
      out.push("");
      out.push(`- **id:** \`${finding.id}\``);
      out.push(`- **seen:** ${finding.occurrences}×, first at ${finding.firstSeenAt}`);
      if (finding.context) out.push(`- **during:** ${finding.context}`);
      if (finding.steps?.length) {
        out.push(`- **after:** ${finding.steps.map((s) => `\`${s}\``).join(", ")}`);
      }
      if (finding.detail?.why) out.push(`- **why it matters:** ${finding.detail.why}`);
      out.push("");
      if (finding.detail) {
        const { why, ...rest } = finding.detail;
        if (Object.keys(rest).length) {
          out.push("```json");
          out.push(redact(JSON.stringify(rest, null, 2)).slice(0, 2000));
          out.push("```");
          out.push("");
        }
      }
    }
  }

  if (inherited.length) {
    out.push("## Already present before the run started");
    out.push("");
    out.push(
      "These were true of the save the moment it was opened, so they were not caused by anything " +
        "here. They are still worth looking at — a save carrying invalid state is a bug that already " +
        "happened — but do not go hunting for the code path that broke them during this run.",
    );
    out.push("");
    for (const finding of inherited) {
      out.push(`- **${SEVERITY_LABEL[finding.severity] ?? finding.severity}** \`${finding.id}\` — ${finding.summary}`);
      if (finding.detail?.why) out.push(`  - ${finding.detail.why}`);
    }
    out.push("");
  }

  if (state.timeline.length) {
    out.push("## What the run did");
    out.push("");
    out.push("The last actions before the report was written, most recent last.");
    out.push("");
    out.push("```");
    for (const entry of state.timeline.slice(-60)) {
      out.push(`${entry.at.slice(11, 19)}  ${entry.description}`);
    }
    out.push("```");
    out.push("");
  }

  out.push("## Reproducing this");
  out.push("");
  out.push("```");
  out.push(state.meta.command ?? "(command not recorded)");
  out.push("```");
  out.push("");
  out.push(
    "The seed makes the sequence of actions deterministic. With `--ai live` the model's own " +
      "answers still vary, so a finding that depends on a specific generation may not recur; " +
      "record the run with `--record <name>` to make even that reproducible.",
  );
  out.push("");

  return out.join("\n");
};
