import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { filterCohort, isHolderFloorKept, isOkxClusterGateKept, replayJournal, replayTrade } from "./replay.js";

const HALTED_10USD =
  "/home/hatch/workspace/goals/solana-memecoin-flipping-system/hidden_files/spotter-test-20261122-v2-10usd-halted/journal.jsonl";
const V212_HALTED =
  "/home/hatch/workspace/goals/solana-memecoin-flipping-system/hidden_files/spotter-test-20261122-v2-10usd-v212-halted/journal.jsonl";

function entry(mint: string, price: number, sizeUsd: number, feesUsd: number, ts: string) {
  return { ts, mint, action: "paper_entry", reason: "test", price, sizeUsd, feesUsd };
}

function leg(mint: string, action: "partial" | "close", reason: string, price: number, sizeUsd: number, feesUsd: number, ts: string) {
  return { ts, mint, action, reason, price, sizeUsd, feesUsd };
}

describe("replayTrade on synthetic journals", () => {
  it("reproduces a TP1 + TP2 winner with exact P&L", () => {
    const t = replayTrade(
      entry("WINNER", 10000, 2.2, 0.07, "2026-11-23T00:00:00.000Z"),
      [
        leg("WINNER", "partial", "take profit 1 at +50%, sell 50%", 15000, 1.1, 0.0535, "2026-11-23T00:10:00.000Z"),
        leg("WINNER", "close", "take profit 2 at +100%, sell rest", 20000, 1.1, 0.07, "2026-11-23T00:20:00.000Z"),
      ],
      null,
      null,
    );
    // TP1 leg: 1.10*1.5 - 0.0535 - 1.10 = +0.4965
    // TP2 leg: 1.10*2.0 - 0.07 - 1.10 = +1.03
    // minus buy fee 0.07 -> +1.4565
    expect(t.outcome).toBe("WIN");
    expect(t.pnlUsd).toBeCloseTo(1.4565, 4);
    expect(t.legs).toHaveLength(2);
    expect(t.legs[0].ladderAgrees).toBe(true);
    expect(t.legs[1].ladderAgrees).toBe(true);
  });

  it("reproduces a hard-stop loser with exact P&L", () => {
    const t = replayTrade(
      entry("LOSER", 10000, 2.2, 0.07, "2026-11-23T00:00:00.000Z"),
      [leg("LOSER", "close", "hard stop -30% from entry", 6500, 2.2, 0.0469, "2026-11-23T00:05:00.000Z")],
      null,
      null,
    );
    // 2.20*0.65 - 0.0469 - 2.20 = -0.8169, minus buy fee 0.07 -> -0.8869
    expect(t.outcome).toBe("LOSS");
    expect(t.pnlUsd).toBeCloseTo(-0.8869, 4);
    expect(t.legs[0].ladderAgrees).toBe(true);
  });

  it("replays a halt settle at face value (not a ladder decision)", () => {
    const t = replayTrade(
      entry("HALTED", 10000, 2.2, 0.07, "2026-11-23T00:00:00.000Z"),
      [leg("HALTED", "close", "halt settle at last seen mc (watcher)", 11000, 2.2, 0.0766, "2026-11-23T00:30:00.000Z")],
      null,
      null,
    );
    expect(t.settledNotExited).toBe(true);
    expect(t.legs[0].ladderAction).toBeNull();
    expect(t.pnlUsd).toBeCloseTo(0.0734, 4);
  });

  it("estimates the buy fee for pre-v2.12 entries without feesUsd", () => {
    const withFee = replayTrade(
      entry("FEE1", 10000, 2.2, 0.07, "2026-11-23T00:00:00.000Z"),
      [leg("FEE1", "close", "hard stop -30% from entry", 6500, 2.2, 0.0469, "2026-11-23T00:05:00.000Z")],
      null,
      null,
      { solPriceUsd: 73 },
    );
    const noFeeField = replayTrade(
      { ts: "2026-11-23T00:00:00.000Z", mint: "FEE2", action: "paper_entry", reason: "test", price: 10000, sizeUsd: 2.2 },
      [leg("FEE2", "close", "hard stop -30% from entry", 6500, 2.2, 0.0469, "2026-11-23T00:05:00.000Z")],
      null,
      null,
      { solPriceUsd: 73 },
    );
    // Estimated buy fee at SOL $73, rent-inclusive (SOUL audit fix):
    // fixed 0.000055 + rent 0.00203928 SOL = $0.1529, plus 3% of
    // $2.20 = $0.066 -> ~$0.219. The old ~$0.07 estimate assumed
    // the rent was reclaimed. The P&L therefore differs from the
    // booked-fee trade by the rent (~$0.149), not by ~$0.
    expect(noFeeField.buyFeeUsd).toBeCloseTo(0.219, 2);
    expect(noFeeField.buyFeeEstimated).toBe(true);
    expect(noFeeField.pnlExact).toBe(false);
    expect(noFeeField.pnlUsd).toBeCloseTo(-1.0358, 3);
    expect(withFee.pnlUsd).toBeCloseTo(-0.8869, 4);
    expect((noFeeField.pnlUsd ?? 0) - (withFee.pnlUsd ?? 0)).toBeCloseTo(-0.149, 2);
  });

  it("a pre-v2.12 entry with no SOL price to estimate from is UNKNOWN, not estimated", () => {
    const t = replayTrade(
      { ts: "2026-11-23T00:00:00.000Z", mint: "FEE3", action: "paper_entry", reason: "test", price: 10000, sizeUsd: 2.2 },
      [leg("FEE3", "close", "hard stop -30% from entry", 6500, 2.2, 0.0469, "2026-11-23T00:05:00.000Z")],
      null,
      null,
    );
    // ReplayOptions.solPriceUsd has NO default: without it the buy
    // fee is null and the trade is unverifiable.
    expect(t.buyFeeUsd).toBeNull();
    expect(t.outcome).toBe("UNKNOWN");
    expect(t.pnlUsd).toBeNull();
  });
});

