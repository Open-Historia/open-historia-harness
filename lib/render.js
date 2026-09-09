// Turning snapshots and diffs into text I can read at a glance.
//
// Everything here is plain strings — no colour, no cursor tricks — so the same
// output works in a terminal, in a report file, and in a transcript.

const pad = (label, width = 15) => String(label).padEnd(width);
const num = (value) => (value === null || value === undefined ? "?" : String(value));

const topBy = (record, count = 3) =>
  Object.entries(record ?? {})
    .sort((a, b) => (b[1]?.length ?? b[1]) - (a[1]?.length ?? a[1]))
    .slice(0, count);

/** One screenful: what the game looks like right now. */
export const renderSnapshot = (snap, { title = "" } = {}) => {
  const lines = [];
  lines.push(`=== ${title || "HARNESS"} · turn ${num(snap.round)} · ${num(snap.gameDate)} ===`);
  lines.push(`${pad("playing")}${num(snap.country)} (${num(snap.difficulty)})`);

  const biggest = topBy(snap.ownershipByPolity)
    .map(([polity, regions]) => `${polity} ${regions.length}`)
    .join("  ");
  lines.push(`${pad("regions")}${snap.counts.regions} across ${snap.counts.polities} polities  ·  ${biggest}`);

  const byOwner = {};
  for (const unit of snap.units) {
    byOwner[unit.owner] ??= { count: 0, strength: 0 };
    byOwner[unit.owner].count += 1;
    byOwner[unit.owner].strength += Number(unit.strength) || 0;
  }
  const unitSummary = Object.entries(byOwner)
    .map(([owner, s]) => `${owner} ${s.count} (str ${s.strength})`)
    .join("  ");
  lines.push(`${pad("units")}${snap.counts.units}${unitSummary ? `   ${unitSummary}` : ""}`);

  lines.push(`${pad("events")}${snap.counts.events} total`);
  const planned = snap.actions.filter((a) => a.status === "planned").length;
  const orders = snap.actions.filter((a) => a.source === "order").length;
  lines.push(`${pad("actions")}${planned} planned / ${snap.counts.actions - planned} resolved / ${orders} queued orders`);
  lines.push(`${pad("chats")}${snap.counts.chats} open`);
  if (snap.activeCatalyst) lines.push(`${pad("catalyst")}${snap.activeCatalyst.title ?? "active"}`);

  return lines.join("\n");
};

