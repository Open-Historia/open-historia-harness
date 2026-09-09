// "What changed this turn" — the view that makes a headless run readable.
//
// PURE. No I/O, no imports from the game, no clock. Two state bundles in, a plain
// object out, so it is unit-testable against transcribed fixtures.
//
// The section that earns its place is `reconciliation`. Everything else describes
// what the world looks like now; reconciliation cross-checks what the AI SAID
// against what actually landed. The two worst failure modes in this game are "the
// event says territory changed hands but the map never moved" and "troops were
// narrated but never appeared" — the exact bugs the [Map Truth] and
// [Unit Coordinates] prompt directives were bolted on to fight. Those directives
// exist because nobody could measure the problem. Now it is a number.

const asArray = (value) => (Array.isArray(value) ? value : []);
const asObject = (value) => (value && typeof value === "object" ? value : {});

/**
 * Units store their side as `ownerCode` (a full country name, despite the
 * field's name), not `owner`. Reading `owner` gives null for every real unit the
 * game creates, which quietly emptied the per-polity unit tallies.
 */
export const unitOwner = (unit) => unit?.ownerCode ?? unit?.owner ?? null;

const indexById = (list) => {
  const map = new Map();
  for (const entry of asArray(list)) {
    if (entry?.id) map.set(entry.id, entry);
  }
  return map;
};

/** Great-circle distance in km, for reporting how far a unit actually moved. */
export const haversineKm = (aLng, aLat, bLng, bLat) => {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h))));
};

const diffGame = (before, after) => {
  const fields = ["round", "gameDate", "country", "difficulty", "startDate", "language"];
  const changes = {};
  for (const field of fields) {
    const from = asObject(before)[field];
    const to = asObject(after)[field];
    changes[field] = from === to ? null : [from, to];
  }
  return changes;
};

const diffRegions = (beforeWorld, afterWorld, nameOf) => {
  const from = asObject(beforeWorld.regionOwnershipOverrides);
  const to = asObject(afterWorld.regionOwnershipOverrides);

  const transferred = [];
  const added = [];
  const removed = [];

  for (const id of new Set([...Object.keys(from), ...Object.keys(to)])) {
    const was = from[id] ?? null;
    const now = to[id] ?? null;
    if (was === now) continue;
    const entry = { id, name: nameOf(id) };
    if (was && now) transferred.push({ ...entry, from: was, to: now });
    else if (now) added.push({ ...entry, to: now });
    else removed.push({ ...entry, from: was });
  }

  const byPolity = {};
  const bump = (polity, key, delta = 1) => {
    byPolity[polity] ??= { gained: 0, lost: 0, net: 0, gainedFrom: {}, lostTo: {} };
    byPolity[polity][key] += delta;
    byPolity[polity].net = byPolity[polity].gained - byPolity[polity].lost;
  };

  const pairs = new Map();
  for (const move of transferred) {
    bump(move.to, "gained");
    bump(move.from, "lost");
    byPolity[move.to].gainedFrom[move.from] = (byPolity[move.to].gainedFrom[move.from] ?? 0) + 1;
    byPolity[move.from].lostTo[move.to] = (byPolity[move.from].lostTo[move.to] ?? 0) + 1;

    const key = JSON.stringify([move.from, move.to]);
    if (!pairs.has(key)) pairs.set(key, { from: move.from, to: move.to, count: 0, regions: [] });
    const pair = pairs.get(key);
    pair.count += 1;
    pair.regions.push(move.name || move.id);
  }
  for (const entry of added) bump(entry.to, "gained");
  for (const entry of removed) bump(entry.from, "lost");

  return {
    transferred: transferred.sort((a, b) => a.id.localeCompare(b.id)),
    added,
    removed,
    byPolity,
    byPair: [...pairs.values()].sort((a, b) => b.count - a.count),
  };
};

