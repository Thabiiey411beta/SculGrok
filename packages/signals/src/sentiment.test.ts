import { describe, expect, it } from "vitest";
import { writeFileSync, mkdtempSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadGraduatedMints, parseDexScreenerResponse, scoreSentiment, type SentimentInput } from "./sentiment.js";

function baseInput(overrides: Partial<SentimentInput> = {}): SentimentInput {
  return {
    mint: "TEST11111111111111111111111111111111111111",
    smartBuyers: [],
    smartBuyUsd: 0,
    recentBuyers: [],
    onGraduatedBoard: false,
    birdeyeRank: null,
    birdeyeVolumeChangePct: null,
    dexVolumeH24: null,
    dexVolumeH1: null,
    dexTxnsH24: null,
    dexMcapUsd: null,
    cmcSolChange24hPct: null,
    cmcBtcChange24hPct: null,
    ...overrides,
  };
}

describe("scoreSentiment — X-free tracker v2.8", () => {
  it("all sources missing is unknown, score 0, never hot or cold", () => {
    const s = scoreSentiment(baseInput());
    expect(s.score).toBe(0);
    expect(s.verdict).toBe("unknown");
    expect(s.sources).toEqual([]);
  });

  it("three distinct smart buyers with size cluster hard (40 + 10)", () => {
    const s = scoreSentiment(baseInput({ smartBuyers: ["a", "b", "c"], smartBuyUsd: 50000, recentBuyers: ["a", "b", "c"] }));
    expect(s.components.smartCluster).toBe(50);
    expect(s.score).toBe(50);
    expect(s.verdict).toBe("warm");
  });

  it("duplicate smart buyers count once", () => {
    const s = scoreSentiment(baseInput({ smartBuyers: ["a", "a", "a"], smartBuyUsd: 0 }));
    expect(s.components.smartCluster).toBe(15);
  });

  it("one small smart buy alone is cold", () => {
    const s = scoreSentiment(baseInput({ smartBuyers: ["a"], smartBuyUsd: 500 }));
    expect(s.score).toBe(15);
    expect(s.verdict).toBe("cold");
  });

  it("graduated board + strong smart cluster is warm, not hot — one source family cannot score hot", () => {
    // Score 65 from the fomo family alone (smart cluster 50 + board
    // 15). The single-family cap (SOUL audit fix) holds it at warm:
    // hot needs >= 2 distinct source families.
    const s = scoreSentiment(
      baseInput({ smartBuyers: ["a", "b", "c"], smartBuyUsd: 20000, recentBuyers: ["a", "b", "c"], onGraduatedBoard: true }),
    );
    expect(s.components.board).toBe(15);
    expect(s.score).toBe(65);
    expect(s.verdict).toBe("warm");
  });

  it("two source families at >= 60 is hot", () => {
    // Same fomo signal (65) plus a Birdeye trending component (+5,
    // rank 120) — two families, score 70, hot.
    const s = scoreSentiment(
      baseInput({ smartBuyers: ["a", "b", "c"], smartBuyUsd: 20000, recentBuyers: ["a", "b", "c"], onGraduatedBoard: true, birdeyeRank: 120, birdeyeVolumeChangePct: 10 }),
    );
    expect(s.score).toBe(70);
    expect(s.verdict).toBe("hot");
  });

  it("birdeye top-10 rank with volume surge scores the full trending component", () => {
    const s = scoreSentiment(baseInput({ birdeyeRank: 5, birdeyeVolumeChangePct: 250 }));
    expect(s.components.trending).toBe(20);
    expect(s.sources).toContain("birdeye-trending");
  });

  it("birdeye rank outside the top 50 still counts as present", () => {
    const s = scoreSentiment(baseInput({ birdeyeRank: 120, birdeyeVolumeChangePct: 10 }));
    expect(s.components.trending).toBe(5);
  });

  it("dex volume spike ratio is h1 vs the h24 hourly average", () => {
    // h1 75,000 vs h24/24 = 22,500 -> 3.33x spike, +10; txns 3,227 -> +5.
    const s = scoreSentiment(
      baseInput({ dexVolumeH24: 540000, dexVolumeH1: 75000, dexTxnsH24: 3227, dexMcapUsd: 7000000 }),
    );
    expect(s.volumeSpikeRatio).toBeCloseTo(3.33, 1);
    expect(s.components.volume).toBe(15);
    expect(s.sources).toContain("dexscreener");
  });

  it("dex volume/mcap rewards real turnover, not just a big mcap", () => {
    const s = scoreSentiment(baseInput({ dexVolumeH24: 60000, dexVolumeH1: 1000, dexTxnsH24: 100, dexMcapUsd: 100000 }));
    // spike 0.4x -> 0; vol/mcap 0.6 -> +5; txns < 300 -> 0.
    expect(s.components.volume).toBe(5);
  });

  it("breadth rewards many distinct recent buyers", () => {
    const s = scoreSentiment(baseInput({ recentBuyers: Array.from({ length: 12 }, (_, i) => "t" + i) }));
    expect(s.components.breadth).toBe(5);
    expect(s.verdict).toBe("cold");
  });

  it("score never exceeds 100 even with every component maxed", () => {
    const s = scoreSentiment(
      baseInput({
        smartBuyers: ["a", "b", "c", "d"],
        smartBuyUsd: 100000,
        recentBuyers: Array.from({ length: 20 }, (_, i) => "t" + i),
        onGraduatedBoard: true,
        birdeyeRank: 1,
        birdeyeVolumeChangePct: 600,
        dexVolumeH24: 1000000,
        dexVolumeH1: 200000,
        dexTxnsH24: 5000,
        dexMcapUsd: 1000000,
        cmcSolChange24hPct: 5.0,
        cmcBtcChange24hPct: 2.0,
      }),
    );
    expect(s.score).toBeLessThanOrEqual(100);
    expect(s.verdict).toBe("hot");
  });
});

