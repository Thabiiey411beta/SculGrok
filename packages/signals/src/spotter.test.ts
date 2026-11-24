import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireLock,
  BLOCKED_COOLDOWN_MS,
  blockedCooldownRemaining,
  buildSecondLookCoin,
  bundlePctFromCluster,
  buySellRatioFromJupiterStats,
  classifyRugcheckFailure,
  creatorBalancePct,
  deepCheckJournal,
  devSoldPctFromCluster,
  discoverySource,
  entryFeeUsd,
  entryFlowStats,
  entryGemNote,
  entryHeatStats,
  entryLiqVol,
  entryVolStats,
  fetchMarketData,
  filterCooldownBlocked,
  finalizeExitGrade,
  finalizeExitGradeNow,
  gemInputFromCoin,
  gradeClose,
  heatNoteText,
  holderExits,
  HOLDER_FLOOR,
  FRESH_TIER_MIN_GEM,
  isElevatedRisk,
  isFreshTier,
  isHolderFloorBlock,
  isLiquidityFloorBlock,
  isOkxClusterGateBlock,
  isReentryBlocked,
  jupiterRecentToCoin,
  LIQ_VOL_SUSPICIOUS_BELOW,
  LIQUIDITY_FLOOR_USD,
  liqVolNoteText,
  loadTrustedWallets,
  lpLockedPct,
  NEAR_MISS_COOLDOWN_MS,
  newState,
  newWalletInflowFromJupiterStats,
  normalizeState,
  noteBlocked,
  parseJupiterTokenResponse,
  parseToken2022Account,
  PERMANENT_COOLDOWN_MS,
  pickSecondLookCandidates,
  POST_EXIT_TRACK_MS,
  provisionalExitGrade,
  pruneBlockedMints,
  pruneClosedMints,
  readiness,
  recordClosedMint,
  releaseLock,
  resolveHolderCount,
  resolveLiquidityUsd,
  rugInputFromReport,
  stageAFlowFromJupiterStats,
  stageAFlowNote,
  stageBMeasuredNote,
  SECOND_LOOK_MAX_AGE_MS,
  SECOND_LOOK_MIN_AGE_MS,
  SECOND_LOOK_SLOTS,
  SLICE_CANDIDATES,
  topHoldersSnapshot,
  trustedAlertTraders,
  trustedSmartMoney,
  uniqueBuyerGrowthPctFromJupiterStats,
  updatePostExitTracking,
  washPctFromJupiterStats,
  type ClusterResult,
  type SpotterState,
} from "./spotter.js";
import { evaluateRug, RUG_DEFERRED_FIELDS } from "../../anti-rug/src/checks.js";
import { openPosition } from "../../exit/src/exit.js";
import { evaluateGem } from "./gem-signal.js";

function baseReport(overrides: Record<string, unknown> = {}) {
  return {
    mintAuthority: null,
    freezeAuthority: null,
    topHolders: [
      { address: "AAA", pct: 5, owner: "AAA" },
      { address: "BBB", pct: 4, owner: "BBB" },
    ],
    risks: [],
    markets: [{ marketType: "raydium", lp: { lpLockedPct: 99.8 } }],
    score_normalised: 1,
    rugged: false,
    creatorBalance: 0,
    token: { supply: 1_000_000_000, decimals: 6 },
    ...overrides,
  } as Parameters<typeof rugInputFromReport>[1];
}

function baseCoin(complete: boolean) {
  return {
    mint: "TEST11111111111111111111111111111111111111",
    name: "Test",
    symbol: "TST",
    creator: "CREATOR11111111111111111111111111111111",
    created_timestamp: Date.now() - 60000,
    usd_market_cap: complete ? 100000 : 30000,
    complete,
    associated_bonding_curve: "CURVE",
    bonding_curve: "CURVE",
  } as Parameters<typeof rugInputFromReport>[2];
}

describe("v2.7 LP-lock verification", () => {
  it("migrated coin with locked LP passes the LP gate", () => {
    const input = rugInputFromReport("M", baseReport(), baseCoin(true));
    expect(input.lpLockedOrBurned).toBe(true);
  });

  it("migrated coin with lpLockedPct 0 fails the LP gate", () => {
    const input = rugInputFromReport(
      "M",
      baseReport({ markets: [{ marketType: "raydium", lp: { lpLockedPct: 0 } }] }),
      baseCoin(true),
    );
    expect(input.lpLockedOrBurned).toBe(false);
  });

  it("migrated coin with no LP data is unknown (fail-closed)", () => {
    const input = rugInputFromReport("M", baseReport({ markets: [] }), baseCoin(true));
    expect(input.lpLockedOrBurned).toBeNull();
  });

  it("pre-migration coin skips the LP gate (bonding curve, no LP yet)", () => {
    const input = rugInputFromReport("M", baseReport({ markets: [] }), baseCoin(false));
    expect(input.lpLockedOrBurned).toBe(true);
  });

  it("lpLockedPct takes the max across markets", () => {
    expect(
      lpLockedPct(baseReport({ markets: [{ marketType: "raydium", lp: { lpLockedPct: 10 } }, { marketType: "orca", lp: { lpLockedPct: 83.2 } }] })),
    ).toBe(83.2);
    expect(lpLockedPct(baseReport({ markets: [] }))).toBeNull();
  });

  it("sell quote only adds a pass when markets are empty", () => {
    const noMarkets = rugInputFromReport("M", baseReport({ markets: [] }), baseCoin(false), false);
    expect(noMarkets.sellSimulationOk).toBe(false);
    const quoted = rugInputFromReport("M", baseReport({ markets: [] }), baseCoin(false), true);
    expect(quoted.sellSimulationOk).toBe(true);
    const withMarkets = rugInputFromReport("M", baseReport(), baseCoin(false), false);
    expect(withMarkets.sellSimulationOk).toBe(true);
  });

  it("creatorBalancePct derives from creatorBalance / supply", () => {
    expect(creatorBalancePct(baseReport({ creatorBalance: 50000000 }))).toBe(5);
    expect(creatorBalancePct(baseReport({ creatorBalance: undefined }))).toBeNull();
  });
});

describe("v2.7 Jupiter recent fallback mapping", () => {
  it("maps a fresh launch as pre-migration with now timestamps", () => {
    const coin = jupiterRecentToCoin({ id: "MINT", name: "N", symbol: "S", dev: "DEV", mcap: 30000 }, 1000000);
    expect(coin.mint).toBe("MINT");
    expect(coin.creator).toBe("DEV");
    expect(coin.complete).toBe(false);
    expect(coin.created_timestamp).toBe(1000000);
    expect(coin.usd_market_cap).toBe(30000);
  });

  it("marks a >=$69k token as migrated so the LP check still applies", () => {
    const coin = jupiterRecentToCoin({ id: "MINT", name: "N", symbol: "S", mcap: 80000 }, 1000000);
    expect(coin.complete).toBe(true);
  });

  it("falls back to fdv when mcap is missing", () => {
    const coin = jupiterRecentToCoin({ id: "MINT", name: "N", symbol: "S", fdv: 12000 }, 1000000);
    expect(coin.usd_market_cap).toBe(12000);
  });
});

describe("v2.7 state normalisation", () => {
  it("repairs null counters without touching real values", () => {
    const state = newState() as unknown as Record<string, unknown>;
    state.alertBoosts = null;
    state.clusterBlocks = null;
    state.equityUsd = 10.34;
    state.trades = 2;
    const fixed = normalizeState(state as unknown as SpotterState);
    expect(fixed.alertBoosts).toBe(0);
    expect(fixed.clusterBlocks).toBe(0);
    expect(fixed.equityUsd).toBe(10.34);
    expect(fixed.trades).toBe(2);
    expect(Array.isArray(fixed.positions)).toBe(true);
  });
});

describe("v2.7 readiness equity bar is derived from start equity", () => {
  it("needs equity >= startEquity * 1.1, not a hard-coded number", () => {
    const state = newState();
    state.trades = 20;
    state.wins = 9;
    state.losses = 11;
    state.grossWinsUsd = 12;
    state.grossLossesUsd = 10;
    state.priceSourceLostCloses = 0;
    state.worstLossPct = -0.2;
    state.equityUsd = 16.49;
    expect(readiness(state).ready).toBe(false);
    expect(readiness(state).reasons.join(" ")).toContain("16.50");
    state.equityUsd = 16.5;
    expect(readiness(state).ready).toBe(true);
  });
});

describe("v2.10 re-entry cooldown", () => {
  it("records a close with exit mc and timestamp", () => {
    const state = newState();
    recordClosedMint(state, "MINT", 50000, 1000000, "hard stop");
    expect(state.closedMints["MINT"]).toEqual({ closedAtMs: 1000000, exitMcUsd: 50000, reason: "hard stop" });
  });

  it("blocks re-entry inside 30 minutes, allows it after", () => {
    const state = newState();
    recordClosedMint(state, "MINT", 50000, 1000000, "hard stop");
    // Trade #12's 2.5-min gap and 5eiLc #2's 16-min gap: blocked.
    expect(isReentryBlocked(state, "MINT", 1000000 + 2.5 * 60 * 1000)).not.toBeNull();
    expect(isReentryBlocked(state, "MINT", 1000000 + 16 * 60 * 1000)).not.toBeNull();
    expect(isReentryBlocked(state, "MINT", 1000000 + 29 * 60 * 1000)).not.toBeNull();
    // Exactly 30 minutes: cooldown over, allowed again.
    expect(isReentryBlocked(state, "MINT", 1000000 + 30 * 60 * 1000)).toBeNull();
    // CjaiYHC2 #2's 35-min gap stays legal.
    expect(isReentryBlocked(state, "MINT", 1000000 + 35 * 60 * 1000)).toBeNull();
    expect(isReentryBlocked(state, "OTHER", 1000000 + 60 * 1000)).toBeNull();
  });

  it("prunes records older than 24h and keeps recent ones", () => {
    const state = newState();
    recordClosedMint(state, "OLD", 1000, 1000000, "x");
    recordClosedMint(state, "NEW", 1000, 1000000 + 23 * 60 * 60 * 1000, "x");
    pruneClosedMints(state, 1000000 + 25 * 60 * 60 * 1000);
    expect(state.closedMints["OLD"]).toBeUndefined();
    expect(state.closedMints["NEW"]).toBeDefined();
  });

  it("normalizeState repairs a missing closedMints map", () => {
    const state = newState() as unknown as Record<string, unknown>;
    delete state.closedMints;
    const fixed = normalizeState(state as unknown as SpotterState);
    expect(fixed.closedMints).toEqual({});
    expect(fixed.trades).toBe(0);
  });

  it("newState starts with an empty closedMints map", () => {
    expect(newState().closedMints).toEqual({});
  });
});

describe("v2.23 blocked-mint cooldown", () => {
  it("a never-blocked mint is free to check", () => {
    const state = newState();
    expect(blockedCooldownRemaining(state, "MINT", 1000000, 10000)).toBe(0);
  });

  it("blocks within the 60m window and frees at expiry", () => {
    const state = newState();
    noteBlocked(state, "MINT", 1000000, 10000, false);
    expect(blockedCooldownRemaining(state, "MINT", 1000000 + 10 * 60 * 1000, 10000)).toBe(50 * 60 * 1000);
    expect(blockedCooldownRemaining(state, "MINT", 1000000 + 59 * 60 * 1000, 10000)).toBe(60 * 1000);
    expect(blockedCooldownRemaining(state, "MINT", 1000000 + 60 * 60 * 1000, 10000)).toBe(0);
    expect(blockedCooldownRemaining(state, "OTHER", 1000000 + 10 * 60 * 1000, 10000)).toBe(0);
  });

  it("an mc rise of >= 50% ends it early, a smaller rise does not", () => {
    const state = newState();
    noteBlocked(state, "MINT", 1000000, 10000, false);
    expect(blockedCooldownRemaining(state, "MINT", 1000000 + 10 * 60 * 1000, 15000)).toBe(0);
    expect(blockedCooldownRemaining(state, "MINT", 1000000 + 10 * 60 * 1000, 14999)).toBeGreaterThan(0);
  });

  it("an mc fall never ends it early", () => {
    const state = newState();
    noteBlocked(state, "MINT", 1000000, 10000, false);
    expect(blockedCooldownRemaining(state, "MINT", 1000000 + 10 * 60 * 1000, 5000)).toBeGreaterThan(0);
  });

  it("near-miss tier uses the 15m window and 25% rise bar", () => {
    const state = newState();
    noteBlocked(state, "MINT", 1000000, 10000, true);
    expect(blockedCooldownRemaining(state, "MINT", 1000000 + 10 * 60 * 1000, 10000)).toBe(5 * 60 * 1000);
    expect(blockedCooldownRemaining(state, "MINT", 1000000 + 15 * 60 * 1000, 10000)).toBe(0);
    expect(blockedCooldownRemaining(state, "MINT", 1000000 + 10 * 60 * 1000, 12500)).toBe(0);
    expect(blockedCooldownRemaining(state, "MINT", 1000000 + 10 * 60 * 1000, 12000)).toBeGreaterThan(0);
  });

  it("noteBlocked refreshes from the latest block", () => {
    const state = newState();
    noteBlocked(state, "MINT", 1000000, 10000, false);
    noteBlocked(state, "MINT", 1000000 + 30 * 60 * 1000, 12000, false);
    expect(blockedCooldownRemaining(state, "MINT", 1000000 + 50 * 60 * 1000, 12000)).toBe(40 * 60 * 1000);
  });

  it("prunes records older than 24h and keeps recent ones", () => {
    const state = newState();
    noteBlocked(state, "OLD", 1000000, 1000, false);
    noteBlocked(state, "NEW", 1000000 + 23 * 60 * 60 * 1000, 1000, true);
    pruneBlockedMints(state, 1000000 + 25 * 60 * 60 * 1000);
    expect(state.blockedMints["OLD"]).toBeUndefined();
    expect(state.blockedMints["NEW"]).toBeDefined();
  });

  it("normalizeState repairs missing blockedMints and cooldownSkips", () => {
    const state = newState() as unknown as Record<string, unknown>;
    delete state.blockedMints;
    delete state.cooldownSkips;
    const fixed = normalizeState(state as unknown as SpotterState);
    expect(fixed.blockedMints).toEqual({});
    expect(fixed.cooldownSkips).toBe(0);
  });

  it("newState starts empty with zero skips", () => {
    const state = newState();
    expect(state.blockedMints).toEqual({});
    expect(state.cooldownSkips).toBe(0);
    expect(BLOCKED_COOLDOWN_MS).toBe(60 * 60 * 1000);
    expect(NEAR_MISS_COOLDOWN_MS).toBe(15 * 60 * 1000);
  });
});

