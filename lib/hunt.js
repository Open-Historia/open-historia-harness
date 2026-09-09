// The bug hunt.
//
// Plays the game at a chosen aggression level, checks the invariants after every
// single action, and writes findings to the bug report as they happen.
//
// Two rules shape this:
//
//   - An action THROWING is not automatically a bug. Level 4 deliberately feeds
//     the engine nonsense, and rejecting nonsense is correct behaviour. What is
//     always a bug is the engine ending up in an impossible STATE, or throwing
//     something that is clearly an internal error rather than a validation
//     message.
//   - Everything is checked after everything. A corrupt world is worth finding
//     whichever action produced it, so the invariants run after each step rather
//     than once at the end.

import { checkAll } from "./invariants.js";
import { LEVELS, generateInput, isFailing, makeRng, nextAction } from "./levels.js";

/** Errors that are the engine working, not failing. */
const isValidationError = (error) => {
  const message = String(error?.message ?? "");
  return (
    /choose a time-skip|greater than zero|supported date range|no region matched|cannot tell|campaignSwitched/i.test(
      message,
    ) || error?.harnessNoAi === true
  );
};

/** Errors that always mean a real defect, whatever we fed in. */
const isInternalError = (error) => {
  const message = String(error?.message ?? "");
  return /is not a function|cannot read propert|undefined is not|of undefined|of null|Maximum call stack|Converting circular/i.test(
    message,
  );
};

export const runHunt = async ({
  driver,
  report,
  level = 1,
  seed = 1,
  turns = null,
  log,
  onStep = null,
}) => {
  const spec = LEVELS[level] ?? LEVELS[1];
  const rng = makeRng(seed);
  const { game, world, units, inspect } = driver;

  const budget = turns ?? spec.turns;
  let previous = await world.read();

  // Baseline. A save that is ALREADY invalid is a genuinely useful finding, but it
  // is not something the run did — and conflating the two would send someone
  // hunting for a bug in code that never touched it. Everything found here is
  // marked pre-existing, and anything matching it later is attributed the same way.
  const preExisting = new Set();
  for (const finding of checkAll(previous, { context: "starting state" })) {
    preExisting.add(`${finding.id}::${finding.summary}`);
    report.add({ ...finding, preExisting: true }, { step: "the save as it was opened" });
    if (finding.severity === "critical" || finding.severity === "high") {
      log.warn(`pre-existing in this save: ${finding.summary}`);
    }
  }

  await units.sync();

  const attempt = async (description, run, { allowRewind = false } = {}) => {
    report.step(description);
    onStep?.(description);

    let outcome = null;
    let threw = null;
    try {
      outcome = await run();
      if (outcome?.error) threw = outcome.error;
    } catch (error) {
      threw = error;
    }

    if (threw) {
      if (isInternalError(threw)) {
        // A TypeError from inside the engine is a defect regardless of what we
        // fed it: bad input should be rejected, not crash.
        report.crash(threw, { step: description, context: "internal error, not a validation message" });
        log.warn(`CRASH during ${description}: ${threw.message}`);
      } else if (!isValidationError(threw)) {
        report.add(
          {
            id: "unexpected-error",
            severity: "medium",
            summary: `Unexpected error: ${String(threw.message).slice(0, 120)}`,
            detail: { message: threw.message, why: "not recognisably a validation message" },
            context: description,
          },
          { step: description },
        );
      }
    }

    // The state check runs whether or not the action threw — a half-applied write
    // is exactly the kind of damage worth catching.
    const current = await world.read();
    const findings = checkAll(current, { previous, context: description, allowRewind });
    for (const finding of findings) {
      const wasThereAllAlong = preExisting.has(`${finding.id}::${finding.summary}`);
      report.add({ ...finding, preExisting: wasThereAllAlong }, { step: description });
      // Only shout about things this run actually caused.
      if (!wasThereAllAlong && isFailing(finding.severity, level)) {
        log.warn(`${finding.severity}: ${finding.summary}`);
      }
    }

    previous = current;
    return outcome;
  };

  for (let index = 0; index < budget; index += 1) {
    const action = nextAction(rng, level);

    switch (action) {
      case "plainTurn": {
        const days = generateInput(rng, level, "days");
        const outcome = await attempt(`turn(${days})`, () => game.turn(days));
        if (outcome) {
          report.count("turns");
          report.count("aiCalls", outcome.providerCalls ?? 0);
          if (outcome.fallback) report.count("fallbacks");
          if (outcome.diff) checkGeneration(outcome, report, level, log);
        }
        break;
      }

      case "plannedAction": {
        const text = generateInput(rng, level, "actionText");
        await attempt(`plan(${JSON.stringify(String(text).slice(0, 40))})`, () => game.plan(text));
        report.count("actions");
        break;
      }

      case "deployUnit": {
        const { lng, lat } = generateInput(rng, level, "coords");
        const strength = generateInput(rng, level, "strength");
        const name = generateInput(rng, level, "unitName");
        await attempt(`deploy(${lng.toFixed?.(2) ?? lng}, ${lat.toFixed?.(2) ?? lat}, str ${strength})`, () =>
          units.deploy({ type: "infantry", strength, name, lng, lat }),
        );
        report.count("actions");
        break;
      }

      case "gmCommand": {
        const text = generateInput(rng, level, "gmText");
        const outcome = await attempt(`gm(${JSON.stringify(String(text).slice(0, 40))})`, () => game.gm(text));
        report.count("actions");
        if (outcome) report.count("aiCalls", outcome.providerCalls ?? 0);
        break;
      }

      case "extremeJump": {
        const days = generateInput(rng, level, "days");
        await attempt(`extreme turn(${days})`, () => game.turn(days));
        report.count("actions");
        break;
      }

      case "nastyInput": {
        // Aim the worst strings at the world-write path, where a bad owner name
        // becomes permanent state rather than a rejected message.
        const text = generateInput(rng, level, "actionText");
        const snapshot = await world.snapshot();
        const regionId = Object.keys(snapshot.ownership)[Math.floor(rng() * snapshot.counts.regions)];
        if (regionId) {
          await attempt(`setOwner(${regionId}, ${JSON.stringify(String(text).slice(0, 30))})`, () =>
            world.setOwner(regionId, String(text)),
          );
        }
        report.count("actions");
        break;
      }

      case "rollback": {
        const snapshots = await game.snapshots();
        if (Array.isArray(snapshots) && snapshots.length) {
          // Level 4+ also tries indices that do not exist.
          const target =
            level >= 4 && rng() < 0.4
              ? Math.floor(rng() * 20) - 5
              : Math.floor(rng() * snapshots.length);
          await attempt(`rollback(${target})`, () => game.rollback(target), { allowRewind: true });
        }
        report.count("actions");
        break;
      }

      case "rapidFire": {
        // Concurrent writes to the same world. The engine serialises turns with
        // beginSimulation, so this is testing that guard rather than expecting
        // both to succeed.
        await attempt("two turns at once", async () => {
          const results = await Promise.allSettled([game.turn(30), game.turn(30)]);
          const rejected = results.filter((r) => r.status === "rejected");
          return { error: rejected.length === results.length ? rejected[0].reason : null };
        });
        report.count("actions");
        break;
      }

      default:
        break;
    }
  }

  // Final sweep, including things only worth checking once.
  const finalState = await world.read();
  const snapshot = await world.snapshot();
  for (const finding of checkAll(finalState, { context: "final state" })) {
    report.add(
      { ...finding, preExisting: preExisting.has(`${finding.id}::${finding.summary}`) },
      { step: "end of run" },
    );
  }

  // The server must still be answering. A hung or dead server after a fuzz run is
  // itself the bug.
  try {
    const response = await fetch(`${driver.session.baseUrl}/api/library`);
    if (!response.ok) {
      report.add({
        id: "server-unhealthy",
        severity: "critical",
        summary: `The server returned ${response.status} after the run`,
        detail: { status: response.status },
        context: "final health check",
      });
    }
  } catch (error) {
    report.add({
      id: "server-dead",
      severity: "critical",
      summary: "The server stopped responding during the run",
      detail: { message: error.message },
      context: "final health check",
    });
  }

  return { snapshot, findings: report.findings };
};

