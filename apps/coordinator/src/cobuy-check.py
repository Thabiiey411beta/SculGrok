#!/usr/bin/env python3
"""Co-buy wallet clustering check for the Solana memecoin desk (v2.15,
million-inspired: "wallets that keep entering the same tokens together
are merged into one owner").

For a candidate mint, read its Helius Enhanced Transactions up to
--before-ts (entry time) and group token ACQUISITIONS by slot: a mint
transfer TO a wallet FROM the bonding curve / a router is a buy. A
slot in which several distinct wallets acquire the token together is
a coordinated buy — the signature of a bundle / same-slot group
buying in before the desk does.

Rules (analysis lives in packages/signals/src/cobuy.ts; this script
is a thin fetcher + grouper):
- Acquisitions only: sender must be the bonding curve (passed with
  --curve) or a router: a counterparty appearing in >= 20% of
  transfers AND at least 3 times (Jupiter aggregator, Pump AMM,
  Raydium pool). There is NO top-3 cap on routers. A sell's receiver
  IS the curve/router, so counting every transfer would make the
  curve the top "acquirer".
- Same-slot groups: distinct acquirers per slot, with amounts.
  Transactions with no slot are SKIPPED (counted as slotMissing) —
  grouping them under one null slot would report unrelated buys as
  a single coordinated group.
- Top-holder co-buy: when --holders is given, report whether >=2 of
  the top holders acquired in the same slot (or within +-1 slot).
- Transactions with no timestamp are dropped from the pre-entry
  window (counted as timestampMissing) — a timestamp-less tx cannot
  be placed before entry time.

Auth: Helius key via the registered custom.helius connection,
surrogate only, sent as ?api-key=. No key is ever read from a file,
env var, or chat, and no secret is printed. Read-only: no signing,
no transactions.
"""
import argparse
import json
import os
import sys
import urllib.request
from collections import Counter, defaultdict

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import read_json_response, url_with_surrogate_query_param

ALLOWED = ["mainnet.helius-rpc.com", "api.helius.xyz", "api-mainnet.helius-rpc.com"]
REST_URL = "https://api.helius.xyz/v0"
MAX_PAGES = 60
PAGE_LIMIT = 100


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        raise RuntimeError("redirect refused, verify the endpoint")


