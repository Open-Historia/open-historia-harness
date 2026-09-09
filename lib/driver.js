// The verbs. Thin wrappers over the engine's own functions, with a snapshot taken
// either side of anything that mutates, so a diff is always available without the
// caller having to remember to ask for one.
//
// Nothing here reimplements game logic. Every verb is a call into gameplay.js or
// unitsController.js — the harness's job is to observe, not to simulate.

import path from "node:path";

import { diffStates } from "./diff.js";
import { createInspector, loadRegionCatalog } from "./inspect.js";

const asArray = (value) => (Array.isArray(value) ? value : []);

/**
 * unitsController keeps units, playerCode, round and gameDate in module scope,
 * populated only by an unexported refresh(). deployUnit self-heals, but move and
 * attack read a stale empty list without this.
 *
 * startUnitsSync() fires that refresh and returns a teardown, and subscribeUnits
 * tells us when it landed — so the module can be primed with no source change,
 * and the 5-second poll it also starts is killed immediately rather than left
 * running to race the turn.
 */
const primeUnits = (units) =>
  new Promise((resolve) => {
    let stop = () => {};
    const off = units.subscribeUnits(() => {
      off();
      stop();
      resolve();
    });
    stop = units.startUnitsSync();
    // If the module was already primed no event fires, so do not hang.
    setTimeout(() => {
      off();
      stop();
      resolve();
    }, 2000).unref?.();
  });

