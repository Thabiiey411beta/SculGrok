import type { RugCheckResult } from "./types.js";

export interface RugInput {
  mint: string;
  mintAuthorityLive?: boolean | null;
  freezeAuthorityLive?: boolean | null;
  top10Pct?: number | null;
  singleWalletPct?: number | null;
  bundlePct?: number | null;
  devSoldPct?: number | null;
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

/** Fail-closed rug check. Any missing or timed-out hard input blocks. */
export function evaluateRug(input: RugInput): RugCheckResult {
  const failed: string[] = [];
  const warned: string[] = [];
  if (input.timedOut) failed.push("timeout");
  if (input.dataMissing) failed.push("missing_data");
  if (isMissing(input.mintAuthorityLive)) failed.push("mint_authority_unknown");
  else if (input.mintAuthorityLive) failed.push("mint_authority_live");
  if (isMissing(input.freezeAuthorityLive)) failed.push("freeze_authority_unknown");
  else if (input.freezeAuthorityLive) failed.push("freeze_authority_live");
  if (isMissing(input.top10Pct)) failed.push("top10_unknown");
  else if ((input.top10Pct as number) > 0.3) failed.push("top10_concentration");
  else if ((input.top10Pct as number) >= 0.2) warned.push("top10_elevated");
  if (!isMissing(input.singleWalletPct) && (input.singleWalletPct as number) >= 0.1) failed.push("single_wallet_concentration");
  if (isMissing(input.bundlePct)) failed.push("bundle_unknown");
  else if ((input.bundlePct as number) > 0.2) failed.push("bundle_concentration");
  if (!isMissing(input.devSoldPct) && (input.devSoldPct as number) > 0.2) failed.push("dev_sold_too_much");
  if (!isMissing(input.washPct) && (input.washPct as number) > 0.5) failed.push("wash_volume");
  if (isMissing(input.lpLockedOrBurned)) failed.push("lp_state_unknown");
  else if (!input.lpLockedOrBurned) failed.push("lp_not_locked_or_burned");
  if (isMissing(input.liquidityUsd)) failed.push("liquidity_unknown");
  else if ((input.liquidityUsd as number) < 5000) warned.push("liquidity_thin");
  if (isMissing(input.sellSimulationOk)) failed.push("sell_simulation_unknown");
  else if (!input.sellSimulationOk) failed.push("sell_simulation_failed");
  if (input.token2022TransferFee) failed.push("token2022_transfer_fee");
  if (input.token2022TransferHook) failed.push("token2022_transfer_hook");
  if (input.token2022PermanentDelegate) failed.push("token2022_permanent_delegate");
  if (input.token2022Pause) failed.push("token2022_pause");
  if (input.mutableMetadata) warned.push("mutable_metadata");

  const verdict = failed.length > 0 ? "block" : warned.length > 0 ? "watch" : "pass";
  const rug_score = failed.length > 0 ? 0 : Math.max(0, 100 - warned.length * 15);
  return {
    mint: input.mint,
    verdict,
    rug_score,
    failed,
    warned,
    details: { ...input },
    checked_at: Date.now(),
  };
}
