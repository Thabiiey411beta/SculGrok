/**
 * BSC (four.meme) paper spotter — v2, 2026-11-24.
 *
 * A SECOND, separate paper desk mirroring the Solana memecoin desk's
 * harness (same journal shape, same exit ladder, same readiness
 * bar, same $15 start equity) — but for four.meme tokens on BNB
 * Chain, with BSC-native sources. It NEVER touches the Solana state,
 * journal, crons, or gates.
 *
 * v2 REPLACES the Solana gem score with a VOLUME-FIRST ruleset
 * (packages/bsc/src/volume.ts): entries are driven by measured
 * volume — DexScreener m5/h1 USD volume, buy/sell dominance,
 * unique-trader breadth, volume heat, volume vs liquidity, pair
 * age <= 6h. v1 entered 0 trades in ~31 polls because a brand-new
 * token scores 46 by construction and can never clear the 70/60
 * gem bars. Graduated tokens are first-class entries; pre-grad
 * tokens are evaluated + journaled on volume but stay blocked by
 * the fee model at $15. New discovery: (B) fresh PancakeSwap V2
 * pools, Helper3-filtered to real graduates, plus a GRADUATION
 * RE-CHECK that re-reads Helper3 for up to 4 seen tokens per poll
 * and catches tokens that flip to graduated=1. Graduation is
 * determined STRICTLY (Helper3 flag; the v1 dexId/GoPlus fallbacks
 * are removed — they admitted non-four.meme tokens as graduated).
 * GoPlus holder floor has a documented staleness fallback
 * (>= 50 live h1 traders overrides a stale GoPlus count < 200).
 * Read the v2 build note before reusing any threshold:
 * hidden_files/bsc-v2-volume-rules-20261124.md.
 *
 * Sources (all verified live 2026-11-24, no keys):
 * - Discovery: GeckoTerminal new_pools (BSC), filtered to
 *   dex "four-meme". four.meme's own REST list is geo-blocked
 *   (Cloudflare 403) from this VM and eth_getLogs is rejected by
 *   every public BSC RPC (-32005) — see packages/bsc/src/discovery.ts.
 * - Pricing: DexScreener tokens/v1/bsc (pre-grad tokens DO return a
 *   fourmeme pair with price/mcap/txns but NO liquidity object) +
 *   Helper3 getTokenInfo eth_call (curve price, raised, threshold,
 *   graduation flag). See packages/bsc/src/pricing.ts.
 * - Security: GoPlus token_security/56, single-address calls (batch
 *   is unreliable — a 2-address batch returned 1 result). See
 *   packages/bsc/src/goplus.ts.
 *
 * CLUSTER GATE (v3, 2026-11-24): THERE IS ONE NOW — packages/bsc/src/
 * bsc-cluster.ts, built on the NodeReal MegaNode endpoint (the key
 * Newton provided; URL read at runtime from ~/.nodereal/bsc-rpc-url,
 * never logged). It mirrors the Solana desk's Helius funder-cluster
 * verdict rules (shared funder / creator-funded / direct transfer
 * between top holders; fail-closed on any RPC failure) with holders
 * reconstructed from the mint's Transfer logs and first funders
 * from nr_getAssetTransfers native BNB. Runs ONLY on would-be
 * entries, after the sell-sim gate. Unknown-heavy (>= half of
 * checked holders unresolvable) sizes the entry x 0.75 and journals
 * cluster_unknown — a deliberate divergence from Solana v2.18,
 * which BLOCKS on >= half unknown (see bsc-cluster.ts header).
 * State carries clusterGateAvailable: true and a clusterBlocks
 * counter. Build note: hidden_files/bsc-cluster-gate-20261124.md.
 *
 * Structural differences from Solana, baked in (not bugs):
 * - Pre-graduation tokens have ~2 holders (TokenManager2 + creator)
 *   and NO DexScreener liquidity — the holder floor (>= 200) and
 *   liquidity floor ($8k) apply to GRADUATED tokens only. Pre-grad
 *   the curve itself is the exit (sell into the curve at the Helper3
 *   price minus the 1% platform fee).
 * - The four.meme 1% trading fee has NO on-chain minimum on
 *   classic launches (fee flip, 2026-11-24): Helper3 getTokenInfo
 *   reports minTradingFee 0, verified live via tryBuy/trySell
 *   (a $3.30 buy charged exactly 1%, no 0.001 BNB floor). Each
 *   candidate's OWN on-chain minimum feeds the fee bar at Gate 3
 *   (resolveMinFeeBnb in fees.ts); the 0.001 BNB figure survives
 *   only as the fallback for missing/ambiguous reads or non-1%
 *   fee rates (X-Mode / TaxToken). Pre-graduation entries at $15
 *   now break even at ~7.7% and pass the 25% bar — the volume
 *   gates, not the fee, are the binding pre-grad filter. See
 *   packages/bsc/src/fees.ts and hidden_files/bsc-fee-flip-20261124.md.
 * - No smart-money list on BSC (no Fomo equivalent wired).
 * - v1 gem flow components (removed in v2 — see volume.ts):
 *   buy/sell ratio from h1 buy/sell COUNTS, inflow as net h1 buy
 *   txns, buyer growth as h1 buy rate vs the h6 hourly average.
 *   They were validated on Solana data, not BSC data, and the
 *   score could not discriminate between new tokens at all.
 * - No separate 1-minute watcher: the 5-minute poll prices
 *   open positions itself each run (the Solana spotter does the same
 *   in its own poll; the 1-min watcher is a Solana-only extra).
 *
 * Paper-only. No wallet, no private key, no signing, no live trading.
 */
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendJournal, journalEntry } from "../../core/src/journal.js";
import { applyExit, evaluateExit, openPosition, type Position } from "../../exit/src/exit.js";
import type { MicroProfile } from "../../core/src/micro.js";
import { BSC_FEES, breakEvenGrossPct, fixedCostPctOfPosition, legCostBnb, resolveMinFeeBnb } from "./fees.js";
import { fetchGoPlus, goplusVerdict } from "./goplus.js";
import { fetchNewFourMemePoolsPages, fetchNewPancakePoolsPages, type BscCandidate } from "./discovery.js";
import { fetchBnbPriceUsd, fetchCurveInfo, fetchDexPair, quotePancakeSell, type CurveInfo, type DexBscPair } from "./pricing.js";
import { pregradActivityFloor, volumeJournalExtra, volumeVerdict, VOL_TRADER_BREADTH_FOR_HOLDER_FLOOR, type VolumeInputs } from "./volume.js";
import { checkBscCluster } from "./bsc-cluster.js";

export const BSC_DIR = "/home/hatch/workspace/goals/solana-memecoin-flipping-system/hidden_files/spotter-test-20261122-v2-bsc";
export const BSC_STATE_PATH = BSC_DIR + "/state.json";
export const BSC_JOURNAL_PATH = BSC_DIR + "/journal.jsonl";
export const BSC_LOCK_PATH = BSC_DIR + "/bsc-spotter.lock";

export const BSC_START_EQUITY_USD = 15.0;
/** Same exit ladder + sizing as the Solana desk, as an independent
 * profile (changing the Solana profile must not silently retune BSC). */
