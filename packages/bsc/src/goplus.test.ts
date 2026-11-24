import { describe, expect, it } from "vitest";
import { goplusVerdict, parseGoPlusResult } from "./goplus.js";

// Real GoPlus payloads, fetched live 2026-11-24 ~12:48 SAST (trimmed
// to the fields the mapping reads).

const TAGENT_PREGRAD = {
  code: 1,
  message: "OK",
  result: {
    "0x1a88eb1eb9398d52b65999f8164bffff30bcffff": {
      is_honeypot: "0",
      buy_tax: "",
      sell_tax: "",
      transfer_tax: "",
      cannot_buy: "0",
      is_mintable: "0",
      hidden_owner: "0",
      is_proxy: "0",
      is_blacklisted: "0",
      is_in_dex: "0",
      is_open_source: "1",
      holder_count: "2",
      owner_address: "0x5c952063c7fc8610ffdb798152d69f0b9550762b",
      owner_percent: "1.0",
      creator_address: "0xe2a4a197330af51425f67206bb4b70a410c2a6bb",
      total_supply: "1000000000",
      transfer_pausable: "0",
    },
  },
};

const FORA_GRADUATED = {
  code: 1,
  message: "OK",
  result: {
    "0x82E852e5705d9F7d94f902244B5ffaFAac5B4444": {
      is_honeypot: "0",
      buy_tax: "0",
      sell_tax: "0",
      cannot_buy: "0",
      cannot_sell_all: "0",
      is_mintable: "0",
      hidden_owner: "0",
      is_proxy: "0",
      is_blacklisted: "0",
      is_in_dex: "1",
      holder_count: "343",
      lp_holder_count: "2",
      owner_address: "0x0000000000000000000000000000000000000000",
      creator_address: "0xeeefff8ce2710fa490e0fcb794235e873c252d2e",
      total_supply: "1000000000",
      transfer_pausable: "1",
    },
  },
};

describe("GoPlus mapping", () => {
  it("pre-graduation TAGENT: empty taxes and absent fields are null, not flags", () => {
    const sec = parseGoPlusResult("0x1a88eb1eb9398d52b65999f8164bffff30bcffff", TAGENT_PREGRAD);
    expect(sec).not.toBeNull();
    expect(sec!.isHoneypot).toBe(false);
    expect(sec!.buyTax).toBeNull();
    expect(sec!.sellTax).toBeNull();
    expect(sec!.cannotSellAll).toBeNull(); // absent pre-graduation
    expect(sec!.lpHolderCount).toBeNull(); // absent pre-graduation
    expect(sec!.holderCount).toBe(2);
    expect(sec!.isInDex).toBe(false);
    expect(goplusVerdict(sec!).verdict).toBe("pass");
  });

  it("graduated FORA: taxes 0, 343 holders, watch on transfer_pausable only", () => {
    const sec = parseGoPlusResult("0x82E852e5705d9F7d94f902244B5ffaFAac5B4444", FORA_GRADUATED);
    expect(sec).not.toBeNull();
    expect(sec!.buyTax).toBe(0);
    expect(sec!.sellTax).toBe(0);
    expect(sec!.cannotSellAll).toBe(false);
    expect(sec!.holderCount).toBe(343);
    expect(sec!.lpHolderCount).toBe(2);
    expect(sec!.isInDex).toBe(true);
    const v = goplusVerdict(sec!);
    expect(v.verdict).toBe("watch");
    expect(v.warned).toEqual(["transfer_pausable"]);
  });

  it("blocks honeypot, unsellable, cannot-buy, and >10% taxes", () => {
    const base = parseGoPlusResult("0x82E852e5705d9F7d94f902244B5ffaFAac5B4444", FORA_GRADUATED)!;
    expect(goplusVerdict({ ...base, isHoneypot: true }).verdict).toBe("block");
    expect(goplusVerdict({ ...base, cannotSellAll: true }).verdict).toBe("block");
    expect(goplusVerdict({ ...base, cannotBuy: true }).verdict).toBe("block");
    expect(goplusVerdict({ ...base, sellTax: 100 }).failed).toContain("sell_tax 100%");
    expect(goplusVerdict({ ...base, buyTax: 11 }).verdict).toBe("block");
    expect(goplusVerdict({ ...base, sellTax: 5 }).verdict).toBe("watch");
  });

  it("fail-closed: missing result, wrong code, or absent address parses to null", () => {
    expect(parseGoPlusResult("0xabc", { code: 1, result: {} })).toBeNull();
    expect(parseGoPlusResult("0xabc", { code: 0, result: {} })).toBeNull();
    expect(parseGoPlusResult("0xabc", {})).toBeNull();
    expect(parseGoPlusResult("0xabc", null)).toBeNull();
  });
});
