import { describe, expect, it } from "vitest";
import { analyzeCoBuy, coBuyNote, isCoBuyFlagged, type CoBuyResult } from "./cobuy.js";

function result(over: Partial<CoBuyResult>): CoBuyResult {
  return {
    mint: "TEST",
    txsAnalyzed: 53,
    fetched: 100,
    pages: 1,
    reachedBefore: true,
    windowStartTs: 1_700_000_000,
    windowEndTs: 1_700_000_100,
    distinctAcquirers: 2,
    totalAcquisitions: 2,
    totalAmount: 39_600_000,
    maxAcquirersInSlot: 1,
    topSlot: { slot: 472693180, acquirers: ["GG5ATPW7"], amount: 39_219_686 },
    topAcquirerShare: 0.99,
    slotGroups: [{ slot: 472693180, acquirers: ["GG5ATPW7"], amount: 39_219_686 }],
    topHolderCoBuy: null,
    ...over,
  };
}

describe("analyzeCoBuy", () => {
  it("computes topSlotShare from the busiest slot", () => {
    const f = analyzeCoBuy(result({}));
    expect(f.topSlotShare).toBeCloseTo(39_219_686 / 39_600_000, 4);
    expect(f.maxAcquirersInSlot).toBe(1);
    expect(f.topAcquirerShare).toBe(0.99);
    expect(f.maxTopHoldersInSlot).toBe(0);
    expect(f.topHolderPairs).toBe(0);
  });

  it("counts top-holder pairs and the max sharing a slot", () => {
    const f = analyzeCoBuy(
      result({
        topHolderCoBuy: {
          pairs: [{ a: "AAA", b: "BBB", sameSlot: [123], nearSlot: [] }],
          maxTopHoldersInSlot: 2,
        },
      }),
    );
    expect(f.maxTopHoldersInSlot).toBe(2);
    expect(f.topHolderPairs).toBe(1);
  });

  it("handles an empty window without crashing", () => {
    const f = analyzeCoBuy(result({ txsAnalyzed: 0, distinctAcquirers: 0, totalAcquisitions: 0, totalAmount: 0, topSlot: null, topAcquirerShare: 0, maxAcquirersInSlot: 0 }));
    expect(f.topSlotShare).toBe(0);
    expect(f.maxAcquirersInSlot).toBe(0);
  });
});

describe("isCoBuyFlagged (provisional thresholds)", () => {
  it("flags several acquirers taking a big share in one slot", () => {
    const f = analyzeCoBuy(result({ maxAcquirersInSlot: 4, topSlot: { slot: 1, acquirers: ["A", "B", "C", "D"], amount: 30_000_000 } }));
    expect(isCoBuyFlagged(f)).toBe(true);
  });

  it("does not flag several acquirers when the slot is a small share", () => {
    const f = analyzeCoBuy(result({ maxAcquirersInSlot: 4, topSlot: { slot: 1, acquirers: ["A", "B", "C", "D"], amount: 1_000_000 } }));
    expect(isCoBuyFlagged(f)).toBe(false);
  });

  it("flags top holders buying in the same slot", () => {
    const f = analyzeCoBuy(result({ topHolderCoBuy: { pairs: [{ a: "A", b: "B", sameSlot: [1], nearSlot: [] }], maxTopHoldersInSlot: 3 } }));
    expect(isCoBuyFlagged(f)).toBe(true);
  });

  it("does not flag a concentrated single buyer (DEQD2q8y shape)", () => {
    // One buyer took 99% of early buys in one slot, alone. That is
    // concentration, not a co-buy — the flag must not fire on it.
    const f = analyzeCoBuy(result({}));
    expect(isCoBuyFlagged(f)).toBe(false);
  });

  it("never flags on a partial window", () => {
    const f = analyzeCoBuy(result({ reachedBefore: false, maxAcquirersInSlot: 9, topSlot: { slot: 1, acquirers: ["A", "B", "C", "D", "E", "F", "G", "H", "I"], amount: 39_000_000 } }));
    expect(isCoBuyFlagged(f)).toBe(false);
  });
});

describe("coBuyNote", () => {
  it("renders the key numbers in one line", () => {
    const f = analyzeCoBuy(result({}));
    const note = coBuyNote(f, false);
    expect(note).toContain("maxAcqSlot=1");
    expect(note).toContain("topAcqShare=99%");
    expect(note).toContain("window=full");
    expect(note).toContain("flagged=false");
  });
});
