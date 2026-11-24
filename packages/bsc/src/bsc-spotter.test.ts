import { describe, expect, it } from "vitest";
import {
  bscReadiness,
  BSC_DEPRIORITIZE_POLLS,
  BSC_GRAD_RECHECK_PER_POLL,
  BSC_NO_MOVE_CHECKS_LIMIT,
  curveProgressPct,
  newBscState,
  normalizeBscState,
  pickGradRecheckCandidates,
  progressVelocityPctPerHour,
  rankBscCandidates,
  recheckVelocityPctPerHour,
  recordCurveCheck,
  volumeInputsForCandidate,
  type BscState,
} from "./bsc-spotter.js";
import { volumeVerdict } from "./volume.js";
import { breakEvenGrossPct } from "./fees.js";
import type { CurveInfo, DexBscPair } from "./pricing.js";

function dexPair(overrides: Partial<DexBscPair> = {}): DexBscPair {
  return {
    address: "0xabc",
    dexId: "fourmeme",
    priceNativeBnb: 0.000000005835,
    priceUsd: 0.000003185,
    marketCapUsd: 3185,
    fdvUsd: 3185,
    liquidityUsd: null,
    pairAddress: "0xpair",
    pairCreatedAtMs: Date.now() - 10 * 60 * 1000,
    txnsM5: { buys: 2, sells: 0 },
    txnsH1: { buys: 12, sells: 2 },
    txnsH6: { buys: 30, sells: 5 },
    txnsH24: { buys: 60, sells: 10 },
    volM5Usd: 1200,
    volH1Usd: 2400,
    volH6Usd: 5000,
    volH24Usd: 9000,
    priceChangeM5Pct: 2.1,
    priceChangeH1Pct: 4.2,
    priceChangeH6Pct: 8.0,
    ...overrides,
  };
}

describe("BSC candidate ranking", () => {
  it("ranks by mc velocity vs first sight; unseen tokens rank last", () => {
    const seen = {
      "0xaaa": { firstMcUsd: 3000, firstSeenMs: 1000 },
      "0xbbb": { firstMcUsd: 3000, firstSeenMs: 1000 },
    };
    const cands = [
      { address: "0xaaa", name: "A / BNB", symbol: "A", poolAddress: "p1", createdAtMs: 2000, fdvUsd: 9000, priceUsd: null, priceNativeBnb: null, volM5Usd: null, volH1Usd: null, tradersH1: null, buysH1: null, sellsH1: null, priceChangeH1Pct: null },
      { address: "0xbbb", name: "B / BNB", symbol: "B", poolAddress: "p2", createdAtMs: 3000, fdvUsd: 3300, priceUsd: null, priceNativeBnb: null, volM5Usd: null, volH1Usd: null, tradersH1: null, buysH1: null, sellsH1: null, priceChangeH1Pct: null },
      { address: "0xccc", name: "C / BNB", symbol: "C", poolAddress: "p3", createdAtMs: 4000, fdvUsd: 3000, priceUsd: null, priceNativeBnb: null, volM5Usd: null, volH1Usd: null, tradersH1: null, buysH1: null, sellsH1: null, priceChangeH1Pct: null },
    ];
    const ranked = rankBscCandidates(cands, seen);
    expect(ranked.map((c) => c.address)).toEqual(["0xaaa", "0xbbb", "0xccc"]); // +200%, +10%, unseen (0%)
  });
});

