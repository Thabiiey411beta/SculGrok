import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPaper } from "./paper.js";

describe("runPaper", () => {
  it("runs winner, loser, stall and rug-blocked scenarios", () => {
    const dir = mkdtempSync(join(tmpdir(), "sculgrok-paper-"));
    const summary = runPaper(join(dir, "journal.jsonl"));
    expect(summary.startingEquityUsd).toBe(3);
    expect(summary.trades).toBe(3);
    expect(summary.blocked).toBe(1);
    expect(summary.endingEquityUsd).toBeGreaterThan(0);
  });
});
