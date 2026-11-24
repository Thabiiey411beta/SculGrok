/**
 * 1-minute Jupiter-only position watcher (v2.11 fast loop).
 * Prices ONLY the open paper positions with Jupiter Tokens API v2
 * (lite-api.jup.ag, keyless), and enforces the same exit ladder as
 * the 5-minute scanner. It never opens a new trade, never calls
 * Rugcheck, Pump.fun, or Birdeye, so it does not hammer rate limits.
 * State is shared with spotter-run.ts.
 *
 * v2.11: one invocation now runs up to 5 pricing ticks, 10 seconds
 * apart, instead of a single price check per minute. The 1-minute
 * watcher could not catch a dump inside 60–90 seconds — all six
 * hard-stop closes in the $10 run gapped through -30% (realised
 * -30.3% to -74.0%). A 10-second tick bounds the between-tick move
 * to ~10 seconds of price action. Cost per tick is at most one
 * Jupiter call per open position (max 3), inside the lite-api limit
 * of 5 calls / 10s; a 429 or a null price leaves the position
 * alone, fail-safe.
 *
 * v2.13 lock-free pricing: each tick loads state lock-free (safe
 * since v2.12 made state writes atomic), fetches Jupiter prices, and
 * probes the tick on a clone (probeTick, journaling off). A probe
 * that finds nothing to do is discarded — no lock, no persist, no
 * journal write — so the watcher is never blind while the spotter
 * holds the lock (the old design skipped the whole tick: on
 * 2026-11-23 19:44 all 5 ticks were skipped while the spotter polled,
 * a ~45s blind window). A probe that finds a close / partial / halt
 * acquires the lock, reloads FRESH state, and re-settles on that
 * fresh state with journaling — the persisted close is computed from
 * current STATE, not the stale probe (the prices are the ones fetched
 * for this tick, up to ~10s old by persist time, not re-fetched after
 * the lock). If the lock is held at that moment the persist is
 * deferred (counted as skippedTicks) and the next tick re-probes from
 * fresh state and fresh prices. The close is delayed, not queued:
 * if the 45s deadline or the cron's `timeout 60` ends the run first,
 * the close waits for the NEXT invocation and settles at that later
 * price — the old "delayed by at most one tick, never lost" claim
 * was wrong. Hold-tick peak updates are discarded with the probe
 * (the spotter refreshes peaks every 5 minutes); the probe's only
 * job is to detect closes.
 * Honest scope: this removes blind windows and should reduce
 * multi-tick gap losses, but it would NOT have saved the two -97%
 * rugs — each collapsed inside a single 10-second tick.
 *
 * Locking: the lock is now taken ONLY when a tick has something to
 * persist. The loop deadline (45s) keeps the invocation inside the
 * cron's `timeout 60` wrapper. If Jupiter returns no price for a
 * position, the tick journals a price_missing line and leaves the
 * position alone, do not close it blind.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { fetchJupiterMc, fetchSolPriceUsd, acquireLock, releaseLock, JOURNAL_PATH, newState, normalizeState, readiness, SPOTTER_DIR, STATE_PATH, type SpotterState } from "../../../packages/signals/src/spotter.js";
import { appendJournal, journalEntry } from "../../../packages/core/src/journal.js";
import { probeTick, settleWatcherTick } from "./watcher-tick.js";

const LOCK_PATH = SPOTTER_DIR + "/watcher.lock";

/** Seconds between pricing ticks inside one invocation. */
export const WATCHER_TICK_MS = 10_000;
/** Total wall time the tick loop may run; under the cron timeout 60. */
export const WATCHER_RUN_MS = 45_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function loadState(): SpotterState {
  if (existsSync(STATE_PATH)) {
    return normalizeState(JSON.parse(readFileSync(STATE_PATH, "utf8")) as SpotterState);
  }
  return newState();
}

function saveState(state: SpotterState): void {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  // v2.12 audit fix: atomic rename, same reason as spotter-run.ts —
  // a direct write can be read torn by a concurrent reader.
  writeFileSync(STATE_PATH + ".tmp", JSON.stringify(state, null, 2), "utf8");
  renameSync(STATE_PATH + ".tmp", STATE_PATH);
}

