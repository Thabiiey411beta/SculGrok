/**
 * WebSocket discovery queue — v2.16, 2026-11-23.
 *
 * A long-running relay (apps/coordinator/src/ws-relay.ts) subscribes to
 * PumpPortal's public keyless feed (wss://pumpportal.fun/api/data,
 * {"method":"subscribeNewToken"}) and appends every new Pump.fun launch
 * to SPOTTER_DIR/ws-new-coins.jsonl. The spotter poll merges the fresh
 * slice of that queue into its discovery list, so a launch is seen
 * within seconds instead of at the next 5-minute poll.
 *
 * Feed verified 2026-11-23 from PumpPortal docs + the streaming
 * reference (github.com/vo1ganin/crypto-claude-skills, skills/pumpfun/
 * references/streaming.md) AND a live 60s probe: endpoint
 * wss://pumpportal.fun/api/data, no authentication, new-token stream
 * free. Create events arrive as JSON with txType "create" (or
 * "create_v2"), mint, traderPublicKey (creator), name, symbol, uri,
 * marketCapSol, bondingCurveKey, initialBuy, solAmount,
 * vTokensInBondingCurve, vSolInBondingCurve. There is NO timestamp
 * field in the live event — createdAtMs is therefore receipt time
 * (first-seen), NOT on-chain launch time; the parser still accepts a
 * numeric timestamp if one ever appears. Trade subscriptions are
 * metered/keyed — this relay never subscribes to them. ONE connection
 * only: multiple connections trigger an hourly ban, so the relay holds
 * a single socket and resubscribes on reconnect.
 *
 * Design limits, all deliberate:
 * - The spotter merges only queue entries younger than 15 minutes
 *   (WS_MERGE_MAX_AGE_MS). The candidate filter already requires
 *   tradeAgeMin < 15, so an older launch cannot be a candidate, and
 *   merging the whole 24h queue (~20k launches/day) would flood
 *   `seen` (pruned at 2,000 entries) and evict the first-seen mcs
 *   the merge exists to record. The queue FILE keeps 24h for
 *   debugging/replay; the spotter consumes the fresh slice only.
 * - The relay only changes WHEN a launch is seen, never WHETHER it
 *   can enter: every merged coin goes through every existing gate
 *   unchanged (Rugcheck, cluster, holder/liquidity floors,
 *   sell-sim, scoring). OKX is logged-only, never a gate.
 * - A WS-only coin's last_trade_timestamp starts at creation (the
 *   create event IS a trade), so it is candidate-eligible for its
 *   first 15 minutes. Its usd_market_cap comes from marketCapSol x
 *   the poll's live SOL price; a missing marketCapSol means 0, so
 *   the coin enters `seen` (honest launch mc for runUpPct) but
 *   cannot pass the $1,000 mc floor until a poll feed prices it.
 * - The 5-minute polling path is untouched and remains the fallback:
 *   if the relay dies, discovery degrades to polling, never to dark.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { WS_QUEUE_PATH } from "./spotter-paths.js";
import type { PumpCoin } from "./spotter.js";
export { WS_QUEUE_PATH } from "./spotter-paths.js";

/** Public keyless PumpPortal data feed. Trade streams on this socket
 * are metered/keyed — the relay subscribes to new tokens only. */
export const PUMPPORTAL_WS_URL = "wss://pumpportal.fun/api/data";

