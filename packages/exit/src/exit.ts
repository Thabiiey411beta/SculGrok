import { MICRO_PROFILE, type MicroProfile } from "../../core/src/micro.js";

export interface Position {
  id: string;
  mint: string;
  entryPrice: number;
  sizeUsd: number;
  remainingFraction: number;
  peakPrice: number;
  lastHighAtMs: number;
  openedAtMs: number;
  tp1Done: boolean;
}

export interface Tick {
  price: number;
  atMs: number;
}

export interface ExitDecision {
  action: "hold" | "partial" | "close";
  fraction: number;
  reason: string;
  urgency: "normal" | "high";
}

export function openPosition(id: string, mint: string, entryPrice: number, sizeUsd: number, atMs: number): Position {
  // Fail-closed at the boundary: a non-positive or non-finite entry
  // price or size would make every later multiple Infinity/NaN.
  if (!(entryPrice > 0) || !(sizeUsd > 0)) {
    throw new Error(`openPosition: entryPrice and sizeUsd must be > 0 (got ${entryPrice}, ${sizeUsd})`);
  }
  return { id, mint, entryPrice, sizeUsd, remainingFraction: 1, peakPrice: entryPrice, lastHighAtMs: atMs, openedAtMs: atMs, tp1Done: false };
}

/** Stall trigger: exit when the price has not made a new high for
 * stallMinutes while sitting below this multiple of entry. */
export const STALL_BELOW_MULTIPLE = 1.2;

export function evaluateExit(pos: Position, tick: Tick, profile: MicroProfile = MICRO_PROFILE): ExitDecision {
  const multiple = tick.price / pos.entryPrice;
  const peak = Math.max(pos.peakPrice, tick.price);
  const ageMin = (tick.atMs - pos.openedAtMs) / 60000;
  // Reason strings are computed from the profile so a profile change
  // cannot silently desync the journal from the thresholds. For the
  // default profile they read exactly as before ("-30%", "120
  // minutes", "+50%", "+100%", "18%", "+20%").
  if (multiple <= 1 - profile.hardStopPct) {
    return { action: "close", fraction: pos.remainingFraction, reason: `hard stop -${Math.round(profile.hardStopPct * 100)}% from entry`, urgency: "high" };
  }
  if (ageMin >= profile.timeExitMinutes) {
    return { action: "close", fraction: pos.remainingFraction, reason: `time exit ${profile.timeExitMinutes} minutes`, urgency: "normal" };
  }
  if (!pos.tp1Done && multiple >= profile.tp1Multiple) {
    return { action: "partial", fraction: pos.remainingFraction * profile.tp1Fraction, reason: `take profit 1 at +${Math.round((profile.tp1Multiple - 1) * 100)}%, sell ${Math.round(profile.tp1Fraction * 100)}%`, urgency: "normal" };
  }
  if (pos.tp1Done && multiple >= profile.tp2Multiple) {
    return { action: "close", fraction: pos.remainingFraction, reason: `take profit 2 at +${Math.round((profile.tp2Multiple - 1) * 100)}%, sell rest`, urgency: "normal" };
  }
  if (pos.tp1Done && tick.price <= peak * (1 - profile.trailingStopPct)) {
    return { action: "close", fraction: pos.remainingFraction, reason: `trailing stop ${Math.round(profile.trailingStopPct * 100)}% under peak`, urgency: "high" };
  }
  if (!pos.tp1Done && ageMin >= profile.stallMinutes && multiple < STALL_BELOW_MULTIPLE && tick.atMs - pos.lastHighAtMs >= profile.stallMinutes * 60000) {
    return { action: "close", fraction: pos.remainingFraction, reason: `stall exit, no new high for ${profile.stallMinutes} minutes below +${Math.round((STALL_BELOW_MULTIPLE - 1) * 100)}%`, urgency: "normal" };
  }
  return { action: "hold", fraction: 0, reason: "holding, no exit trigger", urgency: "normal" };
}

export function applyExit(pos: Position, decision: ExitDecision, tick: Tick): Position {
  const next: Position = { ...pos, peakPrice: Math.max(pos.peakPrice, tick.price) };
  if (tick.price > pos.peakPrice) next.lastHighAtMs = tick.atMs;
  if (decision.action === "partial") {
    next.remainingFraction = Math.max(0, pos.remainingFraction - decision.fraction);
    next.tp1Done = true;
  }
  if (decision.action === "close") {
    next.remainingFraction = 0;
  }
  return next;
}
