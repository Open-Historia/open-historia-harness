# Open Historia harness

A headless harness that plays Open Historia for real against a throwaway copy of its data, and reports what went wrong. The game is a separate repo the harness reads but never changes.

## Saves

**Game**:
One campaign as the game stores it: its world, events, chat, advisor, prompts and flags, played on one Scenario.
_Avoid_: campaign, session

**Save**:
A Game a run can be opened on. There are two kinds, a Real save and a Game export.
_Avoid_: fixture (the code's older name for it)

**Real save**:
A Game folder in the main checkout's data directory. Always read-only to the harness.
_Avoid_: local save, game folder

**Game export**:
One Game packed as a single `.zip` by the game's Export or Attach game, usually sent in by a player with a bug report.
_Avoid_: game zip, save zip, bundle

**Game bundle**:
The `game.json` inside a Game export: the Game's data plus a pointer to its Scenario. Not the same file as a Game folder's `game.json`.
_Avoid_: bundle (unqualified)

**Roll-back point**:
A copy of a Game's state the game captures each turn so the turn can be undone. Travels in a Game export as `snapshots.json`.
_Avoid_: snapshot, restore point

**Settings record**:
The `settings.txt` inside a Game export: the player's redacted settings (provider, model, AI toggles) at the moment of export. A record of what they played with, not settings to apply wholesale.
_Avoid_: settings file, config

## Maps

**Scenario**:
The map and starting state a Game is played on.
_Avoid_: map (in names and reports)

**Built-in scenario**:
A Scenario every install of the game ships with.

**Hub scenario**:
A Scenario published on the community hub, which a Game export points to rather than carrying.

**Stand-in scenario**:
The harness's own lightweight Scenario, which a Save is moved onto when its real Scenario is not available in the sandbox.
_Avoid_: sandbox scenario, harness scenario

## Runs

**Sandbox**:
The throwaway data directory a run plays in. Everything a run writes lands here.

**Snapshot**:
The harness's plain-data picture of the world at one moment (`world.snapshot()`), used to diff and check it. Never the game's Roll-back points.

**Finding**:
An invalid world state the harness detected, as opposed to an error the engine threw.

**Pre-existing finding**:
A Finding already present in the Save before the run touched it. Reported apart so nobody blames the run for it.
_Avoid_: old bug, save corruption

**Import finding**:
A difference between a Game export and the Game the importer actually produced from it. Blamed on the game's importer, never on the Save.
