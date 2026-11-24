#!/usr/bin/env python3
"""Smart-list validator (v2.24 steal #1, from the memecoin-tools review).

Paper-only research: validate the FomoAPI smart-money wallet list
against real on-chain trade history. For each sampled wallet, read its
recent Helius Enhanced Transactions, keep only Pump.fun activity, and
compute per-mint realized PnL, win rate and delay-to-first-sell.

Patterns only from haccer/pumpfun-research (batch Helius enhanced txs,
classify BUY/SELL flows, per-mint PnL). No code was cloned, copied or
fetched from that repo or any repo — this file is our own code.

Method, with its limits stated plainly:
- Pump.fun activity = an enhanced tx whose instructions mention the
  Pump.fun program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P, or
  whose Helius `source` is PUMP_FUN. The program call is often an
  INNER instruction (a Jupiter/OKX router calls the bonding curve
  via CPI), so detection recurses into innerInstructions.
- Buy = wallet receives tokens of a mint AND sends SOL in the same tx.
  Sell = wallet sends tokens of a mint AND receives SOL. SOL includes
  wrapped SOL (wSOL token transfers), which is how router-mediated
  trades pay. The wallet must be the actor: Helius returns txs where
  the wallet is merely mentioned (a token recipient in someone
  else's tx, a bystander in a creation bundle) — those create no
  entry at all.
- Realized PnL per mint (SOL) = SOL received from sells - cost of the
  tokens sold, where cost = (tokens sold / tokens bought) * SOL spent
  on buys (average cost basis, in-window only). A mint with sells but
  no in-window buys has unknown cost: its proceeds are reported but
  excluded from realized PnL, and the mint is flagged `unmatchedSells`.
- Delay-to-first-sell = minutes from the wallet's first in-window buy
  of a mint to its first in-window sell, only when the buy precedes
  the sell. A sell before any in-window buy means pre-window
  holdings — delay is undefined and the mint is flagged
  `soldBeforeFirstBuy`.
- Stablecoin legs (USDC/USDT/USD1, exact mints) are never positions:
  in a routed trade the stable leg moves in the same tx as the
  memecoin leg, and counting it invents phantom PnL.
- Win = realized PnL > 0 on a mint with sells; loss = < 0. Mints with
  buys but no sells are open positions, not wins or losses.
- SOL price comes from ONE keyless Jupiter lite-api price fetch for
  the whole run. If it fails, USD figures are null and SOL is the
  unit — the script says which.
- The window is the wallet's newest N txs (default 7 days / 500 txs,
  5 pages x 100), stopping early at the first tx older than the
  window. A wallet that trades rarely can therefore show fewer mints
  than its Fomo history claims — that is a window limit, not proof
  the Fomo numbers are wrong. The Fomo PnL is lifetime/board-window;
  the Helius PnL is this window. Compare them as a sanity check, not
  an audit. Window, tx cap, sample offset/size and the PumpSwap flag
  are CLI args (see --help); the defaults reproduce the v1 run
  exactly, and a widened run is one invocation, not a code change.
- PumpSwap (--include-pumpswap): a tx also counts if it touches the
  PumpSwap AMM program pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA
  (same inner-instruction recursion). But PumpSwap trades non-pump
  mints too (SOL/USDC pairs etc.), so with the flag on, only mints
  ending in `pump` count as Pump.fun-origin positions — the rest are
  counted as excluded non-pump flows, never positions. The flag is
  off by default so a plain run reproduces v1 semantics exactly.

Validated criteria (reported only — nothing is gated on this):
  >= 5 Pump.fun mints traded, realized PnL > 0, win rate >= 40%.

Auth: Helius key via the registered custom.helius connection,
surrogate only, sent as ?api-key=. No key is ever read from a file,
env var or chat, and no secret is printed. Rate discipline: ~0.3s
between calls (~3 req/s vs the ~10 req/s free tier), 429 -> sleep
10s and retry once, then record the wallet as partial and move on.
Total budget <= 150 Helius calls for the run.
"""
import argparse
import json
import statistics
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import read_json_response, url_with_surrogate_query_param

