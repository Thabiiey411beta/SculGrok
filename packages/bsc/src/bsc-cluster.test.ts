/**
 * Unit tests for the BSC funder-cluster gate (bsc-cluster.ts).
 * All fixtures are fabricated log sets — no live RPC, no key.
 * Live behaviour is verified separately (see the build note).
 */
import { describe, expect, it } from "vitest";
import {
  applyClusterRules,
  checkBscCluster,
  decodeTokenCreate,
  reconstructHolders,
  TOKEN_CREATE_TOPIC0,
  TOKEN_MANAGER2,
  TRANSFER_TOPIC0,
  WBNB,
  type BscClusterHolder,
  type BscClusterRpc,
} from "./bsc-cluster.js";
import type { NodeRealLog } from "./nodereal.js";

const MGR = TOKEN_MANAGER2;
const PAIR = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BURN = "0x000000000000000000000000000000000000dead";
const ZERO = "0x0000000000000000000000000000000000000000";
const MINT = "0x1111111111111111111111111111111111111111";

function addr(n: number): string {
  return "0x" + n.toString(16).padStart(40, "0");
}

function padAddr(a: string): string {
  return "0x" + a.replace(/^0x/, "").padStart(64, "0");
}

function transferLog(from: string, to: string, valueTokens: bigint, block = 100): NodeRealLog {
  return {
    address: MINT,
    blockNumber: "0x" + block.toString(16),
    transactionHash: "0x" + "ab".repeat(32),
    logIndex: "0x0",
    topics: [TRANSFER_TOPIC0, padAddr(from), padAddr(to)],
    data: "0x" + (valueTokens * 10n ** 18n).toString(16).padStart(64, "0"),
  };
}

function createLog(creator: string, token: string, block = 90): NodeRealLog {
  const word = (a: string): string => a.replace(/^0x/, "").padStart(64, "0");
  return {
    address: MGR,
    blockNumber: "0x" + block.toString(16),
    transactionHash: "0x" + "cd".repeat(32),
    logIndex: "0x0",
    topics: [TOKEN_CREATE_TOPIC0],
    data: "0x" + word(creator) + word(token) + "0".repeat(64 * 6),
  };
}

const EXCLUDED = new Set([MGR.toLowerCase(), PAIR.toLowerCase(), BURN.toLowerCase(), ZERO.toLowerCase(), MINT.toLowerCase()]);

function holder(owner: string, pct: number, firstFunder: string | null, funders: string[] = [], tokenLinks: string[] = []): BscClusterHolder {
  return { owner, pct, firstFunder, funders: funders.length > 0 ? funders : firstFunder ? [firstFunder] : [], tokenLinks };
}

describe("decodeTokenCreate", () => {
  it("decodes creator (word0) and token (word1) from data", () => {
    const log = createLog(addr(1), addr(2));
    const d = decodeTokenCreate(log.data);
    expect(d?.creator.toLowerCase()).toBe(addr(1));
    expect(d?.token.toLowerCase()).toBe(addr(2));
  });
  it("returns null on short data", () => {
    expect(decodeTokenCreate("0x1234")).toBeNull();
  });
});

describe("reconstructHolders", () => {
  it("rebuilds balances + pcts and excludes system addresses", () => {
    const logs = [
      transferLog(ZERO, MGR, 1_000_000_000n, 90), // mint to manager
      transferLog(MGR, addr(1), 100_000_000n, 91),
      transferLog(MGR, addr(2), 50_000_000n, 92),
      transferLog(addr(1), addr(3), 10_000_000n, 93), // holder1 -> holder3
      transferLog(MGR, BURN, 5_000_000n, 94),
    ];
    const { holders } = reconstructHolders(logs, EXCLUDED, 6);
    expect(holders.map((h) => h.owner.toLowerCase())).toEqual([addr(1), addr(2), addr(3)]);
    expect(holders[0].pct).toBeCloseTo(9, 2); // 90M / 1B
    expect(holders[1].pct).toBeCloseTo(5, 2);
    expect(holders[2].pct).toBeCloseTo(1, 2);
    expect(holders[2].tokenLinks.map((a) => a.toLowerCase())).toEqual([addr(1)]);
    // Manager + burn are excluded even though they hold the most.
    expect(holders.some((h) => h.owner.toLowerCase() === MGR.toLowerCase())).toBe(false);
  });
  it("returns empty when there is nothing to count", () => {
    expect(reconstructHolders([], EXCLUDED, 6).holders).toEqual([]);
  });
});

