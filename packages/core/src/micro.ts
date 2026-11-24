/**
 * $10 micro profile for SculGrok (rerun from 2026-11-22 23:06 SAST; was $3).
 * Paper-first, fail-closed. See docs/MICRO-3USD.md for the fee math.
 * SOL price is an input, never a hard-coded live truth.
 *
 * Sizing v2.7 (2026-11-22 overnight): 22% per position, max 3 open,
 * from the "Tweeter post" doc Newton's Grok Bot run (3 coins max,
 * ~22% of the wallet each, TP + stop on every buy, reinvest wins).
 * Trade-off vs the old 30% x 2: one -30% stop now costs 6.6% of
 * equity instead of 9%, and three uncorrelated positions diversify
 * the single-coin blow-up; but max deployed rises 60% -> 66%, there
 * are more fee legs per unit of equity, and the 15-trades/day cap
 * binds faster with 3 slots to fill. This is a PAPER test of that
 * sizing, not a claim it is better: revert is one line each
 * (startPositionPct 0.22 -> 0.30, maxOpenPositions 3 -> 2).
 *
 * SOL price is NOT a profile constant: it is a live input fetched
 * per poll (Jupiter price). Any code that needs a SOL price takes it
 * as a parameter; there is no fallback price anywhere in the desk.
 */
export interface MicroProfile {
  startEquityUsd: number;
  maxPositionPct: number;
  startPositionPct: number;
  maxOpenPositions: number;
  maxTradesPerDay: number;
  dailyLossLimitPct: number;
  hardStopPct: number;
  trailingStopPct: number;
  tp1Multiple: number;
  tp1Fraction: number;
  tp2Multiple: number;
  timeExitMinutes: number;
  stallMinutes: number;
  minBreakEvenGrossPct: number;
  maxFixedCostPctOfPosition: number;
}

export const MICRO_PROFILE: MicroProfile = {
  // $15 paper run from 2026-11-24 (Newton) — was $10.00, $3.00 before that.
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

export function positionSizeUsd(equityUsd: number, profile: MicroProfile = MICRO_PROFILE): number {
  return equityUsd * profile.startPositionPct;
}

export function positionSizeSol(equityUsd: number, solPriceUsd: number, profile: MicroProfile = MICRO_PROFILE): number {
  if (!(solPriceUsd > 0)) throw new Error("positionSizeSol: solPriceUsd must be a live price > 0");
  return positionSizeUsd(equityUsd, profile) / solPriceUsd;
}

export function dailyLossLimitUsd(profile: MicroProfile = MICRO_PROFILE): number {
  return profile.startEquityUsd * profile.dailyLossLimitPct;
}

export function isPositionSizeAllowed(sizeUsd: number, equityUsd: number, profile: MicroProfile = MICRO_PROFILE): boolean {
  return sizeUsd > 0 && sizeUsd <= equityUsd * profile.maxPositionPct;
}
