/**
 * Pricing for the BSC desk: DexScreener (BSC), Helper3 bonding-curve
 * reads, BNB price, and the PancakeSwap V2 quoter.
 *
 * All four sources verified live 2026-11-24 ~12:47-12:52 SAST:
 * - DexScreener GET /tokens/v1/bsc/<address>: pre-graduation tokens
 *   DO return a pair (dexId "fourmeme", priceNative/priceUsd/fdv/
 *   marketCap/txns, NO liquidity object). Graduated tokens return
 *   dexId "pancakeswap" with liquidity.usd. No holders field.
 * - Helper3 0xF251F83e40a78868FcfA3FA4599Dad6494E46034,
 *   getTokenInfo(address) selector 0x1f69565f, via eth_call on the
 *   public BSC RPC (eth_call works; eth_getLogs does NOT — public
 *   RPCs reject it with -32005). Returns 12 words; the decoded
 *   fields below cross-checked against DexScreener/GeckoTerminal:
 *   w3 price matched DexScreener priceNative EXACTLY for TAGENT
 *   (0.000000005835 BNB); w9 raised matched GeckoTerminal volume;
 *   w10 threshold 18.3 BNB ≈ $10,000 / $545 (the GitBook graduation
 *   figure); w11 graduated flag 0 pre-grad / 1 graduated (FORA).
 *   w7/w8 (remaining / sale supply) are the prober's best-fit
 *   labels, cross-checked only by magnitude (800,000,000 = 80% of
 *   the 1,000,000,000 supply). The desk uses w3/w9/w10/w11 only.
 *   w4/w5 (tradingFeeRate / minTradingFee) are decoded for the
 *   per-token fee model (see fees.ts): on every token sampled
 *   (TAGENT, 0xff5c…, 0x33b2…) the rate is 100 (= 1%) and the
 *   minimum is 0 — verified live via Helper3 tryBuy/trySell
 *   2026-11-24 ~20:35 SAST (see hidden_files/bsc-fee-flip-20261124.md):
 *   a $3.30 buy on 0xff5c… charged 0.0000593 BNB (0.99% of spend)
 *   and the sell of the received tokens charged the same
 *   (1.01% of proceeds) — exactly 1%, no 0.001 BNB floor.
 *   The GitBook still publishes a 0.001 BNB minimum; the contract
 *   disagrees, and the contract is what charges.
 * - BNB price: DexScreener WBNB (0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c)
 *   $545.22 (PancakeSwap, liquidity $8.5M); CoinGecko $545.42 same day.
 * - PancakeSwap V2 Router02 0x10ED43C718714eb63d5aA57B78B54704E256024E,
 *   getAmountsOut selector 0xd06ca61f: verified live for FORA —
 *   1,000,000 FORA quoted 0.052998 BNB out vs 0.0547 BNB naive
 *   (DexScreener price), i.e. impact + 0.25% fee as expected.
 */

const BSC_RPC = "https://bsc-dataseed.binance.org";
const HELPER3 = "0xF251F83e40a78868FcfA3FA4599Dad6494E46034";
const PANCAKE_ROUTER_V2 = "0x10ED43C718714eb63d5aA57B78B54704E256024E";
const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";

export interface DexBscPair {
  address: string;
  dexId: string;
  priceNativeBnb: number | null;
  priceUsd: number | null;
  marketCapUsd: number | null;
  fdvUsd: number | null;
  liquidityUsd: number | null;
  pairAddress: string | null;
  pairCreatedAtMs: number | null;
  txnsM5: { buys: number; sells: number };
  txnsH1: { buys: number; sells: number };
  txnsH6: { buys: number; sells: number };
  txnsH24: { buys: number; sells: number };
  /** v2: DexScreener USD volume per window. NULL when DexScreener
   * does not carry volume for the pair — pre-graduation four.meme
   * pairs return volume {} (only txns are populated). The volume
   * gates fail closed on null. */
  volM5Usd: number | null;
  volH1Usd: number | null;
  volH6Usd: number | null;
  volH24Usd: number | null;
  /** v2: DexScreener % price change per window (null when absent). */
  priceChangeM5Pct: number | null;
  priceChangeH1Pct: number | null;
  priceChangeH6Pct: number | null;
}

