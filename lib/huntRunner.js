// Driving a bug hunt across one or more saves, with full logging and a report
// that is valid at every instant.

import fs from "node:fs";
import path from "node:path";

import { createAiHook } from "./aiClient.js";
import { createBugReport } from "./bugReport.js";
import { createCassette } from "./cassette.js";
import { createDriver } from "./driver.js";
import { createJournal, makeRunId, RUN_STATUS } from "./journal.js";
import { installLifecycle, recoverStaleRuns } from "./lifecycle.js";
import { describeLevel, LEVELS } from "./levels.js";
import { runHunt } from "./hunt.js";
import { createQuota } from "./quota.js";
import { writeReport } from "./report.js";
import { createSession, DEFAULT_SANDBOX_ROOT } from "./session.js";
import { findGameRepo } from "./target.js";

/** Real saves in the main checkout. These are copied read-only; never written to. */
export const listRealSaves = (gameRepo) => {
  const dir = path.join(gameRepo, "server", "data", "games");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(dir, entry.name, "world.json")))
    .map((entry) => entry.name)
    .sort();
};

/**
 * Which saves to hunt in.
 *
 * "all" means a fresh scenario PLUS every real save, because they break
 * differently: a fresh world is pristine, and a real save carries years of
 * accumulated AI output — which is exactly where the interesting corruption is.
 */
export const resolveSaves = (option, gameRepo) => {
  if (!option || option === "fresh") return [null];
  const real = listRealSaves(gameRepo);
  if (option === "all") return [null, ...real];
  if (option === "saves") return real.length ? real : [null];
  return String(option)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
};

export const runBugHunt = async ({
  level = 1,
  seed = Date.now() % 100000,
  saves = "fresh",
  turns = null,
  ai = "off",
  provider = "gemini",
  model = "",
  apiKey = "",
  repo,
  branch = null,
  sandboxRoot = DEFAULT_SANDBOX_ROOT,
  runsDir,
  harnessRoot,
  maxAiCalls = 0,
  cassetteMode = "off",
  cassetteName = "hunt",
  command = "",
  quiet = false,
  onProgress = null,
} = {}) => {
  const gameRepo = findGameRepo(repo);
  const saveList = resolveSaves(saves, gameRepo);
  const spec = LEVELS[level] ?? LEVELS[1];

  const say = (text) => {
    if (!quiet) console.log(text);
    onProgress?.(text);
  };

  recoverStaleRuns({ runsDir });

  const id = makeRunId(`hunt-L${level}`);
  const runDir = path.join(runsDir, id);
  const journal = createJournal({ runsDir, id, meta: { target: "resolving...", ai, level } });

  const report = createBugReport({
    file: path.join(runDir, "BUG-REPORT.md"),
    meta: {
      level,
      levelName: spec.name,
      target: branch ?? "working tree",
      fixture: saveList.filter(Boolean).join(", ") || null,
      ai,
      provider,
      model,
      seed,
      command,
    },
  });

  say(`Bug hunt — ${describeLevel(level)}`);
  say(`Saves: ${saveList.map((s) => s ?? "fresh scenario").join(", ")}`);
  say(`Seed: ${seed}   Report: ${report.file}`);
  say("");

  let session = null;
  let exitCode = 0;

  const shutdown = async (reason) => {
    try {
      await session?.dispose();
    } catch {
      // best effort
    }
    // The report must always end in a defined state, whatever killed us.
    if (report.state.status === "running") {
      report.finish(reason === "complete" ? "complete" : "interrupted", reason);
    }
    writeReport(runDir);
  };

  const lifecycle = installLifecycle({ journal, onShutdown: shutdown, exit: false });

  try {
    const cassette = createCassette({
      dir: path.join(harnessRoot, "cassettes", cassetteName),
      mode: cassetteMode,
    });
    const quota = createQuota({
      file: path.join(sandboxRoot, "quota.json"),
      perRun: Number(maxAiCalls ?? 0),
    });
    const aiHook = createAiHook({ cassette, quota, journal, model });

    // One session per save. Each gets its own sandbox, so a save that ends up
    // corrupted cannot contaminate the next one's findings.
    for (const [index, fixture] of saveList.entries()) {
      if (lifecycle.shuttingDown) break;

      say(`--- ${fixture ?? "fresh scenario"} (${index + 1}/${saveList.length}) ---`);
      report.step(`opening ${fixture ?? "fresh scenario"}`);

      // server.js starts on import and is cached, so a second save needs its own
      // process. Within one process we hunt the first save only; the CLI loops
      // for the rest.
      session = await createSession({
        ai,
        provider,
        model,
        apiKey,
        repo: gameRepo,
        branch,
        sandboxRoot,
        fixture,
        quiet: true,
        allowWrite: [runsDir, path.join(harnessRoot, "cassettes")],
        aiHook,
      });
      journal.state.target = session.target.describe();
      journal.start({ target: session.target.describe(), level, seed, fixture });

      const driver = await createDriver(session);
      const log = {
        info: (message) => {
          journal.log("info", message);
          say(`  ${message}`);
        },
        warn: (message) => {
          journal.log("warn", message);
          say(`  ! ${message}`);
        },
      };

      await runHunt({
        driver,
        report,
        level,
        seed: seed + index,
        turns,
        log,
        onStep: (description) => journal.log("info", description),
      });

      await session.dispose();
      session = null;

      // Only the first save can run in this process. The CLI re-invokes for the rest.
      if (saveList.length > 1 && index === 0 && saveList.length > 1) break;
    }

    report.finish("complete");
    journal.finalize(RUN_STATUS.complete);
  } catch (error) {
    report.crash(error, { context: "the hunt itself failed" });
    report.finish("failed", error.message);
    journal.log("error", error.message, { stack: error.stack });
    journal.finalize(RUN_STATUS.failed, { error: error.message });
    exitCode = 2;
    say(`ERROR: ${error.message}`);
  } finally {
    await shutdown("complete");
  }

  const findings = report.findings;
  const critical = findings.filter((f) => f.severity === "critical").length;
  const high = findings.filter((f) => f.severity === "high").length;
  if (critical || report.state.crashes.length) exitCode = 1;

  return {
    id,
    runDir,
    reportFile: report.file,
    findings,
    crashes: report.state.crashes,
    counts: report.state.counts,
    exitCode,
    summary:
      `HUNT level=${level} save=${saveList[0] ?? "fresh"} findings=${findings.length} ` +
      `critical=${critical} high=${high} crashes=${report.state.crashes.length} ` +
      `turns=${report.state.counts.turns} seed=${seed} report=${path.relative(harnessRoot, report.file)}`,
  };
};
