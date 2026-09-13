# Open Game exports through the game's own code

A Game export is opened with the game's own `readGameZip` (`src/runtime/gameZip.js`), inside a booted session, and imported through the game server's real routes in the same order as the Games tab (`libraryBar.jsx`): Scenario first, then the Game with its scenario id rewritten, then the Roll-back points as raw text. The harness never unzips the file itself or rebuilds a Game folder from the Game bundle. A second copy of that mapping would drift from the real one, and then the harness would be testing an import no player ever gets. As a bonus, every zip run doubles as a regression test of the player-facing import.

## Considered Options

- **Unzip in the harness** (with the game's JSZip, or a small reader built on `node:zlib`) and write the Game folder into the sandbox before boot. Faster to reach and easy to unit-test, but it is the second implementation this decision exists to avoid.
- **Call `importGameBundle` in a child process** with `OH_DATA_DIR` set, as the game's own tests do. Not needed: the zip is opened after the server is up, so the real routes are always available.

## Consequences

- A zip can only be opened once the engine has loaded, so opening one is part of session boot, not of sandbox seeding.
- **The one exception is hub maps.** `downloadHubBundle` lives in `communityHub.jsx`, which the loader refuses because it compiles no JSX. The harness repeats its short sequence of calls to the game's own `.js` parts, and before each hub download it checks the target's source to confirm `downloadHubBundle` still makes the same calls. If it doesn't, the report warns that the harness's copy may be out of date.
- A target that predates Game exports cannot be used with `--save-zip`, and the harness says so (exit 5) rather than falling back to its own importer.
