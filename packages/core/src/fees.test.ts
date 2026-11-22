import { describe, expect, it } from "vitest";
import { breakEvenGrossPct, LIGHT_FEES, SNIPER_FEES } from "./fees.js";

describe("fees", () => {
  it("light path break-even is under 25 percent on a 0.008 SOL position", () => {
    expect(breakEvenGrossPct(0.008, LIGHT_FEES, 2)).toBeLessThan(0.25);
  });
  it("sniper path break-even is over 50 percent on a 0.008 SOL position", () => {
    expect(breakEvenGrossPct(0.008, SNIPER_FEES, 2)).toBeGreaterThan(0.5);
  });
});
