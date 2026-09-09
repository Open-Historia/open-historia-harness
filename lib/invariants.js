// What counts as a bug.
//
// These are the things that must be true of the world no matter what was done to
// it. A scenario can do something absurd on purpose; the engine is still not
// allowed to end up in these states.
//
// Several of these are drawn from failures that have actually happened in this
// game rather than from imagination — most notably `polity-name-is-prose`, which
// catches the real `"Rome In a brief proclamation issued from London"` sitting in
// a live save right now: narrative text leaked into an owner name, minting a
// phantom country that paints and labels itself beside the real one.

const asArray = (value) => (Array.isArray(value) ? value : []);
const asObject = (value) => (value && typeof value === "object" ? value : {});

/** A finding. `severity` decides whether a run fails or merely reports. */
const finding = (id, severity, summary, detail = null) => ({ id, severity, summary, detail });

const isFiniteNumber = (value) => typeof value === "number" && Number.isFinite(value);

/**
 * Owner names must be full country names.
 *
 * A three-letter code written into regionOwnershipOverrides mints a phantom
 * country beside the real one — the failure the [Polity Names] prompt directive
 * exists to prevent, and which normalizeRegionTransfer canonicalises against.
 */
const CODE_LIKE = /^[A-Z]{2,3}$/;

/**
 * Prose that has leaked into a name.
 *
 * The naive version of this — flag commas, or long names — cried wolf immediately:
 * "Virgin Islands, U.S.", "Bonaire, Sint Eustatius and Saba" and "Saint Helena,
 * Ascension and Tris" are all real country names in the shipped seed, and a bug
 * hunter with false positives is worse than useless.
 *
 * The actual discriminator is CAPITALISATION. Real place names capitalise every
 * content word and use only a small set of lowercase connectives. Prose does not:
 *
 *   "Bonaire, Sint Eustatius and Saba"              -> 0 stray lowercase words
 *   "Democratic Republic of the Congo"              -> 0 (of, the are connectives)
 *   "Rome In a brief proclamation issued from London" -> 5 (a, brief, proclamation,
 *                                                          issued, from)
 */
const NAME_CONNECTIVES = new Set([
  "and", "of", "the", "da", "das", "de", "del", "der", "di", "do", "dos", "du",
  "el", "la", "las", "les", "los", "van", "von", "y", "e", "al", "bin", "ibn",
  "sur", "sous", "upon", "on", "in", "at",
]);

const strayLowercaseWords = (name) =>
  String(name)
    .split(/[\s,]+/)
    .filter(Boolean)
    // A word that starts lowercase and is not a recognised connective. Numbers and
    // single letters (U.S.) are ignored.
    .filter((word) => /^[a-z]/.test(word) && !NAME_CONNECTIVES.has(word.toLowerCase()) && word.length > 1);

const looksLikeProse = (name) => {
  if (typeof name !== "string") return false;
  // The longest legitimate name in the shipped data is 36 characters
  // ("United States Minor Outlying Islands"), so this is comfortably clear of it.
  if (name.length > 64) return true;
  return strayLowercaseWords(name).length >= 3;
};

