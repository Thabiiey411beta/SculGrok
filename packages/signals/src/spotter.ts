/**
 * Gem spotter — paper-only, fail-closed. The version history
 * (v2.2-v2.17 changelog) lives in hidden_files/*.md notes; this
 * header is the contract, not the changelog (SOUL audit fix, 2026-11-23).
 *
 * Entry chain (in order, each a hard gate — unknown/missing BLOCKS):
 * Rugcheck fetch + rugged flag + score <= 50 -> gem score >= 70 (or
 * the fresh-tier concentration allowance, score >= 50 — v2.27 24h
 * experiment, see FRESH_TIER_MIN_GEM) -> Helius
 * funder-cluster gate (cluster blocks; >= half of checked holders
 * with unknown funders blocks; below half halves size 0.75x) ->
 * Cabal-Hunter second opinion (blocks ONLY on HIGH risk, score >= 65
 * or honeypot HIGH; a failed scan never blocks) -> holder floor 200
 * and liquidity floor $8,000, both MIN across sources, fail-closed on
 * total absence -> sentiment (logged only; cold sentiment on
 * DexScreener volume data halves size 0.5x) -> Jupiter sell-sim
 * gate (blocks no route / zero output / output < 50% of expected /
 * impact > 10%; a transient quote after bounded retry BLOCKS) ->
 * co-buy (logged only).
 *
 * OKX is LOGGED ONLY (SOUL audit fix v2.18, 2026-11-23): its cluster
 * labels were inverted against paper outcomes (KYC passed, Betty
 * flagged), so it must never block or haircut alone; Helius is the
 * cluster authority. isOkxClusterGateBlock stays exported for replay
 * analysis only. OKX holder counts still feed resolveHolderCount.
 *
 * Fail-closed rules that matter most (SOUL audit fix v2.18):
 * - SOL price is a live Jupiter fetch per poll. If it fails, the poll
 *   is skipped (poll_failed) — there is NO fallback price anywhere.
 * - rugInputFromReport / gemInputFromCoin pass measured values or
 *   null. The four formerly unmeasured fields are wired to measured
 *   sources (v2.19, two-stage rug evaluation): bundlePct from the
 *   Helius funder-cluster linked supply %, devSoldPct from the
 *   creator's Helius transactions (swap-sold / acquired),
 *   washPct from Jupiter stats1h organic vs total volume, and the
 *   Token-2022 flags from Helius getAccountInfo extension parsing.
 *   Stage A (before the gem gate) defers those six fields so the
 *   cheap legs can filter first; stage B (after the gem gate, for
 *   would-be entries only) measures them and re-evaluates the rug
 *   check with no deferral. Any field still unmeasurable stays null
 *   and blocks — a deferred result is provisional, never a pass.
 *   Wash is LOGGED ONLY (v2.20): live Jupiter organic share is
 *   0.97-0.99 for every measurable fresh launch, and 27/30 fresh
 *   tokens have no organic fields at all (n=30, 2026-11-23) — wash
 *   has zero discriminating power on fresh tokens, so the old
 *   >50% block and the -20 gem penalty were friction without
 *   signal. The value is still measured at stage B and journaled
 *   with its source; re-promote only when a wash source is found
 *   that varies across candidates. The three gem flow components
 *   are measured from Jupiter stats1h BEFORE the stage-A gem gate
 *   (v2.21): buyer growth from holderChange, buy/sell ratio from
 *   buy/sell volume, inflow from numNetBuyers — one DexScreener +
 *   Jupiter fetch per candidate passing the Rugcheck filter,
 *   reused at stage B, so the gem ceiling is 100 when all are
 *   measured and the 70 bar / 50 fresh-tier bar (v2.27 experiment)
 *   are reachable at stage A; see gemInputFromCoin. A failed fetch leaves them
 *   null (0 points, blocks on the gem gate as before).
 * - Blocked-mint cooldown (v2.23): a mint blocked at deep-check is not
 *   re-checked for 60 minutes (15 for near-miss / data-gap blocks:
 *   cluster-unknown, holder / liquidity floors, sell-sim sizing),
 *   unless its mc rose >= 50% (>= 25% near-miss) since the block — a
 *   big rise means the picture changed. Skips are journaled as
 *   cooldown_skip and counted, never as blocks. No gate or bar changed.
 * - Dev-sold measurement (v2.23, cluster-check.py): the creator-tx
 *   window pages with the Helius `before` cursor up to 1000 txs
 *   (Helius caps one page at 100), stopping early when the creation
 *   tx is found — a busy creator no longer reads as unknown just
 *   because 100 txs did not reach creation. Still unknown past
 *   1000 txs, still blocks.
 * - v2.24 (logged signals only, no gate or bar changed): volume heat
 *   + avg trade size on every entry (memecoin.watch patterns —
 *   count-based heat from DexScreener m5/h1 buys, exact avg buy from
 *   Jupiter 1h volume/count); top-holder exit watch on open positions
 *   (wallet-tracker --holders-of pattern — a top-5 holder halving or
 *   leaving the top 10 journals holder_exit, never an exit); the
 *   smart-list validator runs offline (Helius per-wallet PnL) and does
 *   NOT change which wallets the spotter trusts until Newton says so.
 * - v2.25 (logged fields only, no gate, bar, sizing or exit changed):
 *   liq/vol ratio on every entry (DexScreener h24 volume / liquidity,
 *   suspicious < 0.1 — Immutal0 rule, adapted); exit grading on every
 *   full close (papertrench pattern — excellent / sold early /
 *   round-tripped, left-on-table vs the best mc seen in the 120-min
 *   post-exit window, position size % of book with a > 25% flag);
 *   entry thesis recorded at entry only and never edited by a close.
 *   NOTE: this build is v2.25, not v2.24 — the v2.24 label was
 *   already taken by the heat + holder-exit work above, and the route
 *   note's "v2.24" for these fields predates that discovery.
 * - v2.26 (trusted smart-money subset): the gem bonus (+15/+5) and
 *   the +10 recent-smart-buy boost count TRUSTED wallets only — the
 *   7 wallets that cleared the Helius per-wallet PnL validation
 *   (widened run, ranks 26-50, 30 days, PumpSwap included;
 *   validated-smart-wallets.json, generated from the validation JSON,
 *   never hand-edited) plus one expectancy exception Newton added
 *   2026-11-24: wallet 9wMySLRUm... ("1111111111111", WR 0.245,
 *   realized +1,660.9 SOL — the sample's largest; the win-rate bar
 *   was waived for it, marked "exception" in the file). A Fomo-listed
 *   holder that never validated adds nothing; an alert buy counts
 *   only for its trusted traders, with the buy count restricted to
 *   theirs. The bonus bars are unchanged (+15 needs >= 2 trusted
 *   wallets with minTrades >= 10). A missing/unreadable trusted file
 *   counts 0 (same fail-closed shape as a missing Fomo feed). Journal
 *   shows smartMoney as trusted/fomo so the filter is auditable.
 * - v2.28 (funnel fixes, 2026-11-24 ~19:55 SAST — coverage/timing
 *   only, no gate, bar, sizing or exit changed): pre-slice cooldown
 *   filter (the top-8 slice holds 8 fresh candidates instead of
 *   ~5.1 — 36% of slice slots were burned on cooldown skips);
 *   Rugcheck-failure transient/permanent split + second-look slice
 *   (permanent = creator-history danger or live mint/freeze
 *   authority -> 24h cooldown, never re-checked; transient =
 *   concentration / low liquidity -> 15m cooldown, re-checked at
 *   age 30-120 min in 2 reserved slice slots, re-scoring gem +
 *   Rugcheck fresh; 48h paper experiment from 2026-11-24 ~19:55
 *   SAST, second-look lines tagged source "second-look"); stage-A
 *   gem components journaled on blocks (flow note, zero new calls).
 *   No safety gate touched: Rugcheck <= 50, fresh-tier allowance,
 *   cluster, dev-sold, holder/liquidity floors, sell-sim, Cabal,
 *   OKX cluster gate all unchanged.
 * - Holder/liquidity resolvers use the MIN across disagreeing
 *   sources (fail-closed), never MAX or first-available.
 * - ATA rent is a cost (fees.ts): the buy leg includes it.
 * No API key. No live trading.
 */
