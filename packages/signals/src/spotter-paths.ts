/**
 * Shared filesystem paths for the spotter desk.
 *
 * This module imports NOTHING from the desk. It exists to break a
 * circular import: spotter.ts imports ws-queue.ts (WS discovery
 * merge), and ws-queue.ts needs the queue path. When the paths lived
 * in spotter.ts, ws-queue.ts evaluated `WS_QUEUE_PATH = SPOTTER_DIR
 * + ...` at module top level while spotter.ts was still mid-evaluation
 * and SPOTTER_DIR was in its temporal dead zone — both entry points
 * (spotter-run.ts, watcher-run.ts) crashed at import with
 * `ReferenceError: Cannot access 'SPOTTER_DIR' before initialization`
 * (2026-11-23 22:14 SAST, desk down until this fix). Paths live here
 * so no desk module ever evaluates a path before it is defined.
 */

export const SPOTTER_DIR =
  "/home/hatch/workspace/goals/solana-memecoin-flipping-system/hidden_files/spotter-test-20261122-v2";
export const STATE_PATH = SPOTTER_DIR + "/state.json";
export const JOURNAL_PATH = SPOTTER_DIR + "/journal.jsonl";

/** Queue file the WS relay appends to and the spotter poll reads. */
export const WS_QUEUE_PATH = SPOTTER_DIR + "/ws-new-coins.jsonl";