export const checkWorld = (world, { previous = null, context = "" } = {}) => {
  const findings = [];
  const w = asObject(world);
  const owners = asObject(w.regionOwnershipOverrides);
  const units = asArray(w.units);

  // --- ownership -----------------------------------------------------------
  const ownerNames = new Set(Object.values(owners).filter(Boolean));

  for (const owner of ownerNames) {
    if (CODE_LIKE.test(owner)) {
      findings.push(
        finding("owner-is-a-code", "high", `Region owner "${owner}" is a country code, not a name`, {
          owner,
          regions: Object.entries(owners).filter(([, o]) => o === owner).slice(0, 5).map(([id]) => id),
          why: "a code here mints a phantom country beside the real one, with its own colour and label",
        }),
      );
    }
    if (looksLikeProse(owner)) {
      findings.push(
        finding("polity-name-is-prose", "high", `Polity name looks like narrative text: "${owner}"`, {
          owner,
          length: owner.length,
          regions: Object.entries(owners).filter(([, o]) => o === owner).slice(0, 5).map(([id]) => id),
          why: "narrative text leaked into an owner name; this has happened in a real save",
        }),
      );
    }
    if (typeof owner === "string" && owner.trim() !== owner) {
      findings.push(finding("owner-has-whitespace", "medium", `Owner name has stray whitespace: ${JSON.stringify(owner)}`, { owner }));
    }
  }

  for (const [regionId, owner] of Object.entries(owners)) {
    if (owner === "" || owner === null) {
      findings.push(finding("owner-is-empty", "medium", `Region ${regionId} has an empty owner`, { regionId }));
    }
  }

  // Regions must not silently disappear. Losing ownership entries wholesale is
  // the difference between "a country was conquered" and "the map broke".
  if (previous) {
    const before = Object.keys(asObject(previous.regionOwnershipOverrides)).length;
    const after = Object.keys(owners).length;
    if (after < before * 0.95) {
      findings.push(
        finding("regions-vanished", "critical", `Region count fell from ${before} to ${after}`, {
          before,
          after,
          lost: before - after,
        }),
      );
    }
  }

  // --- units ---------------------------------------------------------------
  const seenUnitIds = new Set();
  for (const unit of units) {
    const id = unit?.id ?? "(no id)";
    if (seenUnitIds.has(id)) {
      findings.push(finding("duplicate-unit-id", "high", `Two units share the id ${id}`, { id }));
    }
    seenUnitIds.add(id);

    if (!isFiniteNumber(unit?.lng) || !isFiniteNumber(unit?.lat)) {
      findings.push(
        finding("unit-bad-coordinates", "high", `Unit ${id} has non-finite coordinates`, {
          id,
          lng: unit?.lng,
          lat: unit?.lat,
        }),
      );
    } else {
      if (Math.abs(unit.lat) > 90 || Math.abs(unit.lng) > 180) {
        findings.push(
          finding("unit-off-earth", "high", `Unit ${id} is outside valid coordinates`, {
            id,
            lng: unit.lng,
            lat: unit.lat,
          }),
        );
      }
      if (Math.abs(unit.lng) < 0.01 && Math.abs(unit.lat) < 0.01) {
        findings.push(
          finding("unit-at-null-island", "medium", `Unit ${id} is at 0,0`, {
            id,
            why: "the classic 'coordinates were never really set' failure",
          }),
        );
      }
    }

    if (unit?.strength !== undefined && !isFiniteNumber(unit.strength)) {
      findings.push(finding("unit-bad-strength", "high", `Unit ${id} has non-finite strength`, { id, strength: unit.strength }));
    }
    if (isFiniteNumber(unit?.strength) && unit.strength < 0) {
      findings.push(finding("unit-negative-strength", "medium", `Unit ${id} has negative strength`, { id, strength: unit.strength }));
    }

    const owner = unit?.ownerCode ?? unit?.owner;
    if (owner && CODE_LIKE.test(owner)) {
      findings.push(finding("unit-owner-is-a-code", "medium", `Unit ${id} is owned by a code, "${owner}"`, { id, owner }));
    }
    if (owner && looksLikeProse(owner)) {
      findings.push(finding("unit-owner-is-prose", "high", `Unit ${id} owner looks like narrative text`, { id, owner }));
    }
  }

  // --- numeric hygiene across the world ------------------------------------
  for (const [polity, value] of Object.entries(asObject(w.internationalReputation))) {
    if (!isFiniteNumber(value)) {
      findings.push(finding("reputation-not-a-number", "medium", `Reputation for ${polity} is not a finite number`, { polity, value }));
    }
  }

  return findings.map((entry) => ({ ...entry, context }));
};

export const checkGame = (game, { previous = null, context = "", allowRewind = false } = {}) => {
  const findings = [];
  const g = asObject(game);

  if (g.round !== undefined && (!isFiniteNumber(g.round) || g.round < 1)) {
    findings.push(finding("round-invalid", "critical", `Round is ${JSON.stringify(g.round)}`, { round: g.round }));
  }

  if (g.gameDate && !/^\d{4}-\d{2}-\d{2}$/.test(String(g.gameDate))) {
    findings.push(finding("date-malformed", "critical", `Game date is not an ISO date: ${JSON.stringify(g.gameDate)}`, { gameDate: g.gameDate }));
  }

  if (previous && !allowRewind) {
    const before = asObject(previous);
    if (isFiniteNumber(before.round) && isFiniteNumber(g.round) && g.round < before.round) {
      findings.push(
        finding("round-went-backwards", "critical", `Round went from ${before.round} to ${g.round}`, {
          from: before.round,
          to: g.round,
        }),
      );
    }
    if (before.gameDate && g.gameDate && String(g.gameDate) < String(before.gameDate)) {
      findings.push(
        finding("date-went-backwards", "critical", `Date went from ${before.gameDate} to ${g.gameDate}`, {
          from: before.gameDate,
          to: g.gameDate,
        }),
      );
    }
  }

  return findings.map((entry) => ({ ...entry, context }));
};

/** Events must be dated and identifiable, or the log becomes unusable. */
export const checkEvents = (events, { context = "" } = {}) => {
  const findings = [];
  const seen = new Set();
  for (const event of asArray(events)) {
    if (event?.id) {
      if (seen.has(event.id)) {
        findings.push(finding("duplicate-event-id", "medium", `Two events share the id ${event.id}`, { id: event.id }));
      }
      seen.add(event.id);
    }
    if (event?.date && !/^\d{4}-\d{2}-\d{2}$/.test(String(event.date))) {
      findings.push(finding("event-date-malformed", "medium", `Event ${event.id ?? "?"} has a malformed date`, { id: event.id, date: event.date }));
    }
  }
  return findings.map((entry) => ({ ...entry, context }));
};

/** Everything, over a full state bundle. */
export const checkAll = (bundle, { previous = null, context = "", allowRewind = false } = {}) => [
  ...checkWorld(bundle?.world, { previous: previous?.world ?? null, context }),
  ...checkGame(bundle?.game, { previous: previous?.game ?? null, context, allowRewind }),
  ...checkEvents(bundle?.events, { context }),
];

export const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };

export const sortFindings = (findings) =>
  [...findings].sort(
    (a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9),
  );