import { execFile } from "node:child_process";
import { readFileSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { evaluateRug, RUG_DEFERRED_FIELDS, type RugInput } from "../../anti-rug/src/checks.js";
import { evaluateGem, type GemInput, type GemSignal } from "./gem-signal.js";
import { LIGHT_FEES, legCostSol } from "../../core/src/fees.js";
import { MICRO_PROFILE, positionSizeUsd } from "../../core/src/micro.js";
import { applyExit, evaluateExit, openPosition, type Position } from "../../exit/src/exit.js";
import { appendJournal, journalEntry, type ExitQuality, type JournalEntry } from "../../core/src/journal.js";
import { decideSellSim, expectedOutLamports, parseSellQuote, tokenBaseUnits, type SellSimQuote } from "../../anti-rug/src/sell-sim.js";
import { checkCoBuy, coBuyNote, isCoBuyFlagged } from "./cobuy.js";
import { analyzeOperator, operatorExcludedAddrs, operatorNote, realFloatPctFromTopHolders } from "./operator.js";
import { loadWsQueue, mergeWsCoins, WS_MERGE_MAX_AGE_MS, WS_QUEUE_PATH, wsCoinToPumpCoin } from "./ws-queue.js";
import { fetchDexScreener, loadBirdeyeTrending, loadCmcMarket, loadGraduatedMints, scoreSentiment, type BirdeyeTrendingToken, type CmcMarket, type DexSnapshot } from "./sentiment.js";
import { JOURNAL_PATH, SPOTTER_DIR, STATE_PATH } from "./spotter-paths.js";
export { JOURNAL_PATH, SPOTTER_DIR, STATE_PATH } from "./spotter-paths.js";

const execFileAsync = promisify(execFile);
const CLUSTER_CHECK = "/home/hatch/workspace/goals/solana-memecoin-flipping-system/hidden_files/sculgrok-work/apps/coordinator/src/cluster-check.py";
const CABAL_CHECK = "/home/hatch/workspace/custom-connectors/custom.cabal-hunter/bin/cabal_hunter.py";
const OKX_CHECK = "/home/hatch/workspace/custom-connectors/custom.okx/bin/okx.py";
const HELIUS_CHECK = "/home/hatch/workspace/custom-connectors/custom.helius/bin/helius.py";
/** SPL Token program (all four Token-2022 flags are false by
 * construction) and Token-2022 program ids. */
export const SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

export interface CabalResult {
  risk: string;
  /** Numeric cabal score, null when the scan did not return one —
   * a missing score is NEVER 0: 0 would journal as "CLEAN" when the
   * scan actually said nothing (SOUL audit fix). */
  cabal_score: number | null;
  honeypot_risk: string;
  verdict: string;
}

/** Run the Cabal-Hunter scan. Returns null on any failure or on a
 * malformed response, fail-OPEN: a failed second opinion never
 * blocks, the Helius verdict stands. */
export async function checkCabal(mint: string): Promise<CabalResult | null> {
  try {
    const { stdout } = await execFileAsync("python3", [CABAL_CHECK, "scan", "--mint", mint], { timeout: 90000 });
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    const summary = (parsed.summary ?? parsed) as Record<string, unknown>;
    if (typeof summary !== "object" || summary === null) return null;
    const str = (v: unknown): string => (typeof v === "string" ? v : "UNKNOWN");
    return {
      risk: str(summary.risk),
      cabal_score: typeof summary.cabal_score === "number" && Number.isFinite(summary.cabal_score) ? summary.cabal_score : null,
      honeypot_risk: str(summary.honeypot_risk),
      verdict: str(summary.verdict),
    };
  } catch {
    return null;
  }
}

export interface ClusterResult {
  clustered: boolean;
  reason: string;
  checked: number;
  unknown: number;
  sharedFunders: Array<{ funder: string; holders: string[]; pct: number; count: number }>;
  /** Measured bundle share (v2.19): % of TOTAL supply held by the
   * union of funder-linked top holders (percent points, e.g. 8.7),
   * null when the script did not report it. The rug check's
   * bundlePct is linkedPct / 100. A lower bound when unknown > 0. */
  linkedPct: number | null;
  /** Measured dev-sold share (v2.19) from the creator's Helius
   * transactions, null when no creator was passed or the script
   * did not report it. pct is the fraction of the creator's
   * acquired supply sold via swaps (null = unmeasurable). */
  devSold: {
    pct: number | null;
    acquired: number | null;
    sold: number | null;
    moved: number | null;
    txsChecked: number | null;
    sawCreation: boolean;
    note: string;
  } | null;
  /** Operator components (v2.22, QuantOrb-inspired): connected
   * components of the checked top holders under the cluster link
   * set (shared first funder, creator-funded, direct transfer),
   * pctSupply in % of TOTAL supply. Null when the script did not
   * report them — the operator analysis is then unavailable, never
   * zeroed. See packages/signals/src/operator.ts. */
  operators: Array<{ members: string[]; pctSupply: number; count: number }> | null;
}

/** Token-2022 extension flags for one mint, measured from the mint
 * account itself (Helius getAccountInfo, jsonParsed). isToken2022
 * false means the plain SPL Token program: all four flags are
 * false by construction, measured, with the program id as
 * evidence — never unknown. */
export interface Token2022Flags {
  isToken2022: boolean;
  transferFee: boolean;
  transferHook: boolean;
  permanentDelegate: boolean;
  pause: boolean;
  /** Owner program id of the mint account (the evidence). */
  program: string;
}

/** Pure parse of a Helius getAccountInfo (jsonParsed) response for
 * a mint account. Returns null on a malformed response or an
 * unrecognised owner program — the caller treats that as unknown,
 * never as "no extensions". Extension presence is the flag: a
 * transferFeeConfig at 0 bps still counts (its authority can raise
 * it), as does a transferHook with a null programId. Validated live
 * 2026-11-23: USDC (SPL, no extensions key) -> all false;
 * PyUSD (Token-2022, permanentDelegate + transferFeeConfig +
 * transferHook + others) -> those three true, pause false. */
export function parseToken2022Account(data: unknown): Token2022Flags | null {
  const value = (data as { result?: { value?: Record<string, unknown> | null } } | null)?.result?.value;
  if (!value || typeof value !== "object") return null;
  const owner = value.owner;
  if (typeof owner !== "string" || owner === "") return null;
  const dataField = value.data as { program?: unknown; parsed?: { info?: { extensions?: unknown } } } | null;
  if (!dataField || typeof dataField !== "object") return null;
  const extensions = dataField.parsed?.info?.extensions;
  if (owner === SPL_TOKEN_PROGRAM) {
    return { isToken2022: false, transferFee: false, transferHook: false, permanentDelegate: false, pause: false, program: owner };
  }
  if (owner !== TOKEN_2022_PROGRAM) return null;
  if (!Array.isArray(extensions)) return null;
  const names = new Set<string>();
  for (const e of extensions) {
    const name = (e as { extension?: unknown } | null)?.extension;
    if (typeof name === "string") names.add(name);
  }
  return {
    isToken2022: true,
    transferFee: names.has("transferFeeConfig"),
    transferHook: names.has("transferHook"),
    permanentDelegate: names.has("permanentDelegate"),
    // The parsed extension name is "pausable"; accept the
    // "pausableConfig" spelling too (Rugcheck's token_extensions
    // uses it) so neither spelling is ever read as "no pause".
    pause: names.has("pausable") || names.has("pausableConfig"),
    program: owner,
  };
}

/** Run the Helius getAccountInfo check for one mint. Returns null
 * on any failure or malformed response — fail-closed, the caller
 * blocks on unmeasured Token-2022 flags. One RPC call (1 credit)
 * per would-be entry, via the registered helius.py helper. */
export async function checkToken2022(mint: string): Promise<Token2022Flags | null> {
  try {
    const { stdout } = await execFileAsync("python3", [HELIUS_CHECK, "account", "--address", mint], { timeout: 30000 });
    return parseToken2022Account(JSON.parse(stdout) as unknown);
  } catch {
    return null;
  }
}

export interface OkxSignal {
  bundlers: string | null;
  bundlerAthPercent: string | null;
  devTokens: string | null;
  devRugs: string | null;
  devHoldingPercent: string | null;
  top10Percent: string | null;
  insidersPercent: string | null;
  snipersPercent: string | null;
  freshWalletsPercent: string | null;
  phishingPercent: string | null;
  totalHolders: string | null;
  clusterConcentration: string | null;
  holderSameFundSourcePercent: string | null;
}

/** Run the OKX bundle/dev/details/cluster reads (v2.5). LOGGED SIGNAL
 * ONLY for every field, INCLUDING cluster concentration (SOUL audit
 * fix v2.18, 2026-11-23 — the v2.14 hard gate is DEMOTED): OKX labels
 * were inverted against paper outcomes (KYC passed, Betty flagged),
 * so no OKX field is ever trusted as a gate or a haircut. Helius is
 * the cluster authority. isOkxClusterGateBlock stays exported for
 * replay analysis only. Returns null only if every OKX call fails.
 * A null result is logged as okx_failed, never a block. */
export async function checkOkx(mint: string): Promise<OkxSignal | null> {
  const run = async (cmd: string): Promise<Record<string, unknown> | null> => {
    try {
      const { stdout } = await execFileAsync("python3", [OKX_CHECK, cmd, "--mint", mint], { timeout: 30000 });
      const parsed = JSON.parse(stdout) as { code?: string; data?: Record<string, unknown> };
      if (parsed.code !== "0" || !parsed.data) return null;
      return parsed.data;
    } catch {
      return null;
    }
  };
  const [bundle, dev, details, cluster] = await Promise.all([run("bundle"), run("dev"), run("details"), run("cluster")]);
  if (!bundle && !dev && !details && !cluster) return null;
  const devHold = dev?.devHoldingInfo as Record<string, unknown> | undefined;
  const devLaunched = dev?.devLaunchedInfo as Record<string, unknown> | undefined;
  const tags = details?.tags as Record<string, unknown> | undefined;
  const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
  return {
    bundlers: str(bundle?.totalBundlers),
    bundlerAthPercent: str(bundle?.bundlerAthPercent),
    devTokens: str(devLaunched?.totalTokens),
    devRugs: str(devLaunched?.rugPullCount),
    devHoldingPercent: str(devHold?.devHoldingPercent),
    top10Percent: str(tags?.top10HoldingsPercent),
    insidersPercent: str(tags?.insidersPercent),
    snipersPercent: str(tags?.snipersPercent),
    freshWalletsPercent: str(tags?.freshWalletsPercent),
    phishingPercent: str(tags?.suspectedPhishingWalletPercent),
    totalHolders: str(tags?.totalHolders),
    clusterConcentration: str(cluster?.ClusterConcentration),
    holderSameFundSourcePercent: str(cluster?.holderSameFundSourcePercent),
  };
}

/** Run the Helius funder-cluster check. Returns null on any failure
 * or on a malformed response (clustered must be a boolean, checked /
 * unknown finite numbers), fail-closed: the caller blocks. */
export async function checkCluster(mint: string, holders: Array<{ owner: string; pct: number }>, creator: string): Promise<ClusterResult | null> {
  try {
    const { stdout } = await execFileAsync("python3", [CLUSTER_CHECK, "--mint", mint, "--holders", JSON.stringify(holders), "--creator", creator || ""], { timeout: 60000 });
    const parsed = JSON.parse(stdout) as Partial<ClusterResult>;
    if (
      typeof parsed.clustered !== "boolean" ||
      typeof parsed.checked !== "number" ||
      !Number.isFinite(parsed.checked) ||
      typeof parsed.unknown !== "number" ||
      !Number.isFinite(parsed.unknown)
    ) {
      return null;
    }
    // Measured fields (v2.19): defensive — an older script (or a
    // malformed one) that omits them yields null, never 0: a
    // missing linkedPct/devSold is unknown, and the stage-B rug
    // re-evaluation blocks on it.
    const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
    const devSoldRaw = (parsed as { devSold?: Record<string, unknown> | null }).devSold;
    // Operator components (v2.22): defensive — a script that omits
    // them yields null, never an empty list passed off as measured.
    // A group is kept only when all three fields validate.
    let operators: ClusterResult["operators"] = null;
    const opsRaw = (parsed as { operators?: unknown }).operators;
    if (Array.isArray(opsRaw)) {
      const groups: NonNullable<ClusterResult["operators"]> = [];
      for (const g of opsRaw) {
        const gg = g as Record<string, unknown>;
        if (!Array.isArray(gg.members) || !gg.members.every((m) => typeof m === "string")) continue;
        if (typeof gg.pctSupply !== "number" || !Number.isFinite(gg.pctSupply)) continue;
        if (typeof gg.count !== "number" || !Number.isFinite(gg.count)) continue;
        groups.push({ members: gg.members as string[], pctSupply: gg.pctSupply, count: gg.count });
      }
      operators = groups;
    }
    return {
      clustered: parsed.clustered,
      reason: typeof parsed.reason === "string" ? parsed.reason : "",
      checked: parsed.checked,
      unknown: parsed.unknown,
      sharedFunders: Array.isArray(parsed.sharedFunders) ? parsed.sharedFunders : [],
      linkedPct: num((parsed as { linkedPct?: unknown }).linkedPct),
      operators,
      devSold:
        devSoldRaw && typeof devSoldRaw === "object"
          ? {
              pct: num(devSoldRaw.pct),
              acquired: num(devSoldRaw.acquired),
              sold: num(devSoldRaw.sold),
              moved: num(devSoldRaw.moved),
              txsChecked: num(devSoldRaw.txsChecked),
              sawCreation: devSoldRaw.sawCreation === true,
              note: typeof devSoldRaw.note === "string" ? devSoldRaw.note : "",
            }
          : null,
    };
  } catch {
    return null;
  }
}

/** Wash share from Jupiter Tokens API stats1h (v2.19): the
 * non-organic share of 1h volume, 1 - (organic buy+sell) /
 * (total buy+sell). Null unless all four volumes are finite
 * numbers and total volume > 0 — a dead/inactive token returns
 * null organic fields, which is unknown, not 0% wash. Formula
 * validated live 2026-11-23: Pikachu 0.975 (buy 13634 + sell
 * 10713, organic 297 + 304). LIMITS: Jupiter's "organic" is
 * their proprietary wash/bot filter — the number measures
 * Jupiter-classified organic share, not ground-truth wash; and
 * for fresh pump.fun launches it is 0.97-0.99 for every token
 * measured (n=4), so the standing >50% wash block in evaluateRug
 * fires on essentially all live candidates until that threshold
 * is recalibrated from real data. Do not lower the threshold here
 * — it is desk policy, and n=4 cannot calibrate it. */
export function washPctFromJupiterStats(stats: JupiterTokenStats | null): number | null {
  const s1 = stats?.stats1h ?? null;
  if (!s1) return null;
  const buy = s1.buyVolume;
  const sell = s1.sellVolume;
  const buyOrg = s1.buyOrganicVolume;
  const sellOrg = s1.sellOrganicVolume;
  if (
    typeof buy !== "number" || !Number.isFinite(buy) ||
    typeof sell !== "number" || !Number.isFinite(sell) ||
    typeof buyOrg !== "number" || !Number.isFinite(buyOrg) ||
    typeof sellOrg !== "number" || !Number.isFinite(sellOrg)
  ) {
    return null;
  }
  const total = buy + sell;
  if (total <= 0) return null;
  const organic = buyOrg + sellOrg;
  if (organic < 0 || organic > total) return null;
  return 1 - organic / total;
}

/** Buy/sell volume ratio from Jupiter Tokens API stats1h (v2.20):
 * buyVolume / sellVolume over the last hour. Null unless both
 * volumes are finite numbers and sellVolume > 0 — a token with no
 * sells yet is too young to judge, and that is unknown (0 points),
 * not a ratio. Money-weighted: volume, not trade count, because
 * dollars are what move the price. LIMITS: on a pump.fun bonding
 * curve buy and sell volume are usually near-equal (the curve
 * itself is the counterparty), so fresh tokens typically score
 * ~0 here; a ratio >= 2 (full 20 points in scoreGem) means real
 * one-sided buy pressure. Validated live 2026-11-24 ~00:05 SAST
 * (n=30 fresh tokens): computable for 24/30; the 6 misses are
 * tokens with no sellVolume yet. */
export function buySellRatioFromJupiterStats(stats: JupiterTokenStats | null): number | null {
  const s1 = stats?.stats1h ?? null;
  if (!s1) return null;
  const buy = s1.buyVolume;
  const sell = s1.sellVolume;
  if (
    typeof buy !== "number" || !Number.isFinite(buy) || buy < 0 ||
    typeof sell !== "number" || !Number.isFinite(sell) || sell <= 0
  ) {
    return null;
  }
  return buy / sell;
}

/** Unique-buyer growth % from Jupiter Tokens API stats1h (v2.20):
 * stats1h.holderChange IS the % change in holder count over the
 * last hour — passed through, not derived. Null unless finite.
 * A negative value is MEASURED (the holder base shrank) and scores
 * 0 via scoreGem's clamp; it is not unknown. LIMITS: small-base
 * effect — a 1 -> 4 holder move reads +300% and maxes the
 * component (25 points) on 3 new wallets; and Jupiter publishes
 * no exact definition of holderChange, so the pass-through rests
 * on live verification against holderCount (2026-11-24 ~00:05
 * SAST: holderCount 5 with +66.7% = 3 -> 5 holders; holderCount 1
 * with -66.7% = 3 -> 1; holderCount 4 with +100% = 2 -> 4).
 * Coverage live: present for 12/30 fresh tokens — absent means
 * 0 points, never a block. */
export function uniqueBuyerGrowthPctFromJupiterStats(stats: JupiterTokenStats | null): number | null {
  const h = stats?.stats1h?.holderChange ?? null;
  if (typeof h !== "number" || !Number.isFinite(h)) return null;
  return h;
}

/** New-wallet inflow from Jupiter Tokens API stats1h (v2.20):
 * stats1h.numNetBuyers — the count of wallets that were net
 * buyers in the last hour. Units: wallets (scoreGem divides by 2
 * and caps at 15, so 30+ net-buyer wallets maxes the component).
 * Null unless a finite number >= 0. LIMITS, stated plainly:
 * Jupiter exposes no strict new-wallet count, so this is wallet
 * INFLOW, not a strict new-wallet count — a returning wallet that
 * net-buys in the hour is included. For a fresh token the 1h
 * window is the token's whole life, so it measures early buyer
 * inflow. Coverage live 2026-11-24 ~00:05 SAST: present for
 * 27/30 fresh tokens. */
export function newWalletInflowFromJupiterStats(stats: JupiterTokenStats | null): number | null {
  const n = stats?.stats1h?.numNetBuyers ?? null;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return null;
  return n;
}

/** Stage-A gem flow from one Jupiter token-stats row (v2.21,
 * pure — testable): the three flow components the stage-A gem
 * gate scores, extracted from the single pre-gate fetch. A null
 * stats row (fetch failed / Jupiter does not know the mint)
 * yields all three null — 0 points, never invented values. */
export function stageAFlowFromJupiterStats(stats: JupiterTokenStats | null): {
  uniqueBuyerGrowthPct: number | null;
  buySellRatio: number | null;
  newWalletInflow: number | null;
} {
  return {
    uniqueBuyerGrowthPct: uniqueBuyerGrowthPctFromJupiterStats(stats),
    buySellRatio: buySellRatioFromJupiterStats(stats),
    newWalletInflow: newWalletInflowFromJupiterStats(stats),
  };
}

/** Bundle share from a Helius cluster result (v2.19): the
 * funder-linked % of total supply as a 0-1 fraction. Null when the
 * cluster result is null or carries no linkedPct — never 0. */
export function bundlePctFromCluster(cluster: ClusterResult | null): number | null {
  if (!cluster || cluster.linkedPct === null || cluster.linkedPct === undefined) return null;
  if (!Number.isFinite(cluster.linkedPct) || cluster.linkedPct < 0) return null;
  return cluster.linkedPct / 100;
}

/** Dev-sold share from a Helius cluster result (v2.19): the
 * fraction of the creator's acquired supply sold via swaps. Null
 * when unmeasured. A measured 0 stays 0 — it is not unknown. */
export function devSoldPctFromCluster(cluster: ClusterResult | null): number | null {
  const pct = cluster?.devSold?.pct ?? null;
  if (pct === null || pct === undefined) return null;
  if (!Number.isFinite(pct) || pct < 0 || pct > 1) return null;
  return pct;
}

/** Stage-B journal note (v2.20, pure — testable): every measured
 * value with its source, so a later reader can see where each
 * number came from. Wash is journaled here even though it is
 * logged-only (it never gates); the three gem flow components are
 * journaled too. A null is always written as "unknown
 * (...source...)" — never as 0. */
export function stageBMeasuredNote(
  measured: {
    bundlePct: number | null;
    devSoldPct: number | null;
    washPct: number | null;
    token2022: Token2022Flags | null;
    uniqueBuyerGrowthPct: number | null;
    buySellRatio: number | null;
    newWalletInflow: number | null;
  },
  devSold: ClusterResult["devSold"],
): string {
  const devNote = devSold
    ? " n=" + devSold.txsChecked + " acquired=" + Math.round(devSold.acquired ?? 0) + " sold=" + Math.round(devSold.sold ?? 0) + " moved=" + Math.round(devSold.moved ?? 0) + (devSold.sawCreation ? " creation-seen" : " creation-outside-window")
    : "";
  return (
    "measured: bundle=" + (measured.bundlePct === null ? "unknown (helius cluster linkedPct)" : (measured.bundlePct * 100).toFixed(1) + "% helius-cluster-linked") +
    " devSold=" + (measured.devSoldPct === null ? "unknown (helius creator txs)" : (measured.devSoldPct * 100).toFixed(1) + "% helius-creator-txs" + devNote) +
    " wash=" + (measured.washPct === null ? "unknown (jupiter stats1h organic, logged-only)" : (measured.washPct * 100).toFixed(1) + "% jupiter-stats1h-organic, logged-only") +
    " token2022=" + (measured.token2022 === null ? "unknown (helius getAccountInfo)" : measured.token2022.isToken2022 ? "Token-2022 fee=" + measured.token2022.transferFee + " hook=" + measured.token2022.transferHook + " delegate=" + measured.token2022.permanentDelegate + " pause=" + measured.token2022.pause : "SPL (all flags false)") +
    " gemFlow=" +
    " growth=" + (measured.uniqueBuyerGrowthPct === null ? "unknown (jupiter stats1h holderChange)" : measured.uniqueBuyerGrowthPct.toFixed(1) + "% jupiter-stats1h-holderChange") +
    " buySell=" + (measured.buySellRatio === null ? "unknown (jupiter stats1h volumes)" : measured.buySellRatio.toFixed(2) + " jupiter-stats1h-volumes") +
    " inflow=" + (measured.newWalletInflow === null ? "unknown (jupiter stats1h numNetBuyers)" : Math.round(measured.newWalletInflow) + " jupiter-stats1h-numNetBuyers")
  );
}
export const FOMO_FEED_PATH = "/home/hatch/workspace/goals/solana-memecoin-flipping-system/hidden_files/fomo-feed.json";
export const FOMO_ALERTS_PATH = "/home/hatch/workspace/goals/solana-memecoin-flipping-system/hidden_files/fomo-alerts.json";
export const TRUSTED_WALLETS_PATH = "/home/hatch/workspace/goals/solana-memecoin-flipping-system/hidden_files/validated-smart-wallets.json";
const SOL_MINT = "So11111111111111111111111111111111111111112";

/** Acquire the shared spotter/watcher lock dir. A lock older than
 * `staleMs` is orphaned and reclaimed: both crons wrap runs in
 * `timeout 180` (spotter) / `timeout 60` (watcher), so no live run
 * can legitimately hold a lock for 5 minutes. Without this, a run
 * killed mid-poll left the lock dir behind and every later poll
 * skipped silently forever — the same failure mode as the v2.4
 * maxTradesPerDay bug (dead spotter, no journal). Returns true when
 * the lock is held by the caller, false when a live run holds it.
 * `reclaimed` is true when a stale lock was removed.
 *
 * SOUL audit fix (2026-11-23): the lock carries an owner token
 * (pid + random + timestamp) written into the dir on acquire, and
 * releaseLock removes the dir ONLY when the token matches — a
 * caller must never delete a lock by path blindly (the old
 * spotter-run/watcher-run catch handlers did `rmSync` after the
 * `finally` had already released it, which could delete a NEW lock
 * taken by the next invocation). A stale lock is reclaimed only
 * after re-statting the dir and confirming the same inode/mtime,
 * so two processes racing the reclaim cannot both remove it. */
export function acquireLock(lockPath: string, staleMs = 5 * 60 * 1000): { held: boolean; reclaimed: boolean; token: string | null } {
  const token = process.pid + ":" + Math.random().toString(36).slice(2) + ":" + Date.now();
  const writeToken = (): boolean => {
    try {
      writeFileSync(join(lockPath, "owner"), token, "utf8");
      return true;
    } catch {
      return false;
    }
  };
  // Try to create the lock dir. If it already exists, it belongs to
  // another run — never delete it here; only the stale path below may
  // remove a lock, and only after re-statting it.
  try {
    mkdirSync(lockPath);
  } catch {
    // Dir already exists: live run, or orphan from a killed run.
    try {
      const before = statSync(lockPath);
      if (Date.now() - before.mtimeMs > staleMs) {
        // Re-stat immediately before removal: reclaim only if it is
        // still the same directory we just statted.
        const again = statSync(lockPath);
        if (again.ino === before.ino && again.mtimeMs === before.mtimeMs) {
          rmSync(lockPath, { recursive: true, force: true });
          mkdirSync(lockPath);
          if (!writeToken()) {
            try {
              rmSync(lockPath, { recursive: true, force: true });
            } catch {
              // Best effort; the dir is ours and empty of a token.
            }
            return { held: false, reclaimed: false, token: null };
          }
          return { held: true, reclaimed: true, token };
        }
      }
    } catch {
      // Lost a race with the other process; treat as held by it.
    }
    return { held: false, reclaimed: false, token: null };
  }
  if (!writeToken()) {
    // We created the dir but could not write the owner token — remove
    // OUR dir so the next run is not blocked by a tokenless lock.
    try {
      rmSync(lockPath, { recursive: true, force: true });
    } catch {
      // Best effort.
    }
    return { held: false, reclaimed: false, token: null };
  }
  return { held: true, reclaimed: false, token };
}

/** Release a lock acquired by acquireLock. Removes the dir ONLY when
 * the owner token inside matches — never delete a lock by path
 * blindly. A null token or a token mismatch means the lock is not
 * ours (or already gone): do nothing. */
export function releaseLock(lockPath: string, token: string | null): void {
  if (!token) return;
  try {
    const owner = readFileSync(join(lockPath, "owner"), "utf8");
    if (owner !== token) return; // someone else's lock — never delete it
    rmSync(lockPath, { recursive: true, force: true });
  } catch {
    // Already gone (stale-reclaimed by the next run, or never made).
  }
}

/** Fill in counters/fields that are missing or null in a loaded
 * state.json (e.g. alertBoosts: null in the live $10 state, or a
 * state written before a counter existed). Never resets real values,
 * never touches positions/seen/equity. Call after every loadState. */
export function normalizeState(state: SpotterState): SpotterState {
  const num = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
  // Every plain numeric counter defaults to 0 when missing/null.
  // (tradesToday falls back to cumulative trades; solPriceUsd falls
  // back to 0 — no live price yet, never an invented one; equity
  // falls back to the profile's start equity.)
  const numericKeys = [
    "trades", "wins", "losses", "blocked", "priceSourceLostCloses",
    "grossWinsUsd", "grossLossesUsd", "jupiterRescues", "clusterBlocks",
    "cabalBlocks", "okxSignals", "alertBoosts", "sentimentSignals",
    "riskHaircuts", "okxClusterGateBlocks", "holderFloorBlocks",
    "liquidityFloorBlocks", "sellSimBlocks", "sellSimTransient",
    "coBuySignals", "wsCoinsSeen", "polls", "cooldownSkips",
    "holderExitSignals", "exitGradeSignals",
  ] as const;
  for (const k of numericKeys) state[k] = num(state[k], 0);
  state.tradesToday = num(state.tradesToday, state.trades);
  state.worstLossPct = num(state.worstLossPct, 0);
  state.solPriceUsd = num(state.solPriceUsd, 0);
  state.equityUsd = num(state.equityUsd, MICRO_PROFILE.startEquityUsd);
  if (!Array.isArray(state.positions)) state.positions = [];
  if (state.seen == null || typeof state.seen !== "object") state.seen = {};
  if (state.closedMints == null || typeof state.closedMints !== "object") state.closedMints = {};
  if (state.blockedMints == null || typeof state.blockedMints !== "object") state.blockedMints = {};
  for (const p of state.positions) {
    p.missedPolls = num(p.missedPolls, 0);
    if (typeof p.lastMcUsd !== "number" || !Number.isFinite(p.lastMcUsd)) p.lastMcUsd = p.entryMcUsd;
  }
  // v2.25: grading flags on closed-mint records default to false;
  // a record without entryMcUsd predates grading and is skipped
  // silently by finalizeExitGradeNow (marked graded, no line).
  for (const rec of Object.values(state.closedMints)) {
    rec.postExitSeen = rec.postExitSeen === true;
    rec.graded = rec.graded === true;
    if (typeof rec.postExitPeakMcUsd !== "number" || !Number.isFinite(rec.postExitPeakMcUsd)) rec.postExitPeakMcUsd = rec.exitMcUsd;
  }
  return state;
}

/** Re-entry cooldown (v2.10): a mint that just closed may not be
 * entered again within this long. 30 minutes covers the two losing
 * re-entries in this run (2.5 min and 16 min after close) and keeps
 * the one winning re-entry (35 min after close) legal. */
export const REENTRY_COOLDOWN_MS = 30 * 60 * 1000;

/** Record a close so the cooldown can see it. Called on every close
 * path: the spotter exit loop, the 1-min watcher, and halt settles.
 * exitMcUsd is the mc the position closed at (last seen mc for a
 * halt settle). v2.25: `details` (from gradeClose) stores the grading
 * inputs on the record; without details the record keeps the old bare
 * shape. If an ungraded record for the same mint already exists, it
 * is finalised first (its tracking window is over — the mint just
 * closed again) so the new close never silently drops a grade.
 * journalPath defaults to null (no journaling): callers pass the
 * live path; tests pass a temp path or none. */
export function recordClosedMint(
  state: SpotterState,
  mint: string,
  exitMcUsd: number,
  nowMs: number,
  reason: string,
  details?: { entryMcUsd: number; peakMcUsd: number; exitCostBasisUsd: number; exitQuality: ExitQuality; sizePct: number | null; sizePctFlagged: boolean },
  journalPath: string | null = null,
): void {
  if (!state.closedMints || typeof state.closedMints !== "object") state.closedMints = {};
  finalizeExitGradeNow(state, mint, nowMs, journalPath, "superseded by new close");
  const rec: ClosedMint = { closedAtMs: nowMs, exitMcUsd, reason };
  if (details) {
    rec.entryMcUsd = details.entryMcUsd;
    rec.peakMcUsd = details.peakMcUsd;
    rec.exitCostBasisUsd = details.exitCostBasisUsd;
    rec.postExitPeakMcUsd = exitMcUsd;
    rec.postExitSeen = false;
    rec.graded = false;
    rec.exitQuality = details.exitQuality;
    rec.sizePct = details.sizePct;
    rec.sizePctFlagged = details.sizePctFlagged;
  }
  state.closedMints[mint] = rec;
}

/** Finalise one ungraded closed-mint record now (v2.25): compute the
 * final grade from the stored inputs + post-exit tracking so far,
 * journal one exit_grade line, mark graded, count it. Records that
 * predate grading (no entryMcUsd) are marked graded silently — there
 * is nothing honest to grade them with, and no line is written.
 * A null journalPath still marks graded (probe ticks run on a
 * discarded clone, so no line is lost). Pure state + one journal
 * line; never a gate, never an exit. */
export function finalizeExitGradeNow(state: SpotterState, mint: string, nowMs: number, journalPath: string | null, reason: string): void {
  const rec = state.closedMints?.[mint];
  if (!rec || rec.graded) return;
  if (typeof rec.entryMcUsd !== "number" || !(rec.entryMcUsd > 0)) {
    rec.graded = true;
    return;
  }
  const g = finalizeExitGrade(
    rec.entryMcUsd,
    rec.exitMcUsd,
    rec.peakMcUsd ?? rec.exitMcUsd,
    rec.postExitSeen ? (rec.postExitPeakMcUsd ?? rec.exitMcUsd) : null,
    rec.postExitSeen === true,
    rec.exitCostBasisUsd ?? 0,
  );
  rec.graded = true;
  rec.exitQuality = g.exitQuality;
  state.exitGradeSignals = (state.exitGradeSignals ?? 0) + 1;
  if (journalPath !== null) {
    appendJournal(
      journalPath,
      journalEntry(mint, "exit_grade", `exit graded ${g.exitQuality} (${reason})`, {
        price: rec.exitMcUsd,
        equityUsd: state.equityUsd,
        exitQuality: g.exitQuality,
        leftOnTablePct: g.leftOnTablePct,
        leftOnTableUsd: g.leftOnTableUsd,
        leftOnTableReason: g.leftOnTableReason,
        sizePct: rec.sizePct ?? null,
        sizePctFlagged: rec.sizePctFlagged ?? false,
      }),
    );
  }
}

/** Post-exit tracking for one poll (v2.25): for every ungraded close
 * still inside its 120-min window, raise its post-exit peak from the
 * mints visible in this poll's discovery feed (seenMc: mint -> mc,
 * built from byMint + the Jupiter fallback map); finalise it when
 * the window has closed. Mints that left the feed are simply not
 * updated — a missing post-exit price stays missing, never invented.
 * Called once per poll, after the exit loop. */
export function updatePostExitTracking(state: SpotterState, seenMc: Map<string, number>, nowMs: number, journalPath: string | null = JOURNAL_PATH): void {
  if (!state.closedMints) return;
  for (const [mint, rec] of Object.entries(state.closedMints)) {
    if (rec.graded) continue;
    const mc = seenMc.get(mint);
    if (typeof mc === "number" && mc > 0) {
      rec.postExitSeen = true;
      rec.postExitPeakMcUsd = Math.max(rec.postExitPeakMcUsd ?? rec.exitMcUsd, mc);
    }
    if (nowMs - rec.closedAtMs >= POST_EXIT_TRACK_MS) {
      finalizeExitGradeNow(state, mint, nowMs, journalPath, "120-min post-exit window closed");
    }
  }
}

/** The closed-mint record blocking a re-entry right now, or null.
 * Blocked only while the close is inside the cooldown window. */
export function isReentryBlocked(state: SpotterState, mint: string, nowMs: number): ClosedMint | null {
  const rec = state.closedMints?.[mint];
  if (!rec) return null;
  if (nowMs - rec.closedAtMs < REENTRY_COOLDOWN_MS) return rec;
  return null;
}

/** Drop closed-mint records older than 24h, same window as the seen
 * pruning, so state.json does not grow without bound. */
export function pruneClosedMints(state: SpotterState, nowMs: number): void {
  if (!state.closedMints) return;
  for (const [mint, rec] of Object.entries(state.closedMints)) {
    if (nowMs - rec.closedAtMs > 24 * 60 * 60 * 1000) delete state.closedMints[mint];
  }
}

/** Blocked-mint cooldown (v2.23): a mint blocked at deep-check is not
 * re-checked until the cooldown expires. Diagnosis 2026-11-24: 53% of
 * deep-checks were re-checks of already-blocked mints (top mint 39x),
 * so ~half the 8-slot slice was spent re-proving the same rejections
 * while fresh coins waited. The cooldown is a slice-efficiency fix
 * only — no gate or bar changes. Two tiers: a full 60 minutes for
 * risk findings (Rugcheck score, concentration, gem, cluster,
 * Cabal, sell-sim), 15 minutes for near-miss / data-gap blocks
 * (holder / liquidity floors, cluster-unknown, sell-sim sizing),
 * because those can flip fast as holders and liquidity grow. Either
 * tier ends early when the mc rose a lot since the block (>= 50%,
 * >= 25% near-miss) — a big rise means the picture changed. A fall
 * never ends it early: no gate improves when a mint crashes. */
// v2.27 24h experiment (Newton, 2026-11-24 ~15:09 SAST): fresh-tier
// gem bar 60 -> 50 for 24h, paper only; reverts 2026-11-25 ~15:09 SAST.
// All safety gates unchanged (cluster, dev-sold, Rugcheck score,
// holder/liquidity floors, sell-sim). The 50s band is UNPROVEN —
// history's wins entered at gem 64-84 — this test exists to generate
// paper entries and data, not because 50 is validated. Applied at
// both the stage-A and stage-B fresh-tier checks below.
export const FRESH_TIER_MIN_GEM = 50;
export const BLOCKED_COOLDOWN_MS = 60 * 60 * 1000;
export const NEAR_MISS_COOLDOWN_MS = 15 * 60 * 1000;
export const BLOCKED_MC_RISE_PCT = 50;
export const NEAR_MISS_MC_RISE_PCT = 25;
/** v2.28 permanent tier: a Rugcheck failure that never decays
 * (creator-history danger, live mint/freeze authority) is not
 * re-checked for 24h — the prune window for blockedMints, so the
 * record is dropped just as the cooldown expires. */
export const PERMANENT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
/** v2.28 second-look window: transient Rugcheck failures
 * (concentration / low liquidity) are re-checked when the token
 * is 30-120 min old, in 2 reserved slice slots — see
 * pickSecondLookCandidates. A 30-min-old token is long gone from
 * the newest-200 poll feed, so second-look candidates come from
 * state (blockedMints + seen), not the poll list. */
export const SECOND_LOOK_MIN_AGE_MS = 30 * 60 * 1000;
export const SECOND_LOOK_MAX_AGE_MS = 120 * 60 * 1000;
export const SECOND_LOOK_SLOTS = 2;
/** v2.28: slice size (v2.16 widened 5 -> 8). The main ranking
 * fills 8 minus the second-look coins built this poll. */
export const SLICE_CANDIDATES = 8;

/** Classify a Rugcheck failure as permanent or transient (v2.28),
 * from the already-fetched report — no new data. Permanent: live
 * mint/freeze authority (top-level report fields, not risks), or a
 * danger-level risk naming creator history of rugged tokens (live
 * probes 2026-11-24: raw 9,600-115,200 — that one risk alone
 * exceeds Rugcheck's Danger threshold, and it never decays).
 * Transient: everything else — concentration (single holder /
 * top 10), low liquidity, LP state — which can improve as the
 * token ages. An empty/unknown risk list classifies permanent
 * (fail-closed: longer cooldown, no second look). Only the
 * danger level counts for the name match — a warn-level creator
 * mention is not a creator-history danger. Pure — testable. */
export function classifyRugcheckFailure(report: RugcheckReport): "permanent" | "transient" {
  if (report.mintAuthority !== null && report.mintAuthority !== undefined) return "permanent";
  if (report.freezeAuthority !== null && report.freezeAuthority !== undefined) return "permanent";
  const risks = report.risks ?? [];
  if (risks.length === 0) return "permanent";
  for (const r of risks) {
    if (r.level !== "danger") continue;
    const name = (r.name ?? "").toLowerCase();
    if (name.includes("creator") && (name.includes("rug") || name.includes("history"))) return "permanent";
  }
  return "transient";
}

/** Record a deep-check block so the cooldown can see it. Called on
 * every block path (not on the re-entry block — closedMints already
 * covers that). Overwrites on repeat blocks, so the cooldown always
 * runs from the latest block. v2.28: kind records the Rugcheck-failure
 * class when the caller classified it — "permanent" (24h cooldown)
 * or "transient" (15m cooldown, second-look eligible). Omitted on
 * all other block paths: those records behave exactly as before. */
export function noteBlocked(state: SpotterState, mint: string, nowMs: number, mcUsd: number, nearMiss: boolean, kind?: "permanent" | "transient"): void {
  if (!state.blockedMints || typeof state.blockedMints !== "object") state.blockedMints = {};
  state.blockedMints[mint] = { blockedAtMs: nowMs, mcUsd, nearMiss, ...(kind ? { kind } : {}) };
}

/** Milliseconds of cooldown left for this mint right now, or 0 when
 * it is free to deep-check (never blocked, expired, or mc rose past
 * the tier threshold since the block). Pure — testable. v2.28: the
 * window is 24h for a permanent Rugcheck failure, 15m for a
 * near-miss / transient failure, 60m otherwise. A permanent block
 * never ends early on an mc rise — creator history / live
 * mint-freeze authority does not improve when the price rises. */
export function blockedCooldownRemaining(state: SpotterState, mint: string, nowMs: number, mcUsd: number): number {
  const rec = state.blockedMints?.[mint];
  if (!rec) return 0;
  const windowMs = rec.kind === "permanent" ? PERMANENT_COOLDOWN_MS : rec.nearMiss ? NEAR_MISS_COOLDOWN_MS : BLOCKED_COOLDOWN_MS;
  const elapsed = nowMs - rec.blockedAtMs;
  if (elapsed >= windowMs) return 0;
  if (rec.kind !== "permanent") {
    const risePct = rec.mcUsd > 0 && mcUsd > 0 ? ((mcUsd - rec.mcUsd) / rec.mcUsd) * 100 : 0;
    const riseBar = rec.nearMiss ? NEAR_MISS_MC_RISE_PCT : BLOCKED_MC_RISE_PCT;
    if (risePct >= riseBar) return 0;
  }
  return windowMs - elapsed;
}

/** Drop blocked-mint records older than 24h, same window as the seen
 * pruning, so state.json does not grow without bound. */
export function pruneBlockedMints(state: SpotterState, nowMs: number): void {
  if (!state.blockedMints) return;
  for (const [mint, rec] of Object.entries(state.blockedMints)) {
    if (nowMs - rec.blockedAtMs > 24 * 60 * 60 * 1000) delete state.blockedMints[mint];
  }
}

/** v2.28 pre-slice cooldown filter (P1): drop ranked candidates
 * whose blocked-mint cooldown has not expired, BEFORE slicing, so
 * the top-8 slice holds 8 fresh candidates instead of ~5.1 (36%
 * of slice slots were burned on cooldown skips). Uses the same
 * blockedCooldownRemaining as the in-loop check, so semantics
 * match exactly — the in-loop check stays as a safety net. Pure. */
export function filterCooldownBlocked<T extends { coin: PumpCoin }>(ranked: T[], state: SpotterState, nowMs: number): T[] {
  return ranked.filter((c) => blockedCooldownRemaining(state, c.coin.mint, nowMs, c.coin.usd_market_cap ?? 0) === 0);
}

/** v2.28 second-look candidates (P2): transient-blocked mints ready
 * for a re-check at age 30-120 min. Oldest first-seen first (FIFO),
 * at most maxN. A mint qualifies only when: its block was classified
 * transient; its 15m transient cooldown has expired; its seen record
 * carries the creator + bonding-curve addresses needed to rebuild
 * the exact PumpCoin (records predating v2.28 lack them and are
 * skipped — fail-safe); it is not an open position and not
 * re-entry-blocked. Permanent blocks, unclassified blocks and
 * non-Rugcheck blocks are never eligible. Pure — testable. */
export function pickSecondLookCandidates(state: SpotterState, nowMs: number, maxN = SECOND_LOOK_SLOTS): string[] {
  const eligible = Object.entries(state.blockedMints ?? {})
    .filter(([mint, rec]) => {
      if (rec.kind !== "transient") return false;
      const seen = state.seen?.[mint];
      if (!seen) return false;
      const ageMs = nowMs - seen.firstSeenMs;
      if (ageMs < SECOND_LOOK_MIN_AGE_MS || ageMs > SECOND_LOOK_MAX_AGE_MS) return false;
      if (blockedCooldownRemaining(state, mint, nowMs, seen.lastMcUsd ?? 0) > 0) return false;
      if (!seen.creator || !seen.bondingCurve || !seen.associatedBondingCurve) return false;
      if (state.positions.some((p) => p.mint === mint)) return false;
      if (isReentryBlocked(state, mint, nowMs)) return false;
      return true;
    })
    .sort((a, b) => (state.seen[a[0]].firstSeenMs ?? 0) - (state.seen[b[0]].firstSeenMs ?? 0));
  return eligible.slice(0, maxN).map(([mint]) => mint);
}

/** v2.28 rebuild a PumpCoin for a second-look re-check from the
 * seen record + a fresh Jupiter mc. created_timestamp is firstSeenMs
 * (receipt time — seconds after launch for WS-discovered coins, so
 * the age the poll computes from it matches the eligibility window);
 * last_trade_timestamp is now (the re-check does not re-prove
 * recency — the deep check re-scores gem + Rugcheck fresh, and the
 * trade-age filter does not apply to second-look coins). Returns
 * null when the seen record lacks the rebuild fields. Pure. */
export function buildSecondLookCoin(state: SpotterState, mint: string, mcUsd: number, nowMs: number): PumpCoin | null {
  const seen = state.seen?.[mint];
  if (!seen || !seen.creator || !seen.bondingCurve || !seen.associatedBondingCurve) return null;
  return {
    mint,
    name: seen.name,
    symbol: seen.symbol,
    creator: seen.creator,
    created_timestamp: seen.firstSeenMs,
    last_trade_timestamp: nowMs,
    ath_market_cap: Math.max(seen.firstMcUsd, mcUsd),
    usd_market_cap: mcUsd,
    complete: seen.complete,
    associated_bonding_curve: seen.associatedBondingCurve,
    bonding_curve: seen.bondingCurve,
    discoveredVia: "second-look",
  };
}

/** v2.28 stage-A gem instrumentation (P6): the flow components
 * behind a stage-A gem block, journaled with the block so
 * calibration no longer has to infer which component binds.
 * Zero new calls — every value is already in hand at stage A.
 * Null components print as null (unmeasured scores 0). Pure. */
export function stageAFlowNote(
  flow: { uniqueBuyerGrowthPct: number | null; buySellRatio: number | null; newWalletInflow: number | null },
  mcVelPct: number,
  smartMoneyWallets: number,
  fomoWallets: number,
  alertBuy: boolean,
): string {
  const fmt = (v: number | null, suffix = ""): string => (v === null ? "null" : String(Math.round(v * 100) / 100) + suffix);
  return (
    "flow: buySell=" + fmt(flow.buySellRatio) +
    " holderChg=" + fmt(flow.uniqueBuyerGrowthPct, "%") +
    " netBuyers=" + fmt(flow.newWalletInflow) +
    " mcVel=" + fmt(mcVelPct, "%") +
    " sm=" + smartMoneyWallets + "/" + fomoWallets +
    " alert=" + (alertBuy ? "yes" : "no")
  );
}

/** Live SOL price in USD from Jupiter, keyless. Null on any failure —
 * the caller must fail-closed (skip the poll), never fall back to a
 * hard-coded price. Price v2 on lite-api.jup.ag returned 404
 * intermittently on 2026-11-22, so try api.jup.ag price v3 first,
 * then lite tokens v2 search. */
export async function fetchSolPriceUsd(): Promise<number | null> {
  try {
    const data = (await fetchJson("https://api.jup.ag/price/v3?ids=" + SOL_MINT, 8000)) as Record<string, { usdPrice?: number }>;
    const price = data?.[SOL_MINT]?.usdPrice;
    if (typeof price === "number" && price > 0) return price;
  } catch {
    // Fall through to the tokens search fallback.
  }
  try {
    const tokens = (await fetchJson("https://lite-api.jup.ag/tokens/v2/search?query=" + SOL_MINT, 8000)) as Array<{ id: string; usdPrice?: number }>;
    const hit = tokens?.find((t) => t.id === SOL_MINT);
    if (hit && typeof hit.usdPrice === "number" && hit.usdPrice > 0) return hit.usdPrice;
  } catch {
    // Both sources failed, caller falls back.
  }
  return null;
}

/** Fomo smart-money wallets: wallet -> { trades, pnlUsd }. Empty map when the feed file is missing or stale. */
export function loadFomoWallets(): Map<string, { trades: number; pnlUsd: number }> {
  const out = new Map<string, { trades: number; pnlUsd: number }>();
  try {
    const feed = JSON.parse(readFileSync(FOMO_FEED_PATH, "utf8"));
    for (const w of feed.smartMoneyWallets ?? []) {
      if (w.wallet) out.set(w.wallet, { trades: w.trades ?? 0, pnlUsd: w.pnlUsd ?? 0 });
    }
  } catch {
    // No feed yet, or unreadable: smart money stays 0, spotter continues.
  }
  return out;
}

export interface TrustedWallets {
  wallets: Set<string>;
  handles: Set<string>;
}

/** Validated smart-money wallets (v2.26): the 7 wallets that cleared
 * the Helius per-wallet PnL validation (widened run, ranks 26-50,
 * 30 days, PumpSwap included). File generated from the widened
 * validation JSON — never hand-edited. Empty sets when the file is
 * missing or unreadable: the smart-money bonus then counts 0, the
 * same fail-closed shape as a missing Fomo feed. The path param
 * exists for tests. */
export function loadTrustedWallets(path = TRUSTED_WALLETS_PATH): TrustedWallets {
  const out: TrustedWallets = { wallets: new Set(), handles: new Set() };
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    for (const w of data.wallets ?? []) {
      if (typeof w.wallet === "string" && w.wallet) out.wallets.add(w.wallet);
      if (typeof w.handle === "string" && w.handle) out.handles.add(w.handle);
    }
  } catch {
    // Missing or unreadable: no trusted wallet, no bonus.
  }
  return out;
}

