import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newState, type SpotterState } from "../../../packages/signals/src/spotter.js";
import { openPosition } from "../../../packages/exit/src/exit.js";
import { probeTick, settleWatcherTick } from "./watcher-tick.js";

const SOL = 70;

function stateWithPosition(entryMc: number, sizeUsd = 2.2, sizePctAtEntry = 15): SpotterState {
  const state = newState();
  state.equityUsd = 15;
  const pos = openPosition("p1", "MINT", entryMc, sizeUsd, 0);
  state.positions.push({
    id: pos.id,
    mint: "MINT",
    name: "Test",
    entryMcUsd: entryMc,
    sizeUsd,
    openedAtMs: 0,
    position: pos,
    lastMcUsd: entryMc,
    missedPolls: 0,
    // v2.25: thesis recorded at entry, size % of book at entry.
    entryThesis: "gem 71, fresh tier",
    sizePctAtEntry,
  });
  return state;
}

function readJournalLines(journalPath: string): Array<Record<string, unknown>> {
  return readFileSync(journalPath, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("settleWatcherTick (v2.11)", () => {
  it("holds between entry and TP1 and updates last mc", () => {
    const state = stateWithPosition(100);
    const r = settleWatcherTick(state, new Map([["MINT", 120]]), SOL, 60_000, null);
    expect(r).toEqual({ priced: 1, missing: 0, partials: 0, closed: 0, halted: false });
    expect(state.positions).toHaveLength(1);
    expect(state.positions[0].lastMcUsd).toBe(120);
    expect(state.equityUsd).toBe(15);
  });

  it("leaves a position alone when Jupiter returns no price", () => {
    const state = stateWithPosition(100);
    const r = settleWatcherTick(state, new Map([["MINT", null]]), SOL, 60_000, null);
    expect(r.missing).toBe(1);
    expect(r.priced).toBe(0);
    expect(state.positions).toHaveLength(1);
    expect(state.equityUsd).toBe(15);
  });

  it("journals a price_missing line when Jupiter returns no price (SOUL audit fix)", () => {
    // The old behaviour held the position silently; the new one
    // flags it in the journal so a price outage is visible, not a
    // quiet hold. The position is still held, not closed blind.
    const dir = mkdtempSync(join(tmpdir(), "sculgrok-watcher-"));
    const journalPath = join(dir, "journal.jsonl");
    const state = stateWithPosition(100);
    const r = settleWatcherTick(state, new Map([["MINT", null]]), SOL, 60_000, journalPath);
    expect(r.missing).toBe(1);
    expect(state.positions).toHaveLength(1);
    const lines = readFileSync(journalPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const missing = lines.filter((l) => l.action === "price_missing");
    expect(missing).toHaveLength(1);
    expect(missing[0].mint).toBe("MINT");
    expect(missing[0].reason).toContain("no Jupiter price");
  });

  it("sells 50 percent at TP1 +50%", () => {
    const state = stateWithPosition(100);
    const r = settleWatcherTick(state, new Map([["MINT", 150]]), SOL, 60_000, null);
    expect(r.partials).toBe(1);
    expect(state.positions).toHaveLength(1);
    expect(state.positions[0].position.remainingFraction).toBeCloseTo(0.5, 5);
    expect(state.positions[0].position.tp1Done).toBe(true);
    expect(state.equityUsd).toBeGreaterThan(15);
  });

  it("closes the rest at TP2 +100% after TP1", () => {
    const state = stateWithPosition(100);
    settleWatcherTick(state, new Map([["MINT", 150]]), SOL, 60_000, null);
    const r = settleWatcherTick(state, new Map([["MINT", 200]]), SOL, 120_000, null);
    expect(r.closed).toBe(1);
    expect(state.positions).toHaveLength(0);
    expect(state.wins).toBe(1);
    expect(state.closedMints["MINT"]).toBeDefined();
    expect(state.closedMints["MINT"].exitMcUsd).toBe(200);
  });

  it("closes all on the hard stop and records the worst loss", () => {
    const state = stateWithPosition(100);
    const r = settleWatcherTick(state, new Map([["MINT", 70]]), SOL, 60_000, null);
    expect(r.closed).toBe(1);
    expect(state.positions).toHaveLength(0);
    expect(state.losses).toBe(1);
    expect(state.worstLossPct).toBeLessThan(-0.3);
    expect(state.equityUsd).toBeLessThan(15);
  });

  it("trails 18 percent under the peak after TP1", () => {
    const state = stateWithPosition(100);
    settleWatcherTick(state, new Map([["MINT", 150]]), SOL, 60_000, null);
    // Peak 180 after this tick's hold update, then a drop to 147 (< 180 * 0.82).
    settleWatcherTick(state, new Map([["MINT", 180]]), SOL, 120_000, null);
    const r = settleWatcherTick(state, new Map([["MINT", 147]]), SOL, 180_000, null);
    expect(r.closed).toBe(1);
    expect(state.wins).toBe(1);
  });

  it("halts and settles open positions when equity breaches the daily loss limit", () => {
    const state = stateWithPosition(100);
    state.equityUsd = 7.6;
    const r = settleWatcherTick(state, new Map([["MINT", 70]]), SOL, 60_000, null);
    expect(r.halted).toBe(true);
    expect(state.halted).toBe(true);
    expect(state.positions).toHaveLength(0);
    expect(state.equityUsd).toBeLessThan(7.5);
  });

  it("counts a halt-settled position as a close (v2.12 audit fix)", () => {
    // Equity already under the halt line, position holding at entry:
    // the main loop holds it, the halt settle closes it — result.closed
    // used to stay 0, under-reporting closes on a halt day.
    const state = stateWithPosition(100);
    state.equityUsd = 7.4;
    const r = settleWatcherTick(state, new Map([["MINT", 100]]), SOL, 60_000, null);
    expect(r.halted).toBe(true);
    expect(r.closed).toBe(1);
    expect(state.positions).toHaveLength(0);
    expect(state.losses).toBe(1);
    expect(state.closedMints["MINT"]).toBeDefined();
  });

  it("prices multiple positions in one tick", () => {
    const state = stateWithPosition(100);
    const pos2 = openPosition("p2", "MINT2", 50, 2.2, 0);
    state.positions.push({
      id: pos2.id,
      mint: "MINT2",
      name: "Test2",
      entryMcUsd: 50,
      sizeUsd: 2.2,
      openedAtMs: 0,
      position: pos2,
      lastMcUsd: 50,
      missedPolls: 0,
    });
    const r = settleWatcherTick(
      state,
      new Map([
        ["MINT", 150],
        ["MINT2", 75],
      ]),
      SOL,
      60_000,
      null,
    );
    expect(r.priced).toBe(2);
    expect(r.partials).toBe(2);
  });
});

describe("probeTick (v2.13 lock-free pricing)", () => {
  it("detects a rug-style close without touching the live state", () => {
    const state = stateWithPosition(100);
    const { probe, result } = probeTick(state, new Map([["MINT", 3]]), SOL, 60_000);
    // The probe sees the -97% gap and closes it...
    expect(result.closed).toBe(1);
    expect(probe.positions).toHaveLength(0);
    expect(probe.equityUsd).toBeLessThan(15);
    // ...but the input state is untouched: no close, no equity move,
    // no journal write (probeTick never writes). The caller persists
    // the close by re-settling the fresh state under the lock.
    expect(state.positions).toHaveLength(1);
    expect(state.equityUsd).toBe(15);
    expect(state.positions[0].lastMcUsd).toBe(100);
  });

  it("the locked re-settle reproduces the probe's close exactly", () => {
    const state = stateWithPosition(100);
    const prices = new Map<string, number | null>([["MINT", 3]]);
    const { result: probeResult } = probeTick(state, prices, SOL, 60_000);
    const settleResult = settleWatcherTick(state, prices, SOL, 60_000, null);
    expect(settleResult.closed).toBe(probeResult.closed);
    expect(settleResult.partials).toBe(probeResult.partials);
    expect(settleResult.halted).toBe(probeResult.halted);
    expect(state.positions).toHaveLength(0);
  });

  it("a hold probe leaves the live state untouched (peaks advance only via persisted state)", () => {
    const state = stateWithPosition(100);
    const { result } = probeTick(state, new Map([["MINT", 120]]), SOL, 60_000);
    expect(result.closed).toBe(0);
    expect(result.partials).toBe(0);
    // The probe's clone advanced lastMcUsd to 120, but the input did
    // not — the caller discards hold probes, so peaks refresh only
    // when the spotter (every 5 min) or a settling tick persists.
    expect(state.positions[0].lastMcUsd).toBe(100);
    expect(state.equityUsd).toBe(15);
  });

  it("detects a TP1 partial without touching the live state", () => {
    const state = stateWithPosition(100);
    const { result } = probeTick(state, new Map([["MINT", 150]]), SOL, 60_000);
    expect(result.partials).toBe(1);
    expect(state.positions[0].position.remainingFraction).toBe(1);
    expect(state.equityUsd).toBe(15);
  });
});

describe("v2.25 close grading + thesis (logged only)", () => {
  it("a TP2 close journals the provisional grade, pending left-on-table, and size — but no thesis", () => {
    const dir = mkdtempSync(join(tmpdir(), "sculgrok-watcher-v225-"));
    const journalPath = join(dir, "journal.jsonl");
    const state = stateWithPosition(100);
    settleWatcherTick(state, new Map([["MINT", 150]]), SOL, 60_000, journalPath);
    const r = settleWatcherTick(state, new Map([["MINT", 200]]), SOL, 120_000, journalPath);
    expect(r.closed).toBe(1);
    const closes = readJournalLines(journalPath).filter((l) => l.action === "close");
    expect(closes).toHaveLength(1);
    const close = closes[0];
    expect(close.exitQuality).toBe("excellent"); // entry 100, peak 200, exit 200: all of the move kept
    expect(close.leftOnTablePct).toBeNull();
    expect(close.leftOnTableUsd).toBeNull();
    expect(String(close.leftOnTableReason)).toContain("pending post-exit");
    expect(close.sizePct).toBe(15);
    expect(close.sizePctFlagged).toBe(false);
    // Thesis rule: the close line carries no thesis field and its
    // reason does not restate the entry thesis.
    expect("entryThesis" in close).toBe(false);
    expect(String(close.reason)).not.toContain("gem 71");
    // The closed-mint record carries grading inputs, never the thesis.
    const rec = state.closedMints["MINT"] as unknown as Record<string, unknown>;
    expect(rec.entryMcUsd).toBe(100);
    expect(rec.peakMcUsd).toBe(200);
    expect(rec.exitCostBasisUsd).toBeCloseTo(1.1, 5); // remaining half of the 2.2 size
    expect(rec.graded).toBe(false);
    expect("entryThesis" in rec).toBe(false);
  });

  it("a partial journals sizePct only — no exitQuality while the position is open", () => {
    const dir = mkdtempSync(join(tmpdir(), "sculgrok-watcher-v225-"));
    const journalPath = join(dir, "journal.jsonl");
    const state = stateWithPosition(100);
    const r = settleWatcherTick(state, new Map([["MINT", 150]]), SOL, 60_000, journalPath);
    expect(r.partials).toBe(1);
    const partials = readJournalLines(journalPath).filter((l) => l.action === "partial");
    expect(partials).toHaveLength(1);
    expect(partials[0].sizePct).toBe(15);
    expect(partials[0].sizePctFlagged).toBe(false);
    expect("exitQuality" in partials[0]).toBe(false);
    expect("leftOnTablePct" in partials[0]).toBe(false);
  });

  it("a hard stop after a run-up grades round-tripped", () => {
    const dir = mkdtempSync(join(tmpdir(), "sculgrok-watcher-v225-"));
    const journalPath = join(dir, "journal.jsonl");
    const state = stateWithPosition(100);
    settleWatcherTick(state, new Map([["MINT", 150]]), SOL, 60_000, journalPath);
    const r = settleWatcherTick(state, new Map([["MINT", 70]]), SOL, 120_000, journalPath);
    expect(r.closed).toBe(1);
    const closes = readJournalLines(journalPath).filter((l) => l.action === "close");
    expect(closes).toHaveLength(1);
    // Entry 100, peak 150, exit 70: kept (70-100)/(150-100) = -60% of the move.
    expect(closes[0].exitQuality).toBe("round-tripped");
    expect(closes[0].sizePct).toBe(15);
  });

  it("sizePct over 25% is flagged on the close line", () => {
    const dir = mkdtempSync(join(tmpdir(), "sculgrok-watcher-v225-"));
    const journalPath = join(dir, "journal.jsonl");
    const state = stateWithPosition(100, 2.2, 30);
    const r = settleWatcherTick(state, new Map([["MINT", 200]]), SOL, 60_000, journalPath);
    // 200 is TP2 only after TP1, so this tick is a TP1 partial, not a
    // close — use a hard-stop close instead.
    expect(r.partials).toBe(1);
    const r2 = settleWatcherTick(state, new Map([["MINT", 70]]), SOL, 120_000, journalPath);
    expect(r2.closed).toBe(1);
    const closes = readJournalLines(journalPath).filter((l) => l.action === "close");
    expect(closes[0].sizePct).toBe(30);
    expect(closes[0].sizePctFlagged).toBe(true);
  });

  it("a halt settle journals the grading fields too", () => {
    const dir = mkdtempSync(join(tmpdir(), "sculgrok-watcher-v225-"));
    const journalPath = join(dir, "journal.jsonl");
    const state = stateWithPosition(100);
    state.equityUsd = 7.4;
    const r = settleWatcherTick(state, new Map([["MINT", 100]]), SOL, 60_000, journalPath);
    expect(r.halted).toBe(true);
    expect(r.closed).toBe(1);
    const closes = readJournalLines(journalPath).filter((l) => l.action === "close");
    expect(closes).toHaveLength(1);
    expect(closes[0].exitQuality).toBe("pending"); // never above entry
    expect(closes[0].leftOnTablePct).toBeNull();
    expect(closes[0].sizePct).toBe(15);
    expect("entryThesis" in closes[0]).toBe(false);
  });
});