describe("v2.24 volume heat + holder-exit watch", () => {
  const dex = { buysH1: 120, sellsH1: 60, buysM5: 10, sellsM5: 5 };
  const jup = {
    mcap: 50000,
    liquidityUsd: 9000,
    holderCount: 1200,
    createdAt: "2026-11-23T18:00:00.000Z",
    organicScore: 72,
    organicScoreLabel: "high",
    stats1h: {
      buyVolume: 4100,
      sellVolume: 2000,
      buyOrganicVolume: 2050,
      sellOrganicVolume: 1000,
      numBuys: 100,
      numSells: 50,
      numTraders: 120,
      numNetBuyers: 25,
      holderChange: 10,
      volumeChange: 5,
    },
    stats24hVolume: 200000,
  };

  it("uniform flow reads ~8.33% heat at 1.0x pace", () => {
    const h = entryHeatStats(dex, jup);
    expect(h.buyHeatPct).toBeCloseTo(100 / 12, 5);
    expect(h.buyHeatPace).toBeCloseTo(1, 5);
    expect(h.sellHeatPct).toBeCloseTo(100 / 12, 5);
  });

  it("accelerating buys read hot", () => {
    const h = entryHeatStats({ ...dex, buysM5: 30, buysH1: 60 }, jup);
    expect(h.buyHeatPct).toBe(50);
    expect(h.buyHeatPace).toBe(6);
  });

  it("zero h1 or missing sources read null, never throw", () => {
    expect(entryHeatStats({ ...dex, buysH1: 0 }, jup).buyHeatPct).toBeNull();
    const empty = entryHeatStats(null, null);
    expect(empty.buyHeatPct).toBeNull();
    expect(empty.sellHeatPct).toBeNull();
    expect(empty.buyHeatPace).toBeNull();
    expect(empty.avgBuyUsd).toBeNull();
    expect(empty.avgSellUsd).toBeNull();
    expect(empty.avgBuyOrgUsd).toBeNull();
  });

  it("avg buy/sell are exact Jupiter volume/count", () => {
    const h = entryHeatStats(dex, jup);
    expect(h.avgBuyUsd).toBe(41);
    expect(h.avgSellUsd).toBe(40);
    expect(h.avgBuyOrgUsd).toBe(20.5);
    const zeroBuys = entryHeatStats(dex, { ...jup, stats1h: { ...jup.stats1h, numBuys: 0 } });
    expect(zeroBuys.avgBuyUsd).toBeNull();
    expect(zeroBuys.avgBuyOrgUsd).toBeNull();
  });

  it("heatNoteText is compact and empty when nothing is measurable", () => {
    const note = heatNoteText(entryHeatStats(dex, jup));
    expect(note).toContain("8.3%");
    expect(note).toContain("1.0x pace");
    expect(note).toContain("avgBuy $41");
    expect(heatNoteText(entryHeatStats(null, null))).toBe("");
  });

  it("topHoldersSnapshot excludes curve/pool/locker, caps at 5, sorts by pct", () => {
    const report = baseReport({
      topHolders: [
        { address: "CURVE", pct: 98, owner: "CURVE" },
        { address: "H1", pct: 12, owner: "H1" },
        { address: "H2", pct: 9 },
        { address: "LOCKER", pct: 8, owner: "LOCKER" },
        { address: "H3", pct: 7, owner: "H3" },
        { address: "H4", pct: 5, owner: "H4" },
        { address: "H5", pct: 4, owner: "H5" },
        { address: "H6", pct: 3, owner: "H6" },
      ],
    });
    const snap = topHoldersSnapshot(report, new Set(["CURVE", "LOCKER"]));
    expect(snap).toHaveLength(5);
    expect(snap.map((h) => h.owner)).toEqual(["H1", "H2", "H3", "H4", "H5"]);
    expect(snap[0].pct).toBe(12);
    expect(snap[1].owner).toBe("H2"); // owner falls back to address
  });

  it("holderExits flags halved and left-top-10, ignores dips and growth", () => {
    const snap = [
      { owner: "A", pct: 10 },
      { owner: "B", pct: 5 },
      { owner: "C", pct: 2 },
    ];
    const exits = holderExits(snap, [
      { owner: "A", pct: 4 },
      { owner: "B", pct: 4.5 },
      { owner: "C", pct: 3 },
    ]);
    expect(exits).toHaveLength(1);
    expect(exits[0].owner).toBe("A");
    expect(exits[0].kind).toBe("halved");
    expect(exits[0].dropPct).toBeCloseTo(60, 5);
    const gone = holderExits(snap, [{ owner: "A", pct: 10 }]);
    expect(gone.map((e) => [e.owner, e.kind])).toEqual([
      ["B", "left_top10"],
      ["C", "left_top10"],
    ]);
    expect(gone[0].pctNow).toBe(0);
    expect(gone[0].dropPct).toBe(100);
    expect(holderExits([], [{ owner: "A", pct: 10 }])).toEqual([]);
    expect(holderExits([{ owner: "A", pct: 0 }], [])).toHaveLength(1); // 0% holder leaving still counts as left
  });

  it("newState starts with zero holderExitSignals and normalizeState repairs it", () => {
    expect(newState().holderExitSignals).toBe(0);
    const state = newState() as unknown as Record<string, unknown>;
    delete state.holderExitSignals;
    expect(normalizeState(state as unknown as SpotterState).holderExitSignals).toBe(0);
  });
});

