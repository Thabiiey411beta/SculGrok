/**
 * BSC funder-cluster gate (NodeReal MegaNode, 2026-11-24).
 *
 * The Solana desk's Helius funder-cluster check (v2.2), rebuilt
 * from BSC logs: is this mint's top-holder set funded by one
 * operator? Same verdict rules, same fail-closed posture.
 *
 * HOW IT WORKS (all verified live 2026-11-24 — see
 * hidden_files/bsc-cluster-gate-20261124.md):
 * - Creator + creation block: TokenManager2 TokenCreate logs.
 *   topic0 = keccak256("TokenCreate(address,address,uint256,string,
 *   string,uint256,uint256,uint256)") = 0x396d5e90...cad20
 *   (computed with a self-checked pure-python Keccak; prefix/suffix
 *   match the earlier truncated record AND 652 live logs decode
 *   cleanly). Creator/token are NOT indexed — they live in data
 *   words 0/1, so the lookup fetches a window and filters
 *   client-side. Creator verified to match GoPlus creatorAddress
 *   on the test token.
 * - Top holders: reconstructed from the mint's Transfer logs
 *   (creation block -> latest). No holder-list source exists on
 *   BSC (GoPlus/DexScreener give counts only) — reconstruction
 *   is the holder source. Balances are exact (BigInt).
 * - First funder per holder: nr_getAssetTransfers, categories
 *   ["external","internal"], native BNB, window = last 1,999,999
 *   blocks (~69d; the method rejects ranges >= 2M and rejects
 *   toBlock "latest" — explicit hex blocks only). Earliest inbound
 *   transfer >= 0.001 BNB is the first funder.
 *
 * DELIBERATE DEVIATION from the design note (documented, not a
 * mistake): the note's prescribed funder leg — earliest Transfer
 * log on the MINT contract — would false-cluster EVERY token:
 * for curve buys the sender is TokenManager2 itself, so every
 * holder's "first funder" would be the manager. Verified live:
 * all 6 top holders of the test token show the manager as their
 * only token sender. The native-BNB leg (nr_getAssetTransfers)
 * is the true analogue of Helius native funding, and is what
 * this module uses. Mint logs are used for holder reconstruction
 * + the direct-transfer rule only.
 *
 * VERDICT RULES (mirror Helius v2.2 / cluster-check.py exactly):
 * - One funder first-funding >= 2 top holders with combined
 *   >= 8% of supply -> cluster. Or >= 3 top holders regardless.
 * - Any top holder funded (any transfer >= floor, not just first)
 *   by the token creator -> cluster.
 * - A direct Transfer of this mint between two top holders ->
 *   cluster (transfers from a sender holding >= 20% ignored as
 *   pool/curve-like).
 * - Any RPC failure, no creation log, or no holders -> THROW
 *   (the caller blocks, fail-closed).
 * - Unknown-heavy (>= half of checked holders with no resolvable
 *   funder) -> verdict "unknown", NOT a block: the caller sizes
 *   the entry x 0.75 and journals cluster_unknown. NOTE: this
 *   diverges from Solana v2.18 (SOUL audit), which BLOCKS on
 *   >= half unknown — the task prescribes the 0.75x posture for
 *   BSC because the BSC funder leg is noisier (established
 *   wallets, CEX/WBNB funding paths, stable-quoted tokens whose
 *   holders never touch native BNB). Switching to block is a
 *   one-line change in the caller if Newton wants Solana parity.
 *
 * FUNDER EXCLUSIONS (system addresses never count as funders):
 * WBNB (unwraps pay native BNB to the unwrapper — verified live:
 * a top holder's funder was the WBNB contract), TokenManager2,
 * PancakeSwap Router02 (swap refunds), the token's PCS pair,
 * burn/zero, the mint itself. A shared funder that is a contract
 * other than these still counts (an operator CAN fund via a
 * contract); the 0.001 BNB dust floor excludes the gas-dust
 * payments observed live (a shared contract paying 0.000065 BNB
 * to all 6 top holders at the same blocks).
 */
import { NodeRealClient, NodeRealError, type NodeRealLog, type NodeRealTransfer } from "./nodereal.js";

