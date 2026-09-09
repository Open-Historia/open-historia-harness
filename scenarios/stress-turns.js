export const meta = {
  name: "stress-turns",
  description: "Ten consecutive turns. Pushes the engine past the 5-round history consolidation and checks nothing drifts.",
  aiCallBudget: 30,
};

export default async ({ game, world, expect, log }) => {
  const TURNS = Number(process.env.OH_HARNESS_TURNS ?? 10);
  const before = await world.snapshot();

  let lastDate = before.gameDate;
  let lastRound = before.round;
  let fallbacks = 0;

  for (let index = 0; index < TURNS; index += 1) {
    const outcome = log.turn(await game.turn(30));
    if (!outcome.ok) {
      expect.that(false, `turn ${index + 1} threw`, { error: outcome.error?.message });
      break;
    }
    if (outcome.fallback) fallbacks += 1;

    const after = await world.snapshot();

    // The clock must move forward every single turn. A stalled date is the
    // failure that makes a long game feel broken, and it only shows up over
    // several turns.
    expect.that(
      after.round === lastRound + 1,
      `turn ${index + 1}: round should advance by exactly one`,
      { from: lastRound, to: after.round },
    );
    expect.that(
      after.gameDate > lastDate,
      `turn ${index + 1}: the date should move forward`,
      { from: lastDate, to: after.gameDate },
    );

    lastRound = after.round;
    lastDate = after.gameDate;
  }

  const after = await world.snapshot();
  log.info(`played ${lastRound - before.round} turns, ${fallbacks} fell back`);

  // consolidateRecentHistory fires every 5 rounds and rewrites history
  // irreversibly. Crossing that boundary must not lose the event log wholesale.
  expect.that(
    after.counts.events >= before.counts.events,
    "history consolidation must not lose the event log",
    { before: before.counts.events, after: after.counts.events },
  );

  // Ownership should still describe a whole world, not a shredded one.
  expect.that(
    after.counts.regions >= before.counts.regions * 0.99,
    "the region map should survive a long run intact",
    { before: before.counts.regions, after: after.counts.regions },
  );
};
