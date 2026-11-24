/**
 * Pump.fun WS discovery relay — v2.16, 2026-11-23.
 *
 * Long-running, paper-only. Holds ONE WebSocket to PumpPortal's public
 * keyless feed (wss://pumpportal.fun/api/data), subscribes to new
 * token launches, and appends every creation event to the discovery
 * queue (SPOTTER_DIR/ws-new-coins.jsonl) for the 5-minute spotter
 * poll to consume. No keys, no signing, no transactions, no funds.
 *
 * Rules that matter:
 * - ONE connection only. PumpPortal bans multiple concurrent
 *   connections (hourly ban). The relay never opens a second socket
 *   while one is alive; reconnects replace the socket, never add one.
 * - The relay NEVER exits on a feed error. Connect failures, closes,
 *   and stale streams all feed the reconnect loop with exponential
 *   backoff (1s..60s). It exits 0 only on SIGTERM/SIGINT, so systemd
 *   Restart=on-failure restarts crashes but not clean stops. The ONE
 *   exception is a malformed proxy URL at startup: a bad proxy is a
 *   config error, not a feed error — the relay exits non-zero
 *   rather than silently connecting direct (direct dies in ~500ms,
 *   so the fallback would just spin in a reconnect loop).
 * - Stale-stream watchdog: the firehose can stop delivering while
 *   the socket stays open, so 10 minutes without any message means
 *   the stream is dead — close and reconnect.
 * - The queue file is pruned hourly (entries > 24h dropped, deduped).
 *   The relay is the sole writer; pruning is atomic (tmp + rename).
 * - Logs are JSON lines on stdout (systemd journal captures them).
 *   Nothing secret is ever logged (events carry only public mint /
 *   creator / name data).
 *
 * Supervision: systemd unit sculgrok-ws-relay.service (canonical copy
 * in hidden_files/ws-relay/). If the service is down, discovery
 * degrades to the 5-minute poll — it never goes dark.
 *
 * Transport: the relay uses the `ws` package (not Node's built-in
 * WebSocket) with an HttpsProxyAgent, because this VM reaches the
 * internet through an HTTP egress proxy and Node's built-in
 * WebSocket does not use it — it connects direct and the handshake
 * dies in ~500ms (close 1006). curl proved the WS upgrade succeeds
 * through the proxy (HTTP 101). The proxy URL is read from the
 * HTTPS_PROXY env var and is never logged (it may carry credentials).
 */

import WebSocket from "ws";
import { HttpsProxyAgent } from "https-proxy-agent";
import {
  handleWsMessage,
  isWsStale,
  nextBackoffMs,
  pruneWsQueueFile,
  PUMPPORTAL_WS_URL,
  WS_QUEUE_MAX_AGE_MS,
  WS_QUEUE_PATH,
  WS_STALE_MS,
} from "../../../packages/signals/src/ws-queue.js";

const WS_URL = process.env.PUMPPORTAL_WS_URL ?? PUMPPORTAL_WS_URL;
const QUEUE_PATH = process.env.WS_QUEUE_PATH ?? WS_QUEUE_PATH;
// A malformed WS_STALE_MS (NaN, <= 0) is a config error: fall back
// to the compiled default instead of passing NaN to isWsStale (NaN
// comparisons are always false, so the watchdog would never fire).
const STALE_MS_RAW = Number(process.env.WS_STALE_MS ?? WS_STALE_MS);
const STALE_MS = Number.isFinite(STALE_MS_RAW) && STALE_MS_RAW > 0 ? STALE_MS_RAW : WS_STALE_MS;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

/** Egress proxy agent (see header). Undefined = connect direct.
 * A proxy env var that is set but malformed is a startup config
 * error: log and exit non-zero rather than silently connecting
 * direct (direct dies in ~500ms, so the fallback would only spin
 * the reconnect loop). The proxy value itself is never logged. */
const PROXY_AGENT = (() => {
  const proxy =
    process.env.HTTPS_PROXY ??
    process.env.https_proxy ??
    process.env.HTTP_PROXY ??
    process.env.http_proxy;
  if (!proxy) return undefined;
  const fatal = (msg: string): never => {
    console.error(JSON.stringify({ ts: new Date().toISOString(), service: "ws-relay", level: "error", msg }));
    process.exit(1);
  };
  let url: URL | null = null;
  try {
    url = new URL(proxy);
  } catch {
    url = null;
  }
  if (url === null || !url.hostname) fatal("malformed proxy URL in env, refusing to start");
  try {
    return new HttpsProxyAgent(proxy);
  } catch {
    fatal("could not build proxy agent, refusing to start");
  }
})();

interface RelayStats {
  connects: number;
  messages: number;
  appended: number;
  duplicates: number;
  ignored: number;
  malformed: number;
  appendFailed: number;
  reconnects: number;
}

function log(level: string, msg: string, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), service: "ws-relay", level, msg, ...extra }));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function wsDataToString(data: WebSocket.RawData): string | null {
  if (typeof data === "string") return data;
  if (data instanceof Buffer) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return null;
}

/**
 * One connection lifetime: connect, subscribe, forward messages until
 * the socket closes or the stream goes stale. Returns the uptime in
 * ms so the caller can reset the backoff after a healthy run.
 */
