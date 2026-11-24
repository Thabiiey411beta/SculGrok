#!/usr/bin/env python3
"""Helius funder-cluster check for the Solana memecoin desk.

Free Bubblemaps replacement, built on data we already pay for with
Helius (connected, free tier). For each top holder wallet, read its
recent Enhanced Transactions and find who first funded it with SOL.
Wallets linked by a transfer, or funded by the same wallet, are
probably one owner, the same signal Bubblemaps draws as a cluster.

Rules, all fail-closed:
- Any funder that funded >=2 top holders with combined >=8% of supply,
  or >=3 top holders regardless of supply, is a cluster -> BLOCK.
- A top holder funded by the token creator is a cluster -> BLOCK.
- A direct token transfer of this mint between two top holders is a
  cluster -> BLOCK.
- If the Helius call fails for a holder, that holder is unknown, not
  clean. If the whole check fails, exit non-zero and the caller blocks.
- An empty holder list is an error (exit 2), not "clean": there is
  nothing to check, so no verdict can be reached.
- The output carries an explicit "verdict": "clustered" | "clean" |
  "unknown" (unknown when unknown > 0 and not clustered — the caller
  must block on unknown).

Measured bundle share (v2.19, SOUL-audit wiring): the output also
carries "linkedPct" — the % of TOTAL supply held by the union of
funder-linked top holders (shared first funder, creator-funded, or
direct-transfer linked, both endpoints). That is the rug check's
bundlePct: a measured value, not a threshold verdict. It is a LOWER
bound when unknown > 0 (an unknown holder may also be linked), and
it inherits the cluster heuristic's limits (first funder in a
25-tx window; a pool paying a seller SOL can look like a funder).

Measured dev-sold share (v2.19): the output also carries "devSold"
from the creator's own Helius transactions (limit 100, newest
first). Formula: devSoldPct = swap-sold / acquired, where acquired
is every inflow of this mint to the creator and swap-sold is every
SWAP-type outflow (a sale). TRANSFER outflows are reported as
"moved", not sold — a transfer is not a sale (the cluster gate
separately catches creator-funded top holders). Limits, all
documented: (a) the creator-tx window pages with the Helius
`before` cursor up to 1000 txs (v2.23, one page caps at 100), so
only creators busier than 1000 txs since creation still read as
unknown — and they still block; (b) sold > acquired clamps to 1.0
with a window-incomplete note; (c) a creator selling from a second
wallet is invisible here; (d) Rugcheck creatorBalance is NOT used
as the denominator — it is systematically 0 for pump.fun tokens
(verified live 2026-11-23: Pikachu/Betty/KYC all report 0 while
OKX shows devHold 1.6% for Pikachu and the creator's own txs show
16.6M tokens acquired), so it cannot measure anything. Validated
live: Pikachu creator acquired 16,568,419, swap-sold 0, moved
500,000 -> pct 0.0 (the -40.5% loss was not a dev swap-dump);
KYC/Betty creators return 100 txs with no mint transfers -> pct
null (window missed the Nov-22 creation); 2026-11-24 a gem-71
candidate's creator needed 572 txs to reach creation (pct 0.0),
which the old single-page window missed entirely.

Cut-offs (8% / >=3 holders / 20% pool-ignore) are PROVISIONAL,
validated on n=2 tokens only (Kill Your Customer clustered and lost
-45%; Betty not clustered and was the one v2 win) — not a measured
calibration.

Auth: Helius key via the registered custom.helius connection, surrogate
only, sent as ?api-key=. No key is ever read from a file, env var, or
chat, and no secret is printed.
"""
import argparse
import json
import sys
import urllib.request

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import read_json_response, url_with_surrogate_query_param

ALLOWED = ["mainnet.helius-rpc.com", "api.helius.xyz", "api-mainnet.helius-rpc.com"]
REST_URL = "https://api.helius.xyz/v0"
MIN_FUND_LAMPORTS = 5_000_000  # 0.005 SOL, ignore dust / rent


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        raise RuntimeError("redirect refused, verify the endpoint")


