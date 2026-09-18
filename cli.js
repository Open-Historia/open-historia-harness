#!/usr/bin/env node
// oh-harness — play Open Historia headlessly and report what changed.
//
// Optimised for one thing: I type one command and get back readable structured
// text. Everything else is in service of that.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { listRuns, recoverStaleRuns } from "./lib/lifecycle.js";
import { buildReport, writeReport } from "./lib/report.js";
import { HARNESS_ROOT, RUNS_DIR, listScenarios, runScenarios } from "./lib/runner.js";
import { DEFAULT_SANDBOX_ROOT } from "./lib/session.js";
import { pruneSandboxes } from "./lib/sandbox.js";
import { configureSafety, isInside, resetSafety } from "./lib/safety.js";
import { DEFAULT_GAME_REPO, findGameRepo } from "./lib/target.js";
import { pruneWorktrees } from "./lib/worktree.js";
import { detectBlockers } from "./lib/compat.js";
import { compareBranches, renderComparison } from "./lib/compare.js";
import { checkExports, checkOneExport } from "./lib/checkExports.js";
import { pruneHubCache } from "./lib/hubScenario.js";
import { exportsDir, inspectZipFile, listGameExports, resolveSaveZip } from "./lib/gameExport.js";
import { hideHomeDir } from "./lib/redact.js";
import { runBugHunt, listRealSaves, resolveSaves } from "./lib/huntRunner.js";
import { LEVELS } from "./lib/levels.js";

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
  oh-harness --status                    every run, its state, and its report
  oh-harness --doctor                    recover interrupted runs, audit, clean up
  oh-harness --prune                     drop stale sandboxes and worktrees
  oh-harness --hunt --level 1..5         hunt for bugs; writes a bug report as it goes
  oh-harness --levels                    what each level does, and which saves exist
  oh-harness --verify-compat             report which import blockers a target has
  oh-harness <scenario> --compare a,b    run the same scenario against two branches
  oh-harness --check-exports             open every Game export in game-exports/, no turns played

Target
  --repo <path>        game repo (default: ../open-historia)
  --branch <ref>       test a branch in a throwaway worktree (e.g. upstream/main)
  --fresh-worktree     rebuild the worktree instead of reusing it

Bug hunt
  --hunt               play the game looking for bugs, writing BUG-REPORT.md as it goes
  --level 1..5         1 plays like a normal player, 5 actively tries to break things
  --saves fresh|all|saves|<id,...>   which save(s) to hunt in (default fresh)

