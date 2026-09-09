export const meta = {
  name: "ai-quality",
  description:
    "Plays several turns and audits each generation for the objective faults the game's prompt directives exist to fight.",
  requires: { ai: true },
  aiCallBudget: 15,
};

export default async ({ game, world, expect, log }) => {
  const RUNS = Number(process.env.OH_HARNESS_RUNS ?? 3);
  const { auditTurn, summariseConsistency } = await import("../lib/aiQuality.js");

  const audits = [];

  for (let index = 0; index < RUNS; index += 1) {
    const outcome = log.turn(await game.turn(30));
    if (!outcome.ok) {
      expect.that(false, `turn ${index + 1} threw`, { error: outcome.error?.message });
      break;
    }

    // A fallback is not a quality datapoint — the model never answered — so it is
    // reported and skipped rather than scored as a bad generation.
    if (outcome.fallback) {
      expect.that(false, `turn ${index + 1} fell back instead of generating`, {
        reason: outcome.fallback,
      });
      continue;
    }

    // A 30-day jump asks for 5-7 events (gameplay.js eventCountRangeForDays).
    const audit = auditTurn({
      diff: outcome.diff,
      before: outcome.before,
      after: outcome.after,
      minEvents: 5,
      maxEvents: 7,
    });
    audits.push(audit);

    for (const fault of audit.faults) {
      log.warn(`turn ${index + 1}: ${fault.kind}${fault.note ? ` — ${fault.note}` : ""}`);
    }

    // Every claim the model made about the map must have landed.
    expect.noUnappliedTransfers(outcome.diff, `turn ${index + 1}: every claimed transfer should apply`);
    expect.mapTruthAtLeast(outcome.diff, 0.9, `turn ${index + 1}: map truth should be at least 0.9`);
  }

  if (audits.length) {
    const summary = summariseConsistency(audits);
    log.info(
      `audited ${summary.runs} generations: ${summary.clean} clean, ` +
        `event counts ${summary.eventCounts.join(",")} (median ${summary.medianEvents})`,
    );
    for (const [kind, count] of Object.entries(summary.faultsByKind)) {
      log.warn(`${kind}: ${count} of ${summary.runs} generations`);
    }

    // A distribution, not a verdict on one sample: the model varies, and a single
    // generation would flatter or condemn it at random.
    expect.that(
      summary.clean >= Math.ceil(summary.runs / 2),
      "at least half the generations should be free of objective faults",
      summary,
    );
  }
};
