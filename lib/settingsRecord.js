// The Settings record a Game export carries (settings.txt), and what a run
// should take from it.
//
// The game writes it for a person to read, never to be applied: importing a game
// changes nobody's settings (debugLog.js buildSettingsReport). So this reads the
// few lines that decide whether a bug reproduces — which provider, which model,
// reasoning on or off — and leaves the rest as a quote for the report.
//
// Provider names arrive as display labels ("Gemini", "OpenAI Compatible"). They
// are matched against the game's OWN provider table, handed in by the caller,
// so a provider the game adds later is recognised without a copy kept here.

const lineValue = (lines, label) => {
  const prefix = `${label}:`;
  const line = lines.find((entry) => entry.startsWith(prefix));
  return line === undefined ? null : line.slice(prefix.length).trim() || null;
};

/** The AI section's "Label: value" lines, trimmed; empty when there is none. */
const aiSection = (text) => {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === "AI:");
  if (start === -1) return [];
  const section = [];
  for (const line of lines.slice(start + 1)) {
    // Items are indented; the next unindented line is the next section.
    if (!/^\s/.test(line)) break;
    section.push(line.trim());
  }
  return section;
};

/**
 * Parse a Settings record. Null for an empty or absent one.
 *
 * `providers` is the game's PROVIDER_OPTIONS: [{ value, label }].
 */
export const readSettingsRecord = (text, { providers = [] } = {}) => {
  if (typeof text !== "string" || !text.trim()) return null;

  const ai = aiSection(text);
  const providerLabel = lineValue(ai, "Provider");
  const known = providers.find((entry) => entry.label === providerLabel);
  const reasoning = lineValue(ai, "Model reasoning");

  return {
    text,
    providerLabel,
    provider: known?.value ?? null,
    model: lineValue(ai, "Model"),
    reasoning: reasoning === "on" ? true : reasoning === "off" ? false : null,
  };
};

/**
 * Decide what a run takes from the record.
 *
 * Only with live (or replayed) AI does any of it matter. The provider is never
 * switched — the harness's key belongs to the provider it was given — so the
 * player's model and reasoning are used only when the providers already match
 * and no model was given on the command line. Anything else is said out loud,
 * because a bug that does not reproduce on a different model is not evidence.
 */
export const planAiSettings = ({ record, ai = "off", provider = "gemini", model = "" } = {}) => {
  const plan = { provider, model, reasoning: null, fromRecord: false, notes: [], warnings: [] };
  if (!record || ai === "off") return plan;

  const playersProvider = record.providerLabel ?? "an unrecorded provider";
  if (record.provider !== provider) {
    plan.warnings.push(
      `The player used ${playersProvider}${record.model ? ` (${record.model})` : ""}; this run used ${provider}. ` +
        "A bug that does not reproduce may only need their model.",
    );
    return plan;
  }

  if (model) {
    if (record.model && record.model !== model) {
      plan.notes.push(`--model ${model} was used instead of the player's ${record.model}.`);
    }
    return plan;
  }

  if (!record.model) return plan;
  plan.model = record.model;
  plan.reasoning = record.reasoning;
  plan.fromRecord = true;
  const reasoning = record.reasoning === null ? "" : `, reasoning ${record.reasoning ? "on" : "off"}`;
  plan.notes.push(`Played with the player's settings from their Settings record: ${record.model}${reasoning}.`);
  return plan;
};