export const BSC_PROFILE: MicroProfile = {
  startEquityUsd: 15.0,
  maxPositionPct: 0.22,
  startPositionPct: 0.22,
  maxOpenPositions: 3,
  maxTradesPerDay: 15,
  dailyLossLimitPct: 0.25,
  hardStopPct: 0.3,
  trailingStopPct: 0.18,
  tp1Multiple: 1.5,
  tp1Fraction: 0.5,
  tp2Multiple: 2.0,
  timeExitMinutes: 120,
  stallMinutes: 20,
  minBreakEvenGrossPct: 0.25,
  maxFixedCostPctOfPosition: 0.1,
};
export const BSC_HALT_EQUITY_USD = BSC_START_EQUITY_USD * (1 - BSC_PROFILE.dailyLossLimitPct); // $11.25
export const BSC_READINESS_EQUITY_USD = BSC_START_EQUITY_USD * 1.1; // $16.50
export const BSC_HOLDER_FLOOR = 200;
export const BSC_LIQUIDITY_FLOOR_USD = 8000;
/** v2: no gem bars — entry is volume-gated (see volume.ts). */
/** Graduation re-check: Helper3 re-reads per poll, and the max age
 * of a seen token worth re-checking (a token that has not graduated
 * in 24h is almost certainly a dead curve). */
export const BSC_GRAD_RECHECK_PER_POLL = 4;
export const BSC_GRAD_RECHECK_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** P1+P4 (2026-11-24): re-check slot allocation. The old
 * progress-desc-only rank re-checked the same top 4 tokens every
 * poll while 561/811 seen tokens were never curve-checked. Per
 * poll the 4 slots are now: 2 progress-ranked (by velocity, P4),
 * 1 never-measured round-robin (oldest firstSeen first), 1
 * stalest lastCurveCheckMs. A designated pool that is empty
 * backfills from the next-best eligible tokens so the budget is
 * still used. */
export const BSC_RECHECK_PROGRESS_SLOTS = 2;
export const BSC_RECHECK_ROUND_ROBIN_SLOTS = 1;
export const BSC_RECHECK_STALEST_SLOTS = 1;
/** P1 staleness decay: a token whose progress has not moved
 * (>= 0.05pp counts as a move) in this many consecutive checks
 * is deprioritized for this many polls, then becomes eligible
 * again. */
export const BSC_NO_MOVE_CHECKS_LIMIT = 12;
export const BSC_DEPRIORITIZE_POLLS = 24;
export const BSC_PROGRESS_MOVE_MIN_PP = 0.05;
export const BSC_SLICE = 8;
/** Slice oversampling: the ranked list can contain cooled-down
 * tokens, which the loop skips without consuming the deep-check
 * budget — so the slice is wider than the budget. */
export const BSC_SLICE_CANDIDATES = 16;
export const BSC_BLOCKED_COOLDOWN_MS = 60 * 60 * 1000;
export const BSC_REENTRY_COOLDOWN_MS = 30 * 60 * 1000;

export interface BscPosition {
  id: string;
  address: string;
  name: string;
  entryMcUsd: number;
  sizeUsd: number;
  openedAtMs: number;
  position: Position;
  lastMcUsd: number;
  missedPolls: number;
  entryThesis?: string;
  sizePctAtEntry?: number;
  graduatedAtEntry: boolean;
  /** Per-token platform-fee minimum (BNB) resolved from Helper3
   * at entry (fee flip, 2026-11-24) — the sell leg in settleClose
   * charges the same minimum the entry was evaluated at.
   * Undefined for positions opened before the flip (fallback). */
  minFeeBnbAtEntry?: number;
}

export interface BscState {
  startedAtMs: number;
  equityUsd: number;
  trades: number;
  wins: number;
  losses: number;
  blocked: number;
  priceSourceLostCloses: number;
  grossWinsUsd: number;
  grossLossesUsd: number;
  goplusBlocks: number;
  holderFloorBlocks: number;
  liquidityFloorBlocks: number;
  sellSimBlocks: number;
  sellSimTransient: number;
  /** v2 counters. */
  volumeBlocks: number;
  gradChecks: number;
  graduatesFound: number;
  cooldownSkips: number;
  reentrySkips: number;
  bscCoinsSeen: number;
  tradesToday: number;
  tradeDay: string | null;
  worstLossPct: number;
  halted: boolean;
  polls: number;
  bnbPriceUsd: number;
  /** v3 (2026-11-24): NodeReal funder-cluster gate is live. */
  clusterGateAvailable: boolean;
  /** v3: entries blocked by the cluster gate (clustered verdict
   * or fail-closed RPC failure). */
  clusterBlocks: number;
  positions: BscPosition[];
  /** v2: seen records carry curve progress so the graduation
   * re-check can rank them (fields are optional — records written
   * by v1 lack them and read as "never curve-checked").
   * P1+P4 (2026-11-24): lastProgressPct/lastProgressMs hold the
   * PREVIOUS reading so velocity can be computed; noMoveChecks
   * counts consecutive readings with < 0.05pp of progress
   * movement; deprioritizeUntilPoll is the poll number before
   * which a stalled token is skipped by the re-check. All four
   * are optional — legacy records read as "one reading, no
   * staleness history" and bootstrap velocity from the
   * progress/age prior. */
  seen: Record<string, { firstMcUsd: number; firstSeenMs: number; poolAddress?: string; curveProgressPct?: number; raisedBnb?: number; graduated?: boolean; lastCurveCheckMs?: number; lastProgressPct?: number; lastProgressMs?: number; noMoveChecks?: number; deprioritizeUntilPoll?: number }>;
  closedMints: Record<string, number>;
  blockedMints: Record<string, { blockedAtMs: number; mcUsd: number }>;
}

export function newBscState(nowMs = Date.now()): BscState {
  return {
    startedAtMs: nowMs,
    equityUsd: BSC_START_EQUITY_USD,
    trades: 0,
    wins: 0,
    losses: 0,
    blocked: 0,
    priceSourceLostCloses: 0,
    grossWinsUsd: 0,
    grossLossesUsd: 0,
    goplusBlocks: 0,
    holderFloorBlocks: 0,
    liquidityFloorBlocks: 0,
    sellSimBlocks: 0,
    sellSimTransient: 0,
    volumeBlocks: 0,
    gradChecks: 0,
    graduatesFound: 0,
    cooldownSkips: 0,
    reentrySkips: 0,
    bscCoinsSeen: 0,
    tradesToday: 0,
    tradeDay: null,
    worstLossPct: 0,
    halted: false,
    polls: 0,
    bnbPriceUsd: 0,
    clusterGateAvailable: true,
    clusterBlocks: 0,
    positions: [],
    seen: {},
    closedMints: {},
    blockedMints: {},
  };
}

const NUMERIC_KEYS: Array<keyof BscState> = [
  "equityUsd", "trades", "wins", "losses", "blocked", "priceSourceLostCloses",
  "grossWinsUsd", "grossLossesUsd", "goplusBlocks", "holderFloorBlocks",
  "liquidityFloorBlocks", "sellSimBlocks", "sellSimTransient", "volumeBlocks",
  "gradChecks", "graduatesFound", "cooldownSkips",
  "reentrySkips", "bscCoinsSeen", "tradesToday", "worstLossPct", "polls", "bnbPriceUsd", "clusterBlocks",
];

export function normalizeBscState(raw: Partial<BscState>): BscState {
  const s = { ...newBscState(), ...raw } as BscState;
  for (const k of NUMERIC_KEYS) {
    const v = (s as unknown as Record<string, unknown>)[k];
    (s as unknown as Record<string, unknown>)[k] = typeof v === "number" && Number.isFinite(v) ? v : 0;
  }
  if (!Array.isArray(s.positions)) s.positions = [];
  if (!s.seen || typeof s.seen !== "object") s.seen = {};
  if (!s.closedMints || typeof s.closedMints !== "object") s.closedMints = {};
  if (!s.blockedMints || typeof s.blockedMints !== "object") s.blockedMints = {};
  s.clusterGateAvailable = true;
  return s;
}