export const TOKEN_MANAGER2 = "0x5c952063c7fc8610FFDB798152D69F0B9550762b";
export const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
export const PANCAKE_ROUTER_V2 = "0x10ED43C718714eb63d5aA57B78B54704E256024E";
export const BURN_ADDRESS = "0x000000000000000000000000000000000000dead";
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
/** keccak256("TokenCreate(address,address,uint256,string,string,uint256,uint256,uint256)") */
export const TOKEN_CREATE_TOPIC0 = "0x396d5e902b675b032348d3d2e9517ee8f0c4a926603fbc075d3d282ff00cad20";
export const TRANSFER_TOPIC0 = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** Top holders checked (same as the Solana gate). */
export const BSC_CLUSTER_TOP_HOLDERS = 6;
/** Dust floor for a funding transfer (mirrors Solana's 0.005 SOL scale). */
export const BSC_MIN_FUND_BNB = 0.001;
export const BSC_MIN_FUND_WEI = 1_000_000_000_000_000n;
/** nr_getAssetTransfers rejects ranges >= 2,000,000 blocks. */
export const BSC_FUNDER_WINDOW_BLOCKS = 1_999_999;
/** Creation-log walk-back: 40k-block chunks, at most this many. */
export const BSC_CREATION_CHUNKS = 3;
export const BSC_LOG_CHUNK_BLOCKS = 40_000;

export interface BscClusterHolder {
  owner: string;
  /** % of total supply (0-100). */
  pct: number;
  /** Earliest inbound native-BNB funder >= floor, or null. */
  firstFunder: string | null;
  /** All qualifying funders (earliest first) — the creator check
   * uses ANY funder, mirroring cluster-check.py. */
  funders: string[];
  /** Wallets that sent this mint to this holder (token links). */
  tokenLinks: string[];
}

export interface BscClusterResult {
  clustered: boolean;
  verdict: "clustered" | "clean" | "unknown";
  reason: string;
  /** Holders checked. */
  checked: number;
  /** Holders with a resolved funder. */
  funded: number;
  /** Holders with no resolvable funder. */
  unknown: number;
  sharedFunders: Array<{ funder: string; holders: string[]; pct: number; count: number }>;
  /** % of supply held by the union of linked holders. */
  linkedPct: number;
  linkedHolders: number;
  creatorFunded: string[];
  /** Creator's own % of supply when the creator is a top holder. */
  creatorPct: number | null;
  creator: string | null;
  creationBlock: number | null;
  holders: BscClusterHolder[];
  /** JSON-RPC attempts issued (the CU proxy). */
  callsMade: number;
}

export interface BscClusterRpc {
  callsMade: number;
  blockNumber(): Promise<number>;
  getLogs(filter: { address?: string; topics?: (string | null)[]; fromBlock: string; toBlock: string }): Promise<NodeRealLog[]>;
  getLogsChunked(filter: { address?: string; topics?: (string | null)[]; fromBlock: number; toBlock: number }): Promise<NodeRealLog[]>;
  assetTransfers(params: Record<string, unknown>): Promise<{ transfers: NodeRealTransfer[]; pageKey?: string }>;
}

function lower(a: string): string {
  return a.toLowerCase();
}

function shortAddr(a: string): string {
  return a.slice(0, 8) + "...";
}

function topicToAddress(topic: string): string {
  return "0x" + topic.slice(26);
}

/** Decode a TokenCreate log's data: word0 = creator, word1 = token
 * (neither is indexed). Returns null when the data is too short. */
export function decodeTokenCreate(data: string): { creator: string; token: string } | null {
  if (typeof data !== "string" || !data.startsWith("0x") || data.length < 2 + 128) return null;
  return {
    creator: "0x" + data.slice(26, 66),
    token: "0x" + data.slice(90, 130),
  };
}

/**
 * Reconstruct holder balances from mint Transfer logs. Pure.
 * - `logs` are the mint's Transfer logs (creation -> latest).
 * - `excluded` are system addresses never treated as holders
 *   (TokenManager2, PCS pair, burn, zero, the mint itself).
 * Returns the top `topN` holders by balance with % of total
 * supply (total = sum of all positive balances on-chain, which
 * is the minted supply — no decimals/totalSupply assumption)
 * and each holder's token-link senders (value > 0 only).
 */
export function reconstructHolders(
  logs: NodeRealLog[],
  excluded: Set<string>,
  topN: number = BSC_CLUSTER_TOP_HOLDERS,
): { holders: Array<{ owner: string; pct: number; tokenLinks: string[] }>; totalPositive: bigint } {
  const balances = new Map<string, bigint>();
  const links = new Map<string, Set<string>>();
  for (const log of logs) {
    if (!log.topics || log.topics.length < 3) continue;
    const from = topicToAddress(log.topics[1]);
    const to = topicToAddress(log.topics[2]);
    let value: bigint;
    try {
      value = BigInt(log.data);
    } catch {
      continue;
    }
    if (value <= 0n) continue;
    balances.set(from, (balances.get(from) ?? 0n) - value);
    balances.set(to, (balances.get(to) ?? 0n) + value);
    if (!links.has(to)) links.set(to, new Set<string>());
    links.get(to)?.add(from);
  }
  let totalPositive = 0n;
  for (const bal of balances.values()) {
    if (bal > 0n) totalPositive += bal;
  }
  if (totalPositive <= 0n) return { holders: [], totalPositive: 0n };
  const ranked = [...balances.entries()]
    .filter(([addr, bal]) => bal > 0n && !excluded.has(lower(addr)))
    .sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0))
    .slice(0, topN)
    .map(([owner, bal]) => ({
      owner,
      // 4-decimal-place percent via BigInt math (no float error).
      pct: Number((bal * 1_000_000n) / totalPositive) / 10_000,
      tokenLinks: [...(links.get(owner) ?? [])].filter((s) => !excluded.has(lower(s))),
    }));
  return { holders: ranked, totalPositive };
}

