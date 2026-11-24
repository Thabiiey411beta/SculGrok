import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendWsQueueEntry,
  handleWsMessage,
  isWsStale,
  loadWsQueue,
  mergeWsCoins,
  nextBackoffMs,
  parsePumpPortalCreate,
  parseWsQueueEntry,
  pruneWsQueueFile,
  WS_MERGE_MAX_AGE_MS,
  wsCoinToPumpCoin,
  type WsNewCoin,
} from "./ws-queue.js";
import type { PumpCoin } from "./spotter.js";

const MINT_A = "zZ8C2Mcr39RaAU7xVKE6cfnFd7oeucRJFi3jyPspump";
const MINT_B = "8WiK2Bp1JoTpvUdxJdpMPij5d6QV2yg7giZRGdBCpump";
const CREATOR = "Creator1111111111111111111111111111111111";
const NOW = 1795460000000;

function createEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    txType: "create",
    signature: "sig111",
    mint: MINT_A,
    traderPublicKey: CREATOR,
    name: "Test Coin",
    symbol: "TST",
    uri: "https://example.invalid/meta.json",
    marketCapSol: 2.5, bondingCurveKey: "2q7x2Nk4TyNkdRwYnzTcdRRgx6t1wrHVccQDbmCeriJA",
    timestamp: 1795459990, // seconds
    ...overrides,
  };
}

function pumpCoin(overrides: Partial<PumpCoin> = {}): PumpCoin {
  return {
    mint: MINT_A,
    name: "Test",
    symbol: "TST",
    creator: CREATOR,
    created_timestamp: NOW - 60000,
    last_trade_timestamp: NOW - 10000,
    usd_market_cap: 5000,
    complete: false,
    associated_bonding_curve: "",
    bonding_curve: "",
    ...overrides,
  };
}

describe("parsePumpPortalCreate", () => {
  it("parses a valid create event, seconds timestamp to ms", () => {
    const e = parsePumpPortalCreate(createEvent(), NOW);
    expect(e).not.toBeNull();
    expect(e!.mint).toBe(MINT_A);
    expect(e!.creator).toBe(CREATOR);
    expect(e!.name).toBe("Test Coin");
    expect(e!.marketCapSol).toBe(2.5);
    expect(e!.createdAtMs).toBe(1795459990000);
    expect(e!.firstSeenMs).toBe(NOW);
    expect(e!.txType).toBe("create");
  });

  it("accepts create_v2", () => {
    expect(parsePumpPortalCreate(createEvent({ txType: "create_v2" }), NOW)?.txType).toBe("create_v2");
  });

  it("rejects trade and migration events", () => {
    expect(parsePumpPortalCreate(createEvent({ txType: "buy" }), NOW)).toBeNull();
    expect(parsePumpPortalCreate(createEvent({ txType: "migration" }), NOW)).toBeNull();
  });

  it("rejects missing / short / non-string mint", () => {
    expect(parsePumpPortalCreate(createEvent({ mint: undefined }), NOW)).toBeNull();
    expect(parsePumpPortalCreate(createEvent({ mint: "short" }), NOW)).toBeNull();
    expect(parsePumpPortalCreate(createEvent({ mint: 123 }), NOW)).toBeNull();
    expect(parsePumpPortalCreate(null, NOW)).toBeNull();
    expect(parsePumpPortalCreate("not an object", NOW)).toBeNull();
  });

  it("falls back to nowMs on a missing timestamp, tolerates ms", () => {
    const noTs = createEvent();
    delete noTs.timestamp;
    expect(parsePumpPortalCreate(noTs, NOW)?.createdAtMs).toBe(NOW);
    expect(parsePumpPortalCreate(createEvent({ timestamp: 1795459990000 }), NOW)?.createdAtMs).toBe(
      1795459990000,
    );
  });

  it("parses the live shape: no timestamp field, bondingCurveKey carried", () => {
    // Verified by a 60s raw probe 2026-11-23: live create events carry
    // no timestamp, so createdAtMs is receipt time (first-seen).
    const live = createEvent({ bondingCurveKey: "2q7x2Nk4TyNkdRwYnzTcdRRgx6t1wrHVccQDbmCeriJA" });
    delete live.timestamp;
    const e = parsePumpPortalCreate(live, NOW);
    expect(e).not.toBeNull();
    expect(e!.createdAtMs).toBe(NOW);
    expect(e!.firstSeenMs).toBe(NOW);
    expect(e!.bondingCurveKey).toBe("2q7x2Nk4TyNkdRwYnzTcdRRgx6t1wrHVccQDbmCeriJA");
    expect(wsCoinToPumpCoin(e!, 73).bonding_curve).toBe(
      "2q7x2Nk4TyNkdRwYnzTcdRRgx6t1wrHVccQDbmCeriJA",
    );
  });

  it("nulls a missing or negative marketCapSol", () => {
    const noMc = createEvent();
    delete noMc.marketCapSol;
    expect(parsePumpPortalCreate(noMc, NOW)?.marketCapSol).toBeNull();
    expect(parsePumpPortalCreate(createEvent({ marketCapSol: -1 }), NOW)?.marketCapSol).toBeNull();
  });

  it("defaults missing name/symbol/creator to empty strings", () => {
    const e = parsePumpPortalCreate(createEvent({ name: undefined, symbol: undefined, traderPublicKey: undefined }), NOW);
    expect(e!.name).toBe("");
    expect(e!.symbol).toBe("");
    expect(e!.creator).toBe("");
  });
});

