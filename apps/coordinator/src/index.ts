/**
 * SculGrok Coordinator — paper-mode skeleton
 *
 * This is the lead process. It loads the seven agent prompts,
 * listens for signals, runs Risk as a hard gate, and never signs transactions.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runPaper } from "./paper.js";

const MODE = process.argv.includes("--mode") 
  ? process.argv[process.argv.indexOf("--mode") + 1] 
  : "paper";

const LIVE_FLAG = process.argv.includes("--live");

function loadPrompt(name: string): string {
  return readFileSync(resolve(__dirname, "../../../prompts", `${name}.md`), "utf8");
}

async function main() {
  if (process.argv.includes("--paper-sim")) {
    const summary = runPaper(resolve(__dirname, "../../../paper-journal.jsonl"));
    console.log("Paper simulation ($3 micro profile):");
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  console.log("══════════════════════════════════════");
  console.log("  SculGrok  —  Multi-agent trading desk");
  console.log("══════════════════════════════════════");
  console.log(`Mode: ${MODE.toUpperCase()}`);
  
  if (MODE === "live" && !LIVE_FLAG) {
    console.error("Refusing to start live mode without --live flag. See docs/SAFETY.md");
    process.exit(1);
  }

  if (MODE === "live") {
    console.warn("⚠  LIVE MODE — real capital at risk. Two locks confirmed.");
  } else {
    console.log("✓  Paper mode (safe). Same rules as live, no real fills.");
  }

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

  console.log("\nDesk is ready. Waiting for signals...");
  console.log("(Wire ingest + anti-rug + executor next)");

  // Keep process alive for now
  setInterval(() => {}, 1 << 30);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