function toNum(v: unknown): number | null {
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return null;
}

function txns(v: unknown): { buys: number; sells: number } {
  const o = (v as { buys?: unknown; sells?: unknown }) ?? {};
  return {
    buys: typeof o.buys === "number" ? o.buys : 0,
    sells: typeof o.sells === "number" ? o.sells : 0,
  };
}

/** First pair in the DexScreener tokens response (null when none). */
export function parseDexTokensResponse(json: unknown, address: string): DexBscPair | null {
  if (!Array.isArray(json) || json.length === 0) return null;
  const p = json[0] as Record<string, unknown>;
  const tx = (p.txns as Record<string, unknown>) ?? {};
  const vol = (p.volume as Record<string, unknown>) ?? {};
  const pc = (p.priceChange as Record<string, unknown>) ?? {};
  return {
    address,
    dexId: typeof p.dexId === "string" ? p.dexId : "",
    priceNativeBnb: toNum(p.priceNative),
    priceUsd: toNum(p.priceUsd),
    marketCapUsd: toNum(p.marketCap),
    fdvUsd: toNum(p.fdv),
    liquidityUsd: toNum((p.liquidity as Record<string, unknown>)?.usd),
    pairAddress: typeof p.pairAddress === "string" ? p.pairAddress : null,
    pairCreatedAtMs: typeof p.pairCreatedAt === "number" ? p.pairCreatedAt : null,
    txnsM5: txns(tx.m5),
    txnsH1: txns(tx.h1),
    txnsH6: txns(tx.h6),
    txnsH24: txns(tx.h24),
    volM5Usd: toNum(vol.m5),
    volH1Usd: toNum(vol.h1),
    volH6Usd: toNum(vol.h6),
    volH24Usd: toNum(vol.h24),
    priceChangeM5Pct: toNum(pc.m5),
    priceChangeH1Pct: toNum(pc.h1),
    priceChangeH6Pct: toNum(pc.h6),
  };
}

export async function fetchDexPair(address: string, timeoutMs = 12000): Promise<DexBscPair | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch("https://api.dexscreener.com/tokens/v1/bsc/" + address, {
      signal: ctrl.signal,
      headers: { accept: "application/json", "user-agent": "SculGrok-bsc/0.1 paper-test" },
    });
    if (!res.ok) return null;
    return parseDexTokensResponse(await res.json(), address);
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

export async function fetchBnbPriceUsd(timeoutMs = 12000): Promise<number | null> {
  const pair = await fetchDexPair(WBNB, timeoutMs);
  return pair?.priceUsd ?? null;
}

export interface CurveInfo {
  version: number;
  tokenManager: string | null;
  /** Current bonding-curve price in BNB per token (w3, /1e18). */
  priceBnb: number | null;
  /** Trading fee rate from Helper3 (w4, RAW integer: 100 = 1%).
   * Null when the call result is malformed. The per-token fee
   * model trusts the Helper3 minimum only when this is exactly
   * 100 (classic launch) — any other rate means X-Mode / TaxToken
   * / a different schedule and falls back to 0.001 BNB. */
  tradingFeeRatePct: number | null;
  /** Per-token minimum trading fee in BNB (w5, /1e18). Null when
   * the call result is malformed. 0 on every classic token
   * sampled so far — the GitBook's 0.001 BNB minimum does not
   * hold on-chain (verified live via tryBuy/trySell). */
  minTradingFeeBnb: number | null;
  /** Tokens still offered on the curve (w7, /1e18). Best-fit label. */
  remainingTokens: number | null;
  /** Total sale supply on the curve (w8, /1e18). Best-fit label. */
  saleSupplyTokens: number | null;
  /** BNB raised so far (w9, /1e18). */
  raisedBnb: number | null;
  /** Graduation threshold in BNB (w10, /1e18). */
  thresholdBnb: number | null;
  /** Graduated flag (w11 == 1). */
  graduated: boolean | null;
}

