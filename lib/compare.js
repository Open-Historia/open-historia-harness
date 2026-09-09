// Running the same scenario against two branches and diffing the results.
//
// This answers "does this PR actually change turn behaviour, and how" — a
// question that is otherwise answered by reading a diff and guessing.
//
// It forks, and must: server.js calls app.listen() at module scope, so importing
// it IS starting it, and the module cache means one server per process. Two
// targets therefore need two processes, which also guarantees the second run
// cannot inherit module state from the first.
//
// Under --no-ai the comparison is fully deterministic, so ANY difference is
// attributable to the branch. With live AI it is indicative only, and the report
// says so rather than implying a rigour it does not have.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const runChild = ({ cliPath, scenario, branch, extraArgs = [], cwd }) =>
  new Promise((resolve) => {
    const args = [cliPath, ...scenario, "--quiet", ...extraArgs];
    if (branch) args.push("--branch", branch);

    const child = spawn(process.execPath, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => resolve({ code, stdout, stderr, branch }));
  });

/** Pull the report path out of the machine summary line the CLI always prints last. */
const reportPathFrom = (stdout) => {
  const match = /report=(\S+)/.exec(stdout);
  return match ? match[1] : null;
};

const loadReport = (harnessRoot, stdout) => {
  const relative = reportPathFrom(stdout);
  if (!relative) return null;
  const file = path.join(harnessRoot, relative.replace(/report\.md$/, "report.json"));
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

/** The parts of a run that a branch can actually change. Timing is not one. */
const behaviour = ({ turns, transfers, events, fallbacks }) => ({ turns, transfers, events, fallbacks });

const turnStats = (report) => {
  const turns = report?.turns ?? [];
  return {
    turns: turns.length,
    transfers: turns.reduce((sum, t) => sum + (t.transferred ?? 0), 0),
    events: turns.reduce((sum, t) => sum + (t.events ?? 0), 0),
    ms: turns.reduce((sum, t) => sum + (t.ms ?? 0), 0),
    fallbacks: turns.filter((t) => t.generation?.source === "fallback").length,
  };
};

export const compareBranches = async ({
  scenario,
  branches,
  harnessRoot,
  cliPath,
  extraArgs = [],
  ai = "off",
}) => {
  const [left, right] = branches;
  const args = ai === "off" ? extraArgs : [...extraArgs, "--ai", ai];

  // Sequential, not parallel. Two live runs would race the same rate limit, and
  // two offline runs would fight over the worktree cache.
  const results = [];
  for (const branch of [left, right]) {
    const outcome = await runChild({ cliPath, scenario, branch, extraArgs: args, cwd: harnessRoot });
    results.push({ ...outcome, report: loadReport(harnessRoot, outcome.stdout) });
  }

  const [a, b] = results;
  const statsA = turnStats(a.report);
  const statsB = turnStats(b.report);

  const rows = [
    ["assertions passed", assertionLabel(a.report), assertionLabel(b.report)],
    ["turns", statsA.turns, statsB.turns],
    ["regions transferred", statsA.transfers, statsB.transfers],
    ["events generated", statsA.events, statsB.events],
    ["fallbacks", statsA.fallbacks, statsB.fallbacks],
    ["map truth", mapTruthLabel(a.report), mapTruthLabel(b.report)],
    ["turn wall time", `${statsA.ms} ms`, `${statsB.ms} ms`],
  ];

  const failuresA = new Set((a.report?.failures ?? []).map((f) => f.message));
  const failuresB = new Set((b.report?.failures ?? []).map((f) => f.message));
  const onlyA = [...failuresA].filter((m) => !failuresB.has(m));
  const onlyB = [...failuresB].filter((m) => !failuresA.has(m));

  return {
    left: { branch: left, ...a, stats: statsA },
    right: { branch: right, ...b, stats: statsB },
    rows,
    onlyA,
    onlyB,
    deterministic: ai === "off",
    // Wall time is deliberately excluded: it varies run to run on the same
    // branch, so counting it would report a difference on every comparison and
    // train us to ignore the verdict entirely.
    differs:
      a.code !== b.code ||
      onlyA.length > 0 ||
      onlyB.length > 0 ||
      JSON.stringify(behaviour(statsA)) !== JSON.stringify(behaviour(statsB)),
  };
};

const assertionLabel = (report) => {
  if (!report) return "?";
  const total = report.summary?.assertions ?? 0;
  const failed = report.summary?.assertionFailures ?? 0;
  return `${total - failed}/${total}`;
};

const mapTruthLabel = (report) => {
  const value = report?.summary?.mapTruth;
  return value === null || value === undefined ? "n/a" : String(value);
};

export const renderComparison = (comparison) => {
  const { left, right, rows, onlyA, onlyB, deterministic, differs } = comparison;
  const out = [];

  out.push(`COMPARE  ${left.branch}  vs  ${right.branch}`);
  out.push("");
  const width = Math.max(...rows.map(([label]) => label.length)) + 2;
  const col = (value) => String(value).padStart(14);
  out.push(`${"".padEnd(width)}${col(left.branch.slice(-13))}${col(right.branch.slice(-13))}`);
  for (const [label, a, b] of rows) {
    // Timing is shown but never flagged — see `behaviour` above.
    const noisy = label === "turn wall time";
    const flag = noisy || String(a) === String(b) ? "" : "   <-- differs";
    out.push(`${label.padEnd(width)}${col(a)}${col(b)}${flag}`);
  }

  if (onlyA.length || onlyB.length) {
    out.push("");
    out.push("Assertions that failed on ONE side only:");
    for (const message of onlyA) out.push(`  ${left.branch}: ${message}`);
    for (const message of onlyB) out.push(`  ${right.branch}: ${message}`);
  }

  out.push("");
  out.push(
    deterministic
      ? differs
        ? "Offline run: the model is not a variable here, so every difference above is attributable to the branch."
        : "Offline run: identical. The branch does not change turn behaviour that this scenario exercises."
      : "LIVE run: the model is a variable, so these differences are indicative, not attributable to the branch.",
  );

  return out.join("\n");
};
