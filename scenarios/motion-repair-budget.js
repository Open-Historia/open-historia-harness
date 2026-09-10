// How many world motion repair calls one long segmented skip makes, and on what.
//
// The field report: with segmented skips on, the log showed the same storylines
// repaired in every segment, and one turn spent 3h14m on it. This plays exactly
// that shape — one 365-day skip (four ~92-day segments) over a save seeded with
// eight stalled, high-pressure storylines — and counts every provider call by
// what it is, so two branches can be compared with --branch.
//
// OH_REPAIR_MODE
//   fail (default)  repair calls never reach the provider: each is answered
//                   locally, instantly, with a tool call the game's validator
//                   rejects. That is the report's case — a repair that fails the
//                   same way every time — and it costs no quota. The main
//                   simulation calls stay live.
//   live            repair calls go to the model like everything else.
// OH_SKIP_DAYS      default 365.
//
// Needs --ai live (the main simulation must answer for storylines to be judged at
// all), and a save: --fixture uk-empire-continuation-session. The storylines are
// written into the sandbox copy only.

export const meta = {
  name: "motion-repair-budget",
  description: "One long segmented skip over stalled storylines; counts world motion repair calls per segment.",
  requires: { ai: true },
};

const SEEDED = [
  ["storyline-russia-ukraine-border-crisis", "crisis", "Russia-Ukraine Border Crisis", ["Russia", "Ukraine", "United States"], 80, 40,
    "Russian forces massed on Ukraine's borders keep NATO and Kyiv on alert while talks stall."],
  ["storyline-taiwan-strait-tensions", "crisis", "Taiwan Strait Tensions", ["China", "Taiwan", "United States"], 70, 25,
    "Record PLA air incursions and US transits keep the strait in a tense military standoff."],
  ["storyline-korean-peninsula-crisis", "crisis", "Korean Peninsula Security Crisis", ["North Korea", "South Korea", "United States"], 65, 20,
    "North Korean missile testing and allied readiness sustain a dangerous confrontation."],
  ["storyline-iran-nuclear-standoff", "crisis", "Iran Nuclear Standoff", ["Iran", "Israel", "United States"], 68, 22,
    "Stalled Vienna talks and rising enrichment keep an Israeli strike and new sanctions in play."],
  ["storyline-ethiopia-tigray-conflict", "conflict", "Ethiopian Civil Conflict in Tigray", ["Ethiopia"], 75, 30,
    "Federal and Tigrayan forces remain locked in a war marked by blockade and famine warnings."],
  ["storyline-myanmar-post-coup-conflict", "conflict", "Myanmar Post-Coup Conflict", ["Myanmar"], 72, 28,
    "The junta faces spreading armed resistance and a collapsing economy after the coup."],
  ["storyline-armenia-azerbaijan-border", "crisis", "Armenia-Azerbaijan Border Friction", ["Armenia", "Azerbaijan"], 60, 20,
    "Deadly border clashes continue despite the 2020 ceasefire and Russian peacekeepers."],
  ["storyline-sahel-insurgency-mali", "conflict", "Sahel Insurgency in Mali", ["Mali", "France"], 62, 18,
    "Jihadist attacks spread while Mali's junta and France fall out over the counterterror mission."],
];

// No visible milestone since mid-September: past the 45-day anti-stasis
// backstop at every segment's stop date, and due for review straight away.
const seededStoryline = ([id, kind, title, participants, pressure, momentum, state]) => ({
  id,
  kind,
  title,
  participants,
  status: "active",
  pressure,
  momentum,
  startedDate: "2021-01-15",
  accountedThroughDate: "2021-11-01",
  lastUpdatedDate: "2021-11-01",
  lastVisibleEventDate: "2021-09-15",
  nextReviewDate: "2021-12-28",
  state,
  drivers: [],
  constraints: [],
  sourceEventIds: [],
  createdRound: 120,
  updatedRound: 134,
});

// A tool call the validator rejects (no stopDate, no storyline): the repair
// fails exactly as a bad model answer would, with no network and no wait.
const rejectedRepairAnswer = () =>
  new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ functionCall: { name: "submit_world_motion_repair", args: {} } }] } }],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

const classify = (bodyText) => {
  let body = null;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return { kind: "other", tool: "" };
  }
  const tool = body?.tools?.[0]?.functionDeclarations?.[0]?.name ?? "";
  const system = String(body?.system_instruction?.parts?.[0]?.text ?? "");
  const user = String(body?.contents?.[0]?.parts?.[0]?.text ?? "");
  if (system.includes("TARGETED ENDOGENOUS MOTION REPAIR")) {
    const storylineId = /persistent storyline: ([^\s.]+)\./.exec(system)?.[1] ?? "?";
    return { kind: "worldMotionRepair", tool, storylineId };
  }
  if (system.includes("NORMAL-MONTH WORLD COMPOSITION PASS")) return { kind: "worldBreadthRepair", tool };
  const segment = /This is segment (\d+) of (\d+)/.exec(user);
  if (segment) return { kind: "jumpSegment", tool, segment: Number(segment[1]), segmentCount: Number(segment[2]) };
  return { kind: tool || "untooled", tool };
};

