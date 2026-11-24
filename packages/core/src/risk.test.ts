import { describe, expect, it } from "vitest";
import { applyLoss, checkRisk, haltDesk, newRiskState } from "./risk.js";

describe("risk", () => {
  it("halts on daily loss", () => {
    const state = applyLoss(newRiskState(3), 0.75);
    expect(state.kill).toBe("halted");
    expect(checkRisk(state, 1).verdict).toBe("halt");
  });
  it("denies a position over the 22 percent max", () => {
    // Profile maxPositionPct is 0.22, not 40%: size 2 on equity 3
    // is 66% and denies; the boundary is 0.66 on equity 3.
    expect(checkRisk(newRiskState(3), 2).verdict).toBe("deny");
    expect(checkRisk(newRiskState(3), 0.67).verdict).toBe("deny");
    expect(checkRisk(newRiskState(3), 0.66).verdict).toBe("allow");
  });
  it("denies when max open positions are reached (3)", () => {
    expect(checkRisk({ ...newRiskState(3), openPositions: 3 }, 1).verdict).toBe("deny");
    // 2 open is under the max of 3 and allows (size 1 on equity 3
    // is over 22%, so use a smaller size for the allow check).
    expect(checkRisk({ ...newRiskState(3), openPositions: 2 }, 0.5).verdict).toBe("allow");
  });
  it("denies a zero, negative or NaN position size (SOUL audit fix)", () => {
    // NaN > maxSize is false, so without the explicit guard it
    // would have been allowed through.
    expect(checkRisk(newRiskState(3), 0).verdict).toBe("deny");
    expect(checkRisk(newRiskState(3), -1).verdict).toBe("deny");
    expect(checkRisk(newRiskState(3), Number.NaN).verdict).toBe("deny");
  });
  it("applyLoss ignores a negative loss (a gain) instead of crediting equity", () => {
    const state = newRiskState(3);
    expect(applyLoss(state, -0.5)).toEqual(state);
    expect(applyLoss(state, Number.NaN)).toEqual(state);
  });
  it("haltDesk locks the desk", () => {
    expect(haltDesk(newRiskState(3), "manual halt").kill).toBe("halted");
  });
});
