import { describe, expect, it } from "vitest";
import { breakEvenGrossPct, legCostSol, LIGHT_FEES, SNIPER_FEES } from "./fees.js";

describe("fees", () => {
  it("light path break-even is ~33 percent on a 0.008 SOL position (rent is a cost now)", () => {
    // Fixed 0.000055 x 2 legs + rent 0.00203928 = 0.00214928 / 0.008
    // = 26.9% fixed + 6% proportional = ~32.9%. The old "under 25%"
    // bar assumed the ATA rent was reclaimed; it is not (SOUL audit
    // fix: rugs and halts never close cleanly, exactly when rent is
    // lost). A $2.20-size position cannot break even under 25%.
    expect(breakEvenGrossPct(0.008, LIGHT_FEES, 2)).toBeCloseTo(0.329, 2);
  });
  it("sniper path break-even is over 50 percent on a 0.008 SOL position", () => {
    expect(breakEvenGrossPct(0.008, SNIPER_FEES, 2)).toBeGreaterThan(0.5);
  });
  it("a round trip costs two legs, buy plus sell (v2.12 audit fix)", () => {
    // The gate models 2 legs and the docs say fees are "per side".
    // The live books used to charge only the sell leg; the buy leg
    // (first leg, isFirstLeg=true) is the same cost again, PLUS the
    // ATA rent — the rent is charged once, on the buy leg, and is
    // never reclaimed (SOUL audit fix).
    const sizeSol = 2.2 / 70;
    const buy = legCostSol(sizeSol, LIGHT_FEES, true);
    const sell = legCostSol(sizeSol, LIGHT_FEES, false);
    expect(buy).toBeCloseTo(sell + 0.00203928, 10);
    expect(buy + sell).toBeCloseTo(2 * (0.000055 + sizeSol * 0.03) + 0.00203928, 10);
  });
});
