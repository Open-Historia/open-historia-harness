# For the AI agent running this

You have been pointed at a bug-hunting harness for **Open Historia**, a map-based
strategy game driven by an LLM. Your job is to play the game hard, find bugs, and
hand the user a report they can act on.

Read this whole file before running anything.

---

## What you are working with

Two sibling repos:

```
open-historia/            the game. You do NOT modify it. Ever.
open-historia-harness/    this. Run everything from here.
```

The harness boots the game's real server against a **throwaway copy** of its data,
plays real turns through the real engine, and checks after every action that the
world is still in a valid state. It never touches the user's actual save files —
there is a test (`lib/safety.realdata.test.js`) that proves this by fingerprinting
their save directory before and after a full run.

---

## Talking to the user

### Start by asking three things

Ask them together, in one message, and give them the context to answer:

1. **What level?** 1–5. Explain the trade-off rather than just listing numbers:

   | Level | Plays like | A bug found here means |
   |---|---|---|
   | 1 | a normal player having a normal game | **urgent** — real players will hit this |
   | 2 | an impatient player: long jumps, many actions | very likely to affect real players |
   | 3 | a power user: GM commands, edge-case dates | worth fixing |
   | 4 | someone actively trying to break it | worth knowing about |
   | 5 | everything at once, worst inputs available | may be noise; judge each on merit |

   If they have no preference, **suggest 2** for a first run: it exercises real
   behaviour and still finds things, without producing noise they have to wade
   through.

2. **Which saves?** `fresh` (a clean scenario), a named save, or `all`. Run
   `node cli.js --levels` to show them what saves exist on their machine. Real
   saves are more interesting than fresh ones — they carry years of accumulated AI
   output, which is where corruption actually lives — so **suggest `all`** if they
   have saves and are not in a hurry.

3. **AI provider and key?** The harness runs perfectly well with **no key at all**,
   using the game's deterministic fallback turn. That tests the whole engine except
   the model itself, and costs nothing. Only ask for a key if they want to test
   whether the *model's* answers are good.

   If they do want live AI, ask which provider (`gemini`, `openai`, `anthropic`,
   `openai-compatible`) and tell them to put the key at
   `%USERPROFILE%\.open-historia-harness.json`:

   ```json
   { "gemini": { "apiKey": "...", "model": "gemini-3.5-flash-lite" } }
   ```

   **Never ask them to paste a key into the chat.** If they do anyway, tell them
   to rotate it, and use the file instead.

### While it runs

Long runs are slow, especially with live AI (6–30 s per turn). Say what you are
running and roughly how long it will take. Do not go silent.

### When you are done

Read `BUG-REPORT.md` and **summarise it in your own words**. Do not paste the file.
Lead with what matters:

- Anything under **Crashes** first. An exception escaping the engine is always real.
- Note that repeated findings of the same kind are **grouped**: "31 instances, e.g.
  Two events share the id e1" is one problem affecting 31 things, not 31 problems.
- Then findings **caused by the run**, worst severity first.
- Then, briefly, anything **already present in the save** — flagging clearly that
  the run did not cause it.
- If nothing was found, say so plainly. That is a real result, not a failure.

Give them the path to the full report and the exact command to reproduce.

---

## Running it

```bash
cd open-historia-harness

node cli.js --levels                              # levels, and which saves exist
node cli.js --hunt --level 2                      # fresh scenario
node cli.js --hunt --level 2 --saves all          # fresh plus every real save
node cli.js --hunt --level 4 --saves modern-day-session --seed 777
node cli.js --hunt --level 3 --ai live            # with a real model
```

Useful flags: `--turns <n>` to override the level's turn count, `--seed <n>` to
reproduce an earlier hunt exactly, `--max-ai-calls <n>` to cap spend,
`--record <name>` to save the model's responses for replay.

The report is written to `runs/<timestamp>-hunt-L<level>/BUG-REPORT.md`.

**With `--saves all` you get one report per save**, because each runs in its own
process (the game server starts on import and is cached, so one server per
process). The run ends with a combined table on stdout and an index at
`runs/HUNT-INDEX-L<level>.md` listing every save and its report. Read the index
first, then open only the reports that have findings.

---

## Logging is already on, and already durable

You do not need to enable anything. Every run:

- appends each completed step to `journal.jsonl` and **fsyncs it**, so a kill
  cannot lose more than the last record;