describe("v2 volume inputs (DexScreener + GeckoTerminal snapshot)", () => {
  it("prefers DexScreener volume, falls back to the GeckoTerminal snapshot", () => {
    const cand = {
      address: "0xabc", name: "A / BNB", symbol: "A", poolAddress: "p1", createdAtMs: Date.now() - 30 * 60 * 1000,
      fdvUsd: 5000, priceUsd: null, priceNativeBnb: null,
      volM5Usd: 800, volH1Usd: 1500, tradersH1: 25, buysH1: 20, sellsH1: 8, priceChangeH1Pct: 3.1,
    };
    const input = volumeInputsForCandidate(cand, dexPair(), Date.now());
    expect(input.volM5Usd).toBe(1200); // DexScreener wins over the GT snapshot.
    expect(input.volH1Usd).toBe(2400);
    expect(input.tradersH1).toBe(25);
    expect(input.buysH1).toBe(12);
    expect(input.sellsH1).toBe(2);
    expect(input.pairAgeH).toBeCloseTo(10 / 60, 2);
    // Pre-grad pair: DexScreener volume null -> GT snapshot used.
    const preGrad = volumeInputsForCandidate(cand, dexPair({ volM5Usd: null, volH1Usd: null }), Date.now());
    expect(preGrad.volM5Usd).toBe(800);
    expect(preGrad.volH1Usd).toBe(1500);
  });

  it("a graduated token with real volume passes the volume gates", () => {
    const cand = {
      address: "0xabc", name: "A / BNB", symbol: "A", poolAddress: "p1", createdAtMs: Date.now() - 30 * 60 * 1000,
      fdvUsd: 50000, priceUsd: null, priceNativeBnb: null,
      volM5Usd: null, volH1Usd: null, tradersH1: 40, buysH1: 30, sellsH1: 10, priceChangeH1Pct: 5,
    };
    const hot = dexPair({ dexId: "pancakeswap", marketCapUsd: 50000, liquidityUsd: 17000, txnsH1: { buys: 40, sells: 5 }, volM5Usd: 4000, volH1Usd: 12000, priceChangeH1Pct: 6 });
    const v = volumeVerdict(volumeInputsForCandidate(cand, hot, Date.now()));
    expect(v.pass).toBe(true);
  });
});

describe("v2 fee bar (unchanged model, now standalone)", () => {
  it("pre-graduation at $3.30 is fee-blocked (the 0.001 BNB minimum)", () => {
    expect(breakEvenGrossPct(3.3 / 545.22, false)).toBeGreaterThan(0.25);
  });

  it("graduated at $3.30 passes the fee bar", () => {
    expect(breakEvenGrossPct(3.3 / 545.22, true)).toBeLessThan(0.25);
  });
});

describe("graduation re-check picking", () => {
  const now = 1_000_000_000_000;
  function seenEntry(overrides: Record<string, unknown> = {}): { firstMcUsd: number; firstSeenMs: number } {
    return { firstMcUsd: 3000, firstSeenMs: now - 60 * 60 * 1000, ...overrides };
  }

  it("P1+P4: 2 velocity-ranked progress slots + round-robin + stalest (legacy progress-desc order is gone)", () => {
    // ddd has the highest progress/age prior (85% in 10 min, age
    // floored at 15 min -> 340%/h); bbb 85% in 1h -> 85%/h; aaa
    // 20% in 1h -> 20%/h. ccc is never-measured (round-robin).
    // aaa is the only measured token left for the stalest slot.
    const seen = {
      "0xaaa": seenEntry({ curveProgressPct: 20 }),
      "0xbbb": seenEntry({ curveProgressPct: 85 }),
      "0xccc": seenEntry({ firstSeenMs: now - 5 * 60 * 1000 }),
      "0xddd": seenEntry({ curveProgressPct: 85, firstSeenMs: now - 10 * 60 * 1000 }),
    };
    const { toCheck } = pickGradRecheckCandidates(seen, new Set(), {}, {}, now, 4);
    expect(toCheck).toEqual(["0xddd", "0xbbb", "0xccc", "0xaaa"]);
  });

  it("skips open positions, recently closed mints, and tokens older than 24h", () => {
    const seen = {
      "0xopen": seenEntry({ curveProgressPct: 99 }),
      "0xclosed": seenEntry({ curveProgressPct: 99 }),
      "0xold": seenEntry({ curveProgressPct: 99, firstSeenMs: now - 25 * 60 * 60 * 1000 }),
      "0xok": seenEntry({ curveProgressPct: 50 }),
    };
    const { toCheck } = pickGradRecheckCandidates(seen, new Set(["0xopen"]), { "0xclosed": now - 5 * 60 * 1000 }, {}, now, 4);
    expect(toCheck).toEqual(["0xok"]);
  });

  it("already-graduated tokens go to the graduated list (unless in cooldown)", () => {
    const seen = {
      "0xgrad": seenEntry({ graduated: true }),
      "0xgradcool": seenEntry({ graduated: true }),
    };
    const blocked = { "0xgradcool": { blockedAtMs: now - 10 * 60 * 1000, mcUsd: 5000 } };
    const { toCheck, alreadyGraduated } = pickGradRecheckCandidates(seen, new Set(), {}, blocked, now, 4);
    expect(toCheck).toEqual([]);
    expect(alreadyGraduated).toEqual(["0xgrad"]);
  });

  it("caps at the per-poll budget", () => {
    const seen: Record<string, { firstMcUsd: number; firstSeenMs: number }> = {};
    for (let i = 0; i < 10; i++) seen["0x" + i] = seenEntry({ curveProgressPct: i });
    const { toCheck } = pickGradRecheckCandidates(seen, new Set(), {}, {}, now);
    expect(toCheck).toHaveLength(BSC_GRAD_RECHECK_PER_POLL);
    expect(toCheck[0]).toBe("0x9"); // highest progress first
  });

  it("curveProgressPct is -1 on missing data, 0-100 otherwise", () => {
    expect(curveProgressPct(null)).toBe(-1);
    expect(curveProgressPct({ version: 2, tokenManager: "0x5c95", priceBnb: 1e-9, tradingFeeRatePct: 100, minTradingFeeBnb: 0, remainingTokens: 1, saleSupplyTokens: 800000000, raisedBnb: 9.15, thresholdBnb: 18.3, graduated: false })).toBeCloseTo(50, 6);
    expect(curveProgressPct({ version: 2, tokenManager: "0x5c95", priceBnb: 1e-9, tradingFeeRatePct: 100, minTradingFeeBnb: 0, remainingTokens: 0, saleSupplyTokens: 800000000, raisedBnb: 18, thresholdBnb: 18, graduated: true })).toBe(100);
  });
});