/** Queue entries older than this are pruned (file) / ignored (load). */
export const WS_QUEUE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Only queue entries this fresh are merged into a poll (matches the
 * candidate filter's tradeAgeMin < 15). */
export const WS_MERGE_MAX_AGE_MS = 15 * 60 * 1000;

/** A stream with no message for this long is presumed dead (the
 * socket can stay open while the firehose stops delivering) and the
 * relay reconnects. */
export const WS_STALE_MS = 10 * 60 * 1000;

export interface WsNewCoin {
  mint: string;
  name: string;
  symbol: string;
  /** Creator wallet (PumpPortal traderPublicKey). */
  creator: string;
  /** Market cap in SOL at creation, null when the event omits it. */
  marketCapSol: number | null;
  /** Bonding-curve address (PumpPortal bondingCurveKey). */
  bondingCurveKey: string;
  /** Launch time, milliseconds. The live event carries no timestamp,
   * so this is RECEIPT time (first-seen), not on-chain launch time —
   * a launch is seen within ~1s of creation, so the error is small,
   * but do not present it as the exact launch second. */
  createdAtMs: number;
  /** When the relay first saw the event, milliseconds. */
  firstSeenMs: number;
  signature: string;
  txType: string;
}

/**
 * Parse one PumpPortal message into a new-coin event, or null when it
 * is not a token-creation event. Accepts txType "create" and
 * "create_v2". The live event carries NO timestamp field (verified by
 * a 60s raw probe 2026-11-23), so createdAtMs falls back to nowMs
 * (receipt time) in practice; a numeric timestamp, seconds or ms, is
 * still honoured if one ever appears. Never throws — a bad frame must
 * not kill the relay.
 */
export function parsePumpPortalCreate(raw: unknown, nowMs = Date.now()): WsNewCoin | null {
  if (raw == null || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  if (m.txType !== "create" && m.txType !== "create_v2") return null;
  const mint = m.mint;
  if (typeof mint !== "string" || mint.length < 32 || mint.length > 44) return null;
  const ts = m.timestamp;
  // A timestamp more than 60s in the future is a bad clock (or a bad
  // frame), not a launch from tomorrow: clamp it to receipt time so
  // the coin cannot sit invisible to the age filter.
  const createdAtMs =
    typeof ts === "number" && Number.isFinite(ts) && ts > 0
      ? Math.min(ts > 1e12 ? ts : ts * 1000, nowMs + 60 * 1000)
      : nowMs;
  const mcSol = m.marketCapSol;
  return {
    mint,
    name: typeof m.name === "string" ? m.name : "",
    symbol: typeof m.symbol === "string" ? m.symbol : "",
    creator: typeof m.traderPublicKey === "string" ? m.traderPublicKey : "",
    marketCapSol: typeof mcSol === "number" && Number.isFinite(mcSol) && mcSol >= 0 ? mcSol : null,
    bondingCurveKey: typeof m.bondingCurveKey === "string" ? m.bondingCurveKey : "",
    createdAtMs,
    firstSeenMs: nowMs,
    signature: typeof m.signature === "string" ? m.signature : "",
    txType: m.txType as string,
  };
}

/**
 * Map a queued launch onto a PumpCoin. The create event IS a trade,
 * so last_trade_timestamp starts at creation. complete is false — a
 * launch has not graduated. The event carries the bonding-curve
 * address (bondingCurveKey); associated_bonding_curve is a different
 * PDA not in the event and stays empty (curve sets never match a real
 * holder address downstream).
 */
export function wsCoinToPumpCoin(e: WsNewCoin, solPriceUsd: number): PumpCoin {
  // A non-finite or non-positive SOL price is not a price: the mcap
  // is 0, never NaN or negative.
  const price = typeof solPriceUsd === "number" && Number.isFinite(solPriceUsd) && solPriceUsd > 0 ? solPriceUsd : 0;
  return {
    mint: e.mint,
    name: e.name,
    symbol: e.symbol,
    creator: e.creator,
    created_timestamp: e.createdAtMs,
    last_trade_timestamp: e.createdAtMs,
    usd_market_cap: e.marketCapSol != null ? e.marketCapSol * price : 0,
    complete: false,
    associated_bonding_curve: "",
    bonding_curve: e.bondingCurveKey,
    discoveredVia: "ws", // v2.17: WS-only until proven otherwise (merge keeps poll on overlap)
  };
}

/** Append one queue entry as a JSON line. Creates the directory when missing. */
export function appendWsQueueEntry(queuePath: string, entry: WsNewCoin): void {
  const dir = dirname(queuePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(queuePath, JSON.stringify(entry) + "\n", "utf8");
}

export interface WsQueueLoad {
  entries: WsNewCoin[];
  /** Malformed lines skipped (counted, never fatal). */
  skipped: number;
}

/** Validate one stored queue line back into a WsNewCoin. The stored
 * firstSeenMs is kept (parsePumpPortalCreate would overwrite it). */
export function parseWsQueueEntry(raw: unknown, nowMs = Date.now()): WsNewCoin | null {
  if (raw == null || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.mint !== "string" || m.mint.length < 32 || m.mint.length > 44) return null;
  const createdAtMs =
    typeof m.createdAtMs === "number" && Number.isFinite(m.createdAtMs)
      ? Math.min(m.createdAtMs, nowMs + 60 * 1000)
      : nowMs;
  return {
    mint: m.mint,
    name: typeof m.name === "string" ? m.name : "",
    symbol: typeof m.symbol === "string" ? m.symbol : "",
    creator: typeof m.creator === "string" ? m.creator : "",
    marketCapSol:
      typeof m.marketCapSol === "number" && Number.isFinite(m.marketCapSol) ? m.marketCapSol : null,
    bondingCurveKey: typeof m.bondingCurveKey === "string" ? m.bondingCurveKey : "",
    createdAtMs,
    firstSeenMs:
      typeof m.firstSeenMs === "number" && Number.isFinite(m.firstSeenMs)
        ? m.firstSeenMs
        : createdAtMs,
    signature: typeof m.signature === "string" ? m.signature : "",
    txType: typeof m.txType === "string" ? m.txType : "create",
  };
}

/**
 * Load the queue: deduped by mint (earliest firstSeen wins), entries
 * older than maxAgeMs dropped, malformed lines counted and skipped.
 * A missing file is an empty queue, not an error.
 */
export function loadWsQueue(
  queuePath: string,
  nowMs = Date.now(),
  maxAgeMs = WS_QUEUE_MAX_AGE_MS,
): WsQueueLoad {
  if (!existsSync(queuePath)) return { entries: [], skipped: 0 };
  const byMint = new Map<string, WsNewCoin>();
  let skipped = 0;
  for (const line of readFileSync(queuePath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      skipped += 1;
      continue;
    }
    const e = parseWsQueueEntry(parsed, nowMs);
    if (e === null) {
      skipped += 1;
      continue;
    }
    if (nowMs - e.createdAtMs > maxAgeMs) continue;
    const prev = byMint.get(e.mint);
    if (!prev || e.firstSeenMs < prev.firstSeenMs) byMint.set(e.mint, e);
  }
  return {
    entries: [...byMint.values()].sort((a, b) => a.createdAtMs - b.createdAtMs),
    skipped,
  };
}

/**
 * Rewrite the queue file keeping only entries younger than maxAgeMs,
 * deduped by mint (earliest firstSeen wins). The rewrite itself is
 * atomic (tmp + rename), but there is NO lock: the claim that "no
 * append can interleave" rests only on the relay being the sole
 * writer and calling this from its own single-threaded event loop —
 * a second writer (or a concurrent spotter) could interleave. A
 * missing file is a no-op.
 */
export function pruneWsQueueFile(
  queuePath: string,
  nowMs = Date.now(),
  maxAgeMs = WS_QUEUE_MAX_AGE_MS,
): number {
  const loaded = loadWsQueue(queuePath, nowMs, maxAgeMs);
  if (!existsSync(queuePath)) return 0;
  const tmp = queuePath + ".tmp";
  writeFileSync(tmp, loaded.entries.map((e) => JSON.stringify(e)).join("\n") + (loaded.entries.length > 0 ? "\n" : ""), "utf8");
  renameSync(tmp, queuePath);
  return loaded.entries.length;
}

/**
 * Merge WS-discovered coins into the poll list. The poll row wins for
 * live price / last-trade (it is fresher); the WS row wins for
 * created_timestamp when earlier (honest launch age) and fills a
 * missing creator. Returns the merged list and how many mints came
 * from the queue alone.
 */
export function mergeWsCoins(
  pollCoins: PumpCoin[],
  wsCoins: PumpCoin[],
): { coins: PumpCoin[]; wsNewCount: number } {
  // Clone the poll rows: the overlap branch below mutates
  // created_timestamp/creator, and the caller's list must not be
  // mutated by a merge.
  const byMint = new Map(pollCoins.map((c) => [c.mint, { ...c }]));
  let wsNewCount = 0;
  for (const w of wsCoins) {
    const p = byMint.get(w.mint);
    if (!p) {
      // v2.17: WS-only coin — tag its discovery source at insert.
      w.discoveredVia = "ws";
      byMint.set(w.mint, w);
      wsNewCount += 1;
      continue;
    }
    // Overlap: poll row wins, source stays poll — do not overwrite.
    if (w.created_timestamp < p.created_timestamp) p.created_timestamp = w.created_timestamp;
    if (!p.creator && w.creator) p.creator = w.creator;
  }
  return { coins: [...byMint.values()], wsNewCount };
}

/** Reconnect backoff, milliseconds by attempt: 1s, 2s, 5s, 10s, 30s,
 * then 60s forever. Deterministic (no jitter) so it is testable. */
const BACKOFF_STEPS_MS = [1000, 2000, 5000, 10000, 30000, 60000];

export function nextBackoffMs(attempt: number): number {
  return BACKOFF_STEPS_MS[Math.min(Math.max(0, attempt), BACKOFF_STEPS_MS.length - 1)];
}

/** True when no socket activity (message or connect) for longer than
 * staleMs — the firehose can stop delivering while the socket stays
 * open, so silence is itself the failure signal. */
export function isWsStale(lastActivityMs: number, nowMs: number, staleMs = WS_STALE_MS): boolean {
  return nowMs - lastActivityMs > staleMs;
}

export type WsHandleResult = "appended" | "duplicate" | "ignored" | "malformed" | "append_failed";

/**
 * Parse one raw WS frame and, for a new creation, append it to the
 * queue unless this process already appended that mint. Never throws:
 * a bad frame or a failed append must not kill the relay — the poll
 * fallback still covers discovery. `seenMints` maps mint ->
 * firstSeenMs (pruned hourly by the relay). The mint is marked seen
 * ONLY after a successful append: marking it first poisoned the set
 * (SOUL audit fix — a failed append left the mint "seen" forever
 * and every later retry returned "duplicate").
 */
export function handleWsMessage(
  raw: string,
  queuePath: string,
  seenMints: Map<string, number>,
  nowMs = Date.now(),
): WsHandleResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "malformed";
  }
  // parsePumpPortalCreate is pure property access and never throws;
  // no try/catch around it (the old one hid nothing).
  const entry = parsePumpPortalCreate(parsed, nowMs);
  if (entry === null) return "ignored";
  if (seenMints.has(entry.mint)) return "duplicate";
  try {
    appendWsQueueEntry(queuePath, entry);
  } catch {
    return "append_failed";
  }
  seenMints.set(entry.mint, entry.firstSeenMs);
  return "appended";
}
