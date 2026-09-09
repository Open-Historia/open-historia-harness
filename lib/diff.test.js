// The diff is pure, so it is tested against fixtures rather than a live game.
// The cases that matter are the dishonest ones: an event claiming territory that
// never moved, and troops narrated but never placed. Those are the bugs the
// [Map Truth] and [Unit Coordinates] prompt directives exist to fight, and the
// point of reconciliation is to turn them from anecdote into a number.

import assert from "node:assert/strict";
import test from "node:test";

import { diffStates, haversineKm } from "./diff.js";

// Region ids are real GADM ids in the shape the game actually stores.
const NAMES = { "DEU.2_1": "Bavaria", "DEU.1_1": "Baden-Württemberg", "FRA.6_1": "Alsace" };
const nameOf = (id) => NAMES[id] ?? null;

const state = ({ round = 1, date = "2016-01-01", owners = {}, units = [], events = [], reputation = {} } = {}) => ({
  game: { round, gameDate: date, country: "France", difficulty: "standard" },
  world: {
    regionOwnershipOverrides: owners,
    units,
    internationalReputation: reputation,
    polityOverrides: {},
    countryTags: {},
  },
  events,
  actions: [],
  chats: [],
});

const event = (id, title, impacts = {}) => ({
  id,
  title,
  date: "2016-02-14",
  impacts: { regionTransfers: [], unitOps: [], markerOps: [], polityChanges: [], createdChats: [], ...impacts },
});

test("a clean transfer is reported and reconciles", () => {
  const before = state({ owners: { "DEU.2_1": "Germany" } });
  const after = state({
    round: 2,
    date: "2016-07-01",
    owners: { "DEU.2_1": "France" },
    events: [event("e1", "French offensive", { regionTransfers: [{ regionId: "DEU.2_1", fromCode: "Germany", toCode: "France" }] })],
  });

  const d = diffStates(before, after, { nameOf });

  assert.deepEqual(d.game.round, [1, 2]);
  assert.deepEqual(d.regions.transferred, [{ id: "DEU.2_1", name: "Bavaria", from: "Germany", to: "France" }]);
  assert.equal(d.regions.byPolity.France.net, 1);
  assert.equal(d.regions.byPolity.Germany.net, -1);
  assert.deepEqual(d.regions.byPair, [{ from: "Germany", to: "France", count: 1, regions: ["Bavaria"] }]);
  assert.equal(d.reconciliation.mapTruthScore, 1);
  assert.deepEqual(d.reconciliation.transfers.unapplied, []);
});

test("an event that claims a transfer the map never made is caught", () => {
  // The headline failure. The story says Alsace changed hands; ownership is
  // untouched. Without this the run looks like a success.
  const owners = { "FRA.6_1": "France" };
  const before = state({ owners });
  const after = state({
    owners,
    events: [event("e3", "Rhine offensive", { regionTransfers: [{ regionId: "FRA.6_1", fromCode: "France", toCode: "Germany" }] })],
  });

  const d = diffStates(before, after, { nameOf });

  assert.deepEqual(d.regions.transferred, [], "nothing actually moved");
  assert.equal(d.reconciliation.transfers.claimed, 1);
  assert.equal(d.reconciliation.transfers.applied, 0);
  assert.equal(d.reconciliation.mapTruthScore, 0);
  assert.match(d.reconciliation.transfers.unapplied[0].why, /the map did not move/);
  assert.equal(d.reconciliation.transfers.unapplied[0].eventTitle, "Rhine offensive");
});

test("a claim naming a region that does not exist says so", () => {
  const before = state({ owners: { "DEU.2_1": "Germany" } });
  const after = state({
    owners: { "DEU.2_1": "Germany" },
    events: [event("e4", "Invented place", { regionTransfers: [{ regionId: "ATLANTIS_1", toCode: "France" }] })],
  });

  const d = diffStates(before, after, { nameOf });
  assert.match(d.reconciliation.transfers.unapplied[0].why, /no region with that id exists/);
});

test("a claim for territory already owned is not credited", () => {
  // Restating a fait accompli should not inflate the score.
  const owners = { "DEU.2_1": "France" };
  const d = diffStates(state({ owners }), state({
    owners,
    events: [event("e5", "Saar plebiscite", { regionTransfers: [{ regionId: "DEU.2_1", toCode: "France" }] })],
  }), { nameOf });

  assert.equal(d.reconciliation.transfers.applied, 0);
  assert.match(d.reconciliation.transfers.unapplied[0].why, /already owned/);
});

