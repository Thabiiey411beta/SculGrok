/**
 * Operator + sell-impact analysis (v2.22, QuantOrb-inspired:
 * "20 wallets can be 4 people — show who really holds a token,
 * and how far the price falls if they sell").
 *
 * The operator components ride on the Helius funder-cluster check
 * (apps/coordinator/src/cluster-check.py), which already fetches
 * each checked top holder's funding history: operators are the
 * connected components of the top holders under the SAME link set
 * the cluster verdict uses (shared first funder, creator-funded,
 * direct token transfer). No extra Helius calls, no new API key.
 *
 * This module is PURE analysis over that payload plus market data
 * the poll already fetched (mc, liquidity, Rugcheck top holders).
 * It NEVER blocks, never changes size or score: the spotter wires
 * it as a LOGGED SIGNAL ONLY (same contract as the co-buy signal),
 * because the desk already over-blocks (152 blocked / 0 entries
 * in the 2026-11-24 window) and a new gate would make that worse.
 * Promote only after the replay in
 * hidden_files/operator-sell-impact-build-20261124.md shows the
 * metrics separating rugs from wins on real journal data.
 *
 * Sell impact is a MODEL, not a measurement: constant-product
 * AMM math, impact = V / (L/2 + V), where V is the USD value
 * sold and L the pool's USD liquidity (token reserve value ~= L/2
 * in a 50/50 pool). For bonding-curve tokens the real impact of a
 * big sell is typically LARGER (the curve falls steeply as supply
 * returns), so the number is a LOWER BOUND on the damage, and it
 * is labelled as modelled everywhere it appears. A null means the
 * inputs were missing (mc, liquidity or float unknown) — never 0.
 *
 * Real float: Rugcheck top-holder pcts are % of TOTAL supply, so
 * operator shares are converted to % of the real float by
 * excluding the non-float holders the caller can identify
 * (bonding-curve addresses, pool token-vault addresses from the
 * Rugcheck markets, locker owners, the burn address). Pool /
 * locker addresses the caller cannot identify stay in the float,
 * so realFloatPct is an UPPER bound and % -of-float figures are
 * LOWER bounds on concentration. pctFloat is clamped to 100: a
 * value above 100 means the exclusion set missed a non-float
 * holder, i.e. the float is overstated, not that an operator owns
 * more than the float.
 */

/** One operator from the cluster check: connected holders that
 * are probably one owner. pctSupply is % of TOTAL supply. */
export interface OperatorGroup {
  members: string[];
  pctSupply: number;
  count: number;
}

/** The cluster-check payload this analysis consumes. */
export interface OperatorClusterInput {
  /** Null when the script did not report operators (older script
   * or malformed payload) — the analysis is then unavailable. */
  operators: OperatorGroup[] | null;
  checked: number;
  unknown: number;
  /** % of TOTAL supply held by the union of linked holders. */
  linkedPct: number | null;
}

export interface OperatorFeatures {
  /** False when no operator payload was available. */
  operatorsAvailable: boolean;
  /** Number of distinct operators among the checked holders. */
  operatorCount: number | null;
  /** Largest single operator, % of TOTAL supply. */
  largestOperatorPctSupply: number | null;
  /** Largest single operator, % of the real float (clamped 0-100). */
  largestOperatorPctFloat: number | null;
  /** Largest single operator's holding, USD at current mc. */
  largestOperatorUsd: number | null;
  /** Top 3 operators combined, % of the real float (clamped 0-100). */
  top3OperatorPctFloat: number | null;
  /** All linked holders combined, % of the real float (clamped). */
  linkedPctFloat: number | null;
  /** Modelled price fall if the largest operator sold everything. */
  sellImpactLargestPct: number | null;
  /** Modelled price fall if the top 3 operators sold everything. */
  sellImpactTop3Pct: number | null;
  /** Modelled price fall if ALL linked holders sold everything. */
  sellImpactAllLinkedPct: number | null;
  /** % of total supply that is real float (null = unknown). */
  realFloatPct: number | null;
  liquidityUsd: number | null;
  mcUsd: number | null;
  /** The sell-impact model, so no reader mistakes it for measured. */
  model: "cpamm-lower-bound";
}

/** Solana burn address — never a real holder, excluded from float. */
export const BURN_ADDRESS = "1nc1nerator11111111111111111111111111111111";

/**
 * Non-float addresses for one token, as a set: bonding-curve
 * addresses, pool token-vault (liquidityA) addresses from the
 * Rugcheck markets, locker owners, and the burn address. Rugcheck
 * returns lockerOwners as a RECORD (locker -> owner), not a list —
 * both shapes are accepted, and a missing field contributes
 * nothing. The live spotter and the replay both use this helper so
 * the float definition cannot drift between them.
 */
export function operatorExcludedAddrs(input: {
  curveAddrs: Array<string | undefined | null>;
  markets?: Array<{ liquidityA?: string | null }> | null;
  lockerOwners?: Record<string, unknown> | Array<string> | null;
}): Set<string> {
  const out = new Set<string>([BURN_ADDRESS]);
  for (const a of input.curveAddrs) if (typeof a === "string" && a) out.add(a);
  for (const m of input.markets ?? []) if (typeof m?.liquidityA === "string" && m.liquidityA) out.add(m.liquidityA);
  const lockers = input.lockerOwners;
  const lockerAddrs = Array.isArray(lockers) ? lockers : lockers && typeof lockers === "object" ? Object.keys(lockers) : [];
  for (const o of lockerAddrs) if (typeof o === "string" && o) out.add(o);
  return out;
}

