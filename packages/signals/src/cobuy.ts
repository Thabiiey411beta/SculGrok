/**
 * Co-buy wallet clustering (v2.15, million-inspired: "wallets that
 * keep entering the same tokens together are merged into one owner").
 *
 * For a candidate mint, the helper (apps/coordinator/src/cobuy-check.py)
 * reads the token's Helius Enhanced Transactions up to entry time and
 * groups token ACQUISITIONS by slot (a buy = a mint transfer FROM the
 * bonding curve / a router TO a regular wallet). A slot in which several
 * distinct wallets acquire the token together is a coordinated buy —
 * the signature of a bundle / same-slot group buying in before the
 * desk does.
 *
 * This module is the PURE analysis + the execFile wrapper. The flag
 * rule is provisional (see the constants below): the historical replay
 * could not reach the pre-entry window of the high-volume wins (the
 * Helius enhanced-tx endpoint pages newest-first, so reaching a
 * minutes-old window hours later means paging through 6,000+ txs, and
 * the free tier 429'd mid-collection), so the flag is wired as a
 * LOGGED signal first and calibrated on live entries. It NEVER blocks
 * an entry on its own — see the replay numbers in
 * hidden_files/million-build-20261123.md.
 */
import { execFile } from "node:child_process";

export interface CoBuySlotGroup {
  slot: number;
  acquirers: string[];
  amount: number;
}

export interface CoBuyTopHolderPair {
  a: string;
  b: string;
  sameSlot: number[];
  nearSlot: [number, number][];
}

/** JSON the cobuy-check.py helper prints on stdout. */
export interface CoBuyResult {
  mint: string;
  txsAnalyzed: number;
  fetched: number;
  pages: number;
  reachedBefore: boolean;
  windowStartTs: number | null;
  windowEndTs: number;
  distinctAcquirers: number;
  totalAcquisitions: number;
  totalAmount: number;
  maxAcquirersInSlot: number;
  topSlot: CoBuySlotGroup | null;
  topAcquirerShare: number;
  slotGroups: CoBuySlotGroup[];
  topHolderCoBuy: { pairs: CoBuyTopHolderPair[]; maxTopHoldersInSlot: number } | null;
}

export interface CoBuyFeatures {
  /** False when the helper could not page back to entry time: the
   * features are then a partial-window sample, not the full window. */
  reachedBefore: boolean;
  txsAnalyzed: number;
  distinctAcquirers: number;
  totalAcquisitions: number;
  maxAcquirersInSlot: number;
  /** Share of all early buy volume that landed in the single busiest
   * slot (0-1). A coordinated group buys in one slot. */
  topSlotShare: number;
  /** Share of all early buy volume taken by the single biggest buyer. */
  topAcquirerShare: number;
  /** Most top holders (Rugcheck topHolders) that acquired in one slot. */
  maxTopHoldersInSlot: number;
  topHolderPairs: number;
}

/** Provisional flag thresholds — NOT yet validated on a win/rug
 * replay (see the module doc). A flag is journaled, never a block.
 * Calibrate on the live entries this signal logs before promoting. */
export const COBUY_MIN_ACQUIRERS_IN_SLOT = 3;
export const COBUY_MIN_TOP_SLOT_SHARE = 0.25;
export const COBUY_MIN_TOP_HOLDERS_SHARED_SLOT = 3;

/** Pure feature computation from a helper result. */
export function analyzeCoBuy(result: CoBuyResult): CoBuyFeatures {
  const topSlotShare =
    result.topSlot && result.totalAmount > 0 ? result.topSlot.amount / result.totalAmount : 0;
  return {
    reachedBefore: result.reachedBefore,
    txsAnalyzed: result.txsAnalyzed,
    distinctAcquirers: result.distinctAcquirers,
    totalAcquisitions: result.totalAcquisitions,
    maxAcquirersInSlot: result.maxAcquirersInSlot,
    topSlotShare: Math.min(1, Math.max(0, topSlotShare)),
    topAcquirerShare: Math.min(1, Math.max(0, result.topAcquirerShare)),
    maxTopHoldersInSlot: result.topHolderCoBuy?.maxTopHoldersInSlot ?? 0,
    topHolderPairs: result.topHolderCoBuy?.pairs.length ?? 0,
  };
}

