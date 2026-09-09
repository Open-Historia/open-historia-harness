export const meta = {
  name: "smoke",
  description: "The engine boots, state reads back, and a turn advances the clock. No AI required.",
  aiCallBudget: 0,
};

export default async ({ game, world, expect, log }) => {
  const snap = await world.snapshot();
  log.snapshot(snap);

  expect.that(snap.counts.regions > 3000, "the seeded world should carry the full region map", {
    regions: snap.counts.regions,
  });
  expect.that(Boolean(snap.country), "a player country should be set", { country: snap.country });
  expect.that(snap.round >= 1, "the game should start at round 1 or later", { round: snap.round });

  const turn = log.turn(await game.turn(30));

  expect.that(turn.ok, "the turn should complete without throwing", { error: turn.error?.message });
  expect.roundAdvanced(turn.diff);
  expect.dateAdvanced(turn.diff);

  // Deliberately NOT asserting generatedByAi: this scenario is the offline
  // baseline, and it must stay green with no API key at all.
};
