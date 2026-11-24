/**
 * BSC v2 — VOLUME-FIRST entry ruleset (replaces the Solana gem score).
 *
 * Why: v1 reused the Solana gem score (bars 70 / fresh 60). A
 * brand-new token scores 46 BY CONSTRUCTION (growth 25 + buy-ratio
 * 20 + ~1 inflow from a single buy) and can never clear the bar,
 * so the desk deep-checked ~30 polls and entered 0 trades. The gem
 * score is velocity/flow-by-proxy; this module measures ACTUAL
 * volume instead, from fields observed live on real tokens.
 *
 * Data sources (all verified live 2026-11-24):
 * - DexScreener tokens/v1/bsc/<address>: volume {m5, h1, h6, h24}
 *   in USD, txns {buys, sells} per window, priceChange per window,
 *   liquidity.usd, pairCreatedAt. NOTE: for pre-graduation
 *   four.meme pairs volume/priceChange are EMPTY ({}) — only txns
 *   are carried. Volume exists only once a token has a
 *   PancakeSwap pair, i.e. after graduation.
 * - GeckoTerminal new_pools attributes: volume_usd {m5, h1},
 *   transactions {h1: {buyers, sellers, buys, sells}},
 *   price_change_percentage. Carried on the candidate from
 *   discovery — no extra call.
 *
 * Every threshold below is either SOURCED (from a repo/doc) or
 * marked UNPROVEN (calibrated on ONE 15-token snapshot of fresh
 * PancakeSwap pools, 2026-11-24 ~15:30 SAST — see the v2 build
 * note). No threshold is presented as backtested: there are 0
 * graduated four.meme entries in the journal to backtest against.
 * The ruleset is a set of HARD GATES (all must pass), not a score
 * with a bar — deliberately different from the Solana desk. A
 * journal-only additive score (volumeScore, CMC-adapted) is
 * computed for later calibration; it never gates.
 *
 * Pre-graduation: the volume gates are EVALUATED and journaled for
 * every deep-checked pre-grad token, but entries stay blocked by
 * the existing fee model (four.meme 1% min 0.001 BNB = ~33% round
 * trip on a $3.30 position; break-even ~38.7% > the 25% bar).
 * The volume ruleset is effectively graduated-first at $15 equity.
 */

export const VOL_MIN_M5_USD = 300;
export const VOL_MIN_H1_USD = 500;
/** memecoin.watch Heat rule: buy/sell ratio >= 1.2x required. */
export const VOL_MIN_BUY_SELL_RATIO = 1.2;
/** CMC snipe-score lowest trader tier: >10 traders. */
export const VOL_MIN_TRADERS_H1 = 10;
/** Heat = (volM5 / volH1) / (5/60): 1.0 = steady flow, >1 =
 * accelerating, <1 = fading. (UNPROVEN bar — adapted from the
 * memecoin.watch Heat pattern, 1m/5m x 100 with tiers 33/48/100.) */
export const VOL_MIN_HEAT = 1.0;
/** h1 volume as a share of pool liquidity. (UNPROVEN — calibrated
 * on the 15-token snapshot: dead tokens ~0-4%, live mid tokens
 * 8-53%.) */
export const VOL_MIN_VOL_LIQ_RATIO = 0.05;
/** CMC snipe-score MAX_POOL_AGE_HOURS = 6: graduation is a
 * moment, not a state — only trade the first 6h of the pair. */
export const VOL_MAX_PAIR_AGE_H = 6;
/** Breadth fallback when GeckoTerminal trader data is absent
 * (graduation re-check candidates): total h1 txns as a proxy for
 * unique traders (sample ratio txns/traders ~1.4-2.1, so 20 txns
 * ~= 10-14 traders). UNPROVEN. */
export const VOL_MIN_H1_TXNS_FALLBACK = 20;
/** Holder-floor staleness fallback (see bsc-spotter.ts): GoPlus
 * holder counts lag by hours for fresh graduates (0-3 holders
 * observed on tokens with 50-614 live traders). When GoPlus says
 * <200 holders but >=50 unique wallets traded in the last hour,
 * the live breadth is the better distribution evidence. 50 is the
 * CMC snipe-score top trader tier. UNPROVEN. */
export const VOL_TRADER_BREADTH_FOR_HOLDER_FLOOR = 50;

