import { LIGHT_FEES, legCostSol } from "../../../packages/core/src/fees.js";
import { appendJournal, journalEntry } from "../../../packages/core/src/journal.js";
import { MICRO_PROFILE, positionSizeSol, positionSizeUsd } from "../../../packages/core/src/micro.js";
import { applyExit, evaluateExit, openPosition, type Position } from "../../../packages/exit/src/exit.js";
import { evaluateRug } from "../../../packages/anti-rug/src/checks.js";
import { evaluateGem, type GemInput } from "../../../packages/signals/src/gem-signal.js";

export interface PaperScenario {
  name: string;
  mint: string;
  prices: number[];
  minutesPerTick: number;
  rugBlocked?: boolean;
}

export interface PaperSummary {
  startingEquityUsd: number;
  endingEquityUsd: number;
  trades: number;
  wins: number;
  losses: number;
  blocked: number;
  journalPath: string;
}

const CLEAN_RUG = {
  mintAuthorityLive: false,
  freezeAuthorityLive: false,
  top10Pct: 0.15,
  singleWalletPct: 0.05,
  bundlePct: 0.1,
  devSoldPct: 0.05,
  washPct: 0.1,
  lpLockedOrBurned: true,
  liquidityUsd: 20000,
  sellSimulationOk: true,
  token2022TransferFee: false,
  token2022TransferHook: false,
  token2022PermanentDelegate: false,
  token2022Pause: false,
  mutableMetadata: false,
};

const CLEAN_GEM: Omit<GemInput, "mint" | "positionSol"> = {
  uniqueBuyerGrowthPct: 60,
  buySellRatio: 2.0,
  newWalletInflow: 40,
  marketCapVelocityPct: 80,
  smartMoneyWallets: 2,
  smartMoneyMinTrades: 12,
  clusterPct: 0.1,
  // No washPct: wash is logged-only since v2.20, not a gem input.
  socialBeforeFlow: false,
  curveProgressPct: 80,
  migrated: true,
  liquidityUsd: 20000,
};

export function runPaper(journalPath: string, solPriceUsd: number): PaperSummary {
  if (!(solPriceUsd > 0)) throw new Error("runPaper: solPriceUsd must be a live price > 0");
  let equity = MICRO_PROFILE.startEquityUsd;
  let trades = 0;
  let wins = 0;
  let losses = 0;
  let blocked = 0;
  const solPrice = solPriceUsd;
  const scenarios: PaperScenario[] = [
    { name: "winner", mint: "WINNER111111111111111111111111111111111111", prices: [1, 1.2, 1.5, 1.8, 2.0], minutesPerTick: 10 },
    { name: "loser", mint: "LOSER1111111111111111111111111111111111111", prices: [1, 0.9, 0.8, 0.7], minutesPerTick: 10 },
    { name: "stall", mint: "STALL1111111111111111111111111111111111111", prices: [1, 1.01, 1.0, 1.01, 1.0], minutesPerTick: 30 },
    { name: "rug-blocked", mint: "RUG111111111111111111111111111111111111111", prices: [1, 2, 3], minutesPerTick: 10, rugBlocked: true },
  ];
  for (const sc of scenarios) {
    const rugInput = sc.rugBlocked
      ? { ...CLEAN_RUG, mint: sc.mint, mintAuthorityLive: true }
      : { ...CLEAN_RUG, mint: sc.mint };
    const rug = evaluateRug(rugInput);
    const sizeUsd = positionSizeUsd(equity);
    const sizeSol = positionSizeSol(equity, solPrice);
    const gem = evaluateGem({ ...CLEAN_GEM, mint: sc.mint, positionSol: sizeSol }, rug);
    appendJournal(journalPath, journalEntry(sc.mint, "signal", gem.reason, { score: gem.score, sizeUsd, equityUsd: equity }));
    if (!gem.actionable) {
      blocked += 1;
      appendJournal(journalPath, journalEntry(sc.mint, "blocked", gem.reason, { score: gem.score }));
      continue;
    }
    trades += 1;
    const entryPrice = sc.prices[0];
    let pos: Position = openPosition(sc.name, sc.mint, entryPrice, sizeUsd, 0);
    let proceedsUsd = 0;
    let costUsd = 0;
    // Buy leg, charged here and subtracted from P&L below (SOUL audit
    // fix: the old pnl = proceeds - size never subtracted it, so
    // every trade's P&L was overstated by the buy-leg cost).
    const buyLegCostUsd = legCostSol(sizeSol, LIGHT_FEES, true) * solPrice;
    costUsd += buyLegCostUsd;
    let closed = false;
    for (let i = 1; i < sc.prices.length; i++) {
      const atMs = i * sc.minutesPerTick * 60000;
      const price = sc.prices[i];
      const decision = evaluateExit(pos, { price, atMs });
      if (decision.action === "hold") {
        pos = applyExit(pos, decision, { price, atMs });
        continue;
      }
      const fractionSold = decision.fraction;
      const grossSol = sizeSol * fractionSold * (price / entryPrice);
      const legCost = legCostSol(grossSol, LIGHT_FEES, false) * solPrice;
      costUsd += legCost;
      proceedsUsd += grossSol * solPrice - legCost;
      appendJournal(journalPath, journalEntry(sc.mint, decision.action, decision.reason, { sizeUsd: sizeUsd * fractionSold, price, feesUsd: legCost }));
      pos = applyExit(pos, decision, { price, atMs });
      if (pos.remainingFraction <= 0) {
        closed = true;
        break;
      }
    }
    if (!closed && pos.remainingFraction > 0) {
      const lastPrice = sc.prices[sc.prices.length - 1];
      const grossSol = sizeSol * pos.remainingFraction * (lastPrice / entryPrice);
      const legCost = legCostSol(grossSol, LIGHT_FEES, false) * solPrice;
      costUsd += legCost;
      proceedsUsd += grossSol * solPrice - legCost;
      appendJournal(journalPath, journalEntry(sc.mint, "close", "end of scenario, close rest", { price: lastPrice, feesUsd: legCost }));
    }
    // Sell legs are already netted inside proceedsUsd (proceeds =
    // gross - legCost); the buy leg is the only cost left to subtract.
    const pnl = proceedsUsd - sizeUsd - buyLegCostUsd;
    equity += pnl;
    if (pnl > 0) wins += 1;
    else losses += 1;
    appendJournal(journalPath, journalEntry(sc.mint, "trade_done", sc.name + " pnl " + pnl.toFixed(4) + " USD", { sizeUsd, equityUsd: equity, feesUsd: costUsd }));
  }
  return { startingEquityUsd: MICRO_PROFILE.startEquityUsd, endingEquityUsd: equity, trades, wins, losses, blocked, journalPath };
}
