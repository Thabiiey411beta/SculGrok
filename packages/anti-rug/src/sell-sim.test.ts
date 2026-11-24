import { describe, expect, it } from "vitest";
import {
  decideSellSim,
  expectedOutLamports,
  parseSellQuote,
  tokenBaseUnits,
} from "./sell-sim.js";

describe("sell-sim quote parse", () => {
  it("parses outAmount + priceImpactPct (V2 deprecated fallback, decimal ratio)", () => {
    expect(parseSellQuote({ outAmount: "123456", priceImpactPct: "0.02" })).toEqual({
      outAmountLamports: 123456,
      priceImpactPct: 0.02,
    });
  });

  it("parses V2 priceImpact as percentage points, not a ratio", () => {
    // V2 /order priceImpact -0.1 means -0.1%, i.e. -0.001 as a ratio.
    expect(parseSellQuote({ outAmount: "123456", priceImpact: -0.1 })).toEqual({
      outAmountLamports: 123456,
      priceImpactPct: -0.001,
    });
    // V2 priceImpact wins over the deprecated priceImpactPct when both are present.
    expect(parseSellQuote({ outAmount: "123456", priceImpact: 0.5, priceImpactPct: "0.02" })).toEqual({
      outAmountLamports: 123456,
      priceImpactPct: 0.005,
    });
  });

  it("parses V1 priceImpactPct as a decimal ratio", () => {
    expect(parseSellQuote({ outAmount: "123456", priceImpactPct: "0.02" }, "v1")).toEqual({
      outAmountLamports: 123456,
      priceImpactPct: 0.02,
    });
  });

  it("rejects a response carrying a transaction (quote-only use)", () => {
    expect(parseSellQuote({ outAmount: "100", transaction: "deadbeef" })).toBeNull();
    expect(parseSellQuote({ outAmount: "100", transaction: null })).not.toBeNull();
  });

  it("rejects an empty routePlan", () => {
    expect(parseSellQuote({ outAmount: "100", routePlan: [] })).toBeNull();
    expect(parseSellQuote({ outAmount: "100", routePlan: [{ swapInfo: {} }] })).not.toBeNull();
  });

  it("accepts a missing priceImpactPct (null, not a failure)", () => {
    expect(parseSellQuote({ outAmount: "1000" })).toEqual({ outAmountLamports: 1000, priceImpactPct: null });
  });

  it("rejects a missing or negative outAmount", () => {
    expect(parseSellQuote({})).toBeNull();
    expect(parseSellQuote({ outAmount: "-5" })).toBeNull();
    expect(parseSellQuote(null)).toBeNull();
    expect(parseSellQuote("nope")).toBeNull();
  });
});

describe("sell-sim token sizing", () => {
  it("sizes the position in base units from supply", () => {
    // $2.20 at $55,734 mc, supply 1e9, 6 decimals:
    // tokens = 2.20 * 1e9 / 55734 ≈ 39,473 -> 39,473,000,000 base units.
    const units = tokenBaseUnits(2.2, 55734, 1_000_000_000, 6);
    expect(units).toBeGreaterThan(39_000_000_000);
    expect(units).toBeLessThan(40_000_000_000);
  });

  it("returns null when supply is missing (fail-closed)", () => {
    expect(tokenBaseUnits(2.2, 55734, null, 6)).toBeNull();
    expect(tokenBaseUnits(2.2, 55734, 0, 6)).toBeNull();
    expect(tokenBaseUnits(2.2, 55734, undefined, 6)).toBeNull();
  });

  it("returns null when decimals are absent (no default 6 — SOUL audit fix)", () => {
    // The old code defaulted missing decimals to 6, which silently
    // sized the sell sim wrong for any other decimals. Missing
    // decimals now blocks the sell sim instead.
    expect(tokenBaseUnits(2.2, 55734, 1_000_000_000, null)).toBeNull();
    expect(tokenBaseUnits(2.2, 55734, 1_000_000_000, undefined)).toBeNull();
    expect(tokenBaseUnits(2.2, 55734, 1_000_000_000, -1)).toBeNull();
    expect(tokenBaseUnits(2.2, 55734, 1_000_000_000, Number.NaN)).toBeNull();
    // 0 decimals is a real value (10^0 = 1), not missing data.
    expect(tokenBaseUnits(2.2, 55734, 1_000_000_000, 0)).toBe(39473);
  });

  it("returns null for a zero or negative position / mc", () => {
    expect(tokenBaseUnits(0, 55734, 1_000_000_000, 6)).toBeNull();
    expect(tokenBaseUnits(2.2, 0, 1_000_000_000, 6)).toBeNull();
  });
});

describe("sell-sim decision", () => {
  // expectedOutLamports returns null on invalid input; the fixture
  // inputs are valid, so the non-null assertion is safe here.
  const expected = expectedOutLamports(2.2, 73)!; // ~30,136,986 lamports

  it("passes a healthy quote", () => {
    const d = decideSellSim({ outAmountLamports: expected, priceImpactPct: 0.01 }, expected);
    expect(d.verdict).toBe("pass");
  });

  it("passes when priceImpactPct is missing but output is healthy", () => {
    const d = decideSellSim({ outAmountLamports: expected, priceImpactPct: null }, expected);
    expect(d.verdict).toBe("pass");
  });

  it("fails on a null quote or null expected output (unknown input blocks)", () => {
    expect(decideSellSim(null, expected).verdict).toBe("fail");
    expect(decideSellSim({ outAmountLamports: expected, priceImpactPct: 0.01 }, null).verdict).toBe("fail");
  });

  it("blocks a zero-output quote (honeypot / dead pool)", () => {
    const d = decideSellSim({ outAmountLamports: 0, priceImpactPct: 0 }, expected);
    expect(d.verdict).toBe("fail");
    expect(d.reason).toContain("outAmount 0");
  });

  it("blocks output under 50% of expected", () => {
    const d = decideSellSim({ outAmountLamports: Math.floor(expected * 0.4), priceImpactPct: 0.01 }, expected);
    expect(d.verdict).toBe("fail");
    expect(d.reason).toContain("40.0%");
  });

  it("passes output just above the 50% line", () => {
    const d = decideSellSim({ outAmountLamports: Math.floor(expected * 0.51), priceImpactPct: 0.01 }, expected);
    expect(d.verdict).toBe("pass");
  });

  it("blocks extreme price impact even with healthy output", () => {
    const d = decideSellSim({ outAmountLamports: expected, priceImpactPct: 0.6 }, expected);
    expect(d.verdict).toBe("fail");
    expect(d.reason).toContain("60.0%");
  });

  it("blocks impact above 10% even with healthy output", () => {
    const d = decideSellSim({ outAmountLamports: expected, priceImpactPct: 0.11 }, expected);
    expect(d.verdict).toBe("fail");
    expect(d.reason).toContain("11.0%");
  });

  it("passes impact in the 5-10% caution band, with the caution noted", () => {
    const d = decideSellSim({ outAmountLamports: expected, priceImpactPct: 0.06 }, expected);
    expect(d.verdict).toBe("pass");
    expect(d.reason).toContain("caution");
  });

  it("returns null expected output on invalid input (no silent 0)", () => {
    expect(expectedOutLamports(0, 73)).toBeNull();
    expect(expectedOutLamports(2.2, 0)).toBeNull();
    expect(expectedOutLamports(Number.NaN, 73)).toBeNull();
  });
});