/** Smart-money count from curve-excluded top holders, trusted-only
 * (v2.26): a holder counts only when it is BOTH in the live Fomo
 * feed and in the validated set. fomoWallets is the pre-filter
 * count, so the journal can show trusted/fomo. Pure. */
export function trustedSmartMoney(
  topHolders: Array<{ address: string; pct: number; owner?: string }>,
  curveAddrs: Set<string>,
  fomoWallets: Map<string, { trades: number; pnlUsd: number }>,
  trusted: TrustedWallets,
): { wallets: number; minTrades: number; fomoWallets: number } {
  const fomoHolders = topHolders.filter(
    (h) => h.owner && !curveAddrs.has(h.address) && !curveAddrs.has(h.owner ?? "") && fomoWallets.has(h.owner),
  );
  const trustedHolders = fomoHolders.filter((h) => trusted.wallets.has(h.owner as string));
  return {
    wallets: trustedHolders.length,
    minTrades: trustedHolders.length > 0 ? Math.max(...trustedHolders.map((h) => fomoWallets.get(h.owner as string)!.trades)) : 0,
    fomoWallets: fomoHolders.length,
  };
}

/** Alert traders that are in the validated set (v2.26). The alerts
 * feed carries handles, not wallet addresses, so the join is by
 * handle. Pure. */
export function trustedAlertTraders(traders: string[], trusted: TrustedWallets): string[] {
  return traders.filter((t) => trusted.handles.has(t));
}

export interface FomoAlertBuy { buys: number; usdValue: number | null; newestTs: number; traders: string[]; buysByTrader: Record<string, number> }

/** Fast smart-money buys from the 30-minute alerts feed (v2.6): mint -> buys
 * by tracked smart wallets in the last 60 minutes. Empty map when the
 * alerts file is missing or stale. Only a signal, never a gate on its own. */
export function loadFomoAlerts(nowMs = Date.now()): Map<string, FomoAlertBuy> {
  const out = new Map<string, FomoAlertBuy>();
  try {
    const alerts = JSON.parse(readFileSync(FOMO_ALERTS_PATH, "utf8"));
    for (const b of alerts.smartMoneyBuys ?? []) {
      if (!b.mint || typeof b.ts !== "number" || nowMs - b.ts > 60 * 60 * 1000) continue;
      const prev = out.get(b.mint);
      if (prev) {
        prev.buys += 1;
        prev.usdValue = Math.max(prev.usdValue ?? 0, b.usdValue ?? 0) || null;
        prev.newestTs = Math.max(prev.newestTs, b.ts);
        if (b.trader && !prev.traders.includes(b.trader)) prev.traders.push(b.trader);
        if (b.trader) prev.buysByTrader[b.trader] = (prev.buysByTrader[b.trader] ?? 0) + 1;
      } else {
        out.set(b.mint, { buys: 1, usdValue: b.usdValue ?? null, newestTs: b.ts, traders: b.trader ? [b.trader] : [], buysByTrader: b.trader ? { [b.trader]: 1 } : {} });
      }
    }
  } catch {
    // No alerts file yet, or unreadable: no recency boost, spotter continues.
  }
  return out;
}

export interface FomoRecentBuy { traders: string[]; buys: number }

/** All recent buys (smart or not) from the 30-minute alerts feed,
 * last 60 minutes: mint -> distinct traders. Breadth component for
 * the X-free sentiment tracker (v2.8). Empty map when the alerts
 * file is missing or stale. Only a signal, never a gate. */
export function loadFomoRecentBuys(nowMs = Date.now()): Map<string, FomoRecentBuy> {
  const out = new Map<string, FomoRecentBuy>();
  try {
    const alerts = JSON.parse(readFileSync(FOMO_ALERTS_PATH, "utf8"));
    for (const b of alerts.recentBuys ?? []) {
      if (!b.mint || typeof b.ts !== "number" || nowMs - b.ts > 60 * 60 * 1000) continue;
      const prev = out.get(b.mint);
      if (prev) {
        prev.buys += 1;
        if (b.trader && !prev.traders.includes(b.trader)) prev.traders.push(b.trader);
      } else {
        out.set(b.mint, { traders: b.trader ? [b.trader] : [], buys: 1 });
      }
    }
  } catch {
    // No alerts file yet, or unreadable: no breadth component.
  }
  return out;
}

/** Paper-entry reason tail (v2.11): for a fresh-tier entry the gem
 * reason reads "rug check blocked: ..." because evaluateGem blocks on
 * the concentration flags the tier deliberately allows — the journal
 * then looks like a block was overridden. Say so plainly instead.
 * Entry logic is UNCHANGED: the fresh bucket is 3W/4L net +$1.85 in
 * this run vs the clean bucket 2W/3L net +$0.17, and the worst loss
 * in the bucket was a re-entry (already fixed by the v2.10
 * cooldown), so there is no journal evidence to hard-block
 * concentration for the tier. */
/** Fresh-launch concentration tier (v2): the rug check failed ONLY on
 * concentration flags (top10 / single wallet / bundle), top10 <= 50%,
 * single <= 25%, Rugcheck score <= 20, no danger risk. A clean rug
 * check (failed = []) is NOT the fresh tier — [].every(...) is
 * vacuously true, which used to let a clean-rug candidate with gem
 * score 50-69 in through the tier's score>=50 bypass even though
 * evaluateGem had called it not actionable (v2.12 audit fix; the
 * journal shows no such entry yet — all clean entries scored >= 70 —
 * but the path was live). */
export function isFreshTier(
  failed: string[],
  top10Pct: number | null | undefined,
  singleWalletPct: number | null | undefined,
  rugcheckScore: number,
  dangerRiskCount: number,
): boolean {
  return (
    failed.length > 0 &&
    failed.every((f) => f === "top10_concentration" || f === "single_wallet_concentration" || f === "bundle_concentration") &&
    (top10Pct ?? 1) <= 0.5 &&
    (singleWalletPct ?? 1) <= 0.25 &&
    rugcheckScore <= 20 &&
    dangerRiskCount === 0
  );
}

/** Buy-leg fee in USD for an entry (v2.12 audit fix). The live books
 * only ever charged the SELL leg (legCostSol(..., false) on exits);
 * the buy leg (~3% pool+slippage + fixed) was never deducted, so
 * every trade's P&L was overstated by ~$0.06-0.09 and equity by
 * ~$1.51 over the first 20 entries — restated equity ≈ $7.27, below
 * the $7.50 halt line. paper.ts charges both legs and evaluateGem
 * gates on a 2-leg break-even; the books now match the gate and the
 * docs ("pool fee 1 percent and slippage 2 percent per side"). */
export function entryFeeUsd(sizeUsd: number, solPrice: number): number {
  return legCostSol(sizeUsd / solPrice, LIGHT_FEES, true) * solPrice;
}

/** Elevated-risk size haircut (v2.13). Journal evidence (23 trades,
 * 8W/15L, corrected fee model): the flagged cohort is 0W/8L including
 * BOTH -97% rugs (net -$10.53); the unflagged cohort is 8W/7L (net
 * +$3.50). A trade is flagged when sentiment is cold (< 30) WITH
 * DexScreener volume data present.
 * SOUL audit fix v2.18: the old leg (a) — OKX cluster Medium/High —
 * is DELETED. OKX is logged-only now (its labels were inverted
 * against paper outcomes), so it must not haircut either; the
 * haircut is sentiment-only. Guards (fail-open): a sentiment score
 * with NO DexScreener volume data never flags — scoreSentiment
 * returns 0 with no data, which would otherwise flag every
 * uninstrumented candidate. The evidence is post-hoc (n=23), so the
 * haircut stays a HAIRCUT (0.5x), not a block. */
export const RISK_HAIRCUT = 0.5;
export function isElevatedRisk(sentimentScore: number, sentimentHasDexData: boolean): boolean {
  if (sentimentHasDexData && sentimentScore < 30) return true;
  return false;
}

/** v2.14 hard gates (market-structure research §6, journal-validated
 * on n=21, 7W/14L, base gross -$8.68). All three are pure predicates
 * so the journal replay test can run them on fixture rows.
 *
 * Gate 1 — OKX cluster: DEMOTED to LOGGED-ONLY (SOUL audit fix
 * v2.18). isOkxClusterGateBlock stays exported for replay analysis
 * only — the live poll never calls it. OKX labels were inverted
 * against paper outcomes (KYC passed, Betty flagged).
 *
 * Gate 2 — holder floor: block when holders < 200. In-sample:
 * filters 0W/5L; with gate 1: 7W/7L kept, gross +$1.40, zero wins
 * lost. FAIL-CLOSED on total absence (holders === null): the standing
 * rule is missing data = block, and the count is present on every
 * journaled entry (OKX 23/23), so an absence means a data outage.
 *
 * Gate 3 — liquidity floor: block when liquidity < $8,000.
 * In-sample n=9 (instrumented subset only): filters 0W/5L, does NOT
 * catch the rugs ($8.7k/$9.0k) — it catches thin-liquidity losses.
 * FAIL-CLOSED on total absence, same reasoning as gate 2. */
export const HOLDER_FLOOR = 200;
export const LIQUIDITY_FLOOR_USD = 8000;

/** Historical filter only (see the gate docs above): true when the
 * OKX cluster concentration is Medium or High. The live poll does
 * NOT call this — OKX is logged-only since v2.18. */
export function isOkxClusterGateBlock(clusterConcentration: string | null | undefined): boolean {
  return clusterConcentration === "Medium" || clusterConcentration === "High";
}

export interface HolderCountResolution {
  holders: number | null;
  /** Which source supplied the value (okx | rugcheck | jupiter | none). */
  source: "okx" | "rugcheck" | "jupiter" | "none";
  /** True when >=2 sources were present and not all equal. The gate
   * uses the MIN and journals the disagreement — a data conflict is
   * resolved fail-closed, not by picking the friendliest number. */
  disagreement: boolean;
}

