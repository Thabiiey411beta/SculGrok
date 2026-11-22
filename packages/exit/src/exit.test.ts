import { describe, expect, it } from "vitest";
import { applyExit, evaluateExit, openPosition } from "./exit.js";

describe("evaluateExit", () => {
  it("sells 50 percent at plus 50 percent", () => {
    const pos = openPosition("p1", "MINT", 1, 1.2, 0);
    const d = evaluateExit(pos, { price: 1.5, atMs: 10 * 60000 });
    expect(d.action).toBe("partial");
    expect(d.fraction).toBeCloseTo(0.5, 5);
  });
  it("closes the rest at plus 100 percent", () => {
    let pos = openPosition("p1", "MINT", 1, 1.2, 0);
    pos = applyExit(pos, evaluateExit(pos, { price: 1.5, atMs: 10 * 60000 }), { price: 1.5, atMs: 10 * 60000 });
    const d = evaluateExit(pos, { price: 2.0, atMs: 20 * 60000 });
    expect(d.action).toBe("close");
  });
  it("closes all at minus 30 percent", () => {
    const pos = openPosition("p1", "MINT", 1, 1.2, 0);
    expect(evaluateExit(pos, { price: 0.7, atMs: 10 * 60000 }).action).toBe("close");
  });
  it("trails 18 percent under the peak after take profit 1", () => {
    let pos = openPosition("p1", "MINT", 1, 1.2, 0);
    pos = applyExit(pos, evaluateExit(pos, { price: 1.5, atMs: 10 * 60000 }), { price: 1.5, atMs: 10 * 60000 });
    pos = { ...pos, peakPrice: 1.8 };
    const d = evaluateExit(pos, { price: 1.47, atMs: 20 * 60000 });
    expect(d.action).toBe("close");
  });
  it("time exits at 120 minutes", () => {
    const pos = openPosition("p1", "MINT", 1, 1.2, 0);
    expect(evaluateExit(pos, { price: 1.1, atMs: 120 * 60000 }).action).toBe("close");
  });
});
