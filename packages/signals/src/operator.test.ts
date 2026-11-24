import { describe, expect, it } from "vitest";
import {
  analyzeOperator,
  BURN_ADDRESS,
  cpammSellImpactPct,
  operatorExcludedAddrs,
  operatorNote,
  realFloatPctFromTopHolders,
  type OperatorClusterInput,
} from "./operator.js";

const input = (operators: OperatorClusterInput["operators"], linkedPct: number | null = null): OperatorClusterInput => ({
  operators,
  checked: 6,
  unknown: 0,
  linkedPct,
});

const threeOps = [
  { members: ["A", "B"], pctSupply: 12, count: 2 },
  { members: ["C"], pctSupply: 5, count: 1 },
  { members: ["D", "E", "F"], pctSupply: 3, count: 3 },
];

describe("cpammSellImpactPct", () => {
  it("computes V / (L/2 + V)", () => {
    // Sell $1,000 into $10,000 liquidity: 1000 / (5000 + 1000) = 16.67%.
    expect(cpammSellImpactPct(1000, 10000)).toBeCloseTo(16.6667, 3);
    // Sell the whole reserve value: 5000 / (5000 + 5000) = 50%.
    expect(cpammSellImpactPct(5000, 10000)).toBeCloseTo(50, 6);
  });
  it("approaches 100% for a sale dwarfing the pool", () => {
    const v = cpammSellImpactPct(1_000_000, 1000);
    expect(v).not.toBeNull();
    expect(v as number).toBeGreaterThan(99);
    expect(v as number).toBeLessThan(100);
  });
  it("is 0 for a zero sale and null for missing inputs", () => {
    expect(cpammSellImpactPct(0, 10000)).toBe(0);
    expect(cpammSellImpactPct(1000, 0)).toBeNull();
    expect(cpammSellImpactPct(1000, -5)).toBeNull();
    expect(cpammSellImpactPct(NaN, 10000)).toBeNull();
    expect(cpammSellImpactPct(1000, NaN)).toBeNull();
  });
});

describe("operatorExcludedAddrs", () => {
  it("collects curve, pool-vault, locker and burn addresses", () => {
    const s = operatorExcludedAddrs({
      curveAddrs: ["curve1", undefined, ""],
      markets: [{ liquidityA: "vault1" }, { liquidityA: null }, {}],
      lockerOwners: { locker1: { owner: "x" }, locker2: {} },
    });
    expect([...s].sort()).toEqual([BURN_ADDRESS, "curve1", "locker1", "locker2", "vault1"].sort());
    expect(s.has(BURN_ADDRESS)).toBe(true);
    expect(s.has("curve1")).toBe(true);
    expect(s.has("vault1")).toBe(true);
    expect(s.has("locker1")).toBe(true);
  });
  it("accepts lockerOwners as a list too, and tolerates missing fields", () => {
    const s = operatorExcludedAddrs({ curveAddrs: [], markets: null, lockerOwners: ["lockerA"] });
    expect(s.has("lockerA")).toBe(true);
    expect(s.has(BURN_ADDRESS)).toBe(true);
    const empty = operatorExcludedAddrs({ curveAddrs: [] });
    expect([...empty]).toEqual([BURN_ADDRESS]);
  });
});

describe("realFloatPctFromTopHolders", () => {
  const holders = [
    { address: "curve", pct: 60, owner: "curveOwner" },
    { address: "poolVault", pct: 5, owner: "poolOwner" },
    { address: "burn", pct: 2, owner: BURN_ADDRESS },
    { address: "wallet1", pct: 8, owner: "wallet1" },
    { address: "wallet2", pct: 4, owner: "wallet2" },
  ];
  it("excludes curve, pool vault and burn addresses", () => {
    const excluded = new Set(["curve", "curveOwner", "poolVault", BURN_ADDRESS]);
    expect(realFloatPctFromTopHolders(holders, excluded)).toBeCloseTo(33, 6);
  });
  it("matches on owner as well as address", () => {
    const excluded = new Set(["curveOwner"]);
    // Only the curve entry (60%) is excluded via its owner.
    expect(realFloatPctFromTopHolders(holders, excluded)).toBeCloseTo(40, 6);
  });
  it("is null for an empty holder list or a fully excluded supply", () => {
    expect(realFloatPctFromTopHolders([], new Set())).toBeNull();
    // A list covering 100% of supply, all of it excluded.
    const full = [
      { address: "curve", pct: 60, owner: "curveOwner" },
      { address: "wallet1", pct: 40, owner: "wallet1" },
    ];
    expect(realFloatPctFromTopHolders(full, new Set(["curve", "curveOwner", "wallet1"]))).toBeNull();
  });
});

