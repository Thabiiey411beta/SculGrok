/**
 * Operator + sell-impact replay (v2.22): for every archived paper
 * trade, run the LIVE operator check on its mint and tabulate the
 * operator metrics against the trade's journaled outcome.
 *
 *   npx tsx packages/backtest/src/operator-replay.ts <journal.jsonl> [...] [--out <rows.json>] [--curves <curves.json>]
 *
 * READ-ONLY: reads journal COPIES, never touches state.json or the
 * live journal, never trades. It only makes read-only API calls
 * (Rugcheck report, Jupiter lite-api stats, Helius enhanced txs via
 * the cluster check). One retry per failed check, 3s between mints
 * to stay polite to the Helius free tier.
 *
 * CAVEATS — read before quoting any number from this replay:
 * 1. Holder composition is CURRENT, not entry-time. A token's
 *    operators churn after entry, so this tests "do rugs still look
 *    concentrated now", NOT "would the signal have caught the rug
 *    at entry". Weak evidence; a clean replay does not prove the
 *    signal would have worked live, and a dirty one does not prove
 *    it would have failed.
 * 2. Outcomes: the backtest harness outcome when verifiable
 *    (buy fee estimated at SOL $73, the documented $10-run price);
 *    otherwise an APPROXIMATE outcome from leg price ratios with
 *    fees ignored (rows marked outcomeSource "approx"). Near-zero
 *    trades could flip class under the approximation; our trades
 *    are mostly +/-30-100%, so the classes are robust.
 * 3. The replay cannot see the bonding-curve address from the
 *    journal, so it derives it: the curve PDA is deterministic
 *    (seeds ["bonding-curve", mint] under the pump program), and
 *    the derivation is verified 5/5 against the live
 *    frontend-api-v3 coin list plus the 8WiK2Bp1Jo case, where the
 *    derived curve PDA equals the top holder's owner and the
 *    derived ATA equals the market's liquidityA. Pass the derived
 *    addresses via --curves <curves.json> (see curve-pda.py).
 *    Without --curves the float exclusion misses the curve and
 *    the curve itself reads as the largest "operator" — the rows
 *    are then wrong, not just noisy.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { replayJournal, type ParsedTrade } from "./replay.js";
import {
  checkCluster,
  fetchJupiterTokenStats,
  fetchRugcheck,
} from "../../signals/src/spotter.js";
import { analyzeOperator, BURN_ADDRESS, operatorExcludedAddrs, realFloatPctFromTopHolders } from "../../signals/src/operator.js";

const SOL_PRICE_USD = 73; // documented $10-run price (replay.ts)
const SLEEP_MS = 3000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface OperatorRow {
  mint: string;
  outcome: string;
  outcomeSource: "harness" | "approx" | "unknown";
  netPct: number | null;
  entryAt: string;
  operatorCount: number | null;
  largestOperatorPctSupply: number | null;
  largestOperatorPctFloat: number | null;
  top3OperatorPctFloat: number | null;
  linkedPctFloat: number | null;
  sellImpactLargestPct: number | null;
  sellImpactTop3Pct: number | null;
  sellImpactAllLinkedPct: number | null;
  realFloatPct: number | null;
  mcUsd: number | null;
  liquidityUsd: number | null;
  checked: number | null;
  unknownHolders: number | null;
  error: string | null;
}

/** Approximate net % from leg price ratios, fees ignored: a partial
 * sells half of what remains (or its journaled size share), a close
 * sells the rest. Only used when the harness cannot verify the P&L. */
function approxNetPct(t: ParsedTrade): number | null {
  if (!(t.entryPrice > 0) || !(t.sizeUsd > 0) || t.legs.length === 0) return null;
  let remaining = 1;
  let net = 0;
  for (const leg of t.legs) {
    const frac =
      leg.action === "partial"
        ? leg.sizeUsd !== null
          ? leg.sizeUsd / t.sizeUsd
          : 0.5 * remaining
        : remaining;
    net += frac * (leg.price / t.entryPrice - 1);
    remaining -= frac;
  }
  return net;
}