export function bscReadiness(state: BscState): { ready: boolean; reasons: string[]; winRate: number; profitFactor: number; priceLostPct: number } {
  const closed = state.wins + state.losses;
  const winRate = closed > 0 ? state.wins / closed : 0;
  const profitFactor = state.grossLossesUsd > 0 ? state.grossWinsUsd / state.grossLossesUsd : state.grossWinsUsd > 0 ? 99 : 0;
  const priceLostPct = closed > 0 ? state.priceSourceLostCloses / closed : 0;
  const priceClosed = closed - state.priceSourceLostCloses;
  const reasons: string[] = [];
  if (state.trades < 20) reasons.push("need >=20 trades, have " + state.trades);
  if (priceClosed < 10) reasons.push("need >=10 closed on price, have " + priceClosed);
  if (winRate < 0.4) reasons.push("win rate " + Math.round(winRate * 100) + "% < 40%");
  if (profitFactor < 1.2) reasons.push("profit factor " + profitFactor.toFixed(2) + " < 1.20");
  if (state.equityUsd < BSC_READINESS_EQUITY_USD) reasons.push("equity $" + state.equityUsd.toFixed(2) + " < $" + BSC_READINESS_EQUITY_USD.toFixed(2));
  if (priceLostPct > 0.1) reasons.push("price-source-lost closes " + Math.round(priceLostPct * 100) + "% > 10%");
  if ((state.worstLossPct ?? 0) <= -0.5) reasons.push("worst single-trade loss " + Math.round((state.worstLossPct ?? 0) * 100) + "% <= -50%");
  if (state.halted) reasons.push("daily loss halt triggered");
  return { ready: reasons.length === 0, reasons, winRate, profitFactor, priceLostPct };
}

function sastDate(nowMs: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Johannesburg", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(nowMs));
}

/** Lock dir with owner token + 5-min stale reclaim (same semantics
 * as the Solana spotter's acquireLock/releaseLock, local so the BSC
 * desk does not import the Solana spotter module). */
export function acquireBscLock(lockPath: string, staleMs = 5 * 60 * 1000): { held: boolean; reclaimed: boolean; token: string | null } {
  const token = process.pid + ":" + Math.random().toString(36).slice(2) + ":" + Date.now();
  const writeToken = (): boolean => {
    try {
      writeFileSync(join(lockPath, "owner"), token, "utf8");
      return true;
    } catch {
      return false;
    }
  };
  try {
    mkdirSync(lockPath);
  } catch {
    try {
      const before = statSync(lockPath);
      if (Date.now() - before.mtimeMs > staleMs) {
        const again = statSync(lockPath);
        if (again.ino === before.ino && again.mtimeMs === before.mtimeMs) {
          rmSync(lockPath, { recursive: true, force: true });
          mkdirSync(lockPath);
          if (!writeToken()) {
            try {
              rmSync(lockPath, { recursive: true, force: true });
            } catch {
              // Best effort.
            }
            return { held: false, reclaimed: false, token: null };
          }
          return { held: true, reclaimed: true, token };
        }
      }
    } catch {
      // Lost a race; treat as held by the other run.
    }
    return { held: false, reclaimed: false, token: null };
  }
  if (!writeToken()) {
    try {
      rmSync(lockPath, { recursive: true, force: true });
    } catch {
      // Best effort.
    }
    return { held: false, reclaimed: false, token: null };
  }
  return { held: true, reclaimed: false, token };
}

export function releaseBscLock(lockPath: string, token: string | null): void {
  if (!token) return;
  try {
    const owner = readFileSync(join(lockPath, "owner"), "utf8");
    if (owner !== token) return;
    rmSync(lockPath, { recursive: true, force: true });
  } catch {
    // Already gone.
  }
}

/**
 * Curve progress (0-100) from a Helper3 read, for the graduation
 * re-check ranking. -1 = "never measured" (curve null or missing
 * raised/threshold) — unmeasured tokens sort below measured ones.
 */
export function curveProgressPct(curve: CurveInfo | null): number {
  if (!curve || curve.raisedBnb === null || curve.thresholdBnb === null || curve.thresholdBnb <= 0) return -1;
  return Math.min(100, (curve.raisedBnb / curve.thresholdBnb) * 100);
}

/** Measured progress velocity (%/h) from the last two curve
 * readings: (current progress − previous progress) over the
 * time between the readings. Null when fewer than two readings
 * exist or the readings share a timestamp — the caller falls
 * back to the progress/age prior. Pure. */
export function progressVelocityPctPerHour(
  rec: { curveProgressPct?: number; lastCurveCheckMs?: number; lastProgressPct?: number; lastProgressMs?: number },
): number | null {
  const cur = rec.curveProgressPct;
  const prev = rec.lastProgressPct;
  const curMs = rec.lastCurveCheckMs;
  const prevMs = rec.lastProgressMs;
  if (cur === undefined || cur < 0 || prev === undefined || prev < 0) return null;
  if (curMs === undefined || prevMs === undefined) return null;
  const dtH = (curMs - prevMs) / 3_600_000;
  if (!(dtH > 0)) return null;
  return (cur - prev) / dtH;
}

/**
 * Effective re-check velocity (%/h) for a measured token: the
 * measured two-reading velocity when available, else the
 * progress/age prior — progress gained since first sight,
 * spread over at most the token's seen age (age floored at
 * 15 min so a just-seen high-progress token does not explode
 * the ranking). The prior is what bootstraps velocity for
 * legacy records and first readings: a token at 57% seen 6h
 * ago priors at ~9.6%/h and earns its second reading quickly;
 * a token at 0.01% priors near zero and does not. After the
 * second reading the measured velocity takes over. Pure.
 */
export function recheckVelocityPctPerHour(
  rec: { curveProgressPct?: number; firstSeenMs: number; lastCurveCheckMs?: number; lastProgressPct?: number; lastProgressMs?: number },
  nowMs: number,
): number {
  const measured = progressVelocityPctPerHour(rec);
  if (measured !== null) return measured;
  const progress = rec.curveProgressPct;
  if (progress === undefined || progress < 0) return 0;
  const ageH = Math.max((nowMs - rec.firstSeenMs) / 3_600_000, 0.25);
  return progress / ageH;
}

export type BscSeenRecord = BscState["seen"][string];

/**
 * Record one Helper3 curve reading on a seen record (shared by
 * the graduation re-check and the deep-check path, so both
 * maintain the same history). Shifts the previous progress
 * reading into lastProgressPct/lastProgressMs before storing
 * the new one, and runs the staleness decay: a reading that
 * moves progress by < BSC_PROGRESS_MOVE_MIN_PP increments
 * noMoveChecks; at BSC_NO_MOVE_CHECKS_LIMIT consecutive
 * no-move readings the token is deprioritized until
 * nowPoll + BSC_DEPRIORITIZE_POLLS and the counter resets, so
 * it becomes eligible again and can be deprioritized again if
 * still flat. A reading with no measurable progress leaves the
 * history untouched (no data is not evidence of stalling).
 * nowPoll is optional — without it the decay cannot arm, and
 * the record is updated without deprioritization. Pure apart
 * from mutating the passed record.
 */
