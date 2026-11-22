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
  return { id, mint, entryPrice, sizeUsd, remainingFraction: 1, peakPrice: entryPrice, lastHighAtMs: atMs, openedAtMs: atMs, tp1Done: false };
}

export function evaluateExit(pos: Position, tick: Tick, profile: MicroProfile = MICRO_PROFILE): ExitDecision {
  const multiple = tick.price / pos.entryPrice;
  const peak = Math.max(pos.peakPrice, tick.price);
  const ageMin = (tick.atMs - pos.openedAtMs) / 60000;
  if (multiple <= 1 - profile.hardStopPct) {
    return { action: "close", fraction: pos.remainingFraction, reason: "hard stop -30% from entry", urgency: "high" };
  }
  if (ageMin >= profile.timeExitMinutes) {
    return { action: "close", fraction: pos.remainingFraction, reason: "time exit 120 minutes", urgency: "normal" };
  }
  if (!pos.tp1Done && multiple >= profile.tp1Multiple) {
    return { action: "partial", fraction: pos.remainingFraction * profile.tp1Fraction, reason: "take profit 1 at +50%, sell 50%", urgency: "normal" };
  }
  if (pos.tp1Done && multiple >= profile.tp2Multiple) {
    return { action: "close", fraction: pos.remainingFraction, reason: "take profit 2 at +100%, sell rest", urgency: "normal" };
  }
  if (pos.tp1Done && tick.price <= peak * (1 - profile.trailingStopPct)) {
    return { action: "close", fraction: pos.remainingFraction, reason: "trailing stop 18% under peak", urgency: "high" };
  }
  if (!pos.tp1Done && ageMin >= profile.stallMinutes && multiple < 1.2 && tick.atMs - pos.lastHighAtMs >= profile.stallMinutes * 60000) {
    return { action: "close", fraction: pos.remainingFraction, reason: "stall exit, no new high for 20 minutes below +20%", urgency: "normal" };
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