function word(hex: string, i: number): bigint {
  return BigInt("0x" + hex.slice(2 + i * 64, 2 + (i + 1) * 64));
}

/** Decode a getTokenInfo eth_call result (12 x 32-byte words). */
export function decodeGetTokenInfo(hex: string): CurveInfo | null {
  if (typeof hex !== "string" || !hex.startsWith("0x") || hex.length < 2 + 12 * 64) return null;
  const scale = 10n ** 18n;
  const div = (w: bigint): number | null => {
    // Values above 2^53 lose integer precision; these are token/BNB
    // amounts where float precision is fine, but guard the absurd.
    if (w > 10n ** 30n) return null;
    return Number(w) / Number(scale);
  };
  const manager = "0x" + hex.slice(2 + 1 * 64 + 24, 2 + 2 * 64);
  // w4 is a raw integer rate (100 = 1%), NOT a /1e18 amount —
  // do not run it through div(). Guard the absurd.
  const rateWord = word(hex, 4);
  return {
    version: Number(word(hex, 0)),
    tokenManager: /^0x[0-9a-fA-F]{40}$/.test(manager) ? manager : null,
    priceBnb: div(word(hex, 3)),
    tradingFeeRatePct: rateWord <= 100000n ? Number(rateWord) : null,
    minTradingFeeBnb: div(word(hex, 5)),
    remainingTokens: div(word(hex, 7)),
    saleSupplyTokens: div(word(hex, 8)),
    raisedBnb: div(word(hex, 9)),
    thresholdBnb: div(word(hex, 10)),
    graduated: word(hex, 11) === 1n ? true : word(hex, 11) === 0n ? false : null,
  };
}

export function getTokenInfoCalldata(token: string): string {
  return "0x1f69565f" + token.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

async function rpcCall(method: string, params: unknown[], timeoutMs = 15000): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(BSC_RPC, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "content-type": "application/json", accept: "application/json", "user-agent": "SculGrok-bsc/0.1 paper-test" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { result?: unknown; error?: unknown };
    if (json.error) return null;
    return json.result ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

export async function fetchCurveInfo(token: string): Promise<CurveInfo | null> {
  const result = await rpcCall("eth_call", [{ to: HELPER3, data: getTokenInfoCalldata(token) }, "latest"]);
  if (typeof result !== "string") return null;
  return decodeGetTokenInfo(result);
}

function pad32hex(n: bigint): string {
  return n.toString(16).padStart(64, "0");
}

/** PancakeSwap V2 getAmountsOut quote for selling `amountTokens`
 * (in whole tokens, 18dp assumed — four.meme tokens are 18dp) into
 * WBNB. Returns the BNB out, or null when the call fails/reverts
 * (no route). */
export async function quotePancakeSell(token: string, amountTokens: number): Promise<number | null> {
  // Whole-token count first, then scale in bigint — the float
  // amountTokens x 1e18 would lose integer precision above 2^53.
  const wholeTokens = Math.floor(amountTokens);
  if (!(wholeTokens > 0)) return null;
  const amountIn = BigInt(wholeTokens) * 10n ** 18n;
  const data =
    "0xd06ca61f" +
    pad32hex(amountIn) +
    pad32hex(0x40n) +
    pad32hex(2n) +
    pad32hex(BigInt(token)) +
    pad32hex(BigInt(WBNB));
  const result = await rpcCall("eth_call", [{ to: PANCAKE_ROUTER_V2, data }, "latest"]);
  if (typeof result !== "string" || result.length < 2 + 2 * 64) return null;
  try {
    const out = BigInt("0x" + result.slice(2 + 64, 2 + 128));
    return Number(out) / 1e18;
  } catch {
    return null;
  }
}
