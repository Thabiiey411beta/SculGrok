/**
 * X-free sentiment tracker — v2.9, 2026-11-23. Paper-only, logged signal only.
 *
 * v2.9 adds CoinMarketCap as a MARKET CONTEXT component (max 10). CMC has
 * NO per-mint endpoint on this plan, so it never scores a specific
 * Pump.fun mint and the trending-symbol idea was DROPPED: the trending
 * endpoint /v1/cryptocurrency/trending/latest returned HTTP 403 on this
 * plan (tested live 2026-11-23 ~02:05 SAST, 0 credits consumed), so no
 * symbol matching is attempted at all — no generic-collision risk, no
 * forced component. Only /v2/cryptocurrency/quotes/latest for BTC+SOL
 * (1 credit/call, verified live) feeds the market-context score.
 *
 * X is still 401 (token problem, portal-side fix needed from Newton).
 * Per the overnight research brief §3, there is no free X API any more,
 * and a scraper must NOT be built (Nitter is dead, violates ToS). So
 * this tracker uses only sources already owned / connected, $0 extra:
 *
 * 1. FomoAPI alerts feed (already polled every 30 min by cron,
 *    125 credits/poll, 250k/month budget) — smart-wallet buy
 *    clustering: distinct tracked smart traders buying the same mint
 *    in the last 60 minutes, and total smart USD. Reuses the
 *    loadFomoAlerts() map the spotter already builds each poll.
 * 2. FomoAPI graduated board (already in fomo-feed.json, 6h cadence)
 *    — a candidate on the graduated board is on-chain attention.
 * 3. Birdeye trending (custom.birdeye, `birdeye.py trending`) —
 *    rank + volume24hChangePercent. Called lazily, at most once per
 *    poll, only when a candidate reaches the deep-check stage (same
 *    pattern as Cabal/OKX). Fail-open: a failed call = no trending
 *    component, never a block.
 * 4. DexScreener public API, keyless (`/latest/dex/tokens/<mint>`,
 *    verified live 2026-11-23) — h1/h24 volume, h24 txns, liquidity,
 *    market cap. Volume-spike detection: h1 volume vs the h24 hourly
 *    average. Called only for would-be entries (max ~3/poll).
 *    Fail-open: a failed fetch = no volume component.
 *
 * 5. CoinMarketCap market context (v2.9, `cmc.py quotes --symbols BTC,SOL`,
 *    1 credit/call) — SOL + BTC 24h change. Risk-on (both green, SOL
 *    outperforming) adds up to 10; both red adds 0. Called lazily, at most
 *    once per poll, only when a candidate reaches the deep-check stage
 *    (same pattern as Birdeye). Fail-open: a failed call = component 0.
 *
 * Cost per spotter poll: $0 extra, plus ≤1 CMC credit on polls with a
 * would-be entry (15,000/month budget; 3 credits used before v2.9). The
 * FomoAPI alerts + feed files are already written by their crons;
 * Birdeye trending is 1 call only on polls with a would-be entry;
 * DexScreener is free/keyless.
 *
 * Cap table (v2.9): smart-cluster 50 + graduated board 15 + Birdeye
 * trending 20 + DexScreener volume 20 + breadth 5 + CMC market 10 = raw
 * max 120, clamped to 100. Verdict thresholds unchanged: hot ≥60,
 * warm 30–59, cold <30, unknown when every source is missing.
 *
 * Scoring is deliberately flow-confirmed, not hype-first: every
 * component requires on-chain buying or volume, so a token cannot
 * score "hot" on social noise alone — there is no social input at
 * all until the X token is fixed. When X returns, Layer 1 counts +
 * Layer 3 search context from the research brief slot in as a fifth
 * component; until then this module is the whole tracker.
 *
 * NEVER a gate: scoreSentiment() only ever informs a journal entry
 * (`sentiment_signal`) and a note on the paper_entry reason. It
 * never blocks, never changes size, never changes the gem score.
 * Missing data = component 0 and verdict "unknown", fail-closed
 * in the sense that an unknown token is logged as unknown, not
 * treated as hot or cold.
 *
 * PROVISIONAL WEIGHTS (SOUL audit fix, 2026-11-23): every component
 * weight and threshold in this module is an unsourced practitioner
 * guess, not a measured calibration — flagged by
 * `provisionalWeights: true` on every score. Two fail-closed rules:
 * (1) a feed older than 6h awards no board points (loadGraduatedMints
 * checks mtime); (2) "hot" requires >= 2 distinct source families —
 * fomo-alerts and fomo-graduated count as ONE family ("fomo"); the
 * families are fomo, birdeye, dexscreener, coinmarketcap. A token
 * scoring >= 60 from a single family caps at "warm": partial data
 * cannot score hot.
 */