const diffUnits = (beforeWorld, afterWorld) => {
  const before = indexById(beforeWorld.units);
  const after = indexById(afterWorld.units);

  const spawned = [];
  const removed = [];
  const moved = [];
  const strength = [];
  const status = [];

  for (const [id, unit] of after) {
    const was = before.get(id);
    if (!was) {
      spawned.push({
        id,
        name: unit.name ?? null,
        owner: unitOwner(unit),
        type: unit.type ?? null,
        strength: unit.strength ?? null,
        at: [unit.lng ?? null, unit.lat ?? null],
      });
      continue;
    }
    if (was.lng !== unit.lng || was.lat !== unit.lat) {
      moved.push({
        id,
        name: unit.name ?? null,
        owner: unitOwner(unit),
        from: [was.lng, was.lat],
        to: [unit.lng, unit.lat],
        km:
          [was.lng, was.lat, unit.lng, unit.lat].every((n) => Number.isFinite(n))
            ? haversineKm(was.lng, was.lat, unit.lng, unit.lat)
            : null,
      });
    }
    if (was.strength !== unit.strength) {
      strength.push({
        id,
        name: unit.name ?? null,
        owner: unitOwner(unit),
        from: was.strength ?? null,
        to: unit.strength ?? null,
        delta: (Number(unit.strength) || 0) - (Number(was.strength) || 0),
      });
    }
    if (was.status !== unit.status) {
      status.push({ id, name: unit.name ?? null, from: was.status ?? null, to: unit.status ?? null });
    }
  }

  for (const [id, unit] of before) {
    if (after.has(id)) continue;
    removed.push({
      id,
      name: unit.name ?? null,
      owner: unitOwner(unit),
      lastStrength: unit.strength ?? null,
    });
  }

  const byPolity = {};
  const tally = (owner, key, delta = 1) => {
    if (!owner) return;
    byPolity[owner] ??= { spawned: 0, removed: 0, moved: 0, netStrength: 0 };
    byPolity[owner][key] += delta;
  };
  for (const u of spawned) {
    tally(u.owner, "spawned");
    tally(u.owner, "netStrength", Number(u.strength) || 0);
  }
  for (const u of removed) {
    tally(u.owner, "removed");
    tally(u.owner, "netStrength", -(Number(u.lastStrength) || 0));
  }
  for (const u of moved) tally(u.owner, "moved");
  for (const u of strength) tally(u.owner, "netStrength", u.delta);

  return { spawned, removed, moved, strength, status, byPolity };
};

const diffPolities = (beforeWorld, afterWorld) => {
  const before = asObject(beforeWorld.polityOverrides);
  const after = asObject(afterWorld.polityOverrides);
  const beforeRep = asObject(beforeWorld.internationalReputation);
  const afterRep = asObject(afterWorld.internationalReputation);
  const beforeTags = asObject(beforeWorld.countryTags);
  const afterTags = asObject(afterWorld.countryTags);

  const created = Object.keys(after).filter((name) => !(name in before));
  const removed = Object.keys(before).filter((name) => !(name in after));

  const reputation = [];
  for (const polity of new Set([...Object.keys(beforeRep), ...Object.keys(afterRep)])) {
    const from = beforeRep[polity] ?? null;
    const to = afterRep[polity] ?? null;
    if (from === to) continue;
    reputation.push({ polity, from, to, delta: (Number(to) || 0) - (Number(from) || 0) });
  }

  const tags = [];
  for (const polity of new Set([...Object.keys(beforeTags), ...Object.keys(afterTags)])) {
    const was = new Set(asArray(beforeTags[polity]));
    const now = new Set(asArray(afterTags[polity]));
    const gained = [...now].filter((t) => !was.has(t));
    const lost = [...was].filter((t) => !now.has(t));
    if (gained.length || lost.length) tags.push({ polity, added: gained, removed: lost });
  }

  const colors = [];
  for (const polity of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const from = before[polity]?.color ?? null;
    const to = after[polity]?.color ?? null;
    if (from !== to) colors.push({ polity, from, to });
  }

  return { created, removed, reputation, tags, colors };
};