describe("analyzeOperator", () => {
  it("computes operator shares of float and modelled sell impacts", () => {
    // mc $100k, liquidity $20k, float 40%: largest 12% supply = 30%
    // of float = $12k; top3 20% supply = 50% of float = $20k.
    const f = analyzeOperator(input(threeOps, 20), { mcUsd: 100_000, liquidityUsd: 20_000, realFloatPct: 40 });
    expect(f.operatorsAvailable).toBe(true);
    expect(f.operatorCount).toBe(3);
    expect(f.largestOperatorPctSupply).toBe(12);
    expect(f.largestOperatorPctFloat).toBeCloseTo(30, 6);
    expect(f.largestOperatorUsd).toBeCloseTo(12_000, 6);
    expect(f.top3OperatorPctFloat).toBeCloseTo(50, 6);
    expect(f.linkedPctFloat).toBeCloseTo(50, 6);
    // Largest sell: 12000 / (10000 + 12000) = 54.5%.
    expect(f.sellImpactLargestPct).toBeCloseTo(54.5454, 3);
    // Top3 sell: 20000 / (10000 + 20000) = 66.7%.
    expect(f.sellImpactTop3Pct).toBeCloseTo(66.6667, 3);
    expect(f.sellImpactAllLinkedPct).toBeCloseTo(66.6667, 3);
    expect(f.model).toBe("cpamm-lower-bound");
  });
  it("clamps % -of-float at 100 when the float is understated", () => {
    // Largest operator 12% supply against a 10% float: raw 120%.
    const f = analyzeOperator(input(threeOps), { mcUsd: 100_000, liquidityUsd: 20_000, realFloatPct: 10 });
    expect(f.largestOperatorPctFloat).toBe(100);
    expect(f.top3OperatorPctFloat).toBe(100);
  });
  it("keeps % -of-float while sell impact goes null on missing market data", () => {
    const f = analyzeOperator(input(threeOps, 20), { mcUsd: null, liquidityUsd: null, realFloatPct: 40 });
    expect(f.largestOperatorPctFloat).toBeCloseTo(30, 6);
    expect(f.largestOperatorUsd).toBeNull();
    expect(f.sellImpactLargestPct).toBeNull();
    expect(f.sellImpactTop3Pct).toBeNull();
    expect(f.sellImpactAllLinkedPct).toBeNull();
  });
  it("keeps sell impact while % -of-float goes null on a missing float", () => {
    const f = analyzeOperator(input(threeOps, 20), { mcUsd: 100_000, liquidityUsd: 20_000, realFloatPct: null });
    expect(f.largestOperatorPctFloat).toBeNull();
    expect(f.sellImpactTop3Pct).toBeCloseTo(66.6667, 3);
  });
  it("reports unavailable with all metrics null when no payload", () => {
    const f = analyzeOperator(input(null), { mcUsd: 100_000, liquidityUsd: 20_000, realFloatPct: 40 });
    expect(f.operatorsAvailable).toBe(false);
    expect(f.operatorCount).toBeNull();
    expect(f.largestOperatorPctFloat).toBeNull();
    expect(f.sellImpactTop3Pct).toBeNull();
  });
  it("handles a single operator and an empty operator list", () => {
    const solo = analyzeOperator(input([{ members: ["A"], pctSupply: 4, count: 1 }]), { mcUsd: 50_000, liquidityUsd: 10_000, realFloatPct: 50 });
    expect(solo.operatorCount).toBe(1);
    expect(solo.largestOperatorPctFloat).toBeCloseTo(8, 6);
    expect(solo.top3OperatorPctFloat).toBeCloseTo(8, 6);
    const empty = analyzeOperator(input([]), { mcUsd: 50_000, liquidityUsd: 10_000, realFloatPct: 50 });
    expect(empty.operatorsAvailable).toBe(true);
    expect(empty.operatorCount).toBe(0);
    expect(empty.largestOperatorPctSupply).toBeNull();
  });
});

describe("operatorNote", () => {
  it("renders the key numbers and the model label", () => {
    const f = analyzeOperator(input(threeOps, 20), { mcUsd: 100_000, liquidityUsd: 20_000, realFloatPct: 40 });
    const note = operatorNote(f);
    expect(note).toContain("count=3");
    expect(note).toContain("largest=30.0% of float");
    expect(note).toContain("top3=50.0%");
    expect(note).toContain("sellImpact largest=54.5%");
    expect(note).toContain("modelled CPAMM lower bound");
  });
  it("renders unknown when no payload", () => {
    expect(operatorNote(analyzeOperator(input(null), { mcUsd: null, liquidityUsd: null, realFloatPct: null }))).toContain("unknown");
  });
});