describe("applyClusterRules", () => {
  const creator = addr(99);
  it("clusters on a shared first funder >= 2 holders and >= 8%", () => {
    const r = applyClusterRules(
      [holder(addr(1), 5, addr(50)), holder(addr(2), 4, addr(50)), holder(addr(3), 1, addr(51))],
      creator,
    );
    expect(r.clustered).toBe(true);
    expect(r.verdict).toBe("clustered");
    expect(r.sharedFunders).toHaveLength(1);
    expect(r.sharedFunders[0].pct).toBeCloseTo(9, 2);
    expect(r.linkedPct).toBeCloseTo(9, 2);
  });
  it("clusters on a shared first funder of >= 3 holders regardless of supply", () => {
    const r = applyClusterRules(
      [holder(addr(1), 1, addr(50)), holder(addr(2), 1, addr(50)), holder(addr(3), 1, addr(50))],
      creator,
    );
    expect(r.clustered).toBe(true);
  });
  it("does NOT cluster on a shared funder below both bars", () => {
    const r = applyClusterRules([holder(addr(1), 2, addr(50)), holder(addr(2), 2, addr(50))], creator);
    expect(r.clustered).toBe(false);
    expect(r.verdict).toBe("clean");
  });
  it("clusters when any top holder is funded by the creator", () => {
    const r = applyClusterRules(
      [holder(addr(1), 3, addr(50), [addr(50), creator]), holder(addr(2), 2, addr(51))],
      creator,
    );
    expect(r.clustered).toBe(true);
    expect(r.creatorFunded).toEqual([addr(1)]);
  });
  it("clusters on a direct token transfer between top holders", () => {
    const r = applyClusterRules(
      [holder(addr(1), 5, addr(50), [addr(50)], [addr(2)]), holder(addr(2), 4, addr(51), [addr(51)], [])],
      creator,
    );
    expect(r.clustered).toBe(true);
    expect(r.linkedPct).toBeCloseTo(9, 2);
  });
  it("ignores direct transfers from a sender holding >= 20%", () => {
    const r = applyClusterRules(
      [holder(addr(1), 5, addr(50), [addr(50)], [addr(9)]), holder(addr(9), 25, addr(51), [addr(51)], [])],
      creator,
    );
    expect(r.clustered).toBe(false);
  });
  it("reports unknown (not clustered) when holders have no funder", () => {
    const r = applyClusterRules([holder(addr(1), 5, null), holder(addr(2), 4, addr(51))], creator);
    expect(r.clustered).toBe(false);
    expect(r.verdict).toBe("unknown");
  });
  it("reports clean when every holder has an independent funder", () => {
    const r = applyClusterRules([holder(addr(1), 5, addr(50)), holder(addr(2), 4, addr(51))], creator);
    expect(r.clustered).toBe(false);
    expect(r.verdict).toBe("clean");
  });
});

/** Minimal fake RPC for the orchestrator tests. */
function fakeRpc(opts: {
  creation?: { block: number; creator: string } | null;
  transferLogs?: NodeRealLog[];
  funders?: Record<string, Array<{ from: string; valueBnb: number }>>;
  failOn?: "blockNumber" | "getLogs" | "assetTransfers";
}): BscClusterRpc {
  const head = 200_000;
  return {
    callsMade: 0,
    async blockNumber() {
      if (opts.failOn === "blockNumber") throw new Error("boom");
      return head;
    },
    async getLogs(filter) {
      if (opts.failOn === "getLogs") throw new Error("boom");
      if (filter.address === MGR) {
        if (opts.creation === null || opts.creation === undefined) return [];
        return [createLog(opts.creation.creator, MINT, opts.creation.block)];
      }
      return opts.transferLogs ?? [];
    },
    async getLogsChunked(filter) {
      if (opts.failOn === "getLogs") throw new Error("boom");
      return this.getLogs({ ...filter, fromBlock: "0x" + filter.fromBlock.toString(16), toBlock: "0x" + filter.toBlock.toString(16) });
    },
    async assetTransfers(params) {
      if (opts.failOn === "assetTransfers") throw new Error("boom");
      const to = (params as { toAddress: string }).toAddress;
      const list = opts.funders?.[to.toLowerCase()] ?? [];
      return {
        transfers: list.map((f, i) => ({
          category: "external",
          blockNum: "0x" + (1000 + i).toString(16),
          from: f.from,
          to,
          value: "0x" + BigInt(Math.round(f.valueBnb * 1e18)).toString(16),
          asset: "BNB",
          hash: "0x" + "ee".repeat(32),
        })),
      };
    },
  };
}