describe("P1+P4 re-check slot allocation", () => {
  const now = 1_000_000_000_000;
  const hour = 60 * 60 * 1000;
  function rec(overrides: Record<string, unknown> = {}): { firstMcUsd: number; firstSeenMs: number } {
    return { firstMcUsd: 3000, firstSeenMs: now - 6 * hour, ...overrides };
  }

  it("allocates 2 velocity slots + 1 oldest never-measured + 1 stalest measured", () => {
    const seen = {
      // m2 gains 20%/h, m1 gains 5%/h -> the 2 progress slots.
      "0xm1": rec({ curveProgressPct: 80, lastProgressPct: 75, lastProgressMs: now - hour, lastCurveCheckMs: now - 5 * 60 * 1000 }),
      "0xm2": rec({ curveProgressPct: 30, lastProgressPct: 10, lastProgressMs: now - hour, lastCurveCheckMs: now - 5 * 60 * 1000 }),
      // m3 is flat at 60% (two readings 1h apart, +0pp) and its data is 5h old -> stalest slot only.
      "0xm3": rec({ curveProgressPct: 60, lastProgressPct: 60, lastProgressMs: now - 6 * hour, lastCurveCheckMs: now - 5 * hour }),
      // m4 gains only 1%/h -> beaten in the progress slots, not stalest.
      "0xm4": rec({ curveProgressPct: 10, lastProgressPct: 9, lastProgressMs: now - hour, lastCurveCheckMs: now - 5 * 60 * 1000 }),
      // n1 is the oldest never-measured token -> round-robin slot.
      "0xn1": rec({ firstSeenMs: now - 5 * hour }),
      "0xn2": rec({ firstSeenMs: now - hour }),
      "0xn3": rec({ firstSeenMs: now - 30 * 60 * 1000 }),
    };
    const { toCheck } = pickGradRecheckCandidates(seen, new Set(), {}, {}, now, 4);
    expect(toCheck).toEqual(["0xm2", "0xm1", "0xn1", "0xm3"]);
  });

  it("velocity ranking: a gainer beats a flat token at the same progress, and a low fast gainer beats a high flat one", () => {
    const seen = {
      "0xflat50": rec({ curveProgressPct: 50, lastProgressPct: 50, lastProgressMs: now - hour, lastCurveCheckMs: now }),
      "0xgain50": rec({ curveProgressPct: 50, lastProgressPct: 40, lastProgressMs: now - hour, lastCurveCheckMs: now }),
      "0xgain5": rec({ curveProgressPct: 5, lastProgressPct: 0, lastProgressMs: now - hour, lastCurveCheckMs: now }),
    };
    const { toCheck } = pickGradRecheckCandidates(seen, new Set(), {}, {}, now, 4);
    // Progress slots: gain50 (+10%/h), gain5 (+5%/h). Flat50
    // (+0%/h) only gets the stalest slot, last.
    expect(toCheck).toEqual(["0xgain50", "0xgain5", "0xflat50"]);
  });

  it("legacy records bootstrap velocity from the progress/age prior", () => {
    // No lastProgress on any record: 57.6% in 6h priors at
    // 9.6%/h, 9.6% at 1.6%/h, 0.11% near zero.
    const seen = {
      "0xhi": rec({ curveProgressPct: 57.6 }),
      "0xmid": rec({ curveProgressPct: 9.6 }),
      "0xlo": rec({ curveProgressPct: 0.11 }),
    };
    const { toCheck } = pickGradRecheckCandidates(seen, new Set(), {}, {}, now, 2);
    expect(toCheck).toEqual(["0xhi", "0xmid"]);
    const hi = seen["0xhi"] as { curveProgressPct?: number; firstSeenMs: number; lastCurveCheckMs?: number; lastProgressPct?: number; lastProgressMs?: number };
    expect(recheckVelocityPctPerHour(hi, now)).toBeCloseTo(9.6, 6);
    expect(progressVelocityPctPerHour(hi)).toBeNull();
  });

  it("a just-seen high-progress token priors high (age floored at 15 min) so it earns a second reading fast", () => {
    const seen = {
      "0xold": rec({ curveProgressPct: 57.6 }),
      "0xnew": rec({ curveProgressPct: 50, firstSeenMs: now - 10 * 60 * 1000 }),
    };
    const { toCheck } = pickGradRecheckCandidates(seen, new Set(), {}, {}, now, 2);
    expect(toCheck[0]).toBe("0xnew");
    expect(recheckVelocityPctPerHour(seen["0xnew"], now)).toBeCloseTo(200, 6); // 50% / 0.25h floor
  });

  it("recordCurveCheck shifts history so the second reading yields a measured velocity", () => {
    const r: { firstMcUsd: number; firstSeenMs: number; curveProgressPct?: number; lastCurveCheckMs?: number; lastProgressPct?: number; lastProgressMs?: number } = {
      firstMcUsd: 3000,
      firstSeenMs: now - 2 * hour,
    };
    const curve = (raised: number): CurveInfo => ({
      version: 2, tokenManager: null, priceBnb: 1e-9, tradingFeeRatePct: 100, minTradingFeeBnb: 0, remainingTokens: null, saleSupplyTokens: null,
      raisedBnb: raised, thresholdBnb: 100, graduated: false,
    });
    recordCurveCheck(r, curve(40), now - hour, 100);
    expect(r.curveProgressPct).toBe(40);
    expect(progressVelocityPctPerHour(r)).toBeNull(); // one reading only
    recordCurveCheck(r, curve(50), now, 101);
    expect(r.curveProgressPct).toBe(50);
    expect(r.lastProgressPct).toBe(40);
    expect(progressVelocityPctPerHour(r)).toBeCloseTo(10, 6); // +10pp in 1h
  });
});