describe("scoreSentiment — CMC market context v2.9", () => {
  it("risk-on with SOL outperforming BTC scores the full 10", () => {
    const s = scoreSentiment(baseInput({ cmcSolChange24hPct: 3.5, cmcBtcChange24hPct: 1.2 }));
    expect(s.components.cmcMarket).toBe(10);
    expect(s.sources).toContain("coinmarketcap");
    expect(s.cmcSolChange24hPct).toBe(3.5);
    expect(s.cmcBtcChange24hPct).toBe(1.2);
  });

  it("both green but BTC outperforming SOL scores 7", () => {
    const s = scoreSentiment(baseInput({ cmcSolChange24hPct: 0.8, cmcBtcChange24hPct: 2.0 }));
    expect(s.components.cmcMarket).toBe(7);
  });

  it("mixed market (one green, one red) scores 3", () => {
    const s = scoreSentiment(baseInput({ cmcSolChange24hPct: 1.5, cmcBtcChange24hPct: -0.5 }));
    expect(s.components.cmcMarket).toBe(3);
  });

  it("both red scores 0 and is cold, not unknown — the data is present", () => {
    const s = scoreSentiment(baseInput({ cmcSolChange24hPct: -2.0, cmcBtcChange24hPct: -1.0 }));
    expect(s.components.cmcMarket).toBe(0);
    expect(s.score).toBe(0);
    expect(s.verdict).toBe("cold");
    expect(s.sources).toContain("coinmarketcap");
  });

  it("CMC missing entirely is component 0 with no coinmarketcap source", () => {
    const s = scoreSentiment(baseInput({ cmcSolChange24hPct: null, cmcBtcChange24hPct: null }));
    expect(s.components.cmcMarket).toBe(0);
    expect(s.sources).not.toContain("coinmarketcap");
    expect(s.verdict).toBe("unknown");
  });

  it("a partial CMC quote (only one side) is treated as missing", () => {
    const s = scoreSentiment(baseInput({ cmcSolChange24hPct: 4.0, cmcBtcChange24hPct: null }));
    expect(s.components.cmcMarket).toBe(0);
    expect(s.sources).not.toContain("coinmarketcap");
  });

  it("CMC credits pass through to the score for journal logging", () => {
    const s = scoreSentiment(baseInput({ cmcSolChange24hPct: 1.0, cmcBtcChange24hPct: 1.0, cmcCredits: 1 }));
    expect(s.cmcCredits).toBe(1);
  });

  it("cap still holds at 100 with CMC maxed on top of everything else", () => {
    const s = scoreSentiment(
      baseInput({
        smartBuyers: ["a", "b", "c"],
        smartBuyUsd: 50000,
        recentBuyers: Array.from({ length: 12 }, (_, i) => "t" + i),
        onGraduatedBoard: true,
        birdeyeRank: 1,
        birdeyeVolumeChangePct: 500,
        dexVolumeH24: 1000000,
        dexVolumeH1: 200000,
        dexTxnsH24: 5000,
        dexMcapUsd: 1000000,
        cmcSolChange24hPct: 5.0,
        cmcBtcChange24hPct: 2.0,
      }),
    );
    // Raw 50 + 15 + 20 + 20 + 5 + 10 = 120, clamped to 100.
    expect(s.score).toBe(100);
  });
});

