/**
 * SculGrok Coordinator — paper-mode skeleton.
 *
 * This is the lead process. It loads the seven agent prompts and
 * reports the desk state. It does NOT listen for signals, does NOT
 * run Risk as a hard gate, and never signs transactions — the old
 * header claimed all three and none of them was true. Live mode is
 * NOT implemented here: --mode live (or --live) exits 1. The live
 * spotter/watcher are apps/coordinator/src/spotter-run.ts and
 * watcher-run.ts (paper positions only); this file is the prompt
 * loader + paper-sim entry point only.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runPaper } from "./paper.js";
import { fetchSolPriceUsd } from "../../../packages/signals/src/spotter.js";

const MODE = process.argv.includes("--mode")
  ? process.argv[process.argv.indexOf("--mode") + 1]
  : "paper";

const LIVE_FLAG = process.argv.includes("--live");

function loadPrompt(name: string): string {
  return readFileSync(resolve(__dirname, "../../../prompts", `${name}.md`), "utf8");
}

async function main() {
  if (process.argv.includes("--paper-sim")) {
    // The sim needs a real SOL price: fetch it live, fail-closed
    // (exit 1) when Jupiter cannot price SOL — never a made-up one.
    const solPrice = await fetchSolPriceUsd();
    if (solPrice === null) {
      console.error("paper-sim: SOL price unavailable, fail-closed");
      process.exit(1);
    }
    const summary = runPaper(resolve(__dirname, "../../../paper-journal.jsonl"), solPrice);
    console.log("Paper simulation ($10 micro profile):");
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  console.log("══════════════════════════════════════");
  console.log("  SculGrok  —  Multi-agent trading desk");
  console.log("══════════════════════════════════════");
  console.log(`Mode: ${MODE.toUpperCase()}`);

  if (MODE === "live" || LIVE_FLAG) {
    console.error("Live mode is not implemented in this coordinator. It is paper-only; the live spotter/watcher run under spotter-run.ts / watcher-run.ts (paper positions only).");
    process.exit(1);
  }

  console.log("✓  Paper mode (safe). Same rules as live, no real fills.");

  const agents = [
    "coordinator",
    "scout",
    "scalper",
    "hedge",
    "risk",
    "news",
    "exit",
  ];

  console.log("\nLoaded agents:");
  for (const a of agents) {
    const prompt = loadPrompt(a);
    console.log(`  • ${a.padEnd(12)} (${prompt.length} chars)`);
  }

  console.log("\nDesk is ready. (No signal loop — see spotter-run.ts.)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