/** Resolve the holder count from the sources available at gate time.
 * OKX totalHolders is primary (present 23/23 in the journal);
 * Rugcheck totalHolders and Jupiter holderCount are fallbacks.
 * When several sources are present, the MIN is used (fail-closed)
 * and disagreement is flagged for the journal. */
export function resolveHolderCount(
  okxHolders: string | null | undefined,
  rugcheckHolders: number | null | undefined,
  jupiterHolders: number | null | undefined,
): HolderCountResolution {
  const okxNum = typeof okxHolders === "string" && okxHolders !== "" ? Number(okxHolders) : null;
  const vals: Array<{ v: number; source: "okx" | "rugcheck" | "jupiter" }> = [];
  if (typeof okxNum === "number" && Number.isFinite(okxNum) && okxNum >= 0) vals.push({ v: okxNum, source: "okx" });
  if (typeof rugcheckHolders === "number" && Number.isFinite(rugcheckHolders) && rugcheckHolders >= 0)
    vals.push({ v: rugcheckHolders, source: "rugcheck" });
  if (typeof jupiterHolders === "number" && Number.isFinite(jupiterHolders) && jupiterHolders >= 0)
    vals.push({ v: jupiterHolders, source: "jupiter" });
  if (vals.length === 0) return { holders: null, source: "none", disagreement: false };
  const best = vals.reduce((a, b) => (b.v < a.v ? b : a));
  return { holders: best.v, source: best.source, disagreement: vals.length > 1 && vals.some((x) => x.v !== vals[0].v) };
}

export function isHolderFloorBlock(holders: number | null): boolean {
  // Fail-closed on total absence (see gate docs above).
  return holders === null || holders < HOLDER_FLOOR;
}

export interface LiquidityResolution {
  liquidityUsd: number | null;
  /** Which source supplied the value (pumpfun | rugcheck | jupiter | dexscreener | none). */
  source: "pumpfun" | "rugcheck" | "jupiter" | "dexscreener" | "none";
  /** True when >=2 sources were present and not all equal. */
  disagreement: boolean;
}

/** Resolve entry liquidity from the sources available at gate time.
 * The sources measure different things (curve SOL vs total market
 * liquidity vs pair liquidity), so the MIN across present sources
 * is used (fail-closed) and disagreement is flagged for the journal
 * — never first-available, never max. */
export function resolveLiquidityUsd(
  pumpfunLiquidityUsd: number | null | undefined,
  rugcheckTotalMarketLiquidity: number | null | undefined,
  jupiterLiquidityUsd: number | null | undefined,
  dexLiquidityUsd: number | null | undefined,
): LiquidityResolution {
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
  const vals: Array<{ v: number; source: "pumpfun" | "rugcheck" | "jupiter" | "dexscreener" }> = [];
  const p = num(pumpfunLiquidityUsd);
  if (p !== null) vals.push({ v: p, source: "pumpfun" });
  const r = num(rugcheckTotalMarketLiquidity);
  if (r !== null) vals.push({ v: r, source: "rugcheck" });
  const j = num(jupiterLiquidityUsd);
  if (j !== null) vals.push({ v: j, source: "jupiter" });
  const d = num(dexLiquidityUsd);
  if (d !== null) vals.push({ v: d, source: "dexscreener" });
  if (vals.length === 0) return { liquidityUsd: null, source: "none", disagreement: false };
  const best = vals.reduce((a, b) => (b.v < a.v ? b : a));
  return { liquidityUsd: best.v, source: best.source, disagreement: vals.length > 1 && vals.some((x) => x.v !== vals[0].v) };
}

export function isLiquidityFloorBlock(liquidityUsd: number | null): boolean {
  // Fail-closed on total absence (see gate docs above).
  return liquidityUsd === null || liquidityUsd < LIQUIDITY_FLOOR_USD;
}

/** Buy-dominance / flow snapshot (v2.14, LOGGED ONLY). Built from the
 * DexScreener snapshot and Jupiter token stats the spotter already
 * fetches for the gates — no extra calls. No gate, no score change,
 * no sizing change: after 20 paper trades these fields are the
 * backtest input for a buy-dominance gate (research §6.3). Null means
 * the source did not carry the field — absence recorded explicitly.
 *
 * Run-up honesty (research §1): runUpPct is measured from
 * first-seen-in-this-run, so same-poll entries show 0%, and NO
 * available source exposes a launch mc — Jupiter createdAt and
 * DexScreener pairCreatedAt are timestamps, not mcs, and a Pump.fun
 * curve starts near-zero by design, so a launch-mc denominator would
 * be meaningless anyway. tokenAgeMin (Jupiter createdAt preferred,
 * DexScreener pairCreatedAt fallback) plus the fixed-window DexScreener
 * price changes are the honest substitutes, recorded here. */
export interface EntryFlowStats {
  dexBuysH1: number | null;
  dexSellsH1: number | null;
  dexBuysM5: number | null;
  dexSellsM5: number | null;
  dexBuysH24: number | null;
  dexSellsH24: number | null;
  jupBuyVolumeH1: number | null;
  jupSellVolumeH1: number | null;
  jupBuyOrgVolumeH1: number | null;
  jupSellOrgVolumeH1: number | null;
  jupNumBuysH1: number | null;
  jupNumSellsH1: number | null;
  jupNumTradersH1: number | null;
  jupNumNetBuyersH1: number | null;
  jupHolderChangeH1: number | null;
  jupOrganicScore: number | null;
  tokenAgeMin: number | null;
  dexPriceChangeH1Pct: number | null;
  dexPriceChangeH6Pct: number | null;
  dexPriceChangeH24Pct: number | null;
}

export function entryFlowStats(
  dex: { buysH1: number | null; sellsH1: number | null; buysM5: number | null; sellsM5: number | null; buysH24: number | null; sellsH24: number | null; pairCreatedAt: number | null; priceChangeH1Pct: number | null; priceChangeH6Pct: number | null; priceChangeH24Pct: number | null } | null,
  jup: JupiterTokenStats | null,
  nowMs: number,
): EntryFlowStats {
  const s1 = jup?.stats1h ?? null;
  let tokenAgeMin: number | null = null;
  const createdMs = jup?.createdAt ? Date.parse(jup.createdAt) : NaN;
  if (Number.isFinite(createdMs) && createdMs > 0) {
    tokenAgeMin = Math.max(0, (nowMs - createdMs) / 60000);
  } else if (typeof dex?.pairCreatedAt === "number" && dex.pairCreatedAt > 0) {
    tokenAgeMin = Math.max(0, (nowMs - dex.pairCreatedAt) / 60000);
  }
  return {
    dexBuysH1: dex?.buysH1 ?? null,
    dexSellsH1: dex?.sellsH1 ?? null,
    dexBuysM5: dex?.buysM5 ?? null,
    dexSellsM5: dex?.sellsM5 ?? null,
    dexBuysH24: dex?.buysH24 ?? null,
    dexSellsH24: dex?.sellsH24 ?? null,
    jupBuyVolumeH1: s1?.buyVolume ?? null,
    jupSellVolumeH1: s1?.sellVolume ?? null,
    jupBuyOrgVolumeH1: s1?.buyOrganicVolume ?? null,
    jupSellOrgVolumeH1: s1?.sellOrganicVolume ?? null,
    jupNumBuysH1: s1?.numBuys ?? null,
    jupNumSellsH1: s1?.numSells ?? null,
    jupNumTradersH1: s1?.numTraders ?? null,
    jupNumNetBuyersH1: s1?.numNetBuyers ?? null,
    jupHolderChangeH1: s1?.holderChange ?? null,
    jupOrganicScore: jup?.organicScore ?? null,
    tokenAgeMin,
    dexPriceChangeH1Pct: dex?.priceChangeH1Pct ?? null,
    dexPriceChangeH6Pct: dex?.priceChangeH6Pct ?? null,
    dexPriceChangeH24Pct: dex?.priceChangeH24Pct ?? null,
  };
}

export interface EntryHeatStats {
  buyHeatPct: number | null;
  sellHeatPct: number | null;
  buyHeatPace: number | null;
  avgBuyUsd: number | null;
  avgSellUsd: number | null;
  avgBuyOrgUsd: number | null;
}

/** Volume heat + average trade size at entry (v2.24, journal only).
 * memecoin.watch's Heat = 1m volume / 5m volume x 100 measures
 * acceleration: the recent window's share of the wider window. We
 * have no 1m volume — DexScreener gives m5/h1 buy COUNTS and Jupiter
 * gives 1h volumes + counts — so the heat here is count-based: m5
 * buys as a share of h1 buys. Uniform flow over the hour puts 5/60
 * = 8.33% of buys in any 5 minutes, so buyHeatPace divides by 8.33:
 * 1.0x is steady, 3x is accelerating. avgBuyUsd is exact (Jupiter
 * 1h buy volume / 1h buy count), not an estimate. LOGGED ONLY — no
 * gate, no score change. Null means a source did not carry the field.
 * After 20 paper trades these are the backtest input for a
 * volume-heat gate. */
export function entryHeatStats(
  dex: { buysH1: number | null; sellsH1: number | null; buysM5: number | null; sellsM5: number | null } | null,
  jup: JupiterTokenStats | null,
): EntryHeatStats {
  const ratio = (m5: number | null, h1: number | null): number | null => {
    if (typeof m5 !== "number" || typeof h1 !== "number" || !(h1 > 0) || m5 < 0) return null;
    return (m5 / h1) * 100;
  };
  const avg = (vol: number | null, n: number | null): number | null => {
    if (typeof vol !== "number" || typeof n !== "number" || !(n > 0) || vol < 0) return null;
    return vol / n;
  };
  const s1 = jup?.stats1h ?? null;
  const buyHeatPct = ratio(dex?.buysM5 ?? null, dex?.buysH1 ?? null);
  return {
    buyHeatPct,
    sellHeatPct: ratio(dex?.sellsM5 ?? null, dex?.sellsH1 ?? null),
    buyHeatPace: buyHeatPct === null ? null : buyHeatPct / (100 / 12),
    avgBuyUsd: avg(s1?.buyVolume ?? null, s1?.numBuys ?? null),
    avgSellUsd: avg(s1?.sellVolume ?? null, s1?.numSells ?? null),
    avgBuyOrgUsd: avg(s1?.buyOrganicVolume ?? null, s1?.numBuys ?? null),
  };
}

/** Compact heat fragment for the paper_entry reason line. Empty when
 * nothing was measurable, so the reason stays clean. */
export function heatNoteText(heat: EntryHeatStats): string {
  const parts: string[] = [];
  if (heat.buyHeatPct !== null && heat.buyHeatPace !== null) {
    parts.push(`heat buys ${heat.buyHeatPct.toFixed(1)}% (${heat.buyHeatPace.toFixed(1)}x pace)`);
  }
  if (heat.avgBuyUsd !== null) parts.push(`avgBuy $${Math.round(heat.avgBuyUsd)}`);
  return parts.join(", ");
}

export interface EntryLiqVol {
  liqVolRatio: number | null;
  liqVolSuspicious: boolean;
}

/** Liquidity / volume ratio at entry (v2.25, journal only). The
 * DexScreener snapshot already fetched for entryFlowStats carries
 * both numbers (volumeH24, liquidityUsd) — no new API call. The
 * ratio is h24 volume / liquidity; Immutal0 flags < 0.1 as
 * suspicious (thin volume for the pool size). LOGGED ONLY — no gate,
 * no score change. Null when either number is missing or liquidity
 * is not positive: a missing ratio is UNKNOWN, never 0 (0 would
 * journal as "most suspicious" on a data outage). */
export const LIQ_VOL_SUSPICIOUS_BELOW = 0.1;
export function entryLiqVol(dex: DexSnapshot | null): EntryLiqVol {
  const vol = dex?.volumeH24 ?? null;
  const liq = dex?.liquidityUsd ?? null;
  if (typeof vol !== "number" || typeof liq !== "number" || !(liq > 0) || vol < 0) {
    return { liqVolRatio: null, liqVolSuspicious: false };
  }
  const ratio = vol / liq;
  return { liqVolRatio: ratio, liqVolSuspicious: ratio < LIQ_VOL_SUSPICIOUS_BELOW };
}

/** Compact liq/vol fragment for the paper_entry reason line. Empty
 * when nothing was measurable; SUSPICIOUS is spelled out when the
 * ratio is measured and below the bar. */
export function liqVolNoteText(v: EntryLiqVol): string {
  if (v.liqVolRatio === null) return "";
  return "liq/vol " + v.liqVolRatio.toFixed(2) + (v.liqVolSuspicious ? " SUSPICIOUS" : "");
}

/** Post-exit tracking window (v2.25): after a close, the spotter
 * poll keeps watching the mint in the discovery feed for this long
 * and records the best mc seen. The window is 120 minutes — the
 * time-exit horizon, so a position's whole plausible "what if I had
 * held" story fits inside it. A rise is only "sold early" when the
 * post-exit peak beats the exit mc by more than this. */
export const POST_EXIT_TRACK_MS = 120 * 60 * 1000;
export const POST_EXIT_SOLD_EARLY_PCT = 5;

/** Provisional exit grade at close time (v2.25, pure — testable).
 * Graded from the move available while holding: captured is the
 * share of the peak gain the exit kept. >= 90% kept is excellent;
 * <= 50% kept (including exits below entry after a run-up) is
 * round-tripped. Between 50% and 90% the grade is pending — the
 * post-exit window decides whether the price ran on (sold early)
 * or not (excellent). A trade that never went above entry has no
 * move to grade yet, so it is pending too. */
export function provisionalExitGrade(entryMcUsd: number, exitMcUsd: number, peakMcUsd: number): ExitQuality {
  if (!(entryMcUsd > 0) || !(exitMcUsd > 0) || !(peakMcUsd > 0)) return "pending";
  const peakGain = peakMcUsd - entryMcUsd;
  if (peakGain <= 0) return "pending";
  const captured = (exitMcUsd - entryMcUsd) / peakGain;
  if (captured >= 0.9) return "excellent";
  if (captured <= 0.5) return "round-tripped";
  return "pending";
}

export interface FinalExitGrade {
  exitQuality: ExitQuality;
  leftOnTablePct: number | null;
  leftOnTableUsd: number | null;
  leftOnTableReason: string;
}

/** Final exit grade at the end of the post-exit window (v2.25, pure
 * — testable). leftOnTable is the gain foregone by selling when the
 * position did, measured against the best mc seen AFTER the exit
 * (not the in-trade peak — giving back while holding is the
 * round-trip grade, not left-on-table). When no post-exit price was
 * seen in the window, leftOnTable is null with the reason and the
 * grade falls back to the in-trade move (a pending provisional
 * finalises to excellent: it kept 50-90% of the move and nothing
 * shows the price ran on). Precedence: a >= 50% in-trade give-back
 * is round-tripped even if the price later rose — the bigger error
 * happened while holding. Otherwise a > 5% post-exit rise is sold
 * early, and anything else is excellent. */
export function finalizeExitGrade(
  entryMcUsd: number,
  exitMcUsd: number,
  peakMcUsd: number,
  postExitPeakMcUsd: number | null,
  postExitSeen: boolean,
  costBasisUsd: number,
): FinalExitGrade {
  if (!(entryMcUsd > 0) || !(exitMcUsd > 0) || !(peakMcUsd > 0)) {
    return { exitQuality: "pending", leftOnTablePct: null, leftOnTableUsd: null, leftOnTableReason: "unmeasurable: non-positive entry/exit/peak mc" };
  }
  if (!postExitSeen || postExitPeakMcUsd === null) {
    const provisional = provisionalExitGrade(entryMcUsd, exitMcUsd, peakMcUsd);
    return {
      exitQuality: provisional === "pending" ? "excellent" : provisional,
      leftOnTablePct: null,
      leftOnTableUsd: null,
      leftOnTableReason: "no post-exit price in 120-min window",
    };
  }
  const peakGain = peakMcUsd - entryMcUsd;
  const giveBack = peakGain > 0 ? (peakMcUsd - exitMcUsd) / peakGain : 0;
  const leftPct = Math.max(0, ((postExitPeakMcUsd - exitMcUsd) / exitMcUsd) * 100);
  const leftUsd = costBasisUsd > 0 ? Math.max(0, (postExitPeakMcUsd / exitMcUsd - 1) * costBasisUsd) : 0;
  const exitQuality: ExitQuality =
    giveBack >= 0.5 ? "round-tripped" : postExitPeakMcUsd > exitMcUsd * (1 + POST_EXIT_SOLD_EARLY_PCT / 100) ? "sold early" : "excellent";
  return { exitQuality, leftOnTablePct: leftPct, leftOnTableUsd: leftUsd, leftOnTableReason: "post-exit peak in 120-min window" };
}

/** One close's grading payload (v2.25, pure — testable). Shared by
 * the spotter exit loop and the watcher tick so both close paths
 * journal identical fields. peakMcUsd is the best mc while holding
 * (position.peakPrice, updated on every priced tick) or the exit mc,
 * whichever is higher — the exit tick itself counts. leftOnTable is
 * always null at close time: no post-exit price can exist yet, so
 * the reason says so instead of inventing a number. sizePct comes
 * from the entry (stored on the position); positions opened before
 * v2.25 have none and journal null, never a reconstructed value. */
export function gradeClose(
  p: PaperPositionState,
  exitMcUsd: number,
  costBasisUsd: number,
): {
  details: { entryMcUsd: number; peakMcUsd: number; exitCostBasisUsd: number; exitQuality: ExitQuality; sizePct: number | null; sizePctFlagged: boolean };
  journal: { exitQuality: ExitQuality; leftOnTablePct: null; leftOnTableUsd: null; leftOnTableReason: string; sizePct: number | null; sizePctFlagged: boolean };
} {
  const peakMcUsd = Math.max(p.position.peakPrice, exitMcUsd);
  const exitQuality = provisionalExitGrade(p.entryMcUsd, exitMcUsd, peakMcUsd);
  const sizePct = typeof p.sizePctAtEntry === "number" ? p.sizePctAtEntry : null;
  return {
    details: { entryMcUsd: p.entryMcUsd, peakMcUsd, exitCostBasisUsd: costBasisUsd, exitQuality, sizePct, sizePctFlagged: (p.sizePctAtEntry ?? 0) > 25 },
    journal: {
      exitQuality,
      leftOnTablePct: null,
      leftOnTableUsd: null,
      leftOnTableReason: "pending post-exit tracking (120-min window)",
      sizePct,
      sizePctFlagged: (p.sizePctAtEntry ?? 0) > 25,
    },
  };
}

/** One top holder, as snapshotted at entry and as re-read later. */
export interface TopHolderSnapshot {
  owner: string;
  pct: number;
}

/** Top holders from a Rugcheck report, minus the exclusion set
 * (curve, pool vaults, lockers, burn — see operatorExcludedAddrs),
 * top `n` by pct. Pure. */
export function topHoldersSnapshot(report: RugcheckReport, excluded: Set<string>, n = 5): TopHolderSnapshot[] {
  return (report.topHolders ?? [])
    .filter((h) => !excluded.has(h.address) && !excluded.has(h.owner ?? ""))
    .map((h) => ({ owner: h.owner ?? h.address, pct: typeof h.pct === "number" ? h.pct : 0 }))
    .sort((a, b) => b.pct - a.pct)
    .slice(0, n);
}

export interface HolderExit {
  owner: string;
  pctAtEntry: number;
  pctNow: number;
  dropPct: number;
  kind: "halved" | "left_top10";
}

/** Diff an entry snapshot against a fresh top-10 snapshot (v2.24,
 * wallet-tracker --holders-of pattern). A top-5 holder whose share
 * halved (>= 50% drop) or who left the top 10 entirely is an exit.
 * Small dips and growth are not exits. Pure. */
export function holderExits(snapshot: TopHolderSnapshot[], current: TopHolderSnapshot[]): HolderExit[] {
  const now = new Map(current.map((h) => [h.owner, h.pct]));
  const exits: HolderExit[] = [];
  for (const h of snapshot) {
    const pctNow = now.get(h.owner);
    if (pctNow === undefined) {
      exits.push({ owner: h.owner, pctAtEntry: h.pct, pctNow: 0, dropPct: 100, kind: "left_top10" });
    } else if (h.pct > 0 && pctNow <= h.pct * 0.5) {
      exits.push({ owner: h.owner, pctAtEntry: h.pct, pctNow, dropPct: ((h.pct - pctNow) / h.pct) * 100, kind: "halved" });
    }
  }
  return exits;
}

export function entryGemNote(gem: GemSignal, freshTier: boolean): string {
  if (freshTier && gem.reason.startsWith("rug check blocked:")) {
    const flags = gem.reason.slice("rug check blocked: ".length);
    return (
      "fresh tier override: concentration flags allowed (" +
      flags +
      ", Rugcheck score <= 20, no danger risk), gem score " +
      gem.score
    );
  }
  return gem.reason;
}

export interface EntryVolStats {
  firstMcUsd: number;
  /** Entry mc vs first-seen mc, percent (anti-chase / volatility proxy). */
  runUpPct: number;
  liquidityUsd: number;
  top10Pct: number;
  singleWalletPct: number;
}

/** Entry-time volatility / concentration snapshot (v2.11, journal only).
 * The next sizing or gate decision needs these numbers per trade, and
 * the journal did not carry them: holders, liquidity and run-up do not
 * separate winners from losers in the 12-trade sample, so no
 * volatility-tiered sizing rule is adopted yet — this records the
 * inputs so the rule can be validated on the next 20 trades instead
 * of guessed. -1 means the Rugcheck value was null. */
export function entryVolStats(coin: PumpCoin, seen: SeenCoin, rugInput: RugInput): EntryVolStats {
  const first = seen.firstMcUsd > 0 ? seen.firstMcUsd : coin.usd_market_cap;
  return {
    firstMcUsd: first,
    runUpPct: first > 0 ? ((coin.usd_market_cap - first) / first) * 100 : 0,
    liquidityUsd: coin.canonical_pool_liquidity_usd ?? 0,
    top10Pct: rugInput.top10Pct ?? -1,
    singleWalletPct: rugInput.singleWalletPct ?? -1,
  };
}

