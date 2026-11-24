import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { acquireLock, releaseLock, JOURNAL_PATH, newState, normalizeState, readiness, runSpotterPoll, SPOTTER_DIR, STATE_PATH, type SpotterState } from "../../../packages/signals/src/spotter.js";
import { appendJournal, journalEntry } from "../../../packages/core/src/journal.js";

const LOCK_PATH = SPOTTER_DIR + "/watcher.lock";

function loadState(): SpotterState {
  if (existsSync(STATE_PATH)) {
    return normalizeState(JSON.parse(readFileSync(STATE_PATH, "utf8")) as SpotterState);
  }
  return newState();
}

async function main(): Promise<void> {
  mkdirSync(SPOTTER_DIR, { recursive: true });
  const lock = acquireLock(LOCK_PATH);
  if (!lock.held) {
    console.log(JSON.stringify({ poll: "skipped", reason: "lock held by watcher" }));
    return;
  }
  if (lock.reclaimed) {
    appendJournal(JOURNAL_PATH, journalEntry("spotter", "stale_lock_recovered", "orphaned lock dir older than 5 min removed, poll proceeding", {}));
    console.log(JSON.stringify({ poll: "stale_lock_recovered", reason: "orphaned lock dir removed" }));
  }
  try {
  const state = loadState();
  const before = { equity: state.equityUsd, trades: state.trades, polls: state.polls };
  await runSpotterPoll(state);
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  // v2.12 audit fix: write tmp + atomic rename. A direct writeFileSync
  // to state.json lets a concurrent reader (watcher initial load, which
  // runs without the lock, or any status read) see a torn half-written
  // file. The lock serialises writers, so the tmp name never collides.
  writeFileSync(STATE_PATH + ".tmp", JSON.stringify(state, null, 2), "utf8");
  renameSync(STATE_PATH + ".tmp", STATE_PATH);
  console.log(JSON.stringify({
    poll: state.polls,
    equityUsd: Number(state.equityUsd.toFixed(4)),
    trades: state.trades,
    wins: state.wins,
    losses: state.losses,
    blocked: state.blocked,
    priceSourceLostCloses: state.priceSourceLostCloses,
    clusterBlocks: state.clusterBlocks ?? 0,
    cabalBlocks: state.cabalBlocks ?? 0,
    okxSignals: state.okxSignals ?? 0,
    okxClusterGateBlocks: state.okxClusterGateBlocks ?? 0,
    holderFloorBlocks: state.holderFloorBlocks ?? 0,
    liquidityFloorBlocks: state.liquidityFloorBlocks ?? 0,
    alertBoosts: state.alertBoosts ?? 0,
    sentimentSignals: state.sentimentSignals ?? 0,
    riskHaircuts: state.riskHaircuts ?? 0,
    sellSimBlocks: state.sellSimBlocks ?? 0,
    sellSimTransient: state.sellSimTransient ?? 0,
    coBuySignals: state.coBuySignals ?? 0,
    wsCoinsSeen: state.wsCoinsSeen ?? 0,
    tradesToday: state.tradesToday ?? state.trades,
    worstLossPct: state.worstLossPct ?? 0,
    solPriceUsd: state.solPriceUsd,
    jupiterRescues: state.jupiterRescues ?? 0,
    readiness: readiness(state),
    openPositions: state.positions.map((p) => ({ mint: p.mint, name: p.name, entryMcUsd: p.entryMcUsd, lastMcUsd: p.lastMcUsd, remaining: p.position.remainingFraction })),
    seenCoins: Object.keys(state.seen).length,
    deltaEquity: Number((state.equityUsd - before.equity).toFixed(4)),
    startedAtMs: state.startedAtMs,
  }, null, 2));
  } finally {
    // Token-checked release only: never delete a lock by path
    // blindly (the old catch handler below did rmSync after this
    // finally had already released it, which could delete a NEW lock
    // taken by the next invocation).
    releaseLock(LOCK_PATH, lock.token);
  }
}

main().catch((err) => {
  // No lock cleanup here: any lock this run held was already
  // released by the finally above; a throw before acquireLock means
  // no lock was ever held. Touching the lock path here could delete
  // a lock belonging to the next invocation.
  console.error(err);
  process.exit(1);
});
