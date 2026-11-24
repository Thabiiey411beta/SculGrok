/**
 * Discovery for the BSC desk: GeckoTerminal new_pools (BSC), filtered
 * to four.meme.
 *
 * Why GeckoTerminal and not four.meme's own API: the four.meme REST
 * list (doc-verified POST /v1/public/token/search on
 * https://four.meme/meme-api) returns HTTP 403 Cloudflare geo-block
 * ("Due to your current location, access to our services is
 * restricted") from this VM on every path, GET and POST. The live
 * browser (non-blocked egress) could confirm it; this desk cannot
 * use it. eth_getLogs for TokenCreate events is also unusable here:
 * every public BSC RPC rejects it (-32005 limit exceeded, even for a
 * 1-block range). GeckoTerminal new_pools is the verified working
 * no-key discovery path (fetched live 2026-11-24 ~12:47 SAST: 20
 * pools/page, 8 four-meme on page 1).
 *
 * Response shape (verified): data[] entries carry
 * relationships.dex.data.id ("four-meme" / "pancakeswap_v2" / ...),
 * relationships.base_token.data.id ("bsc_0x..."), and attributes
 * { name ("SYMBOL / BNB"), pool_created_at, fdv_usd,
 * base_token_price_usd, base_token_price_native_currency,
 * transactions, volume_usd }. market_cap_usd is null for fresh
 * four.meme pools (fdv_usd is populated). Names repeat across
 * distinct tokens — the address is the identity, never the name.
 */

export interface BscCandidate {
  address: string;
  name: string;
  symbol: string;
  poolAddress: string;
  createdAtMs: number;
  fdvUsd: number | null;
  priceUsd: number | null;
  priceNativeBnb: number | null;
  /** v2: GeckoTerminal snapshot carried from discovery (no extra
   * call). volume_usd / transactions.h1 / price_change_percentage
   * from the new_pools attributes. Null when the pool does not
   * carry the field. These are the volume gates' breadth inputs;
   * DexScreener volume (pricing.ts) is the primary volume source. */
  volM5Usd: number | null;
  volH1Usd: number | null;
  tradersH1: number | null;
  buysH1: number | null;
  sellsH1: number | null;
  priceChangeH1Pct: number | null;
}

function toNum(v: unknown): number | null {
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return null;
}

export function parseNewPools(json: unknown, dexId = "four-meme"): BscCandidate[] {
  const data = (json as { data?: unknown[] })?.data;
  if (!Array.isArray(data)) return [];
  const out: BscCandidate[] = [];
  for (const p of data) {
    const entry = p as {
      id?: string;
      attributes?: Record<string, unknown>;
      relationships?: { dex?: { data?: { id?: string } }; base_token?: { data?: { id?: string } } };
    };
    if (entry.relationships?.dex?.data?.id !== dexId) continue;
    const baseId = entry.relationships?.base_token?.data?.id ?? "";
    const address = baseId.startsWith("bsc_") ? baseId.slice(4) : baseId;
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) continue;
    const name = typeof entry.attributes?.name === "string" ? entry.attributes.name : "";
    const symbol = name.includes(" / ") ? name.split(" / ")[0] : name;
    const created = typeof entry.attributes?.pool_created_at === "string" ? Date.parse(entry.attributes.pool_created_at) : NaN;
    const vol = (entry.attributes?.volume_usd as Record<string, unknown>) ?? {};
    const txH1 = ((entry.attributes?.transactions as Record<string, unknown>)?.h1 as Record<string, unknown>) ?? {};
    const pc = (entry.attributes?.price_change_percentage as Record<string, unknown>) ?? {};
    const buyers = toNum(txH1.buyers);
    const sellers = toNum(txH1.sellers);
    out.push({
      address,
      name,
      symbol,
      poolAddress: typeof entry.id === "string" ? entry.id : "",
      createdAtMs: Number.isFinite(created) ? created : 0,
      fdvUsd: toNum(entry.attributes?.fdv_usd),
      priceUsd: toNum(entry.attributes?.base_token_price_usd),
      priceNativeBnb: toNum(entry.attributes?.base_token_price_native_currency),
      volM5Usd: toNum(vol.m5),
      volH1Usd: toNum(vol.h1),
      tradersH1: buyers !== null && sellers !== null ? buyers + sellers : (buyers ?? sellers ?? null),
      buysH1: toNum(txH1.buys),
      sellsH1: toNum(txH1.sells),
      priceChangeH1Pct: toNum(pc.h1),
    });
  }
  return out;
}

export async function fetchNewPoolsPage(page = 1, dexId = "four-meme", timeoutMs = 15000): Promise<BscCandidate[]> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`https://api.geckoterminal.com/api/v2/networks/bsc/new_pools?page=${page}`, {
      signal: ctrl.signal,
      headers: { accept: "application/json", "user-agent": "SculGrok-bsc/0.1 paper-test" },
    });
    if (!res.ok) throw new Error("GeckoTerminal HTTP " + res.status);
    return parseNewPools(await res.json(), dexId);
  } finally {
    clearTimeout(t);
  }
}

export async function fetchNewFourMemePools(page = 1, timeoutMs = 15000): Promise<BscCandidate[]> {
  return fetchNewPoolsPage(page, "four-meme", timeoutMs);
}

/** v2 — Discovery B: fresh PancakeSwap V2 pools. Most are NOT
 * four.meme graduates (0 of 38 fresh PCS pools across 6 pages
 * returned graduated=1 from Helper3, 2026-11-24 ~15:35 SAST —
 * Flap and direct listings dominate the feed), so the spotter
 * Helper3-filters these before they consume deep-check budget. */
export async function fetchNewPancakePools(page = 1, timeoutMs = 15000): Promise<BscCandidate[]> {
  return fetchNewPoolsPage(page, "pancakeswap_v2", timeoutMs);
}

/** Fetch several new_pools pages (page 1 = newest). Pages widen the
 * age window: page 1 alone is ~10-20 min of four.meme launches. */
export async function fetchNewPoolsPages(pages = 2, dexId = "four-meme", timeoutMs = 15000): Promise<BscCandidate[]> {
  const out: BscCandidate[] = [];
  const seen = new Set<string>();
  for (let page = 1; page <= pages; page++) {
    const batch = await fetchNewPoolsPage(page, dexId, timeoutMs);
    for (const c of batch) {
      if (!seen.has(c.address.toLowerCase())) {
        seen.add(c.address.toLowerCase());
        out.push(c);
      }
    }
    if (batch.length === 0) break;
  }
  return out;
}

export async function fetchNewFourMemePoolsPages(pages = 2, timeoutMs = 15000): Promise<BscCandidate[]> {
  return fetchNewPoolsPages(pages, "four-meme", timeoutMs);
}

export async function fetchNewPancakePoolsPages(pages = 2, timeoutMs = 15000): Promise<BscCandidate[]> {
  return fetchNewPoolsPages(pages, "pancakeswap_v2", timeoutMs);
}