/** SAST calendar date, YYYY-MM-DD, for the daily trade cap. */
export function todaySast(d = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Johannesburg", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

export interface PumpCoin {
  mint: string;
  name: string;
  symbol: string;
  creator: string;
  created_timestamp: number;
  last_trade_timestamp?: number;
  ath_market_cap?: number;
  usd_market_cap: number;
  market_cap_usd?: number;
  reply_count?: number;
  complete: boolean;
  associated_bonding_curve: string;
  bonding_curve: string;
  canonical_pool_liquidity_usd?: number;
  raydium_pool?: string | null;
  /** v2.17 discovery source: "ws" when the coin came from the
   * WebSocket queue alone (set by wsCoinToPumpCoin / mergeWsCoins),
   * undefined for poll coins (resolves to "poll" in
   * discoverySource). A coin in both stays a poll coin.
   * "second-look" (v2.28): a transient-blocked mint re-checked at
   * age 30-120 min from state, not from any feed. */
  discoveredVia?: "ws" | "poll" | "second-look";
}

export interface SeenCoin {
  mint: string;
  name: string;
  symbol: string;
  firstSeenMs: number;
  firstMcUsd: number;
  lastMcUsd: number;
  lastSeenMs: number;
  replies: number;
  creator: string;
  complete: boolean;
  /** v2.28: bonding-curve addresses, recorded at first sight so a
   * second-look re-check can rebuild the exact PumpCoin from state
   * (rugInputFromReport excludes the curve from top holders).
   * Absent on records predating v2.28 — those mints are never
   * second-look eligible (fail-safe). */
  bondingCurve?: string;
  associatedBondingCurve?: string;
}

export interface PaperPositionState {
  id: string;
  mint: string;
  name: string;
  entryMcUsd: number;
  sizeUsd: number;
  openedAtMs: number;
  position: Position;
  lastMcUsd: number;
  missedPolls: number;
  /** v2.24 top-holder exit watch: the top 5 curve-excluded holders
   * at entry (from the entry Rugcheck report) plus the exclusion set
   * used, so the poll can diff later reports against the same set.
   * Absent on positions opened before v2.24 (no snapshot, no check). */
  topHoldersAtEntry?: TopHolderSnapshot[];
  holderExcludedAddrs?: string[];
  /** v2.25 entry thesis: the entry reason (gem note) as recorded
   * while the position was open, before the outcome was known. Set
   * at entry ONLY — close paths must never write it. Absent on
   * positions opened before v2.25. */
  entryThesis?: string;
  /** v2.25 position size as % of book equity at entry (rounded, the
   * same number as the paper_entry "size N%" reason). Stored so the
   * close can journal it without reconstructing entry-time equity.
   * Absent on positions opened before v2.25 (journals null). */
  sizePctAtEntry?: number;
}

export interface ClosedMint {
  closedAtMs: number;
  exitMcUsd: number;
  reason: string;
  /** v2.25 exit grading (only present when the close supplied
   * details — recordClosedMint without details keeps the old bare
   * shape, so existing tests and old state files still read).
   * entryMcUsd / peakMcUsd / exitCostBasisUsd are the grading
   * inputs; postExitPeakMcUsd starts at exitMcUsd and is raised by
   * the poll's post-exit tracking; postExitSeen distinguishes "seen
   * again at exactly the exit mc" from "never seen again". graded
   * is set when the exit_grade line is journaled (or when the
   * record predates grading and is skipped silently). */
  entryMcUsd?: number;
  peakMcUsd?: number;
  exitCostBasisUsd?: number;
  postExitPeakMcUsd?: number;
  postExitSeen?: boolean;
  graded?: boolean;
  exitQuality?: ExitQuality;
  sizePct?: number | null;
  sizePctFlagged?: boolean;
}

/** v2.23: a mint blocked at deep-check, for the blocked-mint cooldown.
 * nearMiss marks a near-miss / data-gap block (holder / liquidity floor,
 * cluster-unknown, sell-sim sizing) — those get the short cooldown.
 * v2.28: kind marks the Rugcheck-failure class for the
 * transient/permanent split — "permanent" (creator-history danger or
 * live mint/freeze authority, 24h cooldown, never second-looked) or
 * "transient" (concentration / low liquidity, 15m cooldown,
 * second-look eligible at age 30-120 min). Absent on records that
 * predate v2.28 and on non-Rugcheck blocks: those behave exactly as
 * before (60m full / 15m near-miss). */
export interface BlockedMint {
  blockedAtMs: number;
  mcUsd: number;
  nearMiss: boolean;
  kind?: "permanent" | "transient";
}

export interface SpotterState {
  startedAtMs: number;
  equityUsd: number;
  trades: number;
  wins: number;
  losses: number;
  blocked: number;
  priceSourceLostCloses: number;
  grossWinsUsd: number;
  grossLossesUsd: number;
  jupiterRescues: number;
  clusterBlocks: number;
  cabalBlocks: number;
  okxSignals: number;
  alertBoosts: number;
  sentimentSignals: number;
  /** Entries sized down by the v2.13 elevated-risk haircut. */
  riskHaircuts: number;
  /** v2.14 hard-gate blocks (journal reason carries the value). */
  okxClusterGateBlocks: number;
  holderFloorBlocks: number;
  liquidityFloorBlocks: number;
  /** v2.15 Jupiter sell-sim gate: entries blocked by the sell quote,
   * and quotes that failed after bounded retry (transient — also a
   * block since v2.18, counted separately so a dead quote endpoint
   * is distinguishable from an unsellable token). */
  sellSimBlocks: number;
  sellSimTransient: number;
  /** v2.15 co-buy logged signal: entries with a co-buy analysis. */
  coBuySignals: number;
  /** v2.22 operator + sell-impact logged signal: entries with an
   * operator analysis (LOGGED ONLY, never a gate — see
   * packages/signals/src/operator.ts). */
  operatorSignals: number;
  /** v2.24 top-holder exit watch: holder_exit journal lines written
   * for open positions (LOGGED ONLY, never an exit). */
  holderExitSignals: number;
  /** v2.25 exit grading: exit_grade journal lines written
   * (LOGGED ONLY, never a gate or exit change). */
  exitGradeSignals: number;
  /** v2.16 WS discovery: cumulative mints the relay queue contributed
   * to a poll (fresh slice only, <= 15 min old). */
  wsCoinsSeen: number;
  tradesToday: number;
  tradeDay: string | null;
  worstLossPct: number;
  solPriceUsd: number;
  halted: boolean;
  seen: Record<string, SeenCoin>;
  positions: PaperPositionState[];
  closedMints: Record<string, ClosedMint>;
  /** v2.23: mints blocked at deep-check, with the mc at block time,
   * for the blocked-mint cooldown. */
  blockedMints: Record<string, BlockedMint>;
  /** v2.23: deep-checks skipped by the blocked-mint cooldown. */
  cooldownSkips: number;
  polls: number;
  lastPollMs: number | null;
}

export function newState(): SpotterState {
  return {
    startedAtMs: Date.now(),
    equityUsd: MICRO_PROFILE.startEquityUsd,
    trades: 0,
    wins: 0,
    losses: 0,
    blocked: 0,
    priceSourceLostCloses: 0,
    grossWinsUsd: 0,
    grossLossesUsd: 0,
    jupiterRescues: 0,
    clusterBlocks: 0,
    cabalBlocks: 0,
    okxSignals: 0,
    alertBoosts: 0,
    sentimentSignals: 0,
    riskHaircuts: 0,
    okxClusterGateBlocks: 0,
    holderFloorBlocks: 0,
    liquidityFloorBlocks: 0,
    sellSimBlocks: 0,
    sellSimTransient: 0,
    coBuySignals: 0,
    operatorSignals: 0,
    holderExitSignals: 0,
    exitGradeSignals: 0,
    wsCoinsSeen: 0,
    tradesToday: 0,
    tradeDay: null,
    worstLossPct: 0,
    solPriceUsd: 0, // no live price yet — a poll must fetch one, never invent one
    halted: false,
    seen: {},
    positions: [],
    closedMints: {},
    blockedMints: {},
    cooldownSkips: 0,
    polls: 0,
    lastPollMs: null,
  };
}

export function readiness(state: SpotterState): { ready: boolean; reasons: string[]; winRate: number; profitFactor: number; priceLostPct: number } {
  // v2.12 audit fix: denominators are CLOSED trades, not entries.
  // The old code used state.trades (entries) for winRate and
  // priceClosed, so open positions inflated "closed on price" and
  // deflated win rate: at 20 trades with 3 open it reported
  // priceClosed 20 (true: 17) and WR 6/20 = 30% (true: 6/17 = 35%).
  // READINESS.md says "at least 10 of those closed on price" — the
  // bar is about closes, so it must count closes.
  const closed = state.wins + state.losses;
  const winRate = closed > 0 ? state.wins / closed : 0;
  const profitFactor = state.grossLossesUsd > 0 ? state.grossWinsUsd / state.grossLossesUsd : state.grossWinsUsd > 0 ? 99 : 0;
  const priceLostPct = closed > 0 ? state.priceSourceLostCloses / closed : 0;
  const priceClosed = closed - state.priceSourceLostCloses;
  const reasons: string[] = [];
  if (state.trades < 20) reasons.push("need >=20 trades, have " + state.trades);
  if (priceClosed < 10) reasons.push("need >=10 closed on price, have " + priceClosed);
  if (winRate < 0.4) reasons.push("win rate " + Math.round(winRate * 100) + "% < 40%");
  if (profitFactor < 1.2) reasons.push("profit factor " + profitFactor.toFixed(2) + " < 1.20");
  if (state.equityUsd < MICRO_PROFILE.startEquityUsd * 1.1) reasons.push("equity $" + state.equityUsd.toFixed(2) + " < $" + (MICRO_PROFILE.startEquityUsd * 1.1).toFixed(2));
  if (priceLostPct > 0.1) reasons.push("price-source-lost closes " + Math.round(priceLostPct * 100) + "% > 10%");
  if ((state.worstLossPct ?? 0) <= -0.5) reasons.push("worst single-trade loss " + Math.round((state.worstLossPct ?? 0) * 100) + "% <= -50%");
  if (state.halted) reasons.push("daily loss halt triggered");
  return { ready: reasons.length === 0, reasons, winRate, profitFactor, priceLostPct };
}

async function fetchJson(url: string, timeoutMs = 12000): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: "application/json", "user-agent": "SculGrok-spotter/0.1 paper-test" } });
    if (!res.ok) throw new Error("HTTP " + res.status + " " + url);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

export async function fetchNewCoins(limit = 200): Promise<{ coins: PumpCoin[]; source: "pumpfun" | "jupiter-recent" }> {
  const out: PumpCoin[] = [];
  try {
    for (let offset = 0; offset < limit; offset += 50) {
      const url = "https://frontend-api-v3.pump.fun/coins?offset=" + offset + "&limit=50&sort=created_timestamp&order=DESC&includeNsfw=false";
      const data = (await fetchJson(url)) as PumpCoin[];
      out.push(...data);
      if (data.length < 50) break;
    }
  } catch {
    // Primary discovery is down (frontend-api-v3 has 403'd scripts
    // before): fall back to Jupiter /tokens/v2/recent, keyless,
    // instead of dying blind. The caller journals the fallback.
    // v2.12 audit fix: if some Pump.fun pages already loaded, keep
    // them instead of discarding the partial list for the fallback.
    if (out.length > 0) return { coins: out, source: "pumpfun" };
    return { coins: await fetchJupiterRecent(), source: "jupiter-recent" };
  }
  // Also fetch by market cap: older, graduated tokens with more holders,
  // which are more likely to pass top10 than the freshest launches.
  try {
    const top = (await fetchJson("https://frontend-api-v3.pump.fun/coins?offset=0&limit=50&sort=market_cap&order=DESC&includeNsfw=false")) as PumpCoin[];
    const seen = new Set(out.map((c) => c.mint));
    for (const c of top) if (!seen.has(c.mint)) out.push(c);
  } catch {
    // Market-cap feed is a bonus, not a hard requirement
  }
  // Last-trade feed: tokens still trading stay visible even after they
  // leave the newest list. This is the main v2 price-tracking fix.
  try {
    const active = (await fetchJson("https://frontend-api-v3.pump.fun/coins?offset=0&limit=100&sort=last_trade_timestamp&order=DESC&includeNsfw=false")) as PumpCoin[];
    const seen = new Set(out.map((c) => c.mint));
    for (const c of active) if (!seen.has(c.mint)) out.push(c);
  } catch {
    // Last-trade feed is a bonus, not a hard requirement
  }
  return { coins: out, source: "pumpfun" };
}

interface JupiterRecentToken {
  id: string;
  name: string;
  symbol: string;
  dev?: string;
  mcap?: number;
  fdv?: number;
  holderCount?: number;
  launchpad?: string;
}

/** Map one Jupiter /tokens/v2/recent row onto a PumpCoin. Recent rows
 * are minutes-old launches, so created/last-trade timestamps are now.
 * `complete` is inferred from market cap against the ~$69k graduation
 * threshold: a migrated token must NOT slip through with complete=false,
 * or the post-migration LP check would be skipped for it. */
export function jupiterRecentToCoin(t: JupiterRecentToken, nowMs = Date.now()): PumpCoin {
  const mc = typeof t.mcap === "number" && t.mcap > 0 ? t.mcap : (typeof t.fdv === "number" && t.fdv > 0 ? t.fdv : 0);
  return {
    mint: t.id,
    name: t.name ?? "",
    symbol: t.symbol ?? "",
    creator: t.dev ?? "",
    created_timestamp: nowMs,
    last_trade_timestamp: nowMs,
    usd_market_cap: mc,
    complete: mc >= 69000,
    associated_bonding_curve: "",
    bonding_curve: "",
  };
}

/** Jupiter discovery fallback: latest launches across launchpads.
 * Returns PumpCoin-shaped rows; empty on any failure (caller then
 * journals poll_failed as before). */
export async function fetchJupiterRecent(limit = 30): Promise<PumpCoin[]> {
  try {
    const data = (await fetchJson("https://lite-api.jup.ag/tokens/v2/recent?limit=" + limit, 12000)) as JupiterRecentToken[];
    if (!Array.isArray(data)) return [];
    const now = Date.now();
    return data.filter((t) => t && typeof t.id === "string").map((t) => jupiterRecentToCoin(t, now));
  } catch {
    return [];
  }
}

/** Real sell simulation via a Jupiter swap quote (lite-api, keyless):
 * can 1,000 tokens of this mint be quoted to SOL? Only used when a
 * candidate has no Rugcheck markets, so it can only ADD passes, never
 * block beyond the old markets.length > 0 rule. False on any failure
 * AND when decimals are missing/invalid — the quote cannot be sized
 * without them (no default 6, SOUL audit fix). */
export async function fetchJupiterSellQuoteOk(mint: string, decimals: number | null): Promise<boolean> {
  try {
    if (typeof decimals !== "number" || !Number.isFinite(decimals) || decimals < 0 || decimals > 9) return false;
    const amount = Math.floor(1000 * 10 ** Math.floor(decimals));
    const url = "https://lite-api.jup.ag/swap/v1/quote?inputMint=" + encodeURIComponent(mint) + "&outputMint=" + SOL_MINT + "&amount=" + amount + "&slippageBps=200";
    const data = (await fetchJson(url, 10000)) as { outAmount?: string };
    const out = Number(data?.outAmount);
    return Number.isFinite(out) && out > 0;
  } catch {
    return false;
  }
}

/** v2.15 sell-simulation fetch: quote SELLING `amountBaseUnits` of
 * this mint for SOL. Three outcomes, and the distinction matters:
 * - { kind: "quote" } — Jupiter priced the sell; decideSellSim rules.
 * - { kind: "noRoute" } — Jupiter REFUSED the quote (HTTP 400/404,
 *   or a 200 with no usable outAmount): no route for this size, the
 *   token is unsellable at the would-be position size. This is a
 *   definitive signal, NOT a transient — the gate BLOCKS on it.
 * - { kind: "transient" } — network / timeout / 5xx / 429 after
 *   bounded retry (2 attempts, Retry-After honoured, capped 30s):
 *   the gate BLOCKS on it too (SOUL audit fix v2.18 — the old
 *   fail-open transient is gone; an untested token must not enter).
 * A 429 is deliberately NOT a noRoute (it is Jupiter rate-limiting,
 * not refusing the token). The body is read as TEXT before any JSON
 * parse: Jupiter answers a 429 with plain-text "Rate limit exceeded"
 * under an application/json content-type, which misparses as a
 * no-route if parsed as JSON first. Read-only quote, no signing, no
 * transaction, keyless. Swap V1 /quote, so priceImpactPct is a
 * decimal ratio (see sell-sim.ts). */
export type SellQuoteResult =
  | { kind: "quote"; quote: SellSimQuote }
  | { kind: "noRoute"; status: number }
  | { kind: "transient" };

export async function fetchJupiterSellQuote(mint: string, amountBaseUnits: number): Promise<SellQuoteResult> {
  const url = "https://lite-api.jup.ag/swap/v1/quote?inputMint=" + encodeURIComponent(mint) + "&outputMint=" + SOL_MINT + "&amount=" + Math.floor(amountBaseUnits) + "&slippageBps=200";
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10000);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: { accept: "application/json", "user-agent": "SculGrok-spotter/0.1 paper-test" } });
      const text = await res.text();
      if (res.status === 429) {
        // Rate-limited, not refused. Honour Retry-After (seconds),
        // capped at 30s; retry once, then transient.
        if (attempt === 0) {
          const retryAfter = Number(res.headers.get("retry-after"));
          const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 30000) : 1000;
          await sleep(waitMs);
          continue;
        }
        return { kind: "transient" };
      }
      if (res.status >= 500 || res.status === 408) {
        if (attempt === 0) continue;
        return { kind: "transient" };
      }
      if (res.status >= 400) {
        // Jupiter refused the quote (400 = no route / bad mint,
        // 404 = unknown token). Do not retry a refusal.
        return { kind: "noRoute", status: res.status };
      }
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        // 200 with an unparseable body: Jupiter answered but gave no
        // route data. Treat as no-route (fail-closed for a malformed
        // quote) rather than a transient.
        return { kind: "noRoute", status: 200 };
      }
      const quote = parseSellQuote(data, "v1");
      if (quote !== null) return { kind: "quote", quote };
      // 200 with no usable outAmount: Jupiter answered but gave no
      // route data. Treat as no-route (fail-closed for a malformed
      // quote) rather than a transient.
      return { kind: "noRoute", status: 200 };
    } catch {
      // Network error / timeout (AbortError): retry once, then transient.
      if (attempt === 0) continue;
      return { kind: "transient" };
    } finally {
      clearTimeout(t);
    }
  }
  return { kind: "transient" };
}

export async function fetchRugcheck(mint: string): Promise<unknown> {
  return fetchJson("https://api.rugcheck.xyz/v1/tokens/" + mint + "/report", 12000);
}

/** Jupiter Tokens API v2 search row, parsed for the v2.14 gates +
 * volume logging. Only the fields the desk uses; everything is
 * defensive (typeof checks) because the lite-api shape is not
 * versioned. stats1h is the buy-dominance input (research §6.3):
 * buy vs sell volume, organic (wash-filtered) buy vs sell volume,
 * numNetBuyers. All null when the response does not carry them. */
export interface JupiterTokenStats {
  mcap: number | null;
  liquidityUsd: number | null;
  holderCount: number | null;
  /** Token creation time, ISO string (null when absent). A timestamp,
   * NOT a launch mc — no available source exposes one. */
  createdAt: string | null;
  organicScore: number | null;
  organicScoreLabel: string | null;
  stats1h: {
    buyVolume: number | null;
    sellVolume: number | null;
    buyOrganicVolume: number | null;
    sellOrganicVolume: number | null;
    numBuys: number | null;
    numSells: number | null;
    numTraders: number | null;
    numNetBuyers: number | null;
    holderChange: number | null;
    volumeChange: number | null;
  } | null;
  stats24hVolume: number | null;
}

/** Pure parse of a Jupiter /tokens/v2/search response for one mint.
 * Exact-mint match only (same rule as the old fetchJupiterMc);
 * a search that returns other tokens is a miss, not a price. */
export function parseJupiterTokenResponse(data: unknown, mint: string): JupiterTokenStats | null {
  if (!Array.isArray(data) || data.length === 0) return null;
  const hit = (data as Array<Record<string, unknown>>).find((t) => t?.id === mint);
  if (!hit) return null;
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const s1 = (hit.stats1h ?? null) as Record<string, unknown> | null;
  return {
    mcap: num(hit.mcap),
    liquidityUsd: num(hit.liquidity),
    holderCount: num(hit.holderCount),
    createdAt: typeof hit.createdAt === "string" ? hit.createdAt : null,
    organicScore: num(hit.organicScore),
    organicScoreLabel: typeof hit.organicScoreLabel === "string" ? hit.organicScoreLabel : null,
    stats1h: s1
      ? {
          buyVolume: num(s1.buyVolume),
          sellVolume: num(s1.sellVolume),
          buyOrganicVolume: num(s1.buyOrganicVolume),
          sellOrganicVolume: num(s1.sellOrganicVolume),
          numBuys: num(s1.numBuys),
          numSells: num(s1.numSells),
          numTraders: num(s1.numTraders),
          numNetBuyers: num(s1.numNetBuyers),
          holderChange: num(s1.holderChange),
          volumeChange: num(s1.volumeChange),
        }
      : null,
    stats24hVolume: num(((hit.stats24h ?? null) as Record<string, unknown> | null)?.volume),
  };
}

/** Jupiter token row for one mint (keyless lite-api search). Null
 * when Jupiter does not know the mint or the call fails. One call
 * per would-be entry that reaches the OKX stage; the same response
 * feeds the holder fallback, the liquidity fallback, and the volume
 * logging, so it costs $0 extra beyond the call itself. */
export async function fetchJupiterTokenStats(mint: string): Promise<JupiterTokenStats | null> {
  try {
    const data = await fetchJson("https://lite-api.jup.ag/tokens/v2/search?query=" + encodeURIComponent(mint), 12000);
    return parseJupiterTokenResponse(data, mint);
  } catch {
    return null;
  }
}

/** DexScreener + Jupiter token stats for one mint, one call each
 * (v2.21). The poll calls this ONCE per candidate passing the
 * Rugcheck filter, before the stage-A gem gate, and reuses the
 * pair at stage B and in the holder/liquidity gates — never a
 * second fetch for the same candidate. Both fetchers are
 * fail-null internally, so a failed call yields null stats (flow
 * scores 0, candidate blocks on the gem gate) and never throws
 * into the poll. */
export async function fetchMarketData(mint: string): Promise<{ dex: DexSnapshot | null; jupStats: JupiterTokenStats | null }> {
  const dex = await fetchDexScreener(mint);
  const jupStats = await fetchJupiterTokenStats(mint);
  return { dex, jupStats };
}

