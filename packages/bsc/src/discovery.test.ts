import { describe, expect, it } from "vitest";
import { parseNewPools } from "./discovery.js";

// Real GeckoTerminal new_pools entries, fetched live 2026-11-24
// ~12:47 SAST (attributes trimmed to the fields the parser reads).
const GT_PAGE = {
  data: [
    {
      id: "bsc_0x1234",
      attributes: {
        name: "TAGENT / BNB",
        pool_created_at: "2026-11-24T10:40:50Z",
        fdv_usd: "3217.728695",
        base_token_price_usd: "0.000003217728695",
        base_token_price_native_currency: "0.00000000589381550655309",
      },
      relationships: {
        dex: { data: { id: "four-meme", type: "dex" } },
        base_token: { data: { id: "bsc_0x1a88eb1eb9398d52b65999f8164bffff30bcffff", type: "token" } },
      },
    },
    {
      id: "bsc_0x5678",
      attributes: {
        name: "SomeCoin / BNB",
        pool_created_at: "2026-11-24T10:44:00Z",
        fdv_usd: "99999",
        base_token_price_usd: "0.001",
        base_token_price_native_currency: "0.000001",
      },
      relationships: {
        dex: { data: { id: "pancakeswap_v2", type: "dex" } },
        base_token: { data: { id: "bsc_0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", type: "token" } },
      },
    },
    {
      id: "bsc_0x9abc",
      attributes: {
        name: "好币 / BNB",
        pool_created_at: "2026-11-24T10:42:49Z",
        fdv_usd: "3214.781745",
        base_token_price_usd: "0.000003214781745",
        base_token_price_native_currency: "0.000000005835",
      },
      relationships: {
        dex: { data: { id: "four-meme", type: "dex" } },
        base_token: { data: { id: "bsc_0x2544d5f064d30a6b69a2e2dcd72f2342141cffff", type: "token" } },
      },
    },
  ],
};

describe("GeckoTerminal new_pools parsing", () => {
  it("keeps four-meme pools only, strips the bsc_ prefix, parses symbol and fdv", () => {
    const out = parseNewPools(GT_PAGE);
    expect(out).toHaveLength(2);
    expect(out[0].address).toBe("0x1a88eb1eb9398d52b65999f8164bffff30bcffff");
    expect(out[0].symbol).toBe("TAGENT");
    expect(out[0].fdvUsd).toBeCloseTo(3217.73, 2);
    expect(out[0].createdAtMs).toBe(Date.parse("2026-11-24T10:40:50Z"));
    expect(out[1].symbol).toBe("好币");
  });

  it("returns [] on a missing or malformed payload", () => {
    expect(parseNewPools({})).toEqual([]);
    expect(parseNewPools(null)).toEqual([]);
    expect(parseNewPools({ data: "nope" })).toEqual([]);
  });

  it("filters by dex id: pancakeswap_v2 keeps PCS pools only", () => {
    const out = parseNewPools(GT_PAGE, "pancakeswap_v2");
    expect(out).toHaveLength(1);
    expect(out[0].symbol).toBe("SomeCoin");
  });

  it("carries the GeckoTerminal volume/trader snapshot when present", () => {
    const page = {
      data: [
        {
          id: "bsc_0x9999",
          attributes: {
            name: "HOT / BNB",
            pool_created_at: "2026-11-24T15:30:00Z",
            fdv_usd: "35049",
            base_token_price_usd: "0.000035",
            base_token_price_native_currency: "0.000000064",
            volume_usd: { m5: "62454.07", h1: "67721.49", h24: "67721.49" },
            transactions: { m5: { buys: 100, sells: 90, buyers: 80, sellers: 70 }, h1: { buys: 715, sells: 740, buyers: 320, sellers: 294 } },
            price_change_percentage: { m5: "12.5", h1: "45.2" },
          },
          relationships: {
            dex: { data: { id: "pancakeswap_v2", type: "dex" } },
            base_token: { data: { id: "bsc_0x3d0854e0704f2cb1580d7bf3b6dc28682e487777", type: "token" } },
          },
        },
      ],
    };
    const out = parseNewPools(page, "pancakeswap_v2");
    expect(out).toHaveLength(1);
    expect(out[0].volM5Usd).toBeCloseTo(62454.07, 2);
    expect(out[0].volH1Usd).toBeCloseTo(67721.49, 2);
    expect(out[0].tradersH1).toBe(614); // buyers + sellers
    expect(out[0].buysH1).toBe(715);
    expect(out[0].sellsH1).toBe(740);
    expect(out[0].priceChangeH1Pct).toBeCloseTo(45.2, 6);
  });

  it("snapshot fields are null when GeckoTerminal does not carry them", () => {
    const out = parseNewPools(GT_PAGE);
    expect(out[0].volM5Usd).toBeNull();
    expect(out[0].tradersH1).toBeNull();
  });
});
