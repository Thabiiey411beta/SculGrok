import { breakEvenGrossPct, fixedCostPctOfPosition, LIGHT_FEES, type FeeModel } from "../../core/src/fees.js";
import { MICRO_PROFILE, type MicroProfile } from "../../core/src/micro.js";
import type { RugCheckResult } from "../../anti-rug/src/types.js";

export interface GemInput {
  mint: string;
  /** Measured only — null when the source did not carry the field.
   * A null component scores 0; the desk never synthesises buyer
   * growth, buy/sell ratio or inflow from other signals (SOUL audit
   * fix: the old gemInputFromCoin invented them from mc velocity +
   * ATH ratio + recency). */
  uniqueBuyerGrowthPct: number | null;
  buySellRatio: number | null;
  newWalletInflow: number | null;
  marketCapVelocityPct: number;
  smartMoneyWallets: number;
  smartMoneyMinTrades: number;
  /** A tracked smart-money wallet bought this mint in the last hour (fast alerts feed, v2.6). */
  recentSmartBuy?: boolean;
  /** Measured only — null when unmeasured. Penalties apply only
   * when the value is actually measured; an unmeasured cluster /
   * social signal scores 0 and penalises nothing (the rug check,
   * not the gem score, is what blocks on missing data). There is
   * deliberately NO washPct field here (v2.20): wash is measured
   * and journaled by the spotter but is logged-only — it has zero
   * discriminating power on fresh tokens (n=30 live, 2026-11-23:
   * 27/30 unknown, 3/30 at 0.98-1.00), so the old -20 penalty for
   * wash > 30% subtracted 20 points from every measurable
   * candidate. RE-PROMOTE only when a wash source is found that
   * varies across candidates; restore the field and the penalty
   * together. */
  clusterPct: number | null;
  socialBeforeFlow: boolean | null;
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
  // Null (unmeasured) components score 0 — never synthesised.
  score += input.uniqueBuyerGrowthPct !== null ? clamp(input.uniqueBuyerGrowthPct / 2, 0, 25) : 0;
  score += input.buySellRatio !== null ? clamp((input.buySellRatio - 1) * 20, 0, 20) : 0;
  score += input.newWalletInflow !== null ? clamp(input.newWalletInflow / 2, 0, 15) : 0;
  score += clamp(input.marketCapVelocityPct / 4, 0, 15);
  score += input.smartMoneyWallets >= 2 && input.smartMoneyMinTrades >= 10 ? 15 : input.smartMoneyWallets >= 1 ? 5 : 0;
  if (input.recentSmartBuy) score += 10;
  score += input.migrated ? 5 : clamp(input.curveProgressPct / 20, 0, 5);
  score += input.liquidityUsd >= 5000 ? 5 : 0;
  // Penalties only on measured values — an unmeasured cluster/
  // social signal penalises nothing (the rug check blocks on missing
  // data; the gem score must not invent a penalty either). There
  // is no wash penalty any more (v2.20, logged-only — see the
  // GemInput comment above).
  if (input.clusterPct !== null && input.clusterPct > 0.3) score -= 20;
  if (input.socialBeforeFlow === true) score -= 10;
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
    return { mint: input.mint, score, actionable: false, reason: `modelled break-even ${Math.round(be * 100)}% >= min ${Math.round(profile.minBreakEvenGrossPct * 100)}%`, breakEvenGrossPct: be };
  }
  if (fixedPct > profile.maxFixedCostPctOfPosition) {
    return { mint: input.mint, score, actionable: false, reason: `fixed costs ${Math.round(fixedPct * 100)}% > max ${Math.round(profile.maxFixedCostPctOfPosition * 100)}% of position`, breakEvenGrossPct: be };
  }
  // A "watch" rug verdict is not clean — say so in the reason.
  return { mint: input.mint, score, actionable: true, reason: "rug " + rug.verdict + ", score " + score + ", break-even " + Math.round(be * 100) + "%", breakEvenGrossPct: be };
}
