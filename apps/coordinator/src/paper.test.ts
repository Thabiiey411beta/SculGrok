import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPaper } from "./paper.js";

describe("runPaper", () => {
  it("runs winner, loser, stall and rug-blocked scenarios", () => {
    const dir = mkdtempSync(join(tmpdir(), "sculgrok-paper-"));
    // SOL $73 is the documented live price during the $15 run,
    // passed explicitly — runPaper has no default price.
    const summary = runPaper(join(dir, "journal.jsonl"), 73);
    expect(summary.startingEquityUsd).toBe(15);
    expect(summary.trades).toBe(3);
    expect(summary.blocked).toBe(1);
    expect(summary.wins).toBe(1);
    expect(summary.losses).toBe(2);
    // P&L is now proceeds - size - buyLegCostUsd (SOUL audit fix:
    // the old formula never subtracted the buy leg). Verified:
    // $15.5994 — the winner covers the loser, the stall and the
    // buy-leg costs. (Net +$0.5994 vs +$0.2455 at the $10 start:
    // positions are 22% of a bigger equity and the fixed per-leg
    // fees are a smaller fraction.)
    expect(summary.endingEquityUsd).toBeCloseTo(15.5994, 3);
    expect(summary.endingEquityUsd).toBeGreaterThan(0);
  });

  it("throws without a live SOL price (no hardcoded fallback)", () => {
    const dir = mkdtempSync(join(tmpdir(), "sculgrok-paper-"));
    expect(() => runPaper(join(dir, "journal.jsonl"), 0)).toThrow();
    expect(() => runPaper(join(dir, "journal.jsonl"), Number.NaN)).toThrow();
  });
});