/** What changed this turn. The reconciliation block is deliberately loud. */
export const renderDiff = (diff, { header = "" } = {}) => {
  const lines = [];
  const round = diff.game.round ? `TURN ${diff.game.round[0]} -> ${diff.game.round[1]}` : "TURN";
  const date = diff.game.gameDate ? `   ${diff.game.gameDate[0]} -> ${diff.game.gameDate[1]}` : "";
  lines.push(`--- ${round}${date}${header ? `   ${header}` : ""} ---`);

  const r = diff.regions;
  if (r.transferred.length || r.added.length || r.removed.length) {
    lines.push(`REGIONS   ${r.transferred.length} transferred`);
    for (const pair of r.byPair) {
      lines.push(`  ${pair.from} -> ${pair.to}   ${pair.count}   ${pair.regions.slice(0, 6).join(", ")}`);
    }
  } else {
    lines.push("REGIONS   no ownership change");
  }

  const u = diff.units;
  if (u.spawned.length || u.removed.length || u.moved.length || u.strength.length) {
    lines.push(`UNITS     +${u.spawned.length}  -${u.removed.length}   ${u.moved.length} moved`);
    for (const unit of u.spawned) {
      lines.push(`  + ${unit.name ?? unit.id}   ${unit.owner}  ${unit.type ?? ""}  str ${num(unit.strength)}  @ ${num(unit.at[1])}, ${num(unit.at[0])}`);
    }
    for (const unit of u.moved) {
      lines.push(`  ~ ${unit.name ?? unit.id}   ${unit.owner}  ${num(unit.from[1])},${num(unit.from[0])} -> ${num(unit.to[1])},${num(unit.to[0])}  (${num(unit.km)} km)`);
    }
    for (const unit of u.removed) {
      lines.push(`  - ${unit.name ?? unit.id}   ${unit.owner}  lost`);
    }
  }

  if (diff.polities.reputation.length) {
    const rep = diff.polities.reputation
      .map((entry) => `${entry.polity} ${num(entry.from)} -> ${num(entry.to)} (${entry.delta > 0 ? "+" : ""}${entry.delta})`)
      .join("   ");
    lines.push(`POLITIES  reputation  ${rep}`);
  }

  if (diff.events.count) {
    const notable = diff.events.added.filter((e) => e.notable).length;
    const player = diff.events.added.filter((e) => e.playerRelated).length;
    lines.push(`EVENTS    +${diff.events.count}  (${notable} notable, ${player} player-related)`);
    for (const event of diff.events.added.slice(0, 8)) {
      const impacts = Object.entries(event.impactCounts)
        .filter(([, count]) => count > 0)
        .map(([kind, count]) => `${count} ${kind}`)
        .join(", ");
      lines.push(`  ${num(event.date)}  ${event.title ?? "(untitled)"}${impacts ? `   [${impacts}]` : ""}`);
    }
  }

  for (const chat of diff.chats.opened) {
    lines.push(`CHATS     opened — ${chat.participants.join(", ")}: ${String(chat.firstLine ?? "").slice(0, 60)}`);
  }

  lines.push(...renderReconciliation(diff.reconciliation));
  return lines.join("\n");
};

/**
 * The block worth reading first.
 *
 * Silent when everything the AI claimed actually happened; loud when it did not,
 * because that gap is the whole reason this harness exists.
 */
export const renderReconciliation = (rec) => {
  if (!rec) return [];
  const lines = [];
  const t = rec.transfers;

  const clean =
    t.unapplied.length === 0 && t.unexplained.length === 0 && (rec.unitOps.shortfalls?.length ?? 0) === 0;

  if (clean) {
    if (t.claimed > 0) lines.push(`RECONCILED  map-truth 1.00  (${t.applied}/${t.claimed} claimed transfers applied)`);
    return lines;
  }

  lines.push(
    `!! RECONCILIATION  map-truth ${rec.mapTruthScore === null ? "n/a" : rec.mapTruthScore.toFixed(2)}` +
      `  (${t.applied}/${t.claimed} claimed transfers applied)`,
  );
  for (const miss of t.unapplied.slice(0, 8)) {
    const where = miss.regionId;
    lines.push(`   ${miss.eventId ?? "?"} "${miss.eventTitle ?? ""}" claimed ${where} -> ${miss.to} : ${miss.why}`);
  }
  for (const stray of t.unexplained.slice(0, 8)) {
    lines.push(`   ${stray.name ?? stray.id}: ${stray.from} -> ${stray.to} : ${stray.why}`);
  }
  for (const shortfall of rec.unitOps.shortfalls ?? []) {
    lines.push(`   unitOps ${shortfall.kind}: ${shortfall.why}`);
  }
  return lines;
};

/** The single machine-readable line a run always ends with. */
export const renderSummaryLine = (summary) =>
  [
    "HARNESS",
    `target=${summary.target}`,
    `scenarios=${summary.scenarios}`,
    `pass=${summary.pass}`,
    `fail=${summary.fail}`,
    `assertions=${summary.assertionsPassed}/${summary.assertionsTotal}`,
    `aiCalls=${summary.aiCalls}`,
    `fallbacks=${summary.fallbacks}`,
    summary.mapTruth === null || summary.mapTruth === undefined ? "mapTruth=n/a" : `mapTruth=${summary.mapTruth.toFixed(2)}`,
    `ms=${summary.ms}`,
    summary.report ? `report=${summary.report}` : null,
  ]
    .filter(Boolean)
    .join(" ");