describe("wsCoinToPumpCoin", () => {
  it("converts marketCapSol with the poll SOL price and starts trade age at creation", () => {
    const entry: WsNewCoin = {
      mint: MINT_A,
      name: "Test",
      symbol: "TST",
      creator: CREATOR,
      marketCapSol: 2.5, bondingCurveKey: "2q7x2Nk4TyNkdRwYnzTcdRRgx6t1wrHVccQDbmCeriJA",
      createdAtMs: NOW - 60000,
      firstSeenMs: NOW - 5000,
      signature: "sig",
      txType: "create",
    };
    const coin = wsCoinToPumpCoin(entry, 73);
    expect(coin.usd_market_cap).toBeCloseTo(182.5);
    expect(coin.created_timestamp).toBe(NOW - 60000);
    expect(coin.last_trade_timestamp).toBe(NOW - 60000);
    expect(coin.complete).toBe(false);
    expect(coin.bonding_curve).toBe("2q7x2Nk4TyNkdRwYnzTcdRRgx6t1wrHVccQDbmCeriJA");
  });

  it("zero mc when marketCapSol is missing", () => {
    const entry: WsNewCoin = {
      mint: MINT_A,
      name: "",
      symbol: "",
      creator: "",
      marketCapSol: null, bondingCurveKey: "",
      createdAtMs: NOW - 1000,
      firstSeenMs: NOW,
      signature: "",
      txType: "create",
    };
    expect(wsCoinToPumpCoin(entry, 73).usd_market_cap).toBe(0);
  });
});

