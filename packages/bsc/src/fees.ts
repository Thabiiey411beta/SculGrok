/**
 * BSC (four.meme) fee model — BNB-denominated, NOT Solana's constants.
 *
 * Verified live 2026-11-24 ~12:50 SAST:
 * - Gas: eth_gasPrice on bsc-dataseed returned 0x2faf080 = 0.05 gwei.
 *   A swap at ~150k gas costs 0.0000075 BNB (~$0.004 at $545/BNB).
 *   The model charges 0.00005 BNB/leg — a ~7x buffer for busy periods.
 * - four.meme internal-market trading fee (official GitBook
 *   https://four-meme.gitbook.io/four.meme/guide/how-it-works.md):
 *   1% per trade, MINIMUM 0.001 BNB — but the GitBook is WRONG
 *   on-chain. Helper3 getTokenInfo (w4/w5) reports tradingFeeRate
 *   100 (= 1%) and minTradingFee 0 on every classic token sampled
 *   (TAGENT, 0xff5c…, 0x33b2…), and Helper3 tryBuy/trySell
 *   VERIFIED it live 2026-11-24 ~20:35 SAST: a $3.30 buy on
 *   0xff5c… charged 0.0000593 BNB (0.99% of spend) and the sell
 *   charged the same (1.01% of proceeds) — exactly 1%, no floor.
 *   Newton's decision (2026-11-24): use each token's OWN on-chain
 *   minimum via resolveMinFeeBnb(), fall back to the conservative
 *   0.001 BNB only when the Helper3 read is missing/ambiguous.
 *   The global constant is NOT flipped to 0. See
 *   hidden_files/bsc-fee-flip-20261124.md.
 * - PancakeSwap V2 pool fee: 0.25% — verified live from GoPlus dex
 *   data for FORA (pool_fee "0.0025").
 * - Slippage: 2% per leg, same as the Solana light path (assumption,
 *   not measured — four.meme curve slippage is not quoted anywhere
 *   public; the sell-sim gate is what catches a bad quote live).
 * - No ATA rent on BSC (no associated-token-account rent).
 *
 * Break-even math mirrors packages/core/src/fees.ts (simplified
 * conservative form: fixed/position + proportional x legs), split by
 * regime: below 0.1 BNB the four.meme minimum fee is the fixed cost
 * and only slippage is proportional; above it the 1% fee is
 * proportional instead.
 */
export interface BscFeeModel {
  gasPerLegBnb: number;
  platformFeePct: number;
  platformFeeMinBnb: number;
  poolFeePct: number;
  slippagePct: number;
}

export const BSC_FEES: BscFeeModel = {
  gasPerLegBnb: 0.00005,
  platformFeePct: 0.01,
  platformFeeMinBnb: 0.001,
  poolFeePct: 0.0025,
  slippagePct: 0.02,
};

/** BNB amount at which the 1% four.meme fee overtakes the 0.001 BNB minimum. */
export const PLATFORM_FEE_MIN_THRESHOLD_BNB = BSC_FEES.platformFeeMinBnb / BSC_FEES.platformFeePct; // 0.1 BNB

/** The two Helper3 fields the per-token fee model reads. A
 * CurveInfo is structurally compatible — pass it straight in. */
export interface TokenFeeInfo {
  /** Raw Helper3 tradingFeeRate (100 = 1%). Null = unreadable. */
  tradingFeeRatePct: number | null;
  /** Helper3 minTradingFee in BNB. Null = unreadable. */
  minTradingFeeBnb: number | null;
}

/**
 * Resolve the platform-fee minimum for ONE token (Newton's
 * decision, 2026-11-24: per-token on-chain minimum, NOT a global
 * flip to 0). The Helper3 value is trusted ONLY when the read is
 * well-formed AND reports the classic 1% fee rate
 * (tradingFeeRate == 100). Any other rate (X-Mode, TaxToken, or a
 * different schedule) or a missing/ambiguous read falls back to
 * the conservative 0.001 BNB — never assume 0 without a
 * successful Helper3 read showing rate 100.
 */
export function resolveMinFeeBnb(fee: TokenFeeInfo | null): { minFeeBnb: number; source: "helper3" | "fallback" } {
  if (
    fee !== null &&
    fee.tradingFeeRatePct === 100 &&
    fee.minTradingFeeBnb !== null &&
    Number.isFinite(fee.minTradingFeeBnb) &&
    fee.minTradingFeeBnb >= 0
  ) {
    return { minFeeBnb: fee.minTradingFeeBnb, source: "helper3" };
  }
  return { minFeeBnb: BSC_FEES.platformFeeMinBnb, source: "fallback" };
}

/**
 * Per-token minimum for the cost functions below. Defaults to
 * the conservative 0.001 BNB fallback — callers pass the
 * resolveMinFeeBnb() result for pre-graduation tokens.
 */
export function legCostBnb(positionBnb: number, graduated: boolean, model: BscFeeModel = BSC_FEES, minFeeBnb: number = model.platformFeeMinBnb): number {
  if (graduated) {
    return model.gasPerLegBnb + positionBnb * (model.poolFeePct + model.slippagePct);
  }
  return (
    model.gasPerLegBnb +
    Math.max(positionBnb * model.platformFeePct, minFeeBnb) +
    positionBnb * model.slippagePct
  );
}

/** Gross % move needed to break even on a round trip (2 legs). */
export function breakEvenGrossPct(positionBnb: number, graduated: boolean, model: BscFeeModel = BSC_FEES, minFeeBnb: number = model.platformFeeMinBnb): number {
  if (positionBnb <= 0) return Number.POSITIVE_INFINITY;
  if (graduated) {
    return (2 * model.gasPerLegBnb) / positionBnb + 2 * (model.poolFeePct + model.slippagePct);
  }
  // The threshold moves with the per-token minimum: with min 0 the
  // fee is purely proportional from the first wei.
  const thresholdBnb = minFeeBnb / model.platformFeePct;
  if (positionBnb < thresholdBnb) {
    // Minimum fee binds: fixed = gas + minimums, proportional = slippage only.
    return (2 * model.gasPerLegBnb + 2 * minFeeBnb) / positionBnb + 2 * model.slippagePct;
  }
  return (2 * model.gasPerLegBnb) / positionBnb + 2 * (model.platformFeePct + model.slippagePct);
}

/** Fixed costs (gas + minimum fees) as a fraction of the position. */
export function fixedCostPctOfPosition(positionBnb: number, graduated: boolean, model: BscFeeModel = BSC_FEES, minFeeBnb: number = model.platformFeeMinBnb): number {
  if (positionBnb <= 0) return Number.POSITIVE_INFINITY;
  if (graduated) return (2 * model.gasPerLegBnb) / positionBnb;
  const thresholdBnb = minFeeBnb / model.platformFeePct;
  if (positionBnb < thresholdBnb) {
    return (2 * model.gasPerLegBnb + 2 * minFeeBnb) / positionBnb;
  }
  return (2 * model.gasPerLegBnb) / positionBnb;
}
