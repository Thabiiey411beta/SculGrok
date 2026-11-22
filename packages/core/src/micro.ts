/**
 * $3 micro profile for SculGrok.
 * Paper-first, fail-closed. See docs/MICRO-3USD.md for the fee math.
 * SOL price is an input, never a hard-coded live truth.
 */
export interface MicroProfile {
  startEquityUsd: number;
  solPriceUsd: number;
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
  startEquityUsd: 3.0,
  solPriceUsd: 150,
  maxPositionPct: 0.4,
  startPositionPct: 0.4,
  maxOpenPositions: 2,
  maxTradesPerDay: 6,
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

export function positionSizeSol(equityUsd: number, profile: MicroProfile = MICRO_PROFILE): number {
  return positionSizeUsd(equityUsd, profile) / profile.solPriceUsd;
}

export function dailyLossLimitUsd(profile: MicroProfile = MICRO_PROFILE): number {
  return profile.startEquityUsd * profile.dailyLossLimitPct;
}

export function isPositionSizeAllowed(sizeUsd: number, equityUsd: number, profile: MicroProfile = MICRO_PROFILE): boolean {
  return sizeUsd > 0 && sizeUsd <= equityUsd * profile.maxPositionPct;
}
