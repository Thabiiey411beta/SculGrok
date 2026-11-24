/**
 * GoPlus token_security (chain 56 = BSC) mapping for the BSC desk.
 *
 * Verified live 2026-11-24 ~12:48 SAST on two real tokens:
 * - Pre-graduation TAGENT 0x1a88eb1eb9398d52b65999f8164bffff30bcffff:
 *   is_honeypot "0", buy_tax/sell_tax/transfer_tax "" (empty — no tax
 *   data on the curve), cannot_sell_all ABSENT, lp_holder_count
 *   ABSENT, holders ABSENT, holder_count "2", is_mintable "0",
 *   hidden_owner "0", is_proxy "0", is_blacklisted "0",
 *   is_in_dex "0", owner_address = TokenManager2
 *   0x5c952063c7fc8610FFDB798152D69F0B9550762b at owner_percent 1.0.
 * - Graduated FORA 0x82E852e5705d9F7d94f902244B5ffaFAac5B4444:
 *   buy_tax "0", sell_tax "0", cannot_sell_all "0", holder_count
 *   "343", lp_holder_count "2", is_in_dex "1", dex[0] PancakeV2
 *   liquidity 8338.67 pool_fee 0.0025, transfer_pausable "1".
 *
 * Consequences baked into this mapping (do not "fix" them away):
 * - Pre-graduation, empty taxes / absent cannot_sell_all /
 *   holder_count 0-2 / TokenManager2 owning 100% are EXPECTED
 *   (the curve holds the supply; the platform fee is 1%, not a
 *   token tax). They are recorded as null / not flagged. Flagging
 *   them would block every pre-graduation token.
 * - GoPlus batch requests are UNRELIABLE: a 2-address batch returned
 *   only 1 result (verified live). Fetch one address per call.
 * - No GoPlus response at all (HTTP error, code != 1, address absent
 *   from result) is FAIL-CLOSED: parse returns null and the caller
 *   must block. Individual absent FIELDS are not missing data.
 *
 * Gate thresholds (v1): block on honeypot, cannot_sell_all,
 * cannot_buy, or any buy/sell tax > 10% (a 100% sell tax is
 * subsumed — it is also unsellable). Mintable / hidden owner /
 * proxy / blacklisted / pausable are WARNED (watch), never a block
 * in v1: they are real risks but unvalidated as entry predictors on
 * this desk, and blocking on them pre-graduation would need a
 * replay the desk does not have yet.
 */

export interface GoPlusSecurity {
  address: string;
  isHoneypot: boolean | null;
  buyTax: number | null;
  sellTax: number | null;
  cannotBuy: boolean | null;
  cannotSellAll: boolean | null;
  isMintable: boolean | null;
  hiddenOwner: boolean | null;
  isProxy: boolean | null;
  isBlacklisted: boolean | null;
  isInDex: boolean | null;
  transferPausable: boolean | null;
  holderCount: number | null;
  lpHolderCount: number | null;
  ownerAddress: string | null;
  creatorAddress: string | null;
  totalSupply: string | null;
}

export type GoPlusVerdict = "pass" | "watch" | "block";

function parseBool(v: unknown): boolean | null {
  if (v === "1") return true;
  if (v === "0") return false;
  return null;
}

function parseTax(v: unknown): number | null {
  if (typeof v !== "string" || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseCount(v: unknown): number | null {
  if (typeof v !== "string" || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Parse one GoPlus result entry. Returns null when the entry is
 * absent — the caller treats null as "no data, block". */
export function parseGoPlusResult(address: string, json: unknown): GoPlusSecurity | null {
  const result = (json as { result?: Record<string, Record<string, unknown>> })?.result;
  if (!result || typeof result !== "object") return null;
  const key = Object.keys(result).find((k) => k.toLowerCase() === address.toLowerCase());
  if (!key) return null;
  const r = result[key];
  return {
    address,
    isHoneypot: parseBool(r.is_honeypot),
    buyTax: parseTax(r.buy_tax),
    sellTax: parseTax(r.sell_tax),
    cannotBuy: parseBool(r.cannot_buy),
    cannotSellAll: parseBool(r.cannot_sell_all),
    isMintable: parseBool(r.is_mintable),
    hiddenOwner: parseBool(r.hidden_owner),
    isProxy: parseBool(r.is_proxy),
    isBlacklisted: parseBool(r.is_blacklisted),
    isInDex: parseBool(r.is_in_dex),
    transferPausable: parseBool(r.transfer_pausable),
    holderCount: parseCount(r.holder_count),
    lpHolderCount: parseCount(r.lp_holder_count),
    ownerAddress: typeof r.owner_address === "string" ? r.owner_address : null,
    creatorAddress: typeof r.creator_address === "string" ? r.creator_address : null,
    totalSupply: typeof r.total_supply === "string" ? r.total_supply : null,
  };
}

/** Hard gate mapping. failed = blocks, warned = watch flags. */
export function goplusVerdict(sec: GoPlusSecurity): { verdict: GoPlusVerdict; failed: string[]; warned: string[] } {
  const failed: string[] = [];
  const warned: string[] = [];
  if (sec.isHoneypot === true) failed.push("honeypot");
  if (sec.cannotSellAll === true) failed.push("cannot_sell_all");
  if (sec.cannotBuy === true) failed.push("cannot_buy");
  if (sec.sellTax !== null && sec.sellTax > 10) failed.push(`sell_tax ${sec.sellTax}%`);
  if (sec.buyTax !== null && sec.buyTax > 10) failed.push(`buy_tax ${sec.buyTax}%`);
  if (sec.isMintable === true) warned.push("mintable");
  if (sec.hiddenOwner === true) warned.push("hidden_owner");
  if (sec.isProxy === true) warned.push("proxy");
  if (sec.isBlacklisted === true) warned.push("blacklisted");
  if (sec.transferPausable === true) warned.push("transfer_pausable");
  if (sec.sellTax !== null && sec.sellTax > 0 && sec.sellTax <= 10) warned.push(`sell_tax ${sec.sellTax}%`);
  if (sec.buyTax !== null && sec.buyTax > 0 && sec.buyTax <= 10) warned.push(`buy_tax ${sec.buyTax}%`);
  return { verdict: failed.length > 0 ? "block" : warned.length > 0 ? "watch" : "pass", failed, warned };
}

export async function fetchGoPlus(address: string, timeoutMs = 12000): Promise<GoPlusSecurity | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(
      "https://api.gopluslabs.io/api/v1/token_security/56?contract_addresses=" + address,
      { signal: ctrl.signal, headers: { accept: "application/json", "user-agent": "SculGrok-bsc/0.1 paper-test" } },
    );
    if (!res.ok) return null;
    const json = (await res.json()) as { code?: number };
    if (json.code !== 1) return null;
    return parseGoPlusResult(address, json);
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}