const impactsOf = (event) => asObject(event?.impacts);

/**
 * The headline. Compare what the new events CLAIMED against what the world
 * actually shows.
 *
 * A claimed transfer counts as applied when the region really is owned by the
 * named polity afterwards. Anything else is reported with a reason, because
 * "the model said Alsace changed hands and it did not" is the single most useful
 * sentence this harness can produce.
 */
/**
 * Unit ops, reconciled by KIND rather than pretending to match op-to-unit.
 *
 * Ops carry no id that survives into the world for a spawn, so claiming per-op
 * resolution would be false precision. Comparing counts per kind is honest and
 * still catches the failure that matters: an event narrating three deployments
 * while nothing appears on the map.
 */
const unitOpTally = ({ newEvents, units }) => {
  const claimed = { spawn: 0, move: 0, remove: 0, other: 0 };
  for (const event of newEvents) {
    for (const op of asArray(impactsOf(event).unitOps)) {
      const kind = String(op?.op ?? "").toLowerCase();
      if (/spawn|create|deploy/.test(kind)) claimed.spawn += 1;
      else if (/move|advance|reposition/.test(kind)) claimed.move += 1;
      else if (/remove|destroy|disband|defeat/.test(kind)) claimed.remove += 1;
      else claimed.other += 1;
    }
  }

  const actual = { spawn: units.spawned.length, move: units.moved.length, remove: units.removed.length };
  const total = claimed.spawn + claimed.move + claimed.remove;
  const matched =
    Math.min(claimed.spawn, actual.spawn) +
    Math.min(claimed.move, actual.move) +
    Math.min(claimed.remove, actual.remove);

  const shortfalls = [];
  for (const kind of ["spawn", "move", "remove"]) {
    if (claimed[kind] > actual[kind]) {
      shortfalls.push({ kind, claimed: claimed[kind], applied: actual[kind], why: `${claimed[kind] - actual[kind]} narrated but not on the map` });
    }
  }

  return { claimed, actual, matched, shortfalls, score: total === 0 ? null : Number((matched / total).toFixed(3)) };
};

const reconcile = ({ newEvents, beforeWorld, afterWorld, regions, units, nameOf }) => {
  const ownedBefore = asObject(beforeWorld.regionOwnershipOverrides);
  const ownedAfter = asObject(afterWorld.regionOwnershipOverrides);

  const claimed = [];
  for (const event of newEvents) {
    for (const transfer of asArray(impactsOf(event).regionTransfers)) {
      claimed.push({
        eventId: event.id ?? null,
        eventTitle: event.title ?? null,
        regionId: transfer.regionId,
        from: transfer.fromCode ?? null,
        to: transfer.toCode ?? null,
      });
    }
  }

  const applied = [];
  const unapplied = [];
  const explained = new Set();

  for (const claim of claimed) {
    const owner = ownedAfter[claim.regionId];
    if (owner === undefined) {
      unapplied.push({ ...claim, why: "no region with that id exists in the world" });
      continue;
    }
    if (owner !== claim.to) {
      unapplied.push({
        ...claim,
        actualOwner: owner,
        why:
          ownedBefore[claim.regionId] === owner
            ? "the map did not move — the region still has its previous owner"
            : `the map moved to ${owner} instead`,
      });
      continue;
    }
    if (ownedBefore[claim.regionId] === claim.to) {
      unapplied.push({ ...claim, why: "already owned by that polity before the turn" });
      continue;
    }
    applied.push({ ...claim, name: nameOf(claim.regionId) });
    explained.add(claim.regionId);
  }

  // Ownership that moved with no event claiming it. Rarer, and usually a sign the
  // engine applied something the story never mentioned.
  const unexplained = regions.transferred
    .filter((move) => !explained.has(move.id))
    .map((move) => ({ ...move, why: "map moved with no event claiming it" }));

  return {
    transfers: {
      claimed: claimed.length,
      applied: applied.length,
      appliedList: applied,
      unapplied,
      unexplained,
    },
    unitOps: unitOpTally({ newEvents, units }),
    // applied / claimed. Null rather than a misleading 1.0 when nothing was
    // claimed — "the model made no territorial claims" is not "the model was
    // perfectly accurate".
    mapTruthScore: claimed.length === 0 ? null : Number((applied.length / claimed.length).toFixed(3)),
  };
};

