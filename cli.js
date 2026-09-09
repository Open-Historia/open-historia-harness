#!/usr/bin/env node
// oh-harness — play Open Historia headlessly and report what changed.
//
// Optimised for one thing: I type one command and get back readable structured
// text. Everything else is in service of that.

import fs from "node:fs";
import path from "node:path";

import { listRuns, recoverStaleRuns } from "./lib/lifecycle.js";
import { buildReport, writeReport } from "./lib/report.js";
import { HARNESS_ROOT, RUNS_DIR, listScenarios, runScenarios } from "./lib/runner.js";
import { DEFAULT_SANDBOX_ROOT } from "./lib/session.js";
import { pruneSandboxes } from "./lib/sandbox.js";
import { configureSafety, resetSafety } from "./lib/safety.js";
import { DEFAULT_GAME_REPO, findGameRepo } from "./lib/target.js";
import { pruneWorktrees } from "./lib/worktree.js";
import { detectBlockers } from "./lib/compat.js";
import { compareBranches, renderComparison } from "./lib/compare.js";

const EXIT = { ok: 0, assertion: 1, error: 2, quota: 3, budget: 4, compat: 5, interrupted: 6 };

const parseArgs = (argv) => {
  const options = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      options._.push(arg);
      continue;
    }
    const [rawKey, inlineValue] = arg.slice(2).split("=");
    const key = rawKey.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = argv[i + 1];
    const takesValue = inlineValue !== undefined || (next && !next.startsWith("--"));
    if (!takesValue) {
      options[key] = true;
      continue;
    }
    options[key] = inlineValue !== undefined ? inlineValue : next;
    if (inlineValue === undefined) i += 1;
  }
  return options;
};

const HELP = `
oh-harness — headless test harness for Open Historia

  oh-harness <scenario...> [options]     run scenarios
  oh-harness --list                      list scenarios
  oh-harness --status                    every run, its state, how to resume
  oh-harness --doctor                    recover interrupted runs, audit, clean up
  oh-harness --prune                     drop stale sandboxes and worktrees
  oh-harness --verify-compat             report which import blockers a target has
  oh-harness <scenario> --compare a,b    run the same scenario against two branches

Target
  --repo <path>        game repo (default: ../open-historia)
  --branch <ref>       test a branch in a throwaway worktree (e.g. upstream/main)
  --fresh-worktree     rebuild the worktree instead of reusing it

Run
  --ai off|live        provider calls (default: off, uses the deterministic fallback)
  --key <k>            API key (prefer OH_HARNESS_GEMINI_KEY or the config file)
  --provider <name>    gemini | openai | anthropic | openai-compatible
  --model <name>
  --record [name]      record real model responses to cassettes/<name>
  --replay [name]      replay them: no network, no quota, deterministic
  --replay-mode strict|auto   strict fails on a miss (a changed prompt), auto falls through
  --max-ai-calls <n>   ceiling for this run
  --max-ai-calls-per-day <n>  ceiling shared across runs, survives restarts
  --geometry stock|full
  --fixture <gameId>   seed from a real save in the main checkout
  --force              run AI-only scenarios against the fallback
  --keep               keep the sandbox and worktree for inspection
  --max-runtime <min>  absolute ceiling (default 30)
  --idle-timeout <min> give up if no step completes (default 5)
  --quiet
`;

const say = (text) => console.log(text);

const cmdList = () => {
  const scenarios = listScenarios();
  say(scenarios.length ? scenarios.map((name) => `  ${name}`).join("\n") : "  (no scenarios yet)");
  return EXIT.ok;
};

const cmdStatus = () => {
  const runs = listRuns(RUNS_DIR);
  if (!runs.length) {
    say("no runs yet");
    return EXIT.ok;
  }
  for (const run of runs.slice(0, 20)) {
    const s = run.summary;
    const live = run.live ? " LIVE" : "";
    say(
      `${run.state.status.padEnd(11)}${live.padEnd(5)} ${run.id}  ` +
        `turns=${s.turns} assertions=${s.assertions - s.assertionFailures}/${s.assertions} ` +
        `ai=${s.aiCalls} fallbacks=${s.fallbacks}`,
    );
    if (run.state.status === "interrupted") {
      say(`            resume: oh-harness --resume ${run.id}`);
    }
  }
  return EXIT.ok;
};

const cmdDoctor = () => {
  const recovered = recoverStaleRuns({ runsDir: RUNS_DIR });
  for (const entry of recovered) {
    writeReport(entry.runDir);
    say(`recovered ${entry.id} (${entry.summary.turns} turns, ${entry.summary.aiCalls} AI calls)`);
  }
  if (!recovered.length) say("no interrupted runs to recover");

  const gameRepo = findGameRepo();
  configureSafety({ sandbox: DEFAULT_SANDBOX_ROOT, protect: [gameRepo, DEFAULT_GAME_REPO] });
  const worktrees = pruneWorktrees({ gameRepo, sandboxRoot: DEFAULT_SANDBOX_ROOT });
  const sandboxes = pruneSandboxes({ keepDays: 14 });
  resetSafety();

  say(`removed ${worktrees.length} worktree(s), ${sandboxes.length} stale sandbox(es)`);
  return EXIT.ok;
};

const cmdPrune = (options) => {
  const gameRepo = findGameRepo(options.repo);
  configureSafety({ sandbox: DEFAULT_SANDBOX_ROOT, protect: [gameRepo, DEFAULT_GAME_REPO] });
  const worktrees = pruneWorktrees({ gameRepo, sandboxRoot: DEFAULT_SANDBOX_ROOT });
  const sandboxes = pruneSandboxes({ keepDays: Number(options.keepDays ?? 14) });
  resetSafety();
  say(`removed ${worktrees.length} worktree(s), ${sandboxes.length} sandbox(es)`);
  return EXIT.ok;
};