def fetch_txs(address, limit, before=None):
    q = f"?limit={limit}" + (f"&before={before}" if before else "")
    url = url_with_surrogate_query_param(
        f"{REST_URL}/addresses/{address}/transactions{q}",
        "custom.helius",
        allowed_hosts=ALLOWED,
    )
    request = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.build_opener(NoRedirect()).open(request, timeout=30) as response:
        return read_json_response(response)


def fetch_creator_txs(address, mint, max_pages=10):
    """Creator txs with cursor paging (v2.23).

    Helius caps one page at 100 txs, so a busy creator's creation tx
    can sit outside a single page (verified live 2026-11-24: a gem-71
    candidate's creator needed 572 txs to reach creation). Page with
    the `before` cursor (oldest signature of the previous page) up to
    max_pages (1000 txs), stopping early as soon as the creation tx
    is found or the sold share is measured — the common case stays at
    1-2 pages. A later page failing keeps the txs already fetched
    (no worse than today's single page); a first-page failure raises
    and the caller fails closed as before. Past max_pages with no
    creation, devSold stays unknown and blocks — paging measures
    more, it never invents a value. """
    all_txs = []
    before = None
    for _ in range(max_pages):
        try:
            page = fetch_txs(address, 100, before)
        except Exception:
            if all_txs:
                break
            raise
        if not page:
            break
        all_txs.extend(page)
        probe = analyse_dev(mint, address, all_txs)
        if probe["sawCreation"] or probe["pct"] is not None or probe["sold"] > 0:
            break
        if len(page) < 100:
            break
        before = page[-1].get("signature")
        if not before:
            break
    return all_txs


def analyse_holder(holder, mint, txs):
    """Return funders and token links for one holder wallet."""
    funders = []  # (from, amount, timestamp) newest first
    token_links = set()
    for tx in txs or []:
        ts = tx.get("timestamp") or 0
        for nt in tx.get("nativeTransfers", []) or []:
            if nt.get("toUserAccount") == holder and nt.get("fromUserAccount") != holder:
                amount = nt.get("amount", 0) or 0
                if amount >= MIN_FUND_LAMPORTS:
                    funders.append({"from": nt["fromUserAccount"], "amount": amount, "timestamp": ts})
        # Direct token transfers only, not swaps: a DEX pool sends tokens
        # to every buyer in a SWAP, so counting those would flag every
        # holder as linked to the pool. A TRANSFER is wallet to wallet.
        if tx.get("type") == "TRANSFER":
            for tt in tx.get("tokenTransfers", []) or []:
                if tt.get("mint") == mint and tt.get("toUserAccount") == holder:
                    token_links.add(tt.get("fromUserAccount"))
    # Funders are sorted newest-first EXPLICITLY (timestamp
    # descending) — the old code trusted the Helius page order and
    # took the last entry as the earliest funder without verifying
    # it. The last entry is the earliest in the window.
    funders.sort(key=lambda f: f["timestamp"], reverse=True)
    first_funder = funders[-1]["from"] if funders else None
    return {"firstFunder": first_funder, "funders": funders, "tokenLinks": sorted(token_links)}