/**
 * Diff two state bundles.
 *
 * `nameOf` resolves a region id to a human name; pass one from inspect.js when a
 * catalog is available, otherwise ids are used and nothing breaks.
 */
export const diffStates = (before, after, { nameOf = () => null } = {}) => {
  const beforeWorld = asObject(before?.world);
  const afterWorld = asObject(after?.world);
  const resolve = (id) => nameOf(id) ?? null;

  const regions = diffRegions(beforeWorld, afterWorld, resolve);
  const units = diffUnits(beforeWorld, afterWorld);
  const polities = diffPolities(beforeWorld, afterWorld);

  const beforeEvents = indexById(before?.events);
  const newEvents = asArray(after?.events).filter((event) => !beforeEvents.has(event?.id));

  const beforeActions = indexById(before?.actions);
  const afterActions = indexById(after?.actions);
  const actionStatusChanged = [];
  for (const [id, action] of afterActions) {
    const was = beforeActions.get(id);
    if (was && was.status !== action.status) {
      actionStatusChanged.push({ id, title: action.title ?? null, from: was.status, to: action.status });
    }
  }

  const beforeChats = indexById(before?.chats);
  const chatsOpened = asArray(after?.chats)
    .filter((chat) => !beforeChats.has(chat?.id))
    .map((chat) => ({
      id: chat.id,
      participants: chat.participants ?? [],
      firstLine: asArray(chat.messages)[0]?.text ?? null,
    }));
  const chatNewMessages = [];
  for (const chat of asArray(after?.chats)) {
    const was = beforeChats.get(chat?.id);
    if (!was) continue;
    const gained = asArray(chat.messages).length - asArray(was.messages).length;
    if (gained > 0) {
      const last = asArray(chat.messages).at(-1);
      chatNewMessages.push({ chatId: chat.id, count: gained, lastSpeaker: last?.speaker ?? null, lastText: last?.text ?? null });
    }
  }

  const reconciliation = reconcile({ newEvents, beforeWorld, afterWorld, regions, units, nameOf: resolve });

  const summary = [
    ...regions.transferred.map((m) => `${m.name || m.id}: ${m.from} -> ${m.to}`),
    ...units.spawned.map((u) => `unit spawned: ${u.name ?? u.id} (${u.owner})`),
    ...units.removed.map((u) => `unit lost: ${u.name ?? u.id} (${u.owner})`),
    ...units.moved.map((u) => `unit moved: ${u.name ?? u.id} ${u.km ?? "?"} km`),
    ...polities.reputation.map((r) => `reputation ${r.polity}: ${r.from} -> ${r.to}`),
  ];

  return {
    game: diffGame(before?.game, after?.game),
    regions,
    units,
    polities,
    events: {
      added: newEvents.map((event) => ({
        id: event.id ?? null,
        date: event.date ?? null,
        title: event.title ?? null,
        notable: Boolean(event.notable),
        playerRelated: Boolean(event.playerRelated),
        impactCounts: {
          regionTransfers: asArray(impactsOf(event).regionTransfers).length,
          unitOps: asArray(impactsOf(event).unitOps).length,
          markerOps: asArray(impactsOf(event).markerOps).length,
          polityChanges: asArray(impactsOf(event).polityChanges).length,
          createdChats: asArray(impactsOf(event).createdChats).length,
        },
      })),
      count: newEvents.length,
    },
    actions: { statusChanged: actionStatusChanged },
    chats: { opened: chatsOpened, newMessages: chatNewMessages },
    reconciliation,
    summary,
  };
};