/**
 * Jupiter fallback price: Tokens API v2 on lite-api.jup.ag, keyless.
 * Search by full mint, return mcap in USD when the returned id matches.
 * Returns null when Jupiter does not know the mint or the call fails.
 * The authenticated api.jup.ag endpoint is the same API at a higher
 * rate limit, reached via the custom.jupiter helper, not from this code.
 */
export async function fetchJupiterMc(mint: string): Promise<number | null> {
  const stats = await fetchJupiterTokenStats(mint);
  // Preserve the old contract: only a positive mcap is a price; a 0
  // mcap must never become a position's lastMcUsd.
  const mcap = stats?.mcap;
  return typeof mcap === "number" && mcap > 0 ? mcap : null;
}

interface RugcheckReport {
  mintAuthority?: string | null;
  freezeAuthority?: string | null;
  topHolders?: Array<{ address: string; pct: number; owner?: string }>;
  risks?: Array<{ name: string; level: string }>;
  markets?: Array<{ marketType: string; lp?: { lpLockedPct?: number | null } | null; liquidityA?: string | null }>;
  score_normalised?: number;
  rugged?: boolean;
  creatorBalance?: number | null;
  /** v2.22 operator float: token-locker owners, excluded from the
   * real float with the curve / pool-vault addresses. Rugcheck
   * returns this as a RECORD (locker -> owner), not a list — see
   * operatorExcludedAddrs in packages/signals/src/operator.ts. */
  lockerOwners?: Record<string, unknown> | Array<string> | null;
  token?: { supply?: number | null; decimals?: number | null };
  /** v2.14 holder-floor fallback: total holder count from the full
   * report (verified present in live probe responses, research §5). */
  totalHolders?: number | null;
  /** v2.14 liquidity-floor fallback: total market liquidity USD
   * from the full report (verified present, research §5). */
  totalMarketLiquidity?: number | null;
}

/** Creator's current share of supply, in percent, or null when the
 * report does not carry creatorBalance / token supply. Journal-only:
 * devSoldPct itself is not derivable (no initial balance published),
 * so this never gates an entry. */
export function creatorBalancePct(report: RugcheckReport): number | null {
  const bal = report.creatorBalance;
  const supply = report.token?.supply;
  if (typeof bal !== "number" || typeof supply !== "number" || supply <= 0) return null;
  return (bal / supply) * 100;
}

/** Highest LP-locked pct across the report's markets, or null when no
 * market reports one. The summary endpoint aggregates differently
 * (Fartcoin: market 99.8% vs summary 83.2%), so the per-market max
 * from the full report is the value used. */
export function lpLockedPct(report: RugcheckReport): number | null {
  let best: number | null = null;
  for (const m of report.markets ?? []) {
    const pct = m?.lp?.lpLockedPct;
    if (typeof pct === "number" && Number.isFinite(pct) && (best === null || pct > best)) best = pct;
  }
  return best;
}

/** Measured values for the four formerly unmeasured rug fields
 * (v2.19). Each is `number | boolean | null | undefined`: a real
 * measurement passes through, `null`/`undefined` means unmeasured
 * and evaluateRug blocks on it. Never pass a default (0 / false)
 * for a field that was not measured. */
export interface RugMeasuredValues {
  bundlePct?: number | null;
  devSoldPct?: number | null;
  washPct?: number | null;
  token2022?: Token2022Flags | null;
}

export function rugInputFromReport(mint: string, report: RugcheckReport, coin: PumpCoin, sellQuoteOk = false, measured?: RugMeasuredValues): RugInput {
  const curveAddrs = new Set([coin.associated_bonding_curve, coin.bonding_curve]);
  const holders = (report.topHolders ?? []).filter((h) => !curveAddrs.has(h.address) && !curveAddrs.has(h.owner ?? ""));
  const top10 = holders.slice(0, 10).reduce((s, h) => s + (h.pct ?? 0) / 100, 0);
  const single = holders.length > 0 ? Math.max(...holders.map((h) => (h.pct ?? 0) / 100)) : 0;
  // v2.19: the four fields below are MEASURED at stage B of the
  // deep check (see the poll flow) and passed in via `measured`.
  // Without it they are null and evaluateRug blocks on missing hard
  // inputs — the SOUL audit fix v2.18 removed the old invented
  // values (bundle proxy 0.4 * top10, devSold 0, wash 0.1, all
  // Token-2022 flags false). Do NOT re-invent these without a real
  // source. Sources: bundlePct = Helius cluster linkedPct / 100;
  // devSoldPct = Helius creator-tx swap-sold / acquired;
  // washPct = Jupiter stats1h non-organic share; Token-2022 flags
  // = Helius getAccountInfo extension parse. Rugcheck's own
  // token_extensions corroborate the Token-2022 flags but are NOT
  // the source (Helius reads the mint account directly).
  // LP lock, verified post-migration (v2.7): for a migrated coin the
  // full report's markets carry lp.lpLockedPct. > 0 means some LP is
  // locked; 0 means the creator can pull it; no LP data at all means
  // unknown -> null -> evaluateRug fails "lp_state_unknown" -> block.
  // Pre-migration there is no LP yet (bonding curve), so the gate is
  // N/A = true, as before.
  const lpPct = lpLockedPct(report);
  const lpLockedOrBurned = coin.complete ? (lpPct === null ? null : lpPct > 0) : true;
  const t22 = measured?.token2022 ?? null;
  return {
    mint,
    mintAuthorityLive: report.mintAuthority !== null && report.mintAuthority !== undefined,
    freezeAuthorityLive: report.freezeAuthority !== null && report.freezeAuthority !== undefined,
    top10Pct: top10,
    singleWalletPct: single,
    bundlePct: measured?.bundlePct ?? null,
    devSoldPct: measured?.devSoldPct ?? null,
    washPct: measured?.washPct ?? null,
    // sellSimulationOk: a Rugcheck market existed (old rule) OR a
    // Jupiter quote for 1,000 tokens -> SOL returned a real outAmount
    // (v2.7). The quote is only tried when markets are empty.
    lpLockedOrBurned,
    // Liquidity is the Pump.fun canonical pool, falling back to
    // Rugcheck total market liquidity. NEVER the market cap: mcap is
    // not liquidity, and the old fallback let thin tokens pass the
    // $5,000 warn line on mcap alone.
    liquidityUsd: coin.canonical_pool_liquidity_usd ?? report.totalMarketLiquidity ?? null,
    sellSimulationOk: (report.markets ?? []).length > 0 || sellQuoteOk,
    token2022TransferFee: t22 ? t22.transferFee : null,
    token2022TransferHook: t22 ? t22.transferHook : null,
    token2022PermanentDelegate: t22 ? t22.permanentDelegate : null,
    token2022Pause: t22 ? t22.pause : null,
    mutableMetadata: null,
    dataMissing: false,
    timedOut: false,
  };
}

/** Gem inputs from measured data only (SOUL audit fix v2.18). The old
 * code SYNTHESISED buyer growth, buy/sell ratio and inflow from mc
 * velocity + ATH ratio + recency, and fabricated clusterPct 0.1 /
 * washPct 0.1 / socialBeforeFlow false — scores built on invented
 * inputs. The three flow components are now MEASURED (v2.20) from
 * Jupiter stats1h, passed in via `measured` — buySellRatio from
 * buy/sell volume, uniqueBuyerGrowthPct from holderChange,
 * newWalletInflow from numNetBuyers (see the three extractor
 * functions for formulas, units and limits). They are measured
 * BEFORE the stage-A gem gate (v2.21): the poll fetches
 * DexScreener + Jupiter stats once per candidate passing the
 * Rugcheck filter (fetchMarketData) and passes the flow into the
 * stage-A score, reusing the same fetch at stage B — so the 70
 * bar and the 50 fresh-tier bar are reachable at stage A.
 * (Before v2.21 the fetch happened only at stage B, after the
 * gem + cluster gates, so stage A always scored flow 0 and no
 * candidate could ever reach 60 at stage A — stage B was
 * unreachable. The v2.20 comment that called that "the
 * pre-existing two-stage design, not a bug" was wrong: the
 * limitation was total, not partial.) A failed fetch leaves all
 * three null (0 points — the candidate then blocks on the gem
 * gate as before, never on invented values). clusterPct is still
 * null at stage A (the Helius cluster gate runs after the gem
 * gate) and is passed only at the stage-B re-score.
 * With all three measured the ceiling is 100 (growth 25 +
 * buy/sell 20 + inflow 15 + mc-velocity 15 + smart money 15 +
 * recentSmartBuy 10 + migrated/curve 5 + liquidity 5, minus any
 * cluster penalty); a component that is null scores 0, never
 * blocks. marketCapVelocityPct is the measured change since
 * first-seen-in-this-run; curve progress, liquidity, smart money
 * and recentSmartBuy are measured as before. Wash is NOT a gem
 * input any more (v2.20, logged-only — see gem-signal.ts). */
export function gemInputFromCoin(coin: PumpCoin, seen: SeenCoin, positionSol: number, smartMoney?: { wallets: number; minTrades: number }, recentSmartBuy = false, measured?: { clusterPct?: number | null; uniqueBuyerGrowthPct?: number | null; buySellRatio?: number | null; newWalletInflow?: number | null }): GemInput {
  const mcVel = seen.firstMcUsd > 0 ? ((coin.usd_market_cap - seen.firstMcUsd) / seen.firstMcUsd) * 100 : 0;
  return {
    mint: coin.mint,
    uniqueBuyerGrowthPct: measured?.uniqueBuyerGrowthPct ?? null,
    buySellRatio: measured?.buySellRatio ?? null,
    newWalletInflow: measured?.newWalletInflow ?? null,
    marketCapVelocityPct: mcVel,
    smartMoneyWallets: smartMoney?.wallets ?? 0,
    smartMoneyMinTrades: smartMoney?.minTrades ?? 0,
    recentSmartBuy,
    // v2.19: the measured bundle value that feeds the rug check
    // feeds the gem penalty here too (clusterPct > 30% costs 20
    // points). Null at stage A (not yet measured); the stage-B
    // re-score passes the measured value. Wash used to penalise
    // here as well; it does not any more (v2.20, logged-only).
    clusterPct: measured?.clusterPct ?? null,
    socialBeforeFlow: null,
    curveProgressPct: Math.min(100, (coin.usd_market_cap / 69000) * 100),
    migrated: coin.complete,
    liquidityUsd: coin.canonical_pool_liquidity_usd ?? 0,
    positionSol,
  };
}

/** v2.17 discovery source for a candidate: "ws" when the coin came
 * from the WebSocket queue alone, "poll" otherwise (poll coins carry
 * no discoveredVia; a coin in both stays a poll coin). */
export function discoverySource(coin: PumpCoin): "ws" | "poll" | "second-look" {
  return coin.discoveredVia ?? "poll";
}

/**
 * v2.17: build a deep-check journal line for a candidate, tagged
 * with its discovery source. Used for exactly the six entry-decision
 * actions — blocked, okx_signal, sentiment_signal, cobuy_signal,
 * operator_signal, paper_entry — so the journal can answer whether
 * WS discovery produces deep-checks / entries. Every other line
 * (ws_discovery, poll_failed, cluster_unknown, cabal_failed, okx_failed,
 * holder_source_disagreement, risk_haircut, cobuy_failed, operator_failed,
 * watcher closes) keeps plain journalEntry, untagged.
 */
export function deepCheckJournal(
  coin: PumpCoin,
  action: "blocked" | "cooldown_skip" | "okx_signal" | "sentiment_signal" | "cobuy_signal" | "operator_signal" | "paper_entry",
  reason: string,
  extra: Partial<JournalEntry> = {},
): JournalEntry {
  return journalEntry(coin.mint, action, reason, { source: discoverySource(coin), ...extra });
}

