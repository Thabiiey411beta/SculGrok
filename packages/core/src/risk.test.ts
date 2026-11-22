import { describe, expect, it } from "vitest";
import { applyLoss, checkRisk, haltDesk, newRiskState } from "./risk.js";

describe("risk", () => {
  it("halts on daily loss", () => {
    const state = applyLoss(newRiskState(3), 0.75);
    expect(state.kill).toBe("halted");
    expect(checkRisk(state, 1).verdict).toBe("halt");
  });
  it("denies a position over 40 percent", () => {
    expect(checkRisk(newRiskState(3), 2).verdict).toBe("deny");
  });
  it("denies when max open positions are reached", () => {
    expect(checkRisk({ ...newRiskState(3), openPositions: 2 }, 1).verdict).toBe("deny");
  });
  it("haltDesk locks the desk", () => {
    expect(haltDesk(newRiskState(3), "manual halt").kill).toBe("halted");
  });
});