export function recordCurveCheck(
  rec: BscSeenRecord,
  curve: CurveInfo | null,
  nowMs: number,
  nowPoll?: number,
): void {
  const progress = curveProgressPct(curve);
  if (progress >= 0) {
    const prev = rec.curveProgressPct;
    if (prev !== undefined && prev >= 0) {
      rec.lastProgressPct = prev;
      rec.lastProgressMs = rec.lastCurveCheckMs;
      if (progress - prev >= BSC_PROGRESS_MOVE_MIN_PP) {
        rec.noMoveChecks = 0;
      } else {
        rec.noMoveChecks = (rec.noMoveChecks ?? 0) + 1;
        if (rec.noMoveChecks >= BSC_NO_MOVE_CHECKS_LIMIT && nowPoll !== undefined) {
          rec.deprioritizeUntilPoll = nowPoll + BSC_DEPRIORITIZE_POLLS;
          rec.noMoveChecks = 0;
        }
      }
    }
    rec.curveProgressPct = progress;
  }
  if (curve?.raisedBnb !== null && curve?.raisedBnb !== undefined) rec.raisedBnb = curve.raisedBnb;
  if (curve?.graduated !== null && curve?.graduated !== undefined) rec.graduated = curve.graduated;
  rec.lastCurveCheckMs = nowMs;
}

/**
 * Graduation re-check candidates (pure — the caller does the
 * Helper3 fetches). P1+P4 (2026-11-24): the old progress-desc
 * rank re-checked the same top 4 tokens every poll while
 * 561/811 seen tokens were never curve-checked. The 4 slots
 * are now allocated as one coherent ranking:
 * - 2 progress slots: measured tokens ranked by effective
 *   velocity (Δprogress/hour, measured or progress/age prior),
 *   ties broken by progress desc, then recency. A token at 5%
 *   gaining 5%/h outranks a token at 50% flat for 6h.
 * - 1 round-robin slot: never-measured tokens, oldest
 *   firstSeen first — bootstraps the progress map.
 * - 1 stalest slot: measured tokens with the oldest
 *   lastCurveCheckMs — re-reads tokens whose data is old.
 * A token deprioritized by the staleness decay (no progress
 * movement in 12 consecutive checks) is ineligible for every
 * slot until its deprioritizeUntilPoll passes. Pools that are
 * empty backfill from the next-best eligible tokens so the
 * per-poll budget is still used.
 * - toCheck: seen tokens that have NOT graduated yet, first
 *   seen within 24h, not open, not closed in the last 30 min.
 * - alreadyGraduated: seen tokens already known graduated,
 *   first seen within 24h, not open, not closed recently, NOT
 *   in an active blocked-mint cooldown — worth a fresh
 *   deep-check because volume can arrive after graduation.
 * nowPoll is the state's poll counter; without it the
 * staleness decay is not applied (legacy callers).
 */
export function pickGradRecheckCandidates(
  seen: BscState["seen"],
  openAddrs: Set<string>,
  closedMints: Record<string, number>,
  blockedMints: Record<string, { blockedAtMs: number; mcUsd: number }>,
  nowMs: number,
  n = BSC_GRAD_RECHECK_PER_POLL,
  nowPoll?: number,
): { toCheck: string[]; alreadyGraduated: string[] } {
  type Entry = { address: string; rec: BscSeenRecord };
  const measured: Entry[] = [];
  const neverMeasured: Entry[] = [];
  const grad: Array<{ address: string; firstSeenMs: number }> = [];
  for (const [address, rec] of Object.entries(seen)) {
    const lower = address.toLowerCase();
    if (openAddrs.has(lower)) continue;
    if (nowMs - rec.firstSeenMs > BSC_GRAD_RECHECK_MAX_AGE_MS) continue;
    const closedAt = closedMints[address];
    if (closedAt !== undefined && nowMs - closedAt < BSC_REENTRY_COOLDOWN_MS) continue;
    if (rec.graduated === true) {
      const blockedRec = blockedMints[address];
      if (blockedRec && nowMs - blockedRec.blockedAtMs < BSC_BLOCKED_COOLDOWN_MS) continue;
      grad.push({ address, firstSeenMs: rec.firstSeenMs });
    } else {
      if (nowPoll !== undefined && rec.deprioritizeUntilPoll !== undefined && nowPoll < rec.deprioritizeUntilPoll) continue;
      const entry = { address, rec };
      if (rec.curveProgressPct !== undefined && rec.curveProgressPct >= 0) measured.push(entry);
      else neverMeasured.push(entry);
    }
  }
  // Progress slots: effective velocity desc, progress desc, recency.
  const byVelocity = [...measured].sort(
    (a, b) =>
      recheckVelocityPctPerHour(b.rec, nowMs) - recheckVelocityPctPerHour(a.rec, nowMs) ||
      (b.rec.curveProgressPct ?? -1) - (a.rec.curveProgressPct ?? -1) ||
      b.rec.firstSeenMs - a.rec.firstSeenMs,
  );
  // Round-robin: never-measured, oldest firstSeen first.
  const byFirstSeen = [...neverMeasured].sort((a, b) => a.rec.firstSeenMs - b.rec.firstSeenMs);
  // Stalest: measured, oldest lastCurveCheckMs first (missing = 0).
  const byStaleness = [...measured].sort(
    (a, b) => (a.rec.lastCurveCheckMs ?? 0) - (b.rec.lastCurveCheckMs ?? 0) || a.rec.firstSeenMs - b.rec.firstSeenMs,
  );
  const picked: string[] = [];
  const taken = new Set<string>();
  const take = (list: Entry[], count: number): void => {
    for (const e of list) {
      if (picked.length >= n) return;
      if (count <= 0) return;
      if (taken.has(e.address)) continue;
      taken.add(e.address);
      picked.push(e.address);
      count -= 1;
    }
  };
  take(byVelocity, BSC_RECHECK_PROGRESS_SLOTS);
  take(byFirstSeen, BSC_RECHECK_ROUND_ROBIN_SLOTS);
  take(byStaleness, BSC_RECHECK_STALEST_SLOTS);
  // Backfill: any designated pool may be empty (e.g. no
  // never-measured tokens left) — fill the budget from the
  // next-best measured by velocity, then never-measured by age.
  take(byVelocity, n - picked.length);
  take(byFirstSeen, n - picked.length);
  grad.sort((a, b) => b.firstSeenMs - a.firstSeenMs);
  return { toCheck: picked, alreadyGraduated: grad.slice(0, n).map((r) => r.address) };
}

/** Build the volume-gate inputs for one deep-checked candidate from
 * the DexScreener pair + the GeckoTerminal snapshot carried on the
 * candidate (DexScreener volume primary; the GT snapshot is the
 * fallback when DexScreener carries no volume — pre-grad four.meme
 * pairs return volume {}). Traders are null when the candidate was
 * not discovered via GeckoTerminal (graduation re-check) — the
 * volume module falls back to txn counts. */
export function volumeInputsForCandidate(cand: BscCandidate, dex: DexBscPair, nowMs: number): VolumeInputs {
  return {
    volM5Usd: dex.volM5Usd ?? cand.volM5Usd ?? null,
    volH1Usd: dex.volH1Usd ?? cand.volH1Usd ?? null,
    tradersH1: cand.tradersH1 ?? null,
    buysH1: dex.txnsH1.buys,
    sellsH1: dex.txnsH1.sells,
    buysM5: dex.txnsM5.buys,
    sellsM5: dex.txnsM5.sells,
    liquidityUsd: dex.liquidityUsd,
    priceChangeH1Pct: dex.priceChangeH1Pct,
    pairAgeH: dex.pairCreatedAtMs !== null ? (nowMs - dex.pairCreatedAtMs) / 3_600_000 : null,
  };
}

export interface BscPollSummary {
  candidatesSeen: number;
  deepChecked: number;
  blocked: number;
  entered: number;
  closed: number;
  halted: boolean;
  /** v2: Helper3 graduation re-checks this poll + newly-graduated found. */
  gradRechecks: number;
  graduatesFound: number;
  /** v2: graduated candidates blocked by the volume gates. */
  volumeBlocks: number;
  /** v3: would-be entries blocked by the cluster gate. */
  clusterBlocks: number;
}