export async function runSpotterPoll(state: SpotterState): Promise<SpotterState> {
  const now = Date.now();
  state.polls += 1;
  state.lastPollMs = now;
  // v2.4: daily trade cap. Migrate old state once: if tradeDay is missing,
  // today is the same day the trades already happened, so carry them over
  // instead of resetting to 0 and allowing a full extra cap today.
  const today = todaySast();
  if (state.tradeDay == null) {
    state.tradeDay = today;
    state.tradesToday = state.trades;
  } else if (state.tradeDay !== today) {
    state.tradeDay = today;
    state.tradesToday = 0;
    appendJournal(JOURNAL_PATH, journalEntry("spotter", "new_day", "daily trade cap reset for " + today, { equityUsd: state.equityUsd }));
  }
  // v2.4: live SOL price for this poll. Fail-closed (SOUL audit fix
  // v2.18): if Jupiter cannot price SOL, the poll is skipped — there
  // is NO fallback price anywhere in the desk.
  const liveSol = await fetchSolPriceUsd();
  if (liveSol === null) {
    appendJournal(JOURNAL_PATH, journalEntry("spotter", "poll_failed", "SOL price unavailable, fail-closed", { equityUsd: state.equityUsd }));
    return state;
  }
  const solPrice = liveSol;
  state.solPriceUsd = solPrice;
  const fomoWallets = loadFomoWallets();
  const fomoAlerts = loadFomoAlerts(now);
  const trustedWallets = loadTrustedWallets();
  // v2.8 X-free sentiment inputs (file reads only, $0 extra):
  // recent-buy breadth + graduated-board mints. Birdeye trending
  // is fetched lazily below, at most once per poll, only when a
  // candidate reaches the deep-check stage.
  const fomoRecentBuys = loadFomoRecentBuys(now);
  const graduatedMints = loadGraduatedMints();
  let birdeyeTrending: Map<string, BirdeyeTrendingToken> | null = null;
  // v2.9 CMC market context: lazy, at most 1 quotes call (1 credit) per
  // poll, only when a candidate reaches the deep-check stage. undefined
  // = not yet loaded this poll, null = the call failed (fail-open).
  let cmcMarket: CmcMarket | null | undefined = undefined;
  const trackLoss = (pnl: number, costBasis: number) => {
    if (costBasis > 0 && pnl < 0) {
      state.worstLossPct = Math.min(state.worstLossPct ?? 0, pnl / costBasis);
    }
  };
  let coins: PumpCoin[] = [];
  let fetchError: unknown = null;
  try {
    const fetched = await fetchNewCoins(200);
    coins = fetched.coins;
    if (fetched.source === "jupiter-recent") {
      appendJournal(JOURNAL_PATH, journalEntry("spotter", "discovery_fallback", "Pump.fun feed failed, using Jupiter /tokens/v2/recent (" + coins.length + " coins)", { equityUsd: state.equityUsd }));
    }
  } catch (e) {
    // v2.16: a failed poll feed no longer ends the poll outright —
    // the WS queue may still hold fresh launches. The poll fails
    // below only when BOTH sources are empty.
    fetchError = e;
  }
  // v2.16 WS discovery: merge the fresh slice of the relay queue
  // (launches <= 15 min old — the candidate filter's tradeAgeMin
  // window; merging the whole 24h queue would flood `seen`, pruned
  // at 2,000 entries). The poll row wins for live price/last-trade;
  // the WS row wins for created_timestamp (honest launch age) and
  // fills a missing creator. Every gate below runs unchanged on the
  // merged list — the relay only changes WHEN a launch is seen.
  const wsLoaded = loadWsQueue(WS_QUEUE_PATH, now);
  const wsFresh = wsLoaded.entries.filter((e) => now - e.createdAtMs <= WS_MERGE_MAX_AGE_MS);
  const wsCoins = wsFresh.map((e) => wsCoinToPumpCoin(e, solPrice));
  const merged = mergeWsCoins(coins, wsCoins);
  coins = merged.coins;
  if (merged.wsNewCount > 0) {
    state.wsCoinsSeen = (state.wsCoinsSeen ?? 0) + merged.wsNewCount;
    appendJournal(JOURNAL_PATH, journalEntry("spotter", "ws_discovery", "WS queue contributed " + merged.wsNewCount + " new mint(s) this poll (" + wsLoaded.entries.length + " queued, " + wsLoaded.skipped + " skipped)", { equityUsd: state.equityUsd }));
  }
  if (coins.length === 0) {
    appendJournal(JOURNAL_PATH, journalEntry("spotter", "poll_failed", "Discovery failed: " + String(fetchError ?? "no coins from any discovery source"), { equityUsd: state.equityUsd }));
    return state;
  }
  const byMint = new Map(coins.map((c) => [c.mint, c]));
  for (const coin of coins) {
    const mc = coin.usd_market_cap ?? coin.market_cap_usd ?? 0;
    if (!state.seen[coin.mint]) {
      state.seen[coin.mint] = {
        mint: coin.mint,
        name: coin.name,
        symbol: coin.symbol,
        firstSeenMs: now,
        firstMcUsd: mc,
        lastMcUsd: mc,
        lastSeenMs: now,
        replies: coin.reply_count ?? 0,
        creator: coin.creator,
        complete: coin.complete,
        bondingCurve: coin.bonding_curve,
        associatedBondingCurve: coin.associated_bonding_curve,
      };
    } else {
      const s = state.seen[coin.mint];
      s.lastMcUsd = mc;
      s.lastSeenMs = now;
      s.replies = coin.reply_count ?? s.replies;
      s.complete = coin.complete;
      // v2.28 backfill: records predating v2.28 lack the curve
      // addresses a second-look rebuild needs; fill them when the
      // feed carries them so old records become eligible too.
      if (!s.bondingCurve && coin.bonding_curve) s.bondingCurve = coin.bonding_curve;
      if (!s.associatedBondingCurve && coin.associated_bonding_curve) s.associatedBondingCurve = coin.associated_bonding_curve;
    }
  }
  // Update open positions with current market cap where visible
  // Jupiter fallback: if a position is not in any Pump.fun feed, price it
  // with Jupiter Tokens API v2 by mint before counting it as missed.
  const jupiterMc = new Map<string, number>();
  for (const p of state.positions) {
    const coin = byMint.get(p.mint);
    if (coin) {
      p.lastMcUsd = coin.usd_market_cap ?? coin.market_cap_usd ?? p.lastMcUsd;
      p.missedPolls = 0;
    } else {
      const mc = await fetchJupiterMc(p.mint);
      if (mc !== null) {
        jupiterMc.set(p.mint, mc);
        p.lastMcUsd = mc;
        p.missedPolls = 0;
        state.jupiterRescues = (state.jupiterRescues ?? 0) + 1;
      } else {
        p.missedPolls = (p.missedPolls ?? 0) + 1;
      }
    }
  }
  // v2.24: top-holder exit watch (wallet-tracker --holders-of pattern).
  // LOGGED SIGNAL ONLY — never exits, never resizes. For each open
  // position with an entry snapshot, re-fetch the Rugcheck report and
  // diff its top holders against the snapshot. A top-5 holder halving
  // or leaving the top 10 journals holder_exit. Fail-open: a fetch
  // failure or a report without topHolders skips silently. Max 3
  // Rugcheck calls per poll (one per open position).
  for (const p of state.positions) {
    const snap = p.topHoldersAtEntry;
    if (!snap || snap.length === 0) continue;
    let fresh: unknown;
    try {
      fresh = await fetchRugcheck(p.mint);
    } catch {
      continue;
    }
    const rep = fresh as RugcheckReport | null;
    if (!rep || !Array.isArray(rep.topHolders)) continue;
    const excluded = new Set(p.holderExcludedAddrs ?? []);
    const current = topHoldersSnapshot(rep, excluded, 10);
    const exits = holderExits(snap, current);
    if (exits.length === 0) continue;
    state.holderExitSignals = (state.holderExitSignals ?? 0) + 1;
    const desc = exits
      .map((e) => `${e.owner.slice(0, 8)} ${e.pctAtEntry.toFixed(1)}% -> ${e.pctNow.toFixed(1)}% (${e.kind === "left_top10" ? "left top 10" : "halved"})`)
      .join("; ");
    appendJournal(JOURNAL_PATH, journalEntry(p.mint, "holder_exit", `top holder exit: ${desc}`, { equityUsd: state.equityUsd }));
  }
  // v2.28 second-look (48h paper experiment from 2026-11-24 ~19:55
  // SAST): transient Rugcheck failures are re-checked at age 30-120
  // min in 2 reserved slice slots. Candidates come from state, not
  // the poll list — a 30-min-old token is long gone from the
  // newest-200 feed. Current mc is one keyless Jupiter call each
  // (max 2/poll); no price -> skipped this poll, stays eligible
  // while age < 120 min. The coins carry discoveredVia
  // "second-look", so every deep-check line they produce is tagged
  // source "second-look" in the journal.
  const secondLookCoins: PumpCoin[] = [];
  for (const mint of pickSecondLookCandidates(state, now, SECOND_LOOK_SLOTS)) {
    const mc = await fetchJupiterMc(mint);
    if (mc === null) continue;
    const coin = buildSecondLookCoin(state, mint, mc, now);
    if (!coin) continue;
    secondLookCoins.push(coin);
    appendJournal(JOURNAL_PATH, journalEntry(mint, "second_look", "second-look re-check at age " + Math.round((now - (state.seen[mint]?.firstSeenMs ?? now)) / 60000) + "m, mc $" + Math.round(mc), { equityUsd: state.equityUsd }));
  }
  // Rank candidates: real age under 12h, mc 1000 to 100000, velocity and ATH ratio
  const ranked = coins
    .filter((c) => {
      const ageMin = (now - c.created_timestamp) / 60000;
      const mc = c.usd_market_cap ?? 0;
      const tradeAgeMin = c.last_trade_timestamp ? (now - c.last_trade_timestamp) / 60000 : 999;
      return ageMin < 720 && tradeAgeMin < 15 && mc >= 1000 && mc <= 100000 && !state.positions.some((p) => p.mint === c.mint);
    })
    .map((c) => {
      const s = state.seen[c.mint];
      const mcVel = s.firstMcUsd > 0 ? ((c.usd_market_cap - s.firstMcUsd) / s.firstMcUsd) * 100 : 0;
      const ath = c.ath_market_cap ?? c.usd_market_cap;
      const athRatio = ath > 0 ? c.usd_market_cap / ath : 0;
      const tradeAgeMin = c.last_trade_timestamp ? (now - c.last_trade_timestamp) / 60000 : 999;
      const recency = tradeAgeMin < 5 ? 30 : tradeAgeMin < 15 ? 15 : 0;
      return { coin: c, score: Math.max(0, mcVel) + athRatio * 50 + recency + Math.log10(Math.max(1, c.usd_market_cap)) * 5, mcVel };
    })
    .sort((a, b) => b.score - a.score);
  // v2.28 (P1): the cooldown filter runs BEFORE slicing, so the
  // slice holds 8 fresh candidates instead of ~5.1. The main
  // ranking fills 8 minus the second-look coins built above; the
  // in-loop cooldown check stays as a safety net.
  const candidates = filterCooldownBlocked(ranked, state, now).slice(0, SLICE_CANDIDATES - secondLookCoins.length);
  const deepCheckList = [...candidates, ...secondLookCoins.map((coin) => ({ coin }))];
  // Deep check top candidates, one at a time to respect rate limits
  for (const { coin } of deepCheckList) {
    if (state.halted) break;
    if (state.positions.length >= MICRO_PROFILE.maxOpenPositions) break;
    if ((state.tradesToday ?? state.trades) >= MICRO_PROFILE.maxTradesPerDay) break;
    // v2.10: re-entry cooldown. A mint that closed recently may not
    // be entered again until 30 minutes have passed — checked here,
    // before the Rugcheck fetch, so a blocked re-entry costs no API
    // calls either.
    const reentry = isReentryBlocked(state, coin.mint, now);
    if (reentry) {
      state.blocked += 1;
      appendJournal(JOURNAL_PATH, deepCheckJournal(coin, "blocked", "re-entry cooldown: closed " + Math.round((now - reentry.closedAtMs) / 60000) + "m ago at mc $" + Math.round(reentry.exitMcUsd) + ", now $" + Math.round(coin.usd_market_cap ?? 0), { equityUsd: state.equityUsd }));
      continue;
    }
    // v2.23: blocked-mint cooldown. A mint blocked recently is not
    // re-deep-checked until the cooldown expires (or its mc rose a
    // lot) — checked here, before the Rugcheck fetch, so a skip
    // costs no API calls. Skips are journaled separately as
    // cooldown_skip and counted, never as blocks.
    const cooldownMs = blockedCooldownRemaining(state, coin.mint, now, coin.usd_market_cap ?? 0);
    if (cooldownMs > 0) {
      state.cooldownSkips = (state.cooldownSkips ?? 0) + 1;
      appendJournal(JOURNAL_PATH, deepCheckJournal(coin, "cooldown_skip", "blocked-mint cooldown: " + Math.round(cooldownMs / 60000) + "m left, mc $" + Math.round(coin.usd_market_cap ?? 0), { equityUsd: state.equityUsd }));
      continue;
    }
    const seen = state.seen[coin.mint];
    let report: RugcheckReport;
    try {
      report = (await fetchRugcheck(coin.mint)) as RugcheckReport;
    } catch (e) {
      state.blocked += 1;
      noteBlocked(state, coin.mint, now, coin.usd_market_cap ?? 0, false);
      appendJournal(JOURNAL_PATH, deepCheckJournal(coin, "blocked", "Rugcheck fetch failed, fail-closed", { equityUsd: state.equityUsd }));
      continue;
    }
    // v2.7: Rugcheck's own rugged flag blocks outright.
    if (report.rugged === true) {
      state.blocked += 1;
      noteBlocked(state, coin.mint, now, coin.usd_market_cap ?? 0, false);
      appendJournal(JOURNAL_PATH, deepCheckJournal(coin, "blocked", "Rugcheck flags token rugged", { equityUsd: state.equityUsd }));
      continue;
    }
    // v2.7: real sell simulation only when Rugcheck lists no markets.
    // A Jupiter quote with a real outAmount counts as sellable; a
    // failed quote changes nothing (markets rule still applies).
    let sellQuoteOk = false;
    if ((report.markets ?? []).length === 0) {
      sellQuoteOk = await fetchJupiterSellQuoteOk(coin.mint, report.token?.decimals ?? null);
    }
    // Stage A of the two-stage rug evaluation (v2.19): the six
    // expensive rug fields (bundle/devSold/Token-2022) are
    // DEFERRED — they land in rug.deferred, not rug.failed — so
    // the cheap legs (mint/freeze, concentration, LP, liquidity,
    // sell-sim) can filter first without spending Helius calls.
    // A stage-A "pass" with deferred fields is PROVISIONAL:
    // stage B (below, after the gem + cluster gates) measures them
    // and re-evaluates with no deferral before any entry. The
    // DexScreener + Jupiter fetch is NOT deferred (v2.21): it
    // runs below, before the gem gate, because the gem gate
    // scores measured flow from it.
    let rugInput = rugInputFromReport(coin.mint, report, coin, sellQuoteOk);
    const lpNote = coin.complete ? " lpLocked=" + (lpLockedPct(report) ?? "unknown") + "%" : "";
    let rug = evaluateRug(rugInput, { deferFields: RUG_DEFERRED_FIELDS });
    const rugcheckScore = report.score_normalised ?? 0;
    if (rugcheckScore > 50) {
      state.blocked += 1;
      // v2.28: classify the failure — permanent (creator-history
      // danger / live mint-freeze authority) takes the 24h tier and
      // is never second-looked; transient (concentration / low
      // liquidity) takes the 15m tier and becomes second-look
      // eligible at age 30-120 min. The score bar itself is
      // unchanged (still > 50 blocks).
      const failureKind = classifyRugcheckFailure(report);
      noteBlocked(state, coin.mint, now, coin.usd_market_cap ?? 0, failureKind === "transient", failureKind);
      appendJournal(JOURNAL_PATH, deepCheckJournal(coin, "blocked", "Rugcheck score " + rugcheckScore + " > 50", { score: rugcheckScore, equityUsd: state.equityUsd }));
      continue;
    }
    // v2.21: DexScreener + Jupiter token stats are fetched HERE,
    // before the stage-A gem gate — the gem flow components are
    // measured from this single fetch and scored at stage A, so
    // the 70 bar / 50 fresh-tier bar are reachable. The same pair
    // is reused at stage B and in the holder/liquidity gates
    // below (fetchMarketData is called once per candidate; never
    // re-fetched). The Helius cluster gate stays AFTER the gem
    // gate (it is the expensive call; the gem gate exists to
    // protect it). A failed fetch yields null stats: flow scores
    // 0 and the candidate blocks on the gem gate as before — it
    // never crashes the poll or invents values.
    const { dex, jupStats } = await fetchMarketData(coin.mint);
    const stageAFlow = stageAFlowFromJupiterStats(jupStats);
    // v2.28 (P6): mc velocity at stage A, for the flow note on the
    // stage-A block lines below.
    const mcVelA = seen.firstMcUsd > 0 ? (((coin.usd_market_cap ?? 0) - seen.firstMcUsd) / seen.firstMcUsd) * 100 : 0;
    const dangerRisks = (report.risks ?? []).filter((r) => r.level === "danger");
    // Fresh-launch tier (v2): top10 <= 50% and single <= 25% are allowed
    // ONLY when the rug check failed on concentration flags alone,
    // Rugcheck score <= 20 and no danger risk, at 22% size.
    // isFreshTier() requires failed.length > 0 — a clean rug check is
    // not the fresh tier (v2.12 audit fix, vacuous [].every()).
    let freshTier = isFreshTier(rug.failed, rugInput.top10Pct, rugInput.singleWalletPct, rugcheckScore, dangerRisks.length);
    // v2.7: 22% of equity per position (micro profile), no extra 0.75
    // haircut — the old code sized 40% * 0.75 = 30%. Cluster-unknown
    // entries still take a further 0.75 below.
    const sizeUsd = positionSizeUsd(state.equityUsd);
    const positionSol = sizeUsd / solPrice;
    // v2.4: smart money from the Fomo feed, matched against the
    // curve-excluded top holders. No extra API call, the feed file
    // is at most 6 hours old. v2.26: the gem bonus counts TRUSTED
    // wallets only (validated Helius PnL) — a Fomo-listed holder
    // that never validated adds nothing. fomoCount is the pre-filter
    // count, journaled as smartMoney=trusted/fomo.
    const curveAddrsForGem = new Set([coin.associated_bonding_curve, coin.bonding_curve]);
    const trustedMoney = trustedSmartMoney(report.topHolders ?? [], curveAddrsForGem, fomoWallets, trustedWallets);
    const smartMoney = { wallets: trustedMoney.wallets, minTrades: trustedMoney.minTrades };
    const fomoCount = trustedMoney.fomoWallets;
    // v2.26: the +10 recent-smart-buy boost fires only for trusted
    // traders, and its buy count is restricted to theirs.
    const alertBuyRaw = fomoAlerts.get(coin.mint);
    const trustedTraders = alertBuyRaw ? trustedAlertTraders(alertBuyRaw.traders, trustedWallets) : [];
    const alertBuy =
      alertBuyRaw && trustedTraders.length > 0
        ? { ...alertBuyRaw, buys: trustedTraders.reduce((s, t) => s + (alertBuyRaw.buysByTrader[t] ?? 0), 0), traders: trustedTraders }
        : undefined;
    if (alertBuy) state.alertBoosts = (state.alertBoosts ?? 0) + 1;
    const alertNote = alertBuy ? "smart-buy " + alertBuy.buys + "x $" + Math.round(alertBuy.usdValue ?? 0) + " by " + alertBuy.traders.join(",") + " in last 60m" : "";
    // creatorBalancePct (Rugcheck creatorBalance) is NOT journaled
    // as a holding any more (v2.19): it is systematically 0 for
    // pump.fun tokens — Pikachu/Betty/KYC all report 0 while the
    // creators' own txs / OKX show real holdings (Pikachu dev
    // holds ~1.7%) — so "creatorHold=0.00%" was false signal. The
    // stage-B measured devSold replaces it as the creator signal.
    let gem = evaluateGem(gemInputFromCoin(coin, seen, positionSol, smartMoney, !!alertBuy, { uniqueBuyerGrowthPct: stageAFlow.uniqueBuyerGrowthPct, buySellRatio: stageAFlow.buySellRatio, newWalletInflow: stageAFlow.newWalletInflow }), rug);
    if (!gem.actionable && !freshTier) {
      state.blocked += 1;
      // v2.28: only a Rugcheck-driven block gets classified (a gem
      // / break-even block keeps the 60m tier, kind unset). The flow
      // note (P6) journals the stage-A components with the block.
      const failureKind = gem.reason.startsWith("rug check blocked") ? classifyRugcheckFailure(report) : undefined;
      noteBlocked(state, coin.mint, now, coin.usd_market_cap ?? 0, failureKind === "transient", failureKind);
      appendJournal(JOURNAL_PATH, deepCheckJournal(coin, "blocked", gem.reason + " | top10=" + Math.round((rugInput.top10Pct ?? 0) * 100) + "% single=" + Math.round((rugInput.singleWalletPct ?? 0) * 100) + "% rugcheck=" + rugcheckScore + lpNote + " | " + stageAFlowNote(stageAFlow, mcVelA, smartMoney.wallets, fomoCount, !!alertBuy), { score: gem.score, equityUsd: state.equityUsd }));
      continue;
    }
    if (!gem.actionable && freshTier && gem.score < FRESH_TIER_MIN_GEM) {
      state.blocked += 1;
      noteBlocked(state, coin.mint, now, coin.usd_market_cap ?? 0, false);
      appendJournal(JOURNAL_PATH, deepCheckJournal(coin, "blocked", gem.reason + " fresh tier, score below " + FRESH_TIER_MIN_GEM + " | " + stageAFlowNote(stageAFlow, mcVelA, smartMoney.wallets, fomoCount, !!alertBuy), { score: gem.score }));
      continue;
    }
    // Helius funder-cluster gate (v2.2): only for candidates that would
    // otherwise enter, so Helius is not hammered on every scanned coin.
    // Top 6 curve-excluded holders, by owner wallet, pct in percent.
    const curveAddrs = new Set([coin.associated_bonding_curve, coin.bonding_curve]);
    const clusterHolders = (report.topHolders ?? [])
      .filter((h) => h.owner && !curveAddrs.has(h.address) && !curveAddrs.has(h.owner ?? ""))
      .slice(0, 6)
      .map((h) => ({ owner: h.owner as string, pct: h.pct ?? 0 }));
    let entrySizeUsd = sizeUsd;
    if (clusterHolders.length === 0) {
      state.blocked += 1;
      noteBlocked(state, coin.mint, now, coin.usd_market_cap ?? 0, true);
      appendJournal(JOURNAL_PATH, deepCheckJournal(coin, "blocked", "cluster check: no holders to check, fail-closed", { equityUsd: state.equityUsd }));
      continue;
    }
    const cluster = await checkCluster(coin.mint, clusterHolders, coin.creator);
    if (cluster === null) {
      state.blocked += 1;
      noteBlocked(state, coin.mint, now, coin.usd_market_cap ?? 0, true);
      appendJournal(JOURNAL_PATH, deepCheckJournal(coin, "blocked", "cluster check failed, fail-closed", { equityUsd: state.equityUsd }));
      continue;
    }
    if (cluster.clustered) {
      state.blocked += 1;
      state.clusterBlocks = (state.clusterBlocks ?? 0) + 1;
      noteBlocked(state, coin.mint, now, coin.usd_market_cap ?? 0, false);
      appendJournal(JOURNAL_PATH, deepCheckJournal(coin, "blocked", "cluster: " + cluster.reason, { equityUsd: state.equityUsd }));
      continue;
    }
    // SOUL audit fix v2.18: >= half of checked holders with unknown
    // funders BLOCKS (the cluster verdict is unknowable); below half
    // keeps the 0.75x haircut as a documented partial-unknown posture.
    if (cluster.unknown >= Math.ceil(cluster.checked / 2)) {
      state.blocked += 1;
      noteBlocked(state, coin.mint, now, coin.usd_market_cap ?? 0, true);
      appendJournal(JOURNAL_PATH, deepCheckJournal(coin, "blocked", "cluster: " + cluster.unknown + "/" + cluster.checked + " holders had no funding history (>= half), fail-closed", { equityUsd: state.equityUsd }));
      continue;
    }
    if (cluster.unknown > 0) {
      entrySizeUsd = sizeUsd * 0.75;
      appendJournal(JOURNAL_PATH, journalEntry(coin.mint, "cluster_unknown", "no shared funder found, but " + cluster.unknown + "/" + cluster.checked + " holders had no funding history, reduced size", { equityUsd: state.equityUsd }));
    }
    // v2.14 market-structure inputs (research §6, journal-validated
    // on n=21). dex + jupStats were fetched ONCE above, before the
    // stage-A gem gate (v2.21), and are reused here at stage B, in
    // the holder / liquidity gates, the sentiment section, and the
    // volume logging on entry — no extra calls, no re-fetch.
    // Stage B — measure the six deferred rug fields (v2.19) and
    // re-evaluate the rug check with NO deferral. Only candidates
    // that passed stage A + the gem gate + the cluster gate reach
    // here, so the one new call (Helius getAccountInfo for the
    // Token-2022 flags) costs nothing on filtered coins. A null
    // for any field is unknown and the re-evaluation blocks.
    // Wash is measured here too but is logged-only since v2.20
    // (it never gates); the three gem flow components are measured
    // from the same jupStats and fed into the re-score below.
    // Every measured value is journaled with its source in
    // measuredNote (stageBMeasuredNote), so a later reader can see
    // where it came from.
    const bundlePct = bundlePctFromCluster(cluster);
    const devSoldPct = devSoldPctFromCluster(cluster);
    const washPct = washPctFromJupiterStats(jupStats);
    const t22 = await checkToken2022(coin.mint);
    const uniqueBuyerGrowthPct = uniqueBuyerGrowthPctFromJupiterStats(jupStats);
    const buySellRatio = buySellRatioFromJupiterStats(jupStats);
    const newWalletInflow = newWalletInflowFromJupiterStats(jupStats);
    const measuredNote = stageBMeasuredNote(
      { bundlePct, devSoldPct, washPct, token2022: t22, uniqueBuyerGrowthPct, buySellRatio, newWalletInflow },
      cluster.devSold,
    );
    rugInput = rugInputFromReport(coin.mint, report, coin, sellQuoteOk, { bundlePct, devSoldPct, washPct, token2022: t22 });
    rug = evaluateRug(rugInput);
    // Re-score the gem with the measured flow components and the
    // measured cluster penalty, and re-check the fresh tier against
    // the FULL failure list: a stage-B failure on bundle/devSold/
    // Token-2022 is not a concentration failure, so it cannot enter
    // via the fresh tier.
    freshTier = isFreshTier(rug.failed, rugInput.top10Pct, rugInput.singleWalletPct, rugcheckScore, dangerRisks.length);
    gem = evaluateGem(gemInputFromCoin(coin, seen, positionSol, smartMoney, !!alertBuy, { clusterPct: bundlePct, uniqueBuyerGrowthPct, buySellRatio, newWalletInflow }), rug);
    if (!gem.actionable && !freshTier) {
      state.blocked += 1;
      noteBlocked(state, coin.mint, now, coin.usd_market_cap ?? 0, false);
      appendJournal(JOURNAL_PATH, deepCheckJournal(coin, "blocked", gem.reason + " | " + measuredNote, { score: gem.score, equityUsd: state.equityUsd }));
      continue;
    }
    if (!gem.actionable && freshTier && gem.score < FRESH_TIER_MIN_GEM) {
      state.blocked += 1;
      noteBlocked(state, coin.mint, now, coin.usd_market_cap ?? 0, false);
      appendJournal(JOURNAL_PATH, deepCheckJournal(coin, "blocked", gem.reason + " fresh tier, score below " + FRESH_TIER_MIN_GEM + " | " + measuredNote, { score: gem.score }));
      continue;
    }
    // Cabal-Hunter second opinion (v2.3): only for candidates that
    // would otherwise enter. Block only on HIGH risk, score >= 65,
    // or honeypot HIGH. A failed scan never blocks.
    const cabal = await checkCabal(coin.mint);
    let cabalNote = "cabal: check failed, proceeding on Helius verdict";
    if (cabal !== null) {
      cabalNote = "cabal: risk=" + cabal.risk + " score=" + (cabal.cabal_score ?? "unknown") + " honeypot=" + (cabal.honeypot_risk ?? "unknown");
      // A missing score never blocks (typeof check) — a scan that
      // returned no score is not a clean 0.
      if (cabal.risk === "HIGH" || (typeof cabal.cabal_score === "number" && cabal.cabal_score >= 65) || cabal.honeypot_risk === "HIGH") {
        state.blocked += 1;
        state.cabalBlocks = (state.cabalBlocks ?? 0) + 1;
        noteBlocked(state, coin.mint, now, coin.usd_market_cap ?? 0, false);
        appendJournal(JOURNAL_PATH, deepCheckJournal(coin, "blocked", cabalNote, { equityUsd: state.equityUsd }));
        continue;
      }
    } else {
      appendJournal(JOURNAL_PATH, journalEntry(coin.mint, "cabal_failed", cabalNote, { equityUsd: state.equityUsd }));
    }
    // OKX signal (v2.5): LOGGED ONLY since v2.18 (SOUL audit fix) —
    // every field, including cluster concentration. OKX labels were
    // inverted against paper outcomes (KYC passed, Betty flagged),
    // so no OKX field gates or haircuts an entry. Helius is the
    // cluster authority. A null OKX result is logged as okx_failed,
    // never a block.
    const okx = await checkOkx(coin.mint);
    let okxNote = "okx: check failed, no signal";
    if (okx !== null) {
      state.okxSignals = (state.okxSignals ?? 0) + 1;
      okxNote =
        "okx: bundlers=" + (okx.bundlers ?? "?") +
        " bundlerAth=" + (okx.bundlerAthPercent ?? "?") + "%" +
        " devTokens=" + (okx.devTokens ?? "?") +
        " devRugs=" + (okx.devRugs ?? "?") +
        " devHold=" + (okx.devHoldingPercent ?? "?") + "%" +
        " top10=" + (okx.top10Percent ?? "?") + "%" +
        " insiders=" + (okx.insidersPercent ?? "?") + "%" +
        " snipers=" + (okx.snipersPercent ?? "?") + "%" +
        " fresh=" + (okx.freshWalletsPercent ?? "?") + "%" +
        " phishing=" + (okx.phishingPercent ?? "?") + "%" +
        " holders=" + (okx.totalHolders ?? "?") +
        " cluster=" + (okx.clusterConcentration ?? "?") +
        " sameFund=" + (okx.holderSameFundSourcePercent ?? "?");
      appendJournal(JOURNAL_PATH, deepCheckJournal(coin, "okx_signal", okxNote, { equityUsd: state.equityUsd }));
    } else {
      appendJournal(JOURNAL_PATH, journalEntry(coin.mint, "okx_failed", okxNote, { equityUsd: state.equityUsd }));
    }
    // v2.14 market-structure hard gates (research §6, journal-validated
    // on n=21). dex + jupStats were fetched above (before the
    // stage-A gem gate, v2.21) and are reused by the gates, the
    // sentiment section below, and the volume logging on entry —
    // no extra calls.
    // Gate 1 — OKX cluster: DEMOTED to logged-only (SOUL audit fix
    // v2.18). The okx_signal line above is the whole OKX contribution
    // now; the cluster value never blocks or haircuts. Helius is the
    // cluster authority.
    // Gate 2 — holder floor: block when holders < 200. OKX primary,
    // Rugcheck / Jupiter fallback; MIN on disagreement, journaled.
    // Fail-closed on total absence (standing rule: missing data =
    // block) — the count is present on every journaled entry, so an
    // absence means a data outage and the journal line says so.
    const holderRes = resolveHolderCount(okx?.totalHolders ?? null, report.totalHolders ?? null, jupStats?.holderCount ?? null);
    if (holderRes.disagreement) {
      appendJournal(JOURNAL_PATH, journalEntry(coin.mint, "holder_source_disagreement", "holder sources disagree, using min " + holderRes.holders + " (" + holderRes.source + "): okx=" + (okx?.totalHolders ?? "?") + " rugcheck=" + (report.totalHolders ?? "?") + " jupiter=" + (jupStats?.holderCount ?? "?"), { equityUsd: state.equityUsd }));
    }
    if (isHolderFloorBlock(holderRes.holders)) {
      state.blocked += 1;
      state.holderFloorBlocks = (state.holderFloorBlocks ?? 0) + 1;
      noteBlocked(state, coin.mint, now, coin.usd_market_cap ?? 0, true);
      appendJournal(JOURNAL_PATH, deepCheckJournal(coin, "blocked", "holder_floor_gate: holders " + (holderRes.holders === null ? "unknown (all sources missing), fail-closed" : holderRes.holders + " (" + holderRes.source + ")") + " < 200, hard gate v2.14 | " + measuredNote, { equityUsd: state.equityUsd }));
      continue;
    }
    // Gate 3 — liquidity floor: block when liquidity < $8,000.
    // MIN across the Pump.fun canonical pool, Rugcheck, Jupiter and
    // DexScreener values (fail-closed). Fail-closed on total
    // absence, same reasoning as gate 2.
    const liqRes = resolveLiquidityUsd(coin.canonical_pool_liquidity_usd ?? null, report.totalMarketLiquidity ?? null, jupStats?.liquidityUsd ?? null, dex?.liquidityUsd ?? null);
    if (isLiquidityFloorBlock(liqRes.liquidityUsd)) {
      state.blocked += 1;
      state.liquidityFloorBlocks = (state.liquidityFloorBlocks ?? 0) + 1;
      noteBlocked(state, coin.mint, now, coin.usd_market_cap ?? 0, true);
      appendJournal(JOURNAL_PATH, deepCheckJournal(coin, "blocked", "liquidity_floor_gate: liquidity $" + (liqRes.liquidityUsd === null ? "unknown (all sources missing), fail-closed" : Math.round(liqRes.liquidityUsd) + " (" + liqRes.source + ")") + " < $8,000, hard gate v2.14 | " + measuredNote, { equityUsd: state.equityUsd }));
      continue;
    }
    // Sentiment tracker v2.8 (X-free): LOGGED SIGNAL ONLY. Never
    // blocks, never changes size or score — it only writes a
    // sentiment_signal journal entry and a note on the paper_entry
    // reason, so its predictive value can be measured later against
    // outcomes (same pattern as the OKX logged signal). All sources
    // are already owned: Fomo alerts/feed files, Birdeye trending
    // (lazy, max 1 call/poll), DexScreener public (keyless, per
    // would-be entry). Missing data = component 0, verdict "unknown".
    const alertBuyForSentiment = fomoAlerts.get(coin.mint);
    const recentForSentiment = fomoRecentBuys.get(coin.mint);
    if (birdeyeTrending === null) birdeyeTrending = await loadBirdeyeTrending(20);
    // v2.9 CMC market context (logged signal only, same contract as v2.8):
    // one quotes call per poll, cached; a failed call is component 0.
    if (cmcMarket === undefined) cmcMarket = await loadCmcMarket();
    // v2.14: dex was already fetched above for the gates — reused
    // here, not re-fetched.
    const trend = birdeyeTrending.get(coin.mint);
    const sentiment = scoreSentiment({
      mint: coin.mint,
      smartBuyers: alertBuyForSentiment?.traders ?? [],
      smartBuyUsd: alertBuyForSentiment?.usdValue ?? 0,
      recentBuyers: recentForSentiment?.traders ?? [],
      onGraduatedBoard: graduatedMints.has(coin.mint),
      birdeyeRank: trend?.rank ?? null,
      birdeyeVolumeChangePct: trend?.volumeChangePct ?? null,
      dexVolumeH24: dex?.volumeH24 ?? null,
      dexVolumeH1: dex?.volumeH1 ?? null,
      dexTxnsH24: dex?.txnsH24 ?? null,
      dexMcapUsd: dex?.mcapUsd ?? coin.usd_market_cap,
      cmcSolChange24hPct: cmcMarket?.solChange24hPct ?? null,
      cmcBtcChange24hPct: cmcMarket?.btcChange24hPct ?? null,
      cmcCredits: cmcMarket?.credits ?? null,
    });
    state.sentimentSignals = (state.sentimentSignals ?? 0) + 1;
    const cmcBtcPct = sentiment.cmcBtcChange24hPct ?? 0;
    const sentimentNote =
      "sentiment: " + sentiment.verdict + " " + sentiment.score +
      " (smart " + sentiment.components.smartCluster +
      ", board " + sentiment.components.board +
      ", trending " + sentiment.components.trending +
      ", volume " + sentiment.components.volume +
      ", breadth " + sentiment.components.breadth +
      ", cmc " + sentiment.components.cmcMarket +
      (sentiment.cmcSolChange24hPct !== null
        ? " [SOL " + (sentiment.cmcSolChange24hPct >= 0 ? "+" : "") + sentiment.cmcSolChange24hPct.toFixed(2) +
          "% BTC " + (cmcBtcPct >= 0 ? "+" : "") + cmcBtcPct.toFixed(2) +
          "%, " + (sentiment.cmcCredits ?? 0) + "cr]"
        : "") +
      "; sources: " + (sentiment.sources.join(",") || "none") + ")";
    appendJournal(JOURNAL_PATH, deepCheckJournal(coin, "sentiment_signal", sentimentNote, { score: sentiment.score, equityUsd: state.equityUsd, ...entryFlowStats(dex, jupStats, now) }));
    // Open paper position. v2.13 elevated-risk haircut (sentiment
    // only since v2.18 — the OKX leg was deleted): halve the entry
    // when sentiment is cold on real volume data (see
    // isElevatedRisk). Applied BEFORE the buy fee so the fee is
    // charged on the halved size. Never stacks with itself; it
    // multiplies the cluster-unknown 0.75x when both apply.
    const elevatedRisk = isElevatedRisk(
      sentiment.score,
      sentiment.sources.includes("dexscreener"),
    );
    if (elevatedRisk) {
      entrySizeUsd = entrySizeUsd * RISK_HAIRCUT;
      state.riskHaircuts = (state.riskHaircuts ?? 0) + 1;
      appendJournal(
        JOURNAL_PATH,
        journalEntry(coin.mint, "risk_haircut", "elevated-risk cohort: entry size halved 0.5x (cold sentiment " + sentiment.score + " on DexScreener volume data)", { equityUsd: state.equityUsd }),
      );
    }
    // v2.15 Jupiter sell-simulation gate (million-inspired): quote
    // SELLING the would-be position itself, at the FINAL entry size
    // (after the haircut above, so the quote is exact, not for a
    // bigger size than entered). Block when Jupiter refuses the
    // quote (no route), returns zero output, output < 50% of
    // expected, or price impact > 10%. A network / timeout / 5xx /
    // 429 failure after bounded retry is a TRANSIENT: it BLOCKS too
    // (SOUL audit fix v2.18 — the old fail-open transient is gone;
    // an untested token must not enter). Supply or decimals missing
    // = cannot size the quote = fail-closed block (standing rule:
    // missing data = block).
    let sellSimFields: { sellSimOutLamports?: number | null; sellSimExpectedLamports?: number | null; sellSimImpactPct?: number | null } = {};
    const simBaseUnits = tokenBaseUnits(entrySizeUsd, coin.usd_market_cap, report.token?.supply ?? null, report.token?.decimals ?? null);
    if (simBaseUnits === null) {
      state.blocked += 1;
      state.sellSimBlocks = (state.sellSimBlocks ?? 0) + 1;
      noteBlocked(state, coin.mint, now, coin.usd_market_cap ?? 0, true);
      appendJournal(JOURNAL_PATH, deepCheckJournal(coin, "blocked", "sell_sim_gate: cannot size sell quote, token supply or decimals missing, fail-closed", { equityUsd: state.equityUsd }));
      continue;
    }
    const simResult = await fetchJupiterSellQuote(coin.mint, simBaseUnits);
    if (simResult.kind === "noRoute") {
      state.blocked += 1;
      state.sellSimBlocks = (state.sellSimBlocks ?? 0) + 1;
      noteBlocked(state, coin.mint, now, coin.usd_market_cap ?? 0, false);
      appendJournal(JOURNAL_PATH, deepCheckJournal(coin, "blocked", "sell_sim_gate: Jupiter returned no route for a sell of $" + entrySizeUsd.toFixed(2) + " (HTTP " + simResult.status + ") — unsellable at this size", { equityUsd: state.equityUsd }));
      continue;
    }
    if (simResult.kind === "transient") {
      state.blocked += 1;
      state.sellSimTransient = (state.sellSimTransient ?? 0) + 1;
      noteBlocked(state, coin.mint, now, coin.usd_market_cap ?? 0, true);
      appendJournal(JOURNAL_PATH, deepCheckJournal(coin, "blocked", "sell_sim_gate: sell quote failed after bounded retry (network/timeout/5xx/429), fail-closed — no entry without a sell quote", { equityUsd: state.equityUsd }));
      continue;
    }
    const expected = expectedOutLamports(entrySizeUsd, solPrice);
    const decision = decideSellSim(simResult.quote, expected);
    sellSimFields = { sellSimOutLamports: simResult.quote.outAmountLamports, sellSimExpectedLamports: expected, sellSimImpactPct: simResult.quote.priceImpactPct };
    if (decision.verdict !== "pass") {
      state.blocked += 1;
      state.sellSimBlocks = (state.sellSimBlocks ?? 0) + 1;
      noteBlocked(state, coin.mint, now, coin.usd_market_cap ?? 0, false);
      appendJournal(JOURNAL_PATH, deepCheckJournal(coin, "blocked", "sell_sim_gate: " + decision.reason + " (expected " + (expected ?? "unknown") + " lamports)", { equityUsd: state.equityUsd }));
      continue;
    }
    // v2.15 co-buy logged signal (million-inspired): LOGGED ONLY,
    // never blocks, never changes size. Runs only for would-be
    // entries that passed every gate above, so its cost is one
    // Helius read per entry, not per candidate. A failed check
    // journals cobuy_failed and proceeds.
    const coBuy = await checkCoBuy(coin.mint, now / 1000, clusterHolders, coin.associated_bonding_curve ?? coin.bonding_curve);
    let coBuyNoteText = "cobuy: check failed, no signal";
    let coBuyFields: { coBuyMaxAcquirersInSlot?: number | null; coBuyDistinctAcquirers?: number | null; coBuyTopShare?: number | null; coBuyFlagged?: boolean } = {};
    if (coBuy !== null) {
      state.coBuySignals = (state.coBuySignals ?? 0) + 1;
      const flagged = isCoBuyFlagged(coBuy);
      coBuyNoteText = coBuyNote(coBuy, flagged);
      coBuyFields = { coBuyMaxAcquirersInSlot: coBuy.maxAcquirersInSlot, coBuyDistinctAcquirers: coBuy.distinctAcquirers, coBuyTopShare: coBuy.topAcquirerShare, coBuyFlagged: flagged };
      appendJournal(JOURNAL_PATH, deepCheckJournal(coin, "cobuy_signal", coBuyNoteText, { equityUsd: state.equityUsd, ...coBuyFields }));
    } else {
      appendJournal(JOURNAL_PATH, journalEntry(coin.mint, "cobuy_failed", coBuyNoteText, { equityUsd: state.equityUsd }));
    }
    // v2.22 operator + sell-impact logged signal (QuantOrb-inspired):
    // LOGGED ONLY, never blocks, never changes size or score — the
    // desk over-blocks already, and this signal is uncalibrated
    // until the replay (see hidden_files/operator-sell-impact-
    // build-20261124.md). The operator components ride on the
    // Helius cluster check already paid for above (same link set,
    // no extra Helius calls); the sell impact is a MODELLED CPAMM
    // figure, a lower bound for bonding-curve tokens. A missing
    // operator payload journals operator_failed and proceeds.
    const operatorExcluded = operatorExcludedAddrs({
      curveAddrs: [coin.associated_bonding_curve, coin.bonding_curve],
      markets: report.markets ?? null,
      lockerOwners: report.lockerOwners ?? null,
    });
    const operator = analyzeOperator(cluster, {
      mcUsd: coin.usd_market_cap,
      liquidityUsd: liqRes.liquidityUsd,
      realFloatPct: realFloatPctFromTopHolders(report.topHolders ?? [], operatorExcluded),
    });
    let operatorNoteText = "operator: check failed, no signal";
    let operatorFields: { operatorCount?: number | null; operatorLargestPctFloat?: number | null; operatorTop3PctFloat?: number | null; operatorSellImpactTop3Pct?: number | null; operatorSellImpactLargestPct?: number | null } = {};
    if (operator.operatorsAvailable) {
      state.operatorSignals = (state.operatorSignals ?? 0) + 1;
      operatorNoteText = operatorNote(operator);
      operatorFields = { operatorCount: operator.operatorCount, operatorLargestPctFloat: operator.largestOperatorPctFloat, operatorTop3PctFloat: operator.top3OperatorPctFloat, operatorSellImpactTop3Pct: operator.sellImpactTop3Pct, operatorSellImpactLargestPct: operator.sellImpactLargestPct };
      appendJournal(JOURNAL_PATH, deepCheckJournal(coin, "operator_signal", operatorNoteText, { equityUsd: state.equityUsd, ...operatorFields }));
    } else {
      appendJournal(JOURNAL_PATH, journalEntry(coin.mint, "operator_failed", operatorNoteText, { equityUsd: state.equityUsd }));
    }
    // v2.12 audit fix: charge the BUY leg here (entryFeeUsd). The
    // exit legs already charge the sell leg; without this the round
    // trip was booked as one leg while the gate models two.
    const buyFeeUsd = entryFeeUsd(entrySizeUsd, solPrice);
    state.equityUsd -= buyFeeUsd;
    state.grossLossesUsd = (state.grossLossesUsd ?? 0) + buyFeeUsd;
    const pos = openPosition(coin.mint.slice(0, 8), coin.mint, coin.usd_market_cap, entrySizeUsd, now);
    // v2.25: a re-entry inside the 120-min post-exit window ends the
    // old close's tracking now — its mc movements from here belong to
    // the new trade, not the old exit.
    finalizeExitGradeNow(state, coin.mint, now, JOURNAL_PATH, "superseded by re-entry");
    // v2.25: thesis is the entry gem note, recorded while the
    // position is open; sizePct is the same number as the "size N%"
    // reason below. Both are stored on the position so the close can
    // journal them without reconstructing entry-time equity.
    const thesis = entryGemNote(gem, freshTier);
    const sizePct = Math.round((entrySizeUsd / (state.equityUsd + buyFeeUsd)) * 100);
    state.positions.push({
      id: pos.id,
      mint: coin.mint,
      name: coin.name,
      entryMcUsd: coin.usd_market_cap,
      sizeUsd: entrySizeUsd,
      openedAtMs: now,
      position: pos,
      lastMcUsd: coin.usd_market_cap,
      missedPolls: 0,
      // v2.24 holder-exit watch: snapshot the entry top holders with
      // the same exclusion set the operator check used.
      topHoldersAtEntry: topHoldersSnapshot(report, operatorExcluded),
      holderExcludedAddrs: [...operatorExcluded],
      entryThesis: thesis,
      sizePctAtEntry: sizePct,
    });
    state.trades += 1;
    state.tradesToday = (state.tradesToday ?? 0) + 1;
    const heat = entryHeatStats(dex, jupStats);
    const heatNote = heatNoteText(heat);
    const liqVol = entryLiqVol(dex);
    const liqVolNote = liqVolNoteText(liqVol);
    appendJournal(JOURNAL_PATH, deepCheckJournal(coin, "paper_entry", "cluster-checked, " + cabalNote + ", " + okxNote + ", smartMoney=" + smartMoney.wallets + "/" + fomoCount + (alertNote ? ", " + alertNote : "") + ", size " + sizePct + "%" + (elevatedRisk ? " risk-haircut" : "") + ", freshTier=" + freshTier + lpNote + ", " + measuredNote + ", " + sentimentNote + ", " + coBuyNoteText + ", " + operatorNoteText + (heatNote ? ", " + heatNote : "") + (liqVolNote ? ", " + liqVolNote : "") + ": " + thesis, { score: gem.score, sizeUsd: entrySizeUsd, price: coin.usd_market_cap, feesUsd: buyFeeUsd, equityUsd: state.equityUsd, ...entryVolStats(coin, seen, rugInput), ...entryFlowStats(dex, jupStats, now), ...heat, ...liqVol, sizePct, entryThesis: thesis, ...sellSimFields, ...coBuyFields, ...operatorFields }));
  }
  // Exit open positions
  const remaining: PaperPositionState[] = [];
  for (const p of state.positions) {
    const coin = byMint.get(p.mint);
    const jupiterPrice = jupiterMc.get(p.mint);
    const seen = coin !== undefined || jupiterPrice !== undefined;
    const price = coin ? (coin.usd_market_cap ?? p.lastMcUsd) : (jupiterPrice ?? p.lastMcUsd);
    const decision = evaluateExit(p.position, { price, atMs: now });
    if (decision.action === "hold" && seen) {
      p.position = applyExit(p.position, decision, { price, atMs: now });
      p.lastMcUsd = price;
      remaining.push(p);
      continue;
    }
    if (decision.action === "hold" && !seen) {
      // v2: only close as price-source-lost after 2 missed polls, to avoid
      // closing on a single transient fetch gap.
      if ((p.missedPolls ?? 0) < 2) {
        remaining.push(p);
        continue;
      }
      const grossSol = (p.sizeUsd / solPrice) * p.position.remainingFraction * (p.lastMcUsd / p.entryMcUsd);
      const legCost = legCostSol(grossSol, LIGHT_FEES, false) * solPrice;
      const proceeds = grossSol * solPrice - legCost;
      const pnl = proceeds - p.sizeUsd * p.position.remainingFraction;
      state.equityUsd += pnl;
      state.priceSourceLostCloses += 1;
      trackLoss(pnl, p.sizeUsd * p.position.remainingFraction);
      if (pnl > 0) { state.wins += 1; state.grossWinsUsd += pnl; } else { state.losses += 1; state.grossLossesUsd += -pnl; }
      const gLost = gradeClose(p, p.lastMcUsd, p.sizeUsd * p.position.remainingFraction);
      appendJournal(JOURNAL_PATH, journalEntry(p.mint, "close", "price source lost after 2 missed polls, close at last seen mc (estimated — no fresh price)", { price: p.lastMcUsd, feesUsd: legCost, equityUsd: state.equityUsd, ...gLost.journal }));
      recordClosedMint(state, p.mint, p.lastMcUsd, now, "price source lost", gLost.details, JOURNAL_PATH);
      continue;
    }
    const fractionSold = decision.fraction;
    const grossSol = (p.sizeUsd / solPrice) * fractionSold * (price / p.entryMcUsd);
    const legCost = legCostSol(grossSol, LIGHT_FEES, false) * solPrice;
    const proceeds = grossSol * solPrice - legCost;
    const costBasis = p.sizeUsd * fractionSold;
    const pnl = proceeds - costBasis;
    // v2.25: grade the close (provisional — post-exit window runs
    // later). A partial is not a close: it journals sizePct only,
    // no exitQuality, since the position is still open.
    const gClose = gradeClose(p, price, costBasis);
    // Only the final close settles equity in full; partials settle their share
    state.equityUsd += pnl;
    if (pnl > 0) state.grossWinsUsd += pnl; else state.grossLossesUsd += -pnl;
    if (decision.action === "close") {
      if (pnl > 0) state.wins += 1; else state.losses += 1;
      trackLoss(pnl, costBasis);
      recordClosedMint(state, p.mint, price, now, decision.reason, gClose.details, JOURNAL_PATH);
    }
    appendJournal(JOURNAL_PATH, journalEntry(p.mint, decision.action, decision.reason + (!seen ? " (estimated — no fresh price)" : ""), { sizeUsd: costBasis, price, feesUsd: legCost, equityUsd: state.equityUsd, ...(decision.action === "close" ? gClose.journal : { sizePct: gClose.journal.sizePct, sizePctFlagged: gClose.journal.sizePctFlagged }) }));
    p.position = applyExit(p.position, decision, { price, atMs: now });
    p.lastMcUsd = price;
    if (p.position.remainingFraction > 0) remaining.push(p);
  }
  state.positions = remaining;
  // v2.25: post-exit tracking — raise post-exit peaks from this
  // poll's discovery feed (plus the Jupiter fallback map) and
  // finalise grades whose 120-min window has closed.
  {
    const seenMc = new Map<string, number>();
    for (const [mint, c] of byMint) {
      const mc = c.usd_market_cap ?? c.market_cap_usd ?? 0;
      if (mc > 0) seenMc.set(mint, mc);
    }
    for (const [mint, mc] of jupiterMc) if (!seenMc.has(mint) && mc > 0) seenMc.set(mint, mc);
    updatePostExitTracking(state, seenMc, now);
  }
  // v2.4: prune seen coins, older than 24h or over 2,000 entries.
  // Open positions are never pruned.
  const openMints = new Set(state.positions.map((p) => p.mint));
  const seenEntries = Object.entries(state.seen)
    .filter(([mint, s]) => openMints.has(mint) || now - s.lastSeenMs < 24 * 60 * 60 * 1000)
    .sort((a, b) => b[1].lastSeenMs - a[1].lastSeenMs)
    .slice(0, 2000);
  state.seen = Object.fromEntries(seenEntries);
  // v2.10: prune closed-mint records older than 24h, same window as seen.
  pruneClosedMints(state, now);
  // v2.23: prune blocked-mint records older than 24h, same window.
  pruneBlockedMints(state, now);
  // Daily loss halt, latched: once halted, no new trades in this test run.
  // v2.4: settle open positions at lastMcUsd first, instead of dropping
  // them without a pnl, win/loss, or journal entry.
  if (state.equityUsd <= MICRO_PROFILE.startEquityUsd * (1 - MICRO_PROFILE.dailyLossLimitPct)) {
    if (!state.halted) {
      for (const p of state.positions) {
        const grossSol = (p.sizeUsd / solPrice) * p.position.remainingFraction * (p.lastMcUsd / p.entryMcUsd);
        const legCost = legCostSol(grossSol, LIGHT_FEES, false) * solPrice;
        const proceeds = grossSol * solPrice - legCost;
        const costBasis = p.sizeUsd * p.position.remainingFraction;
        const pnl = proceeds - costBasis;
        state.equityUsd += pnl;
        trackLoss(pnl, costBasis);
        if (pnl > 0) { state.wins += 1; state.grossWinsUsd += pnl; } else { state.losses += 1; state.grossLossesUsd += -pnl; }
        const gHalt = gradeClose(p, p.lastMcUsd, costBasis);
        appendJournal(JOURNAL_PATH, journalEntry(p.mint, "close", "halt settle at last seen mc" + ((p.missedPolls ?? 0) > 0 ? " (estimated — no fresh price)" : ""), { price: p.lastMcUsd, feesUsd: legCost, equityUsd: state.equityUsd, ...gHalt.journal }));
        recordClosedMint(state, p.mint, p.lastMcUsd, now, "halt settle", gHalt.details, JOURNAL_PATH);
      }
      appendJournal(JOURNAL_PATH, journalEntry("spotter", "halt", "daily loss limit reached, halting test", { equityUsd: state.equityUsd }));
    }
    state.halted = true;
    state.positions = [];
  }
  return state;
}