/**
 * Apply the cluster verdict rules to resolved per-holder data.
 * Pure — the same rules as cluster-check.py. `creator` may be
 * null (unknown creator: the creator-funded rule cannot fire).
 */
export function applyClusterRules(
  holders: BscClusterHolder[],
  creator: string | null,
): Pick<BscClusterResult, "clustered" | "verdict" | "reason" | "sharedFunders" | "linkedPct" | "linkedHolders" | "creatorFunded"> {
  const byFirst = new Map<string, BscClusterHolder[]>();
  for (const h of holders) {
    if (!h.firstFunder) continue;
    const list = byFirst.get(lower(h.firstFunder)) ?? [];
    list.push(h);
    byFirst.set(lower(h.firstFunder), list);
  }
  const shared: BscClusterResult["sharedFunders"] = [];
  const reasons: string[] = [];
  let clustered = false;
  for (const [funder, group] of byFirst) {
    const uniq = [...new Set(group.map((g) => lower(g.owner)))];
    if (uniq.length < 2) continue;
    const pct = Math.round(group.reduce((s, g) => s + g.pct, 0) * 100) / 100;
    shared.push({ funder, holders: uniq, pct, count: uniq.length });
    if (pct >= 8 || uniq.length >= 3) {
      clustered = true;
      reasons.push(`shared first funder ${shortAddr(funder)} funds ${uniq.length} top holders, ${pct.toFixed(1)}% of supply`);
    }
  }
  const creatorFunded: string[] = [];
  if (creator) {
    for (const h of holders) {
      if (h.funders.some((f) => lower(f) === lower(creator))) {
        if (creatorFunded.length === 0) {
          reasons.push(`top holder ${shortAddr(h.owner)} funded by token creator`);
        }
        creatorFunded.push(h.owner);
        clustered = true;
      }
    }
  }
  const ownerSet = new Set(holders.map((h) => lower(h.owner)));
  const pctByOwner = new Map(holders.map((h) => [lower(h.owner), h.pct]));
  const transferLinked = new Set<string>();
  for (const h of holders) {
    const links = h.tokenLinks.filter(
      (x) => ownerSet.has(lower(x)) && lower(x) !== lower(h.owner) && (pctByOwner.get(lower(x)) ?? 0) < 20,
    );
    if (links.length > 0) {
      clustered = true;
      if (transferLinked.size === 0) {
        reasons.push(`direct token transfer between top holders ${shortAddr(h.owner)} <- ${shortAddr(links[0])}`);
      }
      transferLinked.add(lower(h.owner));
      for (const l of links) transferLinked.add(lower(l));
    }
  }
  const linked = new Set<string>();
  for (const s of shared) for (const o of s.holders) linked.add(o);
  for (const o of creatorFunded) linked.add(lower(o));
  for (const o of transferLinked) linked.add(o);
  const linkedPct = Math.round([...linked].reduce((s, o) => s + (pctByOwner.get(o) ?? 0), 0) * 100) / 100;
  const unknown = holders.filter((h) => !h.firstFunder).length;
  const verdict = clustered ? "clustered" : unknown > 0 ? "unknown" : "clean";
  return {
    clustered,
    verdict,
    reason: reasons.length > 0 ? reasons.join("; ") : unknown > 0 ? `no shared funder found, ${unknown} holder(s) with no funding history in window` : "no shared funder found",
    sharedFunders: shared,
    linkedPct,
    linkedHolders: linked.size,
    creatorFunded,
  };
}

/** System addresses that never count as a funder (WBNB unwraps,
 * manager/pair refunds, burns). Pair address is per-token. */
export function funderExcludedAddrs(pairAddress?: string | null): Set<string> {
  const s = new Set<string>([lower(WBNB), lower(TOKEN_MANAGER2), lower(PANCAKE_ROUTER_V2), lower(BURN_ADDRESS), lower(ZERO_ADDRESS)]);
  if (pairAddress) s.add(lower(pairAddress));
  return s;
}

function hexBlock(n: number): string {
  return "0x" + n.toString(16);
}

