// What counts as a bug, and — just as important — what does not.
//
// A bug hunter that cries wolf is worse than useless, so the false-positive cases
// here are transcribed from the real shipped data: three genuine country names
// with commas in them that the first version of this flagged as corruption.

import assert from "node:assert/strict";
import test from "node:test";

import { checkAll, checkGame, checkWorld } from "./invariants.js";
import { isFailing, LEVELS, makeRng, nextAction } from "./levels.js";

const ids = (findings) => findings.map((f) => f.id).sort();

test("real country names with commas are NOT flagged", () => {
  // Transcribed from server/data/scenarios/default/world.json. The naive
  // "contains a comma or is long" rule flagged all three of these on the very
  // first run.
  const world = {
    regionOwnershipOverrides: {
      "VIR.1_1": "Virgin Islands, U.S.",
      "BES.1_1": "Bonaire, Sint Eustatius and Saba",
      "SHN.1_1": "Saint Helena, Ascension and Tris",
      "UMI.1_1": "United States Minor Outlying Islands",
      "COD.1_1": "Democratic Republic of the Congo",
      "TTO.1_1": "Trinidad and Tobago",
    },
  };
  assert.deepEqual(checkWorld(world), [], "legitimate names must not be reported");
});

test("narrative text leaked into a polity name IS flagged", () => {
  // A real one, transcribed from a save.
  const world = {
    regionOwnershipOverrides: { "ITA.1_1": "Rome In a brief proclamation issued from London" },
  };
  const findings = checkWorld(world);
  assert.deepEqual(ids(findings), ["polity-name-is-prose"]);
  assert.match(findings[0].summary, /Rome In a brief/);
});

test("a three-letter code as an owner is flagged", () => {
  const findings = checkWorld({ regionOwnershipOverrides: { "ESP.1_1": "ESP" } });
  assert.deepEqual(ids(findings), ["owner-is-a-code"]);
  assert.match(findings[0].detail.why, /phantom country/);
});

test("regions vanishing wholesale is critical", () => {
  const previous = { regionOwnershipOverrides: Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`R${i}`, "France"])) };
  const world = { regionOwnershipOverrides: { "R0": "France" } };
  const findings = checkWorld(world, { previous });
  assert.ok(findings.some((f) => f.id === "regions-vanished" && f.severity === "critical"));
});

test("unit coordinate problems are caught", () => {
  const findings = checkWorld({
    regionOwnershipOverrides: {},
    units: [
      { id: "a", lng: 0, lat: 0, ownerCode: "France" },
      { id: "b", lng: 999, lat: 999, ownerCode: "France" },
      { id: "c", lng: Number.NaN, lat: 5, ownerCode: "France" },
      { id: "d", lng: 2, lat: 48, strength: -5, ownerCode: "France" },
    ],
  });
  const found = ids(findings);
  assert.ok(found.includes("unit-at-null-island"));
  assert.ok(found.includes("unit-off-earth"));
  assert.ok(found.includes("unit-bad-coordinates"));
  assert.ok(found.includes("unit-negative-strength"));
});

test("duplicate unit ids are caught", () => {
  const findings = checkWorld({
    regionOwnershipOverrides: {},
    units: [
      { id: "same", lng: 1, lat: 1, ownerCode: "France" },
      { id: "same", lng: 2, lat: 2, ownerCode: "France" },
    ],
  });
  assert.ok(ids(findings).includes("duplicate-unit-id"));
});

test("a healthy world produces no findings at all", () => {
  const findings = checkAll({
    world: {
      regionOwnershipOverrides: { "FRA.1_1": "France", "DEU.2_1": "Germany" },
      units: [{ id: "u1", lng: 2.35, lat: 48.87, strength: 100, ownerCode: "France" }],
      internationalReputation: { France: 55 },
    },
    game: { round: 3, gameDate: "2016-06-01" },
    events: [{ id: "e1", date: "2016-05-01" }],
  });
  assert.deepEqual(findings, []);
});

test("the clock going backwards is critical, except after a rollback", () => {
  const previous = { round: 5, gameDate: "2016-06-01" };
  const rewound = { round: 4, gameDate: "2016-05-01" };

  const findings = checkGame(rewound, { previous });
  assert.deepEqual(ids(findings), ["date-went-backwards", "round-went-backwards"]);

  // A rollback is SUPPOSED to move the clock back, so it must not be reported.
  assert.deepEqual(checkGame(rewound, { previous, allowRewind: true }), []);
});

test("a malformed date or round is caught", () => {
  assert.ok(ids(checkGame({ round: 1, gameDate: "not-a-date" })).includes("date-malformed"));
  assert.ok(ids(checkGame({ round: 0, gameDate: "2016-01-01" })).includes("round-invalid"));
  assert.ok(ids(checkGame({ round: Number.NaN, gameDate: "2016-01-01" })).includes("round-invalid"));
});

test("levels escalate, and level 1 stays plausible", () => {
  // Level 1 must never generate hostile input: a bug found there has to be one a
  // real player could hit, or the whole severity ladder means nothing.
  assert.equal(LEVELS[1].weight.nastyInput, 0);
  assert.equal(LEVELS[1].weight.gmCommand, 0);
  assert.ok(LEVELS[5].weight.nastyInput > LEVELS[3].weight.nastyInput);
  assert.ok(LEVELS[5].turns > LEVELS[1].turns);
});

test("the action sequence is deterministic for a seed", () => {
  const sequence = (seed) => {
    const rng = makeRng(seed);
    return Array.from({ length: 20 }, () => nextAction(rng, 3));
  };
  assert.deepEqual(sequence(42), sequence(42), "same seed, same run — reproducibility depends on this");
  assert.notDeepEqual(sequence(42), sequence(43));
});

test("the severity floor rises with the level", () => {
  // At level 1 a medium finding fails the run; at level 5 only a critical does,
  // because level 5 is expected to produce noise.
  assert.equal(isFailing("medium", 1), true);
  assert.equal(isFailing("medium", 5), false);
  assert.equal(isFailing("critical", 5), true);
});