ALLOWED = ["mainnet.helius-rpc.com", "api.helius.xyz", "api-mainnet.helius-rpc.com"]
REST_URL = "https://api.helius.xyz/v0"
PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
# PumpSwap AMM program (verified from Helius docs + Chainstack +
# Solscan, 2026-11-24). Only used with --include-pumpswap.
PUMPSWAP_PROGRAM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"
SOL_MINT = "So11111111111111111111111111111111111111112"
# Stablecoins are never positions: in a routed (Jupiter/OKX) trade
# the stable leg moves in the same tx as the memecoin leg, and
# counting it as a buy/sell invents phantom PnL (verified live
# 2026-11-24: a USDC leg read as +109 SOL "profit"). Exact mints.
STABLE_MINTS = {
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",  # USDC
    "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",  # USDT
    "USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB",  # USD1
}
JUP_PRICE_URL = "https://lite-api.jup.ag/price/v3?ids=" + SOL_MINT

FEED_PATH = "/home/hatch/workspace/goals/solana-memecoin-flipping-system/hidden_files/fomo-feed.json"
OUT_PATH = "/home/hatch/workspace/goals/solana-memecoin-flipping-system/hidden_files/smart-list-validation-20261124.json"

MAX_PAGES = 5          # 5 x 100 = 500 txs per wallet
PAGE_LIMIT = 100       # Helius caps limit at 100 (verified 2026-11-24)
WINDOW_DAYS = 7
SLEEP_S = 0.3          # ~3 req/s, well under the ~10 req/s free tier
MAX_CALLS = 150        # total Helius call budget for the run
SAMPLE_SIZE = 25

MIN_MINTS = 5
MIN_WIN_RATE = 0.40


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        raise RuntimeError("redirect refused, verify the endpoint")


class CallBudget:
    def __init__(self, max_calls):
        self.n = 0
        self.max = max_calls

    def spent(self):
        self.n += 1

    def left(self):
        return self.max - self.n


def fetch_page(wallet, before, budget):
    """One Helius Enhanced Transactions page. 429 -> sleep 10s, retry
    once, then raise so the caller can record a partial result."""
    q = f"?limit={PAGE_LIMIT}" + (f"&before={before}" if before else "")
    url = url_with_surrogate_query_param(
        f"{REST_URL}/addresses/{wallet}/transactions{q}",
        "custom.helius",
        allowed_hosts=ALLOWED,
    )
    request = urllib.request.Request(url, headers={"Accept": "application/json"})
    for attempt in (1, 2):
        budget.spent()
        try:
            with urllib.request.build_opener(NoRedirect()).open(request, timeout=30) as response:
                return read_json_response(response)
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt == 1:
                time.sleep(10)
                continue
            raise
    raise RuntimeError("unreachable")


def fetch_wallet_txs(wallet, budget, window_days=WINDOW_DAYS, max_pages=MAX_PAGES):
    """Newest-first pages until max_pages, the window cutoff, or a short
    page. Returns (txs, note). A failed page after some were fetched
    keeps what we have and notes it as partial; a failed first page
    raises. The note distinguishes full window coverage ("N-day
    cutoff reached", or None when the wallet simply has no more txs)
    from truncation ("tx cap reached", "call budget exhausted")."""
    cutoff = time.time() - window_days * 86400
    txs = []
    before = None
    note = None
    for _ in range(max_pages):
        if budget.left() <= 0:
            note = "call budget exhausted"
            break
        try:
            page = fetch_page(wallet, before, budget)
        except Exception as e:
            note = f"fetch failed after {len(txs)} txs: {e}"
            break
        if not page:
            break
        txs.extend(page)
        oldest = min((tx.get("timestamp") or 0) for tx in page)
        if oldest and oldest < cutoff:
            note = f"{window_days}-day cutoff reached"
            break
        if len(page) < PAGE_LIMIT:
            break
        before = page[-1].get("signature")
        if not before:
            break
        time.sleep(SLEEP_S)
    if note is None and len(txs) >= max_pages * PAGE_LIMIT:
        # All pages came back full and the cutoff never hit: the
        # window is truncated at the tx cap, not fully covered.
        note = f"tx cap reached ({max_pages * PAGE_LIMIT} txs), window truncated"
    return txs, note