describe("loadGraduatedMints", () => {
  it("reads addresses from a feed file", () => {
    const dir = mkdtempSync(join(tmpdir(), "sentiment-test-"));
    const path = join(dir, "feed.json");
    writeFileSync(path, JSON.stringify({ graduatedTokens: [{ address: "MINT_A" }, { address: "MINT_B" }, {}] }));
    expect(loadGraduatedMints(path)).toEqual(new Set(["MINT_A", "MINT_B"]));
  });

  it("missing file returns an empty set, never throws", () => {
    expect(loadGraduatedMints("/tmp/does-not-exist-sentiment-feed.json")).toEqual(new Set());
  });

  it("a feed older than 6h awards no board points (stale feed = empty set)", () => {
    const dir = mkdtempSync(join(tmpdir(), "sentiment-test-"));
    const path = join(dir, "feed.json");
    writeFileSync(path, JSON.stringify({ graduatedTokens: [{ address: "MINT_OLD" }] }));
    const old = new Date(Date.now() - 7 * 60 * 60 * 1000);
    utimesSync(path, old, old);
    expect(loadGraduatedMints(path)).toEqual(new Set());
    // And a fresh file with the same content still reads.
    const fresh = new Date();
    utimesSync(path, fresh, fresh);
    expect(loadGraduatedMints(path)).toEqual(new Set(["MINT_OLD"]));
  });
});

describe("parseDexScreenerResponse — v2.14 buy/sell split logging", () => {
  const response = {
    pairs: [
      {
        dexId: "pumpswap",
        volume: { h24: 5000, h1: 500 },
        txns: { h24: { buys: 10, sells: 12 }, h1: { buys: 2, sells: 3 }, m5: { buys: 1, sells: 1 } },
        liquidity: { usd: 100 },
        marketCap: 20000,
        pairCreatedAt: 1000000,
        priceChange: { h1: 5, h6: 10, h24: 20 },
      },
      {
        dexId: "pumpfun",
        volume: { h24: 540000, h1: 75000 },
        txns: { h24: { buys: 2000, sells: 1227 }, h1: { buys: 300, sells: 200 }, m5: { buys: 40, sells: 30 } },
        liquidity: { usd: 8689 },
        marketCap: 55000,
        pairCreatedAt: 1700000000000,
        priceChange: { h1: 90, h6: 150, h24: 300 },
      },
    ],
  };

  it("uses the highest-h24-volume pair and keeps the buy/sell split", () => {
    const s = parseDexScreenerResponse(response);
    expect(s).not.toBeNull();
    expect(s?.volumeH24).toBe(540000);
    expect(s?.volumeH1).toBe(75000);
    expect(s?.txnsH24).toBe(3227);
    expect(s?.liquidityUsd).toBe(8689);
    expect(s?.mcapUsd).toBe(55000);
    expect(s?.buysH1).toBe(300);
    expect(s?.sellsH1).toBe(200);
    expect(s?.buysM5).toBe(40);
    expect(s?.sellsM5).toBe(30);
    expect(s?.buysH24).toBe(2000);
    expect(s?.sellsH24).toBe(1227);
    expect(s?.pairCreatedAt).toBe(1700000000000);
    expect(s?.priceChangeH1Pct).toBe(90);
    expect(s?.priceChangeH6Pct).toBe(150);
    expect(s?.priceChangeH24Pct).toBe(300);
  });

  it("returns null when no pair carries an h24 volume", () => {
    expect(parseDexScreenerResponse({ pairs: [] })).toBeNull();
    expect(parseDexScreenerResponse({})).toBeNull();
    expect(parseDexScreenerResponse(null)).toBeNull();
    expect(parseDexScreenerResponse({ pairs: [{ volume: {} }] })).toBeNull();
  });

  it("missing txns windows are null, not zero — absence is explicit", () => {
    const s = parseDexScreenerResponse({ pairs: [{ volume: { h24: 1000 }, liquidity: { usd: 500 }, marketCap: 9000 }] });
    expect(s?.volumeH24).toBe(1000);
    expect(s?.buysH1).toBeNull();
    expect(s?.sellsH1).toBeNull();
    expect(s?.txnsH24).toBeNull();
    expect(s?.pairCreatedAt).toBeNull();
  });
});