Game exports (a player's exported .zip; hunts and scenario runs)
  --save-zip <path|name>   open a Game export: a path, or its name in game-exports/
  --no-embedded-scenario   play on the Stand-in scenario even when the zip carries its map
  --no-hub                 do not download a Hub scenario the zip points to
  --turns <n>          override the level's turn count
  --seed <n>           reproduce an earlier hunt exactly

Run
  --ai off|live        provider calls (default: off, uses the deterministic fallback)
  --key <k>            API key (prefer OH_HARNESS_GEMINI_KEY or the config file)
  --provider <name>    gemini | nvidia | openrouter | groq | ollama | openai |
                       anthropic | openai-compatible. The first four are harness
                       names for an OpenAI-compatible gateway plus its address;
                       each reads its own block in the config file, so several
                       keys live side by side and --provider picks one.
  --endpoint <url>     override the address for an OpenAI/Anthropic-compatible
                       provider (a self-hosted gateway, a preview host)
  --model <name>
  --record [name]      record real model responses to cassettes/<name>
  --replay [name]      replay them: no network, no quota, deterministic
  --replay-mode strict|auto   strict fails on a miss (a changed prompt), auto falls through
  --max-ai-calls <n>   ceiling for this run
  --max-ai-calls-per-day <n>  ceiling shared across runs, survives restarts
  --min-gap-ms <n>     seconds between provider calls, in ms (default 6500). Raise it
                       for a large save: big prompts hit a tokens-per-minute limit
                       long before they hit a requests-per-minute one.
  --max-retries <n>    429/5xx retries before the run is called rate-limited (default 3)
  --geometry stock|full
  --fixture <gameId>   seed from a real save in the main checkout
  --fixture-source <path>   read that save from ANOTHER root (a copy of a player's
                       data dir), instead of the game repo. The save is copied into
                       the sandbox and the source is never written to.
  --force              run AI-only scenarios against the fallback
  --keep               keep the sandbox and worktree for inspection
  --max-runtime <min>  absolute ceiling (default 30)
  --idle-timeout <min> give up if no step completes (default 5)
  --self-test          run every offline scenario
  --quiet
`;

const say = (text) => console.log(text);

/**
 * --save-zip, checked before anything boots: one Game export, found by path or
 * by short name in game-exports/, and actually a zip. A problem with the file is
 * reported as a sentence naming it, never as a stack trace.
 */
const prepareSaveZip = (options) => {
  if (options.saveZip === undefined) return { file: null };
  if (options.saves !== undefined || options.fixture !== undefined) {
    say("--save-zip opens one Game export on its own; it cannot be combined with --saves or --fixture.");
    return { exit: EXIT.error };
  }
  try {
    const file = resolveSaveZip(options.saveZip === true ? "" : options.saveZip);
    inspectZipFile(file);
    return { file };
  } catch (error) {
    if (!error.harnessExport) throw error;
    say(error.message);
    return { exit: EXIT.error };
  }
};

/**
 * How a reproduce command names the zip: by short name when it is in
 * game-exports/, otherwise by path with the home folder hidden — a report is
 * often pasted into a public issue.
 */
const saveZipArg = (file) => {
  if (isInside(file, exportsDir())) {
    return path.relative(exportsDir(), file).replace(/\.zip$/i, "").split(path.sep).join("/");
  }
  const shown = hideHomeDir(file);
  return /\s/.test(shown) ? `"${shown}"` : shown;
};

const sayNoKey = (name = "gemini") => {
  say(`No API key found for "${name}". Set one of:`);
  for (const variable of KEY_ENV[name] ?? [`OH_HARNESS_${name.toUpperCase()}_KEY`]) {
    say(`  ${variable}=<key>                  (environment)`);
  }
  say(`  ${path.join(process.env.USERPROFILE ?? "~", ".open-historia-harness.json")}`);
  say(`      {"provider":"${name}","${name}":{"apiKey":"...","model":"..."}}`);
  say("");
  say("Providers the harness knows by name, and what they mean to the engine:");
  for (const [alias, spec] of Object.entries(PROVIDER_ALIASES)) {
    say(`  ${alias.padEnd(12)} ${spec.provider} at ${spec.endpoint}`);
  }
  say("  gemini / openai / anthropic     the engine's own, no endpoint needed");
  say("");
  say("Or run without --ai to use the deterministic fallback, which costs nothing.");
};

const cmdLevels = () => {
  const gameRepo = findGameRepo();
  for (const [level, spec] of Object.entries(LEVELS)) {
    say(`  ${level}  ${spec.name.padEnd(14)} ${spec.description}`);
  }
  say("");
  say("Saves available to hunt in:");
  say("  fresh                     a clean scenario (default)");
  for (const save of listRealSaves(gameRepo)) say(`  ${save}`);
  say("  all                       fresh plus every save above");
  say("");
  const exports = listGameExports();
  say(`Game exports to open with --save-zip <name> (in ${hideHomeDir(exportsDir())}):`);
  if (!exports.length) say("  (none yet: put a player's zip there, or run export-round-trip)");
  for (const name of exports) say(`  ${name}`);
  return EXIT.ok;
};

/** One file listing every save hunted in this invocation and where its report is. */
const writeHuntIndex = ({ reports, runsDir, level, seed }) => {
  const file = path.join(runsDir, `HUNT-INDEX-L${level}.md`);
  const lines = [
    `# Bug hunt index — level ${level}`,
    "",
    `Seed ${seed}. ${reports.length} saves hunted. Each has its own BUG-REPORT.md.`,
    "",
    "| Save | Result | Report |",
    "|---|---|---|",
  ];
  for (const entry of reports) {
    const label = entry.save ?? "fresh scenario";
    const total = entry.fromChild ? entry.total : entry.findings.length;
    const critical = entry.fromChild ? entry.critical : entry.findings.filter((f) => f.severity === "critical").length;
    const high = entry.fromChild ? entry.high : entry.findings.filter((f) => f.severity === "high").length;
    const report = entry.reportFile
      ? (entry.fromChild ? entry.reportFile : path.relative(runsDir, entry.reportFile))
      : "see runs/";
    lines.push(`| ${label} | ${total} findings (${critical} critical, ${high} high) | ${report} |`);
  }
  lines.push("");
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
};