/**
 * Constant-product sell impact, in percent: selling $sellUsd of a
 * token into a pool with $liquidityUsd of liquidity moves the
 * price by sellUsd / (liquidityUsd/2 + sellUsd). Null unless both
 * inputs are finite and positive; a 0 sale is 0% impact.
 * Pure, unit-tested. See the module doc for the model limits.
 */
export function cpammSellImpactPct(sellUsd: number, liquidityUsd: number): number | null {
  if (!Number.isFinite(sellUsd) || !Number.isFinite(liquidityUsd)) return null;
  if (sellUsd < 0 || liquidityUsd <= 0) return null;
  if (sellUsd === 0) return 0;
  return (sellUsd / (liquidityUsd / 2 + sellUsd)) * 100;
}

const clampPct = (v: number): number => Math.min(100, Math.max(0, v));

/**
 * Real float as % of total supply: 100 minus the % held by the
 * non-float addresses the caller identified (curve, pool vaults,
 * lockers, burn). Null when the holder list is empty (nothing to
 * measure) or the excluded share is >= 100% (degenerate data —
 * unknown, never 0, so % -of-float never divides by a bad float).
 */
export function realFloatPctFromTopHolders(
  topHolders: Array<{ address: string; pct: number; owner?: string }>,
  excludedAddrs: Set<string>,
): number | null {
  if (topHolders.length === 0) return null;
  let excluded = 0;
  for (const h of topHolders) {
    const pct = typeof h.pct === "number" && Number.isFinite(h.pct) ? h.pct : 0;
    if (excludedAddrs.has(h.address) || (h.owner !== undefined && excludedAddrs.has(h.owner))) excluded += pct;
  }
  const floatPct = 100 - excluded;
  if (!(floatPct > 0)) return null;
  return floatPct;
}

/** Pure operator analysis from a cluster-check payload. */
export function analyzeOperator(
  input: OperatorClusterInput,
  opts: { mcUsd: number | null; liquidityUsd: number | null; realFloatPct: number | null },
): OperatorFeatures {
  const base: OperatorFeatures = {
    operatorsAvailable: false,
    operatorCount: null,
    largestOperatorPctSupply: null,
    largestOperatorPctFloat: null,
    largestOperatorUsd: null,
    top3OperatorPctFloat: null,
    linkedPctFloat: null,
    sellImpactLargestPct: null,
    sellImpactTop3Pct: null,
    sellImpactAllLinkedPct: null,
    realFloatPct: opts.realFloatPct,
    liquidityUsd: opts.liquidityUsd,
    mcUsd: opts.mcUsd,
    model: "cpamm-lower-bound",
  };
  if (!input.operators) return base;
  const sorted = [...input.operators].sort((a, b) => b.pctSupply - a.pctSupply);
  const largest = sorted[0] ?? null;
  const top3Supply = sorted.slice(0, 3).reduce((s, g) => s + g.pctSupply, 0);
  const mc = typeof opts.mcUsd === "number" && Number.isFinite(opts.mcUsd) && opts.mcUsd > 0 ? opts.mcUsd : null;
  const floatPct = typeof opts.realFloatPct === "number" && Number.isFinite(opts.realFloatPct) && opts.realFloatPct > 0 ? opts.realFloatPct : null;
  const usdOf = (pctSupply: number): number | null => (mc === null ? null : (pctSupply / 100) * mc);
  const pctFloatOf = (pctSupply: number): number | null => (floatPct === null ? null : clampPct((pctSupply / floatPct) * 100));
  return {
    ...base,
    operatorsAvailable: true,
    operatorCount: sorted.length,
    largestOperatorPctSupply: largest === null ? null : largest.pctSupply,
    largestOperatorPctFloat: largest === null ? null : pctFloatOf(largest.pctSupply),
    largestOperatorUsd: largest === null ? null : usdOf(largest.pctSupply),
    top3OperatorPctFloat: pctFloatOf(top3Supply),
    linkedPctFloat: input.linkedPct === null ? null : pctFloatOf(input.linkedPct),
    sellImpactLargestPct: largest === null ? null : cpammSellImpactPct(usdOf(largest.pctSupply) ?? NaN, opts.liquidityUsd ?? NaN),
    sellImpactTop3Pct: cpammSellImpactPct(usdOf(top3Supply) ?? NaN, opts.liquidityUsd ?? NaN),
    sellImpactAllLinkedPct: input.linkedPct === null ? null : cpammSellImpactPct(usdOf(input.linkedPct) ?? NaN, opts.liquidityUsd ?? NaN),
  };
}

/** Human-readable one-liner for the journal. */
export function operatorNote(f: OperatorFeatures): string {
  if (!f.operatorsAvailable) return "operator: no operator data, unknown";
  const fmt = (v: number | null): string => (v === null ? "?" : v.toFixed(1) + "%");
  const usd = f.largestOperatorUsd === null ? "?" : "$" + Math.round(f.largestOperatorUsd).toLocaleString("en-US");
  return (
    `operator: count=${f.operatorCount} largest=${fmt(f.largestOperatorPctFloat)} of float (${usd}) ` +
    `top3=${fmt(f.top3OperatorPctFloat)} linked=${fmt(f.linkedPctFloat)} ` +
    `sellImpact largest=${fmt(f.sellImpactLargestPct)} top3=${fmt(f.sellImpactTop3Pct)} (modelled CPAMM lower bound)`
  );
}