/**
 * Full cluster check for one mint. Throws NodeRealError (or any
 * RPC error) on ANY failure — the caller blocks fail-closed.
 * Runs only on would-be entries: ~1 creation lookup + 1-3
 * transfer chunks + 1-2 nr calls per top holder.
 */
export async function checkBscCluster(
  mint: string,
  opts: { client?: BscClusterRpc; pairAddress?: string | null; topN?: number } = {},
): Promise<BscClusterResult> {
  const client: BscClusterRpc = opts.client ?? new NodeRealClient();
  const topN = opts.topN ?? BSC_CLUSTER_TOP_HOLDERS;
  const head = await client.blockNumber();
  const excluded = new Set<string>([lower(TOKEN_MANAGER2), lower(BURN_ADDRESS), lower(ZERO_ADDRESS), lower(mint)]);
  if (opts.pairAddress) excluded.add(lower(opts.pairAddress));
  const funderExcluded = funderExcludedAddrs(opts.pairAddress);

  // 1. Creator + creation block: TokenCreate logs, walking back
  // in 40k chunks (creator/token are NOT indexed — filter in code).
  let creation: { block: number; creator: string } | null = null;
  for (let c = 0; c < BSC_CREATION_CHUNKS && !creation; c += 1) {
    const to = head - c * BSC_LOG_CHUNK_BLOCKS;
    const from = Math.max(to - BSC_LOG_CHUNK_BLOCKS, 0);
    const logs = await client.getLogs({
      address: TOKEN_MANAGER2,
      topics: [TOKEN_CREATE_TOPIC0],
      fromBlock: hexBlock(from),
      toBlock: hexBlock(to),
    });
    for (const log of logs) {
      const decoded = decodeTokenCreate(log.data);
      if (decoded && lower(decoded.token) === lower(mint)) {
        creation = { block: parseInt(log.blockNumber, 16), creator: decoded.creator };
        break;
      }
    }
  }
  if (!creation) {
    throw new NodeRealError(`creation log not found for ${mint} in last ${BSC_CREATION_CHUNKS * BSC_LOG_CHUNK_BLOCKS} blocks`);
  }

  // 2. Top holders from mint Transfer logs (creation -> latest).
  const transferLogs = await client.getLogsChunked({
    address: mint,
    topics: [TRANSFER_TOPIC0],
    fromBlock: creation.block,
    toBlock: head,
  });
  const { holders: top } = reconstructHolders(transferLogs, excluded, topN);
  if (top.length === 0) {
    throw new NodeRealError(`no holders to check for ${mint} (empty holder list)`);
  }

  // 3. First native-BNB funder per holder (nr_getAssetTransfers,
  // external + internal, last ~69d, ascending, up to 2 pages).
  const fromBlock = Math.max(head - BSC_FUNDER_WINDOW_BLOCKS, 0);
  const resolved: BscClusterHolder[] = [];
  for (const h of top) {
    const funders: Array<{ from: string; block: number }> = [];
    let pageKey: string | undefined;
    for (let page = 0; page < 2 && funders.length === 0; page += 1) {
      const params: Record<string, unknown> = {
        fromBlock: hexBlock(fromBlock),
        toBlock: hexBlock(head),
        toAddress: h.owner,
        category: ["external", "internal"],
        maxCount: "0x32",
      };
      if (pageKey) params.pageKey = pageKey;
      const res = await client.assetTransfers(params);
      for (const t of res.transfers) {
        let valueWei: bigint;
        try {
          valueWei = BigInt(t.value);
        } catch {
          continue;
        }
        if (valueWei < BSC_MIN_FUND_WEI) continue;
        if (funderExcluded.has(lower(t.from))) continue;
        if (lower(t.from) === lower(h.owner)) continue;
        funders.push({ from: t.from, block: parseInt(t.blockNum, 16) });
      }
      pageKey = res.pageKey;
      if (!pageKey) break;
    }
    // Transfers arrive ascending by block; the first qualifying
    // one is the earliest funder in the window.
    funders.sort((a, b) => a.block - b.block);
    resolved.push({
      owner: h.owner,
      pct: h.pct,
      firstFunder: funders.length > 0 ? funders[0].from : null,
      funders: funders.map((f) => f.from),
      tokenLinks: h.tokenLinks,
    });
  }

  const rules = applyClusterRules(resolved, creation.creator);
  const unknown = resolved.filter((h) => !h.firstFunder).length;
  const creatorPct = (() => {
    const c = resolved.find((h) => lower(h.owner) === lower(creation!.creator));
    return c ? c.pct : null;
  })();
  return {
    ...rules,
    checked: resolved.length,
    funded: resolved.length - unknown,
    unknown,
    creatorPct,
    creator: creation.creator,
    creationBlock: creation.block,
    holders: resolved,
    callsMade: client.callsMade,
  };
}
