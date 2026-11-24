/**
 * Jupiter sell simulation as a pre-entry honeypot gate (v2.15,
 * million-inspired: "token gauntlet incl. Jupiter sell simulation").
 *
 * Before entering a would-be position, quote SELLING the position
 * itself (inputMint = token, outputMint = SOL, amount = the position
 * size in base units) on Jupiter's keyless quote API. No signing, no
 * transaction, no key — a read-only quote. A token that cannot be
 * sold (honeypot, frozen, dead pool) returns no route / zero output
 * / extreme price impact, and must never enter.
 *
 * This module is the PURE decision logic (parse + predicate) so it
 * is unit-testable without network. The fetch lives in spotter.ts
 * next to fetchJupiterSellQuoteOk, which already uses the same
 * endpoint for the v2.7 markets-empty fallback (1,000 tokens).
 *
 * Failure behaviour (SOUL audit fix, 2026-11-23 — fail-closed):
 * - Quote succeeds, outAmount > 0 and >= 50% of the naive expected
 *   output and price impact <= 10% -> PASS (5-10% passes with a
 *   caution noted in the reason).
 * - Quote succeeds but outAmount is zero, or < 50% of expected, or
 *   price impact > 10% -> FAIL (genuinely unsellable / extreme
 *   impact). The outAmount-vs-expected check is the robust one: it
 *   is the realised output, so it holds even when Jupiter omits
 *   price impact.
 * - Quote fails (HTTP error / timeout / unparseable) after bounded
 *   retry -> UNKNOWN, which BLOCKS the entry. A dead quote endpoint
 *   must not let an untested token in — the old fail-open TRANSIENT
 *   is gone.
 * - No route / unparseable quote -> FAIL (no route is evidence the
 *   token is unsellable at the intended size, not a transient).
 * - Supply or decimals missing (cannot size the quote) -> FAIL:
 *   missing data = block (standing rule). Decimals are NEVER
 *   defaulted (the old "default 6" guessed the token's decimals).
 *
 * Price-impact units (research §2 — branch per version, never share
 * one parser):
 * - Swap V2 /order `priceImpact` (number) is PERCENTAGE POINTS
 *   (e.g. -0.1 = -0.1%); V2 `priceImpactPct` (string) is the
 *   deprecated decimal ratio.
 * - Swap V1 /quote `priceImpactPct` is a DECIMAL RATIO
 *   (e.g. "0.0001" = 0.01%).
 * Internally this module normalises impact to a decimal ratio
 * (0.02 = 2%). Thresholds are practitioner conventions, NOT Jupiter
 * guidance: BLOCK > 10%, caution 5-10%, warn > 1%.
 */
export interface SellSimQuote {
  /** lamports of SOL the quote would return. */
  outAmountLamports: number;
  /** Jupiter price impact as a decimal fraction (0.02 = 2%), or
   * null when the response does not carry it. */
  priceImpactPct: number | null;
}

/** Block when the realised output is under half the naive expected
 * output, or the quoted price impact is > 10%. */
export const MIN_SELL_OUTPUT_RATIO = 0.5;
export const MAX_SELL_IMPACT_PCT = 0.1;
/** 5-10% impact passes with a caution noted in the reason. */
export const CAUTION_SELL_IMPACT_PCT = 0.05;

/** Pure parse of a Jupiter swap quote response. Null when the
 * response has no usable outAmount, an empty route plan, or a
 * non-null `transaction` (a swap payload, not a quote-only
 * response). `version` selects the price-impact field: "v2" reads
 * `priceImpact` (percentage points) first, falling back to the
 * deprecated `priceImpactPct` (decimal ratio); "v1" reads
 * `priceImpactPct` (decimal ratio). */
export function parseSellQuote(data: unknown, version: "v1" | "v2" = "v2"): SellSimQuote | null {
  if (typeof data !== "object" || data === null) return null;
  const d = data as Record<string, unknown>;
  if (d.transaction !== null && d.transaction !== undefined) return null;
  if (Array.isArray(d.routePlan) && d.routePlan.length === 0) return null;
  const rawOut = d.outAmount;
  const out =
    typeof rawOut === "string" && /^\d+$/.test(rawOut)
      ? Number(rawOut)
      : typeof rawOut === "number"
        ? rawOut
        : Number.NaN;
  if (!Number.isFinite(out) || out < 0) return null;
  let impact: number | null = null;
  if (version === "v2") {
    const v2 = Number(d.priceImpact);
    if (Number.isFinite(v2)) impact = v2 / 100; // percentage points -> ratio
    else {
      const legacy = Number(d.priceImpactPct);
      if (Number.isFinite(legacy)) impact = legacy; // deprecated decimal ratio
    }
  } else {
    const v1 = Number(d.priceImpactPct);
    if (Number.isFinite(v1)) impact = v1; // decimal ratio
  }
  return {
    outAmountLamports: Math.floor(out),
    priceImpactPct: impact,
  };
}

