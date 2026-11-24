/**
 * Shadow-position backtester (v2.15, million-inspired).
 *
 * The desk's journal replays used to be hand-rolled Python per
 * investigation (v2.11, v2.13, v2.14 each re-derived the same 23
 * trades by hand). This harness replaces that with one deterministic
 * replay of a journal.jsonl through the EXISTING exit ladder
 * (packages/exit/src/exit.ts) and the EXISTING fee model
 * (packages/core/src/fees.ts) — it does not rewrite the live logic
 * to fit the harness; it calls it.
 *
 * What it replays: every paper_entry -> partial/close sequence in a
 * journal, sorted by ts, per mint (re-entries are separate trades:
 * each paper_entry opens a new trade). Per leg it:
 *   1. asks evaluateExit what the ladder would do at the journaled
 *      price, and records whether the ladder agrees with the
 *      journaled action (ground truth is the journal — the ladder
 *      is measured, not trusted). The ladder decision's urgency is
 *      threaded through to applyExit, not hardcoded "normal";
 *   2. settles the leg with the journaled action via applyExit, so
 *      the position tracks what happened even when the ladder
 *      disagrees;
 *   3. prices the leg from the journal: proceeds =
 *      costBasis * (price / entryPrice) - feesUsd, pnl = proceeds
 *      - costBasis. The buy fee comes from the entry line's feesUsd
 *      when present (v2.12+); older entries (pre-fix) never booked
 *      one, so it is estimated with legCostSol at an EXPLICITLY
 *      supplied SOL price (opts.solPriceUsd — no default; without
 *      one the buy fee is null and the trade is unverifiable).
 *
 * P&L honesty (SOUL audit fix, 2026-11-23): P&L is exact ONLY when
 * every leg carries sizeUsd and feesUsd and the buy fee is booked.
 * A leg missing sizeUsd or feesUsd is marked unverifiable and its
 * P&L is null — the old code INVENTED a cost basis for it (a close
 * without one "settles the whole remaining position", a partial
 * without one is "TP1's half") and booked the invented number as
 * exact. The position-tracking fraction for such a leg is still
 * reconstructed (a close sells the rest by definition; a partial is
 * TP1's half per the ladder rule) so later legs track, but the
 * reconstruction never enters the P&L. A trade with any
 * unverifiable leg, or a null buy fee, has pnlUsd null, outcome
 * UNKNOWN, and is EXCLUDED from netUsd and the win/loss/rug counts
 * (counted separately as unverifiableTrades). The OKX signal is
 * snapshotted at ENTRY time — the old code read the latest signal
 * for the mint at finishTrade, which is lookahead when a mint was
 * re-entered. Closes with no open entry are counted (skippedCloses),
 * trades still open at EOF are counted (openAtEof), torn lines are
 * counted (skippedLines) — none of the three is silently dropped.
 *
 * Ladder-fidelity limits (honest): the journal records action
 * prices, not every tick, so the ladder's peak-dependent decisions
 * cannot always be re-derived. Trailing stops need the unrecorded
 * intra-trade peak, and halt settles / price-source-lost closes are
 * settlements, not ladder decisions — all three are replayed at
 * face value and reported as "unverifiable from journal
 * granularity" instead of being forced to agree. Hard stops, TP1,
 * TP2, time exits and stall exits ARE re-derivable and are asserted.
 *
 * Gate testing: filterCohort() takes the replayed trades and a
 * predicate over the entry's structured fields (score, sizeUsd,
 * flow fields, parsed OKX cluster/holders) and returns the kept
 * cohort's counts + net — so a gate change is tested by writing a
 * predicate, not a new script. The predicate receives the trade's
 * parsed entry line, so any field the journal carries is usable.
 * The historical gate predicates (OKX cluster, holder floor) live
 * here as isOkxClusterGateKept / isHolderFloorKept, not in the test.
 */
import { applyExit, evaluateExit, openPosition, type Position } from "../../exit/src/exit.js";
import { legCostSol, LIGHT_FEES } from "../../core/src/fees.js";
import { MICRO_PROFILE, type MicroProfile } from "../../core/src/micro.js";

