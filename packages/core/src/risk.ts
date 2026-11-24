import { MICRO_PROFILE, type MicroProfile } from "./micro.js";

export type KillState = "ok" | "paused" | "killed" | "halted";

export interface RiskState {
  startEquityUsd: number;
  equityUsd: number;
  openPositions: number;
  tradesToday: number;
  kill: KillState;
  haltReason: string | null;
}

export function newRiskState(startEquityUsd: number): RiskState {
  return {
    startEquityUsd,
    equityUsd: startEquityUsd,
    openPositions: 0,
    tradesToday: 0,
    kill: "ok",
    haltReason: null,
  };
}

export interface RiskVerdict {
  verdict: "allow" | "deny" | "halt";
  reason: string;
  maxSizeUsd: number;
}

export function checkRisk(
  state: RiskState,
  sizeUsd: number,
  profile: MicroProfile = MICRO_PROFILE,
): RiskVerdict {
  const maxSize = state.equityUsd * profile.maxPositionPct;
  // Fail-closed first: a non-positive or NaN size is never allowed
  // (NaN > maxSize is false, so without this the check below would
  // pass it through).
  if (!(sizeUsd > 0)) {
    return { verdict: "deny", reason: "position size must be a positive number", maxSizeUsd: maxSize };
  }
  if (state.kill === "halted") {
    return { verdict: "halt", reason: "desk halted: " + (state.haltReason ?? "daily loss limit"), maxSizeUsd: 0 };
  }
  if (state.kill === "killed") {
    return { verdict: "deny", reason: "kill switch active, new buys disarmed", maxSizeUsd: 0 };
  }
  if (state.kill === "paused") {
    return { verdict: "deny", reason: "discovery paused, no new entries", maxSizeUsd: 0 };
  }
  const dailyLoss = state.startEquityUsd - state.equityUsd;
  if (dailyLoss >= state.startEquityUsd * profile.dailyLossLimitPct) {
    return { verdict: "halt", reason: "daily loss limit reached", maxSizeUsd: 0 };
  }
  if (state.openPositions >= profile.maxOpenPositions) {
    return { verdict: "deny", reason: "max open positions reached", maxSizeUsd: maxSize };
  }
  if (state.tradesToday >= profile.maxTradesPerDay) {
    return { verdict: "deny", reason: "max trades per day reached", maxSizeUsd: maxSize };
  }
  if (sizeUsd > maxSize) {
    return { verdict: "deny", reason: "position size exceeds max position pct", maxSizeUsd: maxSize };
  }
  return { verdict: "allow", reason: "risk checks pass", maxSizeUsd: maxSize };
}

export function applyLoss(state: RiskState, lossUsd: number, profile: MicroProfile = MICRO_PROFILE): RiskState {
  // A negative or NaN "loss" is a gain (or garbage) — applyLoss only
  // ever subtracts. Return the state unchanged rather than crediting
  // equity through the loss path.
  if (!(lossUsd > 0)) return state;
  const next: RiskState = { ...state, equityUsd: state.equityUsd - lossUsd };
  if (next.startEquityUsd - next.equityUsd >= next.startEquityUsd * profile.dailyLossLimitPct) {
    next.kill = "halted";
    next.haltReason = "daily loss limit reached";
  }
  return next;
}

export function haltDesk(state: RiskState, reason: string): RiskState {
  return { ...state, kill: "halted", haltReason: reason };
}
