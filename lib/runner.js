// Running a scenario: boot a session, hand the scenario its verbs, journal every
// step, and shut down cleanly however the run ends.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createDriver } from "./driver.js";
import { createExpect } from "./expect.js";
import { createJournal, makeRunId, RUN_STATUS } from "./journal.js";
import { installLifecycle, recoverStaleRuns } from "./lifecycle.js";
import { renderDiff, renderSnapshot } from "./render.js";
import { summaryLineFor, writeReport } from "./report.js";
import { createSession, DEFAULT_SANDBOX_ROOT } from "./session.js";

export const HARNESS_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
export const RUNS_DIR = path.join(HARNESS_ROOT, "runs");
export const SCENARIOS_DIR = path.join(HARNESS_ROOT, "scenarios");

export const listScenarios = () => {
  if (!fs.existsSync(SCENARIOS_DIR)) return [];
  return fs
    .readdirSync(SCENARIOS_DIR)
    .filter((file) => file.endsWith(".js") && !file.endsWith(".test.js"))
    .map((file) => file.replace(/\.js$/, ""))
    .sort();
};

export const loadScenario = async (name) => {
  const file = path.join(SCENARIOS_DIR, `${name}.js`);
  if (!fs.existsSync(file)) {
    throw new Error(`[harness] no scenario "${name}". Available: ${listScenarios().join(", ") || "(none)"}`);
  }
  const module = await import(pathToFileURL(file).href);
  return { name, meta: module.meta ?? {}, run: module.default };
};

/**
 * Run one or more scenarios in a single session.
 *
 * Recovery of the PREVIOUS run happens first, so the next thing I type cleans up
 * after the last cut-off even if that was a week ago.
 */
export const runScenarios = async (names, options = {}) => {
  const {
    ai = "off",
    sandboxRoot = DEFAULT_SANDBOX_ROOT,
    keep = false,
    quiet = false,
    maxRuntimeMs,
    idleTimeoutMs,
    recover = true,
    ...sessionOptions
  } = options;

  const say = (text) => {
    if (!quiet) console.log(text);
  };

  const recovered = recover
    ? recoverStaleRuns({
        runsDir: RUNS_DIR,
        onRelease: () => {
          // The sandbox and worktree of a dead run are reclaimed by --prune and by
          // the sha-keyed worktree cache; nothing to do per-run here yet.
        },
      })
    : [];
  for (const entry of recovered) {
    say(
      `recovered 1 interrupted run: ${entry.id} (${entry.summary.turns} turns, ` +
        `${entry.summary.aiCalls} AI calls) -> ${path.join(entry.runDir, "RESUME.md")}`,
    );
    writeReport(entry.runDir);
  }

  const scenarios = [];
  for (const name of names) scenarios.push(await loadScenario(name));

  const id = makeRunId(names.join("+").slice(0, 40) || "run");
  const journal = createJournal({
    runsDir: RUNS_DIR,
    id,
    meta: { target: "resolving...", ai, scenarios: names },
  });

  const startedAt = Date.now();
  let session = null;
  let exitCode = 0;

  const shutdown = async () => {
    try {
      await session?.dispose({ keep });
    } catch {
      // Disposal is best-effort; the journal is already durable.
    }
    writeReport(journal.runDir);
  };

  const lifecycle = installLifecycle({
    journal,
    onShutdown: shutdown,
    maxRuntimeMs,
    idleTimeoutMs,
    // The runner returns a result to its caller; the CLI decides the exit code.
    exit: false,
  });

  try {
    session = await createSession({
      ai,
      sandboxRoot,
      quiet: true,
      // The journal and reports for THIS run, written while the guard is active.
      allowWrite: [RUNS_DIR],
      ...sessionOptions,
    });
    journal.state.target = session.target.describe();
    journal.start({ target: session.target.describe(), sandbox: session.sandbox.describe() });
    say(`target: ${session.describe()}`);
    for (const warning of session.target.warnings ?? []) say(`WARNING: ${warning}`);

    const driver = await createDriver(session);
    const expect = createExpect({ journal });
    let turnIndex = 0;

    const log = {
      info: (message) => {
        journal.log("info", message);
        say(message);
      },
      warn: (message) => {
        journal.log("warn", message);
        say(`WARNING: ${message}`);
      },
      snapshot: (snap) => say(renderSnapshot(snap, { title: session.describe() })),
      diff: (diff) => say(renderDiff(diff)),
      /** Journal a turn outcome and print its diff. */
      turn: (outcome) => {
        turnIndex += 1;
        journal.turn(turnIndex, {
          before: outcome.before,
          after: outcome.after,
          diff: outcome.diff,
          generation: outcome.generation,
          ms: outcome.ms,
          providerCalls: outcome.providerCalls,
          task: outcome.task,
        });
        writeReport(journal.runDir);
        if (outcome.fallback) say(`FALLBACK (${outcome.task}): ${outcome.fallback}`);
        say(renderDiff(outcome.diff, { header: `[${outcome.generation?.source ?? "?"} · ${outcome.ms}ms]` }));
        return outcome;
      },
    };

    for (const scenario of scenarios) {
      if (lifecycle.shuttingDown) break;
      if (scenario.meta?.requires?.ai && ai === "off" && !options.force) {
        journal.log("info", `skipped ${scenario.name}: needs AI`);
        say(`SKIP ${scenario.name} (needs --ai; use --force to run it against the fallback)`);
        continue;
      }
      journal.scenario(scenario.name, { description: scenario.meta?.description ?? null });
      say(`\n=== ${scenario.name} ===`);
      await scenario.run({ ...driver, expect, log, session });
    }

    exitCode = expect.failed > 0 ? 1 : 0;
    journal.finalize(exitCode === 0 ? RUN_STATUS.complete : RUN_STATUS.failed, {
      assertionsFailed: expect.failed,
    });
  } catch (error) {
    journal.log("error", error.message, { stack: error.stack });
    journal.finalize(RUN_STATUS.failed, { error: error.message });
    exitCode = 2;
    say(`ERROR: ${error.message}`);
  } finally {
    await shutdown();
  }

  const report = writeReport(journal.runDir);
  const ms = Date.now() - startedAt;
  const summaryLine = summaryLineFor(report, {
    target: journal.state.target,
    ms,
    reportPath: path.relative(HARNESS_ROOT, path.join(journal.runDir, "report.md")),
  });

  return { id, runDir: journal.runDir, report, exitCode, summaryLine, recovered };
};