def touches_pumpswap(tx):
    """True when the tx touches the PumpSwap AMM program, same
    inner-instruction recursion as is_pumpfun. The Helius `source`
    label is a bonus; the program id is the authority."""
    if tx.get("source") == "PUMPSWAP":
        return True
    stack = list(tx.get("instructions") or [])
    while stack:
        ins = stack.pop()
        if ins.get("programId") == PUMPSWAP_PROGRAM:
            return True
        stack.extend(ins.get("innerInstructions") or [])
    return False


def is_pumpfun(tx, include_pumpswap=False):
    """True when the tx touches the Pump.fun program, or (with the
    flag) the PumpSwap program. The program call is often an INNER
    instruction (a Jupiter/OKX router calls the bonding curve via
    CPI), so this recurses into innerInstructions — a top-level-only
    check misses every router-mediated Pump.fun trade."""
    if tx.get("source") == "PUMP_FUN":
        return True
    stack = list(tx.get("instructions") or [])
    while stack:
        ins = stack.pop()
        if ins.get("programId") == PUMP_PROGRAM:
            return True
        if include_pumpswap and ins.get("programId") == PUMPSWAP_PROGRAM:
            return True
        stack.extend(ins.get("innerInstructions") or [])
    return False


def classify_wallet(wallet, txs, cutoff_ts=0, include_pumpswap=False):
    """Per-mint buy/sell aggregation from tokenTransfers +
    nativeTransfers. One (tx, mint) pair = one trade event. Txs
    older than cutoff_ts (the window edge — a straddling page can
    carry a few) are dropped, and the drop is counted. Returns
    (per_mint, pumpfun_txs, dropped_old, pumpswap_txs,
    nonpump_excluded). With --include-pumpswap, only mints ending in
    `pump` count as positions; other mints' flows are counted as
    excluded, never positions (PumpSwap trades SOL/USDC pairs too)."""
    per_mint = {}
    pumpfun_txs = 0
    pumpswap_txs = 0
    nonpump_excluded = 0
    dropped_old = 0
    for tx in txs:
        ts = tx.get("timestamp") or 0
        if cutoff_ts and ts and ts < cutoff_ts:
            dropped_old += 1
            continue
        if not is_pumpfun(tx, include_pumpswap):
            continue
        pumpfun_txs += 1
        if touches_pumpswap(tx):
            pumpswap_txs += 1
        sol_out = 0.0
        sol_in = 0.0
        for nt in tx.get("nativeTransfers") or []:
            amt = (nt.get("amount") or 0) / 1e9
            if nt.get("fromUserAccount") == wallet:
                sol_out += amt
            elif nt.get("toUserAccount") == wallet:
                sol_in += amt
        # Token flows for this tx, grouped by mint. Wrapped SOL
        # (mint So111...) is SOL: router-mediated trades pay in
        # wSOL instead of native SOL, so wSOL flows count toward
        # the SOL side, not as a token mint.
        flows = {}
        excluded_this_tx = set()
        for tt in tx.get("tokenTransfers") or []:
            mint = tt.get("mint")
            if not mint:
                continue
            try:
                amt = float(tt.get("tokenAmount") or 0)
            except (TypeError, ValueError):
                continue
            if mint == SOL_MINT:
                if tt.get("fromUserAccount") == wallet:
                    sol_out += amt
                elif tt.get("toUserAccount") == wallet:
                    sol_in += amt
                continue
            if mint in STABLE_MINTS:
                # Stable leg of a routed trade, never a position.
                continue
            if include_pumpswap and not mint.endswith("pump"):
                # PumpSwap trades non-pump mints too (SOL/USDC
                # pairs): never a memecoin position. Counted once
                # per (tx, mint) so the report can say whether the
                # filter mattered.
                excluded_this_tx.add(mint)
                continue
            f = flows.setdefault(mint, {"in": 0.0, "out": 0.0})
            if tt.get("toUserAccount") == wallet:
                f["in"] += amt
            elif tt.get("fromUserAccount") == wallet:
                f["out"] += amt
        nonpump_excluded += len(excluded_this_tx)
        for mint, f in flows.items():
            # The wallet must be the actor: a buy spends SOL and
            # receives tokens, a sell is the reverse. Helius returns
            # txs where the wallet is merely mentioned (a token
            # recipient in someone else's tx, a bystander in a
            # creation bundle) — those create no entry at all.
            # A buy spends SOL and receives tokens; a sell is the
            # reverse. Split the tx's SOL flow across its mints by
            # token-flow direction (a tx normally touches one mint).
            if f["in"] > 0 and sol_out > 0:
                m = per_mint.setdefault(mint, {
                    "mint": mint, "buys": 0, "sells": 0,
                    "solSpent": 0.0, "solReceived": 0.0,
                    "tokensBought": 0.0, "tokensSold": 0.0,
                    "firstBuyTs": None, "firstSellTs": None,
                })
                m["buys"] += 1
                m["tokensBought"] += f["in"]
                m["solSpent"] += sol_out
                if m["firstBuyTs"] is None or ts < m["firstBuyTs"]:
                    m["firstBuyTs"] = ts
            if f["out"] > 0 and sol_in > 0:
                m = per_mint.setdefault(mint, {
                    "mint": mint, "buys": 0, "sells": 0,
                    "solSpent": 0.0, "solReceived": 0.0,
                    "tokensBought": 0.0, "tokensSold": 0.0,
                    "firstBuyTs": None, "firstSellTs": None,
                })
                m["sells"] += 1
                m["tokensSold"] += f["out"]
                m["solReceived"] += sol_in
                if m["firstSellTs"] is None or ts < m["firstSellTs"]:
                    m["firstSellTs"] = ts

    for m in per_mint.values():
        bought, sold = m["tokensBought"], m["tokensSold"]
        if m["sells"] > 0 and bought > 0:
            cost = min(sold, bought) / bought * m["solSpent"]
            m["realizedPnlSol"] = round(m["solReceived"] - cost, 6)
            m["costBasisKnown"] = True
        elif m["sells"] > 0:
            m["realizedPnlSol"] = None  # proceeds known, cost unknown
            m["costBasisKnown"] = False
        else:
            m["realizedPnlSol"] = None
            m["costBasisKnown"] = True  # open position, nothing realized
        m["unmatchedSells"] = m["sells"] > 0 and bought == 0
        m["partialCostBasis"] = m["sells"] > 0 and sold > bought
        m["soldBeforeFirstBuy"] = bool(
            m["firstBuyTs"] and m["firstSellTs"] and m["firstSellTs"] < m["firstBuyTs"])
        if m["firstBuyTs"] and m["firstSellTs"] and m["firstSellTs"] >= m["firstBuyTs"]:
            m["delayMin"] = round((m["firstSellTs"] - m["firstBuyTs"]) / 60, 1)
        else:
            # No buy-then-sell pair in-window: either still holding,
            # or the sell is of pre-window holdings (delay undefined).
            m["delayMin"] = None
        m["outcome"] = (
            "win" if m["realizedPnlSol"] is not None and m["realizedPnlSol"] > 0
            else "loss" if m["realizedPnlSol"] is not None and m["realizedPnlSol"] < 0
            else "open" if m["sells"] == 0
            else "unmatched"
        )
    return per_mint, pumpfun_txs, dropped_old, pumpswap_txs, nonpump_excluded