import { execFile } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const FOMO_FEED_PATH =
  "/home/hatch/workspace/goals/solana-memecoin-flipping-system/hidden_files/fomo-feed.json";
const BIRDEYE_CHECK = "/home/hatch/workspace/custom-connectors/custom.birdeye/bin/birdeye.py";
const CMC_CHECK = "/home/hatch/workspace/custom-connectors/custom.coinmarketcap/bin/cmc.py";

export interface SentimentInput {
  mint: string;
  /** Distinct tracked smart-money traders who bought this mint in the last 60 min (Fomo alerts). */
  smartBuyers: string[];
  /** Total USD of those smart buys (max single buy is also fine; sum is used). */
  smartBuyUsd: number;
  /** Distinct traders (any) who bought this mint in the last 60 min (Fomo alerts recentBuys). */
  recentBuyers: string[];
  /** Mint is on the FomoAPI graduated board (fomo-feed.json, <=6h old). */
  onGraduatedBoard: boolean;
  /** Birdeye trending rank (1 = top), null when not trending or the call failed. */
  birdeyeRank: number | null;
  /** Birdeye volume24hChangePercent, null when unknown. */
  birdeyeVolumeChangePct: number | null;
  /** DexScreener h24 volume USD of the highest-volume pair, null when unknown. */
  dexVolumeH24: number | null;
  /** DexScreener h1 volume USD, null when unknown. */
  dexVolumeH1: number | null;
  /** DexScreener h24 txn count (buys + sells), null when unknown. */
  dexTxnsH24: number | null;
  /** DexScreener market cap USD, null when unknown (falls back to the spotter's mcap). */
  dexMcapUsd: number | null;
  /** CoinMarketCap SOL 24h change %, null when the quotes call failed/missing. */
  cmcSolChange24hPct: number | null;
  /** CoinMarketCap BTC 24h change %, null when the quotes call failed/missing. */
  cmcBtcChange24hPct: number | null;
  /** CMC credits consumed by the quotes call (null when no call ran). */
  cmcCredits?: number | null;
}

export type SentimentVerdict = "hot" | "warm" | "cold" | "unknown";

