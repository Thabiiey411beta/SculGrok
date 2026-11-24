# Ready for real capital — criteria

Paper only until ALL of these are true, over the v2 test loop. No live
trading, no live keys, until Newton gives the two explicit live locks
separately, after seeing a ready report.

## Criteria
- At least 20 paper trades
- At least 10 of those closed on price, not price-source-lost
- Win rate at least 40%
- Profit factor at least 1.20 (gross wins / gross losses)
- Equity at least $16.50, up 10% from the $15.00 start (rerun from 2026-11-24 ~11:16 SAST; the $10 v2.17 run ended at $10.00 after 147 polls, 0 trades, and is archived in hidden_files/spotter-test-20261122-v2-10usd-v217-reset/; the $3 run ended at $2.39 after 92 polls, 6 trades, 1 win / 5 losses, and is archived in hidden_files/spotter-test-20261122-v2-3usd/). Since v2.7 the bar is derived in code as startEquity x 1.1, not hard-coded.
- Price-source-lost closes at most 10% of trades
- No gap loss worse than -50% on a single trade in the last 20 trades (enforced in readiness() since v2.4, via state.worstLossPct; backfilled -45.1% from the KYC close on 2026-11-22)
- Daily loss halt never triggered in the ready window (enforced in readiness() since v2.4)
- At least 10 trades closed on price, not price-source-lost (enforced in readiness() since v2.4)

## Why these
The v1 test lost 22.9% in 2 hours, 0 wins / 6 losses, with 5 of 6 closes
blind. That is not a signal problem alone — it is price tracking, bundle
verification, and polling gaps. A system that cannot clear these bars in
paper will lose faster live, where fees and slippage are real.

## Loop
Spotter v2 polls every 5 minutes, paper only, fresh $15 start. Each poll
updates state.json with trades, wins, losses, gross wins/losses, and
price-source-lost closes. When readiness() returns ready, the poll cron
stops, the summary job reports ready to Newton, and live is NOT started
automatically — Newton must approve the two live locks first.

## v2.7 (2026-11-22 overnight)
Sizing is 22% per position, max 3 open (Tweeter-post profile; the $10
rerun's first 2 trades were at the old 30% size). LP lock is verified
post-migration, sell simulation can fall back to a Jupiter quote, rugged
tokens block, discovery falls back to Jupiter recent if Pump.fun fails,
stale locks are reclaimed, and state counters are normalised on load.
Full list in docs/MICRO-3USD.md and the spotter.ts header. None of this
changes the readiness bars — they still need 20 trades, and the rerun
is 2 trades in.

## v2.11 (2026-11-23)
Fast watcher: the 1-min watcher now prices open positions every 10
seconds inside each invocation (up to 5 ticks, per-tick lock so the
5-min spotter is not starved). This is the fix for the between-tick
gap that produced the -74.9% loss — all six hard-stop closes in the
run gapped through -30% (realised -30.3% to -74.0%, avg -45.5%).
Hard stop stays -30% (tight 15% stops cut gains in half in a
256k-launch replay — runners pull back 20-28% early). Fresh-tier
concentration override stays, with an honest journal reason. Entry
lines now journal firstMc/runUp/liquidity/top10/single so the next
sizing decision has data. Readiness bars unchanged: the -74.9% loss
stays in the last-20 window until trade #32, and the -51.2%
first-entry gap (BkQjetCC) is not a re-entry, so the worst-loss bar
still cannot pass before trade #32.

## v2.10 (2026-11-23 overnight)
Re-entry cooldown: no re-entry into a mint within 30 minutes of its
close. Trade #12 (-74.9%) was a re-entry 2m34s after a TP2 exit at
+100%, at 2.1x the first entry price, via the fresh-tier override,
and dumped -74% in 87 seconds. Two of the three re-entries in the
run lost; the one winning re-entry came after a 35-minute gap, so
30 minutes keeps it legal. This does not change the readiness bars:
the -74.9% loss stays in the last-20 window until trade #32, and
the -51.2% first-entry gap (BkQjetCC) is not a re-entry, so the
worst-loss bar still cannot pass before trade #32.