async function connectOnce(
  seenMints: Map<string, number>,
  stats: RelayStats,
): Promise<{ reason: "closed" | "stale"; uptimeMs: number }> {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const ws = new WebSocket(WS_URL, { agent: PROXY_AGENT, handshakeTimeout: 15000 });
    let lastActivityMs = Date.now();
    let settled = false;
    let opened = false;
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (reason: "closed" | "stale") => {
      if (settled) return;
      settled = true;
      clearInterval(watchdog);
      if (connectTimer !== undefined) clearTimeout(connectTimer);
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      resolve({ reason, uptimeMs: Date.now() - startedAt });
    };
    // Heartbeat + stale watchdog, every 60s. A 5-minute heartbeat
    // line keeps "is the relay alive" checkable from the journal.
    let ticks = 0;
    const watchdog = setInterval(() => {
      ticks += 1;
      if (ticks % 5 === 0) {
        log("info", "heartbeat", { ...stats, queue: QUEUE_PATH });
      }
      if (isWsStale(lastActivityMs, Date.now(), STALE_MS)) {
        log("warn", "stale stream, reconnecting", { idleMs: Date.now() - lastActivityMs });
        finish("stale");
      }
    }, 60000);
    ws.on("open", () => {
      // The connect timer is for a socket that never opens — clear it
      // now, or it would kill this healthy connection at 15s (bug
      // caught in the first smoke test: every connection died at ~15s).
      if (connectTimer !== undefined) clearTimeout(connectTimer);
      opened = true;
      lastActivityMs = Date.now();
      stats.connects += 1;
      log("info", "connected, subscribing to new tokens", { url: WS_URL });
      ws.send(JSON.stringify({ method: "subscribeNewToken" }));
    });
    ws.on("message", (data) => {
      lastActivityMs = Date.now();
      stats.messages += 1;
      const raw = wsDataToString(data);
      if (raw === null) {
        stats.malformed += 1;
        return;
      }
      const res = handleWsMessage(raw, QUEUE_PATH, seenMints);
      if (res === "appended") stats.appended += 1;
      else if (res === "duplicate") stats.duplicates += 1;
      else if (res === "ignored") stats.ignored += 1;
      else if (res === "malformed") stats.malformed += 1;
      else stats.appendFailed += 1;
    });
    ws.on("close", (code, reason) => {
      log("warn", "socket closed", { code, reason: reason.toString("utf8") });
      finish("closed");
    });
    ws.on("error", (err) => {
      log("error", "socket error", { message: err.message });
      // An error before the socket ever opened means the connect
      // failed: finish as "closed" so the reconnect loop runs now
      // instead of waiting out the 15s connect timer. An error on an
      // already-open socket is followed by "close", which finishes.
      if (!opened) finish("closed");
    });
    // Connect timeout: a socket that never opens must not hang the
    // loop forever. 15s is generous for a WS handshake. Cleared on
    // open (see above) — it must never fire on a live connection.
    connectTimer = setTimeout(() => {
      if (!settled) {
        log("warn", "connect timeout, reconnecting");
        finish("closed");
      }
    }, 15000);
  });
}

async function main(): Promise<void> {
  log("info", "ws-relay starting", { url: WS_URL, queue: QUEUE_PATH, staleMs: STALE_MS, proxy: PROXY_AGENT !== undefined });
  const seenMints = new Map<string, number>();
  const stats: RelayStats = {
    connects: 0,
    messages: 0,
    appended: 0,
    duplicates: 0,
    ignored: 0,
    malformed: 0,
    appendFailed: 0,
    reconnects: 0,
  };
  // Clean stop: exit 0 on SIGTERM/SIGINT so systemd Restart=
  // on-failure does NOT restart an intentional stop. Appends are
  // synchronous, so no queue entry is lost mid-write.
  process.on("SIGTERM", () => process.exit(0));
  process.on("SIGINT", () => process.exit(0));
  // Hourly queue prune (relay is the sole writer; atomic rewrite).
  // Also prunes the in-memory dedupe map so it does not grow forever.
  const pruner = setInterval(() => {
    try {
      const kept = pruneWsQueueFile(QUEUE_PATH, Date.now(), WS_QUEUE_MAX_AGE_MS);
      const cutoff = Date.now() - WS_QUEUE_MAX_AGE_MS;
      for (const [mint, firstSeen] of seenMints) {
        if (firstSeen < cutoff) seenMints.delete(mint);
      }
      log("info", "queue pruned", { kept, seenMints: seenMints.size });
    } catch (e) {
      log("error", "queue prune failed", { error: String(e) });
    }
  }, PRUNE_INTERVAL_MS);
  // A short initial prune keeps the file small after a restart.
  try {
    pruneWsQueueFile(QUEUE_PATH, Date.now(), WS_QUEUE_MAX_AGE_MS);
  } catch {
    /* empty/missing queue is fine */
  }
  let attempt = 0;
  for (;;) {
    let uptimeMs = 0;
    try {
      const res = await connectOnce(seenMints, stats);
      uptimeMs = res.uptimeMs;
      log("info", "connection ended", { reason: res.reason, uptimeMs });
    } catch (e) {
      // connectOnce is written not to throw on feed errors, but `new
      // WebSocket()` above CAN throw synchronously (invalid URL and
      // the like), rejecting the promise — this catch is what keeps
      // one bad construction from killing the relay. Not dead code.
      log("error", "connection loop threw", { error: String(e) });
    }
    // A healthy long-lived connection resets the backoff ladder.
    if (uptimeMs > 5 * 60 * 1000) attempt = 0;
    const delay = nextBackoffMs(attempt);
    attempt += 1;
    stats.reconnects += 1;
    log("info", "reconnecting", { delayMs: delay, attempt });
    await sleep(delay);
  }
}

main().catch((e) => {
  log("error", "fatal", { error: String(e) });
  process.exit(1);
});
