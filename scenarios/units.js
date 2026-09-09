export const meta = {
  name: "units",
  description: "A deployed unit appears on the map, is owned by the player, and survives a turn.",
  aiCallBudget: 0,
};

export default async ({ game, world, units, expect, log }) => {
  const before = await world.snapshot();
  await units.sync();

  const deploy = await units.deploy({
    type: "infantry",
    strength: 100,
    name: "Harness Brigade",
    lng: 2.35,
    lat: 48.87,
  });

  expect.that(deploy.ok, "deploying a unit should not throw", { error: deploy.error?.message });
  expect.that(
    deploy.diff.units.spawned.length === 1,
    "exactly one unit should appear on the map",
    { spawned: deploy.diff.units.spawned },
  );

  const spawned = deploy.diff.units.spawned[0];
  expect.that(
    spawned?.owner === before.country,
    `the unit should belong to the player (${before.country})`,
    { owner: spawned?.owner, expected: before.country },
  );
  expect.that(
    Number.isFinite(spawned?.at?.[0]) && Number.isFinite(spawned?.at?.[1]),
    "the unit should have real coordinates, not null island",
    { at: spawned?.at },
  );

  // A deploy queues an order for the AI to confirm on the next jump, so the unit
  // must still be there afterwards — the failure mode being a unit that appears
  // and then silently vanishes when the turn resolves.
  const turn = log.turn(await game.turn(30));
  const after = await world.snapshot();

  expect.unitCount(after, before.counts.units + 1, "the unit should survive the turn");
  expect.that(
    turn.diff.units.removed.length === 0,
    "the turn should not have destroyed the newly deployed unit",
    { removed: turn.diff.units.removed },
  );
};
