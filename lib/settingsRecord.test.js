// Reading the Settings record a Game export carries, and deciding what of it a
// run should use.

import assert from "node:assert/strict";
import test from "node:test";

import { planAiSettings, readSettingsRecord } from "./settingsRecord.js";

// The game's own provider table has this shape (providerConfig.js PROVIDER_OPTIONS);
// the harness is handed it at run time rather than keeping a copy.
const PROVIDERS = [
  { value: "gemini", label: "Gemini" },
  { value: "openai", label: "OpenAI" },
  { value: "anthropic", label: "Anthropic" },
  { value: "openai-compatible", label: "OpenAI Compatible" },
];

// A real record, as the game writes it.
const GEMINI_RECORD = `-- Settings when this file was saved --
Display:
  UI language: English
  Reduce motion: off
AI:
  Provider: Gemini
  Model: gemini-3.5-flash-lite
  API key: not set
  Custom parameters: none
  Structured output: auto
  Per-task models: none — every task uses the model above
  Model reasoning: on
  Limit AI generation: off
This save:
  Beta unit system: off
`;

const withAi = (lines) => `-- Settings when this file was saved --\nAI:\n${lines.map((l) => `  ${l}`).join("\n")}\n`;

test("reads the provider, model and reasoning from a Settings record", () => {
  const record = readSettingsRecord(GEMINI_RECORD, { providers: PROVIDERS });
  assert.equal(record.provider, "gemini");
  assert.equal(record.providerLabel, "Gemini");
  assert.equal(record.model, "gemini-3.5-flash-lite");
  assert.equal(record.reasoning, true);
  assert.equal(record.text, GEMINI_RECORD);
});

test("a provider the harness has never heard of keeps its label and has no id", () => {
  const record = readSettingsRecord(withAi(["Provider: Mistral Direct", "Model: large-2"]), { providers: PROVIDERS });
  assert.equal(record.provider, null);
  assert.equal(record.providerLabel, "Mistral Direct");
  assert.equal(record.model, "large-2");
  assert.equal(record.reasoning, null);
});

test("a record with no AI section says nothing about the model", () => {
  const record = readSettingsRecord("-- Settings when this file was saved --\nDisplay:\n  UI language: English\n", {
    providers: PROVIDERS,
  });
  assert.equal(record.provider, null);
  assert.equal(record.model, null);
  assert.equal(record.reasoning, null);
});

test("an empty or missing record reads as none", () => {
  assert.equal(readSettingsRecord("", { providers: PROVIDERS }), null);
  assert.equal(readSettingsRecord(null, { providers: PROVIDERS }), null);
});

test("with AI off, nothing from the record is applied", () => {
  const record = readSettingsRecord(GEMINI_RECORD, { providers: PROVIDERS });
  const plan = planAiSettings({ record, ai: "off", provider: "gemini", model: "" });
  assert.equal(plan.fromRecord, false);
  assert.equal(plan.model, "");
  assert.equal(plan.reasoning, null);
  assert.deepEqual(plan.warnings, []);
});

test("live AI on the player's provider plays their model and reasoning, and says so", () => {
  const record = readSettingsRecord(GEMINI_RECORD, { providers: PROVIDERS });
  const plan = planAiSettings({ record, ai: "live", provider: "gemini", model: "" });
  assert.equal(plan.fromRecord, true);
  assert.equal(plan.model, "gemini-3.5-flash-lite");
  assert.equal(plan.reasoning, true);
  assert.match(plan.notes.join("\n"), /gemini-3\.5-flash-lite/);
  assert.match(plan.notes.join("\n"), /reasoning on/);
  assert.deepEqual(plan.warnings, []);
});

test("a model given on the command line wins over the record", () => {
  const record = readSettingsRecord(GEMINI_RECORD, { providers: PROVIDERS });
  const plan = planAiSettings({ record, ai: "live", provider: "gemini", model: "gemini-3.5-pro" });
  assert.equal(plan.fromRecord, false);
  assert.equal(plan.model, "gemini-3.5-pro");
  assert.equal(plan.reasoning, null);
  assert.match(plan.notes.join("\n"), /gemini-3\.5-flash-lite/, "still says what the player used");
});

test("a different provider is a warning, and the player's model is not used", () => {
  const record = readSettingsRecord(withAi(["Provider: OpenAI", "Model: gpt-5-mini", "Model reasoning: off"]), {
    providers: PROVIDERS,
  });
  const plan = planAiSettings({ record, ai: "live", provider: "gemini", model: "" });
  assert.equal(plan.fromRecord, false);
  assert.equal(plan.model, "");
  assert.equal(plan.reasoning, null);
  assert.match(plan.warnings.join("\n"), /OpenAI/);
  assert.match(plan.warnings.join("\n"), /gemini/);
});

test("a provider the harness cannot run is a warning too", () => {
  const record = readSettingsRecord(withAi(["Provider: Mistral Direct", "Model: large-2"]), { providers: PROVIDERS });
  const plan = planAiSettings({ record, ai: "live", provider: "gemini", model: "" });
  assert.equal(plan.fromRecord, false);
  assert.match(plan.warnings.join("\n"), /Mistral Direct/);
});
