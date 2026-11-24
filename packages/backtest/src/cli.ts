/** Minimal CLI for the shadow-position backtester:
 *   npx tsx packages/backtest/src/cli.ts <journal.jsonl> [...]
 * Prints the replay summary (counts, net, ladder agreement) and a
 * per-trade table. Read-only: it never touches state.json or the
 * live journal. Gate predicates live in replay.ts
 * (isOkxClusterGateKept / isHolderFloorKept) and are applied with
 * filterCohort — this CLI is the quick "what did the journal
 * actually do" check. Net covers verifiable trades only; UNKNOWN
 * trades (unverifiable legs or null buy fee) are counted apart.
 */
import { readFileSync } from "node:fs";
import { replayJournal } from "./replay.js";

const files = process.argv.slice(2).filter((a) => !a.startsWith("-"));
if (files.length === 0) {
  console.error("usage: npx tsx packages/backtest/src/cli.ts <journal.jsonl> [...]");
  process.exit(2);
}
const lines = files.flatMap((f) => readFileSync(f, "utf8").split("\n"));
const r = replayJournal(lines);
console.log(`trades=${r.trades.length} wins=${r.wins} losses=${r.losses} rugs=${r.rugs} unverifiable=${r.unverifiableTrades} net=$${r.netUsd.toFixed(2)} (verifiable trades only)`);
console.log(`skipped lines=${r.skippedLines} skipped closes=${r.skippedCloses} open at EOF=${r.openAtEof}`);
console.log(`ladder: ${r.ladderAgreed}/${r.ladderChecked} agreed, ${r.ladderUnverifiable} unverifiable (trailing/settled)`);
for (const t of r.trades) {
  const pnl = t.pnlUsd === null ? "n/a (unverifiable)" : `$${t.pnlUsd.toFixed(2)}`;
  const net = t.netPct === null ? "n/a" : `${(t.netPct * 100).toFixed(1)}%`;
  console.log(
    `${t.mint.slice(0, 10)} ${t.outcome.padEnd(7)} pnl=${pnl} net=${net} ` +
      `legs=${t.legs.length} okx=${t.okxCluster ?? "?"}/${t.okxHolders ?? "?"}`,
  );
}