describe("queue file", () => {
  function tmpQueue(): string {
    return join(mkdtempSync(join(tmpdir(), "ws-queue-")), "ws-new-coins.jsonl");
  }

  it("append + load roundtrip, dedupe keeps earliest firstSeen", () => {
    const path = tmpQueue();
    const a: WsNewCoin = { mint: MINT_A, name: "A", symbol: "A", creator: CREATOR, marketCapSol: 1, bondingCurveKey: "", createdAtMs: NOW - 60000, firstSeenMs: NOW - 5000, signature: "s1", txType: "create" };
    const b: WsNewCoin = { ...a, firstSeenMs: NOW - 1000, signature: "s2" };
    appendWsQueueEntry(path, a);
    appendWsQueueEntry(path, b);
    const loaded = loadWsQueue(path, NOW);
    expect(loaded.entries).toHaveLength(1);
    expect(loaded.entries[0].firstSeenMs).toBe(NOW - 5000);
    expect(loaded.skipped).toBe(0);
  });

  it("prunes entries older than 24h and skips malformed lines", () => {
    const path = tmpQueue();
    const old: WsNewCoin = { mint: MINT_A, name: "Old", symbol: "O", creator: "", marketCapSol: null, bondingCurveKey: "", createdAtMs: NOW - 25 * 60 * 60 * 1000, firstSeenMs: NOW - 25 * 60 * 60 * 1000, signature: "", txType: "create" };
    const fresh: WsNewCoin = { mint: MINT_B, name: "Fresh", symbol: "F", creator: "", marketCapSol: 2, bondingCurveKey: "", createdAtMs: NOW - 60000, firstSeenMs: NOW - 1000, signature: "", txType: "create" };
    appendWsQueueEntry(path, old);
    appendWsQueueEntry(path, fresh);
    appendFileSync(path, "not json\n");
    const loaded = loadWsQueue(path, NOW);
    expect(loaded.entries).toHaveLength(1);
    expect(loaded.entries[0].mint).toBe(MINT_B);
    expect(loaded.skipped).toBe(1);
  });

  it("missing file loads as an empty queue", () => {
    expect(loadWsQueue(join(tmpdir(), "ws-queue-does-not-exist.jsonl"), NOW)).toEqual({
      entries: [],
      skipped: 0,
    });
  });

  it("pruneWsQueueFile rewrites the file dropping old and duplicate entries", () => {
    const path = tmpQueue();
    const old: WsNewCoin = { mint: MINT_A, name: "Old", symbol: "O", creator: "", marketCapSol: null, bondingCurveKey: "", createdAtMs: NOW - 25 * 60 * 60 * 1000, firstSeenMs: NOW - 25 * 60 * 60 * 1000, signature: "", txType: "create" };
    const fresh: WsNewCoin = { mint: MINT_B, name: "Fresh", symbol: "F", creator: "", marketCapSol: 2, bondingCurveKey: "", createdAtMs: NOW - 60000, firstSeenMs: NOW - 1000, signature: "", txType: "create" };
    appendWsQueueEntry(path, old);
    appendWsQueueEntry(path, fresh);
    appendWsQueueEntry(path, fresh);
    expect(pruneWsQueueFile(path, NOW)).toBe(1);
    expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("parseWsQueueEntry keeps the stored firstSeenMs", () => {
    const e = parseWsQueueEntry({ mint: MINT_A, createdAtMs: NOW - 60000, firstSeenMs: NOW - 5000 }, NOW);
    expect(e?.firstSeenMs).toBe(NOW - 5000);
    expect(parseWsQueueEntry({ mint: "short" }, NOW)).toBeNull();
  });
});

describe("mergeWsCoins", () => {
  it("adds WS-only mints and counts them", () => {
    const ws = wsCoinToPumpCoin(
      { mint: MINT_B, name: "B", symbol: "B", creator: CREATOR, marketCapSol: 1, bondingCurveKey: "", createdAtMs: NOW - 60000, firstSeenMs: NOW - 1000, signature: "", txType: "create" },
      73,
    );
    const merged = mergeWsCoins([pumpCoin()], [ws]);
    expect(merged.coins).toHaveLength(2);
    expect(merged.wsNewCount).toBe(1);
  });

  it("tags WS-only coins discoveredVia ws", () => {
    const ws = wsCoinToPumpCoin(
      { mint: MINT_B, name: "B", symbol: "B", creator: CREATOR, marketCapSol: 1, bondingCurveKey: "", createdAtMs: NOW - 60000, firstSeenMs: NOW - 1000, signature: "", txType: "create" },
      73,
    );
    expect(ws.discoveredVia).toBe("ws");
    const merged = mergeWsCoins([pumpCoin()], [ws]);
    expect(merged.coins.find((c) => c.mint === MINT_B)?.discoveredVia).toBe("ws");
  });

  it("a poll+WS duplicate stays a poll coin (no ws tag)", () => {
    const poll = pumpCoin({ creator: "", created_timestamp: NOW - 30000, usd_market_cap: 9000 });
    const ws = wsCoinToPumpCoin(
      { mint: MINT_A, name: "A", symbol: "A", creator: CREATOR, marketCapSol: 1, bondingCurveKey: "", createdAtMs: NOW - 120000, firstSeenMs: NOW - 1000, signature: "", txType: "create" },
      73,
    );
    const merged = mergeWsCoins([poll], [ws]);
    expect(merged.coins).toHaveLength(1);
    // Poll row wins: the merged coin carries no WS tag, so it
    // resolves to "poll" in discoverySource.
    expect(merged.coins[0].discoveredVia).toBeUndefined();
  });

  it("on overlap the poll row wins for price, WS wins for earlier creation and fills a missing creator", () => {
    const poll = pumpCoin({ creator: "", created_timestamp: NOW - 30000, usd_market_cap: 9000 });
    const ws = wsCoinToPumpCoin(
      { mint: MINT_A, name: "A", symbol: "A", creator: CREATOR, marketCapSol: 1, bondingCurveKey: "", createdAtMs: NOW - 120000, firstSeenMs: NOW - 1000, signature: "", txType: "create" },
      73,
    );
    const merged = mergeWsCoins([poll], [ws]);
    expect(merged.coins).toHaveLength(1);
    expect(merged.coins[0].usd_market_cap).toBe(9000);
    expect(merged.coins[0].created_timestamp).toBe(NOW - 120000);
    expect(merged.coins[0].creator).toBe(CREATOR);
    expect(merged.wsNewCount).toBe(0);
  });

  it("keeps the poll creator when present", () => {
    const ws = wsCoinToPumpCoin(
      { mint: MINT_A, name: "A", symbol: "A", creator: "OTHER11111111111111111111111111111111", marketCapSol: 1, bondingCurveKey: "", createdAtMs: NOW - 120000, firstSeenMs: NOW - 1000, signature: "", txType: "create" },
      73,
    );
    expect(mergeWsCoins([pumpCoin()], [ws]).coins[0].creator).toBe(CREATOR);
  });
});

describe("nextBackoffMs", () => {
  it("climbs 1s, 2s, 5s, 10s, 30s then caps at 60s", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 99].map(nextBackoffMs)).toEqual([
      1000, 2000, 5000, 10000, 30000, 60000, 60000, 60000,
    ]);
  });
});

