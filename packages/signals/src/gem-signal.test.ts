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
  washPct: 0.1,
  socialBeforeFlow: false,
  curveProgressPct: 80,
  migrated: true,
  liquidityUsd: 20000,
  positionSol: 0.008,
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
});