def summarize_wallet(handle, wallet, fomo, per_mint, pumpfun_txs, sol_price):
    closed = [m for m in per_mint.values() if m["outcome"] in ("win", "loss")]
    wins = sum(1 for m in closed if m["outcome"] == "win")
    losses = len(closed) - wins
    realized = round(sum(m["realizedPnlSol"] for m in per_mint.values()
                         if m["realizedPnlSol"] is not None), 6)
    delays = [m["delayMin"] for m in per_mint.values() if m["delayMin"] is not None]
    win_rate = round(wins / len(closed), 3) if closed else None
    mints = len(per_mint)
    validated = (
        mints >= MIN_MINTS and realized > 0 and win_rate is not None
        and win_rate >= MIN_WIN_RATE
    )
    return {
        "handle": handle,
        "wallet": wallet,
        "fomoTrades": fomo.get("trades"),
        "fomoPnlUsd": fomo.get("pnlUsd"),
        "fomoWindow": fomo.get("window"),
        "status": "validated" if validated else "rejected",
        "mintsTraded": mints,
        "trades": sum(m["buys"] + m["sells"] for m in per_mint.values()),
        "pumpfunTxs": pumpfun_txs,
        "wins": wins,
        "losses": losses,
        "winRate": win_rate,
        "realizedPnlSol": realized,
        "realizedPnlUsd": round(realized * sol_price, 2) if sol_price else None,
        "medianDelayMin": round(statistics.median(delays), 1) if delays else None,
        "delaysMeasured": len(delays),
        "unmatchedSellMints": sum(1 for m in per_mint.values() if m["unmatchedSells"]),
        "perMint": sorted(per_mint.values(), key=lambda m: (m["realizedPnlSol"] is None, -(m["realizedPnlSol"] or 0))),
    }


