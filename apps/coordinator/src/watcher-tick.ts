/**
 * v2.11 fast watcher tick — one 10-second pricing pass over the open
 * paper positions. Extracted from watcher-run.ts so it is unit-testable
 * (watcher-run.ts executes main() on import and cannot be imported by
 * tests).
 *
 * Why a tick function: the 1-minute watcher could not catch a dump
 * that happens inside 60–90 seconds. All six hard-stop closes in the
 * $10 run gapped through the -30% stop (realised -30.3% to -74.0%,
 * average -45.5%), so the stop LEVEL was never the binding constraint
 * — the 60-second detection gap was. A tick every 10 seconds, with
 * the same exit ladder, bounds the between-tick move to ~10 seconds
 * of price action. Jupiter lite-api is said to allow 5 calls / 10s
 * per IP (unpublished — unverified), and a tick costs at most one
 * call per open position (max 3), so a 10-second cadence stays
 * inside that limit if it holds; a 429 or a null price journals a
 * price_missing line and leaves the position alone — the position is
 * held, not closed blind, and the spotter's 2-missed-polls rule
 * remains the close path for a persistently unpriced position.
 *
 * The caller (watcher-run.ts) owns the loop, the lock, and state
 * persistence: it reloads state and acquires the shared lock per tick
 * so the 5-minute spotter can still grab the lock between ticks.
 * This function only settles one tick against the state it is handed.
 * Journal writes go to `journalPath`; pass null in tests to skip them.
 */
import { applyExit, evaluateExit } from "../../../packages/exit/src/exit.js";
import { LIGHT_FEES, legCostSol } from "../../../packages/core/src/fees.js";
import { MICRO_PROFILE } from "../../../packages/core/src/micro.js";
import { appendJournal, journalEntry, type JournalEntry } from "../../../packages/core/src/journal.js";
import { gradeClose, JOURNAL_PATH, recordClosedMint, type SpotterState } from "../../../packages/signals/src/spotter.js";

export interface TickResult {
  /** Positions priced this tick (a price was returned). */
  priced: number;
  /** Positions with no price this tick (left alone). */
  missing: number;
  /** Partial (TP1) sales this tick. */
  partials: number;
  /** Full closes this tick. */
  closed: number;
  /** True when the daily-loss halt fired on this tick. */
  halted: boolean;
}