const cmdList = () => {
  const scenarios = listScenarios();
  say(scenarios.length ? scenarios.map((name) => `  ${name}`).join("\n") : "  (no scenarios yet)");
  say("");
  say("Any of them can run on a player's Game export: --save-zip <path, or name in game-exports/>.");
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
  const hubMaps = pruneHubCache({ keepDays: 14 });
  resetSafety();

  say(`removed ${worktrees.length} worktree(s), ${sandboxes.length} stale sandbox(es), ${hubMaps.length} cached Hub scenario(s)`);
  return EXIT.ok;
};

const cmdPrune = (options) => {
  const gameRepo = findGameRepo(options.repo);
  configureSafety({ sandbox: DEFAULT_SANDBOX_ROOT, protect: [gameRepo, DEFAULT_GAME_REPO] });
  const worktrees = pruneWorktrees({ gameRepo, sandboxRoot: DEFAULT_SANDBOX_ROOT });
  const sandboxes = pruneSandboxes({ keepDays: Number(options.keepDays ?? 14) });
  const hubMaps = pruneHubCache({ keepDays: Number(options.keepDays ?? 14) });
  resetSafety();
  say(`removed ${worktrees.length} worktree(s), ${sandboxes.length} sandbox(es), ${hubMaps.length} cached Hub scenario(s)`);
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
  if (options.levels) return cmdLevels();
  if (options.status) return cmdStatus();
  if (options.doctor) return cmdDoctor();
  if (options.prune) return cmdPrune(options);
  if (options.verifyCompat) return cmdVerifyCompat(options);
  if (options.checkExports) {
    return checkExports({
      dir: exportsDir(),
      cliPath: path.join(HARNESS_ROOT, "cli.js"),
      runsDir: RUNS_DIR,
      repo: options.repo ?? null,
      branch: options.branch ?? null,
    });
  }
  // Internal: one --check-exports child, for one zip.
  if (options.checkExport) {
    await checkOneExport({
      file: String(options.checkExport),
      repo: options.repo,
      branch: options.branch ?? null,
      sandboxRoot: DEFAULT_SANDBOX_ROOT,
    });
    return EXIT.ok;
  }
  if (options.resume) return cmdResume(String(options.resume));

  if (options.hunt || options.level !== undefined) {
    const level = Math.max(1, Math.min(5, Number(options.level ?? 1)));
    const gameRepo = findGameRepo(options.repo);
    const saveZip = prepareSaveZip(options);
    if (saveZip.exit !== undefined) return saveZip.exit;
    // A Game export is one Save, hunted in this process.
    const saveList = saveZip.file ? [null] : resolveSaves(options.saves ?? "fresh", gameRepo);
    const seed = Number(options.seed ?? Date.now() % 100000);

    const who = resolveProvider(options);
    const apiKey = who.apiKey;
    const ai = options.ai === "live" || options.ai === true ? "live" : "off";
    if (ai === "live" && !apiKey) {
      sayNoKey(who.name);
      return EXIT.error;
    }

    // One save per process: server.js starts on import and is cached, so a second
    // save in the same process would find a closed listener. The loop re-invokes
    // this CLI rather than pretending otherwise.
    const reports = [];
    for (const [index, save] of saveList.entries()) {
      if (index > 0) {
        const child = spawnSync(
          process.execPath,
          [
            process.argv[1],
            "--hunt",
            "--level", String(level),
            "--saves", save ?? "fresh",
            "--seed", String(seed + index),
            ...(ai === "live" ? ["--ai", "live"] : []),
            ...(options.turns ? ["--turns", String(options.turns)] : []),
            ...(options.repo ? ["--repo", String(options.repo)] : []),
          ],
          { encoding: "utf8" },
        );
        // Capture rather than inherit, so the parent can read the child's own
        // summary line. Reporting only the exit code made a save with 32 findings
        // print as "no blocking findings", because nothing critical had failed —
        // technically true and thoroughly misleading.
        if (child.stdout) process.stdout.write(child.stdout);
        if (child.stderr) process.stderr.write(child.stderr);

        const line = /HUNT .*$/m.exec(child.stdout ?? "")?.[0] ?? "";
        // `\\d`, not `\d`: inside a template literal `\d` is not an escape
        // sequence and collapses to a bare "d", so the pattern silently became
        // `findings=(d+)` and matched nothing — every child reported zero.
        const num = (key) => Number(new RegExp(`${key}=(\\d+)`).exec(line)?.[1] ?? 0);
        reports.push({
          save,
          exitCode: child.status ?? 0,
          fromChild: true,
          total: num("findings"),
          critical: num("critical"),
          high: num("high"),
          crashes: num("crashes"),
          reportFile: /report=(\S+)/.exec(line)?.[1] ?? null,
        });
        continue;
      }

      const result = await runBugHunt({
        level,
        seed: seed + index,
        saves: save ?? "fresh",
        saveZip: saveZip.file,
        importScenario: !options.noEmbeddedScenario,
        hub: !options.noHub,
        turns: options.turns ? Number(options.turns) : null,
        ai,
        provider: who.provider,
        model: who.model,
        endpoint: who.endpoint,
        apiKey: apiKey ?? "",
        repo: options.repo,
        branch: options.branch ?? null,
        sandboxRoot: DEFAULT_SANDBOX_ROOT,
        runsDir: RUNS_DIR,
        harnessRoot: HARNESS_ROOT,
        maxAiCalls: Number(options.maxAiCalls ?? 0),
        cassetteMode: options.record ? "record" : "off",
        command:
          `node cli.js --hunt --level ${level} ` +
          (saveZip.file ? `--save-zip ${saveZipArg(saveZip.file)}` : `--saves ${save ?? "fresh"}`) +
          ` --seed ${seed + index}` +
          (options.turns ? ` --turns ${options.turns}` : "") +
          (ai === "live" ? " --ai live" : "") +
          (options.branch ? ` --branch ${options.branch}` : "") +
          (options.noEmbeddedScenario ? " --no-embedded-scenario" : "") +
          (options.noHub ? " --no-hub" : ""),
        quiet: Boolean(options.quiet),
      });
      reports.push(result);
      say("");
      say(result.summary);
      say("");
      say(`Bug report: ${result.reportFile}`);
    }

    if (reports.length > 1) {
      const index = writeHuntIndex({ reports, runsDir: RUNS_DIR, level, seed });
      say("");
      say("=".repeat(60));
      say(`Hunted ${reports.length} saves at level ${level}.`);
      for (const entry of reports) {
        const label = entry.save ?? "fresh";
        const total = entry.fromChild ? entry.total : entry.findings.length;
        const critical = entry.fromChild ? entry.critical : entry.findings.filter((f) => f.severity === "critical").length;
        const high = entry.fromChild ? entry.high : entry.findings.filter((f) => f.severity === "high").length;
        const crashes = entry.fromChild ? entry.crashes : entry.crashes?.length ?? 0;
        say(
          `  ${label.padEnd(38)} ${String(total).padStart(3)} findings` +
            `  (${critical} critical, ${high} high${crashes ? `, ${crashes} CRASHES` : ""})`,
        );
      }
      say("");
      say(`Combined index: ${index}`);
      say("Each save has its own BUG-REPORT.md; the index lists them all.");
    }

    const worst = reports.find((r) => r.exitCode === 1);
    return worst ? EXIT.assertion : EXIT.ok;
  }

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

  const who = resolveProvider(options);
  const pacing = resolvePacing(options);

  // Replay needs provider calls routed to the hook even with no key, since a
  // cassette answers without the network.
  const ai = options.replay ? "replay" : options.ai === "live" || options.ai === true ? "live" : "off";

  if (ai === "live" && !who.apiKey) {
    sayNoKey(who.name);
    return EXIT.error;
  }
  if (ai === "live") {
    say(`provider: ${who.name}${who.name === who.provider ? "" : ` (${who.provider})`}` +
      `${who.model ? ` · ${who.model}` : ""}${who.endpoint ? ` · ${who.endpoint}` : ""}`);
  }

  const saveZip = prepareSaveZip(options);
  if (saveZip.exit !== undefined) return saveZip.exit;

  const result = await runScenarios(names, {
    ai,
    cassetteMode: options.record ? "record" : options.replay ? "replay" : "off",
    cassetteName: (typeof options.record === "string" && options.record) ||
      (typeof options.replay === "string" && options.replay) ||
      "default",
    replayMode: options.replayMode ?? "auto",
    maxAiCalls: Number(options.maxAiCalls ?? 0),
    maxAiCallsPerDay: Number(options.maxAiCallsPerDay ?? 0),
    minGapMs: pacing.minGapMs,
    maxRetries: pacing.maxRetries,
    repo: options.repo,
    branch: options.branch ?? null,
    fresh: Boolean(options.freshWorktree),
    geometry: options.geometry ?? "stock",
    fixture: options.fixture ?? null,
    fixtureSource: options.fixtureSource ?? null,
    saveZip: saveZip.file,
    importScenario: !options.noEmbeddedScenario,
    hub: !options.noHub,
    provider: who.provider,
    model: who.model,
    endpoint: who.endpoint,
    customParams: who.customParams,
    apiKey: who.apiKey ?? "",
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

/** The recommended home for real keys: outside every repo. */
function readConfig() {
  const candidates = [
    path.join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".open-historia-harness.json"),
    path.join(HARNESS_ROOT, "harness.config.json"),
  ];
  for (const file of candidates) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      // Missing or unreadable config is the normal case.
    }
  }
  return {};
}

