// Export a played Game through the game's own zip, open it again, and import it
// back — the whole path a player takes with Export and Import game.
//
// A turn is played first so the zip carries a Roll-back point. The sandbox Game
// sits on the Stand-in scenario, which the game's export counts as a custom map,
// so the zip carries that too: one run covers the bundle, the Roll-back points
// and the embedded Scenario.
//
// The zip is kept at game-exports/harness/round-trip.zip, replacing the last
// one, so a known-good export is always there to open with --save-zip.
//
// This is what catches the export/import feature breaking later. No AI needed.

import fs from "node:fs";
import path from "node:path";

import { checkImport, harnessExportsDir, loadGameZip, placeExport, readLibraryCatalog } from "../lib/gameExport.js";

export const meta = {
  name: "export-round-trip",
  description: "A played Game exported as a zip by the game's own code, reopened and imported back: nothing lost, a new Game, the active Game untouched.",
  requires: { ai: false },
  aiCallBudget: 0,
};

export default async ({ game, expect, log, session }) => {
  const turn = log.turn(await game.turn(30));
  expect.that(turn.ok, "a turn plays before the export, so there is a Roll-back point to carry", {
    error: turn.error?.message,
  });

  const before = await readLibraryCatalog(session);
  const exportedId = before.activeGameId;
  const { buildGameZipBlob, readGameZip } = await loadGameZip(session);

  const built = await buildGameZipBlob(exportedId);
  const bytes = Buffer.from(await built.blob.arrayBuffer());
  const file = path.join(harnessExportsDir(), "round-trip.zip");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  log.info(`exported ${exportedId} to ${file} (${bytes.length} bytes${built.carriesScenario ? ", carrying its Scenario" : ""})`);

  const opened = await readGameZip(bytes);
  expect.that(Boolean(opened.snapshotsText), "the zip carries the Game's Roll-back points");
  expect.that(Boolean(opened.scenarioBundle), "the zip carries the Game's Scenario");

  const placed = await placeExport(session, opened);
  const check = await checkImport(session, { gameId: placed.gameId, sent: placed.sent, snapshotsText: opened.snapshotsText });
  for (const mismatch of check.mismatches) log.warn(mismatch.summary);

  expect.that(check.ok, "every part of the Game's data came back as it was exported", { mismatches: check.mismatches });
  expect.that(check.rollbackPoints.zip > 0, "the Roll-back points survived the trip", check.rollbackPoints);
  expect.that(placed.gameId !== exportedId, "the import is a new Game, not the exported one overwritten", {
    exported: exportedId,
    imported: placed.gameId,
  });
  expect.equal(placed.map.kind, "embedded", "the Game plays on the Scenario the zip carried");

  const afterCatalog = await readLibraryCatalog(session);
  expect.equal(afterCatalog.activeGameId, exportedId, "importing did not change the active Game");
};