- **rewrites `BUG-REPORT.md` in full after every single finding**, so the file on
  disk is valid at every instant. If you time out after finding three bugs, the
  report describes three bugs;
- captures the game server's own log inside the sandbox;
- records full stack traces for anything that escapes the engine.

**If you time out or are killed, the report is still there and still correct.**
Tell the user where it is. The next invocation of any harness command
automatically recovers the interrupted run and writes a `RESUME.md` beside it.

---

## Reading the results properly

This is where you add value over just running a command.

**A thrown error is not automatically a bug.** Levels 4 and 5 deliberately feed the
engine nonsense — empty strings, 10-billion-day jumps, coordinates at 999°.
*Rejecting* nonsense is correct. The harness already distinguishes these:

- **Crashes** are `TypeError`-shaped internal failures. Always real.
- **Findings** are invalid *states* the engine ended up in. Real regardless of input.
- Validation messages are recognised and not reported at all.

**Pre-existing findings are not this run's fault.** The report separates them
under "Already present before the run started". Never tell the user their code
broke something that was already broken in their save — it sends them hunting
through the wrong code. Do say the save carries invalid data, because that is
itself a bug that happened at some point.

**Severity is about players, not drama.** A medium finding at level 1 matters more
than a high finding at level 5, because level 1 is what a real person does.

**Check the "What the run did" timeline** before blaming a specific action. The
harness lists the last steps before each finding.

---

## Things you should not do

- **Do not modify the game repo.** The harness needs no source changes; it patches
  four Node-import blockers in memory at load time. If you think the game needs
  editing to be testable, you are about to break the user's checkout.
- **Do not ask for or accept a pasted API key.** Point at the config file.
- **Do not present raw output as a report.** Summarise, prioritise, interpret.
- **Do not claim a bug you have not seen in the report.** If the run found
  nothing, say it found nothing.
- **Do not run level 5 first.** It produces noise that makes the real signal hard
  to see, and it will waste the user's time.
- **Do not push, commit to, or branch the game repo** unless the user asks.

---

## Committing to this repo

These are hard rules, the same as the game repo's (`docs/conventions.md` there).

### No AI attribution — ever

**Do not add `Co-Authored-By: Claude …` trailers, `Generated with Claude Code`
footers, or any AI-attribution line** to commit messages or PR bodies. This
applies whether or not an AI tool touched the change. Commits and PRs read as
authored by a human contributor, full stop.

### Author identity

Commit under **your own GitHub-linked identity**, with your GitHub `noreply`
email (`<id>+<user>@users.noreply.github.com`) so commits attribute to your
account without publishing a real address. Do not impersonate another
contributor's name or email.

### Nothing personal or local

The repo is public. Do not commit:

- names, home-directory paths, email addresses, or anything else that identifies
  the person running the harness. In comments, write "the user", not a name;
- API keys, even free-tier or revoked ones. Keys belong in
  `%USERPROFILE%\.open-historia-harness.json`;
- anything a local run produced: `runs/`, `sandbox/`, `cassettes/`, bug reports,
  journals, and data copied out of real saves;
- one-off local scenarios and their fixtures. Name them `<name>.local.js`, which
  is gitignored.

Check `git status` before every commit; `.gitignore` covers all of the above, so
anything that shows up there that you did not write on purpose is a warning.

---

## If something goes wrong

| Symptom | What it means |
|---|---|
| `no game repo at ...` | The game is not a sibling directory. Use `--repo <path>`. |
| `No API key found` | Expected without a key. Run without `--ai live`. |
| Exit code 3 | Rate limited or out of quota — **not** a game bug. Wait, or lower `--max-ai-calls`. |
| Exit code 5 | The compat shim could not load this branch. Run `node cli.js --verify-compat`. |
| Every turn says `fallback` | No key, so the model never answered. Expected offline; the engine is still being tested. |
| A finding you cannot explain | Re-run with the same `--seed` — the action sequence is deterministic. |

Run `node cli.js --doctor` if runs seem stuck or worktrees have accumulated.

---

## What "good" looks like

A useful session ends with the user knowing:

1. whether anything is broken, and how badly;
2. which findings are urgent (low level) versus curiosities (high level);
3. what was already wrong in their data before you started;
4. the exact command to reproduce anything you found.

If you cannot tell them those four things, you have not finished.