describe("P1 staleness decay", () => {
  const now = 1_000_000_000_000;
  const fiveMin = 5 * 60 * 1000;
  function flatCurve(): CurveInfo {
    return { version: 2, tokenManager: null, priceBnb: 1e-9, tradingFeeRatePct: 100, minTradingFeeBnb: 0, remainingTokens: null, saleSupplyTokens: null, raisedBnb: 10, thresholdBnb: 100, graduated: false };
  }

  it("12 consecutive no-move checks deprioritize for 24 polls, then the token is eligible again", () => {
    const rec: { firstMcUsd: number; firstSeenMs: number; curveProgressPct?: number; lastCurveCheckMs?: number; lastProgressPct?: number; lastProgressMs?: number; noMoveChecks?: number; deprioritizeUntilPoll?: number } = {
      firstMcUsd: 3000,
      firstSeenMs: now - 60 * 60 * 1000,
      curveProgressPct: 10,
      lastCurveCheckMs: now,
    };
    for (let i = 0; i < BSC_NO_MOVE_CHECKS_LIMIT; i++) {
      recordCurveCheck(rec, flatCurve(), now + (i + 1) * fiveMin, 100 + i);
    }
    expect(rec.noMoveChecks).toBe(0); // reset on arming
    expect(rec.deprioritizeUntilPoll).toBe(111 + BSC_DEPRIORITIZE_POLLS); // 12th check ran at poll 111
    const seen = { "0xflat": rec };
    // Deprioritized: excluded at poll 134, eligible again at 135.
    expect(pickGradRecheckCandidates(seen, new Set(), {}, {}, now, 4, 134).toCheck).toEqual([]);
    expect(pickGradRecheckCandidates(seen, new Set(), {}, {}, now, 4, 135).toCheck).toEqual(["0xflat"]);
  });

  it("a real move resets the no-move counter before it can arm", () => {
    const rec: { firstMcUsd: number; firstSeenMs: number; curveProgressPct?: number; lastCurveCheckMs?: number; lastProgressPct?: number; lastProgressMs?: number; noMoveChecks?: number; deprioritizeUntilPoll?: number } = {
      firstMcUsd: 3000,
      firstSeenMs: now - 60 * 60 * 1000,
      curveProgressPct: 10,
      lastCurveCheckMs: now,
    };
    for (let i = 0; i < 5; i++) recordCurveCheck(rec, flatCurve(), now + (i + 1) * fiveMin, 100 + i);
    expect(rec.noMoveChecks).toBe(5);
    const moved: CurveInfo = { ...flatCurve(), raisedBnb: 11 }; // 10% -> 11% (+1pp)
    recordCurveCheck(rec, moved, now + 6 * fiveMin, 105);
    expect(rec.noMoveChecks).toBe(0);
    expect(rec.deprioritizeUntilPoll).toBeUndefined();
  });

  it("without a poll number the decay does not arm (legacy callers keep old behaviour)", () => {
    const rec: { firstMcUsd: number; firstSeenMs: number; curveProgressPct?: number; lastCurveCheckMs?: number; lastProgressPct?: number; lastProgressMs?: number; noMoveChecks?: number; deprioritizeUntilPoll?: number } = {
      firstMcUsd: 3000,
      firstSeenMs: now - 60 * 60 * 1000,
      curveProgressPct: 10,
      lastCurveCheckMs: now,
    };
    for (let i = 0; i < BSC_NO_MOVE_CHECKS_LIMIT + 2; i++) {
      recordCurveCheck(rec, flatCurve(), now + (i + 1) * fiveMin);
    }
    expect(rec.deprioritizeUntilPoll).toBeUndefined();
    expect(rec.noMoveChecks).toBe(BSC_NO_MOVE_CHECKS_LIMIT + 2);
    // And pickGradRecheckCandidates without nowPoll ignores a
    // deprioritizeUntilPoll set by another path.
    rec.deprioritizeUntilPoll = 9999;
    expect(pickGradRecheckCandidates({ "0xflat": rec }, new Set(), {}, {}, now, 4).toCheck).toEqual(["0xflat"]);
  });

  it("a null curve reading does not count as a no-move check", () => {
    const rec: { firstMcUsd: number; firstSeenMs: number; curveProgressPct?: number; lastCurveCheckMs?: number; lastProgressPct?: number; lastProgressMs?: number; noMoveChecks?: number; deprioritizeUntilPoll?: number } = {
      firstMcUsd: 3000,
      firstSeenMs: now - 60 * 60 * 1000,
      curveProgressPct: 10,
      lastCurveCheckMs: now,
      noMoveChecks: 11,
    };
    recordCurveCheck(rec, null, now + fiveMin, 100);
    expect(rec.noMoveChecks).toBe(11);
    expect(rec.deprioritizeUntilPoll).toBeUndefined();
  });
});