const cmdVerifyCompat = (options) => {
  const target = options.repo ? findGameRepo(options.repo) : findGameRepo();
  const blockers = detectBlockers(target);
  say(`target: ${target}`);
  for (const blocker of blockers) {
    say(`  ${blocker.present ? "SHIMMED" : "not needed"}  ${blocker.id} — ${blocker.note}`);
  }
  const shimmed = blockers.filter((b) => b.present).length;
  say(`\n${shimmed} of ${blockers.length} blockers still present on this target.`);
  return EXIT.ok;
};

const cmdResume = (id) => {
  const runDir = path.join(RUNS_DIR, id === "last" ? (listRuns(RUNS_DIR)[0]?.id ?? "") : id);
  if (!fs.existsSync(runDir)) {
    say(`no such run: ${id}`);
    return EXIT.error;
  }
  const report = buildReport(runDir);
  say(`run ${path.basename(runDir)} — ${report.state.status}`);
  say(`turns completed: ${report.summary.turns}, AI calls spent: ${report.summary.aiCalls}`);
  say("");
  say("Resuming a partially-played run is not implemented yet; its report and per-turn");
  say("state are complete and readable:");
  say(`  ${path.join(runDir, "report.md")}`);
  return EXIT.ok;
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));

  if (options.help || options.h) {
    say(HELP.trim());
    return EXIT.ok;
  }
  if (options.list) return cmdList();
  if (options.status) return cmdStatus();
  if (options.doctor) return cmdDoctor();
  if (options.prune) return cmdPrune(options);
  if (options.verifyCompat) return cmdVerifyCompat(options);
  if (options.resume) return cmdResume(String(options.resume));

  if (options.compare) {
    const branches = String(options.compare).split(",").map((s) => s.trim()).filter(Boolean);
    if (branches.length !== 2) {
      say("--compare takes two refs, e.g. --compare main,upstream/custom-stats");
      return EXIT.error;
    }
    const scenario = options._.length ? options._ : ["smoke"];
    const comparison = await compareBranches({
      scenario,
      branches,
      harnessRoot: HARNESS_ROOT,
      cliPath: path.join(HARNESS_ROOT, "cli.js"),
      ai: options.ai === "live" ? "live" : "off",
    });
    say(renderComparison(comparison));
    return comparison.differs ? EXIT.assertion : EXIT.ok;
  }

  const names = options._.length ? options._ : options.selfTest ? listScenarios() : [];
  if (!names.length) {
    say(HELP.trim());
    return EXIT.ok;
  }

  const apiKey =
    options.key ??
    process.env.OH_HARNESS_GEMINI_KEY ??
    process.env.GEMINI_API_KEY ??
    readConfigKey();

  // Replay needs provider calls routed to the hook even with no key, since a
  // cassette answers without the network.
  const ai = options.replay ? "replay" : options.ai === "live" || options.ai === true ? "live" : "off";

  if (ai === "live" && !apiKey) {
    say("No API key found. Set one of:");
    say("  OH_HARNESS_GEMINI_KEY=<key>            (environment)");
    say(`  ${path.join(process.env.USERPROFILE ?? "~", ".open-historia-harness.json")}   {"gemini":{"apiKey":"..."}}`);
    say("  harness.config.json in this repo       (gitignored)");
    say("");
    say("Or run without --ai to use the deterministic fallback, which costs nothing.");
    return EXIT.error;
  }

  const result = await runScenarios(names, {
    ai,
    cassetteMode: options.record ? "record" : options.replay ? "replay" : "off",
    cassetteName: (typeof options.record === "string" && options.record) ||
      (typeof options.replay === "string" && options.replay) ||
      "default",
    replayMode: options.replayMode ?? "auto",
    maxAiCalls: Number(options.maxAiCalls ?? 0),
    maxAiCallsPerDay: Number(options.maxAiCallsPerDay ?? 0),
    repo: options.repo,
    branch: options.branch ?? null,
    fresh: Boolean(options.freshWorktree),
    geometry: options.geometry ?? "stock",
    fixture: options.fixture ?? null,
    provider: options.provider ?? "gemini",
    model: options.model ?? "",
    apiKey: apiKey ?? "",
    keep: Boolean(options.keep),
    force: Boolean(options.force),
    quiet: Boolean(options.quiet),
    maxRuntimeMs: options.maxRuntime ? Number(options.maxRuntime) * 60000 : undefined,
    idleTimeoutMs: options.idleTimeout ? Number(options.idleTimeout) * 60000 : undefined,
  });

  say("");
  if (result.quota?.spentThisRun) {
    say(`quota: ${result.quota.spentThisRun} calls this run, ${result.quota.spentToday} today`);
  }
  if (result.cassette && (result.cassette.recorded || result.cassette.hits)) {
    say(`cassette: ${result.cassette.recorded} recorded, ${result.cassette.hits} replayed, ${result.cassette.misses} missed`);
  }
  say(result.summaryLine);
  return result.exitCode;
};

/** The recommended home for a real key: outside every repo. */
function readConfigKey() {
  const candidates = [
    path.join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".open-historia-harness.json"),
    path.join(HARNESS_ROOT, "harness.config.json"),
  ];
  for (const file of candidates) {
    try {
      const config = JSON.parse(fs.readFileSync(file, "utf8"));
      const key = config?.gemini?.apiKey || config?.apiKey;
      if (key) return key;
    } catch {
      // Missing or unreadable config is the normal case.
    }
  }
  return null;
}

main()
  .then((code) => {
    process.exitCode = code ?? EXIT.ok;
  })
  .catch((error) => {
    console.error(`[harness] ${error.message}`);
    process.exitCode = EXIT.error;
  });
