import { describe, expect, it } from "vitest";
import { breakEvenGrossPct, BSC_FEES, fixedCostPctOfPosition, legCostBnb, resolveMinFeeBnb } from "./fees.js";

// BNB $545.22 (DexScreener WBNB, verified live 2026-11-24). $3.30 = 0.006053 BNB.
const BNB = 545.22;
const POS_330 = 3.3 / BNB;

describe("BSC fee model", () => {
  it("pre-graduation: the 0.001 BNB minimum fee binds at $3.30", () => {
    // 1% of 0.006053 BNB = 0.0000605 BNB < 0.001 minimum, so the leg
    // costs gas + 0.001 + slippage.
    const leg = legCostBnb(POS_330, false);
    expect(leg).toBeCloseTo(0.00005 + 0.001 + POS_330 * 0.02, 10);
    expect(leg / POS_330).toBeGreaterThan(0.18); // >18% of the position per leg
  });

  it("pre-graduation break-even at $3.30 is ~39%, above the 25% bar — entries block", () => {
    const be = breakEvenGrossPct(POS_330, false);
    expect(be).toBeGreaterThan(0.25);
    expect(be).toBeCloseTo(0.387, 2);
    expect(fixedCostPctOfPosition(POS_330, false)).toBeGreaterThan(0.1);
  });

  it("pre-graduation break-even drops below 25% once the position passes ~$5.45", () => {
    // Position 0.01 BNB ($5.45): fixed 0.0021/0.01 = 21% + 4% slippage = 25%.
    expect(breakEvenGrossPct(0.01 / 1, false)).toBeCloseTo(0.25, 2);
    expect(breakEvenGrossPct(5.5 / BNB, false)).toBeLessThan(0.25);
  });

  it("graduated (PancakeSwap) break-even at $3.30 is ~6%, passes the bar", () => {
    const be = breakEvenGrossPct(POS_330, true);
    expect(be).toBeLessThan(0.25);
    expect(be).toBeCloseTo(0.0615, 3);
    expect(fixedCostPctOfPosition(POS_330, true)).toBeLessThan(0.1);
  });

  it("uses the documented fee constants", () => {
    expect(BSC_FEES.platformFeePct).toBe(0.01);
    expect(BSC_FEES.platformFeeMinBnb).toBe(0.001);
    expect(BSC_FEES.poolFeePct).toBe(0.0025);
    expect(BSC_FEES.slippagePct).toBe(0.02);
  });
});

describe("per-token minimum (Helper3 fee flip, 2026-11-24)", () => {
  it("trusts the Helper3 minimum only on a classic 1% read (rate 100)", () => {
    expect(resolveMinFeeBnb({ tradingFeeRatePct: 100, minTradingFeeBnb: 0 })).toEqual({ minFeeBnb: 0, source: "helper3" });
    expect(resolveMinFeeBnb({ tradingFeeRatePct: 100, minTradingFeeBnb: 0.0005 })).toEqual({ minFeeBnb: 0.0005, source: "helper3" });
  });

  it("falls back to 0.001 BNB on any non-classic rate or ambiguous read — never assumes 0", () => {
    const fallback = { minFeeBnb: 0.001, source: "fallback" };
    expect(resolveMinFeeBnb({ tradingFeeRatePct: 50, minTradingFeeBnb: 0 })).toEqual(fallback); // X-Mode / other schedule
    expect(resolveMinFeeBnb({ tradingFeeRatePct: 200, minTradingFeeBnb: 0 })).toEqual(fallback);
    expect(resolveMinFeeBnb({ tradingFeeRatePct: null, minTradingFeeBnb: 0 })).toEqual(fallback);
    expect(resolveMinFeeBnb({ tradingFeeRatePct: 100, minTradingFeeBnb: null })).toEqual(fallback);
    expect(resolveMinFeeBnb({ tradingFeeRatePct: 100, minTradingFeeBnb: -0.001 })).toEqual(fallback);
    expect(resolveMinFeeBnb(null)).toEqual(fallback);
  });

  it("pre-graduation at $3.30 with min 0 breaks even at ~7.7% — passes the 25% bar", () => {
    const be = breakEvenGrossPct(POS_330, false, BSC_FEES, 0);
    expect(be).toBeLessThan(0.25);
    expect(be).toBeCloseTo(0.0765, 3);
    expect(fixedCostPctOfPosition(POS_330, false, BSC_FEES, 0)).toBeLessThan(0.1);
    // Leg cost is gas + 1% (no floor) + slippage.
    expect(legCostBnb(POS_330, false, BSC_FEES, 0)).toBeCloseTo(0.0002316, 7);
  });

  it("the 0.001 fallback still blocks at $3.30 (~38.7%) — unknown tokens stay fee-blocked", () => {
    expect(breakEvenGrossPct(POS_330, false, BSC_FEES, 0.001)).toBeCloseTo(0.387, 2);
    expect(breakEvenGrossPct(POS_330, false, BSC_FEES, 0.001)).toBeGreaterThan(0.25);
    // Default parameter is the fallback: no per-token minimum passed.
    expect(breakEvenGrossPct(POS_330, false)).toBeCloseTo(0.387, 2);
    expect(legCostBnb(POS_330, false)).toBeCloseTo(0.00005 + 0.001 + POS_330 * 0.02, 10);
  });

  it("a non-zero per-token minimum still binds below its own threshold", () => {
    // min 0.0005 BNB: threshold 0.05 BNB; a $3.30 position is below
    // it, so break-even is fixed-cost dominated (~21%).
    const be = breakEvenGrossPct(POS_330, false, BSC_FEES, 0.0005);
    expect(be).toBeCloseTo((2 * 0.00005 + 2 * 0.0005) / POS_330 + 2 * 0.02, 6);
    expect(be).toBeLessThan(0.25);
  });
});