describe("isWsStale", () => {
  it("false at exactly the stale window, true one ms past it", () => {
    expect(isWsStale(NOW - 10 * 60 * 1000, NOW)).toBe(false);
    expect(isWsStale(NOW - 10 * 60 * 1000 - 1, NOW)).toBe(true);
  });
});

describe("handleWsMessage", () => {
  function tmpQueue(): string {
    return join(mkdtempSync(join(tmpdir(), "ws-queue-")), "ws-new-coins.jsonl");
  }

  it("appends a create, dedupes the repeat, ignores trades, flags bad JSON", () => {
    const path = tmpQueue();
    const seen = new Map<string, number>();
    expect(handleWsMessage(JSON.stringify(createEvent()), path, seen, NOW)).toBe("appended");
    expect(handleWsMessage(JSON.stringify(createEvent()), path, seen, NOW)).toBe("duplicate");
    expect(handleWsMessage(JSON.stringify(createEvent({ txType: "buy" })), path, seen, NOW)).toBe("ignored");
    expect(handleWsMessage("{not json", path, seen, NOW)).toBe("malformed");
    expect(loadWsQueue(path, NOW).entries).toHaveLength(1);
  });

  it("creates the queue directory on first append", () => {
    const dir = mkdtempSync(join(tmpdir(), "ws-queue-"));
    const path = join(dir, "nested", "ws-new-coins.jsonl");
    const seen = new Map<string, number>();
    expect(handleWsMessage(JSON.stringify(createEvent()), path, seen, NOW)).toBe("appended");
    expect(loadWsQueue(path, NOW).entries).toHaveLength(1);
  });
});

describe("WS_MERGE_MAX_AGE_MS", () => {
  it("is 15 minutes, matching the candidate tradeAgeMin window", () => {
    expect(WS_MERGE_MAX_AGE_MS).toBe(15 * 60 * 1000);
  });
});
