// Name resolution, which is how every readable assertion in a scenario is
// written. The cases that matter are the ones where guessing would be worse than
// admitting defeat: shared names (53 of them in the real catalog) and English
// exonyms for regions GADM stores under native names.

import assert from "node:assert/strict";
import test from "node:test";

import { foldName, indexCatalog, isUsableCatalog } from "./inspect.js";

// Transcribed from the real catalog built off regions.pmtiles.
const CATALOG = [
  { id: "DEU.1_1", name: "Baden-Württemberg", country: "Germany", countryCode: "DEU" },
  { id: "DEU.2_1", name: "Bayern", country: "Germany", countryCode: "DEU" },
  { id: "DEU.3_1", name: "Berlin", country: "Germany", countryCode: "DEU" },
  { id: "RUS.3_1", name: "Amur", country: "Russia", countryCode: "RUS" },
  // Genuinely ambiguous in the real data: La Rioja exists in both Spain and
  // Argentina, and Córdoba likewise.
  { id: "ESP.11_1", name: "La Rioja", country: "Spain", countryCode: "ESP" },
  { id: "ARG.10_1", name: "La Rioja", country: "Argentina", countryCode: "ARG" },
];

test("foldName ignores case, accents and punctuation", () => {
  assert.equal(foldName("Baden-Württemberg"), foldName("baden wurttemberg"));
  assert.equal(foldName("Córdoba"), "cordoba");
  assert.equal(foldName("  Bayern "), "bayern");
});

test("the catalog indexes by id and by folded name", () => {
  const index = indexCatalog(CATALOG);
  assert.equal(index.size, 6);
  assert.equal(index.byId.get("DEU.2_1").name, "Bayern");
  assert.equal(index.byName.get("bayern")[0].id, "DEU.2_1");
  // A diacritic-insensitive lookup must still find the accented name.
  assert.equal(index.byName.get("baden wurttemberg")[0].id, "DEU.1_1");
});

test("a shared name indexes to BOTH regions rather than one winning", () => {
  // 53 names are shared in the real catalog. Silently picking one would make an
  // assertion pass against the wrong continent.
  const index = indexCatalog(CATALOG);
  const matches = index.byName.get("la rioja");
  assert.equal(matches.length, 2);
  assert.deepEqual(matches.map((m) => m.country).sort(), ["Argentina", "Spain"]);
});

test("isUsableCatalog rejects the shape a real bug produced", () => {
  // The regression this exists for: an adapter treated the engine's ARRAY as a
  // name map, producing entries keyed by array index. The result had the right
  // COUNT and entirely wrong contents, and it got cached — so every later run
  // silently resolved no names at all.
  const indexKeyed = Array.from({ length: 3143 }, (_, i) => ({ id: String(i), name: "[object Object]" }));
  assert.equal(isUsableCatalog(indexKeyed), false, "array-index ids are not GADM ids");

  assert.equal(isUsableCatalog(null), false);
  assert.equal(isUsableCatalog([]), false);
  assert.equal(isUsableCatalog(CATALOG), false, "a 6-entry fixture is too small to be the real catalog");

  const realistic = Array.from({ length: 200 }, (_, i) => ({ id: `DEU.${i}_1`, name: `Region ${i}` }));
  assert.equal(isUsableCatalog(realistic), true);
});

test("isUsableCatalog rejects entries missing a name", () => {
  const holes = Array.from({ length: 200 }, (_, i) => ({ id: `DEU.${i}_1`, name: i === 5 ? "" : `Region ${i}` }));
  assert.equal(isUsableCatalog(holes), false);
});