def analyse_dev(mint, creator, txs):
    """Dev-sold share from the creator's own transactions.

    acquired = all inflows of this mint to the creator (UI units).
    sold = SWAP-type outflows only (a sale on the curve/pool).
    moved = TRANSFER/other outflows (not a sale; reported, not
    counted — the cluster gate separately catches creator-funded
    top holders). sawCreation = a CREATE tx carrying this mint to
    the creator was inside the fetched window, i.e. the window
    covers the launch and `acquired` is complete. pct is null when
    nothing was acquired in-window (cannot distinguish "never
    bought" from "bought before the window") — except sold > 0,
    which proves selling and reports 1.0. A corrupt amount makes
    the whole measurement unknown, never a guessed number. """
    acquired = 0.0
    sold = 0.0
    moved = 0.0
    saw_creation = False
    bad_amount = False
    for tx in txs or []:
        for tt in tx.get("tokenTransfers", []) or []:
            if tt.get("mint") != mint:
                continue
            try:
                amt = float(tt.get("tokenAmount") or 0)
            except (TypeError, ValueError):
                bad_amount = True
                continue
            if tt.get("toUserAccount") == creator:
                acquired += amt
                if tx.get("type") == "CREATE":
                    saw_creation = True
            elif tt.get("fromUserAccount") == creator:
                if tx.get("type") == "SWAP":
                    sold += amt
                else:
                    moved += amt
    if bad_amount:
        pct = None
        note = "unparseable transfer amount in creator txs, unknown"
    elif acquired > 0:
        pct = min(sold / acquired, 1.0)
        note = "window incomplete, sold exceeds observed acquired" if sold > acquired else ("creation seen in window" if saw_creation else "creation outside fetched window")
    elif sold > 0:
        pct = 1.0
        note = "sold with no acquisition in window, treated as fully sold"
    else:
        pct = None
        note = "no acquisition of this mint in creator tx window, unknown"
    return {"pct": pct, "acquired": acquired, "sold": sold, "moved": moved,
            "txsChecked": len(txs or []), "sawCreation": saw_creation, "note": note}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mint", required=True)
    parser.add_argument("--holders", required=True, help="JSON list of {owner, pct}")
    parser.add_argument("--creator", default="")
    parser.add_argument("--limit", default="25")
    args = parser.parse_args()

    try:
        holders = json.loads(args.holders)
    except Exception as e:
        print(json.dumps({"error": f"invalid --holders JSON: {e}"}), file=sys.stderr)
        sys.exit(2)
    # Validate the input at the CLI boundary: a list of {owner: str,
    # pct: number}. Bad input is an error (exit 2), not a clean bill.
    if not isinstance(holders, list):
        print(json.dumps({"error": "--holders must be a JSON list of {owner, pct}"}), file=sys.stderr)
        sys.exit(2)
    for h in holders:
        if not isinstance(h, dict) or not isinstance(h.get("owner"), str) or not h.get("owner"):
            print(json.dumps({"error": "--holders entries must have a non-empty string owner"}), file=sys.stderr)
            sys.exit(2)
        if "pct" in h and not isinstance(h["pct"], (int, float)):
            print(json.dumps({"error": "--holders pct must be a number"}), file=sys.stderr)
            sys.exit(2)
    owners = [h["owner"] for h in holders if h.get("owner")]
    if not owners:
        print(json.dumps({"error": "no holders to check (empty holder list)"}), file=sys.stderr)
        sys.exit(2)

    per_holder = []
    unknown = 0
    for h in holders:
        owner = h["owner"]
        try:
            txs = fetch_txs(owner, int(args.limit))
        except Exception as e:
            print(json.dumps({"error": f"Helius fetch failed for {owner}: {e}"}), file=sys.stderr)
            sys.exit(2)
        info = analyse_holder(owner, args.mint, txs)
        if info["firstFunder"] is None:
            unknown += 1
        per_holder.append({"owner": owner, "pct": h.get("pct", 0), **info})

    # Group holders by first funder. (An "any funder" grouping was
    # built here and never read — deleted; the creator-as-any-funder
    # check below is the one that matters.)
    from collections import defaultdict
    by_first = defaultdict(list)
    for ph in per_holder:
        if ph["firstFunder"]:
            by_first[ph["firstFunder"]].append(ph)

    shared = []
    clustered = False
    reasons = []
    for funder, group in by_first.items():
        uniq = {g["owner"] for g in group}
        if len(uniq) >= 2:
            pct = sum(g["pct"] for g in group)
            shared.append({"funder": funder, "holders": sorted(uniq), "pct": round(pct, 2), "count": len(uniq)})
            if pct >= 8 or len(uniq) >= 3:
                clustered = True
                reasons.append(f"shared first funder {funder[:8]}... funds {len(uniq)} top holders, {pct:.1f}% of supply")
    # Creator as any funder, not just first — this subsumes the old
    # first-funder creator branch (a creator first-funder is also an
    # any-funder, so the separate branch could only double-report).
    creator_funded = set()
    if args.creator:
        for ph in per_holder:
            if any(f["from"] == args.creator for f in ph["funders"]):
                # Reason names the first one only; the union collects
                # every creator-funded holder (no break — the old
                # break would truncate the linkedPct union).
                if not creator_funded:
                    reasons.append(f"top holder {ph['owner'][:8]}... funded by token creator")
                creator_funded.add(ph["owner"])
                clustered = True
    # Direct token transfers between top holders, ignoring transfers
    # from a holder with >=20% of supply, which is usually a pool or
    # bonding-curve account sending tokens to buyers, not a wallet link.
    owner_set = set(owners)
    pct_by_owner = {h["owner"]: h.get("pct", 0) for h in holders}
    transfer_linked = set()
    for ph in per_holder:
        links = [x for x in ph["tokenLinks"] if x in owner_set and x != ph["owner"] and pct_by_owner.get(x, 0) < 20]
        if links:
            clustered = True
            # Reason names the first pair only; the union collects
            # every linked holder (no break — see creator note above).
            if not transfer_linked:
                reasons.append(f"direct token transfer between top holders {ph['owner'][:8]}... <- {links[0][:8]}...")
            transfer_linked.add(ph["owner"])
            transfer_linked.update(links)

    # Measured bundle share: the union of ALL funder-linked top
    # holders (shared first funder, creator-funded, direct-transfer
    # linked, both endpoints) as % of total supply — the rug
    # check's bundlePct. No threshold here: a link is a link even
    # below the cluster verdict's 8% / >=3 bars. A lower bound when
    # unknown > 0 (an unknown holder may also be linked).
    linked = set()
    for s in shared:
        linked.update(s["holders"])
    linked.update(creator_funded)
    linked.update(transfer_linked)
    linked_pct = round(sum(pct_by_owner.get(o, 0) for o in linked), 2)

    # Measured dev-sold share from the creator's own transactions
    # (cursor-paged, up to 1000 txs, v2.23). A failed first-page
    # fetch is an error (exit 2), same fail-closed rule as the
    # holders: an unmeasured dev-sold is unknown, never 0.
    dev_sold = None
    if args.creator:
        try:
            creator_txs = fetch_creator_txs(args.creator, args.mint)
        except Exception as e:
            print(json.dumps({"error": f"Helius fetch failed for creator {args.creator}: {e}"}), file=sys.stderr)
            sys.exit(2)
        dev_sold = analyse_dev(args.mint, args.creator, creator_txs)

    # Operator components (v2.22, QuantOrb-inspired): connected
    # components of the checked top holders under the SAME link set
    # the cluster verdict uses (shared first funder, creator-funded,
    # direct token transfer between top holders). A component is one
    # probable owner; singletons are operators too. ADDITIVE output
    # only — the verdict, reasons and linkedPct above are untouched,
    # so the fail-closed cluster gate cannot change behaviour here.
    # Limits (inherited from the link set): first funder in a 25-tx
    # window; a pool paying a seller SOL can look like a funder;
    # an operator funding via a second wallet is invisible.
    parent = {o: o for o in owners}
    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x
    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra
    for _funder, group in by_first.items():
        uniq = sorted({g["owner"] for g in group})
        for other in uniq[1:]:
            union(uniq[0], other)
    creator_list = sorted(creator_funded)
    for other in creator_list[1:]:
        union(creator_list[0], other)
    for ph in per_holder:
        for other in [x for x in ph["tokenLinks"] if x in owner_set and x != ph["owner"] and pct_by_owner.get(x, 0) < 20]:
            union(ph["owner"], other)
    by_root = defaultdict(list)
    for o in owners:
        by_root[find(o)].append(o)
    operators = sorted(
        ({"members": sorted(m), "pctSupply": round(sum(pct_by_owner.get(o, 0) for o in m), 2), "count": len(m)} for m in by_root.values()),
        key=lambda op: op["pctSupply"], reverse=True)

    # Explicit verdict: unknown when any holder's funder is unknown
    # and the token is not clustered — the caller must block on it.
    verdict = "clustered" if clustered else ("unknown" if unknown > 0 else "clean")
    out = {
        "clustered": clustered,
        "verdict": verdict,
        "reason": "; ".join(reasons) if reasons else ("no shared funder found" if unknown == 0 else f"no shared funder found, {unknown} holder(s) with no funding history in window"),
        "checked": len(per_holder),
        "unknown": unknown,
        "sharedFunders": shared,
        "linkedPct": linked_pct,
        "linkedHolders": len(linked),
        "operators": operators,
        "creatorFunded": creator_list,
        "devSold": dev_sold,
        "holders": [{k: v for k, v in ph.items() if k != "funders"} for ph in per_holder],
    }
    print(json.dumps(out, indent=2))


if __name__ == "__main__":
    main()
