/**
 * Thin JSON-RPC client for the NodeReal MegaNode BSC endpoint.
 *
 * The endpoint URL lives ONLY at ~/.nodereal/bsc-rpc-url (mode 600,
 * secured 2026-11-24). It is read at runtime, trimmed, and NEVER
 * printed, logged, or recorded anywhere — errors name the file,
 * never the value. A missing/unreadable file is a hard error (the
 * caller fails closed); there is no default URL and no fallback
 * to a public RPC (public RPCs reject eth_getLogs with -32005).
 *
 * Verified live 2026-11-24 (see hidden_files/nodereal-implementation-20261124.md
 * and hidden_files/bsc-cluster-gate-20261124.md):
 * - eth_chainId -> 0x38, eth_blockNumber live head.
 * - eth_getLogs: a single call rejects ranges >= 50,000 blocks
 *   ("exceed maximum block range: 50000") — chunk at 40,000.
 * - nr_getAssetTransfers EXISTS with Alchemy-style params, but its
 *   category enum is {external, internal, 20, 721, 1155, state,
 *   deposit, withdraw} (NOT "erc20"); block range must be
 *   < 2,000,000 blocks; toBlock must be an explicit hex block
 *   (the string "latest" is rejected with "from must be less than
 *   to"). Transfers return ascending by block by default.
 * - Method CU costs (docs): eth_getLogs 50, eth_call 20,
 *   eth_getBalance 15, eth_blockNumber 5. nr_* CU is NOT published;
 *   the client counts calls so the caller can budget by call count.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const NODEREAL_URL_FILE = join(homedir(), ".nodereal", "bsc-rpc-url");
/** Chunk size for eth_getLogs ranges (NodeReal rejects >= 50,000). */
export const NODEREAL_MAX_LOG_RANGE_BLOCKS = 40_000;
/** Per-call timeout; one retry on 5xx/timeout/429, never on 4xx. */
export const NODEREAL_TIMEOUT_MS = 15_000;

export class NodeRealError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NodeRealError";
  }
}

/** Read the endpoint URL from disk (trimmed). Throws NodeRealError
 * when the file is missing, unreadable, or empty. The value is
 * never included in the error. */
export function readNodeRealUrl(filePath: string = NODEREAL_URL_FILE): string {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    throw new NodeRealError(`nodereal endpoint file unreadable: ${filePath}`);
  }
  const url = raw.trim();
  if (!url.startsWith("https://")) {
    throw new NodeRealError(`nodereal endpoint file has no https URL: ${filePath}`);
  }
  return url;
}

export interface NodeRealLog {
  address: string;
  blockNumber: string;
  transactionHash: string;
  logIndex: string;
  topics: string[];
  data: string;
  removed?: boolean;
}