export default async ({ game, world, expect, log, session }) => {
  const mode = (process.env.OH_REPAIR_MODE ?? "fail").toLowerCase();
  const days = Number(process.env.OH_SKIP_DAYS ?? 365);
  const { gameState, gameplay } = session.modules;

  // Segmented skips are opt-in (Settings -> AI); the report was about them.
  globalThis.localStorage.setItem("ai_chunk_long_jumps", "1");

  const current = await gameState.readWorldState({ force: true });
  await gameState.writeWorldState({ ...current, storylines: SEEDED.map(seededStoryline) });
  const seededBack = (await gameState.readWorldState({ force: true })).storylines ?? [];
  expect.that(seededBack.length === SEEDED.length, "the seeded storylines are in the sandbox world", {
    seeded: SEEDED.length,
    readBack: seededBack.length,
  });

  const before = await world.snapshot();
  log.info(`skip ${days} days from ${before.gameDate} (round ${before.round}), repair mode "${mode}", ${SEEDED.length} stalled storylines`);

  // Every provider call, labelled. Wrapped at the global the game's AI client
  // calls at request time, in front of the harness's own shim (which still
  // paces, budgets and records everything that goes on to the provider).
  const calls = [];
  let lastSegment = 0;
  const shim = globalThis.fetch;
  const labelled = async (input, init) => {
    const url = typeof input === "string" ? input : (input?.url ?? String(input));
    if (!/generativelanguage\.googleapis\.com/.test(url) || typeof init?.body !== "string") {
      return shim(input, init);
    }
    const info = classify(init.body);
    if (info.kind === "jumpSegment") lastSegment = info.segment;
    const entry = { ...info, afterSegment: lastSegment, startedAt: Date.now(), ms: 0, answered: "provider" };
    calls.push(entry);
    log.info(
      `call ${calls.length}: ${info.kind}` +
        `${info.segment ? ` ${info.segment}/${info.segmentCount}` : ""}` +
        `${info.storylineId ? ` ${info.storylineId} (after segment ${lastSegment})` : ""}`,
    );
    if (info.kind === "worldMotionRepair" && mode === "fail") {
      entry.answered = "local-reject";
      return rejectedRepairAnswer();
    }
    try {
      return await shim(input, init);
    } finally {
      entry.ms = Date.now() - entry.startedAt;
    }
  };
  globalThis.fetch = labelled;
  if (globalThis.window) globalThis.window.fetch = labelled;

  const startedAt = Date.now();
  let outcome;
  try {
    outcome = await game.turn(days);
    // A segment the model fumbled holds the turn; carry on from it, as a player would.
    for (let retry = 1; !outcome.ok && outcome.error?.segmentHeld && retry <= 3; retry += 1) {
      log.warn(`segment held (${outcome.error.message.slice(0, 160)}); retry ${retry}`);
      try {
        const result = await gameplay.retryPendingJumpSegment({});
        outcome = { ...outcome, ok: true, error: null, result, generation: result?.generation ?? null };
      } catch (error) {
        outcome = { ...outcome, ok: false, error };
      }
    }
  } finally {
    globalThis.fetch = shim;
    if (globalThis.window) globalThis.window.fetch = shim;
  }
  const totalMs = Date.now() - startedAt;

  if (!outcome.ok) log.warn(`the skip did not finish: ${outcome.error?.message ?? "unknown"}`);
  expect.that(outcome.ok, "the skip finishes", { error: outcome.error?.message ?? null });

  const repairs = calls.filter((call) => call.kind === "worldMotionRepair");
  const perStoryline = {};
  for (const call of repairs) perStoryline[call.storylineId] = (perStoryline[call.storylineId] ?? 0) + 1;
  const perSegment = {};
  for (const call of repairs) perSegment[call.afterSegment] = (perSegment[call.afterSegment] ?? 0) + 1;
  const byKind = {};
  for (const call of calls) {
    byKind[call.kind] ??= { calls: 0, ms: 0 };
    byKind[call.kind].calls += 1;
    byKind[call.kind].ms += call.ms;
  }

  const after = await gameState.readWorldState({ force: true });
  const endState = SEEDED.map(([id]) => {
    const storyline = (after.storylines ?? []).find((entry) => entry.id === id);
    return storyline
      ? `${id}: accounted ${storyline.accountedThroughDate}, p${storyline.pressure}/m${storyline.momentum}, next review ${storyline.nextReviewDate || "-"}`
      : `${id}: (missing)`;
  });

  const summary = {
    mode,
    days,
    finished: outcome.ok,
    generation: outcome.generation?.source ?? null,
    totalSeconds: Math.round(totalMs / 1000),
    aiCalls: calls.length,
    byKind,
    repairCalls: repairs.length,
    repairSeconds: Math.round(repairs.reduce((sum, call) => sum + call.ms, 0) / 1000),
    distinctStorylinesRepaired: Object.keys(perStoryline).length,
    repeatedStorylines: Object.fromEntries(Object.entries(perStoryline).filter(([, count]) => count > 1)),
    repairsAfterSegment: perSegment,
  };
  log.info(`REPAIR-SUMMARY ${JSON.stringify(summary)}`);
  for (const line of endState) log.info(`END ${line}`);
};