async function main(): Promise<void> {
  mkdirSync(SPOTTER_DIR, { recursive: true });
  const before = { equity: 0, trades: 0 };
  const startMs = Date.now();
  let ticks = 0;
  let skippedTicks = 0;
  let totalClosed = 0;
  let totalPartials = 0;
  let lastState: SpotterState | null = null;

  // Fast-exit path: load once to check halted / idle before looping.
  const initial = loadState();
  before.equity = initial.equityUsd;
  before.trades = initial.trades;
  if (initial.halted) {
    console.log(JSON.stringify({ watcher: "halted", equityUsd: initial.equityUsd }));
    return;
  }
  if (initial.positions.length === 0) {
    console.log(JSON.stringify({ watcher: "idle", openPositions: 0, equityUsd: Number(initial.equityUsd.toFixed(4)) }));
    return;
  }
  // v2.4: live SOL price for settlement, fetched once per invocation,
  // not per tick — SOL does not move enough in 45 seconds to matter.
  // Fail-closed (SOUL audit fix): if the live fetch fails, fall back
  // to the last LIVE price in state (solPriceUsd > 0) for settlement
  // only; if that is also unavailable, do not settle at all.
  const liveSol = await fetchSolPriceUsd();
  const solPrice = liveSol ?? (initial.solPriceUsd > 0 ? initial.solPriceUsd : null);
  if (solPrice === null) {
    console.log(JSON.stringify({ watcher: "no_sol_price", reason: "SOL price unavailable and no last live price in state, not settling", equityUsd: initial.equityUsd }));
    return;
  }

  while (Date.now() - startMs < WATCHER_RUN_MS) {
    const tickStart = Date.now();
    // v2.13: price lock-free. Load fresh state (atomic writes make a
    // torn read impossible), fetch prices, and probe the tick on a
    // clone. The spotter holding the lock no longer blinds us.
    const state = loadState();
    if (state.halted) {
      lastState = state;
      break;
    }
    if (state.positions.length === 0) {
      lastState = state;
      break;
    }
    state.solPriceUsd = solPrice;
    const prices = new Map<string, number | null>();
    for (const p of state.positions) {
      prices.set(p.mint, await fetchJupiterMc(p.mint));
    }
    const { result: probe } = probeTick(state, prices, solPrice, Date.now());
    ticks += 1;
    if (probe.closed === 0 && probe.partials === 0 && !probe.halted) {
      // Hold tick: discard the probe (its peak updates are stale by
      // next tick anyway; the spotter refreshes peaks every 5 min).
      // No lock, no persist, no journal write.
      lastState = state;
    } else {
      // Something to persist: take the lock, reload FRESH state, and
      // re-settle on it with journaling — never persist the probe.
      const lock = acquireLock(LOCK_PATH);
      if (!lock.held) {
        // Spotter is polling right now: defer the persist, do not
        // queue behind it. The next tick re-probes from fresh state
        // and fresh prices, so the close is delayed, never lost.
        skippedTicks += 1;
      } else {
        if (lock.reclaimed) {
          appendJournal(JOURNAL_PATH, journalEntry("spotter", "stale_lock_recovered", "orphaned lock dir older than 5 min removed, watcher proceeding", {}));
        }
        try {
          const fresh = loadState();
          fresh.solPriceUsd = solPrice;
          const result = settleWatcherTick(fresh, prices, solPrice, Date.now());
          totalClosed += result.closed;
          totalPartials += result.partials;
          saveState(fresh);
          lastState = fresh;
          if (result.halted || fresh.positions.length === 0) break;
        } finally {
          releaseLock(LOCK_PATH, lock.token);
        }
      }
    }
    const elapsed = Date.now() - tickStart;
    const remaining = WATCHER_RUN_MS - (Date.now() - startMs);
    if (remaining <= 0) break;
    if (elapsed < WATCHER_TICK_MS) await sleep(Math.min(WATCHER_TICK_MS - elapsed, remaining));
  }

  const state = lastState ?? loadState();
  console.log(JSON.stringify({
    watcher: "ran",
    ticks,
    skippedTicks,
    equityUsd: Number(state.equityUsd.toFixed(4)),
    trades: state.trades,
    wins: state.wins,
    losses: state.losses,
    closed: totalClosed,
    partials: totalPartials,
    readiness: readiness(state),
    openPositions: state.positions.map((p) => ({ mint: p.mint, name: p.name, entryMcUsd: p.entryMcUsd, lastMcUsd: p.lastMcUsd, remaining: p.position.remainingFraction })),
    deltaEquity: Number((state.equityUsd - before.equity).toFixed(4)),
  }, null, 2));
}

main().catch((err) => {
  // No lock cleanup here: any lock this run held was already
  // released by the finally in the persist branch; a throw before
  // acquireLock means no lock was ever held.
  console.error(err);
  process.exit(1);
});
