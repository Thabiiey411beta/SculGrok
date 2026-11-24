import { describe, expect, it } from "vitest";
import { decodeGetTokenInfo, getTokenInfoCalldata, parseDexTokensResponse } from "./pricing.js";

// Real Helper3 getTokenInfo eth_call result for TAGENT
// 0x1a88eb1eb9398d52b65999f8164bffff30bcffff, fetched live
// 2026-11-24 ~12:51 SAST.
const TAGENT_CURVE_HEX =
  "0x00000000000000000000000000000000000000000000000000000000000000020000000000000000000000005c952063c7fc8610ffdb798152d69f0b9550762b0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000015bd2198200000000000000000000000000000000000000000000000000000000000000640000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000295be83a4f33c51a878700000000000000000000000000000000000000000000295be96e640669720000000000000000000000000000000000000000000000000000000000001e297a59005000000000000000000000000000000000000000000000000fdf6a90adda600000000000000000000000000000000000000000000000000000000000000000000";

// Real DexScreener tokens/v1/bsc response for TAGENT (trimmed),
// fetched live 2026-11-24 ~12:47 SAST.
const TAGENT_DEX = [
  {
    dexId: "fourmeme",
    priceNative: "0.000000005835",
    priceUsd: "0.000003185",
    fdv: 3185.52,
    marketCap: 3185.52,
    liquidity: null,
    pairAddress: "0x2544d5f064d30a6b69a2e2dcd72f2342141cffff",
    pairCreatedAt: 1795516850000,
    txns: { m5: { buys: 0, sells: 0 }, h1: { buys: 1, sells: 0 }, h6: { buys: 1, sells: 0 }, h24: { buys: 1, sells: 0 } },
  },
];

describe("Helper3 getTokenInfo decoding", () => {
  it("decodes the real TAGENT call: price, raised, threshold, not graduated", () => {
    const c = decodeGetTokenInfo(TAGENT_CURVE_HEX);
    expect(c).not.toBeNull();
    expect(c!.version).toBe(2);
    expect(c!.tokenManager).toBe("0x5c952063c7fc8610ffdb798152d69f0b9550762b");
    // w3: 5,835,463,042 wei = 0.000000005835463042 BNB — the full
    // precision value matches DexScreener priceNative (0.000000005835).
    expect(c!.priceBnb).toBeCloseTo(5.835463042e-9, 18);
    expect(c!.raisedBnb).toBeCloseTo(2.072718446597e-6, 18);
    expect(c!.thresholdBnb).toBeCloseTo(18.3, 10);
    expect(c!.graduated).toBe(false);
    expect(c!.saleSupplyTokens).toBeCloseTo(800000000, 0);
    // Fee flip (2026-11-24): w4 = 100 (1% rate), w5 = 0 (no minimum).
    expect(c!.tradingFeeRatePct).toBe(100);
    expect(c!.minTradingFeeBnb).toBe(0);
  });

  it("returns null on a short or malformed result", () => {
    expect(decodeGetTokenInfo("0x1234")).toBeNull();
    expect(decodeGetTokenInfo("not hex")).toBeNull();
  });

  it("builds the getTokenInfo calldata with selector 0x1f69565f", () => {
    expect(getTokenInfoCalldata("0x1a88eb1eb9398d52b65999f8164bffff30bcffff")).toBe(
      "0x1f69565f0000000000000000000000001a88eb1eb9398d52b65999f8164bffff30bcffff",
    );
  });
});

describe("DexScreener BSC parsing", () => {
  it("parses the real TAGENT pair: fourmeme, no liquidity, txns present", () => {
    const p = parseDexTokensResponse(TAGENT_DEX, "0x1a88eb1eb9398d52b65999f8164bffff30bcffff");
    expect(p).not.toBeNull();
    expect(p!.dexId).toBe("fourmeme");
    expect(p!.priceNativeBnb).toBeCloseTo(0.000000005835, 15);
    expect(p!.priceUsd).toBeCloseTo(0.000003185, 9);
    expect(p!.marketCapUsd).toBeCloseTo(3185.52, 2);
    expect(p!.liquidityUsd).toBeNull();
    expect(p!.txnsH1).toEqual({ buys: 1, sells: 0 });
    expect(p!.txnsM5).toEqual({ buys: 0, sells: 0 });
  });

  it("returns null when DexScreener has no pair", () => {
    expect(parseDexTokensResponse([], "0xabc")).toBeNull();
    expect(parseDexTokensResponse(null, "0xabc")).toBeNull();
  });

  it("parses volume + priceChange on a graduated pair; nulls on a pre-grad pair", () => {
    // Real LGU (graduated) tokens/v1 shape, fetched live 2026-11-24 ~15:23 SAST.
    const lgu = [
      {
        dexId: "pancakeswap",
        priceNative: "0.0000000066",
        priceUsd: "0.0000036",
        fdv: 3713,
        marketCap: 3713,
        liquidity: { usd: 6900.62 },
        pairAddress: "0xpair",
        pairCreatedAt: 1795526333000,
        txns: { m5: { buys: 6, sells: 1 }, h1: { buys: 6, sells: 1 }, h6: { buys: 6, sells: 1 }, h24: { buys: 6, sells: 1 } },
        volume: { m5: 268.61, h1: 268.61, h6: 268.61, h24: 268.61 },
        priceChange: { m5: 11.66, h1: 11.66, h6: 11.66, h24: 11.66 },
      },
    ];
    const p = parseDexTokensResponse(lgu, "0x9bad36d7e3cd41449055d11734cc58f7fd22b074");
    expect(p).not.toBeNull();
    expect(p!.volM5Usd).toBeCloseTo(268.61, 2);
    expect(p!.volH1Usd).toBeCloseTo(268.61, 2);
    expect(p!.priceChangeH1Pct).toBeCloseTo(11.66, 2);
    expect(p!.liquidityUsd).toBeCloseTo(6900.62, 2);
    // TAGENT (pre-grad): volume/priceChange absent -> null (fail-closed in v2).
    const t = parseDexTokensResponse(TAGENT_DEX, "0x1a88eb1eb9398d52b65999f8164bffff30bcffff");
    expect(t!.volM5Usd).toBeNull();
    expect(t!.volH1Usd).toBeNull();
    expect(t!.priceChangeH1Pct).toBeNull();
  });
});
