import { describe, expect, it } from "vitest";
import {
  volumeMetrics,
  volumeScore,
  volumeVerdict,
  VOL_MAX_PAIR_AGE_H,
  VOL_MIN_BUY_SELL_RATIO,
  VOL_MIN_H1_TXNS_FALLBACK,
  VOL_MIN_H1_USD,
  VOL_MIN_HEAT,
  VOL_MIN_M5_USD,
  VOL_MIN_TRADERS_H1,
  VOL_MIN_VOL_LIQ_RATIO,
  type VolumeInputs,
} from "./volume.js";

// Live GeckoTerminal + DexScreener snapshots, 2026-11-24 ~15:30 SAST
// (fresh PancakeSwap pools, pages 1-3 — see the v2 build note).
function base(overrides: Partial<VolumeInputs> = {}): VolumeInputs {
  return {
    volM5Usd: 2340,
    volH1Usd: 2340,
    tradersH1: 36,
    buysH1: 30,
    sellsH1: 18,
    buysM5: 12,
    sellsM5: 5,
    liquidityUsd: 4422,
    priceChangeH1Pct: 4.2,
    pairAgeH: 0.5,
    ...overrides,
  };
}

describe("volume metrics", () => {
  it("heat is m5 share of h1 vs the uniform 5/60 baseline", () => {
    // 0x06e2: all volume in the last 5 min -> heat 12x.
    expect(volumeMetrics(base()).heat).toBeCloseTo(12, 6);
    // 0xf4bd (fading frenzy): m5 1679 / h1 33922 -> heat 0.59x.
    expect(volumeMetrics(base({ volM5Usd: 1679, volH1Usd: 33922 })).heat).toBeCloseTo(0.594, 2);
    // Missing volume -> null heat.
    expect(volumeMetrics(base({ volM5Usd: null, volH1Usd: null })).heat).toBeNull();
  });

  it("buy/sell ratio is buys+1 on sells == 0 (journal-safe), 1 on no trades", () => {
    expect(volumeMetrics(base({ buysH1: 28, sellsH1: 0 })).buySellRatio).toBe(29);
    expect(volumeMetrics(base({ buysH1: 0, sellsH1: 0 })).buySellRatio).toBe(1);
    expect(volumeMetrics(base()).buySellRatio).toBeCloseTo(30 / 18, 6);
  });

  it("traders fall back to total h1 txns when GeckoTerminal data is absent", () => {
    const m = volumeMetrics(base({ tradersH1: null, buysH1: 15, sellsH1: 5 }));
    expect(m.tradersH1).toBe(20);
    expect(m.tradersFromTxnFallback).toBe(true);
    const m2 = volumeMetrics(base());
    expect(m2.tradersH1).toBe(36);
    expect(m2.tradersFromTxnFallback).toBe(false);
  });

  it("vol/liq ratio is null without volume or liquidity", () => {
    expect(volumeMetrics(base()).volLiqRatio).toBeCloseTo(2340 / 4422, 6);
    expect(volumeMetrics(base({ volH1Usd: null })).volLiqRatio).toBeNull();
    expect(volumeMetrics(base({ liquidityUsd: null })).volLiqRatio).toBeNull();
  });
});