export interface NodeRealTransfer {
  category: string;
  blockNum: string;
  from: string;
  to: string;
  value: string;
  asset: string;
  hash: string;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export class NodeRealClient {
  readonly url: string;
  private nextId = 1;
  /** JSON-RPC attempts issued (retries included) — the CU proxy. */
  callsMade = 0;

  constructor(url?: string) {
    this.url = url ?? readNodeRealUrl();
  }

  /** One JSON-RPC call with timeout + one retry on 5xx/timeout/
   * 429/network errors. JSON-RPC error objects and HTTP 4xx (other
   * than 429) are never retried. Throws NodeRealError. */
  async request(method: string, params: unknown[]): Promise<unknown> {
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), NODEREAL_TIMEOUT_MS);
      this.callsMade += 1;
      try {
        const res = await fetch(this.url, {
          method: "POST",
          signal: ctrl.signal,
          headers: { "content-type": "application/json", accept: "application/json", "user-agent": "SculGrok-bsc/0.1 paper-test" },
          body: JSON.stringify({ jsonrpc: "2.0", id: this.nextId, method, params }),
        });
        this.nextId += 1;
        if (!res.ok) {
          if (isRetryableStatus(res.status) && attempt === 0) {
            lastErr = new NodeRealError(`${method} HTTP ${res.status}`);
            continue;
          }
          throw new NodeRealError(`${method} HTTP ${res.status}`);
        }
        const json = (await res.json()) as { result?: unknown; error?: { code?: number; message?: string } };
        if (json.error) {
          throw new NodeRealError(`${method} RPC error ${json.error.code ?? "?"}: ${json.error.message ?? "unknown"}`);
        }
        return json.result ?? null;
      } catch (e) {
        if (e instanceof NodeRealError) throw e;
        // Network error / abort (timeout): one retry, then throw.
        lastErr = e instanceof Error ? e : new Error(String(e));
        if (attempt === 0) continue;
        throw new NodeRealError(`${method} failed: ${lastErr.message}`);
      } finally {
        clearTimeout(t);
      }
    }
    throw lastErr ?? new NodeRealError(`${method} failed`);
  }

  async chainId(): Promise<string> {
    const r = await this.request("eth_chainId", []);
    if (typeof r !== "string") throw new NodeRealError("eth_chainId returned no hex string");
    return r;
  }

  async blockNumber(): Promise<number> {
    const r = await this.request("eth_blockNumber", []);
    if (typeof r !== "string") throw new NodeRealError("eth_blockNumber returned no hex string");
    return parseInt(r, 16);
  }

  /** Single eth_getLogs call. Rejects ranges over
   * NODEREAL_MAX_LOG_RANGE_BLOCKS (the node rejects >= 50k). */
  async getLogs(filter: { address?: string; topics?: (string | null)[]; fromBlock: string; toBlock: string }): Promise<NodeRealLog[]> {
    const from = parseInt(filter.fromBlock, 16);
    const to = parseInt(filter.toBlock, 16);
    if (Number.isFinite(from) && Number.isFinite(to) && to - from > NODEREAL_MAX_LOG_RANGE_BLOCKS) {
      throw new NodeRealError(`eth_getLogs range ${to - from} blocks exceeds ${NODEREAL_MAX_LOG_RANGE_BLOCKS} (use getLogsChunked)`);
    }
    const r = await this.request("eth_getLogs", [filter]);
    if (!Array.isArray(r)) throw new NodeRealError("eth_getLogs returned no array");
    return r as NodeRealLog[];
  }

  /** eth_getLogs over [fromBlock, toBlock] (inclusive block numbers),
   * split into <= 40k-block chunks, sequential. Returns all logs. */
  async getLogsChunked(filter: { address?: string; topics?: (string | null)[]; fromBlock: number; toBlock: number }): Promise<NodeRealLog[]> {
    const out: NodeRealLog[] = [];
    let from = filter.fromBlock;
    while (from <= filter.toBlock) {
      const to = Math.min(from + NODEREAL_MAX_LOG_RANGE_BLOCKS, filter.toBlock);
      const chunk = await this.getLogs({ ...filter, fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16) });
      out.push(...chunk);
      from = to + 1;
    }
    return out;
  }

  async call(to: string, data: string, block: string = "latest"): Promise<string | null> {
    const r = await this.request("eth_call", [{ to, data }, block]);
    return typeof r === "string" ? r : null;
  }

  /** nr_getAssetTransfers (Alchemy-style params, NodeReal category
   * enum). Returns the raw result { transfers, pageKey }. Throws
   * NodeRealError on any failure — the caller fails closed. */
  async assetTransfers(params: Record<string, unknown>): Promise<{ transfers: NodeRealTransfer[]; pageKey?: string }> {
    const r = await this.request("nr_getAssetTransfers", [params]);
    if (typeof r !== "object" || r === null || !Array.isArray((r as { transfers?: unknown }).transfers)) {
      throw new NodeRealError("nr_getAssetTransfers returned no transfers array");
    }
    return r as { transfers: NodeRealTransfer[]; pageKey?: string };
  }
}