/**
 * Harness-level provider names.
 *
 * The GAME knows five providers; several services are the same one of those
 * with a different address in front of it. NVIDIA's model API speaks
 * /chat/completions, so to the engine it is "openai-compatible" pointed at
 * NVIDIA's host — but nobody wants to type that, or to remember the URL, every
 * time they pick a model. An alias here is a name plus the endpoint that makes
 * it true; anything else is passed through to the engine unchanged.
 */
const PROVIDER_ALIASES = {
  nvidia: { provider: "openai-compatible", endpoint: "https://integrate.api.nvidia.com/v1" },
  arliai: { provider: "openai-compatible", endpoint: "https://api.arliai.com/v1" },
  openrouter: { provider: "openai-compatible", endpoint: "https://openrouter.ai/api/v1" },
  groq: { provider: "openai-compatible", endpoint: "https://api.groq.com/openai/v1" },
  ollama: { provider: "openai-compatible", endpoint: "http://localhost:11434/v1" },
};

/** Environment variables that hold a key, by the name the config block uses. */
const KEY_ENV = {
  gemini: ["OH_HARNESS_GEMINI_KEY", "GEMINI_API_KEY"],
  nvidia: ["OH_HARNESS_NVIDIA_KEY", "NVIDIA_API_KEY"],
  openrouter: ["OH_HARNESS_OPENROUTER_KEY", "OPENROUTER_API_KEY"],
  groq: ["OH_HARNESS_GROQ_KEY", "GROQ_API_KEY"],
  arliai: ["OH_HARNESS_ARLIAI_KEY", "ARLIAI_API_KEY"],
  openai: ["OH_HARNESS_OPENAI_KEY", "OPENAI_API_KEY"],
  anthropic: ["OH_HARNESS_ANTHROPIC_KEY", "ANTHROPIC_API_KEY"],
};

