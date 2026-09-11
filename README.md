# open-historia-harness

A headless test harness for [Open Historia](https://github.com/Open-Historia/open-historia). It
plays the game for real — turns, units, game-master commands, espionage, rollback — and reports what
changed as structured text, so a change can be verified without launching Electron and reading
screenshots.

It lives in its own repo on purpose. It is never committed into a game branch and cannot reach
upstream by accident.

```
Documents/GitHub/
  open-historia/            the game. NEVER modified by the harness.
  open-historia-harness/    this.
```

## Quick start

```
node cli.js --list
node cli.js smoke units
node cli.js smoke --branch upstream/main
node cli.js smoke --compare main,upstream/custom-stats
```

No API key is needed for any of that. Without one the engine uses its own deterministic fallback
turn, which exercises the whole game except the model itself.

## Hunting for bugs

```
node cli.js --levels                       what each level does, which saves exist
node cli.js --hunt --level 2               play like an impatient player
node cli.js --hunt --level 2 --saves all   fresh scenario plus every real save
node cli.js --hunt --level 4 --saves modern-day-session --seed 777
```

Level 1 plays like a normal player; level 5 actively tries to break things. The
ladder exists so severity means something: **a bug found at level 1 is urgent
because a real player will hit it**, while one found at level 5 may be worth
nothing.

After every single action the world is checked against a set of invariants — no
owner is a country code, no unit is at null island or off the earth, regions do
not vanish, the clock does not run backwards, names are not narrative text. A
finding is an invalid *state*, not a thrown error: levels 4 and 5 deliberately
feed the engine nonsense, and rejecting nonsense is correct behaviour.

`BUG-REPORT.md` is **rewritten in full after every finding**, so it is valid at
every instant. If the agent driving it times out, the report on disk still
describes everything found up to that moment.

It separates problems the run *caused* from ones **already in the save** — telling
someone their code broke something that was already broken sends them hunting
through the wrong file.

If an AI agent is driving this, point it at [AGENTS.md](AGENTS.md).

## The three things it is for

**Seeing the game as data.** `world.snapshot()` returns ownership, units, events, polities and
chats as plain objects. `inspect.who("Bayern")` answers who owns a region. `diff(before, after)`
says what a turn changed.

**Playing it hard.** Ten turns in a loop, a game-master command, a unit deployed and moved, a
rollback — all as ordinary function calls with structured returns.

**Telling whether the AI did its job.** See [Reconciliation](#reconciliation) below.

## Safety

A test server pointed at the real data directory destroyed a player's rollback snapshots on this
machine once. That is why there are four layers, not one:

1. **`assertSandboxed`** — every write must resolve inside the sandbox and outside every protected
   tree. Containment uses `path.relative`, not `startsWith`, so a sibling directory named
   `<root>-evil` is refused; paths are lowercased on Windows so a case variant cannot read as
   "outside".
2. **A second assertion after boot** — `DATA_DIR` is read back out of the game's own resolver, which
   closes the gap where `OH_DATA_DIR` was set too late or clobbered in between.
3. **An `fs` write interceptor** — wraps the write half of `fs` and `fs.promises`. Guarded by
   argument position, because what a call destroys is not always its destination: `rename` is
   guarded on both sides since it removes its source, and `link`/`symlink` on both since an alias
   into real data turns a later innocent write into an in-place truncation.
4. **A fingerprint test** — `safety.realdata.test.js` runs a full session and asserts
   `server/data` is byte-identical afterwards. This is the one to point at if the fear ever
   returns.

**The honest limit of layer 3:** a module doing `import { writeFileSync } from "fs"` binds the
function at link time and never sees the wrapper. `libraryStore.js` uses namespace access, so the
patch bites there. Layer 1 is the guarantee; layer 3 catches mistakes, not adversaries.

## Testing any branch

`--branch <ref>` creates a throwaway `git worktree` under the sandbox, keyed by commit sha so a
repeat run on an unchanged branch reuses it (~500 ms cold, ~45 ms warm). `node_modules` (790 MB) is
an NTFS junction, and `public/assets` (223 MB) is shared read-only via `OH_ASSETS_DIR` — neither is
ever copied.

Sharing modules across branches is a lie when the branch wants different versions, so the lockfiles
are compared and a mismatch is reported as a loud warning. It fires for real: `upstream/main` and
`wiki` currently have different `package-lock.json` files. When that happens, the run is still
using the main checkout's dependency tree — if a result looks strange, run `npm ci` inside the
worktree by hand before trusting it.

## No game source is modified

Four things stop plain Node importing the turn engine, and the harness fixes all four **in memory**
with a loader hook, so a pristine `upstream/main` runs unchanged:

| Blocker | Fix |
|---|---|
| `gameplay.js` imports `./main.jsx`, which contains no JSX but Node rejects on extension | force `format: "module"` |
| `promptContext.js` reads `import.meta.env` at module scope and throws on load | rewrite to a real global |
| `gameplayPrompts.js` imports JSON with no `with { type: "json" }` | attach the attribute |
| `regionSeed.js` reads `import.meta.env` inside `loadRegionCatalog` | rewrite to a real global |

That last one matters more than it looks: `assets.js` swallows the throw and then clears its own
memo, so unshimmed the region catalog is re-decoded on **every prompt build** and every custom
scenario name is silently lost.

`--verify-compat` reports which blockers a target still has. A branch that fixes one upstream shows
up as a no-op rather than being quietly patched forever. `.jsx` is allow-listed to the one JSX-free
file; anything else is refused by name, because the loader does not compile JSX and must not pretend
otherwise.

## Reconciliation

The most valuable thing here. It cross-checks what the AI **claimed** in event impacts against what
the world **actually shows**:

```
!! RECONCILIATION  map-truth 0.86  (12/14 claimed transfers applied)
   evt-3 "Rhine offensive" claimed FRA.6_1 -> Germany : the map did not move
   unitOps spawn: 3 narrated but not on the map
```

These are the exact failure modes the `[Map Truth]` and `[Unit Coordinates]` prompt directives were
written to fight. They existed because nobody could measure the problem. Now it is a number.

`mapTruthScore` is `null` when nothing was claimed — never a flattering `1.00`, because "the model
made no territorial claims" is not "the model was perfectly accurate".

## Interruption

Being killed is the normal exit path. Progress is appended to `journal.jsonl` and fsynced as it
happens, and reports are regenerated from that journal rather than buffered — so a run killed at
turn 8 of 20 still has eight complete turns, a valid report and an accurate AI-call count.

Four stoppers, because on Windows a killed parent usually orphans the child rather than signalling
it: signals, a wall-clock cap, an idle timeout, and polling whether the parent pid still exists.
That last one is what stops an orphan quietly burning Gemini quota after a session dies.

Recovery runs at startup, so the next command cleans up after the last cut-off even if that was a
week ago:

```
oh-harness --status     every run, its state, how to resume
oh-harness --doctor     recover interrupted runs, prune worktrees and sandboxes
```

Each interrupted run gets a `RESUME.md` runbook. A run is only judged abandoned when **both** its
heartbeat is stale and its pid is dead — a busy run can miss a heartbeat, a recycled pid can look
alive, and a false positive would kill a healthy run.

## Using a real model

Put a free-tier Gemini key **outside both repos**, so no `.gitignore` mistake can expose it:

`%USERPROFILE%\.open-historia-harness.json`

```json
{ "gemini": { "apiKey": "...", "model": "gemini-3.5-flash-lite" } }
```

`OH_HARNESS_GEMINI_KEY` also works. Then:

```
node cli.js gm-transfer --ai live
node cli.js gm-transfer --ai live --record baseline
node cli.js gm-transfer --replay baseline --replay-mode strict
```

Calls are serialised at concurrency 1 with a 6.5 s gap — parallel calls are the fastest way to trip
a per-minute limit that then looks like a quality problem. 429s honour Google's own `RetryInfo`
hint before backing off.

**A rate limit is never reported as a bad answer.** Quota exhaustion has its own error type and its
own exit code, because conflating "we ran out of quota" with "the model answered badly" would make
every quality number untrustworthy.

The quota ledger **reserves before spending**, so a process killed mid-call over-counts by one
rather than under-counting — an interrupted run can never cause the next one to overshoot a
free-tier limit.

Cassettes are keyed on the model plus the canonical request body, never the URL, because Gemini
passes its key as a query parameter. Strict replay fails loudly on a miss: a miss means the prompt
changed, which is the whole reason the recording exists.

## Exit codes

`0` pass · `1` assertion failure · `2` harness error · `3` quota exhausted · `4` budget exceeded ·
`5` compat shim could not load the target · `6` interrupted, resumable

## Scenarios

JS files in `scenarios/`, because assertions are logic and a JSON DSL would be a worse version of a
programming language.

```js
export const meta = { name: "gm-transfer", requires: { ai: true }, aiCallBudget: 4 };

export default async ({ game, world, inspect, expect, log }) => {
  const outcome = await game.gm("Transfer Bayern to France.");
  log.turn(outcome);
  expect.generatedByAi(outcome);           // did the MODEL answer, or the fallback?
  expect.regionOwner(await world.snapshot(), "DEU.2_1", "France");
  expect.noUnappliedTransfers(outcome.diff);
};
```

`expect` collects rather than throwing on first failure, so one run reports every problem.

A scenario written for a one-off local investigation, such as a player's report or an unmerged game
branch, should be named `<name>.local.js`. That name is gitignored, along with `scenarios/fixtures/`,
so neither can be pushed by accident. It still runs as `node cli.js <name>.local`.

**`expect.generatedByAi` is the sharpest verb here.** A fallback turn looks like a success from the
outside — the round advances, events appear, state persists — and only `generation.source` reveals
the model never answered.

## A note on region names

GADM stores **native** names. Bavaria is `Bayern`, Cologne is `Köln`. `who("Bavaria")` therefore
finds nothing, and no fuzzy match can bridge that without guessing, so use
`inspect.searchRegions(/bay/i)` instead.

53 names in the real catalog are shared by more than one region. `who("La Rioja")` reports both
Argentina and Spain rather than picking one, because silently choosing would make an assertion pass
against the wrong continent.

## Tests

```
npm test
```

Everything, including the offline scenario library. The game's own `npm test` is untouched and stays
exactly as fast as it was.

## Contributing

Commit rules are in [AGENTS.md](AGENTS.md#committing-to-this-repo) and match the game repo's: **no AI
attribution** in commits or PRs (no `Co-Authored-By: Claude` trailers, no "Generated with Claude Code"
footers), commit under your GitHub `noreply` identity, and nothing personal or produced by a local run.
