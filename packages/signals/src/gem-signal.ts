import { breakEvenGrossPct, fixedCostPctOfPosition, LIGHT_FEES, type FeeModel } from "../../core/src/fees.js";
import { MICRO_PROFILE, type MicroProfile } from "../../core/src/micro.js";
import type { RugCheckResult } from "../../anti-rug/src/types.js";

export interface GemInput {
  mint: string;
  uniqueBuyerGrowthPct: number;
  buySellRatio: number;
  newWalletInflow: number;
  marketCapVelocityPct: number;
  smartMoneyWallets: number;
  smartMoneyMinTrades: number;
  clusterPct: number;
  washPct: number;
  socialBeforeFlow: boolean;
  curveProgressPct: number;
  migrated: boolean;
  liquidityUsd: number;
  positionSol: number;
  feeModel?: FeeModel;
  profile?: MicroProfile;
}

export interface GemSignal {
  mint: string;
  score: number;
  actionable: boolean;
  reason: string;
  breakEvenGrossPct: number;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export function scoreGem(input: GemInput): number {
  let score = 0;
  score += clamp(input.uniqueBuyerGrowthPct / 2, 0, 25);
  score += clamp((input.buySellRatio - 1) * 20, 0, 20);
  score += clamp(input.newWalletInflow / 2, 0, 15);
  score += clamp(input.marketCapVelocityPct / 4, 0, 15);
  score += input.smartMoneyWallets >= 2 && input.smartMoneyMinTrades >= 10 ? 15 : input.smartMoneyWallets >= 1 ? 5 : 0;
  score += input.migrated ? 5 : clamp(input.curveProgressPct / 20, 0, 5);
  score += input.liquidityUsd >= 5000 ? 5 : 0;
  if (input.clusterPct > 0.3) score -= 20;
  if (input.washPct > 0.3) score -= 20;
  if (input.socialBeforeFlow) score -= 10;
  return clamp(Math.round(score), 0, 100);
}

export function evaluateGem(input: GemInput, rug: RugCheckResult): GemSignal {
  const profile = input.profile ?? MICRO_PROFILE;
  const feeModel = input.feeModel ?? LIGHT_FEES;
  const score = scoreGem(input);
  const be = breakEvenGrossPct(input.positionSol, feeModel, 2);
  const fixedPct = fixedCostPctOfPosition(input.positionSol, feeModel, 2);
  if (rug.verdict === "block") {
    return { mint: input.mint, score, actionable: false, reason: "rug check blocked: " + rug.failed.join(", "), breakEvenGrossPct: be };
  }
  if (score < 70) {
    return { mint: input.mint, score, actionable: false, reason: "gem score below 70", breakEvenGrossPct: be };
  }
  if (be >= profile.minBreakEvenGrossPct) {
    return { mint: input.mint, score, actionable: false, reason: "modelled break-even too high at $3 size", breakEvenGrossPct: be };
  }
  if (fixedPct > profile.maxFixedCostPctOfPosition) {
    return { mint: input.mint, score, actionable: false, reason: "fixed costs exceed 10 percent of position", breakEvenGrossPct: be };
  }
  return { mint: input.mint, score, actionable: true, reason: "rug clean, score " + score + ", break-even " + Math.round(be * 100) + "%", breakEvenGrossPct: be };
}
