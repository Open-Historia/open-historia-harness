// Seeing the game as data.
//
// Every question I would otherwise answer by squinting at a screenshot —
// "did Bavaria transfer?", "where is the 3rd Army?", "what did the advisor say?"
// — answered from state instead, as plain objects.
//
// Region names come from a catalog built once from regions.pmtiles and cached
// under the sandbox root. That is deliberately independent of the game's own
// loader: who() stays instant even when the engine's catalog is cold, and a name
// lookup never perturbs the state being inspected.

import fs from "node:fs";
import path from "node:path";

import { unitOwner } from "./diff.js";

const asArray = (value) => (Array.isArray(value) ? value : []);
const asObject = (value) => (value && typeof value === "object" ? value : {});

/** Case- and diacritic-insensitive, so "baden-wurttemberg" finds "Baden-Württemberg". */
export const foldName = (value) =>
  String(value ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/**
 * Does this look like a real catalog?
 *
 * Region ids are GADM-shaped ("DEU.2_1"), never bare array indices — which is
 * exactly what a shape bug produced once.
 */
export const isUsableCatalog = (records) =>
  Array.isArray(records) &&
  records.length > 100 &&
  records.every((r) => typeof r?.id === "string" && typeof r?.name === "string" && r.name.length > 0) &&
  records.some((r) => /[A-Za-z]{3}\./.test(r.id));

/**
 * Build the region catalog from the game's own pmtiles, once, and cache it.
 *
 * Measured at ~144 ms for 3145 regions, so it is cached across runs rather than
 * paid per session.
 */
export const loadRegionCatalog = async ({ session, cachePath }) => {
  if (cachePath && fs.existsSync(cachePath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cachePath, "utf8"));
      // Validate the SHAPE, not just that it parsed. A cache written by a buggy
      // build once poisoned every later run: it had the right entry count and
      // entirely wrong contents, so nothing looked broken except that no region
      // name ever resolved. Cheap to check, and it self-heals instead of needing
      // someone to know the cache exists.
      if (isUsableCatalog(cached)) return cached;
    } catch {
      // A corrupt cache is not worth a failed run; rebuild below.
    }
  }

  let records = [];
  try {
    // The engine returns an ARRAY of {country, countryCode, id, name} — not a
    // name map. Treating it as a map turned array indices into region ids, which
    // silently produced a catalog of the right SIZE and entirely wrong contents.
    const catalog = await session.modules.assets.loadRegionCatalog();
    records = asArray(catalog)
      .filter((entry) => entry?.id && entry?.name)
      .map((entry) => ({
        id: String(entry.id),
        name: String(entry.name),
        country: entry.country ?? null,
        countryCode: entry.countryCode ?? null,
      }));
  } catch {
    records = [];
  }

  // Only cache what passes the same check we apply on read, so a bad build never
  // gets to persist its mistake.
  if (cachePath && isUsableCatalog(records)) {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(records));
  }
  return records;
};

/** Index a catalog for id and folded-name lookup. */
export const indexCatalog = (records) => {
  const byId = new Map();
  const byName = new Map();
  for (const record of asArray(records)) {
    if (!record?.id) continue;
    byId.set(record.id, record);
    const folded = foldName(record.name);
    if (!folded) continue;
    if (!byName.has(folded)) byName.set(folded, []);
    byName.get(folded).push(record);
  }
  return { byId, byName, size: byId.size };
};

/**
 * Create the inspection API over a live session.
 *
 * `catalog` is optional — everything still works with ids instead of names.
 */