/**
 * Who is answering this run: the name the user picked, the engine provider it
 * means, and the key, model and endpoint that go with it.
 *
 * Precedence is the usual one — a flag beats the environment, which beats the
 * config file — applied per field, so `--model` can override one block's model
 * without also having to restate its key.
 */
const resolveProvider = (options) => {
  const config = readConfig();
  const name = String(options.provider ?? config.provider ?? "gemini");
  const alias = PROVIDER_ALIASES[name] ?? null;
  const block = config[name] ?? {};

  const fromEnv = (KEY_ENV[name] ?? []).map((key) => process.env[key]).find(Boolean);
  // `config.apiKey` is the old single-key shape, kept working on purpose: a
  // config written before there was more than one provider must not stop a run.
  const apiKey = options.key ?? fromEnv ?? block.apiKey ?? (name === "gemini" ? config.apiKey : null) ?? null;

  return {
    name,
    provider: alias?.provider ?? block.provider ?? name,
    apiKey,
    model: options.model ?? block.model ?? "",
    endpoint: options.endpoint ?? block.endpoint ?? alias?.endpoint ?? "",
    // Extra body fields for the provider, straight from the config block. This
    // is where a reasoning model is told not to think: DeepSeek V4 spends five
    // sixths of its output on a chain of thought that is thrown away, and
    // `chat_template_kwargs: {thinking: false}` returns the same answer in a
    // fifth of the time.
    customParams: block.customParams ?? null,
  };
};

/** Pacing defaults from the config, so a slow provider does not need flags. */
const resolvePacing = (options) => {
  const rate = readConfig().rateLimit ?? {};
  return {
    minGapMs: Number(options.minGapMs ?? rate.minGapMs ?? 0),
    maxRetries: Number(options.maxRetries ?? rate.maxRetries ?? 0),
  };
};

main()
  .then((code) => {
    process.exitCode = code ?? EXIT.ok;
  })
  .catch((error) => {
    console.error(`[harness] ${error.message}`);
    process.exitCode = EXIT.error;
  });