describe("checkBscCluster (orchestrator, fake RPC)", () => {
  const creator = addr(99);
  const baseLogs = [
    transferLog(ZERO, MGR, 1_000_000_000n, 90),
    transferLog(MGR, addr(1), 100_000_000n, 91),
    transferLog(MGR, addr(2), 50_000_000n, 92),
  ];
  it("returns clean when holders have independent funders", async () => {
    const rpc = fakeRpc({
      creation: { block: 90, creator },
      transferLogs: baseLogs,
      funders: {
        [addr(1)]: [{ from: addr(50), valueBnb: 0.5 }],
        [addr(2)]: [{ from: addr(51), valueBnb: 0.5 }],
      },
    });
    const r = await checkBscCluster(MINT, { client: rpc, pairAddress: PAIR });
    expect(r.clustered).toBe(false);
    expect(r.verdict).toBe("clean");
    expect(r.checked).toBe(2);
    expect(r.creator?.toLowerCase()).toBe(creator);
    expect(r.creationBlock).toBe(90);
  });
  it("returns clustered on a shared funder and reports the union", async () => {
    const rpc = fakeRpc({
      creation: { block: 90, creator },
      transferLogs: baseLogs,
      funders: {
        [addr(1)]: [{ from: addr(50), valueBnb: 0.5 }],
        [addr(2)]: [{ from: addr(50), valueBnb: 0.5 }],
      },
    });
    const r = await checkBscCluster(MINT, { client: rpc, pairAddress: PAIR });
    expect(r.clustered).toBe(true);
    expect(r.verdict).toBe("clustered");
    expect(r.linkedPct).toBeCloseTo(15, 2);
  });
  it("treats WBNB as a funder exclusion, not a funder", async () => {
    const rpc = fakeRpc({
      creation: { block: 90, creator },
      transferLogs: baseLogs,
      funders: {
        [addr(1)]: [{ from: WBNB, valueBnb: 0.5 }],
        [addr(2)]: [{ from: WBNB, valueBnb: 0.5 }],
      },
    });
    const r = await checkBscCluster(MINT, { client: rpc, pairAddress: PAIR });
    expect(r.clustered).toBe(false);
    expect(r.unknown).toBe(2);
  });
  it("ignores sub-dust funding transfers", async () => {
    const rpc = fakeRpc({
      creation: { block: 90, creator },
      transferLogs: baseLogs,
      funders: {
        [addr(1)]: [{ from: addr(50), valueBnb: 0.00006 }],
        [addr(2)]: [{ from: addr(51), valueBnb: 0.5 }],
      },
    });
    const r = await checkBscCluster(MINT, { client: rpc, pairAddress: PAIR });
    expect(r.unknown).toBe(1);
    expect(r.funded).toBe(1);
  });
  it("throws when the creation log is not found (fail-closed)", async () => {
    const rpc = fakeRpc({ creation: null, transferLogs: baseLogs });
    await expect(checkBscCluster(MINT, { client: rpc })).rejects.toThrow(/creation log not found/);
  });
  it("throws when there are no holders (fail-closed)", async () => {
    const rpc = fakeRpc({ creation: { block: 90, creator }, transferLogs: [transferLog(ZERO, MGR, 1_000_000_000n, 90)] });
    await expect(checkBscCluster(MINT, { client: rpc })).rejects.toThrow(/no holders/);
  });
  it("throws when an RPC call fails (fail-closed)", async () => {
    const rpc = fakeRpc({ creation: { block: 90, creator }, transferLogs: baseLogs, failOn: "assetTransfers" });
    await expect(checkBscCluster(MINT, { client: rpc })).rejects.toThrow("boom");
  });
});