/**
 * Rank discovery candidates by mc velocity vs their first-seen mc
 * (GeckoTerminal fdv now vs seen.firstMcUsd). Pure.
 *
 * Why this exists: page 1 alone is ~10-20 min of launches, and a
 * minutes-old token has no velocity and ~1 buy — it scores ~46,
 * below the 60 fresh bar, every time (first live poll: 8/8 blocked
 * at exactly 46). Ranking by velocity surfaces the tokens that
 * already moved since first sight, the same idea as the Solana
 * spotter's velocity-first ranker. Unseen tokens score velocity 0
 * and rank last — they still get checked when the slice has room.
 */
export function rankBscCandidates(
  candidates: BscCandidate[],
  seen: Record<string, { firstMcUsd: number; firstSeenMs: number }>,
): BscCandidate[] {
  const velocity = (c: BscCandidate): number => {
    const first = seen[c.address]?.firstMcUsd ?? 0;
    const now = c.fdvUsd ?? 0;
    return first > 0 && now > 0 ? ((now - first) / first) * 100 : 0;
  };
  return [...candidates].sort((a, b) => velocity(b) - velocity(a) || b.createdAtMs - a.createdAtMs);
}

function block(state: BscState, address: string, reason: string, mcUsd: number, nowMs: number, counter?: "goplus" | "holder" | "liquidity" | "sellSim", extra?: Record<string, number | null | boolean>): void {
  state.blocked += 1;
  if (counter === "goplus") state.goplusBlocks += 1;
  if (counter === "holder") state.holderFloorBlocks += 1;
  if (counter === "liquidity") state.liquidityFloorBlocks += 1;
  if (counter === "sellSim") state.sellSimBlocks += 1;
  state.blockedMints[address] = { blockedAtMs: nowMs, mcUsd };
  appendJournal(BSC_JOURNAL_PATH, journalEntry(address, "blocked", reason, { equityUsd: state.equityUsd, ...(extra ? { extra } : {}) }));
}

function settleClose(
  state: BscState,
  pos: BscPosition,
  fraction: number,
  mcUsd: number,
  reason: string,
  nowMs: number,
  priceSourceLost: boolean,
): number {
  // Realised P&L on the closed fraction: proceeds at current mc
  // minus cost basis minus the sell-leg fee. Equity is book value:
  // only P&L moves it (entry deducted the buy fee only).
  const costBasis = pos.sizeUsd * fraction;
  const grossProceeds = costBasis * (mcUsd / pos.entryMcUsd);
  // The sell leg charges the same per-token minimum the entry was
  // evaluated at (fee flip, 2026-11-24); pre-flip positions fall
  // back to the conservative 0.001 BNB.
  const sellFeeUsd = legCostBnb(grossProceeds / state.bnbPriceUsd, pos.graduatedAtEntry, BSC_FEES, pos.minFeeBnbAtEntry ?? BSC_FEES.platformFeeMinBnb) * state.bnbPriceUsd;
  const realised = grossProceeds - costBasis - sellFeeUsd;
  state.equityUsd += realised;
  if (realised >= 0) state.grossWinsUsd += realised;
  else state.grossLossesUsd += -realised;
  const lossPct = realised / costBasis;
  if (lossPct < (state.worstLossPct ?? 0)) state.worstLossPct = lossPct;
  if (priceSourceLost) state.priceSourceLostCloses += 1;
  appendJournal(
    BSC_JOURNAL_PATH,
    journalEntry(pos.address, "paper_close", reason + `, realised $${realised.toFixed(4)} (fees $${sellFeeUsd.toFixed(4)})`, {
      sizeUsd: pos.sizeUsd,
      price: mcUsd,
      feesUsd: sellFeeUsd,
      equityUsd: state.equityUsd,
      entryThesis: pos.entryThesis,
      sizePct: pos.sizePctAtEntry ?? null,
    }),
  );
  return realised;
}