export interface VolumeInputs {
  volM5Usd: number | null;
  volH1Usd: number | null;
  /** GeckoTerminal unique traders in the last hour (null when the
   * candidate was not discovered via GeckoTerminal). */
  tradersH1: number | null;
  /** DexScreener txn counts (always present — 0 when no trades). */
  buysH1: number;
  sellsH1: number;
  buysM5: number;
  sellsM5: number;
  liquidityUsd: number | null;
  priceChangeH1Pct: number | null;
  /** Hours since the PancakeSwap pair was created (null unknown). */
  pairAgeH: number | null;
}

export interface VolumeMetrics {
  volM5Usd: number | null;
  volH1Usd: number | null;
  /** (volM5 / volH1) / (5/60). Null when either volume is missing. */
  heat: number | null;
  /** h1 buys / h1 sells; Infinity when sells == 0 and buys > 0. */
  buySellRatio: number;
  /** True when buys dominate sells by the ratio bar. */
  buyDominant: boolean;
  /** Unique h1 traders, or the txn-count fallback when GT data is absent. */
  tradersH1: number | null;
  /** True when the trader count came from the txn fallback. */
  tradersFromTxnFallback: boolean;
  /** h1 volume / liquidity. Null when either is missing. */
  volLiqRatio: number | null;
  liquidityUsd: number | null;
  priceChangeH1Pct: number | null;
  pairAgeH: number | null;
}

export function volumeMetrics(input: VolumeInputs): VolumeMetrics {
  // Sells == 0: ratio is buys + 1 (the v1 gem-input convention) —
  // a real number for the journal, and 1 buy / 0 sells still reads
  // as buy-dominant. 0 buys / 0 sells reads as ratio 1 (neutral).
  const ratio = input.sellsH1 > 0 ? input.buysH1 / input.sellsH1 : input.buysH1 + 1;
  const totalH1Txns = input.buysH1 + input.sellsH1;
  const tradersFromTxnFallback = input.tradersH1 === null;
  return {
    volM5Usd: input.volM5Usd,
    volH1Usd: input.volH1Usd,
    heat:
      input.volM5Usd !== null && input.volH1Usd !== null && input.volH1Usd > 0
        ? input.volM5Usd / input.volH1Usd / (5 / 60)
        : null,
    buySellRatio: ratio,
    buyDominant: input.buysH1 > input.sellsH1 && ratio >= VOL_MIN_BUY_SELL_RATIO,
    tradersH1: tradersFromTxnFallback ? totalH1Txns : input.tradersH1,
    tradersFromTxnFallback,
    volLiqRatio:
      input.volH1Usd !== null && input.liquidityUsd !== null && input.liquidityUsd > 0
        ? input.volH1Usd / input.liquidityUsd
        : null,
    liquidityUsd: input.liquidityUsd,
    priceChangeH1Pct: input.priceChangeH1Pct,
    pairAgeH: input.pairAgeH,
  };
}

/**
 * Journal-only additive score (0-100), adapted from the CMC
 * "four.meme sniper" scoring pattern (liquidity tiers, age tiers,
 * trader tiers). NEVER gates an entry — it exists so the journal
 * accumulates a calibration signal for later. The tiers are the
 * CMC article's; the heat and buy-dominance components are ours
 * (UNPROVEN).
 */
export function volumeScore(m: VolumeMetrics): number {
  let s = 0;
  // Liquidity tiers (CMC): >$100k +30 / >$30k +15.
  // (No liquidity data = 0; pre-grad tokens score 0 here.)
  if (m.liquidityUsd !== null) {
    if (m.liquidityUsd > 100_000) s += 30;
    else if (m.liquidityUsd > 30_000) s += 15;
  }
  // Pair-age tiers (CMC): <1h +25 / <3h +15 / <6h +5.
  if (m.pairAgeH !== null) {
    if (m.pairAgeH < 1) s += 25;
    else if (m.pairAgeH < 3) s += 15;
    else if (m.pairAgeH < 6) s += 5;
  }
  // Trader tiers (CMC): >50 +25 / >20 +15 / >10 +8.
  if (m.tradersH1 !== null) {
    if (m.tradersH1 > 50) s += 25;
    else if (m.tradersH1 > 20) s += 15;
    else if (m.tradersH1 > 10) s += 8;
  }
  // Heat (ours, UNPROVEN): >=2 +15 / >=1 +8 — but only once the
  // h1 window is a full hour old. For a token <1h old, m5 ~= h1
  // by construction, so heat is ~12x and meaningless; awarding
  // points for it would inflate every fresh token's score.
  if (m.heat !== null && m.pairAgeH !== null && m.pairAgeH >= 1) {
    if (m.heat >= 2) s += 15;
    else if (m.heat >= 1) s += 8;
  }
  // Buy dominance (ours, UNPROVEN): >=1.5 +10 / >=1.2 +5.
  if (m.buyDominant) s += m.buySellRatio >= 1.5 ? 10 : 5;
  return Math.min(100, s);
}