describe("v2.26 trusted smart-money subset", () => {
  const trusted = { wallets: new Set(["W1", "W2"]), handles: new Set(["alice", "bob"]) };
  const fomo = new Map([
    ["W1", { trades: 50, pnlUsd: 1000 }],
    ["W2", { trades: 12, pnlUsd: 500 }],
    ["W3", { trades: 99, pnlUsd: 2000 }],
  ]);
  const holders = [
    { address: "H1", pct: 10, owner: "W1" },
    { address: "H2", pct: 8, owner: "W2" },
    { address: "H3", pct: 6, owner: "W3" },
    { address: "CURVE", pct: 40, owner: "W1" },
  ];

  it("counts only holders in both the Fomo feed and the trusted set", () => {
    const m = trustedSmartMoney(holders, new Set(["CURVE"]), fomo, trusted);
    expect(m.wallets).toBe(2);
    expect(m.minTrades).toBe(50);
    expect(m.fomoWallets).toBe(3);
  });

  it("a Fomo-only holder adds nothing, and a trusted wallet off the board adds nothing", () => {
    const fomoOnly = trustedSmartMoney(
      [{ address: "H3", pct: 6, owner: "W3" }],
      new Set(),
      fomo,
      trusted,
    );
    expect(fomoOnly).toEqual({ wallets: 0, minTrades: 0, fomoWallets: 1 });
    const offBoard = trustedSmartMoney(
      [{ address: "H1", pct: 10, owner: "W1" }],
      new Set(),
      new Map(),
      trusted,
    );
    expect(offBoard).toEqual({ wallets: 0, minTrades: 0, fomoWallets: 0 });
  });

  it("trustedAlertTraders keeps only validated handles", () => {
    expect(trustedAlertTraders(["alice", "mallory", "bob"], trusted)).toEqual(["alice", "bob"]);
    expect(trustedAlertTraders(["mallory"], trusted)).toEqual([]);
    expect(trustedAlertTraders([], trusted)).toEqual([]);
  });

  it("loadTrustedWallets reads a file, and fails closed on missing or malformed input", () => {
    const dir = mkdtempSync(join(tmpdir(), "trusted-"));
    const good = join(dir, "good.json");
    writeFileSync(
      good,
      JSON.stringify({ wallets: [{ wallet: "W1", handle: "alice" }, { wallet: "W2", handle: "bob" }] }),
    );
    const loaded = loadTrustedWallets(good);
    expect(loaded.wallets).toEqual(new Set(["W1", "W2"]));
    expect(loaded.handles).toEqual(new Set(["alice", "bob"]));
    expect(loadTrustedWallets(join(dir, "missing.json")).wallets.size).toBe(0);
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{not json");
    expect(loadTrustedWallets(bad).handles.size).toBe(0);
    const wrong = join(dir, "wrong.json");
    writeFileSync(wrong, JSON.stringify({ wallets: [{ address: "W1" }] }));
    expect(loadTrustedWallets(wrong).wallets.size).toBe(0);
  });

  it("the live trusted file holds exactly the 8 validated wallets (7 + the 1 expectancy exception)", () => {
    const live = loadTrustedWallets();
    expect(live.wallets.size).toBe(8);
    expect([...live.handles].sort()).toEqual([
      "1111111111111",
      "Aohata",
      "Grimbytez",
      "OmakaseOnly",
      "cherryfairy",
      "letsgopenguin",
      "trencHog8",
      "wrld_sol",
    ]);
  });
});

describe("v2.11 entry volatility stats", () => {
  const coin = {
    mint: "M",
    name: "T",
    symbol: "T",
    creator: "C",
    created_timestamp: 0,
    usd_market_cap: 30000,
    complete: false,
    associated_bonding_curve: "",
    bonding_curve: "",
    canonical_pool_liquidity_usd: 4200,
  } as Parameters<typeof entryVolStats>[0];
  const seen = {
    mint: "M",
    name: "T",
    symbol: "T",
    firstSeenMs: 0,
    firstMcUsd: 10000,
    lastMcUsd: 30000,
    lastSeenMs: 0,
    replies: 0,
    creator: "C",
    complete: false,
  } as Parameters<typeof entryVolStats>[1];

  it("computes run-up vs first-seen mc and passes concentration through", () => {
    const s = entryVolStats(coin, seen, { mint: "M", top10Pct: 0.42, singleWalletPct: 0.18 });
    expect(s.firstMcUsd).toBe(10000);
    expect(s.runUpPct).toBeCloseTo(200, 5);
    expect(s.liquidityUsd).toBe(4200);
    expect(s.top10Pct).toBe(0.42);
    expect(s.singleWalletPct).toBe(0.18);
  });

  it("falls back to current mc when first-seen is 0, and -1 for null concentration", () => {
    const s = entryVolStats(coin, { ...seen, firstMcUsd: 0 }, { mint: "M", top10Pct: null, singleWalletPct: null });
    expect(s.firstMcUsd).toBe(30000);
    expect(s.runUpPct).toBe(0);
    expect(s.top10Pct).toBe(-1);
    expect(s.singleWalletPct).toBe(-1);
  });
});

describe("v2.11 fresh-tier entry reason", () => {  const blockedGem = {
    mint: "M",
    score: 84,
    actionable: false,
    reason: "rug check blocked: top10_concentration, single_wallet_concentration",
    breakEvenGrossPct: 0.06,
  };
  const cleanGem = {
    mint: "M",
    score: 75,
    actionable: true,
    reason: "rug clean, score 75, break-even 6%",
    breakEvenGrossPct: 0.06,
  };

  it("says override, not block, on a fresh-tier entry", () => {
    const note = entryGemNote(blockedGem, true);
    expect(note).toContain("fresh tier override");
    expect(note).toContain("top10_concentration");
    expect(note).not.toContain("rug check blocked");
  });

  it("passes a clean reason through unchanged", () => {
    expect(entryGemNote(cleanGem, true)).toBe(cleanGem.reason);
  });

  it("passes a blocked reason through when not a fresh-tier entry", () => {
    expect(entryGemNote(blockedGem, false)).toBe(blockedGem.reason);
  });
});

describe("v2.12 fresh-tier predicate (audit fix)", () => {
  it("a clean rug check is NOT the fresh tier", () => {
    // [].every(...) is vacuously true — the old inline predicate let a
    // clean-rug candidate with gem score 50-69 in through the tier's
    // score>=50 bypass even though evaluateGem called it not actionable.
    expect(isFreshTier([], 0.15, 0.05, 1, 0)).toBe(false);
  });

  it("concentration-only failures ARE the fresh tier within the caps", () => {
    expect(isFreshTier(["top10_concentration", "single_wallet_concentration"], 0.42, 0.18, 15, 0)).toBe(true);
    expect(isFreshTier(["bundle_concentration"], 0.3, 0.1, 20, 0)).toBe(true);
  });

  it("concentration plus any other failure is not the fresh tier", () => {
    expect(isFreshTier(["top10_concentration", "lp_not_locked_or_burned"], 0.42, 0.18, 15, 0)).toBe(false);
    expect(isFreshTier(["top10_concentration", "mint_authority_live"], 0.42, 0.18, 15, 0)).toBe(false);
  });

  it("fails the tier above the concentration caps, Rugcheck score, or with danger risk", () => {
    expect(isFreshTier(["top10_concentration"], 0.51, 0.18, 15, 0)).toBe(false);
    expect(isFreshTier(["single_wallet_concentration"], 0.2, 0.26, 15, 0)).toBe(false);
    expect(isFreshTier(["top10_concentration"], 0.42, 0.18, 21, 0)).toBe(false);
    expect(isFreshTier(["top10_concentration"], 0.42, 0.18, 15, 1)).toBe(false);
  });
});

describe("v2.12 buy-leg fee (audit fix)", () => {
  it("charges ~3% pool+slippage plus the fixed leg cost plus the ATA rent", () => {
    // $2.09 at SOL $73.34: 3% = $0.0627 + fixed 0.000055 SOL ($0.004)
    // + ATA rent 0.00203928 SOL ($0.1496). The rent is a cost now
    // (SOUL audit fix): it used to be assumed reclaimed, so the old
    // fee was ~$0.067; the honest fee is ~$0.216.
    const fee = entryFeeUsd(2.09, 73.34);
    expect(fee).toBeGreaterThan(0.21);
    expect(fee).toBeLessThan(0.22);
    expect(fee).toBeCloseTo(0.03 * 2.09 + (0.000055 + 0.00203928) * 73.34, 4);
  });

  it("is the same leg the sell side charges (round trip is two legs), plus rent on the buy leg", () => {
    // The gate models 2 legs (breakEvenGrossPct legs=2) and the docs
    // say fees are "per side" — the books must charge both, not one.
    // The buy leg additionally carries the ATA rent (~$0.143 at $70),
    // which the sell leg does not.
    const buy = entryFeeUsd(2.2, 70);
    expect(buy).toBeGreaterThan(0);
    expect(buy).toBeCloseTo(0.03 * 2.2 + (0.000055 + 0.00203928) * 70, 4);
  });
});

describe("v2.12 readiness counts CLOSED trades (audit fix)", () => {
  function readyState(): SpotterState {
    const s = newState();
    s.trades = 20;
    s.wins = 9;
    s.losses = 11;
    s.grossWinsUsd = 12;
    s.grossLossesUsd = 10;
    s.priceSourceLostCloses = 0;
    s.worstLossPct = -0.2;
    s.equityUsd = 11.0;
    return s;
  }

  it("open positions do not inflate closed-on-price or deflate win rate", () => {
    // Live state at the audit: 20 trades, 6W/11L, 3 open.
    // Old code: winRate 6/20 = 30%, priceClosed 20. True: 6/17 = 35.3%, 17.
    const s = readyState();
    s.trades = 20;
    s.wins = 6;
    s.losses = 11;
    s.grossWinsUsd = 10.877;
    s.grossLossesUsd = 12.093;
    const r = readiness(s);
    expect(r.winRate).toBeCloseTo(6 / 17, 5);
    expect(r.reasons.join(" ")).not.toContain("closed on price");
    expect(r.ready).toBe(false); // WR/PF/equity still fail, but not the closed count
  });

  it("needs >=10 CLOSED on price even when entries are >=20", () => {
    // 20 entries but only 7 closed (13 open) must not pass the bar.
    const s = readyState();
    s.trades = 20;
    s.wins = 5;
    s.losses = 2;
    expect(readiness(s).ready).toBe(false);
    expect(readiness(s).reasons.join(" ")).toContain("closed on price");
  });

  it("price-source-lost pct is over closed trades, not entries", () => {
    const s = readyState();
    s.trades = 23; // 3 open on top of 20 closed
    s.wins = 9;
    s.losses = 11;
    s.priceSourceLostCloses = 3;
    // 3/20 closed = 15% > 10% -> not ready. Old code used 3/23 = 13%.
    expect(readiness(s).priceLostPct).toBeCloseTo(3 / 20, 5);
    expect(readiness(s).ready).toBe(false);
  });
});

describe("v2.13 elevated-risk haircut (sentiment-only since v2.18)", () => {
  // SOUL audit fix v2.18: leg (a) — OKX cluster Medium/High — is
  // DELETED. OKX is logged-only (its labels were inverted against
  // paper outcomes), so it must not haircut either. The haircut is
  // sentiment-only: cold sentiment (< 30) with DexScreener volume
  // data present. There is no OKX argument anymore.
  it("flags cold sentiment only when DexScreener volume data is present", () => {
    expect(isElevatedRisk(25, true)).toBe(true);
    expect(isElevatedRisk(29, true)).toBe(true);
    // No volume data: scoreSentiment returns 0 with no data, so a
    // score of 0 must NOT flag — otherwise every uninstrumented
    // candidate would be halved.
    expect(isElevatedRisk(0, false)).toBe(false);
  });

  it("does not flag warm sentiment (score >= 30 is the boundary)", () => {
    expect(isElevatedRisk(30, true)).toBe(false);
    expect(isElevatedRisk(60, true)).toBe(false);
  });

  it("replays the 23 journaled $10 trades: flags both rugs, 0 wins", () => {
    // Source: hidden_files/spotter-test-20261122-v2-10usd-halted and
    // hidden_files/spotter-test-20261122-v2 journals, replayed with
    // the corrected (v2.12) fee model: 8W / 13L / 2 RUG, net -$7.03.
    // Columns: mint prefix, sentiment score (0 = no sentiment
    // signal, pre-v2.8), DexScreener volume data present, outcome.
    // The OKX column is gone: OKX no longer haircuts (v2.18).
    // Sentiment-only, the haircut flags 5 trades — both rugs and 3
    // losses, none of the 8 wins.
    const trades: Array<[string, number, boolean, string]> = [
      ["CjaiYHC2", 0, false, "LOSS"],
      ["DEQD2q8y", 0, false, "LOSS"],
      ["e8q4yhJx", 0, false, "WIN"],
      ["9M4PDviT", 0, false, "LOSS"],
      ["5eiLc9r7", 0, false, "WIN"],
      ["2N6kEXSp", 0, false, "LOSS"],
      ["5eiLc9r7", 0, false, "LOSS"],
      ["97WxZS9M", 0, false, "WIN"],
      ["BkQjetCC", 0, false, "LOSS"],
      ["5ajKDjnp", 0, false, "WIN"],
      ["CjaiYHC2", 0, false, "WIN"],
      ["5ajKDjnp", 0, false, "LOSS"],
      ["GotqLeBi", 27, true, "LOSS"],
      ["DMTxhDS1", 30, true, "LOSS"],
      ["5eEWnVo8", 27, true, "LOSS"],
      ["9mS2wDV3", 30, true, "WIN"],
      ["GESk8TmH", 30, true, "LOSS"],
      ["DnbQKi14", 30, true, "WIN"],
      ["Qwhtz9vc", 25, true, "RUG"],
      ["2JPYTUdB", 30, true, "WIN"],
      ["zZ8C2Mcr", 25, true, "RUG"],
      ["8WiK2Bp1", 27, true, "LOSS"],
      ["33xAhJRD", 30, true, "LOSS"],
    ];
    const flagged = trades.filter((t) => isElevatedRisk(t[1], t[2]));
    expect(trades.length).toBe(23);
    expect(flagged.length).toBe(5);
    expect(flagged.filter((t) => t[3] === "RUG").length).toBe(2);
    expect(flagged.filter((t) => t[3] === "WIN").length).toBe(0);
    expect(flagged.filter((t) => t[3] === "LOSS").length).toBe(3);
  });

  it("normalizeState repairs a missing riskHaircuts counter", () => {
    const s = newState();
    (s as unknown as Record<string, unknown>).riskHaircuts = null;
    normalizeState(s);
    expect(s.riskHaircuts).toBe(0);
  });
});

describe("v2.14 hard gates", () => {
  it("OKX cluster predicate is replay-analysis only (logged-only in the live poll since v2.18)", () => {
    // The predicate itself is unchanged — Medium/High is the
    // historical filter — but the live poll never calls it anymore.
    // OKX labels were inverted against paper outcomes, so it must
    // not block or haircut on its own.
    expect(isOkxClusterGateBlock("Medium")).toBe(true);
    expect(isOkxClusterGateBlock("High")).toBe(true);
    expect(isOkxClusterGateBlock("Low")).toBe(false);
    // Fail-open on unknown: null OKX is no signal, not a block.
    expect(isOkxClusterGateBlock(null)).toBe(false);
    expect(isOkxClusterGateBlock(undefined)).toBe(false);
    // OKX returns title case; a lowercase value is not a match.
    expect(isOkxClusterGateBlock("medium")).toBe(false);
  });

  it("holder count resolves to the MIN across sources (fail-closed)", () => {
    expect(resolveHolderCount("2242", 2000, 1900)).toEqual({ holders: 1900, source: "jupiter", disagreement: true });
    expect(resolveHolderCount(null, 1307, 1200)).toEqual({ holders: 1200, source: "jupiter", disagreement: true });
    expect(resolveHolderCount(null, null, 613)).toEqual({ holders: 613, source: "jupiter", disagreement: false });
    expect(resolveHolderCount("87", null, null)).toEqual({ holders: 87, source: "okx", disagreement: false });
    expect(resolveHolderCount(null, null, null)).toEqual({ holders: null, source: "none", disagreement: false });
    // Non-numeric OKX string is not a count.
    expect(resolveHolderCount("?", 500, null)).toEqual({ holders: 500, source: "rugcheck", disagreement: false });
  });

  it("holder disagreement uses the MIN, which can block on the floor", () => {
    // OKX 100 vs Rugcheck 300: MIN 100 is below the 200 floor, so
    // the gate blocks — the old code took the MAX (300) and passed.
    // The gate does not block on the disagreement itself; the
    // journal notes it.
    const r = resolveHolderCount("100", 300, null);
    expect(r.holders).toBe(100);
    expect(r.disagreement).toBe(true);
    expect(isHolderFloorBlock(r.holders)).toBe(true);
  });

  it("holder floor is 200, fail-closed on total absence", () => {
    expect(HOLDER_FLOOR).toBe(200);
    expect(isHolderFloorBlock(199)).toBe(true);
    expect(isHolderFloorBlock(200)).toBe(false);
    expect(isHolderFloorBlock(2242)).toBe(false);
    // Standing rule: missing data = block.
    expect(isHolderFloorBlock(null)).toBe(true);
  });

  it("liquidity resolves to the MIN across sources (fail-closed)", () => {
    // The sources measure different things (curve SOL vs total
    // market liquidity vs pair liquidity), so the MIN is used and
    // disagreement is flagged — never first-available, never max.
    expect(resolveLiquidityUsd(4200, 9999, 8888, 7777)).toEqual({ liquidityUsd: 4200, source: "pumpfun", disagreement: true });
    expect(resolveLiquidityUsd(null, 9999, 8888, 7777)).toEqual({ liquidityUsd: 7777, source: "dexscreener", disagreement: true });
    expect(resolveLiquidityUsd(null, null, 8888, 7777)).toEqual({ liquidityUsd: 7777, source: "dexscreener", disagreement: true });
    expect(resolveLiquidityUsd(null, null, null, 7777)).toEqual({ liquidityUsd: 7777, source: "dexscreener", disagreement: false });
    expect(resolveLiquidityUsd(null, null, null, null)).toEqual({ liquidityUsd: null, source: "none", disagreement: false });
    expect(resolveLiquidityUsd(undefined, undefined, undefined, undefined)).toEqual({ liquidityUsd: null, source: "none", disagreement: false });
  });

  it("liquidity floor is $8,000, fail-closed on total absence", () => {
    expect(LIQUIDITY_FLOOR_USD).toBe(8000);
    expect(isLiquidityFloorBlock(7999)).toBe(true);
    expect(isLiquidityFloorBlock(8000)).toBe(false);
    expect(isLiquidityFloorBlock(9047)).toBe(false);
    expect(isLiquidityFloorBlock(null)).toBe(true);
  });

  it("normalizeState repairs the three new gate counters", () => {
    const s = newState();
    (s as unknown as Record<string, unknown>).okxClusterGateBlocks = null;
    (s as unknown as Record<string, unknown>).holderFloorBlocks = null;
    (s as unknown as Record<string, unknown>).liquidityFloorBlocks = null;
    normalizeState(s);
    expect(s.okxClusterGateBlocks).toBe(0);
    expect(s.holderFloorBlocks).toBe(0);
    expect(s.liquidityFloorBlocks).toBe(0);
    expect(newState().okxClusterGateBlocks).toBe(0);
  });

  it("replays the 21 journaled $10 trades: cluster + holders keep 7W/7L, both rugs blocked", () => {
    // Source: the two $10 journals, values verified against the
    // okx_signal lines and paper_entry entryVolStats (2026-11-23).
    // Columns: mint prefix, OKX cluster, OKX holders, liquidityUsd
    // (null = not instrumented pre-v2.11, not "unknown at entry"),
    // outcome. Halt-settles (2JPYTUdB +44.4%, 33xAhJRD -22.3%) are
    // excluded, exactly as the research note's n=21 (§0).
    // Cluster gate filters 0W/4L incl. both rugs; holder floor
    // filters 0W/5L; combined 7W/7L kept, gross +$1.40 (note §4).
    const trades: Array<[string, string, number, number | null, "WIN" | "LOSS" | "RUG"]> = [
      ["CjaiYHC2", "Low", 2673, null, "LOSS"],
      ["e8q4yhJx", "Low", 2665, null, "WIN"],
      ["DEQD2q8y", "High", 35, null, "LOSS"],
      ["9M4PDviT", "Low", 568, null, "LOSS"],
      ["5eiLc9r7", "Low", 875, null, "WIN"],
      ["2N6kEXSp", "High", 94, null, "LOSS"],
      ["97WxZS9M", "Low", 269, null, "WIN"],
      ["5eiLc9r7", "Low", 1255, null, "LOSS"],
      ["CjaiYHC2", "Low", 2658, null, "WIN"],
      ["BkQjetCC", "Low", 339, null, "LOSS"],
      ["5ajKDjnp", "Low", 217, null, "WIN"],
      ["5ajKDjnp", "Low", 564, null, "LOSS"],
      ["DMTxhDS1", "Low", 291, 6355, "LOSS"],
      ["5eEWnVo8", "Low", 84, 2360, "LOSS"],
      ["GotqLeBi", "Low", 87, 3453, "LOSS"],
      ["9mS2wDV3", "Low", 1307, 11068, "WIN"],
      ["GESk8TmH", "Low", 224, 3443, "LOSS"],
      ["Qwhtz9vc", "Medium", 2242, 8689, "RUG"],
      ["DnbQKi14", "Low", 703, 9243, "WIN"],
      ["zZ8C2Mcr", "High", 2211, 9047, "RUG"],
      ["8WiK2Bp1", "Low", 77, 4074, "LOSS"],
    ];
    expect(trades.length).toBe(21);
    const blockedByCluster = trades.filter((t) => isOkxClusterGateBlock(t[1]));
    expect(blockedByCluster.length).toBe(4);
    expect(blockedByCluster.filter((t) => t[4] === "RUG").length).toBe(2);
    expect(blockedByCluster.filter((t) => t[4] === "WIN").length).toBe(0);
    const kept = trades.filter((t) => !isOkxClusterGateBlock(t[1]) && !isHolderFloorBlock(t[2]));
    expect(kept.filter((t) => t[4] === "WIN").length).toBe(7);
    expect(kept.filter((t) => t[4] === "LOSS").length).toBe(7);
    expect(kept.filter((t) => t[4] === "RUG").length).toBe(0);
    const filtered = trades.filter((t) => isOkxClusterGateBlock(t[1]) || isHolderFloorBlock(t[2]));
    expect(filtered.length).toBe(7);
    expect(filtered.filter((t) => t[4] === "WIN").length).toBe(0);
  });

  it("replays the 9 instrumented trades: liquidity gate keeps 2W/2L, all three gates keep 2W/0L", () => {
    // The liquidity test is n=9 (only v2.11+ entries carry a
    // liquidity value); null here means "not recorded", so the
    // liquidity gate is applied only on this subset, as in the
    // research note §4. The live gate is fail-closed on a genuinely
    // missing value — a different question, covered by the null test
    // above.
    const trades: Array<[string, string, number, number, "WIN" | "LOSS" | "RUG"]> = [
      ["DMTxhDS1", "Low", 291, 6355, "LOSS"],
      ["5eEWnVo8", "Low", 84, 2360, "LOSS"],
      ["GotqLeBi", "Low", 87, 3453, "LOSS"],
      ["9mS2wDV3", "Low", 1307, 11068, "WIN"],
      ["GESk8TmH", "Low", 224, 3443, "LOSS"],
      ["Qwhtz9vc", "Medium", 2242, 8689, "RUG"],
      ["DnbQKi14", "Low", 703, 9243, "WIN"],
      ["zZ8C2Mcr", "High", 2211, 9047, "RUG"],
      ["8WiK2Bp1", "Low", 77, 4074, "LOSS"],
    ];
    const liqKept = trades.filter((t) => !isLiquidityFloorBlock(t[3]));
    expect(liqKept.filter((t) => t[4] === "WIN").length).toBe(2);
    expect(liqKept.filter((t) => t[4] === "LOSS").length).toBe(0);
    expect(liqKept.filter((t) => t[4] === "RUG").length).toBe(2);
    const liqFiltered = trades.filter((t) => isLiquidityFloorBlock(t[3]));
    expect(liqFiltered.length).toBe(5);
    expect(liqFiltered.filter((t) => t[4] === "WIN").length).toBe(0);
    // All three gates together on the same 9: only the 2 wins survive.
    const allKept = trades.filter((t) => !isOkxClusterGateBlock(t[1]) && !isHolderFloorBlock(t[2]) && !isLiquidityFloorBlock(t[3]));
    expect(allKept.map((t) => t[0]).sort()).toEqual(["9mS2wDV3", "DnbQKi14"]);
  });
});

describe("v2.14 Jupiter token stats parsing", () => {
  const response = [
    { id: "OTHER111111111111111111111111111111111111", mcap: 1 },
    {
      id: "MINT11111111111111111111111111111111111111",
      mcap: 50000,
      liquidity: 9000,
      holderCount: 1200,
      createdAt: "2026-11-23T18:00:00.000Z",
      organicScore: 72,
      organicScoreLabel: "high",
      stats1h: {
        buyVolume: 12000,
        sellVolume: 8000,
        buyOrganicVolume: 11000,
        sellOrganicVolume: 7500,
        numBuys: 120,
        numSells: 90,
        numTraders: 150,
        numNetBuyers: 30,
        holderChange: 45,
        volumeChange: 12.5,
      },
      stats24h: { volume: 200000 },
    },
  ];
  const mint = "MINT11111111111111111111111111111111111111";

  it("parses mcap, liquidity, holders, createdAt, organic score and stats1h", () => {
    const s = parseJupiterTokenResponse(response, mint);
    expect(s).not.toBeNull();
    expect(s?.mcap).toBe(50000);
    expect(s?.liquidityUsd).toBe(9000);
    expect(s?.holderCount).toBe(1200);
    expect(s?.createdAt).toBe("2026-11-23T18:00:00.000Z");
    expect(s?.organicScore).toBe(72);
    expect(s?.organicScoreLabel).toBe("high");
    expect(s?.stats1h?.buyVolume).toBe(12000);
    expect(s?.stats1h?.sellOrganicVolume).toBe(7500);
    expect(s?.stats1h?.numNetBuyers).toBe(30);
    expect(s?.stats1h?.holderChange).toBe(45);
    expect(s?.stats24hVolume).toBe(200000);
  });

  it("returns null for a wrong mint, an empty list, or a non-array", () => {
    expect(parseJupiterTokenResponse(response, "NOPE1111111111111111111111111111111111111")).toBeNull();
    expect(parseJupiterTokenResponse([], mint)).toBeNull();
    expect(parseJupiterTokenResponse(null, mint)).toBeNull();
    expect(parseJupiterTokenResponse({ id: mint } as unknown as unknown[], mint)).toBeNull();
  });

  it("missing stats1h is null stats, not a throw", () => {
    const s = parseJupiterTokenResponse([{ id: mint, mcap: 1000 }], mint);
    expect(s?.mcap).toBe(1000);
    expect(s?.stats1h).toBeNull();
    expect(s?.holderCount).toBeNull();
  });
});

describe("v2.14 entry flow stats", () => {
  const dex = {
    buysH1: 300,
    sellsH1: 200,
    buysM5: 40,
    sellsM5: 30,
    buysH24: 2000,
    sellsH24: 1227,
    pairCreatedAt: Date.parse("2026-11-23T17:30:00.000Z"),
    priceChangeH1Pct: 90,
    priceChangeH6Pct: 150,
    priceChangeH24Pct: 300,
  };
  const jup = {
    mcap: 50000,
    liquidityUsd: 9000,
    holderCount: 1200,
    createdAt: "2026-11-23T18:00:00.000Z",
    organicScore: 72,
    organicScoreLabel: "high",
    stats1h: {
      buyVolume: 12000,
      sellVolume: 8000,
      buyOrganicVolume: 11000,
      sellOrganicVolume: 7500,
      numBuys: 120,
      numSells: 90,
      numTraders: 150,
      numNetBuyers: 30,
      holderChange: 45,
      volumeChange: 12.5,
    },
    stats24hVolume: 200000,
  };

  it("records dex splits, jupiter stats1h, and token age from Jupiter createdAt", () => {
    const now = Date.parse("2026-11-23T18:30:00.000Z");
    const f = entryFlowStats(dex, jup, now);
    expect(f.dexBuysH1).toBe(300);
    expect(f.dexSellsH1).toBe(200);
    expect(f.dexBuysM5).toBe(40);
    expect(f.jupBuyVolumeH1).toBe(12000);
    expect(f.jupSellOrgVolumeH1).toBe(7500);
    expect(f.jupNumNetBuyersH1).toBe(30);
    expect(f.jupOrganicScore).toBe(72);
    // Jupiter createdAt 18:00 is preferred over the DexScreener pair
    // time 17:30: age 30 minutes at 18:30.
    expect(f.tokenAgeMin).toBeCloseTo(30, 5);
    expect(f.dexPriceChangeH1Pct).toBe(90);
    expect(f.dexPriceChangeH24Pct).toBe(300);
  });

  it("falls back to DexScreener pairCreatedAt when Jupiter has no createdAt", () => {
    const now = Date.parse("2026-11-23T18:30:00.000Z");
    const f = entryFlowStats(dex, { ...jup, createdAt: null }, now);
    expect(f.tokenAgeMin).toBeCloseTo(60, 5);
  });

  it("records explicit nulls when both sources are missing", () => {
    const f = entryFlowStats(null, null, Date.now());
    expect(f.dexBuysH1).toBeNull();
    expect(f.jupBuyVolumeH1).toBeNull();
    expect(f.jupNumNetBuyersH1).toBeNull();
    expect(f.tokenAgeMin).toBeNull();
    expect(f.dexPriceChangeH1Pct).toBeNull();
  });
});

describe("v2.17 discovery source tagging", () => {
  const wsCoin = { ...baseCoin(false), discoveredVia: "ws" as const };
  const pollCoin = baseCoin(false);

  it("discoverySource is ws for a WS-only coin, poll otherwise", () => {
    expect(discoverySource(wsCoin)).toBe("ws");
    expect(discoverySource(pollCoin)).toBe("poll");
    expect(discoverySource({ ...pollCoin, discoveredVia: "poll" as const })).toBe("poll");
  });

  it("a deep-check blocked line for a WS coin carries source ws", () => {
    const line = deepCheckJournal(wsCoin, "blocked", "Rugcheck score 70 > 50", { score: 70 });
    expect(line.action).toBe("blocked");
    expect(line.mint).toBe(wsCoin.mint);
    expect(line.source).toBe("ws");
    expect(line.score).toBe(70);
  });

  it("a deep-check blocked line for a poll coin carries source poll", () => {
    const line = deepCheckJournal(pollCoin, "blocked", "Rugcheck score 70 > 50", { score: 70 });
    expect(line.source).toBe("poll");
  });

  it("tags the other deep-check actions too (okx_signal, paper_entry)", () => {
    expect(deepCheckJournal(wsCoin, "okx_signal", "okx: cluster=Low", {}).source).toBe("ws");
    expect(deepCheckJournal(pollCoin, "paper_entry", "entered", { sizeUsd: 2.2 }).source).toBe("poll");
  });
});

describe("v2.18 lock token (SOUL audit fix)", () => {
  function lockPath(): string {
    return join(mkdtempSync(join(tmpdir(), "spotter-lock-")), "lock");
  }

  it("second acquire while held fails; release with the token frees it", () => {
    const p = lockPath();
    const first = acquireLock(p);
    expect(first.held).toBe(true);
    expect(first.reclaimed).toBe(false);
    expect(first.token).not.toBeNull();
    expect(acquireLock(p).held).toBe(false);
    releaseLock(p, first.token);
    const again = acquireLock(p);
    expect(again.held).toBe(true);
    releaseLock(p, again.token);
  });

  it("release with a wrong token or a null token never deletes the lock", () => {
    const p = lockPath();
    const first = acquireLock(p);
    expect(first.held).toBe(true);
    releaseLock(p, "not-our-token");
    expect(acquireLock(p).held).toBe(false);
    releaseLock(p, null);
    expect(acquireLock(p).held).toBe(false);
    releaseLock(p, first.token);
    expect(acquireLock(p).held).toBe(true);
  });

  it("a stale lock is reclaimed only after re-stat (old mtime)", () => {
    const p = lockPath();
    const first = acquireLock(p);
    expect(first.held).toBe(true);
    // Age the lock dir past the stale window: the next acquire
    // reclaims it instead of failing.
    const old = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(p, old, old);
    const second = acquireLock(p, 5 * 60 * 1000);
    expect(second.held).toBe(true);
    expect(second.reclaimed).toBe(true);
    releaseLock(p, second.token);
  });

  it("a fresh lock is never reclaimed", () => {
    const p = lockPath();
    const first = acquireLock(p);
    expect(first.held).toBe(true);
    expect(acquireLock(p, 5 * 60 * 1000).held).toBe(false);
    releaseLock(p, first.token);
  });
});

describe("v2.19 measured rug fields", () => {
  function baseCluster(overrides: Partial<ClusterResult> = {}): ClusterResult {
    return {
      clustered: false,
      reason: "no shared funder found",
      checked: 6,
      unknown: 0,
      sharedFunders: [],
      linkedPct: 0,
      devSold: null,
      operators: null,
      ...overrides,
    };
  }

  describe("washPctFromJupiterStats", () => {
    function stats(buy: number | null, sell: number | null, buyOrg: number | null, sellOrg: number | null) {
      return {
        mcap: 25000, liquidityUsd: 5000, holderCount: 290, createdAt: null,
        organicScore: 51, organicScoreLabel: "medium",
        stats1h: {
          buyVolume: buy, sellVolume: sell, buyOrganicVolume: buyOrg, sellOrganicVolume: sellOrg,
          numBuys: 322, numSells: 188, numTraders: 154, numNetBuyers: 76, holderChange: 22, volumeChange: -52,
        },
        stats24hVolume: 200000,
      };
    }
    it("Pikachu live numbers: 97.5% non-organic (2026-11-23 Jupiter stats1h)", () => {
      // buy 13634.06 + sell 10713.72, organic 297.23 + 304.08.
      const w = washPctFromJupiterStats(stats(13634.056675913447, 10713.716548008357, 297.2278619355584, 304.0753710573086));
      expect(w).toBeCloseTo(0.9753, 3);
    });
    it("returns null when any organic field is missing (dead token, not 0% wash)", () => {
      // Betty / KYC live: buyVolume null, organic nulls.
      expect(washPctFromJupiterStats(stats(null, 1.02, null, 0.5))).toBeNull();
      expect(washPctFromJupiterStats(stats(20907, 10879, null, null))).toBeNull();
      expect(washPctFromJupiterStats(null)).toBeNull();
    });
    it("returns null on zero total volume and 0 on fully organic volume", () => {
      expect(washPctFromJupiterStats(stats(0, 0, 0, 0))).toBeNull();
      expect(washPctFromJupiterStats(stats(100, 100, 100, 100))).toBe(0);
      expect(washPctFromJupiterStats(stats(100, 0, 50, 0))).toBeCloseTo(0.5, 5);
    });
    it("returns null when organic exceeds total (corrupt payload, not a negative wash)", () => {
      expect(washPctFromJupiterStats(stats(100, 100, 150, 100))).toBeNull();
    });
  });

  describe("gem flow components from Jupiter stats1h (v2.20)", () => {
    function stats(s1: Record<string, number | null>) {
      return {
        mcap: 25000, liquidityUsd: 5000, holderCount: 290, createdAt: null,
        organicScore: 51, organicScoreLabel: "medium",
        stats1h: {
          buyVolume: null, sellVolume: null, buyOrganicVolume: null, sellOrganicVolume: null,
          numBuys: null, numSells: null, numTraders: null, numNetBuyers: null, holderChange: null, volumeChange: null,
          ...s1,
        },
        stats24hVolume: 200000,
      };
    }
    it("buySellRatio is buy/sell volume; null with no sells yet", () => {
      expect(buySellRatioFromJupiterStats(stats({ buyVolume: 20000, sellVolume: 10000 }))).toBeCloseTo(2, 5);
      expect(buySellRatioFromJupiterStats(stats({ buyVolume: 74.54, sellVolume: 71.93 }))).toBeCloseTo(1.036, 3);
      expect(buySellRatioFromJupiterStats(stats({ buyVolume: 0, sellVolume: 100 }))).toBe(0);
      // No sells yet (6/30 live fresh tokens): too young to judge,
      // null scores 0 — never an invented ratio.
      expect(buySellRatioFromJupiterStats(stats({ buyVolume: 100, sellVolume: 0 }))).toBeNull();
      expect(buySellRatioFromJupiterStats(stats({ buyVolume: 100, sellVolume: null }))).toBeNull();
      expect(buySellRatioFromJupiterStats(stats({ buyVolume: null, sellVolume: 100 }))).toBeNull();
      expect(buySellRatioFromJupiterStats(null)).toBeNull();
    });
    it("uniqueBuyerGrowthPct passes holderChange through, negative included", () => {
      // Live verification against holderCount: 3 -> 5 holders reads
      // +66.7%, 3 -> 1 reads -66.7%, 2 -> 4 reads +100%.
      expect(uniqueBuyerGrowthPctFromJupiterStats(stats({ holderChange: 66.66666666666666 }))).toBeCloseTo(66.6667, 3);
      expect(uniqueBuyerGrowthPctFromJupiterStats(stats({ holderChange: -66.66666666666666 }))).toBeCloseTo(-66.6667, 3);
      expect(uniqueBuyerGrowthPctFromJupiterStats(stats({ holderChange: 100 }))).toBe(100);
      // Negative is measured (scores 0 via clamp), not unknown.
      expect(uniqueBuyerGrowthPctFromJupiterStats(stats({ holderChange: -10 }))).toBe(-10);
      expect(uniqueBuyerGrowthPctFromJupiterStats(stats({ holderChange: null }))).toBeNull();
      expect(uniqueBuyerGrowthPctFromJupiterStats(null)).toBeNull();
    });
    it("newWalletInflow is numNetBuyers; a measured 0 stays 0", () => {
      expect(newWalletInflowFromJupiterStats(stats({ numNetBuyers: 76 }))).toBe(76);
      expect(newWalletInflowFromJupiterStats(stats({ numNetBuyers: 0 }))).toBe(0);
      expect(newWalletInflowFromJupiterStats(stats({ numNetBuyers: null }))).toBeNull();
      expect(newWalletInflowFromJupiterStats(stats({ numNetBuyers: -1 }))).toBeNull();
      expect(newWalletInflowFromJupiterStats(null)).toBeNull();
    });
  });

  describe("parseToken2022Account", () => {
    const splAccount = {
      result: { value: {
        owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        data: { program: "spl-token", parsed: { info: { decimals: 6, isInitialized: true }, type: "mint" }, space: 82 },
      } },
    };
    const pyusdAccount = {
      result: { value: {
        owner: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
        data: { program: "spl-token-2022", parsed: { info: { decimals: 6, extensions: [
          { extension: "mintCloseAuthority", state: {} },
          { extension: "permanentDelegate", state: { delegate: "2apB" } },
          { extension: "transferFeeConfig", state: { newerTransferFee: { transferFeeBasisPoints: 0 } } },
          { extension: "transferHook", state: { authority: "2apB", programId: null } },
          { extension: "metadataPointer", state: {} },
        ] }, type: "mint" }, space: 82 },
      } },
    };
    it("SPL mint (USDC shape): all four flags false, measured, not unknown", () => {
      const f = parseToken2022Account(splAccount);
      expect(f).not.toBeNull();
      expect(f?.isToken2022).toBe(false);
      expect(f?.transferFee).toBe(false);
      expect(f?.transferHook).toBe(false);
      expect(f?.permanentDelegate).toBe(false);
      expect(f?.pause).toBe(false);
      expect(f?.program).toBe("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    });
    it("Token-2022 mint (PyUSD live shape): fee/hook/delegate true, pause false", () => {
      const f = parseToken2022Account(pyusdAccount);
      expect(f).not.toBeNull();
      expect(f?.isToken2022).toBe(true);
      // 0 bps fee and null hook program still count: the authority
      // can raise the fee / set a program.
      expect(f?.transferFee).toBe(true);
      expect(f?.transferHook).toBe(true);
      expect(f?.permanentDelegate).toBe(true);
      expect(f?.pause).toBe(false);
    });
    it("pausable extension sets pause (both spellings)", () => {
      const withPausable = JSON.parse(JSON.stringify(pyusdAccount)) as any;
      withPausable.result.value.data.parsed.info.extensions.push({ extension: "pausable", state: { paused: false } });
      expect(parseToken2022Account(withPausable)?.pause).toBe(true);
      const withConfig = JSON.parse(JSON.stringify(pyusdAccount)) as any;
      withConfig.result.value.data.parsed.info.extensions.push({ extension: "pausableConfig", state: {} });
      expect(parseToken2022Account(withConfig)?.pause).toBe(true);
    });
    it("unknown program or malformed response is null, never a false pass", () => {
      const other = JSON.parse(JSON.stringify(pyusdAccount)) as any;
      other.result.value.owner = "11111111111111111111111111111111";
      expect(parseToken2022Account(other)).toBeNull();
      expect(parseToken2022Account(null)).toBeNull();
      expect(parseToken2022Account({})).toBeNull();
      expect(parseToken2022Account({ result: { value: null } })).toBeNull();
      // Token-2022 mint with no extensions array: unknown, not false.
      const noExt = JSON.parse(JSON.stringify(pyusdAccount)) as any;
      delete noExt.result.value.data.parsed.info.extensions;
      expect(parseToken2022Account(noExt)).toBeNull();
    });
  });

  describe("bundlePctFromCluster / devSoldPctFromCluster", () => {
    it("linkedPct 8.7% (KYC shared funder) becomes bundlePct 0.087", () => {
      expect(bundlePctFromCluster(baseCluster({ linkedPct: 8.7 }))).toBeCloseTo(0.087, 5);
      expect(bundlePctFromCluster(baseCluster({ linkedPct: 0 }))).toBe(0);
    });
    it("missing linkedPct is null, never 0", () => {
      expect(bundlePctFromCluster(baseCluster({ linkedPct: null }))).toBeNull();
      expect(bundlePctFromCluster(null)).toBeNull();
    });
    it("a measured devSold 0 stays 0 (Pikachu: acquired 16.6M, sold 0)", () => {
      const c = baseCluster({ devSold: { pct: 0, acquired: 16568418.75, sold: 0, moved: 500000, txsChecked: 11, sawCreation: true, note: "creation seen in window" } });
      expect(devSoldPctFromCluster(c)).toBe(0);
    });
    it("missing devSold is null, and out-of-range pcts are null", () => {
      expect(devSoldPctFromCluster(baseCluster())).toBeNull();
      expect(devSoldPctFromCluster(baseCluster({ devSold: { pct: 1.5, acquired: 1, sold: 2, moved: 0, txsChecked: 1, sawCreation: false, note: "" } }))).toBeNull();
      expect(devSoldPctFromCluster(baseCluster({ devSold: { pct: -0.1, acquired: 1, sold: 0, moved: 0, txsChecked: 1, sawCreation: false, note: "" } }))).toBeNull();
    });
  });

  describe("rugInputFromReport with measured values", () => {
    it("passes measured values through; without them the fields stay null", () => {
      const measured = rugInputFromReport("M", baseReport(), baseCoin(true), false, {
        bundlePct: 0.087,
        devSoldPct: 0,
        washPct: 0.1,
        token2022: { isToken2022: true, transferFee: false, transferHook: false, permanentDelegate: false, pause: false, program: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" },
      });
      expect(measured.bundlePct).toBeCloseTo(0.087, 5);
      expect(measured.devSoldPct).toBe(0);
      expect(measured.washPct).toBe(0.1);
      expect(measured.token2022TransferFee).toBe(false);
      expect(measured.token2022Pause).toBe(false);
      const unmeasured = rugInputFromReport("M", baseReport(), baseCoin(true));
      expect(unmeasured.bundlePct).toBeNull();
      expect(unmeasured.devSoldPct).toBeNull();
      expect(unmeasured.washPct).toBeNull();
      expect(unmeasured.token2022TransferFee).toBeNull();
    });
    it("a measured Token-2022 fee passes through as a block", () => {
      const input = rugInputFromReport("M", baseReport(), baseCoin(true), false, {
        bundlePct: 0, devSoldPct: 0, washPct: 0.1,
        token2022: { isToken2022: true, transferFee: true, transferHook: false, permanentDelegate: false, pause: false, program: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" },
      });
      expect(evaluateRug(input).failed).toContain("token2022_transfer_fee");
    });
  });

  describe("gemInputFromCoin with measured cluster + flow components (v2.20)", () => {
    const coin = {
      mint: "M", name: "T", symbol: "T", creator: "C", created_timestamp: 0,
      usd_market_cap: 30000, complete: false, associated_bonding_curve: "", bonding_curve: "",
      canonical_pool_liquidity_usd: 4200,
    } as Parameters<typeof gemInputFromCoin>[0];
    const seen = {
      mint: "M", name: "T", symbol: "T", firstSeenMs: 0, firstMcUsd: 10000,
      lastMcUsd: 30000, lastSeenMs: 0, replies: 0, creator: "C", complete: false,
    } as Parameters<typeof gemInputFromCoin>[1];
    it("passes measured cluster + flow components through; defaults stay null", () => {
      const g = gemInputFromCoin(coin, seen, 0.03, undefined, false, { clusterPct: 0.087, uniqueBuyerGrowthPct: 66.7, buySellRatio: 2.0, newWalletInflow: 40 });
      expect(g.clusterPct).toBeCloseTo(0.087, 5);
      expect(g.uniqueBuyerGrowthPct).toBeCloseTo(66.7, 5);
      expect(g.buySellRatio).toBeCloseTo(2.0, 5);
      expect(g.newWalletInflow).toBe(40);
      const d = gemInputFromCoin(coin, seen, 0.03);
      expect(d.clusterPct).toBeNull();
      expect(d.uniqueBuyerGrowthPct).toBeNull();
      expect(d.buySellRatio).toBeNull();
      expect(d.newWalletInflow).toBeNull();
    });
    it("measured flow components lift the score by exactly their weight", () => {
      // Non-flow score: mc velocity 200% -> 15, curve 43% -> 2.17,
      // smart money 0, liquidity 4200 < 5000 -> 0: 17.17 -> 17.
      // With maxed flow: growth +25, buy/sell +20, inflow +15 = 60
      // more, total 77.17 -> 77.
      const rugPass = evaluateRug(rugInputFromReport("M", baseReport(), baseCoin(true), false, {
        bundlePct: 0, devSoldPct: 0, washPct: 0.1,
        token2022: { isToken2022: false, transferFee: false, transferHook: false, permanentDelegate: false, pause: false, program: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" },
      }));
      const without = evaluateGem(gemInputFromCoin(coin, seen, 0.03), rugPass);
      const withFlow = evaluateGem(gemInputFromCoin(coin, seen, 0.03, undefined, false, { uniqueBuyerGrowthPct: 100, buySellRatio: 2.0, newWalletInflow: 40 }), rugPass);
      expect(withFlow.score - without.score).toBe(60);
      expect(withFlow.score).toBe(77);
    });
  });

  describe("stage-A gem gate scores measured flow (v2.21)", () => {
    // Fixture: mc 30k, first-seen 10k (velocity 200% -> 15),
    // curve 43% -> 2, liquidity 20k -> 5, no smart money, no
    // recent buy. Non-flow score is 22 — the pre-v2.21 stage-A
    // ceiling in miniature: without measured flow this candidate
    // can never reach 60, let alone 70, so stage B was
    // unreachable. The rug is a clean pass (liquid coin, all four
    // measured fields clean) so only the gem score decides.
    const coin = {
      mint: "M", name: "T", symbol: "T", creator: "C", created_timestamp: 0,
      usd_market_cap: 30000, complete: false, associated_bonding_curve: "", bonding_curve: "",
      canonical_pool_liquidity_usd: 20000,
    } as Parameters<typeof gemInputFromCoin>[0];
    const seen = {
      mint: "M", name: "T", symbol: "T", firstSeenMs: 0, firstMcUsd: 10000,
      lastMcUsd: 30000, lastSeenMs: 0, replies: 0, creator: "C", complete: false,
    } as Parameters<typeof gemInputFromCoin>[1];
    const liquidCoin = { ...baseCoin(true), canonical_pool_liquidity_usd: 20000 };
    const rugPass = evaluateRug(rugInputFromReport("M", baseReport(), liquidCoin, false, {
      bundlePct: 0, devSoldPct: 0, washPct: 0.1,
      token2022: { isToken2022: false, transferFee: false, transferHook: false, permanentDelegate: false, pause: false, program: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" },
    }));
    const strongFlow = { uniqueBuyerGrowthPct: 100, buySellRatio: 2.0, newWalletInflow: 40 };

    it("strong measured flow lifts the candidate from 22 to 82 and makes it actionable at stage A", () => {
      const without = evaluateGem(gemInputFromCoin(coin, seen, 0.03), rugPass);
      expect(without.score).toBe(22);
      expect(without.score).toBeLessThanOrEqual(50);
      expect(without.actionable).toBe(false);
      const withFlow = evaluateGem(gemInputFromCoin(coin, seen, 0.03, undefined, false, strongFlow), rugPass);
      expect(withFlow.score).toBe(82);
      expect(withFlow.score).toBeGreaterThanOrEqual(70);
      expect(withFlow.actionable).toBe(true);
    });

    it("moderate measured flow reaches the 50 fresh-tier bar (62) without reaching 70", () => {
      const moderate = evaluateGem(
        gemInputFromCoin(coin, seen, 0.03, undefined, false, { uniqueBuyerGrowthPct: 60, buySellRatio: 1.5, newWalletInflow: 10 }),
        rugPass,
      );
      // Growth 60% -> +25, buy/sell 1.5 -> +10, inflow 10 -> +5:
      // 22 + 40 = 62.
      expect(moderate.score).toBe(62);
      expect(moderate.score).toBeGreaterThanOrEqual(FRESH_TIER_MIN_GEM);
      expect(moderate.score).toBeLessThan(70);
      expect(moderate.actionable).toBe(false);
    });

    it("weak measured flow still blocks at stage A (below the 50 fresh-tier bar too)", () => {
      const weak = evaluateGem(
        gemInputFromCoin(coin, seen, 0.03, undefined, false, { uniqueBuyerGrowthPct: 10, buySellRatio: 1.1, newWalletInflow: 4 }),
        rugPass,
      );
      // Growth 10% -> +5, buy/sell 1.1 -> +2, inflow 4 -> +2:
      // 22 + 9 = 31.
      expect(weak.score).toBe(31);
      expect(weak.score).toBeLessThan(FRESH_TIER_MIN_GEM);
      expect(weak.actionable).toBe(false);
    });

    it("v2.27 experiment: fresh-tier bar is 50 for 24h (reverts 2026-11-25 ~15:09 SAST)", () => {
      // The bar lives in one constant used by both the stage-A and
      // stage-B fresh-tier checks; pin it so a silent edit fails loudly.
      // A 50-59 score clears it, 49 does not; the clean 70 bar is untouched.
      expect(FRESH_TIER_MIN_GEM).toBe(50);
      expect(50).toBeGreaterThanOrEqual(FRESH_TIER_MIN_GEM);
      expect(59).toBeGreaterThanOrEqual(FRESH_TIER_MIN_GEM);
      expect(49).toBeLessThan(FRESH_TIER_MIN_GEM);
    });

    it("a failed fetch (null stats) scores flow 0 and blocks fail-closed at the gem gate", () => {
      const flow = stageAFlowFromJupiterStats(null);
      expect(flow).toEqual({ uniqueBuyerGrowthPct: null, buySellRatio: null, newWalletInflow: null });
      const gem = evaluateGem(gemInputFromCoin(coin, seen, 0.03, undefined, false, flow), rugPass);
      expect(gem.score).toBe(22);
      expect(gem.actionable).toBe(false);
      expect(gem.reason).toBe("gem score below 70");
      // Stats present but no stats1h yet (too young to judge) is
      // the same: unknown, not invented flow.
      const noS1 = stageAFlowFromJupiterStats(parseJupiterTokenResponse([{ id: "M", mcap: 30000 }], "M"));
      expect(noS1).toEqual({ uniqueBuyerGrowthPct: null, buySellRatio: null, newWalletInflow: null });
    });

    it("stageAFlowFromJupiterStats extracts all three components from one stats row", () => {
      const stats = parseJupiterTokenResponse(
        [{
          id: "M", mcap: 30000, liquidity: 20000, holderCount: 500, createdAt: "2026-11-24T00:00:00.000Z",
          stats1h: {
            buyVolume: 12000, sellVolume: 8000, buyOrganicVolume: 11000, sellOrganicVolume: 7500,
            numBuys: 120, numSells: 90, numTraders: 150, numNetBuyers: 30, holderChange: 45, volumeChange: 12.5,
          },
        }],
        "M",
      );
      expect(stageAFlowFromJupiterStats(stats)).toEqual({ uniqueBuyerGrowthPct: 45, buySellRatio: 1.5, newWalletInflow: 30 });
    });
  });

  describe("fetchMarketData fetches once per source (v2.21)", () => {
    const mint = "MINT11111111111111111111111111111111111111";
    afterEach(() => {
      vi.unstubAllGlobals();
    });
    it("issues exactly one DexScreener call and one Jupiter call per invocation, and returns both parsed", async () => {
      const seenUrls: string[] = [];
      vi.stubGlobal("fetch", async (url: string) => {
        seenUrls.push(url);
        if (url.includes("dexscreener")) {
          return {
            ok: true,
            json: async () => ({
              pairs: [{
                volume: { h24: 100000, h1: 5000 },
                txns: { m5: { buys: 40, sells: 30 }, h1: { buys: 300, sells: 200 }, h24: { buys: 2000, sells: 1227 } },
                liquidity: { usd: 9000 }, marketCap: 50000, pairCreatedAt: Date.now() - 3600000,
                priceChange: { h1: 90, h6: 150, h24: 300 },
              }],
            }),
          };
        }
        return {
          ok: true,
          json: async () => [{
            id: mint, mcap: 50000, liquidity: 9000, holderCount: 1200, createdAt: "2026-11-24T00:00:00.000Z",
            stats1h: {
              buyVolume: 12000, sellVolume: 8000, buyOrganicVolume: 11000, sellOrganicVolume: 7500,
              numBuys: 120, numSells: 90, numTraders: 150, numNetBuyers: 30, holderChange: 45, volumeChange: 12.5,
            },
          }],
        };
      });
      const { dex, jupStats } = await fetchMarketData(mint);
      expect(seenUrls.filter((u) => u.includes("dexscreener"))).toHaveLength(1);
      expect(seenUrls.filter((u) => u.includes("jup.ag"))).toHaveLength(1);
      expect(seenUrls).toHaveLength(2);
      expect(dex?.volumeH24).toBe(100000);
      expect(jupStats?.mcap).toBe(50000);
      expect(jupStats?.stats1h?.numNetBuyers).toBe(30);
      // A second invocation fetches again (no memoisation): "once"
      // is per poll invocation, enforced by the single call site in
      // runSpotterPoll — the wrapper itself never double-fetches.
      await fetchMarketData(mint);
      expect(seenUrls).toHaveLength(4);
    });
    it("a failed fetch yields null stats and never throws", async () => {
      vi.stubGlobal("fetch", async () => ({ ok: false, status: 500, json: async () => ({}) }));
      const { dex, jupStats } = await fetchMarketData(mint);
      expect(dex).toBeNull();
      expect(jupStats).toBeNull();
    });
  });

  describe("stageBMeasuredNote (v2.20)", () => {
    const t22 = { isToken2022: true, transferFee: false, transferHook: false, permanentDelegate: false, pause: false, program: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" };
    it("journals every measured value with its source, wash marked logged-only", () => {
      const note = stageBMeasuredNote(
        { bundlePct: 0.087, devSoldPct: 0, washPct: 0.975, token2022: t22, uniqueBuyerGrowthPct: 66.7, buySellRatio: 2.0, newWalletInflow: 40 },
        { pct: 0, acquired: 16568418.75, sold: 0, moved: 500000, txsChecked: 11, sawCreation: true, note: "creation seen in window" },
      );
      expect(note).toContain("bundle=8.7% helius-cluster-linked");
      expect(note).toContain("devSold=0.0% helius-creator-txs");
      expect(note).toContain("wash=97.5% jupiter-stats1h-organic, logged-only");
      expect(note).toContain("token2022=Token-2022 fee=false");
      expect(note).toContain("growth=66.7% jupiter-stats1h-holderChange");
      expect(note).toContain("buySell=2.00 jupiter-stats1h-volumes");
      expect(note).toContain("inflow=40 jupiter-stats1h-numNetBuyers");
    });
    it("writes unknown with the source, never 0, for unmeasured values", () => {
      const note = stageBMeasuredNote(
        { bundlePct: null, devSoldPct: null, washPct: null, token2022: null, uniqueBuyerGrowthPct: null, buySellRatio: null, newWalletInflow: null },
        null,
      );
      expect(note).toContain("bundle=unknown (helius cluster linkedPct)");
      expect(note).toContain("wash=unknown (jupiter stats1h organic, logged-only)");
      expect(note).toContain("growth=unknown (jupiter stats1h holderChange)");
      expect(note).toContain("buySell=unknown (jupiter stats1h volumes)");
      expect(note).toContain("inflow=unknown (jupiter stats1h numNetBuyers)");
    });
  });

  describe("two-stage rug evaluation (stage A defer -> stage B measure)", () => {
    // The base fixture coin has no liquidity (liquidity_unknown
    // blocks on its own); these tests use a liquid coin so only
    // the measured fields decide the verdict.
    const liquidCoin = { ...baseCoin(true), canonical_pool_liquidity_usd: 20000 };
    const stageA = (overrides: Record<string, unknown> = {}) =>
      rugInputFromReport("M", baseReport(overrides), liquidCoin);
    it("stage A defers the six fields; stage B with Pikachu values passes despite wash 0.975", () => {
      const inputA = stageA();
      const rugA = evaluateRug(inputA, { deferFields: RUG_DEFERRED_FIELDS });
      expect(rugA.verdict).toBe("pass");
      expect(rugA.deferred).toHaveLength(6);
      // Stage B: Pikachu measured — bundle 0, devSold 0, wash 0.975, SPL-style flags false.
      // Wash is logged-only since v2.20: 0.975 no longer blocks.
      const inputB = rugInputFromReport("M", baseReport(), liquidCoin, false, {
        bundlePct: 0, devSoldPct: 0, washPct: 0.975,
        token2022: { isToken2022: true, transferFee: false, transferHook: false, permanentDelegate: false, pause: false, program: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" },
      });
      const rugB = evaluateRug(inputB);
      expect(rugB.verdict).toBe("pass");
      expect(rugB.failed).toEqual([]);
    });
    it("stage B with all four fields clean passes", () => {
      const inputB = rugInputFromReport("M", baseReport(), liquidCoin, false, {
        bundlePct: 0, devSoldPct: 0, washPct: 0.1,
        token2022: { isToken2022: false, transferFee: false, transferHook: false, permanentDelegate: false, pause: false, program: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" },
      });
      expect(evaluateRug(inputB).verdict).toBe("pass");
    });
    it("stage B with a missing field still blocks (no deferral at stage B)", () => {
      const inputB = rugInputFromReport("M", baseReport(), liquidCoin, false, {
        bundlePct: 0, devSoldPct: 0, washPct: 0.1, token2022: null,
      });
      const rugB = evaluateRug(inputB);
      expect(rugB.verdict).toBe("block");
      expect(rugB.failed).toContain("token2022_transfer_fee_unknown");
    });
    it("the re-scored gem does NOT penalise measured wash, but DOES score measured flow (v2.20)", () => {
      const coin = {
        mint: "M", name: "T", symbol: "T", creator: "C", created_timestamp: 0,
        usd_market_cap: 30000, complete: true, associated_bonding_curve: "", bonding_curve: "",
        canonical_pool_liquidity_usd: 20000,
      } as Parameters<typeof gemInputFromCoin>[0];
      const seen = {
        mint: "M", name: "T", symbol: "T", firstSeenMs: 0, firstMcUsd: 10000,
        lastMcUsd: 30000, lastSeenMs: 0, replies: 0, creator: "C", complete: true,
      } as Parameters<typeof gemInputFromCoin>[1];
      const rugPass = evaluateRug(rugInputFromReport("M", baseReport(), baseCoin(true), false, {
        bundlePct: 0, devSoldPct: 0, washPct: 0.975,
        token2022: { isToken2022: false, transferFee: false, transferHook: false, permanentDelegate: false, pause: false, program: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" },
      }));
      // Wash 0.975 is in the rug input (logged-only) but there is
      // no wash input to the gem any more: the re-score with
      // measured cluster 0 equals the stage-A score exactly.
      const base = evaluateGem(gemInputFromCoin(coin, seen, 0.03, { wallets: 2, minTrades: 12 }, true), rugPass);
      const rescored = evaluateGem(gemInputFromCoin(coin, seen, 0.03, { wallets: 2, minTrades: 12 }, true, { clusterPct: 0 }), rugPass);
      expect(rescored.score).toBe(base.score);
      // ...while measured flow lifts it: growth 40% -> +20,
      // buy/sell 1.5 -> +10, inflow 10 -> +5 = +35 (moderate
      // values, so the 100 clamp does not hide the contribution).
      const withFlow = evaluateGem(gemInputFromCoin(coin, seen, 0.03, { wallets: 2, minTrades: 12 }, true, { clusterPct: 0, uniqueBuyerGrowthPct: 40, buySellRatio: 1.5, newWalletInflow: 10 }), rugPass);
      expect(withFlow.score - base.score).toBe(35);
      // ...and the cluster penalty still applies on measured cluster.
      const clustered = evaluateGem(gemInputFromCoin(coin, seen, 0.03, { wallets: 2, minTrades: 12 }, true, { clusterPct: 0.4 }), rugPass);
      expect(clustered.score).toBe(base.score - 20);
    });
  });
});

describe("v2.25 liq/vol ratio + exit grading + thesis (logged only)", () => {
  const dex = (volumeH24: number | null, liquidityUsd: number | null) =>
    ({ volumeH24, liquidityUsd }) as unknown as Parameters<typeof entryLiqVol>[0];

  it("liq/vol ratio is h24 volume / liquidity, suspicious below 0.1", () => {
    expect(entryLiqVol(dex(50000, 100000))).toEqual({ liqVolRatio: 0.5, liqVolSuspicious: false });
    expect(entryLiqVol(dex(5000, 100000))).toEqual({ liqVolRatio: 0.05, liqVolSuspicious: true });
    // Exactly 0.1 is NOT suspicious — the rule is strictly below.
    expect(entryLiqVol(dex(10000, 100000))).toEqual({ liqVolRatio: 0.1, liqVolSuspicious: false });
    expect(LIQ_VOL_SUSPICIOUS_BELOW).toBe(0.1);
  });

  it("missing DexScreener data reads null, never 0, never suspicious", () => {
    expect(entryLiqVol(null)).toEqual({ liqVolRatio: null, liqVolSuspicious: false });
    expect(entryLiqVol(dex(null, 100000))).toEqual({ liqVolRatio: null, liqVolSuspicious: false });
    expect(entryLiqVol(dex(50000, null))).toEqual({ liqVolRatio: null, liqVolSuspicious: false });
    expect(entryLiqVol(dex(50000, 0))).toEqual({ liqVolRatio: null, liqVolSuspicious: false });
    expect(entryLiqVol(dex(-100, 100000))).toEqual({ liqVolRatio: null, liqVolSuspicious: false });
  });

  it("liqVolNoteText is compact and empty when unmeasurable", () => {
    expect(liqVolNoteText(entryLiqVol(dex(50000, 100000)))).toBe("liq/vol 0.50");
    expect(liqVolNoteText(entryLiqVol(dex(5000, 100000)))).toContain("SUSPICIOUS");
    expect(liqVolNoteText(entryLiqVol(null))).toBe("");
  });

  it("provisional grade: >=90% of the peak move kept is excellent", () => {
    expect(provisionalExitGrade(100, 190, 200)).toBe("excellent");
    expect(provisionalExitGrade(100, 200, 200)).toBe("excellent");
  });

  it("provisional grade: <=50% kept (incl. below entry after a run-up) is round-tripped", () => {
    expect(provisionalExitGrade(100, 110, 200)).toBe("round-tripped");
    expect(provisionalExitGrade(100, 60, 200)).toBe("round-tripped");
    expect(provisionalExitGrade(100, 150, 200)).toBe("round-tripped"); // exactly 50% kept
  });

  it("provisional grade: 50-90% kept, or never above entry, is pending", () => {
    expect(provisionalExitGrade(100, 170, 200)).toBe("pending");
    expect(provisionalExitGrade(100, 90, 100)).toBe("pending");
    expect(provisionalExitGrade(0, 100, 200)).toBe("pending");
  });

  it("final grade: post-exit rise over 5% is sold early, with left-on-table in % and $", () => {
    const g = finalizeExitGrade(100, 150, 160, 180, true, 2.2);
    expect(g.exitQuality).toBe("sold early");
    expect(g.leftOnTablePct).toBeCloseTo(20, 5);
    expect(g.leftOnTableUsd).toBeCloseTo(0.44, 5);
    expect(g.leftOnTableReason).toContain("120-min window");
  });

  it("final grade: no post-exit price leaves left-on-table null with a reason", () => {
    const g = finalizeExitGrade(100, 190, 200, null, false, 2.2);
    expect(g.exitQuality).toBe("excellent");
    expect(g.leftOnTablePct).toBeNull();
    expect(g.leftOnTableUsd).toBeNull();
    expect(g.leftOnTableReason).toContain("no post-exit price");
  });

  it("final grade: a pending provisional finalises to excellent when nothing ran on", () => {
    const g = finalizeExitGrade(100, 170, 200, null, false, 2.2);
    expect(g.exitQuality).toBe("excellent");
  });

  it("final grade: post-exit peak below the exit means nothing left on the table", () => {
    const g = finalizeExitGrade(100, 150, 160, 140, true, 2.2);
    expect(g.exitQuality).toBe("excellent");
    expect(g.leftOnTablePct).toBe(0);
    expect(g.leftOnTableUsd).toBe(0);
  });

  it("final grade: a >=50% in-trade give-back stays round-tripped even if the price later rose", () => {
    const g = finalizeExitGrade(100, 110, 200, 250, true, 2.2);
    expect(g.exitQuality).toBe("round-tripped");
    expect(g.leftOnTablePct).toBeCloseTo(127.27, 2);
  });

  it("gradeClose bundles details + journal fields and never touches the thesis", () => {
    const state = newState();
    state.equityUsd = 15;
    const pos = openPosition("p1", "MINT", 100, 2.2, 0);
    pos.peakPrice = 200;
    const p = {
      id: pos.id,
      mint: "MINT",
      name: "Test",
      entryMcUsd: 100,
      sizeUsd: 2.2,
      openedAtMs: 0,
      position: pos,
      lastMcUsd: 190,
      missedPolls: 0,
      entryThesis: "gem 71, fresh tier",
      sizePctAtEntry: 15,
    };
    const g = gradeClose(p, 190, 2.2);
    expect(g.journal.exitQuality).toBe("excellent");
    expect(g.journal.leftOnTablePct).toBeNull();
    expect(g.journal.leftOnTableReason).toContain("pending post-exit");
    expect(g.journal.sizePct).toBe(15);
    expect(g.journal.sizePctFlagged).toBe(false);
    expect(g.details.peakMcUsd).toBe(200);
    expect(g.details.exitCostBasisUsd).toBe(2.2);
    expect(p.entryThesis).toBe("gem 71, fresh tier"); // unchanged
    expect("entryThesis" in g.journal).toBe(false);
    expect("entryThesis" in g.details).toBe(false);
  });

  it("gradeClose journals sizePct null (never reconstructed) for pre-v2.25 positions", () => {
    const pos = openPosition("p1", "MINT", 100, 2.2, 0);
    const p = {
      id: pos.id,
      mint: "MINT",
      name: "Test",
      entryMcUsd: 100,
      sizeUsd: 2.2,
      openedAtMs: 0,
      position: pos,
      lastMcUsd: 100,
      missedPolls: 0,
    };
    const g = gradeClose(p, 70, 2.2);
    expect(g.journal.sizePct).toBeNull();
    expect(g.journal.sizePctFlagged).toBe(false);
    expect(g.journal.exitQuality).toBe("pending"); // never above entry
  });

  it("gradeClose flags sizePct over 25%", () => {
    const pos = openPosition("p1", "MINT", 100, 2.2, 0);
    const p = {
      id: pos.id,
      mint: "MINT",
      name: "Test",
      entryMcUsd: 100,
      sizeUsd: 2.2,
      openedAtMs: 0,
      position: pos,
      lastMcUsd: 100,
      missedPolls: 0,
      sizePctAtEntry: 30,
    };
    expect(gradeClose(p, 200, 2.2).journal.sizePctFlagged).toBe(true);
  });

  it("post-exit tracking raises the peak from the discovery feed and finalises at 120 min", () => {
    const dir = mkdtempSync(join(tmpdir(), "sculgrok-v225-"));
    const journalPath = join(dir, "journal.jsonl");
    const state = newState();
    state.equityUsd = 15;
    recordClosedMint(
      state,
      "MINT",
      150,
      1000000,
      "take profit 2",
      { entryMcUsd: 100, peakMcUsd: 160, exitCostBasisUsd: 2.2, exitQuality: "pending", sizePct: 15, sizePctFlagged: false },
      journalPath,
    );
    expect(state.closedMints["MINT"].graded).toBe(false);
    expect(state.closedMints["MINT"].postExitSeen).toBe(false);
    // 60 min in, seen at 180: peak rises, not graded yet.
    updatePostExitTracking(state, new Map([["MINT", 180]]), 1000000 + 60 * 60 * 1000, journalPath);
    expect(state.closedMints["MINT"].postExitPeakMcUsd).toBe(180);
    expect(state.closedMints["MINT"].postExitSeen).toBe(true);
    expect(state.closedMints["MINT"].graded).toBe(false);
    // 119 min: still inside the window.
    updatePostExitTracking(state, new Map(), 1000000 + 119 * 60 * 1000, journalPath);
    expect(state.closedMints["MINT"].graded).toBe(false);
    // 120 min: finalised with one exit_grade line.
    updatePostExitTracking(state, new Map(), 1000000 + POST_EXIT_TRACK_MS, journalPath);
    expect(state.closedMints["MINT"].graded).toBe(true);
    expect(state.exitGradeSignals).toBe(1);
    const lines = readFileSync(journalPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(1);
    expect(lines[0].action).toBe("exit_grade");
    expect(lines[0].exitQuality).toBe("sold early");
    expect(lines[0].leftOnTablePct).toBeCloseTo(20, 5);
    expect(lines[0].leftOnTableUsd).toBeCloseTo(0.44, 5);
    expect(lines[0].sizePct).toBe(15);
    // A second pass never re-grades.
    updatePostExitTracking(state, new Map(), 1000000 + 2 * POST_EXIT_TRACK_MS, journalPath);
    expect(state.exitGradeSignals).toBe(1);
    expect(readFileSync(journalPath, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("a new close finalises the previous ungraded record instead of dropping its grade", () => {
    const dir = mkdtempSync(join(tmpdir(), "sculgrok-v225-"));
    const journalPath = join(dir, "journal.jsonl");
    const state = newState();
    state.equityUsd = 15;
    recordClosedMint(
      state,
      "MINT",
      150,
      1000000,
      "take profit 2",
      { entryMcUsd: 100, peakMcUsd: 160, exitCostBasisUsd: 2.2, exitQuality: "pending", sizePct: 15, sizePctFlagged: false },
      journalPath,
    );
    recordClosedMint(state, "MINT", 90, 1000000 + 40 * 60 * 1000, "hard stop", undefined, journalPath);
    const lines = readFileSync(journalPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(1);
    expect(lines[0].action).toBe("exit_grade");
    expect(lines[0].reason).toContain("superseded by new close");
    expect(lines[0].leftOnTablePct).toBeNull(); // never seen again
    expect(state.closedMints["MINT"].exitMcUsd).toBe(90);
  });

  it("records predating grading are marked graded silently, with no line", () => {
    const dir = mkdtempSync(join(tmpdir(), "sculgrok-v225-"));
    const journalPath = join(dir, "journal.jsonl");
    const state = newState();
    state.equityUsd = 15;
    recordClosedMint(state, "OLD", 50000, 1000000, "hard stop");
    updatePostExitTracking(state, new Map(), 1000000 + POST_EXIT_TRACK_MS, journalPath);
    expect(state.closedMints["OLD"].graded).toBe(true);
    expect(state.exitGradeSignals).toBe(0);
    expect(() => readFileSync(journalPath, "utf8")).toThrow(); // no file written
  });

  it("newState starts with zero exitGradeSignals and normalizeState repairs it", () => {
    expect(newState().exitGradeSignals).toBe(0);
    const state = newState() as unknown as Record<string, unknown>;
    delete state.exitGradeSignals;
    expect(normalizeState(state as unknown as SpotterState).exitGradeSignals).toBe(0);
  });

  it("finalizeExitGradeNow is a no-op on an already-graded record", () => {
    const state = newState();
    state.equityUsd = 15;
    recordClosedMint(
      state,
      "MINT",
      150,
      1000000,
      "take profit 2",
      { entryMcUsd: 100, peakMcUsd: 160, exitCostBasisUsd: 2.2, exitQuality: "pending", sizePct: 15, sizePctFlagged: false },
      null,
    );
    finalizeExitGradeNow(state, "MINT", 1000000, null, "test");
    expect(state.exitGradeSignals).toBe(1);
    finalizeExitGradeNow(state, "MINT", 1000000, null, "test");
    expect(state.exitGradeSignals).toBe(1);
  });
});

describe("v2.28 funnel fixes (pre-slice cooldown filter, transient/permanent split, second-look, stage-A flow note)", () => {
  const T0 = 1_000_000_000_000;
  const MIN = 60 * 1000;

  function seenCoin(mint: string, firstSeenMs: number, overrides: Record<string, unknown> = {}) {
    return {
      mint,
      name: "T",
      symbol: "T",
      firstSeenMs,
      firstMcUsd: 10000,
      lastMcUsd: 10000,
      lastSeenMs: firstSeenMs,
      replies: 0,
      creator: "CREATOR",
      complete: false,
      bondingCurve: "CURVE",
      associatedBondingCurve: "ACURVE",
      ...overrides,
    };
  }

  function rugReport(overrides: Record<string, unknown> = {}) {
    return {
      mintAuthority: null,
      freezeAuthority: null,
      risks: [],
      ...overrides,
    } as Parameters<typeof classifyRugcheckFailure>[0];
  }

  it("classifies creator-history danger as permanent", () => {
    expect(classifyRugcheckFailure(rugReport({ risks: [{ name: "Creator history of rugged tokens", level: "danger" }] }))).toBe("permanent");
  });

  it("classifies live mint / freeze authority as permanent", () => {
    expect(classifyRugcheckFailure(rugReport({ mintAuthority: "MINTAUTH" }))).toBe("permanent");
    expect(classifyRugcheckFailure(rugReport({ freezeAuthority: "FREEZEAUTH" }))).toBe("permanent");
  });

  it("classifies concentration and low liquidity as transient", () => {
    expect(
      classifyRugcheckFailure(
        rugReport({ risks: [{ name: "Single holder ownership", level: "danger" }, { name: "Top 10 holders own a large portion", level: "danger" }] }),
      ),
    ).toBe("transient");
    expect(classifyRugcheckFailure(rugReport({ risks: [{ name: "Low liquidity", level: "warn" }] }))).toBe("transient");
  });

  it("classifies an empty risk list as permanent (fail-closed) and a warn-level creator mention as transient", () => {
    expect(classifyRugcheckFailure(rugReport({ risks: [] }))).toBe("permanent");
    expect(classifyRugcheckFailure(rugReport({ risks: [{ name: "Creator history of rugged tokens", level: "warn" }] }))).toBe("transient");
  });

  it("permanent tier uses the 24h window and never ends early on an mc rise", () => {
    const state = newState();
    noteBlocked(state, "MINT", T0, 10000, false, "permanent");
    expect(blockedCooldownRemaining(state, "MINT", T0 + 10 * MIN, 10000)).toBe(PERMANENT_COOLDOWN_MS - 10 * MIN);
    expect(blockedCooldownRemaining(state, "MINT", T0 + 10 * MIN, 30000)).toBeGreaterThan(0);
    expect(blockedCooldownRemaining(state, "MINT", T0 + 24 * 60 * MIN, 10000)).toBe(0);
    expect(PERMANENT_COOLDOWN_MS).toBe(24 * 60 * 60 * 1000);
  });

  it("transient tier uses the 15m window and the 25% rise bar", () => {
    const state = newState();
    noteBlocked(state, "MINT", T0, 10000, true, "transient");
    expect(blockedCooldownRemaining(state, "MINT", T0 + 10 * MIN, 10000)).toBe(5 * MIN);
    expect(blockedCooldownRemaining(state, "MINT", T0 + 15 * MIN, 10000)).toBe(0);
    expect(blockedCooldownRemaining(state, "MINT", T0 + 10 * MIN, 12500)).toBe(0);
    expect(blockedCooldownRemaining(state, "MINT", T0 + 10 * MIN, 12000)).toBeGreaterThan(0);
  });

  it("a record without kind keeps the legacy 60m / 50% behaviour", () => {
    const state = newState();
    noteBlocked(state, "MINT", T0, 10000, false);
    expect(blockedCooldownRemaining(state, "MINT", T0 + 10 * MIN, 10000)).toBe(50 * MIN);
    expect(blockedCooldownRemaining(state, "MINT", T0 + 10 * MIN, 15000)).toBe(0);
    expect(state.blockedMints["MINT"].kind).toBeUndefined();
  });

  it("noteBlocked overwrites the kind on a re-block", () => {
    const state = newState();
    noteBlocked(state, "MINT", T0, 10000, true, "transient");
    noteBlocked(state, "MINT", T0 + 5 * MIN, 10000, false, "permanent");
    expect(state.blockedMints["MINT"].kind).toBe("permanent");
    expect(blockedCooldownRemaining(state, "MINT", T0 + 20 * MIN, 10000)).toBeGreaterThan(60 * MIN);
  });

  it("filterCooldownBlocked drops cooled-down mints and keeps free ones", () => {
    const state = newState();
    noteBlocked(state, "COLD", T0, 10000, false);
    const ranked = [
      { coin: { ...baseCoin(false), mint: "COLD", usd_market_cap: 10000 } },
      { coin: { ...baseCoin(false), mint: "FREE", usd_market_cap: 10000 } },
      { coin: { ...baseCoin(false), mint: "RISEN", usd_market_cap: 30000 } },
    ];
    noteBlocked(state, "RISEN", T0, 10000, false);
    const kept = filterCooldownBlocked(ranked, state, T0 + 10 * MIN);
    expect(kept.map((c) => c.coin.mint)).toEqual(["FREE", "RISEN"]);
  });

  it("pickSecondLookCandidates picks a transient mint at age 45m with an expired cooldown", () => {
    const state = newState();
    state.seen["MINT"] = seenCoin("MINT", T0);
    noteBlocked(state, "MINT", T0 + 30 * MIN, 10000, true, "transient");
    expect(pickSecondLookCandidates(state, T0 + 45 * MIN)).toEqual(["MINT"]);
  });

  it("pickSecondLookCandidates rejects permanent, too-young, too-old, curve-less, re-entry-blocked and open mints", () => {
    const state = newState();
    const now = T0 + 60 * MIN;
    // permanent
    state.seen["PERM"] = seenCoin("PERM", T0);
    noteBlocked(state, "PERM", T0 + 30 * MIN, 10000, false, "permanent");
    // too young (age 10m, cooldown also unexpired)
    state.seen["YOUNG"] = seenCoin("YOUNG", T0 + 50 * MIN);
    noteBlocked(state, "YOUNG", T0 + 50 * MIN, 10000, true, "transient");
    // too old (age 150m)
    state.seen["OLD"] = seenCoin("OLD", T0 - 90 * MIN);
    noteBlocked(state, "OLD", T0 + 40 * MIN, 10000, true, "transient");
    // no curve addresses (predates v2.28)
    state.seen["NOCURVE"] = seenCoin("NOCURVE", T0, { bondingCurve: undefined, associatedBondingCurve: undefined });
    noteBlocked(state, "NOCURVE", T0 + 30 * MIN, 10000, true, "transient");
    // re-entry blocked (closed 5m ago)
    state.seen["CLOSED"] = seenCoin("CLOSED", T0);
    noteBlocked(state, "CLOSED", T0 + 30 * MIN, 10000, true, "transient");
    state.closedMints["CLOSED"] = { closedAtMs: now - 5 * MIN, exitMcUsd: 9000, reason: "test" };
    // open position
    state.seen["OPEN"] = seenCoin("OPEN", T0);
    noteBlocked(state, "OPEN", T0 + 30 * MIN, 10000, true, "transient");
    state.positions.push({
      id: "OPEN",
      mint: "OPEN",
      name: "T",
      entryMcUsd: 10000,
      sizeUsd: 3.3,
      openedAtMs: T0,
      position: openPosition("OPEN", "OPEN", 10000, 3.3, T0),
      lastMcUsd: 10000,
      missedPolls: 0,
    });
    expect(pickSecondLookCandidates(state, now)).toEqual([]);
  });

  it("pickSecondLookCandidates takes at most 2, oldest first-seen first", () => {
    const state = newState();
    const now = T0 + 60 * MIN;
    for (const [mint, firstSeen] of [["A", T0], ["B", T0 + 10 * MIN], ["C", T0 + 20 * MIN]] as const) {
      state.seen[mint] = seenCoin(mint, firstSeen);
      noteBlocked(state, mint, now - 20 * MIN, 10000, true, "transient");
    }
    expect(pickSecondLookCandidates(state, now)).toEqual(["A", "B"]);
    expect(pickSecondLookCandidates(state, now, 1)).toEqual(["A"]);
    expect(SECOND_LOOK_SLOTS).toBe(2);
    expect(SECOND_LOOK_MIN_AGE_MS).toBe(30 * 60 * 1000);
    expect(SECOND_LOOK_MAX_AGE_MS).toBe(120 * 60 * 1000);
    expect(SLICE_CANDIDATES).toBe(8);
  });

  it("buildSecondLookCoin rebuilds the exact coin and tags it second-look", () => {
    const state = newState();
    state.seen["MINT"] = seenCoin("MINT", T0);
    const coin = buildSecondLookCoin(state, "MINT", 15000, T0 + 45 * MIN);
    expect(coin).not.toBeNull();
    expect(coin!.mint).toBe("MINT");
    expect(coin!.creator).toBe("CREATOR");
    expect(coin!.bonding_curve).toBe("CURVE");
    expect(coin!.associated_bonding_curve).toBe("ACURVE");
    expect(coin!.usd_market_cap).toBe(15000);
    expect(coin!.created_timestamp).toBe(T0);
    expect(coin!.ath_market_cap).toBe(15000);
    expect(coin!.discoveredVia).toBe("second-look");
    expect(discoverySource(coin!)).toBe("second-look");
  });

  it("buildSecondLookCoin returns null without the curve addresses", () => {
    const state = newState();
    state.seen["MINT"] = seenCoin("MINT", T0, { bondingCurve: undefined, associatedBondingCurve: undefined });
    expect(buildSecondLookCoin(state, "MINT", 15000, T0 + 45 * MIN)).toBeNull();
    const empty = newState();
    expect(buildSecondLookCoin(empty, "MINT", 15000, T0 + 45 * MIN)).toBeNull();
  });

  it("stageAFlowNote formats components and nulls", () => {
    expect(stageAFlowNote({ uniqueBuyerGrowthPct: 120, buySellRatio: 1.35, newWalletInflow: 40 }, 85, 0, 3, false)).toBe(
      "flow: buySell=1.35 holderChg=120% netBuyers=40 mcVel=85% sm=0/3 alert=no",
    );
    expect(stageAFlowNote({ uniqueBuyerGrowthPct: null, buySellRatio: null, newWalletInflow: null }, 0, 1, 1, true)).toBe(
      "flow: buySell=null holderChg=null netBuyers=null mcVel=0% sm=1/1 alert=yes",
    );
  });
});
