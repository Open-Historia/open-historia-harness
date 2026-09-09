// A daily budget that survives being killed.
//
// The rule that matters: RESERVE BEFORE SPENDING. A process killed mid-call then
// over-counts by at most one, rather than under-counting — the fail-safe
// direction, so an interrupted run can never cause the next one to blow through
// a free-tier limit.
//
// Persisted under the sandbox root and keyed by date, so the budget is shared
// across runs and survives restarts.

import fs from "node:fs";
import path from "node:path";

const today = (now = new Date()) => now.toISOString().slice(0, 10);

const readLedger = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
};

const writeLedger = (file, ledger) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(ledger, null, 2)}\n`);
  fs.renameSync(temp, file);
};

export class QuotaExhausted extends Error {
  constructor(message, detail) {
    super(message);
    this.name = "QuotaExhausted";
    this.harnessQuota = true;
    this.detail = detail;
  }
}

/**
 * @param file      where the ledger lives
 * @param perDay    daily provider-call ceiling (0 disables the check)
 * @param perRun    ceiling for this run alone
 */
export const createQuota = ({ file, perDay = 0, perRun = 0, now = () => new Date() } = {}) => {
  let spentThisRun = 0;

  const state = () => {
    const ledger = readLedger(file);
    const day = today(now());
    return { ledger, day, spentToday: ledger[day]?.calls ?? 0 };
  };

  return {
    get spentThisRun() {
      return spentThisRun;
    },

    spentToday() {
      return state().spentToday;
    },

    /**
     * Claim one call BEFORE making it. Throws rather than returning false: a
     * silently skipped provider call would look exactly like a model that
     * answered badly, which is the worst possible confusion in an AI-quality
     * harness.
     */
    reserve(task = null) {
      const { ledger, day, spentToday } = state();

      if (perRun > 0 && spentThisRun >= perRun) {
        throw new QuotaExhausted(
          `[harness] run budget of ${perRun} provider calls is spent`,
          { scope: "run", limit: perRun, spent: spentThisRun },
        );
      }
      if (perDay > 0 && spentToday >= perDay) {
        throw new QuotaExhausted(
          `[harness] daily budget of ${perDay} provider calls is spent (resets tomorrow)`,
          { scope: "day", limit: perDay, spent: spentToday, day },
        );
      }

      ledger[day] = { calls: spentToday + 1, updatedAt: new Date().toISOString() };
      // Keep the ledger small: a fortnight is plenty of history for a budget.
      for (const key of Object.keys(ledger)) {
        if (key < day && Object.keys(ledger).length > 14) delete ledger[key];
      }
      writeLedger(file, ledger);
      spentThisRun += 1;

      return { day, spentToday: spentToday + 1, spentThisRun, task };
    },

    /**
     * Give back a reservation for a call that never left the machine (a cassette
     * hit, or a refusal before the request). Only ever called on paths where we
     * KNOW no request was made.
     */
    refund() {
      const { ledger, day, spentToday } = state();
      if (spentToday > 0) {
        ledger[day] = { calls: spentToday - 1, updatedAt: new Date().toISOString() };
        writeLedger(file, ledger);
      }
      if (spentThisRun > 0) spentThisRun -= 1;
    },
  };
};