describe("volume verdict — live calibration tokens", () => {
  it("0x06e2 (mid, buy-dominant) PASSES every gate", () => {
    const v = volumeVerdict(base());
    expect(v.pass).toBe(true);
    expect(v.failed).toEqual([]);
  });

  it("0x3d08 (churn king: 715 buys / 740 sells) FAILS buy dominance only", () => {
    const v = volumeVerdict(
      base({ volM5Usd: 62454, volH1Usd: 67721, tradersH1: 614, buysH1: 715, sellsH1: 740, liquidityUsd: 16285, priceChangeH1Pct: 12 }),
    );
    expect(v.pass).toBe(false);
    expect(v.failed).toHaveLength(1);
    expect(v.failed[0]).toContain("buy dominance");
  });

  it("LGU (m5 $236, h1 $268, 5 traders) FAILS volume + breadth", () => {
    const v = volumeVerdict(base({ volM5Usd: 236, volH1Usd: 268, tradersH1: 5, buysH1: 6, sellsH1: 1, liquidityUsd: 6900 }));
    expect(v.pass).toBe(false);
    expect(v.failed.join(" ")).toContain(`m5 volume $236 < $${VOL_MIN_M5_USD}`);
    expect(v.failed.join(" ")).toContain(`h1 volume $268 < $${VOL_MIN_H1_USD}`);
    expect(v.failed.join(" ")).toContain("traders 5 <");
  });

  it("0xf4bd (fading frenzy) FAILS dominance + heat", () => {
    const v = volumeVerdict(
      base({ volM5Usd: 1679, volH1Usd: 33922, tradersH1: 171, buysH1: 194, sellsH1: 226, liquidityUsd: null }),
    );
    expect(v.pass).toBe(false);
    expect(v.failed.join(" ")).toContain("buy dominance");
    expect(v.failed.join(" ")).toContain(`heat 0.59x < ${VOL_MIN_HEAT}x`);
    expect(v.failed.join(" ")).toContain("volume/liquidity unknown");
  });

  it("fresh pre-grad token (no DexScreener volume) FAILS closed on missing volume", () => {
    const v = volumeVerdict(
      base({ volM5Usd: null, volH1Usd: null, tradersH1: 1, buysH1: 1, sellsH1: 0, liquidityUsd: null, priceChangeH1Pct: null, pairAgeH: 0.1 }),
    );
    expect(v.pass).toBe(false);
    expect(v.failed.join(" ")).toContain("m5 volume unknown");
    expect(v.failed.join(" ")).toContain("h1 volume unknown");
  });

  it("pair older than 6h FAILS recency", () => {
    const v = volumeVerdict(base({ pairAgeH: 7 }));
    expect(v.pass).toBe(false);
    expect(v.failed.join(" ")).toContain(`pair age 7.0h > ${VOL_MAX_PAIR_AGE_H}h`);
  });

  it("negative h1 price change FAILS momentum; absent price change is neutral", () => {
    expect(volumeVerdict(base({ priceChangeH1Pct: -12 })).pass).toBe(false);
    expect(volumeVerdict(base({ priceChangeH1Pct: -12 })).failed.join(" ")).toContain("dumping");
    expect(volumeVerdict(base({ priceChangeH1Pct: null })).pass).toBe(true);
  });

  it("txn-fallback breadth uses the 20-txn bar, not the 10-trader bar", () => {
    const v = volumeVerdict(base({ tradersH1: null, buysH1: 12, sellsH1: 2 }));
    expect(v.pass).toBe(false);
    expect(v.failed.join(" ")).toContain(`h1 txns 14 < ${VOL_MIN_H1_TXNS_FALLBACK}`);
    const v2 = volumeVerdict(base({ tradersH1: null, buysH1: 18, sellsH1: 4 }));
    expect(v2.pass).toBe(true);
  });

  it("low volume/liquidity FAILS the depth gate", () => {
    const v = volumeVerdict(base({ volH1Usd: 832, liquidityUsd: 10302, volM5Usd: 430, tradersH1: 10, buysH1: 15, sellsH1: 6 }));
    // 832/10302 = 8.1% — passes the 5% bar; tighten to check the fail side.
    expect(v.pass).toBe(true);
    const v2 = volumeVerdict(base({ volH1Usd: 500, liquidityUsd: 30000, volM5Usd: 500, tradersH1: 12, buysH1: 15, sellsH1: 6 }));
    expect(v2.pass).toBe(false);
    expect(v2.failed.join(" ")).toContain(`< ${VOL_MIN_VOL_LIQ_RATIO * 100}%`);
  });
});

describe("volume score (journal-only, CMC-adapted)", () => {
  it("hot young liquid token scores high; dead token scores ~0", () => {
    const hot = volumeScore(
      volumeMetrics(base({ volM5Usd: 5000, volH1Usd: 15000, tradersH1: 60, buysH1: 56, sellsH1: 20, liquidityUsd: 50000, pairAgeH: 0.5 })),
    );
    expect(hot).toBeGreaterThanOrEqual(25 + 25 + 15 + 10); // age + traders + heat + dominance
    const dead = volumeScore(
      volumeMetrics(base({ volM5Usd: 0, volH1Usd: 0, tradersH1: 3, buysH1: 0, sellsH1: 0, liquidityUsd: 0, priceChangeH1Pct: null, pairAgeH: 0.1 })),
    );
    expect(dead).toBe(25); // age <1h only
  });

  it("threshold constants are the documented bars", () => {
    expect(VOL_MIN_M5_USD).toBe(300);
    expect(VOL_MIN_H1_USD).toBe(500);
    expect(VOL_MIN_BUY_SELL_RATIO).toBe(1.2);
    expect(VOL_MIN_TRADERS_H1).toBe(10);
    expect(VOL_MIN_HEAT).toBe(1.0);
    expect(VOL_MIN_VOL_LIQ_RATIO).toBe(0.05);
    expect(VOL_MAX_PAIR_AGE_H).toBe(6);
  });
});