function classify(net: number | null): string {
  if (net === null) return "UNKNOWN";
  if (net <= -0.9) return "RUG";
  return net > 0 ? "WIN" : "LOSS";
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const outIdx = argv.indexOf("--out");
  const outPath = outIdx >= 0 ? argv[outIdx + 1] : null;
  const curvesIdx = argv.indexOf("--curves");
  const curvesPath = curvesIdx >= 0 ? argv[curvesIdx + 1] : null;
  const curves: Record<string, { bonding_curve?: string; associated_bonding_curve?: string }> =
    curvesPath !== null ? (JSON.parse(readFileSync(curvesPath, "utf8")) as Record<string, { bonding_curve?: string; associated_bonding_curve?: string }>) : {};
  const files = argv.filter((a) => !a.startsWith("--") && a !== outPath && a !== curvesPath);
  if (files.length === 0) {
    console.error("usage: npx tsx packages/backtest/src/operator-replay.ts <journal.jsonl> [...] [--out <rows.json>]");
    process.exit(2);
  }
  const lines = files.flatMap((f) => readFileSync(f, "utf8").split("\n"));
  const replay = replayJournal(lines, { solPriceUsd: SOL_PRICE_USD });
  console.log(`trades=${replay.trades.length} wins=${replay.wins} losses=${replay.losses} rugs=${replay.rugs} unverifiable=${replay.unverifiableTrades}`);
  const seenMints = new Map<string, OperatorRow>();
  const rows: OperatorRow[] = [];
  for (const t of replay.trades) {
    let outcome: string = t.outcome;
    let outcomeSource: OperatorRow["outcomeSource"] = "harness";
    let netPct = t.netPct;
    if (outcome === "UNKNOWN") {
      const approx = approxNetPct(t);
      if (approx !== null) {
        outcome = classify(approx);
        outcomeSource = "approx";
        netPct = approx;
      } else {
        outcomeSource = "unknown";
      }
    }
    const row: OperatorRow = {
      mint: t.mint,
      outcome,
      outcomeSource,
      netPct,
      entryAt: new Date(t.entryAtMs).toISOString(),
      operatorCount: null,
      largestOperatorPctSupply: null,
      largestOperatorPctFloat: null,
      top3OperatorPctFloat: null,
      linkedPctFloat: null,
      sellImpactLargestPct: null,
      sellImpactTop3Pct: null,
      sellImpactAllLinkedPct: null,
      realFloatPct: null,
      mcUsd: null,
      liquidityUsd: null,
      checked: null,
      unknownHolders: null,
      error: null,
    };
    rows.push(row);
    if (seenMints.has(t.mint)) continue;
    seenMints.set(t.mint, row);
  }
  console.log(`unique mints=${seenMints.size} (re-entries share one operator check)`);
  for (const [mint, row] of seenMints) {
    try {
      const report = (await fetchRugcheck(mint)) as {
        topHolders?: Array<{ address: string; pct: number; owner?: string }>;
        creator?: string | null;
        markets?: Array<{ liquidityA?: string | null }>;
        lockerOwners?: Record<string, unknown> | Array<string> | null;
      };
      const topHolders = report.topHolders ?? [];
      // Curve addresses from the derived PDA map (--curves); without
      // them the curve itself reads as the largest "operator".
      const curve = curves[mint] ?? {};
      const excluded = operatorExcludedAddrs({
        curveAddrs: [curve.bonding_curve, curve.associated_bonding_curve],
        markets: report.markets ?? null,
        lockerOwners: report.lockerOwners ?? null,
      });
      const holders = topHolders
        .filter((h) => h.owner && !excluded.has(h.address) && !excluded.has(h.owner ?? ""))
        .slice(0, 6)
        .map((h) => ({ owner: h.owner as string, pct: h.pct ?? 0 }));
      if (holders.length === 0) {
        row.error = "no curve-excluded top holders in live Rugcheck report";
        console.log(`${mint.slice(0, 10)} ${row.outcome.padEnd(7)} ${row.error}`);
        await sleep(SLEEP_MS);
        continue;
      }
      const creator = typeof report.creator === "string" ? report.creator : "";
      let cluster = await checkCluster(mint, holders, creator);
      if (cluster === null) {
        await sleep(1000);
        cluster = await checkCluster(mint, holders, creator);
      }
      if (cluster === null) {
        row.error = "cluster check failed twice";
        console.log(`${mint.slice(0, 10)} ${row.outcome.padEnd(7)} ${row.error}`);
        await sleep(SLEEP_MS);
        continue;
      }
      const jup = await fetchJupiterTokenStats(mint);
      const realFloat = realFloatPctFromTopHolders(topHolders, excluded);
      const f = analyzeOperator(cluster, {
        mcUsd: jup?.mcap ?? null,
        liquidityUsd: jup?.liquidityUsd ?? null,
        realFloatPct: realFloat,
      });
      row.operatorCount = f.operatorCount;
      row.largestOperatorPctSupply = f.largestOperatorPctSupply;
      row.largestOperatorPctFloat = f.largestOperatorPctFloat;
      row.top3OperatorPctFloat = f.top3OperatorPctFloat;
      row.linkedPctFloat = f.linkedPctFloat;
      row.sellImpactLargestPct = f.sellImpactLargestPct;
      row.sellImpactTop3Pct = f.sellImpactTop3Pct;
      row.sellImpactAllLinkedPct = f.sellImpactAllLinkedPct;
      row.realFloatPct = f.realFloatPct;
      row.mcUsd = f.mcUsd;
      row.liquidityUsd = f.liquidityUsd;
      row.checked = cluster.checked;
      row.unknownHolders = cluster.unknown;
      const fmt = (v: number | null): string => (v === null ? "?" : v.toFixed(1) + "%");
      console.log(
        `${mint.slice(0, 10)} ${row.outcome.padEnd(7)} (${row.outcomeSource}) net=${row.netPct === null ? "?" : (row.netPct * 100).toFixed(1) + "%"} ` +
          `ops=${row.operatorCount ?? "?"} largest=${fmt(row.largestOperatorPctFloat)} top3=${fmt(row.top3OperatorPctFloat)} ` +
          `sellTop3=${fmt(row.sellImpactTop3Pct)} float=${row.realFloatPct === null ? "?" : row.realFloatPct.toFixed(1) + "%"} ` +
          `mc=${row.mcUsd === null ? "?" : "$" + Math.round(row.mcUsd).toLocaleString("en-US")} liq=${row.liquidityUsd === null ? "?" : "$" + Math.round(row.liquidityUsd).toLocaleString("en-US")}`,
      );
    } catch (e) {
      row.error = "replay error: " + (e instanceof Error ? e.message : String(e));
      console.log(`${mint.slice(0, 10)} ${row.outcome.padEnd(7)} ${row.error}`);
    }
    await sleep(SLEEP_MS);
  }
  // Summary: medians per outcome class, over measured rows only.
  const byOutcome = new Map<string, OperatorRow[]>();
  for (const r of rows) {
    if (r.operatorCount === null) continue;
    const arr = byOutcome.get(r.outcome) ?? [];
    arr.push(r);
    byOutcome.set(r.outcome, arr);
  }
  const median = (xs: (number | null)[]): number | null => {
    const v = xs.filter((x): x is number => typeof x === "number").sort((a, b) => a - b);
    return v.length === 0 ? null : v[Math.floor(v.length / 2)];
  };
  console.log("--- medians (measured rows only) ---");
  for (const [outcome, arr] of [...byOutcome.entries()].sort()) {
    console.log(
      `${outcome}: n=${arr.length} largestFloat=${median(arr.map((r) => r.largestOperatorPctFloat))?.toFixed(1) ?? "?"}% ` +
        `top3Float=${median(arr.map((r) => r.top3OperatorPctFloat))?.toFixed(1) ?? "?"}% ` +
        `sellTop3=${median(arr.map((r) => r.sellImpactTop3Pct))?.toFixed(1) ?? "?"}% ` +
        `ops=${median(arr.map((r) => r.operatorCount)) ?? "?"}`,
    );
  }
  if (outPath) {
    writeFileSync(outPath, JSON.stringify(rows, null, 2) + "\n", "utf8");
    console.log(`rows written to ${outPath}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