describe("BSC state + readiness", () => {
  it("new state starts at $15, unhalted, cluster gate available (v3)", () => {
    const s = newBscState(1000);
    expect(s.equityUsd).toBe(15);
    expect(s.halted).toBe(false);
    expect(s.clusterGateAvailable).toBe(true);
    expect(s.clusterBlocks).toBe(0);
    expect(s.positions).toEqual([]);
  });

  it("normalize repairs bad numbers and forces clusterGateAvailable true (v3)", () => {
    const s = normalizeBscState({ equityUsd: NaN, trades: "x" as unknown as number, clusterGateAvailable: false as unknown as boolean, clusterBlocks: "x" as unknown as number } as Partial<BscState>);
    expect(s.equityUsd).toBe(0);
    expect(s.trades).toBe(0);
    expect(s.clusterGateAvailable).toBe(true);
    expect(s.clusterBlocks).toBe(0);
  });

  it("readiness mirrors the Solana bar, scaled to $15 (needs $16.50)", () => {
    const s = newBscState();
    const r = bscReadiness(s);
    expect(r.ready).toBe(false);
    expect(r.reasons.join(" ")).toContain("need >=20 trades");
    const ready: BscState = {
      ...s,
      trades: 20,
      wins: 10,
      losses: 8,
      grossWinsUsd: 12,
      grossLossesUsd: 8,
      equityUsd: 17,
      priceSourceLostCloses: 0,
      worstLossPct: -0.2,
    };
    expect(bscReadiness(ready).ready).toBe(true);
    expect(bscReadiness({ ...ready, equityUsd: 16.4 }).ready).toBe(false);
  });
});