export interface JournalLine {
  ts: string;
  mint: string;
  action: string;
  reason: string;
  score?: number;
  sizeUsd?: number;
  price?: number;
  feesUsd?: number;
  equityUsd?: number;
  [key: string]: unknown;
}

export interface TradeLeg {
  action: "partial" | "close";
  reason: string;
  price: number;
  /** Cost basis of the fraction sold, null when the journal line
   * carried no sizeUsd (reconstructed for position tracking only —
   * see the module header; never enters the P&L). */
  sizeUsd: number | null;
  /** Sell-leg fee, null when the journal line carried none. */
  feesUsd: number | null;
  atMs: number;
  /** Ladder decision at this price, or null when the leg is not a
   * ladder decision (halt settle / price-source-lost). */
  ladderAction: "hold" | "partial" | "close" | null;
  /** True when the ladder's action matches the journaled action.
   * Trailing stops are never "agree" here: the peak is unrecorded,
   * so they are reported as ladderUnverifiable instead. */
  ladderAgrees: boolean;
  ladderUnverifiable: boolean;
  /** True when the journal line lacked sizeUsd or feesUsd: the
   * leg's P&L is null and the trade is not exact. */
  unverifiable: boolean;
  /** Leg P&L, null when unverifiable. */
  pnlUsd: number | null;
}

export type TradeOutcome = "WIN" | "LOSS" | "RUG" | "UNKNOWN";

export interface ParsedTrade {
  mint: string;
  entryAtMs: number;
  entryPrice: number;
  sizeUsd: number;
  /** Buy-leg fee: booked from the entry line, estimated from
   * opts.solPriceUsd for pre-v2.12 entries, null when neither is
   * available (trade is then unverifiable). */
  buyFeeUsd: number | null;
  /** True when buyFeeUsd was estimated, not booked. */
  buyFeeEstimated: boolean;
  /** Structured entry fields, for gate predicates (score, flow
   * stats, tokenAgeMin, ... — whatever the entry line carried). */
  entry: JournalLine;
  /** OKX cluster + holders parsed from the trade's okx_signal line
   * (reason text "cluster=Low ... holders=2673"), snapshotted at
   * ENTRY time. Null when the trade has no okx_signal line before
   * its entry or the fields are absent. */
  okxCluster: string | null;
  okxHolders: number | null;
  legs: TradeLeg[];
  /** P&L across all legs minus the buy fee. Null when any leg is
   * unverifiable or the buy fee is null — the trade's P&L is then
   * UNKNOWN and excluded from netUsd. */
  pnlUsd: number | null;
  /** pnlUsd / sizeUsd, null when pnlUsd is null. Rugs read past
   * -100% because fees push the loss beyond the position size
   * (rug-fix note: -100.6% net). */
  netPct: number | null;
  outcome: TradeOutcome;
  /** True only when every leg is verifiable and the buy fee was
   * booked (not estimated): the P&L is exact. */
  pnlExact: boolean;
  /** True when the trade's close was a halt settle or a
   * price-source-lost close (a settlement, not a ladder exit). */
  settledNotExited: boolean;
}

export interface ReplayResult {
  trades: ParsedTrade[];
  wins: number;
  losses: number;
  rugs: number;
  /** Trades whose P&L is UNKNOWN (unverifiable legs or null buy
   * fee) — excluded from wins/losses/rugs and from netUsd. */
  unverifiableTrades: number;
  /** Net over verifiable trades ONLY (UNKNOWN trades excluded). */
  netUsd: number;
  /** Ladder-applicable legs (excludes trailing + settlements). */
  ladderChecked: number;
  ladderAgreed: number;
  ladderUnverifiable: number;
  /** Torn / unparseable lines skipped while parsing. */
  skippedLines: number;
  /** Close/partial lines with no open entry in this journal. */
  skippedCloses: number;
  /** Trades still open at the end of the journal. */
  openAtEof: number;
}

function parseTs(ts: string): number {
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : 0;
}

function isSettleReason(reason: string): boolean {
  return reason.includes("halt settle") || reason.includes("price source lost");
}

function isTrailingReason(reason: string): boolean {
  return reason.includes("trailing stop");
}

/** Strip the "watcher: " prefix so ladder reasons compare cleanly. */
function stripWatcher(reason: string): string {
  return reason.replace(/^watcher:\s*/, "");
}