export const createInspector = ({ session, catalog = [] }) => {
  const index = indexCatalog(catalog);
  const nameOf = (id) => index.byId.get(id)?.name ?? null;

  const readBundle = async () => {
    const bundle = await session.modules.gameState.readGameStateBundle({ force: true });
    return bundle;
  };

  const snapshot = async () => {
    const bundle = await readBundle();
    const world = asObject(bundle.world);
    const owners = asObject(world.regionOwnershipOverrides);

    const ownershipByPolity = {};
    for (const [regionId, owner] of Object.entries(owners)) {
      (ownershipByPolity[owner] ??= []).push(regionId);
    }

    const polities = {};
    for (const [name, override] of Object.entries(asObject(world.polityOverrides))) {
      polities[name] = {
        aliases: asArray(override.aliases),
        color: override.color ?? null,
        note: override.note ?? null,
        regionCount: ownershipByPolity[name]?.length ?? 0,
      };
    }
    for (const [name, regions] of Object.entries(ownershipByPolity)) {
      polities[name] ??= { aliases: [], color: null, note: null, regionCount: regions.length };
      polities[name].reputation = asObject(world.internationalReputation)[name] ?? null;
      polities[name].tags = asArray(asObject(world.countryTags)[name]);
      polities[name].landless = regions.length === 0;
    }

    return {
      at: new Date().toISOString(),
      gameId: session.sandbox.gameId,
      round: bundle.game?.round ?? null,
      gameDate: bundle.game?.gameDate ?? null,
      startDate: bundle.game?.startDate ?? null,
      country: bundle.game?.country ?? null,
      difficulty: bundle.game?.difficulty ?? null,
      counts: {
        regions: Object.keys(owners).length,
        polities: Object.keys(ownershipByPolity).length,
        units: asArray(world.units).length,
        markers: asArray(world.markers).length,
        events: asArray(bundle.events).length,
        actions: asArray(bundle.actions).length,
        chats: asArray(bundle.chats).length,
      },
      ownership: owners,
      ownershipByPolity,
      claimants: asObject(world.regionClaimants),
      polities,
      units: asArray(world.units),
      markers: asArray(world.markers),
      activeCatalyst: world.activeCatalyst ?? null,
      actionSuggestions: asArray(world.actionSuggestions),
      consolidatedHistory: world.consolidatedHistory ?? null,
      events: asArray(bundle.events),
      actions: asArray(bundle.actions),
      chats: asArray(bundle.chats),
      // The escape hatch. When a question has no verb yet, drill into the raw
      // bundle rather than waiting for one to be added.
      _raw: bundle,
    };
  };

  /**
   * Resolve a region by id OR name.
   *
   * Reports ambiguity instead of guessing: several GADM regions share a name, and
   * silently picking one would make an assertion pass against the wrong place.
   */
  const who = async (idOrName, state = null) => {
    const snap = state ?? (await snapshot());
    const direct = index.byId.get(idOrName);
    if (direct || snap.ownership[idOrName] !== undefined) {
      const id = direct?.id ?? idOrName;
      return {
        regionId: id,
        regionName: nameOf(id),
        owner: snap.ownership[id] ?? null,
        claimants: asArray(snap.claimants[id]),
        matchedBy: "id",
      };
    }

    const folded = foldName(idOrName);
    const matches = index.byName.get(folded) ?? [];
    if (matches.length === 0) {
      // GADM stores NATIVE names — Bavaria is "Bayern", Cologne is "Köln" — so an
      // English exonym is a dead end unless we help. Returning near-misses turns
      // "no match" into an answer rather than a wall.
      const suggestions = [];
      for (const [name, records] of index.byName) {
        if (name.includes(folded) || folded.includes(name)) {
          suggestions.push(...records.map((r) => ({ id: r.id, name: r.name, country: r.country })));
        }
        if (suggestions.length >= 8) break;
      }
      return {
        regionId: null,
        regionName: null,
        owner: null,
        claimants: [],
        matchedBy: null,
        ...(suggestions.length ? { suggestions } : {}),
      };
    }
    if (matches.length > 1) {
      return {
        regionId: null,
        regionName: null,
        owner: null,
        claimants: [],
        matchedBy: "ambiguous",
        ambiguous: matches.map((m) => ({ id: m.id, name: m.name, owner: snap.ownership[m.id] ?? null })),
      };
    }

    const match = matches[0];
    return {
      regionId: match.id,
      regionName: match.name,
      owner: snap.ownership[match.id] ?? null,
      claimants: asArray(snap.claimants[match.id]),
      matchedBy: "name",
    };
  };

  const ownerOf = async (idOrName, state = null) => (await who(idOrName, state)).owner;

  /**
   * Search the catalog by pattern.
   *
   * The honest answer to the exonym problem. GADM stores native names, so
   * who("Bavaria") legitimately finds nothing and no fuzzy match can bridge
   * Bavaria -> Bayern without guessing. searchRegions(/bay/i) finds it in one
   * call, and searchRegions(/./, {country:"Germany"}) lists the lot.
   */
  const searchRegions = (pattern, { country = null, limit = 40 } = {}) => {
    const re = pattern instanceof RegExp ? pattern : new RegExp(String(pattern), "i");
    const hits = [];
    for (const record of index.byId.values()) {
      if (country && record.country !== country) continue;
      if (!re.test(record.name) && !re.test(record.id)) continue;
      hits.push(record);
      if (hits.length >= limit) break;
    }
    return hits.sort((a, b) => a.name.localeCompare(b.name));
  };

  const regionsOf = async (polity, state = null) => {
    const snap = state ?? (await snapshot());
    return (snap.ownershipByPolity[polity] ?? [])
      .map((id) => ({ id, name: nameOf(id) }))
      .sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id));
  };

  const unitsOf = async (polity, state = null) => {
    const snap = state ?? (await snapshot());
    // Units carry their side as `ownerCode`, not `owner`. See unitOwner in diff.js.
    return snap.units.filter((unit) => unitOwner(unit) === polity);
  };

  const unit = async (nameOrId, state = null) => {
    const snap = state ?? (await snapshot());
    const folded = foldName(nameOrId);
    return snap.units.find((u) => u.id === nameOrId || foldName(u.name) === folded) ?? null;
  };

  const eventsTail = async (count = 10, state = null) => {
    const snap = state ?? (await snapshot());
    return snap.events.slice(-count);
  };

  const eventsMatching = async (pattern, state = null) => {
    const snap = state ?? (await snapshot());
    const re = pattern instanceof RegExp ? pattern : new RegExp(String(pattern), "i");
    return snap.events.filter((e) => re.test(`${e.title ?? ""} ${e.text ?? ""}`));
  };

  const eventsWithTransfers = async (state = null) => {
    const snap = state ?? (await snapshot());
    return snap.events.filter((e) => asArray(e?.impacts?.regionTransfers).length > 0);
  };

  const plannedActions = async (state = null) => {
    const snap = state ?? (await snapshot());
    return snap.actions.filter((a) => a.status === "planned");
  };

  const queuedOrders = async (state = null) => {
    const snap = state ?? (await snapshot());
    return snap.actions.filter((a) => a.source === "order");
  };

  const advisorTail = async (count = 10) => {
    const advisor = await session.modules.assets.readJson(
      session.modules.assets.JSON_URLS.advisor,
      { defaultValue: [], force: true },
    );
    return asArray(advisor).slice(-count);
  };

  const chatsWith = async (polity, state = null) => {
    const snap = state ?? (await snapshot());
    return snap.chats.filter((chat) => asArray(chat.participants).includes(polity));
  };

  /** Full-text sweep — the "where the hell is that string" verb. */
  const find = async (pattern, state = null) => {
    const snap = state ?? (await snapshot());
    const re = pattern instanceof RegExp ? pattern : new RegExp(String(pattern), "i");
    const hits = [];
    const test = (kind, id, text) => {
      if (text && re.test(text)) hits.push({ kind, id, text: String(text).slice(0, 200) });
    };
    for (const e of snap.events) test("event", e.id, `${e.title ?? ""} ${e.text ?? ""}`);
    for (const a of snap.actions) test("action", a.id, `${a.title ?? ""} ${a.text ?? ""}`);
    for (const c of snap.chats) for (const m of asArray(c.messages)) test("chat", c.id, m.text);
    return hits;
  };

  return {
    nameOf,
    catalogSize: index.size,
    snapshot,
    who,
    ownerOf,
    searchRegions,
    regionsOf,
    unitsOf,
    unit,
    eventsTail,
    eventsMatching,
    eventsWithTransfers,
    plannedActions,
    queuedOrders,
    advisorTail,
    chatsWith,
    find,
  };
};
