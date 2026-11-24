import type { RugCheckResult } from "./types.js";

export interface RugInput {
  mint: string;
  mintAuthorityLive?: boolean | null;
  freezeAuthorityLive?: boolean | null;
  top10Pct?: number | null;
  singleWalletPct?: number | null;
  bundlePct?: number | null;
  devSoldPct?: number | null;
  /** Wash share (Jupiter stats1h non-organic share). LOGGED ONLY
   * since v2.20 — it never gates an entry and is never deferred.
   * Measurement (n=30 live fresh tokens, 2026-11-23): 27/30 have
   * no organic fields at all (wash unknown) and the 3 measurable
   * ones are 0.98-1.00, so wash has zero discriminating power on
   * fresh tokens: a hard gate on it blocks 100% of candidates
   * including good ones, which is friction without signal, not
   * fail-closed protection. The value still flows through here so
   * it lands in `details` and the journal with its source.
   * RE-PROMOTE only when a wash source is found that varies across
   * candidates (organic fields populated, or a different source) —
   * restore the >0.5 block and the deferred-field entry together. */
  washPct?: number | null;
  lpLockedOrBurned?: boolean | null;
  liquidityUsd?: number | null;
  sellSimulationOk?: boolean | null;
  token2022TransferFee?: boolean | null;
  token2022TransferHook?: boolean | null;
  token2022PermanentDelegate?: boolean | null;
  token2022Pause?: boolean | null;
  mutableMetadata?: boolean | null;
  dataMissing?: boolean;
  timedOut?: boolean;
}

function isMissing(v: unknown): boolean {
  return v === undefined || v === null;
}

/** Rug-input fields whose measurement is expensive (extra API
 * calls) and therefore happens in a later stage of the deep check:
 * bundlePct (Helius funder-cluster), devSoldPct (Helius creator
 * txs), and the four Token-2022 extension flags (Helius
 * getAccountInfo). The spotter evaluates the rug check in two
 * stages: stage A defers these fields (they land in `deferred`,
 * not `failed`), stage B measures them for candidates that pass
 * everything else and re-evaluates with no deferral. Only these
 * six fields may be deferred — every other missing hard input
 * still blocks at stage A. washPct was the seventh deferred field
 * until v2.20, when it was demoted to logged-only (see the field
 * comment above): it is still measured at stage B and journaled,
 * but it never gates, so there is nothing to defer. */
export const RUG_DEFERRED_FIELDS = [
  "bundlePct",
  "devSoldPct",
  "token2022TransferFee",
  "token2022TransferHook",
  "token2022PermanentDelegate",
  "token2022Pause",
] as const;
export type RugDeferredField = (typeof RUG_DEFERRED_FIELDS)[number];

/** Fail-closed rug check. Any missing or timed-out hard input blocks.
 * With `opts.deferFields`, a missing DEFERRED field is recorded in
 * `deferred` instead of `failed` — the result is provisional and
 * the caller must re-evaluate once the field is measured. A
 * deferred field that IS present is still evaluated normally (a
 * measured bundlePct of 0.3 blocks on bundle_concentration even
 * when deferred). Without opts, behaviour is unchanged. */
export function evaluateRug(input: RugInput, opts?: { deferFields?: readonly RugDeferredField[] }): RugCheckResult {
  const failed: string[] = [];
  const warned: string[] = [];
  const deferred: string[] = [];
  const defer = new Set<string>(opts?.deferFields ?? []);
  // A missing field that the caller explicitly deferred is pending
  // measurement, not a failure — yet. It is recorded so the caller
  // (and the journal) can see exactly what is still unmeasured.
  const missingOr = (field: RugDeferredField, reason: string, v: unknown): boolean => {
    if (!isMissing(v)) return false;
    if (defer.has(field)) deferred.push(reason);
    else failed.push(reason);
    return true;
  };
  if (input.timedOut) failed.push("timeout");
  if (input.dataMissing) failed.push("missing_data");
  if (isMissing(input.mintAuthorityLive)) failed.push("mint_authority_unknown");
  else if (input.mintAuthorityLive) failed.push("mint_authority_live");
  if (isMissing(input.freezeAuthorityLive)) failed.push("freeze_authority_unknown");
  else if (input.freezeAuthorityLive) failed.push("freeze_authority_live");
  if (isMissing(input.top10Pct)) failed.push("top10_unknown");
  else if ((input.top10Pct as number) > 0.3) failed.push("top10_concentration");
  else if ((input.top10Pct as number) >= 0.2) warned.push("top10_elevated");
  if (isMissing(input.singleWalletPct)) failed.push("single_wallet_unknown");
  else if ((input.singleWalletPct as number) >= 0.1) failed.push("single_wallet_concentration");
  if (!missingOr("bundlePct", "bundle_unknown", input.bundlePct) && (input.bundlePct as number) > 0.2) failed.push("bundle_concentration");
  if (!missingOr("devSoldPct", "dev_sold_unknown", input.devSoldPct) && (input.devSoldPct as number) > 0.2) failed.push("dev_sold_too_much");
  // washPct is NOT evaluated here (v2.20, logged-only): a measured
  // value, an unknown value, and a 0.98 value all pass this check.
  // The old >0.5 "wash_volume" block fired on every measurable
  // fresh token (n=30: 27 unknown, 3 at 0.98-1.00) and blocked
  // 100% of candidates without discriminating anything. See the
  // washPct field comment for the re-promotion condition.
  if (isMissing(input.lpLockedOrBurned)) failed.push("lp_state_unknown");
  else if (!input.lpLockedOrBurned) failed.push("lp_not_locked_or_burned");
  if (isMissing(input.liquidityUsd)) failed.push("liquidity_unknown");
  else if ((input.liquidityUsd as number) < 5000) warned.push("liquidity_thin");
  if (isMissing(input.sellSimulationOk)) failed.push("sell_simulation_unknown");
  else if (!input.sellSimulationOk) failed.push("sell_simulation_failed");
  if (!missingOr("token2022TransferFee", "token2022_transfer_fee_unknown", input.token2022TransferFee) && input.token2022TransferFee) failed.push("token2022_transfer_fee");
  if (!missingOr("token2022TransferHook", "token2022_transfer_hook_unknown", input.token2022TransferHook) && input.token2022TransferHook) failed.push("token2022_transfer_hook");
  if (!missingOr("token2022PermanentDelegate", "token2022_permanent_delegate_unknown", input.token2022PermanentDelegate) && input.token2022PermanentDelegate) failed.push("token2022_permanent_delegate");
  if (!missingOr("token2022Pause", "token2022_pause_unknown", input.token2022Pause) && input.token2022Pause) failed.push("token2022_pause");
  if (input.mutableMetadata) warned.push("mutable_metadata");

  const verdict = failed.length > 0 ? "block" : warned.length > 0 ? "watch" : "pass";
  const rug_score = failed.length > 0 ? 0 : Math.max(0, 100 - warned.length * 15);
  return {
    mint: input.mint,
    verdict,
    rug_score,
    failed,
    warned,
    deferred,
    details: { ...input },
    checked_at: Date.now(),
  };
}
