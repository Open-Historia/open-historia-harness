// --check-exports: does every Game export in game-exports/ still open?
//
// For after a game update: each zip is opened, imported, import-checked and run
// through the world checks — no turns played. The game server can start only
// once per process, so each zip gets its own child process, and reports back on
// one machine-readable line.
//
// Hub scenarios are never downloaded here. A quick check that has to fetch
// hundreds of MB before saying "opens fine" would not be a quick check.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { listGameExports } from "./gameExport.js";
import { checkAll } from "./invariants.js";
import { hideHomeDir } from "./redact.js";
import { createSession } from "./session.js";

const RESULT_PREFIX = "CHECK-EXPORT ";

/** The child's half: open one zip, check it, and print the result line. */
export const checkOneExport = async ({ file, repo, branch = null, sandboxRoot }) => {
  let session = null;
  let result;
  try {
    session = await createSession({
      repo,
      branch,
      sandboxRoot,
      saveZip: file,
      hub: false,
      hubSkippedBecause: "--check-exports never downloads",
      quiet: true,
      onProgress: () => {},
    });
    const state = await session.modules.gameState.readGameStateBundle({ force: true });
    const save = session.save;
    // Counted as the hunt's report counts them, once per distinct problem, so the
    // two never disagree about the same Save.
    const distinct = new Set(
      checkAll(state, { context: "the Save as it was opened" }).map((finding) => `${finding.id}::${finding.summary}`),
    );
    result = {
      opened: true,
      importFindings: save.importCheck.mismatches.map((mismatch) => mismatch.summary),
      rollbackPoints: save.rollbackPoints,
      map: save.map.kind,
      preExisting: distinct.size,
    };
  } catch (error) {
    result = { opened: false, error: error.message, compat: Boolean(error.harnessCompat) };
  } finally {
    await session?.dispose().catch(() => {});
  }
  console.log(`${RESULT_PREFIX}${JSON.stringify(result)}`);
  return result;
};

const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

// A child that has not answered by now is wedged, not slow: opening one zip is
// seconds, and hub downloads are skipped here.
const CHILD_TIMEOUT_MS = 5 * 60 * 1000;

const describeResult = (result) => {
  if (!result.opened) return `DOES NOT OPEN — ${hideHomeDir(result.error)}`;
  const imported = result.importFindings.length
    ? plural(result.importFindings.length, "IMPORT FINDING")
    : "import ok";
  const points = result.rollbackPoints ? plural(result.rollbackPoints, "Roll-back point") : "no Roll-back points";
  return `opens · ${imported} · ${points} · scenario: ${result.map} · ${plural(result.preExisting, "finding")} already in the Save`;
};

/** The index, rewritten in full after every zip, so a check killed halfway still has a valid one. */
const writeIndex = (index, rows, total) =>
  fs.writeFileSync(
    index,
    [
      "# Game exports check",
      "",
      `${new Date().toISOString()}. ${rows.length} of ${total} checked, each opened, imported and checked on its own; no turns played.`,
      "",
      "| Export | Result |",
      "|---|---|",
      ...rows.map(({ name, result }) => `| ${name} | ${describeResult(result).replace(/\|/g, "\\|")} |`),
      "",
    ].join("\n"),
  );

/**
 * The parent's half: one child per zip, a line each, an index file, an exit code.
 *
 * A zip that does not open is exit 1, not 2: the check ran fine and its answer is
 * "this export is broken", which is a failed assertion about the export. Opening
 * that same zip with --save-zip is a 2, because there the harness could not do
 * what was asked of it.
 */
export const checkExports = ({ dir, cliPath, runsDir, repo = null, branch = null, say = console.log }) => {
  const names = listGameExports(dir);
  if (!names.length) {
    say(`No Game exports in ${hideHomeDir(dir)}. Put a player's zip there, or run export-round-trip to make one.`);
    return 0;
  }

  const index = path.join(runsDir, "EXPORTS-CHECK.md");
  fs.mkdirSync(runsDir, { recursive: true });
  const width = Math.max(...names.map((name) => name.length));
  const rows = [];
  for (const name of names) {
    const file = path.join(dir, ...`${name}.zip`.split("/"));
    const child = spawnSync(
      process.execPath,
      [cliPath, "--check-export", file, ...(repo ? ["--repo", repo] : []), ...(branch ? ["--branch", branch] : [])],
      { encoding: "utf8", timeout: CHILD_TIMEOUT_MS },
    );
    const line = (child.stdout ?? "").split(/\r?\n/).find((entry) => entry.startsWith(RESULT_PREFIX));
    const died = child.error?.code === "ETIMEDOUT" ? `no answer within ${CHILD_TIMEOUT_MS / 60000} minutes` : null;
    const result = line
      ? JSON.parse(line.slice(RESULT_PREFIX.length))
      : { opened: false, error: died ?? (child.stderr || child.stdout || "the check process died").trim().split(/\r?\n/).pop() };
    rows.push({ name, result });
    writeIndex(index, rows, names.length);
    say(`  ${name.padEnd(width)}  ${describeResult(result)}`);
    for (const finding of result.importFindings ?? []) say(`  ${"".padEnd(width)}    Import finding: ${finding}`);
  }

  say("");
  say(`Checked ${plural(names.length, "Game export")} in ${hideHomeDir(dir)}. Turns played: 0.`);
  say(`Index: ${index}`);

  if (rows.some(({ result }) => result.compat)) return 5;
  return rows.some(({ result }) => !result.opened || result.importFindings.length) ? 1 : 0;
};