export function parseJournalLines(lines: string[]): { lines: JournalLine[]; skipped: number } {
  const out: JournalLine[] = [];
  let skipped = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as JournalLine);
    } catch {
      // Skip a torn line; the journal is append-only and a torn
      // tail line must not kill a replay. Counted, not hidden.
      skipped += 1;
    }
  }
  return { lines: out, skipped };
}

/** Parse okx_signal reason text for cluster + holders. The OKX
 * signal is journaled as prose ("... holders=2673 cluster=Low
 * sameFund=..."), so this is a best-effort regex over that text. */
export function parseOkxSignal(reason: string): { cluster: string | null; holders: number | null } {
  const cluster = reason.match(/cluster=([A-Za-z]+)/);
  const holders = reason.match(/holders=(\d+)/);
  return {
    cluster: cluster ? cluster[1] : null,
    holders: holders ? Number(holders[1]) : null,
  };
}

export interface ReplayOptions {
  profile?: MicroProfile;
  /** SOL price in USD used ONLY to estimate the buy fee of
   * pre-v2.12 entries (whose lines carry no feesUsd). NO DEFAULT:
   * without it the buy fee is null and the trade is unverifiable.
   * Pass the documented live price for the run being replayed
   * (e.g. 73 for the $10 runs). */
  solPriceUsd?: number;
}

/** Replay one trade's legs through the exit ladder. The journaled
 * action is ground truth for settlement; the ladder is measured
 * against it, never substituted for it. */