/**
 * Tell an engine defect from a badly-written turn.
 *
 * "The map did not move" means the engine was told to do something and did not —
 * a real bug. "Already owned" means the model narrated capturing territory its
 * subject already held: immersion-breaking, worth knowing, but nothing in the
 * code is broken. Reporting both as HIGH would bury the one that matters.
 */
const gradeUnappliedTransfer = (miss) => {
  const reason = String(miss.why ?? "");

  if (/already owned/i.test(reason)) {
    return {
      id: "redundant-transfer-claimed",
      severity: "low",
      summary: "An event narrated capturing territory its owner already held",
      why: "not an engine fault — the model wrote a turn that reads oddly to a player who knows the map",
    };
  }
  if (/no region with that id|no region matched/i.test(reason)) {
    return {
      id: "transfer-names-unknown-region",
      severity: "medium",
      summary: "An event claimed a transfer for a region that does not exist",
      why: "the model invented a place; the engine correctly refused it, but the story now describes something that never happened",
    };
  }
  return {
    id: "claimed-transfer-not-applied",
    severity: "high",
    summary: "An event claimed territory changed hands but the map did not move",
    why: "the story and the map disagree, which is the failure [Map Truth] exists to prevent",
  };
};

/** Faults in what the model generated, as distinct from the state it left behind. */
const checkGeneration = (outcome, report, level, log) => {
  const unapplied = outcome.diff?.reconciliation?.transfers?.unapplied ?? [];
  for (const miss of unapplied.slice(0, 3)) {
    // These are three different problems wearing one name, and grading them alike
    // overstates two of them. Only the first is the engine failing to do its job;
    // the others are the model writing a poor turn, which matters but is not a
    // defect in the code.
    const graded = gradeUnappliedTransfer(miss);
    report.add(
      {
        id: graded.id,
        severity: graded.severity,
        summary: graded.summary,
        detail: {
          event: miss.eventTitle,
          region: miss.regionId,
          to: miss.to,
          reason: miss.why,
          why: graded.why,
        },
        context: outcome.task,
      },
      { step: outcome.task },
    );
  }

  for (const shortfall of outcome.diff?.reconciliation?.unitOps?.shortfalls ?? []) {
    report.add(
      {
        id: "claimed-units-not-placed",
        severity: "high",
        summary: `${shortfall.claimed} unit ${shortfall.kind} ops narrated, ${shortfall.applied} applied`,
        detail: { ...shortfall, why: "troops described in the story never appeared on the map" },
        context: outcome.task,
      },
      { step: outcome.task },
    );
  }
};