export const createDriver = async (session, { catalog } = {}) => {
  const { gameplay, gameState, units: unitsController } = session.modules;

  const records =
    catalog ??
    (await loadRegionCatalog({
      session,
      cachePath: path.join(path.dirname(session.sandbox.dir), "..", "cache", "region-catalog.json"),
    }));
  const inspect = createInspector({ session, catalog: records });

  const read = () => gameState.readGameStateBundle({ force: true });

  /**
   * Run a mutating verb and describe what it did.
   *
   * Provider calls are attributed to `task` for the run, which is how a retry
   * becomes visible: two calls tagged to one task means the first answer failed
   * validation.
   */
  const observed = async (task, run) => {
    const before = await read();
    const restore = session.fetch.withTask(task);
    const startedAt = Date.now();
    let result = null;
    let error = null;
    try {
      result = await run();
    } catch (caught) {
      error = caught;
    } finally {
      restore();
    }
    const ms = Date.now() - startedAt;
    const after = await read();

    const diff = diffStates(before, after, { nameOf: inspect.nameOf });
    const generation = result?.generation ?? null;

    return {
      task,
      ok: !error,
      error,
      result,
      before,
      after,
      diff,
      ms,
      generation,
      // The most diagnostic field in the system. A fallback means the model never
      // answered and the engine used canned events instead, which looks like a
      // successful turn unless someone checks.
      fallback: generation?.source === "fallback" ? (generation.fallbackReason ?? "unknown") : null,
      providerCalls: session.fetch.stats.aiByTask[task] ?? 0,
    };
  };

  const game = {
    turn: (days = 30) => observed("jumpForward", () => gameplay.simulateTimelineJump({ days })),
    autoTurn: (days = 365) => observed("autoJumpForward", () => gameplay.simulateAutoJump({ days })),

    /** Run `count` turns, stopping early on the first failure. */
    turns: async (count, { days = 30 } = {}) => {
      const results = [];
      for (let index = 0; index < count; index += 1) {
        const outcome = await game.turn(days);
        results.push(outcome);
        if (!outcome.ok) break;
      }
      return results;
    },

    gm: (text) => observed("gameMaster", () => gameplay.applyGameMasterCommand(text)),
    suggest: () => observed("actions", () => gameplay.generateActionSuggestions()),
    refine: (text) => observed("descriptionToAction", () => gameplay.refinePlayerAction(text)),
    catalyst: () => observed("catalystCreation", () => gameplay.createCatalyst()),
    chooseCatalyst: (choice) => observed("catalystExecutor", () => gameplay.advanceActiveCatalyst(choice)),
    stats: (code, name) => observed("countryStatSheet", () => gameplay.generateCountryStatSheet({ code, name })),
    spy: (target) => observed("spyIntercept", () => gameplay.gatherIntelligence(target)),
    intercepts: () => observed("spyIntercept", () => gameplay.refreshSpyIntercepts()),
    consolidate: () => observed("eventConsolidator", () => gameplay.consolidateRecentHistory()),

    snapshots: () => gameplay.loadRollbackSnapshots(),
    rollback: (index = 0) => observed("rollback", () => gameplay.rollBackToSnapshot(index)),

    /** Append a planned action, the way the actions panel does. */
    plan: async (text) => {
      const actions = await gameState.readActionsState({ force: true });
      const next = [
        ...asArray(actions),
        {
          createdAt: new Date().toISOString(),
          id: `harness-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          kind: "action",
          participants: [],
          rawInput: text,
          source: "manual",
          status: "planned",
          text,
          title: text.length > 64 ? `${text.slice(0, 61)}...` : text,
        },
      ];
      await session.modules.assets.writeJson(session.modules.assets.JSON_URLS.actions, next);
      return next.at(-1);
    },
  };

  // Direct world writes. No AI, no cost — for building the preconditions a test
  // needs before the turn it actually cares about.
  const world = {
    snapshot: inspect.snapshot,
    diff: (before, after) => diffStates(before, after, { nameOf: inspect.nameOf }),
    read,

    setOwner: async (regionIdOrName, polity) => {
      const resolved = await inspect.who(regionIdOrName);
      if (!resolved.regionId) {
        throw new Error(
          resolved.matchedBy === "ambiguous"
            ? `[harness] "${regionIdOrName}" matches ${resolved.ambiguous.length} regions; use an id`
            : `[harness] no region matched "${regionIdOrName}"`,
        );
      }
      const current = await gameState.readWorldState({ force: true });
      await gameState.writeWorldState({
        ...current,
        regionOwnershipOverrides: { ...current.regionOwnershipOverrides, [resolved.regionId]: polity },
      });
      return resolved.regionId;
    },

    setDate: async (iso) => {
      const current = await gameState.readGameData({ force: true });
      return gameState.writeGameData({ ...current, gameDate: iso });
    },

    setPlayer: async (country) => {
      const current = await gameState.readGameData({ force: true });
      return gameState.writeGameData({ ...current, country });
    },

    spawnUnit: async (unit) => {
      const current = await gameState.readWorldState({ force: true });
      const next = {
        id: unit.id ?? `harness-unit-${Date.now()}`,
        name: unit.name ?? "Harness Unit",
        type: unit.type ?? "infantry",
        owner: unit.owner ?? current.country ?? "",
        strength: unit.strength ?? 100,
        status: unit.status ?? "active",
        lng: unit.lng,
        lat: unit.lat,
      };
      await gameState.writeWorldState({ ...current, units: [...asArray(current.units), next] });
      return next;
    },
  };

  const units = {
    sync: () => primeUnits(unitsController),
    list: () => unitsController.getUnits(),
    deploy: (spec) => observed("unit.deploy", () => unitsController.deployUnit(spec)),
    move: (id, lng, lat, region) => observed("unit.move", () => unitsController.moveUnitTo(id, lng, lat, region)),
    attack: (attackerId, targetId) => observed("unit.attack", () => unitsController.attackWith(attackerId, targetId)),
    attackRegion: (id, target) => observed("unit.attackRegion", () => unitsController.attackRegion(id, target)),
    disband: (id) => observed("unit.disband", () => unitsController.disbandUnit(id)),
    remove: (id) => observed("unit.remove", () => unitsController.removeUnit(id)),
  };

  return { game, world, units, inspect, session, catalogSize: inspect.catalogSize };
};