export interface SentimentScore {
  mint: string;
  score: number;
  verdict: SentimentVerdict;
  components: { smartCluster: number; board: number; trending: number; volume: number; breadth: number; cmcMarket: number };
  sources: string[];
  /** h1 volume vs the h24 hourly average (null when not computable). */
  volumeSpikeRatio: number | null;
  /** CMC SOL/BTC 24h change % as scored (null when the quotes call failed). */
  cmcSolChange24hPct: number | null;
  cmcBtcChange24hPct: number | null;
  /** CMC credits consumed by the quotes call for this score (null when no call ran). */
  cmcCredits: number | null;
  /** All component weights and thresholds in this module are
   * provisional, unsourced practitioner guesses — see the module
   * header. Always true until a measured calibration replaces them. */
  provisionalWeights: true;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export function scoreSentiment(input: SentimentInput): SentimentScore {
  const smartCount = new Set(input.smartBuyers).size;
  const recentCount = new Set(input.recentBuyers).size;

  // 1. Smart-wallet clustering (max 50): distinct smart buyers, plus a
  // bonus when they put real size behind it.
  let smartCluster = 0;
  if (smartCount >= 3) smartCluster = 40;
  else if (smartCount === 2) smartCluster = 30;
  else if (smartCount === 1) smartCluster = 15;
  if (smartCount > 0 && input.smartBuyUsd >= 10000) smartCluster += 10;
  smartCluster = Math.min(50, smartCluster);

  // 2. Graduated board presence (max 15).
  const board = input.onGraduatedBoard ? 15 : 0;

  // 3. Birdeye trending (max 20): rank points + a volume-change bonus.
  let trending = 0;
  if (input.birdeyeRank !== null && Number.isFinite(input.birdeyeRank)) {
    trending = input.birdeyeRank <= 10 ? 15 : input.birdeyeRank <= 50 ? 10 : 5;
    if (typeof input.birdeyeVolumeChangePct === "number" && input.birdeyeVolumeChangePct >= 100) trending += 5;
  }
  trending = Math.min(20, trending);

  // 4. DexScreener volume (max 20): spike ratio + volume/mcap + txn count.
  let volume = 0;
  let volumeSpikeRatio: number | null = null;
  if (
    typeof input.dexVolumeH24 === "number" &&
    input.dexVolumeH24 > 0 &&
    typeof input.dexVolumeH1 === "number" &&
    input.dexVolumeH1 >= 0
  ) {
    volumeSpikeRatio = input.dexVolumeH1 / (input.dexVolumeH24 / 24);
    if (volumeSpikeRatio >= 3) volume += 10;
    else if (volumeSpikeRatio >= 2) volume += 6;
    else if (volumeSpikeRatio >= 1.5) volume += 3;
  }
  if (
    typeof input.dexVolumeH24 === "number" &&
    input.dexVolumeH24 > 0 &&
    typeof input.dexMcapUsd === "number" &&
    input.dexMcapUsd > 0
  ) {
    const volMcap = input.dexVolumeH24 / input.dexMcapUsd;
    if (volMcap >= 0.5) volume += 5;
    else if (volMcap >= 0.2) volume += 3;
  }
  if (typeof input.dexTxnsH24 === "number" && input.dexTxnsH24 >= 1000) volume += 5;
  else if (typeof input.dexTxnsH24 === "number" && input.dexTxnsH24 >= 300) volume += 2;
  volume = Math.min(20, volume);

  // 5. Breadth (max 5): how many distinct traders bought in the last hour.
  const breadth = recentCount >= 10 ? 5 : recentCount >= 5 ? 3 : 0;

  // 6. CoinMarketCap market context (v2.9, max 10): SOL + BTC 24h change.
  // Market context only — CMC has no per-mint endpoint on this plan, so
  // this never scores a specific mint. Both values are required; a
  // partial quote is treated as missing (component 0, no source).
  let cmcMarket = 0;
  const sol = input.cmcSolChange24hPct;
  const btc = input.cmcBtcChange24hPct;
  const cmcPresent =
    typeof sol === "number" && Number.isFinite(sol) && typeof btc === "number" && Number.isFinite(btc);
  if (cmcPresent) {
    if (sol >= 0 && btc >= 0) cmcMarket = sol >= btc ? 10 : 7;
    else if (sol >= 0 || btc >= 0) cmcMarket = 3;
    else cmcMarket = 0;
  }

  const sources: string[] = [];
  if (smartCount > 0 || recentCount > 0) sources.push("fomo-alerts");
  if (input.onGraduatedBoard) sources.push("fomo-graduated");
  if (input.birdeyeRank !== null) sources.push("birdeye-trending");
  if (input.dexVolumeH24 !== null) sources.push("dexscreener");
  if (cmcPresent) sources.push("coinmarketcap");

  // Source families for the hot cap: fomo-alerts and fomo-graduated
  // are one family ("fomo") — a token cannot score hot on FomoAPI
  // data alone, however strong the cluster is.
  const families = new Set<string>();
  if (smartCount > 0 || recentCount > 0 || input.onGraduatedBoard) families.add("fomo");
  if (input.birdeyeRank !== null) families.add("birdeye");
  if (input.dexVolumeH24 !== null) families.add("dexscreener");
  if (cmcPresent) families.add("coinmarketcap");

  const hasAnyData = sources.length > 0;
  const score = hasAnyData ? clamp(smartCluster + board + trending + volume + breadth + cmcMarket, 0, 100) : 0;
  let verdict: SentimentVerdict;
  if (!hasAnyData) verdict = "unknown";
  else if (score >= 60 && families.size >= 2) verdict = "hot";
  else if (score >= 60) verdict = "warm"; // single-family cap: partial data cannot score hot
  else if (score >= 30) verdict = "warm";
  else verdict = "cold";

  return {
    mint: input.mint,
    score,
    verdict,
    components: { smartCluster, board, trending, volume, breadth, cmcMarket },
    sources,
    volumeSpikeRatio,
    cmcSolChange24hPct: cmcPresent ? sol : null,
    cmcBtcChange24hPct: cmcPresent ? btc : null,
    cmcCredits: typeof input.cmcCredits === "number" ? input.cmcCredits : null,
    provisionalWeights: true,
  };
}

/** Mints on the FomoAPI graduated board (fomo-feed.json). Empty set
 * when the feed file is missing, stale (> 6h old — the board is only
 * as fresh as the 6h feed cadence) or unreadable — never throws. */
export const FOMO_FEED_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export function loadGraduatedMints(feedPath: string = FOMO_FEED_PATH): Set<string> {
  const out = new Set<string>();
  try {
    const mtimeMs = statSync(feedPath).mtimeMs;
    if (Date.now() - mtimeMs > FOMO_FEED_MAX_AGE_MS) return out; // stale feed: no board points
    const feed = JSON.parse(readFileSync(feedPath, "utf8"));
    for (const t of feed.graduatedTokens ?? []) {
      if (typeof t?.address === "string") out.add(t.address);
    }
  } catch {
    // No feed yet, or unreadable: no board component, spotter continues.
  }
  return out;
}

export interface BirdeyeTrendingToken {
  /** Birdeye trending rank (1 = top), null when the response does
   * not carry one — a missing rank is no trending component, never
   * a made-up rank 999 that would still score points. */
  rank: number | null;
  volumeChangePct: number | null;
}

/** Birdeye trending top-N, mint -> { rank, volumeChangePct }.
 * One keyed call via the registered helper (surrogate, no key here).
 * Empty map on any failure — fail-open, the trending component is 0. */
export async function loadBirdeyeTrending(limit = 20): Promise<Map<string, BirdeyeTrendingToken>> {
  const out = new Map<string, BirdeyeTrendingToken>();
  try {
    const { stdout } = await execFileAsync("python3", [BIRDEYE_CHECK, "trending", "--limit", String(limit)], { timeout: 30000 });
    const parsed = JSON.parse(stdout) as { data?: { tokens?: Array<{ address?: string; rank?: number; volume24hChangePercent?: number }> } };
    for (const t of parsed?.data?.tokens ?? []) {
      if (typeof t?.address !== "string") continue;
      out.set(t.address, {
        rank: typeof t.rank === "number" ? t.rank : null,
        volumeChangePct: typeof t.volume24hChangePercent === "number" ? t.volume24hChangePercent : null,
      });
    }
  } catch {
    // Birdeye down / rate-limited / plan-gated: no trending component.
  }
  return out;
}

export interface CmcMarket {
  solChange24hPct: number;
  btcChange24hPct: number;
  /** Credits the quotes call consumed (from the response status).
   * Null when the response does not report a credit count — an
   * absent count is unknown, not 0. */
  credits: number | null;
}

/** CoinMarketCap market context: SOL + BTC 24h change in ONE quotes call
 * (1 credit). One keyed call via the registered helper (surrogate, no key
 * here). Null on any failure — fail-open, the CMC component is 0.
 * Only the verified-plan quotes endpoint is used; the trending endpoint
 * is 403 on this plan and DEX endpoints are plan-gated, so neither is
 * called here. */
export async function loadCmcMarket(): Promise<CmcMarket | null> {
  try {
    const { stdout } = await execFileAsync("python3", [CMC_CHECK, "quotes", "--symbols", "BTC,SOL"], { timeout: 30000 });
    const parsed = JSON.parse(stdout) as {
      data?: Record<string, Array<{ quote?: { USD?: { percent_change_24h?: number } } }>>;
      status?: { credit_count?: number };
    };
    const sol = parsed?.data?.SOL?.[0]?.quote?.USD?.percent_change_24h;
    const btc = parsed?.data?.BTC?.[0]?.quote?.USD?.percent_change_24h;
    if (typeof sol !== "number" || typeof btc !== "number") return null;
    return {
      solChange24hPct: sol,
      btcChange24hPct: btc,
      credits: typeof parsed?.status?.credit_count === "number" ? parsed.status.credit_count : null,
    };
  } catch {
    // CMC down / 401 / 429 / timeout: no market-context component.
    return null;
  }
}

export interface DexSnapshot {
  volumeH24: number | null;
  volumeH1: number | null;
  txnsH24: number | null;
  liquidityUsd: number | null;
  mcapUsd: number | null;
  priceChangeH24Pct: number | null;
  /** v2.14 buy-dominance logging (research §6.3): the buy/sell split
   * was discarded until now, so no volume rule could ever be validated
   * from the journal. These are LOGGED ONLY — no gate, no score change. */
  buysH1: number | null;
  sellsH1: number | null;
  buysM5: number | null;
  sellsM5: number | null;
  buysH24: number | null;
  sellsH24: number | null;
  /** Pair creation time, ms epoch (DexScreener pairCreatedAt). Token
   * age at entry, for the run-up measurement fix (v2.14): runUpPct
   * is measured from first-seen-in-this-run, so same-poll entries
   * show 0% — age + fixed-window price changes are the honest
   * substitutes (no available source exposes a launch mc). */
  pairCreatedAt: number | null;
  priceChangeH1Pct: number | null;
  priceChangeH6Pct: number | null;
}

interface DexScreenerPair {
  volume?: { h24?: number; h1?: number };
  txns?: {
    m5?: { buys?: number; sells?: number };
    h1?: { buys?: number; sells?: number };
    h24?: { buys?: number; sells?: number };
  };
  liquidity?: { usd?: number };
  marketCap?: number;
  pairCreatedAt?: number;
  priceChange?: { h1?: number; h6?: number; h24?: number };
}

/** Pure parse of a DexScreener /latest/dex/tokens/{mint} response.
 * Pair selection is unchanged: the highest-h24-volume pair (fine
 * pre-migration; post-migration the AMM pair dominates). Null when
 * no pair carries an h24 volume — fail-open, caller treats as no data. */
export function parseDexScreenerResponse(data: { pairs?: DexScreenerPair[] } | null | undefined): DexSnapshot | null {
  const pairs = (data?.pairs ?? []).filter((p) => p && typeof p?.volume?.h24 === "number");
  if (pairs.length === 0) return null;
  const best = pairs.reduce((a, b) => ((b.volume?.h24 ?? 0) > (a.volume?.h24 ?? 0) ? b : a));
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const txns = best.txns ?? {};
  const buysH24 = num(txns.h24?.buys);
  const sellsH24 = num(txns.h24?.sells);
  return {
    volumeH24: num(best.volume?.h24),
    volumeH1: num(best.volume?.h1),
    txnsH24: buysH24 !== null && sellsH24 !== null ? buysH24 + sellsH24 : null,
    liquidityUsd: num(best.liquidity?.usd),
    mcapUsd: num(best.marketCap),
    priceChangeH24Pct: num(best.priceChange?.h24),
    buysH1: num(txns.h1?.buys),
    sellsH1: num(txns.h1?.sells),
    buysM5: num(txns.m5?.buys),
    sellsM5: num(txns.m5?.sells),
    buysH24,
    sellsH24,
    pairCreatedAt: num(best.pairCreatedAt),
    priceChangeH1Pct: num(best.priceChange?.h1),
    priceChangeH6Pct: num(best.priceChange?.h6),
  };
}

async function fetchJson(url: string, timeoutMs = 10000): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: "application/json", "user-agent": "SculGrok-spotter/0.1 paper-test" } });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/** DexScreener snapshot for one mint (public, keyless). Uses the
 * highest-h24-volume pair for the mint. Null on any failure or when
 * DexScreener knows no pair for the mint — fail-open. */
export async function fetchDexScreener(mint: string): Promise<DexSnapshot | null> {
  try {
    const data = (await fetchJson("https://api.dexscreener.com/latest/dex/tokens/" + encodeURIComponent(mint), 10000)) as {
      pairs?: DexScreenerPair[];
    };
    return parseDexScreenerResponse(data);
  } catch {
    return null;
  }
}