export function replayTrade(
  entry: JournalLine,
  legs: JournalLine[],
  okxCluster: string | null,
  okxHolders: number | null,
  opts: ReplayOptions = {},
): ParsedTrade {
  const profile = opts.profile ?? MICRO_PROFILE;
  const entryPrice = entry.price ?? 0;
  const sizeUsd = entry.sizeUsd ?? 0;
  const entryAtMs = parseTs(entry.ts);
  // An entry without a positive price/size cannot be replayed at
  // all — openPosition would throw on it. Record it as UNKNOWN
  // instead of crashing the replay or inventing an entry.
  if (!(entryPrice > 0) || !(sizeUsd > 0)) {
    return {
      mint: entry.mint ?? "",
      entryAtMs,
      entryPrice,
      sizeUsd,
      buyFeeUsd: null,
      buyFeeEstimated: false,
      entry,
      okxCluster,
      okxHolders,
      legs: [],
      pnlUsd: null,
      netPct: null,
      outcome: "UNKNOWN",
      pnlExact: false,
      settledNotExited: false,
    };
  }
  let buyFeeUsd: number | null = null;
  let buyFeeEstimated = false;
  if (typeof entry.feesUsd === "number") {
    buyFeeUsd = entry.feesUsd;
  } else if (typeof opts.solPriceUsd === "number" && opts.solPriceUsd > 0) {
    buyFeeUsd = legCostSol(sizeUsd / opts.solPriceUsd, LIGHT_FEES, true) * opts.solPriceUsd;
    buyFeeEstimated = true;
  }
  let pos: Position = openPosition((entry.mint ?? "").slice(0, 8), entry.mint ?? "", entryPrice, sizeUsd, entryAtMs);
  const tradeLegs: TradeLeg[] = [];
  let pnlUsd: number | null = buyFeeUsd === null ? null : -buyFeeUsd;
  let settledNotExited = false;
  for (const leg of legs) {
    const price = leg.price ?? entryPrice;
    const sizeMissing = typeof leg.sizeUsd !== "number";
    const feesMissing = typeof leg.feesUsd !== "number";
    const unverifiable = sizeMissing || feesMissing;
    // Fraction for POSITION tracking only: a close sells the rest
    // (definitional); a partial without a size is TP1's half per the
    // ladder rule. Both are reconstructions — they move the position
    // so later legs track, but they never enter the P&L.
    const fraction =
      leg.action === "partial"
        ? sizeMissing
          ? 0.5 * pos.remainingFraction
          : (leg.sizeUsd as number) / sizeUsd
        : pos.remainingFraction;
    const costBasis = sizeMissing ? fraction * sizeUsd : (leg.sizeUsd as number);
    const feesUsd = feesMissing ? null : (leg.feesUsd as number);
    const atMs = parseTs(leg.ts);
    const reason = stripWatcher(leg.reason ?? "");
    const settle = isSettleReason(reason);
    const trailing = isTrailingReason(reason);
    if (settle) settledNotExited = true;
    // Ladder verdict at this price (null for settlements).
    let ladderAction: TradeLeg["ladderAction"] = null;
    let ladderAgrees = false;
    let ladderUnverifiable = false;
    let urgency: "normal" | "high" = "normal";
    if (!settle) {
      const decision = evaluateExit(pos, { price, atMs }, profile);
      ladderAction = decision.action;
      urgency = decision.urgency;
      if (trailing) {
        // The peak that triggered this trailing stop is an
        // unrecorded intra-trade tick; the ladder cannot be
        // re-derived from journal granularity. P&L stays exact
        // only when the leg itself is verifiable.
        ladderUnverifiable = true;
      } else {
        ladderAgrees = decision.action === leg.action;
      }
    }
    let legPnl: number | null = null;
    if (!unverifiable) {
      const proceeds = costBasis * (entryPrice > 0 ? price / entryPrice : 0) - (feesUsd as number);
      legPnl = proceeds - costBasis;
      if (pnlUsd !== null) pnlUsd += legPnl;
    } else {
      pnlUsd = null;
    }
    tradeLegs.push({
      action: leg.action as "partial" | "close",
      reason,
      price,
      sizeUsd: sizeMissing ? null : (leg.sizeUsd as number),
      feesUsd,
      atMs,
      ladderAction,
      ladderAgrees,
      ladderUnverifiable,
      unverifiable,
      pnlUsd: legPnl,
    });
    // Settle with the JOURNALED action, not the ladder's: the
    // journal is what happened; the ladder is being measured. The
    // fraction sold is the leg's cost basis over the entry size
    // (TP1 sells half); a close sells the rest.
    pos = applyExit(pos, { action: leg.action as "partial" | "close", fraction, reason, urgency }, { price, atMs });
  }
  const pnlExact = pnlUsd !== null && !buyFeeEstimated && tradeLegs.every((l) => !l.unverifiable);
  const netPct = pnlUsd !== null && sizeUsd > 0 ? pnlUsd / sizeUsd : null;
  const outcome: TradeOutcome =
    pnlUsd === null ? "UNKNOWN" : netPct !== null && netPct <= -0.9 ? "RUG" : pnlUsd > 0 ? "WIN" : "LOSS";
  return {
    mint: entry.mint ?? "",
    entryAtMs,
    entryPrice,
    sizeUsd,
    buyFeeUsd,
    buyFeeEstimated,
    entry,
    okxCluster,
    okxHolders,
    legs: tradeLegs,
    pnlUsd,
    netPct,
    outcome,
    pnlExact,
    settledNotExited,
  };
}

/** Replay a whole journal: group paper_entry -> partial/close per
 * mint in ts order (each entry opens a new trade, so re-entries are
 * separate trades), replay each trade, aggregate. Lines are sorted
 * by ts first — the journal is append-only and already
 * chronological, so the sort is a no-op on a healthy journal and a
 * guard on a merged one. */