describe("replayJournal on the real $10 journals", () => {
  it("reproduces the 23-trade journal: 7W / 12L / 2 RUG / 2 UNKNOWN, net ≈ -$9.95 over verifiable trades", () => {
    const lines = [...readFileSync(HALTED_10USD, "utf8").split("\n"), ...readFileSync(V212_HALTED, "utf8").split("\n")];
    // SOL $73 is the documented live price during the $10 runs; it
    // is passed explicitly — replayJournal has no default price.
    const r = replayJournal(lines, { solPriceUsd: 73 });
    expect(r.trades).toHaveLength(23);
    expect(r.wins).toBe(7);
    expect(r.losses).toBe(12);
    expect(r.rugs).toBe(2);
    // The two halt settles (2JPYTUdB, 33xAhJRD) have no sizeUsd on
    // their close legs, so under the SOUL-audit rules their legs are
    // unverifiable and the trades are UNKNOWN — the old 8W/13L
    // counted them at face value with an invented cost basis.
    expect(r.unverifiableTrades).toBe(2);
    const unknownMints = r.trades.filter((t) => t.outcome === "UNKNOWN").map((t) => t.mint.slice(0, 8)).sort();
    expect(unknownMints).toEqual(["2JPYTUdB", "33xAhJRD"]);
    // Net -$9.95 over verifiable trades only (old: -$7.03). Two
    // causes: (a) the two halt-settle P&Ls are excluded instead of
    // booked at face value; (b) pre-v2.12 buy fees are now estimated
    // rent-inclusive (~$0.219 vs ~$0.07 each).
    expect(r.netUsd).toBeCloseTo(-9.95, 1);
    // The two rugs are the Jensen coins.
    const rugMints = r.trades.filter((t) => t.outcome === "RUG").map((t) => t.mint);
    expect(rugMints).toContain("Qwhtz9vcrNdSLBXTDAJCHSDw9NwaL1sCgWo9NmQpump");
    expect(rugMints).toContain("zZ8C2Mcr39RaAU7xVKE6cfnFd7oeucRJFi3jyPspump");
    // Ladder fidelity: every re-derivable leg (hard stop / TP1 / TP2 /
    // stall / time) must agree; trailing stops are unverifiable from
    // journal granularity (unrecorded peak) and are counted apart.
    expect(r.ladderChecked).toBeGreaterThan(0);
    expect(r.ladderAgreed).toBe(r.ladderChecked);
    expect(r.ladderUnverifiable).toBe(3); // the three trailing-stop closes
    // No torn lines, no closes without an entry, no trades open at EOF.
    expect(r.skippedLines).toBe(0);
    expect(r.skippedCloses).toBe(0);
    expect(r.openAtEof).toBe(0);
  });

  it("filterCohort reproduces the v2.14 gate replay on real data", () => {
    const lines = [...readFileSync(HALTED_10USD, "utf8").split("\n"), ...readFileSync(V212_HALTED, "utf8").split("\n")];
    const r = replayJournal(lines, { solPriceUsd: 73 });
    // Gate predicates live in replay.ts (isOkxClusterGateKept /
    // isHolderFloorKept) — replay analysis ONLY, never wired back
    // into the live poll: OKX is logged-only since v2.18.
    // OKX cluster gate: keep only cluster Low (or unknown — the
    // predicate is fail-open on null). Both rugs were cluster High.
    const clusterKept = filterCohort(r.trades, isOkxClusterGateKept);
    expect(clusterKept.rugs).toBe(0);
    expect(clusterKept.wins).toBe(7); // zero wins lost (the 8th old
    // "win" was the 2JPYTUdB halt settle, now UNKNOWN, not a win)
    // The one UNKNOWN carried is 2JPYTUdB (cluster Low, kept);
    // 33xAhJRD (cluster High) is filtered out.
    expect(clusterKept.unknown).toBe(1);
    // Holder floor >= 200 on the entry's OKX holders (parsed from the
    // okx_signal line, snapshotted at entry); null holders =
    // fail-closed, filtered out. The floor does NOT catch the rugs —
    // both had 2,000+ holders (2242, 2211) — it catches thin-holder
    // losses.
    const holderKept = filterCohort(r.trades, isHolderFloorKept);
    expect(holderKept.rugs).toBe(2);
    expect(holderKept.wins).toBe(7);
    expect(holderKept.losses).toBe(7);
    // The one UNKNOWN carried is 33xAhJRD (holders 613, kept);
    // 2JPYTUdB (holders 145) is filtered by the floor.
    expect(holderKept.unknown).toBe(1);
    // Combined (cluster Low AND holders >= 200): the v2.14 replay on
    // n=21 kept 7W/7L; on n=23 the two halt settles are both filtered
    // (2JPYTUdB by holders, 33xAhJRD by cluster) — and both are
    // UNKNOWN anyway, so the combined cohort carries 0 unknown.
    const combinedKept = filterCohort(r.trades, (t) => isOkxClusterGateKept(t) && isHolderFloorKept(t));
    expect(combinedKept.rugs).toBe(0);
    expect(combinedKept.wins).toBe(7);
    expect(combinedKept.losses).toBe(7);
    expect(combinedKept.unknown).toBe(0);
  });
});