/** Token amount in base units for a position of `sizeUsd` at
 * `entryMcUsd`, given total `supply` and `decimals`. Null when the
 * supply or decimals are missing/invalid or the computed amount is
 * not positive — the caller treats that as missing data
 * (fail-closed). Decimals are never defaulted: a missing decimal
 * count means the quote cannot be sized. */
export function tokenBaseUnits(
  sizeUsd: number,
  entryMcUsd: number,
  supply: number | null | undefined,
  decimals: number | null | undefined,
): number | null {
  if (typeof supply !== "number" || !Number.isFinite(supply) || supply <= 0) return null;
  if (!(sizeUsd > 0) || !(entryMcUsd > 0)) return null;
  if (typeof decimals !== "number" || !Number.isFinite(decimals) || decimals < 0 || decimals > 9) return null;
  const dec = Math.floor(decimals);
  const tokens = (sizeUsd * supply) / entryMcUsd;
  const baseUnits = Math.floor(tokens * 10 ** dec);
  return baseUnits > 0 ? baseUnits : null;
}

/** Expected SOL output in lamports for selling `sizeUsd` at the
 * entry price, ignoring fees/slippage: the naive baseline the quote
 * is compared against. Null when the size or price is not a positive
 * number — the caller blocks, it does not compare against 0. */
export function expectedOutLamports(sizeUsd: number, solPriceUsd: number): number | null {
  if (!(sizeUsd > 0) || !(solPriceUsd > 0)) return null;
  return Math.floor((sizeUsd / solPriceUsd) * 1e9);
}

export type SellSimVerdict =
  | { verdict: "pass"; reason: string }
  | { verdict: "fail"; reason: string }
  | { verdict: "unknown"; reason: string };

/** Decide on a quote. `expectedLamports` is the naive output at
 * entry price (see expectedOutLamports). A null quote means Jupiter
 * returned no route / an unparseable response — FAIL, not unknown:
 * no route is evidence the token is unsellable at the intended
 * size. A null expected output means the baseline could not be
 * computed — FAIL (missing data = block). */
export function decideSellSim(quote: SellSimQuote | null, expectedLamports: number | null): SellSimVerdict {
  if (quote === null) {
    return { verdict: "fail", reason: "sell sim: no route / unparseable quote (unsellable at intended size)" };
  }
  if (expectedLamports === null) {
    return { verdict: "fail", reason: "sell sim: cannot compute expected output (invalid size/price)" };
  }
  if (quote.outAmountLamports <= 0) {
    return { verdict: "fail", reason: "sell sim: quote outAmount 0 (unsellable)" };
  }
  if (quote.outAmountLamports < MIN_SELL_OUTPUT_RATIO * expectedLamports) {
    const ratio = quote.outAmountLamports / expectedLamports;
    return {
      verdict: "fail",
      reason: `sell sim: outAmount ${quote.outAmountLamports} lamports is ${(ratio * 100).toFixed(1)}% of expected ${expectedLamports} (< 50%)`,
    };
  }
  if (quote.priceImpactPct !== null && quote.priceImpactPct > MAX_SELL_IMPACT_PCT) {
    return {
      verdict: "fail",
      reason: `sell sim: price impact ${(quote.priceImpactPct * 100).toFixed(1)}% > 10%`,
    };
  }
  const caution =
    quote.priceImpactPct !== null && quote.priceImpactPct >= CAUTION_SELL_IMPACT_PCT
      ? `, caution: impact ${(quote.priceImpactPct * 100).toFixed(2)}% in 5-10% band`
      : "";
  return {
    verdict: "pass",
    reason:
      `sell sim ok: out ${quote.outAmountLamports} lamports` +
      (quote.priceImpactPct !== null ? `, impact ${(quote.priceImpactPct * 100).toFixed(2)}%` : ", impact n/a") +
      caution,
  };
}