export function settleWatcherTick(
  state: SpotterState,
  prices: Map<string, number | null>,
  solPrice: number,
  nowMs: number,
  journalPath: string | null = JOURNAL_PATH,
): TickResult {
  const log = (mint: string, action: string, reason: string, extra: Partial<JournalEntry>): void => {
    if (journalPath !== null) appendJournal(journalPath, journalEntry(mint, action, reason, extra));
  };
  const result: TickResult = { priced: 0, missing: 0, partials: 0, closed: 0, halted: false };
  const remaining: SpotterState["positions"] = [];
  for (const p of state.positions) {
    const mc = prices.get(p.mint);
    if (mc === null || mc === undefined) {
      // No price this tick: FLAG it (price_missing journal line) and
      // keep holding — do not silently hold, and do not close blind.
      // Closing needs a price; the spotter's 2-missed-polls rule is
      // the close path for a persistently unpriced position.
      result.missing += 1;
      log(p.mint, "price_missing", "watcher: no Jupiter price this tick, position held (not closed blind)", { price: p.lastMcUsd, equityUsd: state.equityUsd });
      remaining.push(p);
      continue;
    }
    result.priced += 1;
    const decision = evaluateExit(p.position, { price: mc, atMs: nowMs });
    if (decision.action === "hold") {
      p.position = applyExit(p.position, decision, { price: mc, atMs: nowMs });
      p.lastMcUsd = mc;
      remaining.push(p);
      continue;
    }
    const fractionSold = decision.fraction;
    const grossSol = (p.sizeUsd / solPrice) * fractionSold * (mc / p.entryMcUsd);
    const legCost = legCostSol(grossSol, LIGHT_FEES, false) * solPrice;
    const proceeds = grossSol * solPrice - legCost;
    const costBasis = p.sizeUsd * fractionSold;
    const pnl = proceeds - costBasis;
    // v2.25: grade the close (provisional — the spotter poll's
    // post-exit window finalises it). A partial is not a close: it
    // journals sizePct only, no exitQuality, since the position is
    // still open. The thesis is never written here: close lines
    // carry no entryThesis field and never change p.entryThesis.
    const g = gradeClose(p, mc, costBasis);
    state.equityUsd += pnl;
    if (pnl > 0) state.grossWinsUsd += pnl;
    else state.grossLossesUsd += -pnl;
    if (decision.action === "close") {
      if (pnl > 0) state.wins += 1;
      else state.losses += 1;
      if (costBasis > 0 && pnl < 0) state.worstLossPct = Math.min(state.worstLossPct ?? 0, pnl / costBasis);
      result.closed += 1;
      recordClosedMint(state, p.mint, mc, nowMs, decision.reason, g.details, journalPath);
    } else {
      result.partials += 1;
    }
    log(p.mint, decision.action, "watcher: " + decision.reason, { sizeUsd: costBasis, price: mc, feesUsd: legCost, equityUsd: state.equityUsd, ...(decision.action === "close" ? g.journal : { sizePct: g.journal.sizePct, sizePctFlagged: g.journal.sizePctFlagged }) });
    p.position = applyExit(p.position, decision, { price: mc, atMs: nowMs });
    p.lastMcUsd = mc;
    if (p.position.remainingFraction > 0) remaining.push(p);
  }
  state.positions = remaining;
  // Daily-loss halt: settle any remaining open positions at lastMcUsd
  // before halting, same as the spotter exit loop (v2.4). Settle at
  // the FRESH price from this tick's prices map when the position was
  // priced; when it was not priced, settle at lastMcUsd and mark the
  // P&L estimated (SOUL audit fix — the old code settled every halt
  // at possibly-stale lastMcUsd with no marker).
  if (state.equityUsd <= MICRO_PROFILE.startEquityUsd * (1 - MICRO_PROFILE.dailyLossLimitPct)) {
    for (const p of state.positions) {
      const freshMc = prices.get(p.mint);
      const hasFreshPrice = typeof freshMc === "number" && freshMc > 0;
      const settleMc = hasFreshPrice ? (freshMc as number) : p.lastMcUsd;
      const grossSol = (p.sizeUsd / solPrice) * p.position.remainingFraction * (settleMc / p.entryMcUsd);
      const legCost = legCostSol(grossSol, LIGHT_FEES, false) * solPrice;
      const proceeds = grossSol * solPrice - legCost;
      const costBasis = p.sizeUsd * p.position.remainingFraction;
      const pnl = proceeds - costBasis;
      state.equityUsd += pnl;
      if (costBasis > 0 && pnl < 0) state.worstLossPct = Math.min(state.worstLossPct ?? 0, pnl / costBasis);
      if (pnl > 0) {
        state.wins += 1;
        state.grossWinsUsd += pnl;
      } else {
        state.losses += 1;
        state.grossLossesUsd += -pnl;
      }
      // v2.12 audit fix: a halt-settled position IS a close — count it,
      // or the watcher output under-reports closes on a halt day.
      result.closed += 1;
      const gHalt = gradeClose(p, settleMc, costBasis);
      log(p.mint, "close", "halt settle at last seen mc (watcher)" + (hasFreshPrice ? "" : " (estimated — no fresh price)"), { price: settleMc, feesUsd: legCost, equityUsd: state.equityUsd, ...gHalt.journal });
      recordClosedMint(state, p.mint, settleMc, nowMs, "halt settle", gHalt.details, journalPath);
    }
    state.halted = true;
    state.positions = [];
    result.halted = true;
    log("spotter", "halt", "daily loss limit reached, halting test (watcher)", { equityUsd: state.equityUsd });
  }
  return result;
}

/** Lock-free probe (v2.13): settle one tick against a JSON clone of the
 * state, with journaling DISABLED. The caller uses this to price
 * positions while the spotter holds the shared lock: if the probe
 * finds nothing to do (no close, no partial, no halt), the clone is
 * discarded and nothing is persisted — the live state is untouched
 * and no journal line is written. If the probe DOES find a close /
 * partial / halt, the caller acquires the lock, reloads fresh state,
 * and re-runs settleWatcherTick on that fresh state (with journaling)
 * so the persisted close is computed from current data, not from the
 * stale clone. The probe never mutates its input: it is safe to run
 * on the live state object, but cloning keeps the contract explicit
 * and makes the "probe changes nothing" property unit-testable. */
export function probeTick(
  state: SpotterState,
  prices: Map<string, number | null>,
  solPrice: number,
  nowMs: number,
): { probe: SpotterState; result: TickResult } {
  const probe = JSON.parse(JSON.stringify(state)) as SpotterState;
  const result = settleWatcherTick(probe, prices, solPrice, nowMs, null);
  return { probe, result };
}
