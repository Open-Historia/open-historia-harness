# Game exports

Put a player's exported Game here: the `.zip` they made with **Export** in the Games tab, or
attached to a bug report from **Settings → Diagnostics**. Everything in this folder except this
file is gitignored, so a player's campaign never reaches the repo.

Once a zip is here, use it by name, without the folder or `.zip`:

```
node cli.js --hunt --level 1 --save-zip my-campaign-game --branch upstream/beta
node cli.js rollback --save-zip my-campaign-game --branch upstream/beta
node cli.js --check-exports --branch upstream/beta
```

`--levels` lists what is here. `--check-exports` opens every zip in the folder without playing
any turns, which is a quick way to see that they all still open after a game update.

The harness only ever reads the zips you put here. The one place it writes is `harness/`, where
the `export-round-trip` scenario keeps the zip it makes (`--save-zip harness/round-trip`).

`--branch upstream/beta` is there because Game exports are only on that branch for now. Leave it
off once your checkout has them.