export function replayJournal(lines: string[], opts: ReplayOptions = {}): ReplayResult {
  const { lines: parsedLines, skipped: skippedLines } = parseJournalLines(lines);
  const parsed = [...parsedLines].sort((a, b) => parseTs(a.ts) - parseTs(b.ts));
  // okx_signal lines, keyed by mint, in order (one per entry in
  // practice). The signal is SNAPSHOTTED at entry time below — a
  // later signal for the same mint must not leak into an earlier
  // trade (lookahead).
  const okxByMint = new Map<string, { cluster: string | null; holders: number | null }>();
  const trades: ParsedTrade[] = [];
  let skippedCloses = 0;
  let openAtEof = 0;
  let current = new Map<string, { entry: JournalLine; legs: JournalLine[]; okx: { cluster: string | null; holders: number | null } }>();
  const finishTrade = (mint: string, atEof = false) => {
    const open = current.get(mint);
    if (!open) return;
    current.delete(mint);
    if (atEof) openAtEof += 1;
    trades.push(replayTrade(open.entry, open.legs, open.okx.cluster, open.okx.holders, opts));
  };
  for (const line of parsed) {
    if (line.action === "okx_signal") {
      okxByMint.set(line.mint, parseOkxSignal(line.reason ?? ""));
      continue;
    }
    if (line.action === "paper_entry") {
      // A new entry for a mint with an unfinished trade means the
      // old trade never got a close line (halted mid-run, etc.):
      // finish it as-is so it is not silently dropped.
      finishTrade(line.mint);
      current.set(line.mint, {
        entry: line,
        legs: [],
        okx: okxByMint.get(line.mint) ?? { cluster: null, holders: null },
      });
      continue;
    }
    if (line.action === "partial" || line.action === "close") {
      const open = current.get(line.mint);
      if (!open) {
        skippedCloses += 1; // Close with no entry in this journal: count it, skip it.
        continue;
      }
      open.legs.push(line);
      if (line.action === "close") finishTrade(line.mint);
    }
  }
  // Any trade still open at the end of the journal (halted run with
  // positions settled by the halt line itself is already closed;
  // a genuinely open trade has no close — finish it for accounting,
  // counted as openAtEof).
  for (const mint of [...current.keys()]) finishTrade(mint, true);

  let wins = 0;
  let losses = 0;
  let rugs = 0;
  let unverifiableTrades = 0;
  let netUsd = 0;
  let ladderChecked = 0;
  let ladderAgreed = 0;
  let ladderUnverifiable = 0;
  for (const t of trades) {
    if (t.outcome === "WIN") wins += 1;
    else if (t.outcome === "RUG") rugs += 1;
    else if (t.outcome === "LOSS") losses += 1;
    else unverifiableTrades += 1;
    if (t.pnlUsd !== null) netUsd += t.pnlUsd;
    for (const leg of t.legs) {
      if (leg.ladderUnverifiable) ladderUnverifiable += 1;
      else if (leg.ladderAction !== null) {
        ladderChecked += 1;
        if (leg.ladderAgrees) ladderAgreed += 1;
      }
    }
  }
  return { trades, wins, losses, rugs, unverifiableTrades, netUsd, ladderChecked, ladderAgreed, ladderUnverifiable, skippedLines, skippedCloses, openAtEof };
}

/** Historical gate predicates for filterCohort (moved out of
 * replay.test.ts, SOUL audit fix). The OKX cluster filter is replay
 * analysis ONLY — the live gate is demoted to logged-only since
 * v2.18, and this predicate must never be wired back into the poll.
 * The holder-floor filter is fail-closed on null holders (filtered
 * out). */
export function isOkxClusterGateKept(t: ParsedTrade): boolean {
  return t.okxCluster !== "Medium" && t.okxCluster !== "High";
}

export function isHolderFloorKept(t: ParsedTrade): boolean {
  return (t.okxHolders ?? 0) >= 200;
}

/** Gate testing: keep only the trades whose entry passes the
 * predicate, and return the kept cohort's counts + net. The
 * predicate receives the full parsed trade (entry fields, OKX
 * cluster/holders, legs, pnl) so any journaled signal can gate.
 * UNKNOWN trades are carried in kept/filtered but never counted as
 * wins/losses/rugs and never enter netUsd. */
export function filterCohort(
  trades: ParsedTrade[],
  predicate: (trade: ParsedTrade) => boolean,
): { kept: ParsedTrade[]; filtered: ParsedTrade[]; wins: number; losses: number; rugs: number; unknown: number; netUsd: number } {
  const kept: ParsedTrade[] = [];
  const filtered: ParsedTrade[] = [];
  for (const t of trades) (predicate(t) ? kept : filtered).push(t);
  let wins = 0;
  let losses = 0;
  let rugs = 0;
  let unknown = 0;
  let netUsd = 0;
  for (const t of kept) {
    if (t.outcome === "WIN") wins += 1;
    else if (t.outcome === "RUG") rugs += 1;
    else if (t.outcome === "LOSS") losses += 1;
    else unknown += 1;
    if (t.pnlUsd !== null) netUsd += t.pnlUsd;
  }
  return { kept, filtered, wins, losses, rugs, unknown, netUsd };
}