/** Provisional flag: a coordinated same-slot buy. Requires the full
 * pre-entry window (reachedBefore) — a partial window undercounts
 * slots and would flag on noise. */
export function isCoBuyFlagged(f: CoBuyFeatures): boolean {
  if (!f.reachedBefore) return false;
  if (f.maxAcquirersInSlot >= COBUY_MIN_ACQUIRERS_IN_SLOT && f.topSlotShare >= COBUY_MIN_TOP_SLOT_SHARE) return true;
  if (f.maxTopHoldersInSlot >= COBUY_MIN_TOP_HOLDERS_SHARED_SLOT) return true;
  return false;
}

/** Human-readable one-liner for the journal. */
export function coBuyNote(f: CoBuyFeatures, flagged: boolean): string {
  return (
    `cobuy: maxAcqSlot=${f.maxAcquirersInSlot} topSlotShare=${(f.topSlotShare * 100).toFixed(0)}% ` +
    `topAcqShare=${(f.topAcquirerShare * 100).toFixed(0)}% distinct=${f.distinctAcquirers} ` +
    `topHoldersInSlot=${f.maxTopHoldersInSlot} window=${f.reachedBefore ? "full" : "partial"} ` +
    `flagged=${flagged}`
  );
}

const COBUY_CHECK =
  "/home/hatch/workspace/goals/solana-memecoin-flipping-system/hidden_files/sculgrok-work/apps/coordinator/src/cobuy-check.py";

/**
 * Runs the co-buy helper for a candidate mint. Fail-OPEN: any helper
 * failure / timeout / unparseable output returns null and the caller
 * proceeds without the signal (it is a logged signal, never a gate).
 * Failures are LOGGED (console.error with the mint) instead of
 * silently swallowed — a helper that always fails must be visible.
 * The helper reads public Helius data only; no key, no signing.
 */
export function checkCoBuy(
  mint: string,
  beforeTs: number,
  holders: { owner: string; pct: number }[],
  curve?: string,
): Promise<CoBuyFeatures | null> {
  return new Promise((resolve) => {
    const args = ["--mint", mint, "--before-ts", String(Math.floor(beforeTs))];
    if (holders.length > 0) args.push("--holders", JSON.stringify(holders));
    if (curve) args.push("--curve", curve);
    execFile("python3", [COBUY_CHECK, ...args], { timeout: 60_000 }, (err, stdout) => {
      if (err) {
        console.error("cobuy check failed for " + mint + ": " + err.message);
        return resolve(null);
      }
      try {
        const parsed = JSON.parse(stdout) as Partial<CoBuyResult>;
        if (!isCoBuyResult(parsed)) {
          console.error("cobuy check returned an unusable result for " + mint);
          return resolve(null);
        }
        resolve(analyzeCoBuy(parsed));
      } catch {
        console.error("cobuy check returned unparseable output for " + mint);
        resolve(null);
      }
    });
  });
}

/** Validate the helper's JSON before analyzeCoBuy reads it: every
 * numeric field it uses must be a finite number, the slot groups an
 * array, reachedBefore a boolean. A malformed shape is a failed
 * check (null), not a zeroed-out feature set. */
function isCoBuyResult(parsed: unknown): parsed is CoBuyResult {
  if (typeof parsed !== "object" || parsed === null) return false;
  const p = parsed as Record<string, unknown>;
  const num = (v: unknown): boolean => typeof v === "number" && Number.isFinite(v);
  if (typeof p.mint !== "string") return false;
  if (typeof p.reachedBefore !== "boolean") return false;
  for (const k of ["txsAnalyzed", "fetched", "pages", "distinctAcquirers", "totalAcquisitions", "totalAmount", "maxAcquirersInSlot", "topAcquirerShare"] as const) {
    if (!num(p[k])) return false;
  }
  if (!Array.isArray(p.slotGroups)) return false;
  if (p.topSlot !== null && typeof p.topSlot !== "object") return false;
  if (p.topHolderCoBuy !== null && typeof p.topHolderCoBuy !== "object") return false;
  return true;
}
