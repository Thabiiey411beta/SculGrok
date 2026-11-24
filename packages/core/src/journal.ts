import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface JournalEntry {
  ts: string;
  mint: string;
  action: string;
  reason: string;
  /** v2.17 discovery source for deep-check lines (blocked, okx_signal,
   * sentiment_signal, cobuy_signal, paper_entry): "ws" when the coin
   * came from the WebSocket queue alone, "poll" when it came from the
   * 5-minute poll (poll row wins on overlap). v2.28: "second-look"
   * when the coin is a transient-blocked mint re-checked at age
   * 30-120 min from state. Absent on lines that
   * are not a candidate's entry decision (ws_discovery, poll_failed,
   * watcher closes). Lets the backtest answer whether WS discovery
   * produces deep-checks / entries. */
  source?: "ws" | "poll" | "second-look";
  score?: number;
  sizeUsd?: number;
  price?: number;
  feesUsd?: number;
  equityUsd?: number;
  extra?: Record<string, unknown>;
  /** v2.11 entry-time volatility / concentration snapshot (paper_entry only). */
  firstMcUsd?: number;
  runUpPct?: number;
  liquidityUsd?: number;
  top10Pct?: number;
  singleWalletPct?: number;
  /** v2.14 buy-dominance / flow snapshot (paper_entry + sentiment_signal).
   * LOGGED ONLY — no gate, no score change, no sizing change. Null
   * means the source did not carry the field (absence recorded
   * explicitly, never fabricated). After 20 paper trades these fields
   * are the backtest input for a buy-dominance gate (research §6.3). */
  dexBuysH1?: number | null;
  dexSellsH1?: number | null;
  dexBuysM5?: number | null;
  dexSellsM5?: number | null;
  dexBuysH24?: number | null;
  dexSellsH24?: number | null;
  jupBuyVolumeH1?: number | null;
  jupSellVolumeH1?: number | null;
  jupBuyOrgVolumeH1?: number | null;
  jupSellOrgVolumeH1?: number | null;
  jupNumBuysH1?: number | null;
  jupNumSellsH1?: number | null;
  jupNumTradersH1?: number | null;
  jupNumNetBuyersH1?: number | null;
  jupHolderChangeH1?: number | null;
  jupOrganicScore?: number | null;
  /** Token age at entry in minutes (Jupiter createdAt preferred,
   * DexScreener pairCreatedAt fallback) + fixed-window price change
   * — the honest substitutes for run-up, since no available source
   * exposes a launch mc (see entryFlowStats in spotter.ts). */
  tokenAgeMin?: number | null;
  dexPriceChangeH1Pct?: number | null;
  dexPriceChangeH6Pct?: number | null;
  dexPriceChangeH24Pct?: number | null;
  /** v2.24 volume heat + avg trade size (paper_entry only). LOGGED
   * ONLY — no gate, no score change. buyHeatPct is DexScreener m5
   * buys as a share of h1 buys (uniform flow = 8.33%); buyHeatPace
   * divides by 8.33 (1.0x steady, 3x accelerating). avgBuyUsd is
   * exact (Jupiter 1h buy volume / 1h buy count). Null means the
   * source did not carry the field. After 20 paper trades these are
   * the backtest input for a volume-heat gate. */
  buyHeatPct?: number | null;
  sellHeatPct?: number | null;
  buyHeatPace?: number | null;
  avgBuyUsd?: number | null;
  avgSellUsd?: number | null;
  avgBuyOrgUsd?: number | null;
  /** v2.15 Jupiter sell-sim quote for the would-be position
   * (paper_entry only): realised SOL output in lamports, the naive
   * expected output at entry price, and the quoted price impact
   * (decimal fraction, null when Jupiter omits it). Absent when the
   * quote failed — a transient quote now BLOCKS the entry, so an
   * entry line never carries a missing quote. */
  sellSimOutLamports?: number | null;
  sellSimExpectedLamports?: number | null;
  sellSimImpactPct?: number | null;
  /** v2.15 co-buy clustering snapshot (paper_entry + cobuy_signal):
   * LOGGED ONLY, never a gate. Max distinct acquirers in one slot,
   * distinct acquirers in the pre-entry window, and the top
   * acquirer's share of early buy volume (0-1). Null when the check
   * failed. `coBuyFlagged` is the provisional flag (see cobuy.ts). */
  coBuyMaxAcquirersInSlot?: number | null;
  coBuyDistinctAcquirers?: number | null;
  coBuyTopShare?: number | null;
  coBuyFlagged?: boolean;
  /** v2.22 operator + sell-impact snapshot (paper_entry +
   * operator_signal): LOGGED ONLY, never a gate. Distinct probable
   * owners among the checked top holders, the largest operator's
   * share of the real float, the top-3 operators' share of the
   * float, and the MODELLED CPAMM sell-impact % if the largest /
   * top-3 operators sold everything (a lower bound for
   * bonding-curve tokens). Null when the check failed or the market
   * data was missing. See packages/signals/src/operator.ts. */
  operatorCount?: number | null;
  operatorLargestPctFloat?: number | null;
  operatorTop3PctFloat?: number | null;
  operatorSellImpactLargestPct?: number | null;
  operatorSellImpactTop3Pct?: number | null;
  /** v2.25 liq/vol ratio (paper_entry only). DexScreener h24 volume /
   * liquidity (Immutal0 rule, adapted — its $10k-$200k band and $500
   * vol floor are NOT adopted). LOGGED ONLY — no gate, no score
   * change. Null when DexScreener did not carry volume or liquidity
   * (absence recorded explicitly, never 0). liqVolSuspicious is true
   * when the ratio is measured and < 0.1. */
  liqVolRatio?: number | null;
  liqVolSuspicious?: boolean;
  /** v2.25 exit grading (close / exit_grade lines). LOGGED ONLY.
   * exitQuality is the papertrench grade: excellent (kept >= 90% of
   * the peak move), sold early (price ran > 5% after the exit),
   * round-tripped (gave back >= 50% of the peak move while holding),
   * pending (provisional at close: 50-90% captured, needs the
   * post-exit window to decide). leftOnTable is the gain foregone by
   * selling when the position did, measured against the best mc seen
   * after the exit inside the 120-min tracking window — null with a
   * reason when no post-exit price was seen, never invented. sizePct
   * is the position size as % of book equity at entry; sizePctFlagged
   * is true over 25%. */
  exitQuality?: ExitQuality;
  leftOnTablePct?: number | null;
  leftOnTableUsd?: number | null;
  leftOnTableReason?: string;
  sizePct?: number | null;
  sizePctFlagged?: boolean;
  /** v2.25 entry thesis (paper_entry only). The entry reason as
   * recorded while the position was open, before the outcome was
   * known. Close paths never write it and never change it — the
   * journal must show the thesis as it stood at entry, not as
   * rewritten after the result. */
  entryThesis?: string;
}

/** v2.25 exit grade. "pending" is provisional-only (close line);
 * a finalised exit_grade line always carries one of the other three. */
export type ExitQuality = "excellent" | "sold early" | "round-tripped" | "pending";

export function appendJournal(filePath: string, entry: JournalEntry): void {
  mkdirSync(dirname(filePath), { recursive: true });
  appendFileSync(filePath, JSON.stringify(entry) + "\n", "utf8");
}

export function journalEntry(
  mint: string,
  action: string,
  reason: string,
  extra: Partial<JournalEntry> = {},
): JournalEntry {
  // Identity fields win: extra is spread FIRST so a caller passing
  // extra: { ts, mint, ... } can never overwrite the entry's own
  // timestamp, mint, action or reason.
  return { ...extra, ts: new Date().toISOString(), mint, action, reason };
}
