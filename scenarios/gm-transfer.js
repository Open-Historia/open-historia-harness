export const meta = {
  name: "gm-transfer",
  description: "A game-master command handing a region to another polity must actually move it on the map.",
  requires: { ai: true },
  // gameMaster can retry once on validation failure, and refreshSpyIntercepts
  // may also generate during the same turn.
  aiCallBudget: 4,
};

export default async ({ game, world, inspect, expect, log }) => {
  // Pick a real region from the live catalog rather than hard-coding an id that a
  // scenario change could invalidate. Bayern, not "Bavaria" — GADM stores native
  // names.
  const candidates = inspect.searchRegions(/^Bayern$/);
  expect.that(candidates.length === 1, "Bayern should resolve to exactly one region", { candidates });
  if (candidates.length !== 1) return;

  const region = candidates[0];
  const before = await world.snapshot();
  const owner = before.ownership[region.id];
  log.info(`${region.name} (${region.id}) is currently owned by ${owner}`);

  const target = owner === "France" ? "Italy" : "France";
  const outcome = await game.gm(`Transfer ${region.name} (region id ${region.id}) to ${target}.`);
  log.turn(outcome);

  // The assertion that matters most: a GM command falling back means the model
  // never answered, and the canned fallback makes no territorial changes at all.
  expect.generatedByAi(outcome, "the GM command must not silently fall back");
  expect.that(outcome.ok, "the GM command should not throw", { error: outcome.error?.message });

  const after = await world.snapshot();
  expect.regionOwner(after, region.id, target, `${region.name} should now belong to ${target}`);
  expect.noUnappliedTransfers(outcome.diff);
  expect.aiCalls(outcome, { atMost: 2 });
};