def fetch_txs(address, limit, before=None):
    url = url_with_surrogate_query_param(
        f"{REST_URL}/addresses/{address}/transactions?limit={limit}" + (f"&before={before}" if before else ""),
        "custom.helius",
        allowed_hosts=ALLOWED,
    )
    request = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.build_opener(NoRedirect()).open(request, timeout=30) as response:
        return read_json_response(response)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mint", required=True)
    parser.add_argument("--before-ts", type=int, default=0, help="epoch seconds; only txs at or before this are analysed (0 = now)")
    parser.add_argument("--curve", default="", help="bonding curve address (sender of curve buys)")
    parser.add_argument("--holders", default="[]", help="JSON list of {owner, pct} top holders to test for same-slot co-buy")
    parser.add_argument("--max-pages", type=int, default=MAX_PAGES)
    parser.add_argument("--raw-out", default="", help="optional path to write raw acquisition events as JSON")
    args = parser.parse_args()

    import time
    before_ts = args.before_ts or int(time.time())
    holders = json.loads(args.holders)
    top_owners = [h["owner"] for h in holders if h.get("owner")]

    # Validate --raw-out before burning Helius calls: reject path
    # traversal and require the parent directory to exist.
    if args.raw_out:
        if ".." in args.raw_out.replace("\\", "/").split("/"):
            print(json.dumps({"error": "--raw-out must not contain .."}), file=sys.stderr)
            sys.exit(2)
        parent = os.path.dirname(os.path.abspath(args.raw_out))
        if not os.path.isdir(parent):
            print(json.dumps({"error": f"--raw-out parent dir does not exist: {parent}"}), file=sys.stderr)
            sys.exit(2)

    txs = []
    before = None
    reached = False
    pages = 0
    try:
        while pages < args.max_pages:
            batch = fetch_txs(args.mint, PAGE_LIMIT, before)
            pages += 1
            if not batch:
                break
            txs.extend(batch)
            before = batch[-1].get("signature")
            oldest = min((x.get("timestamp", 10**12) for x in batch), default=10**12)
            if oldest <= before_ts:
                reached = True
                break
            if len(batch) < PAGE_LIMIT:
                break
    except Exception as e:
        print(json.dumps({"error": f"Helius fetch failed: {e}"}), file=sys.stderr)
        sys.exit(2)

    pre = [x for x in txs if x.get("timestamp", 10**12) <= before_ts]
    # Timestamp-less txs are dropped from the window above (they get
    # the 10**12 default, which is after any entry time) — count them
    # instead of silently losing them.
    timestamp_missing = sum(1 for x in txs if not isinstance(x.get("timestamp"), (int, float)))
    # Routers: the curve / aggregators / pools are the counterparties
    # that appear in a LARGE share of transfers. The most frequent
    # counterparty alone is not enough: with few transfers, the 2nd/3rd
    # most frequent are ordinary buyers (DEQD2q8y: the curve appeared
    # 7/7 times, the next two appeared once each — treating them as
    # routers dropped real buys). So a router must appear in >= 20% of
    # transfers AND at least 3 times.
    cp = Counter()
    n_transfers = 0
    for x in pre:
        for tt in (x.get("tokenTransfers") or []):
            if tt.get("mint") != args.mint:
                continue
            n_transfers += 1
            if tt.get("fromUserAccount"):
                cp[tt["fromUserAccount"]] += 1
            if tt.get("toUserAccount"):
                cp[tt["toUserAccount"]] += 1
    routers = {a for a, c in cp.items() if c >= 3 and c >= 0.2 * n_transfers}
    if args.curve:
        routers.add(args.curve)

    # Acquisitions: mint transfer FROM a router/curve TO a regular wallet.
    acq_by_slot = defaultdict(lambda: {"acquirers": set(), "amount": 0.0})
    acq_amt = defaultdict(float)
    raw_events = []
    slot_missing = 0
    for x in pre:
        for tt in (x.get("tokenTransfers") or []):
            if tt.get("mint") != args.mint:
                continue
            frm, to = tt.get("fromUserAccount"), tt.get("toUserAccount")
            if not frm or not to or frm == to:
                continue
            if frm in routers and to not in routers:
                # A slot-less acquisition cannot be grouped: skip it
                # (counted) instead of landing it in a null slot
                # alongside unrelated buys.
                slot = x.get("slot")
                if slot is None:
                    slot_missing += 1
                    continue
                amt = float(tt.get("tokenAmount") or 0)
                acq_by_slot[slot]["acquirers"].add(to)
                acq_by_slot[slot]["amount"] += amt
                acq_amt[to] += amt
                raw_events.append({"slot": slot, "ts": x.get("timestamp"), "buyer": to, "amount": amt})
    if args.raw_out:
        with open(args.raw_out, "w") as f:
            json.dump({"mint": args.mint, "beforeTs": before_ts, "events": raw_events}, f)

    slot_groups = [
        {"slot": s, "acquirers": sorted(v["acquirers"]), "amount": round(v["amount"], 2)}
        for s, v in sorted(acq_by_slot.items(), key=lambda kv: -len(kv[1]["acquirers"]))
    ]
    top_slot = slot_groups[0] if slot_groups else None
    total_acq = sum(acq_amt.values())
    top_share = (max(acq_amt.values()) / total_acq) if total_acq > 0 else 0.0

    # Top-holder co-buy: do >=2 of the given top holders acquire in
    # the same slot (or within +-1 slot)? Report the pairs.
    top_holder_cobuy = None
    if top_owners:
        holder_slots = defaultdict(set)
        for ev in raw_events:
            if ev["buyer"] in set(top_owners):
                holder_slots[ev["buyer"]].add(ev["slot"])
        pairs = []
        owners = list(holder_slots.keys())
        for i in range(len(owners)):
            for j in range(i + 1, len(owners)):
                shared = holder_slots[owners[i]] & holder_slots[owners[j]]
                near = set()
                for s1 in holder_slots[owners[i]]:
                    for s2 in holder_slots[owners[j]]:
                        if abs(s1 - s2) <= 1:
                            near.add((s1, s2))
                if shared or near:
                    pairs.append({"a": owners[i], "b": owners[j], "sameSlot": sorted(shared)[:5], "nearSlot": sorted(near)[:5]})
        max_shared = 0
        slot_to_holders = defaultdict(set)
        for o, slots in holder_slots.items():
            for s in slots:
                slot_to_holders[s].add(o)
        if slot_to_holders:
            max_shared = max(len(v) for v in slot_to_holders.values())
        top_holder_cobuy = {"pairs": pairs, "maxTopHoldersInSlot": max_shared}

    out = {
        "mint": args.mint,
        "txsAnalyzed": len(pre),
        "fetched": len(txs),
        "pages": pages,
        "reachedBefore": reached,
        "windowStartTs": min((x.get("timestamp", 0) for x in pre), default=None),
        "windowEndTs": before_ts,
        "slotMissing": slot_missing,
        "timestampMissing": timestamp_missing,
        "distinctAcquirers": len(acq_amt),
        "totalAcquisitions": sum(len(v["acquirers"]) for v in acq_by_slot.values()),
        "totalAmount": round(total_acq, 2),
        "maxAcquirersInSlot": len(top_slot["acquirers"]) if top_slot else 0,
        "topSlot": top_slot,
        "topAcquirerShare": round(top_share, 4),
        "slotGroups": slot_groups[:10],
        "topHolderCoBuy": top_holder_cobuy,
    }
    print(json.dumps(out, indent=2))


if __name__ == "__main__":
    main()