test("ownership that moved with no event claiming it is flagged", () => {
  const d = diffStates(
    state({ owners: { "DEU.1_1": "Germany" } }),
    state({ owners: { "DEU.1_1": "France" } }),
    { nameOf },
  );

  assert.equal(d.reconciliation.transfers.unexplained.length, 1);
  assert.equal(d.reconciliation.transfers.unexplained[0].name, "Baden-Württemberg");
  assert.match(d.reconciliation.transfers.unexplained[0].why, /no event claiming it/);
});

test("mapTruthScore is null when nothing was claimed, not a perfect 1.0", () => {
  // "The model made no territorial claims" is not "the model was perfectly
  // accurate", and reporting 1.0 there would quietly flatter every quiet turn.
  const d = diffStates(state(), state({ round: 2 }), { nameOf });
  assert.equal(d.reconciliation.mapTruthScore, null);
});

test("units spawned, moved, lost and weakened are all described", () => {
  const before = state({
    units: [
      { id: "u1", name: "1st Panzer", owner: "Germany", type: "armor", strength: 70, lng: 8.4, lat: 49.0 },
      { id: "u2", name: "2nd Corps", owner: "Germany", type: "infantry", strength: 40, lng: 9, lat: 50 },
    ],
  });
  const after = state({
    units: [
      { id: "u1", name: "1st Panzer", owner: "Germany", type: "armor", strength: 52, lng: 7.9, lat: 48.2 },
      { id: "u3", name: "3rd Army", owner: "France", type: "infantry", strength: 80, lng: 2.35, lat: 48.87 },
    ],
  });

  const d = diffStates(before, after, { nameOf });

  assert.equal(d.units.spawned.length, 1);
  assert.equal(d.units.spawned[0].name, "3rd Army");
  assert.equal(d.units.removed.length, 1);
  assert.equal(d.units.removed[0].name, "2nd Corps");
  assert.equal(d.units.moved.length, 1);
  assert.ok(d.units.moved[0].km > 50 && d.units.moved[0].km < 150, `92 km-ish, got ${d.units.moved[0].km}`);
  assert.deepEqual(d.units.strength[0].delta, -18);
  assert.equal(d.units.byPolity.France.spawned, 1);
  assert.equal(d.units.byPolity.Germany.removed, 1);
});

test("troops narrated but never placed are caught", () => {
  // The second headline failure: three deployments in the story, nothing on the map.
  const before = state({ units: [] });
  const after = state({
    units: [],
    events: [
      event("e6", "Mobilisation", {
        unitOps: [{ op: "spawn" }, { op: "spawn" }, { op: "spawn" }],
      }),
    ],
  });

  const d = diffStates(before, after, { nameOf });

  assert.equal(d.reconciliation.unitOps.claimed.spawn, 3);
  assert.equal(d.reconciliation.unitOps.actual.spawn, 0);
  assert.equal(d.reconciliation.unitOps.score, 0);
  assert.match(d.reconciliation.unitOps.shortfalls[0].why, /3 narrated but not on the map/);
});

test("reputation and new events surface", () => {
  const d = diffStates(
    state({ reputation: { France: 55 } }),
    state({ reputation: { France: 61 }, events: [event("e7", "Accord signed")] }),
    { nameOf },
  );

  assert.deepEqual(d.polities.reputation, [{ polity: "France", from: 55, to: 61, delta: 6 }]);
  assert.equal(d.events.count, 1);
  assert.equal(d.events.added[0].title, "Accord signed");
});

test("an unchanged turn produces an empty summary", () => {
  const identical = state({ owners: { "DEU.2_1": "Germany" } });
  const d = diffStates(identical, state({ owners: { "DEU.2_1": "Germany" } }), { nameOf });

  assert.deepEqual(d.summary, []);
  assert.deepEqual(d.regions.transferred, []);
  assert.equal(d.events.count, 0);
});

test("haversineKm is roughly right", () => {
  // Paris to Karlsruhe, about 440 km.
  const km = haversineKm(2.35, 48.87, 8.4, 49.0);
  assert.ok(km > 400 && km < 480, `expected ~440 km, got ${km}`);
});