export interface VolumeVerdict {
  pass: boolean;
  failed: string[];
  score: number;
  metrics: VolumeMetrics;
}

/**
 * The v2 entry gates for a GRADUATED token. Every gate must pass;
 * `failed` names each gate that did not, for the journal. Null
 * inputs fail closed (missing data = block), EXCEPT the h1 price
 * change: when DexScreener does not carry it, momentum is neutral
 * (logged, not failed) — the volume gates already carry the signal.
 */
export function volumeVerdict(input: VolumeInputs): VolumeVerdict {
  const m = volumeMetrics(input);
  const failed: string[] = [];
  if (m.volM5Usd === null) failed.push("m5 volume unknown (DexScreener carries no volume for this pair)");
  else if (m.volM5Usd < VOL_MIN_M5_USD) failed.push(`m5 volume $${Math.round(m.volM5Usd)} < $${VOL_MIN_M5_USD}`);
  if (m.volH1Usd === null) failed.push("h1 volume unknown (DexScreener carries no volume for this pair)");
  else if (m.volH1Usd < VOL_MIN_H1_USD) failed.push(`h1 volume $${Math.round(m.volH1Usd)} < $${VOL_MIN_H1_USD}`);
  if (!m.buyDominant) {
    failed.push(
      `buy dominance failed: ${input.buysH1} buys / ${input.sellsH1} sells (ratio ${Number.isFinite(m.buySellRatio) ? m.buySellRatio.toFixed(2) : "inf"} < ${VOL_MIN_BUY_SELL_RATIO})`,
    );
  }
  const breadth = m.tradersH1 ?? 0;
  const breadthBar = m.tradersFromTxnFallback ? VOL_MIN_H1_TXNS_FALLBACK : VOL_MIN_TRADERS_H1;
  if (breadth < breadthBar) {
    failed.push(
      m.tradersFromTxnFallback
        ? `h1 txns ${breadth} < ${breadthBar} (trader-count fallback)`
        : `unique h1 traders ${breadth} < ${breadthBar}`,
    );
  }
  if (m.heat === null) failed.push("volume heat unknown (missing m5/h1 volume)");
  else if (m.heat < VOL_MIN_HEAT) failed.push(`volume heat ${m.heat.toFixed(2)}x < ${VOL_MIN_HEAT}x (flow fading)`);
  if (m.volLiqRatio === null) failed.push("volume/liquidity unknown (missing h1 volume or liquidity)");
  else if (m.volLiqRatio < VOL_MIN_VOL_LIQ_RATIO)
    failed.push(`h1 volume/liquidity ${(m.volLiqRatio * 100).toFixed(1)}% < ${VOL_MIN_VOL_LIQ_RATIO * 100}%`);
  if (m.pairAgeH === null) failed.push("pair age unknown (fail-closed)");
  else if (m.pairAgeH > VOL_MAX_PAIR_AGE_H) failed.push(`pair age ${m.pairAgeH.toFixed(1)}h > ${VOL_MAX_PAIR_AGE_H}h (graduation moment passed)`);
  if (m.priceChangeH1Pct !== null && m.priceChangeH1Pct < 0)
    failed.push(`h1 price change ${m.priceChangeH1Pct.toFixed(1)}% < 0 (dumping)`);
  return { pass: failed.length === 0, failed, score: volumeScore(m), metrics: m };
}

/** Compact journal snapshot of a volume evaluation. */
export function volumeJournalExtra(v: VolumeVerdict): Record<string, number | null | boolean> {
  return {
    volM5Usd: v.metrics.volM5Usd,
    volH1Usd: v.metrics.volH1Usd,
    volHeat: v.metrics.heat !== null ? Math.round(v.metrics.heat * 100) / 100 : null,
    buySellRatioH1: Number.isFinite(v.metrics.buySellRatio) ? Math.round(v.metrics.buySellRatio * 100) / 100 : null,
    tradersH1: v.metrics.tradersH1,
    tradersFromTxnFallback: v.metrics.tradersFromTxnFallback,
    volLiqRatio: v.metrics.volLiqRatio !== null ? Math.round(v.metrics.volLiqRatio * 10000) / 10000 : null,
    volumeScore: v.score,
  };
}