def fetch_sol_price_usd():
    """One keyless Jupiter lite-api price fetch for the whole run.
    Returns the SOL price in USD, or None (then USD is not reported)."""
    try:
        req = urllib.request.Request(JUP_PRICE_URL, headers={"Accept": "application/json"})
        with urllib.request.build_opener(NoRedirect()).open(req, timeout=20) as r:
            data = json.loads(r.read().decode())
        # lite-api returns a flat {mint: {usdPrice}} map; the keyed
        # price-v3 variant nests it under data[ mint ].price.
        entry = data.get(SOL_MINT) or (data.get("data") or {}).get(SOL_MINT) or {}
        price = entry.get("usdPrice") or entry.get("price")
        return float(price) if price else None
    except Exception as e:
        print(f"SOL price fetch failed ({e}); reporting SOL only", file=sys.stderr)
        return None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--sample", type=int, default=SAMPLE_SIZE,
                        help="wallets in the sample (default 25)")
    parser.add_argument("--offset", type=int, default=0,
                        help="skip this many wallets by pnlUsd rank first (default 0)")
    parser.add_argument("--window-days", type=int, default=WINDOW_DAYS,
                        help="history window in days (default 7)")
    parser.add_argument("--max-txs", type=int, default=MAX_PAGES * PAGE_LIMIT,
                        help="max txs fetched per wallet (default 500)")
    parser.add_argument("--max-calls", type=int, default=MAX_CALLS,
                        help="total Helius call budget for the run (default 150)")
    parser.add_argument("--include-pumpswap", action="store_true",
                        help="also count PumpSwap AMM txs; only mints ending in 'pump' count as positions")
    parser.add_argument("--out", default=OUT_PATH)
    args = parser.parse_args()
    max_pages = max(1, -(-args.max_txs // PAGE_LIMIT))

    with open(FEED_PATH) as f:
        feed = json.load(f)
    ranked = sorted(feed.get("smartMoneyWallets", []),
                    key=lambda w: w.get("pnlUsd", 0), reverse=True)
    wallets = ranked[args.offset:args.offset + args.sample]
    sample_by = ("top pnlUsd from smartMoneyWallets" if args.offset == 0
                 else f"pnlUsd ranks {args.offset + 1}-{args.offset + len(wallets)} from smartMoneyWallets")

    sol_price = fetch_sol_price_usd()
    budget = CallBudget(args.max_calls)
    results = []
    for w in wallets:
        wallet, handle = w.get("wallet"), w.get("handle")
        if budget.left() <= 0:
            results.append({"handle": handle, "wallet": wallet,
                            "fomoTrades": w.get("trades"), "fomoPnlUsd": w.get("pnlUsd"),
                            "fomoWindow": w.get("window"), "status": "not_attempted",
                            "note": "call budget exhausted"})
            continue
        try:
            txs, note = fetch_wallet_txs(wallet, budget, args.window_days, max_pages)
        except Exception as e:
            results.append({"handle": handle, "wallet": wallet,
                            "fomoTrades": w.get("trades"), "fomoPnlUsd": w.get("pnlUsd"),
                            "fomoWindow": w.get("window"), "status": "error",
                            "note": f"first-page fetch failed: {e}"})
            continue
        per_mint, pumpfun_txs, dropped_old, pumpswap_txs, nonpump_excluded = classify_wallet(
            wallet, txs, cutoff_ts=time.time() - args.window_days * 86400,
            include_pumpswap=args.include_pumpswap)
        if pumpfun_txs == 0:
            results.append({"handle": handle, "wallet": wallet,
                            "fomoTrades": w.get("trades"), "fomoPnlUsd": w.get("pnlUsd"),
                            "fomoWindow": w.get("window"), "status": "no_pumpfun_activity",
                            "txsFetched": len(txs), "pumpfunTxs": 0, "mintsTraded": 0,
                            "pumpswapTxsTouched": pumpswap_txs,
                            "nonPumpMintsExcluded": nonpump_excluded,
                            "droppedOutsideWindow": dropped_old,
                            "note": note or "no Pump.fun txs in window"})
            continue
        row = summarize_wallet(handle, wallet, w, per_mint, pumpfun_txs, sol_price)
        row["txsFetched"] = len(txs)
        row["pumpswapTxsTouched"] = pumpswap_txs
        row["nonPumpMintsExcluded"] = nonpump_excluded
        row["droppedOutsideWindow"] = dropped_old
        if note:
            row["note"] = note
        results.append(row)

    validated = [r for r in results if r["status"] == "validated"]

    def _truncated(r):
        n = r.get("note") or ""
        return ("tx cap reached" in n or "budget exhausted" in n
                or "fetch failed" in n)

    out = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "feedAsOf": feed.get("asOf"),
        "feedWalletsTotal": len(feed.get("smartMoneyWallets", [])),
        "sampleSize": len(results),
        "sampleOffset": args.offset,
        "sampleBy": sample_by,
        "windowDays": args.window_days,
        "maxTxsPerWallet": args.max_txs,
        "includePumpswap": args.include_pumpswap,
        "solPriceUsd": sol_price,
        "solPriceSource": "Jupiter lite-api price v3 (one fetch)" if sol_price else "fetch failed, SOL only",
        "heliusCallsMade": budget.n,
        "criteria": {"minMints": MIN_MINTS, "realizedPnlSolGt": 0, "minWinRate": MIN_WIN_RATE},
        "summary": {
            "validated": len(validated),
            "rejected": sum(1 for r in results if r["status"] == "rejected"),
            "noPumpfunActivity": sum(1 for r in results if r["status"] == "no_pumpfun_activity"),
            "partialOrError": sum(1 for r in results if r["status"] in ("error", "not_attempted")),
            "fullWindowCoverage": sum(1 for r in results if not _truncated(r)),
            "truncatedWindow": sum(1 for r in results if _truncated(r)),
            "pumpswapTxsTouched": sum(r.get("pumpswapTxsTouched", 0) for r in results),
            "nonPumpMintsExcluded": sum(r.get("nonPumpMintsExcluded", 0) for r in results),
        },
        "validatedHandles": [r["handle"] for r in validated],
        "wallets": results,
    }
    with open(args.out, "w") as f:
        json.dump(out, f, indent=2)

    s = out["summary"]
    print(f"sample {len(results)} wallets, Helius calls {budget.n}, SOL ${sol_price}" if sol_price else f"sample {len(results)} wallets, Helius calls {budget.n}, SOL price unavailable")
    print(f"validated {s['validated']}/{len(results)} | rejected {s['rejected']} | no Pump.fun activity {s['noPumpfunActivity']} | partial/error {s['partialOrError']}")
    print(f"full window coverage {s['fullWindowCoverage']}/{len(results)} | truncated {s['truncatedWindow']} | PumpSwap txs touched {s['pumpswapTxsTouched']} | non-pump mints excluded {s['nonPumpMintsExcluded']}")
    print(f"feed asOf {feed.get('asOf')}, output {args.out}")
    ranked = sorted([r for r in results if r.get("realizedPnlSol") is not None],
                    key=lambda r: r["realizedPnlSol"], reverse=True)
    print("top validated:")
    for r in [x for x in ranked if x["status"] == "validated"][:3]:
        print(f"  {r['handle']}: realized {r['realizedPnlSol']} SOL"
              + (f" (${r['realizedPnlUsd']})" if r.get("realizedPnlUsd") is not None else "")
              + f", mints {r['mintsTraded']}, WR {r['winRate']}, median delay {r['medianDelayMin']} min, Fomo PnL ${r['fomoPnlUsd']}")
    print("top rejected (by realized PnL):")
    for r in [x for x in ranked if x["status"] == "rejected"][:3]:
        print(f"  {r['handle']}: realized {r['realizedPnlSol']} SOL, mints {r['mintsTraded']}, "
              f"WR {r['winRate']}, Fomo PnL ${r['fomoPnlUsd']}")


if __name__ == "__main__":
    main()
