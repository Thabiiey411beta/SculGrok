import { describe, expect, it } from "vitest";
import { evaluateRug } from "../../anti-rug/src/checks.js";
import { evaluateGem, type GemInput } from "./gem-signal.js";

const rugClean = evaluateRug({
  mint: "TEST11111111111111111111111111111111111111",
  mintAuthorityLive: false,
  freezeAuthorityLive: false,
  top10Pct: 0.15,
  singleWalletPct: 0.05,
  bundlePct: 0.1,
  devSoldPct: 0.05,
  washPct: 0.1,
  lpLockedOrBurned: true,
  liquidityUsd: 20000,
  sellSimulationOk: true,
  token2022TransferFee: false,
  token2022TransferHook: false,
  token2022PermanentDelegate: false,
  token2022Pause: false,
  mutableMetadata: false,
});

const gemClean: GemInput = {
  mint: "TEST11111111111111111111111111111111111111",
  uniqueBuyerGrowthPct: 60,
  buySellRatio: 2.0,
  newWalletInflow: 40,
  marketCapVelocityPct: 80,
  smartMoneyWallets: 2,
  smartMoneyMinTrades: 12,
  clusterPct: 0.1,
  // No washPct field (v2.20): wash is logged-only, not a gem input.
  socialBeforeFlow: false,
  curveProgressPct: 80,
  migrated: true,
  liquidityUsd: 20000,
  // 0.03 SOL: the rent-inclusive break-even is ~13% here. At the
  // old 0.008 SOL fixture size the break-even is ~33% (>= the 25%
  // profile minimum), so that size is no longer actionable — see the
  // test below. The fixture uses a size where the gate can pass.
  positionSol: 0.03,
};

describe("evaluateGem", () => {
  it("is actionable when rug is clean and score is high", () => {
    const s = evaluateGem(gemClean, rugClean);
    expect(s.actionable).toBe(true);
    expect(s.score).toBeGreaterThanOrEqual(70);
  });
  it("is not actionable when rug blocks", () => {
    const rug = evaluateRug({ mint: "X", mintAuthorityLive: true, freezeAuthorityLive: false, top10Pct: 0.1, bundlePct: 0.1, lpLockedOrBurned: true, liquidityUsd: 20000, sellSimulationOk: true });
    expect(evaluateGem(gemClean, rug).actionable).toBe(false);
  });
  it("is not actionable on a low score", () => {
    expect(evaluateGem({ ...gemClean, uniqueBuyerGrowthPct: 0, newWalletInflow: 0, marketCapVelocityPct: 0, smartMoneyWallets: 0 }, rugClean).actionable).toBe(false);
  });
  it("is not actionable at a 0.008 SOL position: rent-inclusive break-even ~33% exceeds the 25% minimum", () => {
    // The ATA rent (0.00203928 SOL) is a cost now, not reclaimed, so
    // a tiny position's break-even is dominated by it. Score is 100;
    // the break-even gate is what blocks.
    const s = evaluateGem({ ...gemClean, positionSol: 0.008 }, rugClean);
    expect(s.score).toBe(100);
    expect(s.actionable).toBe(false);
    expect(s.reason).toContain("break-even 33%");
  });
  it("scores 0 for unmeasured growth / ratio / inflow instead of synthesising them", () => {
    const s = evaluateGem({ ...gemClean, uniqueBuyerGrowthPct: null, buySellRatio: null, newWalletInflow: null }, rugClean);
    // 15 (mc velocity) + 15 (smart money) + 5 (migrated) + 5 (liquidity) = 40.
    expect(s.score).toBe(40);
    expect(s.actionable).toBe(false);
  });
  it("reaches the 100 ceiling when every flow component is measured at max", () => {
    // v2.20: growth 25 + buy/sell 20 + inflow 15 + mc velocity 15
    // + smart money 15 + migrated 5 + liquidity 5 = 100. Before
    // the measured flow components the ceiling was 50.
    const s = evaluateGem({ ...gemClean, uniqueBuyerGrowthPct: 60, buySellRatio: 2.0, newWalletInflow: 40, marketCapVelocityPct: 80 }, rugClean);
    expect(s.score).toBe(100);
    expect(s.actionable).toBe(true);
  });
  it("cluster penalty still applies on measured clusterPct > 30%", () => {
    expect(evaluateGem({ ...gemClean, clusterPct: 0.4 }, rugClean).score).toBe(80);
  });
  it("recentSmartBuy adds 10 and can flip a 65 to actionable", () => {
    const base = { ...gemClean, marketCapVelocityPct: 0, smartMoneyWallets: 0, smartMoneyMinTrades: 0, liquidityUsd: 0 };
    expect(evaluateGem(base, rugClean).score).toBe(65);
    expect(evaluateGem(base, rugClean).actionable).toBe(false);
    const boosted = evaluateGem({ ...base, recentSmartBuy: true }, rugClean);
    expect(boosted.score).toBe(75);
    expect(boosted.actionable).toBe(true);
  });
});