export async function runBscPoll(state: BscState, nowMs = Date.now()): Promise<BscPollSummary> {
  const summary: BscPollSummary = { candidatesSeen: 0, deepChecked: 0, blocked: 0, entered: 0, closed: 0, halted: state.halted, gradRechecks: 0, graduatesFound: 0, volumeBlocks: 0, clusterBlocks: 0 };
  if (state.halted) return summary;
  state.polls += 1;

  // Trade-day rollover (SAST).
  const today = sastDate(nowMs);
  if (state.tradeDay !== today) {
    state.tradeDay = today;
    state.tradesToday = 0;
  }

  // BNB price first: fail-closed without it (no position can be sized).
  const bnbPrice = await fetchBnbPriceUsd();
  if (!(bnbPrice && bnbPrice > 0)) {
    appendJournal(BSC_JOURNAL_PATH, journalEntry("bsc-spotter", "poll_failed", "BNB price unavailable, fail-closed", { equityUsd: state.equityUsd }));
    return summary;
  }
  state.bnbPriceUsd = bnbPrice;

  // --- Price open positions (same exit ladder as Solana) ---
  const stillOpen: BscPosition[] = [];
  for (const pos of state.positions) {
    const dex = await fetchDexPair(pos.address);
    let mcUsd: number | null = dex?.marketCapUsd ?? dex?.fdvUsd ?? null;
    if (mcUsd === null) {
      // Fallback: Helper3 curve price x 1e9 supply x BNB price.
      const curve = await fetchCurveInfo(pos.address);
      if (curve && curve.priceBnb !== null && curve.priceBnb !== undefined) {
        mcUsd = curve.priceBnb * 1_000_000_000 * bnbPrice;
      }
    }
    if (mcUsd === null || !(mcUsd > 0)) {
      pos.missedPolls += 1;
      if (pos.missedPolls >= 2) {
        const realised = settleClose(state, pos, pos.position.remainingFraction, pos.lastMcUsd, "price source lost", nowMs, true);
        if (realised >= 0) state.wins += 1;
        else state.losses += 1;
        state.closedMints[pos.address] = nowMs;
        summary.closed += 1;
        continue;
      }
      stillOpen.push(pos);
      continue;
    }
    pos.missedPolls = 0;
    pos.lastMcUsd = mcUsd;
    const decision = evaluateExit(pos.position, { price: mcUsd, atMs: nowMs }, BSC_PROFILE);
    if (decision.action === "hold") {
      stillOpen.push(pos);
      continue;
    }
    if (decision.action === "partial") {
      const realised = settleClose(state, pos, decision.fraction, mcUsd, decision.reason, nowMs, false);
      if (realised >= 0) state.wins += 1;
      else state.losses += 1;
      pos.position = applyExit(pos.position, decision, { price: mcUsd, atMs: nowMs });
      stillOpen.push(pos);
      continue;
    }
    // Full close.
    const realised = settleClose(state, pos, pos.position.remainingFraction, mcUsd, decision.reason, nowMs, false);
    if (realised >= 0) state.wins += 1;
    else state.losses += 1;
    state.closedMints[pos.address] = nowMs;
    summary.closed += 1;
  }
  state.positions = stillOpen;

  // --- Daily-loss halt (run-start based, mirrors the Solana code) ---
  if (state.equityUsd <= BSC_HALT_EQUITY_USD) {
    for (const pos of state.positions) {
      const realised = settleClose(state, pos, pos.position.remainingFraction, pos.lastMcUsd, "halt settle", nowMs, false);
      if (realised >= 0) state.wins += 1;
      else state.losses += 1;
      state.closedMints[pos.address] = nowMs;
    }
    state.positions = [];
    state.halted = true;
    summary.halted = true;
    appendJournal(BSC_JOURNAL_PATH, journalEntry("bsc-spotter", "halt", `daily loss halt: equity $${state.equityUsd.toFixed(4)} <= $${BSC_HALT_EQUITY_USD.toFixed(2)}`, { equityUsd: state.equityUsd }));
    return summary;
  }

  // --- Discovery A: four.meme new pools (2 pages, ~30-60 min of
  // launches). Discovery B (v2, P3 2026-11-24: 4 pages, ~30 min
  // of fresh PancakeSwap V2 pools — doubles the graduate-catch
  // window from ~3 polls to ~6 polls for +2 free GeckoTerminal
  // calls/poll): the graduated-token feed, Helper3-filtered below
  // (most PCS pools are NOT four.meme graduates). B failing
  // never kills A.
  const [resA, resB] = await Promise.allSettled([fetchNewFourMemePoolsPages(2), fetchNewPancakePoolsPages(4)]);
  if (resA.status === "rejected") {
    appendJournal(BSC_JOURNAL_PATH, journalEntry("bsc-spotter", "poll_failed", "GeckoTerminal discovery failed: " + (resA.reason instanceof Error ? resA.reason.message : String(resA.reason)), { equityUsd: state.equityUsd }));
    return summary;
  }
  const candidatesA = resA.value;
  const candidatesB = resB.status === "fulfilled" ? resB.value : [];
  if (resB.status === "rejected") {
    appendJournal(BSC_JOURNAL_PATH, journalEntry("bsc-spotter", "discovery_b_failed", "PancakeSwap discovery failed, continuing with four.meme only: " + (resB.reason instanceof Error ? resB.reason.message : String(resB.reason)), { equityUsd: state.equityUsd }));
  }
  const candidates = [...candidatesA, ...candidatesB];
  summary.candidatesSeen = candidates.length;
  state.bscCoinsSeen += candidates.length;
  // Record first sight BEFORE ranking (velocity needs the baseline).
  for (const c of candidates) {
    if (!state.seen[c.address]) {
      state.seen[c.address] = { firstMcUsd: c.fdvUsd ?? 0, firstSeenMs: nowMs, poolAddress: c.poolAddress };
    } else if (!state.seen[c.address].poolAddress && c.poolAddress) {
      state.seen[c.address].poolAddress = c.poolAddress;
    }
  }
  const openAddrs = new Set(state.positions.map((p) => p.address.toLowerCase()));

  // --- Graduation re-check (v2, P1+P4 2026-11-24): re-read
  // Helper3 for up to 4 seen tokens — 2 by progress velocity,
  // 1 never-measured round-robin, 1 stalest (see
  // pickGradRecheckCandidates). A token that flips to
  // graduated=1 joins the slice and bypasses the blocked-mint
  // cooldown ONCE (regime changed — all gates re-run).
  const { toCheck: recheckAddrs, alreadyGraduated } = pickGradRecheckCandidates(state.seen, openAddrs, state.closedMints, state.blockedMints, nowMs, BSC_GRAD_RECHECK_PER_POLL, state.polls);
  const newlyGraduated: string[] = [];
  for (const addr of recheckAddrs) {
    state.gradChecks += 1;
    const curve = await fetchCurveInfo(addr);
    const rec = state.seen[addr];
    if (!rec) continue;
    const wasGraduated = rec.graduated === true;
    recordCurveCheck(rec, curve, nowMs, state.polls);
    if (curve?.graduated === true && !wasGraduated) {
      newlyGraduated.push(addr);
      state.graduatesFound += 1;
    }
  }
  summary.gradRechecks = recheckAddrs.length;
  summary.graduatesFound = newlyGraduated.length;
  const recheckGraduated = new Set(newlyGraduated.map((a) => a.toLowerCase()));

  // Slice: graduated re-check candidates FIRST (highest value),
  // then discovery ranked by mc velocity vs first sight.
  const slice: BscCandidate[] = [];
  for (const addr of [...newlyGraduated, ...alreadyGraduated]) {
    const rec = state.seen[addr];
    if (!rec) continue;
    slice.push({
      address: addr, name: addr.slice(0, 10), symbol: "", poolAddress: rec.poolAddress ?? "",
      createdAtMs: rec.firstSeenMs, fdvUsd: rec.firstMcUsd, priceUsd: null, priceNativeBnb: null,
      volM5Usd: null, volH1Usd: null, tradersH1: null, buysH1: null, sellsH1: null, priceChangeH1Pct: null,
    });
  }
  const bAddrs = new Set(candidatesB.map((c) => c.address.toLowerCase()));
  for (const cand of rankBscCandidates(candidates, state.seen).filter((c) => !openAddrs.has(c.address.toLowerCase()))) {
    if (slice.length >= BSC_SLICE_CANDIDATES) break;
    if (bAddrs.has(cand.address.toLowerCase())) {
      // Discovery B pre-filter: a Helper3 read that says
      // graduated=false means NOT a four.meme token — drop it
      // before it consumes deep-check budget. Curve null keeps the
      // candidate (the deep-check fails closed on it).
      const curve = await fetchCurveInfo(cand.address);
      state.gradChecks += 1;
      if (curve && curve.graduated === false) continue;
    }
    slice.push(cand);
  }

  // Prune stale cooldown records (24h).
  for (const [addr, rec] of Object.entries(state.blockedMints)) {
    if (nowMs - rec.blockedAtMs > 24 * 60 * 60 * 1000) delete state.blockedMints[addr];
  }
  for (const [addr, at] of Object.entries(state.closedMints)) {
    if (nowMs - at > 24 * 60 * 60 * 1000) delete state.closedMints[addr];
  }

  for (const cand of slice) {
    // Blocked-mint cooldown (60 min flat, v1 — no mc-rise exception).
    // Exception: a token that JUST graduated (re-check transition)
    // bypasses it once — its regime changed and all gates re-run.
    const blockedRec = state.blockedMints[cand.address];
    if (blockedRec && nowMs - blockedRec.blockedAtMs < BSC_BLOCKED_COOLDOWN_MS && !recheckGraduated.has(cand.address.toLowerCase())) {
      state.cooldownSkips += 1;
      appendJournal(BSC_JOURNAL_PATH, journalEntry(cand.address, "cooldown_skip", "blocked recently, skipping re-check", { equityUsd: state.equityUsd }));
      continue;
    }
    // Re-entry cooldown (30 min after a close).
    const closedAt = state.closedMints[cand.address];
    if (closedAt !== undefined && nowMs - closedAt < BSC_REENTRY_COOLDOWN_MS) {
      state.reentrySkips += 1;
      continue;
    }
    // Deep-check budget: skips above do not consume it. No room for
    // a new position (3 open or 15 trades today) ends the loop.
    if (state.positions.length >= BSC_PROFILE.maxOpenPositions || state.tradesToday >= BSC_PROFILE.maxTradesPerDay) break;
    if (summary.deepChecked >= BSC_SLICE) break;
    summary.deepChecked += 1;

    // Gate 1: GoPlus (fail-closed on no data).
    const sec = await fetchGoPlus(cand.address);
    if (!sec) {
      block(state, cand.address, "goplus_unavailable (fail-closed: no GoPlus data)", cand.fdvUsd ?? 0, nowMs, "goplus");
      summary.blocked += 1;
      continue;
    }
    const verdict = goplusVerdict(sec);
    if (verdict.verdict === "block") {
      block(state, cand.address, "goplus blocked: " + verdict.failed.join(", "), cand.fdvUsd ?? 0, nowMs, "goplus");
      summary.blocked += 1;
      continue;
    }

    // Gate 2: DexScreener pair must exist.
    const dex = await fetchDexPair(cand.address);
    if (!dex) {
      block(state, cand.address, "no dex pair on DexScreener", cand.fdvUsd ?? 0, nowMs);
      summary.blocked += 1;
      continue;
    }
    const mcUsd = dex.marketCapUsd ?? dex.fdvUsd ?? cand.fdvUsd ?? 0;
    if (!(mcUsd > 0)) {
      block(state, cand.address, "no market cap from any source", 0, nowMs);
      summary.blocked += 1;
      continue;
    }

    // Curve info + STRICT graduation (v2): Helper3 graduated=true
    // is required. The v1 dexId/GoPlus fallbacks are removed — they
    // admitted non-four.meme tokens as graduated. Curve-null +
    // fourmeme-dexId still reads pre-grad (a four.meme pool is
    // pre-grad by construction); curve-null + any other dexId
    // blocks fail-closed (origin unconfirmed).
    const curve = await fetchCurveInfo(cand.address);
    // Store curve progress for the graduation re-check (shared
    // helper: maintains the velocity history + staleness decay).
    const seenRec = state.seen[cand.address];
    if (seenRec) recordCurveCheck(seenRec, curve, nowMs, state.polls);
    let graduated: boolean;
    if (curve && curve.graduated !== null && curve.graduated !== undefined) {
      graduated = curve.graduated;
    } else if (dex.dexId === "fourmeme") {
      graduated = false;
    } else {
      block(state, cand.address, "curve info unavailable (fail-closed: graduation unconfirmed)", mcUsd, nowMs);
      summary.blocked += 1;
      continue;
    }

    // Gate 3: VOLUME gates (v2) + fee bar. The volume verdict is
    // evaluated for EVERY candidate and journaled either way;
    // graduated tokens must PASS it. Pre-grad tokens pass the fee
    // bar on their OWN on-chain minimum (fee flip, 2026-11-24):
    // Helper3 reports minTradingFee 0 on classic launches, so a
    // $3.30 pre-grad position breaks even at ~7.7% and passes the
    // 25% bar — the binding pre-grad filter is now the activity
    // floor below (h1 volume >= $5 AND h1 traders >= 2), not the
    // fee. A token whose Helper3 read is missing or shows a
    // non-1% rate falls back to the 0.001 BNB minimum and stays
    // fee-blocked at $15.
    let sizeUsd = state.equityUsd * BSC_PROFILE.startPositionPct;
    let positionBnb = sizeUsd / bnbPrice;
    const vol = volumeVerdict(volumeInputsForCandidate(cand, dex, nowMs));
    const volExtra = volumeJournalExtra(vol);
    // Graduated tokens pay the PancakeSwap 0.25% pool fee — no
    // platform minimum applies, so no per-token resolution.
    const feeInfo = graduated ? null : resolveMinFeeBnb(curve);
    const minFeeBnb = feeInfo?.minFeeBnb ?? BSC_FEES.platformFeeMinBnb;
    const feeNote = graduated
      ? "graduated (PancakeSwap 0.25%, no platform minimum)"
      : `minFee ${feeInfo!.minFeeBnb} BNB (${feeInfo!.source})`;
    const be = breakEvenGrossPct(positionBnb, graduated, BSC_FEES, minFeeBnb);
    const fixedPct = fixedCostPctOfPosition(positionBnb, graduated, BSC_FEES, minFeeBnb);
    if (graduated && !vol.pass) {
      state.volumeBlocks += 1;
      summary.volumeBlocks += 1;
      block(state, cand.address, "volume gates failed: " + vol.failed.join("; ") + ` (volume score ${vol.score})`, mcUsd, nowMs, undefined, volExtra);
      summary.blocked += 1;
      continue;
    }
    // Pre-graduation activity floor (2026-11-24): the fee flip
    // removed the fee bar as the pre-grad filter (minFee 0 on
    // classic launches) and the v2 volume gates apply to graduated
    // tokens only — so a minutes-old token with $0 volume and 1
    // buy could enter (the desk's first 2 entries did exactly
    // that, 20:33 SAST). Pre-grad candidates must show >= $5 h1
    // volume AND >= 2 h1 traders; null/unknown fails closed.
    // Graduated tokens skip this (their volume gates already apply).
    if (!graduated) {
      const floor = pregradActivityFloor(vol.metrics);
      if (!floor.pass) {
        block(state, cand.address, floor.reason!, mcUsd, nowMs, undefined, volExtra);
        summary.blocked += 1;
        continue;
      }
    }
    if (be >= BSC_PROFILE.minBreakEvenGrossPct) {
      block(state, cand.address, `modelled break-even ${Math.round(be * 100)}% >= min ${Math.round(BSC_PROFILE.minBreakEvenGrossPct * 100)}%${graduated ? "" : " (pre-graduation)"} [${feeNote}] (volume score ${vol.score}${vol.pass ? ", volume gates pass" : ", volume gates: " + vol.failed.join("; ")})`, mcUsd, nowMs, undefined, volExtra);
      summary.blocked += 1;
      continue;
    }
    if (fixedPct > BSC_PROFILE.maxFixedCostPctOfPosition) {
      block(state, cand.address, `fixed costs ${Math.round(fixedPct * 100)}% > max ${Math.round(BSC_PROFILE.maxFixedCostPctOfPosition * 100)}% of position [${feeNote}] (volume score ${vol.score})`, mcUsd, nowMs, undefined, volExtra);
      summary.blocked += 1;
      continue;
    }

    // Gate 4: holder floor — graduated only (pre-grad ~2 holders is structural).
    if (graduated) {
      if (sec.holderCount === null) {
        block(state, cand.address, "holder count unknown (fail-closed)", mcUsd, nowMs, "holder", volExtra);
        summary.blocked += 1;
        continue;
      }
      if (sec.holderCount < BSC_HOLDER_FLOOR) {
        // v2 staleness fallback: GoPlus holder counts lag by hours
        // for fresh graduates (0-3 holders observed on tokens with
        // 50-614 live traders). >= 50 unique h1 traders is live
        // distribution evidence that contradicts a stale low count.
        const traders = vol.metrics.tradersH1 ?? 0;
        if (traders < VOL_TRADER_BREADTH_FOR_HOLDER_FLOOR) {
          block(state, cand.address, `holders ${sec.holderCount} < floor ${BSC_HOLDER_FLOOR} (live traders ${traders} < ${VOL_TRADER_BREADTH_FOR_HOLDER_FLOOR}, GoPlus count not stale enough to override)`, mcUsd, nowMs, "holder", volExtra);
          summary.blocked += 1;
          continue;
        }
        appendJournal(BSC_JOURNAL_PATH, journalEntry(cand.address, "holder_floor_fallback", `GoPlus holders ${sec.holderCount} < floor ${BSC_HOLDER_FLOOR} but ${traders} unique h1 traders — live breadth overrides stale GoPlus count`, { equityUsd: state.equityUsd, extra: volExtra }));
      }
    }

    // Gate 5: liquidity floor — graduated only (pre-grad has no pool liquidity).
    if (graduated) {
      if (dex.liquidityUsd === null) {
        block(state, cand.address, "liquidity unknown (fail-closed)", mcUsd, nowMs, "liquidity", volExtra);
        summary.blocked += 1;
        continue;
      }
      if (dex.liquidityUsd < BSC_LIQUIDITY_FLOOR_USD) {
        block(state, cand.address, `liquidity $${Math.round(dex.liquidityUsd)} < floor $${BSC_LIQUIDITY_FLOOR_USD}`, mcUsd, nowMs, "liquidity", volExtra);
        summary.blocked += 1;
        continue;
      }
    }

    // Gate 6: sell-sim.
    const priceUsd = dex.priceUsd ?? (curve?.priceBnb !== null && curve?.priceBnb !== undefined ? curve.priceBnb * bnbPrice : null);
    if (priceUsd === null || !(priceUsd > 0)) {
      block(state, cand.address, "sell-sim: no price to quote against", mcUsd, nowMs, "sellSim", volExtra);
      summary.blocked += 1;
      continue;
    }
    const positionTokens = sizeUsd / priceUsd;
    if (!graduated) {
      // Pre-graduation: sell into the curve at the Helper3 price
      // minus the 1% platform fee. No curve price = no quote = block.
      if (curve?.priceBnb === null || curve?.priceBnb === undefined || !(curve.priceBnb > 0)) {
        block(state, cand.address, "sell-sim: no curve price (Helper3)", mcUsd, nowMs, "sellSim", volExtra);
        summary.blocked += 1;
        continue;
      }
      const quotedBnb = positionTokens * curve.priceBnb * 0.99;
      if (!(quotedBnb > 0)) {
        block(state, cand.address, "sell-sim: curve quote zero", mcUsd, nowMs, "sellSim", volExtra);
        summary.blocked += 1;
        continue;
      }
    } else {
      const expectedBnb = positionTokens * (dex.priceNativeBnb ?? 0);
      const quotedBnb = await quotePancakeSell(cand.address, positionTokens);
      if (quotedBnb === null) {
        block(state, cand.address, "sell-sim: PancakeSwap quote unavailable (no route or RPC error)", mcUsd, nowMs, "sellSim", volExtra);
        summary.blocked += 1;
        continue;
      }
      if (expectedBnb > 0 && quotedBnb < 0.5 * expectedBnb) {
        block(state, cand.address, `sell-sim: quoted ${quotedBnb.toFixed(6)} BNB < 50% of expected ${expectedBnb.toFixed(6)} BNB`, mcUsd, nowMs, "sellSim", volExtra);
        summary.blocked += 1;
        continue;
      }
    }

    // Gate 7: funder-cluster gate (v3, NodeReal) — runs ONLY on
    // would-be entries, after every other gate has passed.
    // Clustered -> BLOCK. Any RPC failure -> BLOCK (fail-closed).
    // Unknown-heavy (>= half of checked holders unresolvable) ->
    // entry size x 0.75 + a cluster_unknown journal line (NOT a
    // block — deliberate divergence from Solana v2.18; the BSC
    // funder leg is noisier. See bsc-cluster.ts).
    let clusterVerdict = "cluster not checked";
    let clusterSizeMultiplier = 1;
    try {
      const cluster = await checkBscCluster(cand.address, { pairAddress: dex.pairAddress ?? null });
      clusterVerdict = `cluster ${cluster.verdict} (${cluster.checked} checked, ${cluster.funded} funded, ${cluster.unknown} unknown, linked ${cluster.linkedPct.toFixed(1)}%, ${cluster.callsMade} rpc calls)`;
      appendJournal(BSC_JOURNAL_PATH, journalEntry(cand.address, "cluster_check", `${clusterVerdict} — ${cluster.reason}`, { equityUsd: state.equityUsd, extra: { ...volExtra, clusterChecked: cluster.checked, clusterUnknown: cluster.unknown, clusterLinkedPct: cluster.linkedPct, clusterCalls: cluster.callsMade } }));
      if (cluster.clustered) {
        state.clusterBlocks += 1;
        summary.clusterBlocks += 1;
        block(state, cand.address, `cluster gate: ${cluster.reason}`, mcUsd, nowMs, undefined, volExtra);
        summary.blocked += 1;
        continue;
      }
      if (cluster.unknown > 0 && cluster.unknown >= Math.ceil(cluster.checked / 2)) {
        clusterSizeMultiplier = 0.75;
        appendJournal(BSC_JOURNAL_PATH, journalEntry(cand.address, "cluster_unknown", `unknown-heavy cluster check (${cluster.unknown}/${cluster.checked} holders unresolvable) — entry size x0.75`, { equityUsd: state.equityUsd }));
      }
    } catch (err) {
      state.clusterBlocks += 1;
      summary.clusterBlocks += 1;
      block(state, cand.address, `cluster gate failed (fail-closed): ${err instanceof Error ? err.message : String(err)}`, mcUsd, nowMs, undefined, volExtra);
      summary.blocked += 1;
      continue;
    }
    if (clusterSizeMultiplier !== 1) {
      // Break-even / fixed-cost / sell-sim were evaluated at full
      // size (the sell-sim side is conservative — a larger size is
      // the harder exit); the charged buy fee is recomputed at the
      // haircut size below via positionBnb.
      sizeUsd *= clusterSizeMultiplier;
      positionBnb = sizeUsd / bnbPrice;
    }

    // --- Entry ---
    const buyFeeUsd = legCostBnb(positionBnb, graduated, BSC_FEES, minFeeBnb) * bnbPrice;
    state.equityUsd -= buyFeeUsd;
    const sizePct = Math.round((sizeUsd / state.equityUsd) * 100);
    const thesis = `goplus ${verdict.verdict}${verdict.warned.length > 0 ? " (" + verdict.warned.join(",") + ")" : ""}, volume score ${vol.score} (m5 $${vol.metrics.volM5Usd !== null ? Math.round(vol.metrics.volM5Usd) : "?"} / h1 $${vol.metrics.volH1Usd !== null ? Math.round(vol.metrics.volH1Usd) : "?"}, heat ${vol.metrics.heat !== null ? vol.metrics.heat.toFixed(1) + "x" : "?"}, buys/sells ${dex.txnsH1.buys}/${dex.txnsH1.sells}, traders ${vol.metrics.tradersH1 ?? "?"}), break-even ${Math.round(be * 100)}% [${feeNote}], ${graduated ? "graduated" : "pre-graduation"}, raised ${curve?.raisedBnb !== null && curve?.raisedBnb !== undefined ? curve.raisedBnb.toFixed(4) + " BNB" : "unknown"} / threshold ${curve?.thresholdBnb !== null && curve?.thresholdBnb !== undefined ? curve.thresholdBnb.toFixed(1) + " BNB" : "unknown"}, ${clusterVerdict}${clusterSizeMultiplier !== 1 ? ", size x0.75 (cluster_unknown)" : ""}`;
    const position = openPosition(cand.address, cand.address, mcUsd, sizeUsd, nowMs);
    state.positions.push({
      id: cand.address + ":" + nowMs,
      address: cand.address,
      name: cand.name,
      entryMcUsd: mcUsd,
      sizeUsd,
      openedAtMs: nowMs,
      position,
      lastMcUsd: mcUsd,
      missedPolls: 0,
      entryThesis: thesis,
      sizePctAtEntry: sizePct,
      graduatedAtEntry: graduated,
      minFeeBnbAtEntry: feeInfo?.minFeeBnb ?? undefined,
    });
    state.trades += 1;
    state.tradesToday += 1;
    summary.entered += 1;
    appendJournal(
      BSC_JOURNAL_PATH,
      journalEntry(cand.address, "paper_entry", `${thesis}, size ${sizePct}%`, {
        score: vol.score,
        extra: { ...volExtra, clusterSizeMultiplier, ...(feeInfo ? { minFeeBnb: feeInfo.minFeeBnb, minFeeSource: feeInfo.source } : {}) },
        sizeUsd,
        price: mcUsd,
        feesUsd: buyFeeUsd,
        equityUsd: state.equityUsd,
        firstMcUsd: state.seen[cand.address].firstMcUsd,
        liquidityUsd: dex.liquidityUsd ?? undefined,
        tokenAgeMin: dex.pairCreatedAtMs !== null ? Math.round((nowMs - dex.pairCreatedAtMs) / 60000) : null,
        entryThesis: thesis,
        sizePct,
      }),
    );
  }

  return summary;
}
