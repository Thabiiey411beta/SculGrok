/**
 * BSC (four.meme) paper spotter runner — mirrors
 * apps/coordinator/src/spotter-run.ts for the Solana desk, against
 * the separate BSC state dir. Paper-only: no wallet, no keys, no
 * live trading, no signing.
 *
 * Usage: npx tsx apps/coordinator/src/bsc-spotter-run.ts
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import {
  acquireBscLock,
  BSC_DIR,
  BSC_JOURNAL_PATH,
  BSC_LOCK_PATH,
  BSC_STATE_PATH,
  bscReadiness,
  newBscState,
  normalizeBscState,
  releaseBscLock,
  runBscPoll,
  type BscState,
} from "../../../packages/bsc/src/bsc-spotter.js";
import { appendJournal, journalEntry } from "../../../packages/core/src/journal.js";

function loadState(): BscState {
  if (existsSync(BSC_STATE_PATH)) {
    return normalizeBscState(JSON.parse(readFileSync(BSC_STATE_PATH, "utf8")) as BscState);
  }
  return newBscState();
}

async function main(): Promise<void> {
  mkdirSync(BSC_DIR, { recursive: true });
  const lock = acquireBscLock(BSC_LOCK_PATH);
  if (!lock.held) {
    console.log(JSON.stringify({ poll: "skipped", reason: "lock held by another BSC run" }));
    return;
  }
  if (lock.reclaimed) {
    appendJournal(BSC_JOURNAL_PATH, journalEntry("bsc-spotter", "stale_lock_recovered", "orphaned lock dir older than 5 min removed, poll proceeding", {}));
    console.log(JSON.stringify({ poll: "stale_lock_recovered", reason: "orphaned lock dir removed" }));
  }
  try {
    const state = loadState();
    const before = { equity: state.equityUsd, trades: state.trades, polls: state.polls };
    const summary = await runBscPoll(state);
    mkdirSync(dirname(BSC_STATE_PATH), { recursive: true });
    // Atomic write (tmp + rename), same as the Solana runner (v2.12).
    writeFileSync(BSC_STATE_PATH + ".tmp", JSON.stringify(state, null, 2), "utf8");
    renameSync(BSC_STATE_PATH + ".tmp", BSC_STATE_PATH);
    console.log(JSON.stringify({
      poll: state.polls,
      equityUsd: Number(state.equityUsd.toFixed(4)),
      trades: state.trades,
      wins: state.wins,
      losses: state.losses,
      blocked: state.blocked,
      priceSourceLostCloses: state.priceSourceLostCloses,
      goplusBlocks: state.goplusBlocks ?? 0,
      holderFloorBlocks: state.holderFloorBlocks ?? 0,
      liquidityFloorBlocks: state.liquidityFloorBlocks ?? 0,
      sellSimBlocks: state.sellSimBlocks ?? 0,
      sellSimTransient: state.sellSimTransient ?? 0,
      volumeBlocks: state.volumeBlocks ?? 0,
      clusterBlocks: state.clusterBlocks ?? 0,
      gradChecks: state.gradChecks ?? 0,
      graduatesFound: state.graduatesFound ?? 0,
      cooldownSkips: state.cooldownSkips ?? 0,
      reentrySkips: state.reentrySkips ?? 0,
      bscCoinsSeen: state.bscCoinsSeen ?? 0,
      tradesToday: state.tradesToday ?? state.trades,
      worstLossPct: state.worstLossPct ?? 0,
      bnbPriceUsd: state.bnbPriceUsd,
      clusterGateAvailable: state.clusterGateAvailable,
      halted: state.halted,
      readiness: bscReadiness(state),
      openPositions: state.positions.map((p) => ({ address: p.address, name: p.name, entryMcUsd: p.entryMcUsd, lastMcUsd: p.lastMcUsd, remaining: p.position.remainingFraction })),
      seenCoins: Object.keys(state.seen).length,
      deltaEquity: Number((state.equityUsd - before.equity).toFixed(4)),
      startedAtMs: state.startedAtMs,
      summary,
    }, null, 2));
  } finally {
    releaseBscLock(BSC_LOCK_PATH, lock.token);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
