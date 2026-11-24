# Micro $3 profile

> RERUN AT $10 from 2026-11-22 23:06 SAST (Newton's call). Starting equity is
> now $10.00: max position 40% = $4.00, daily loss limit 25% = $2.50, halt at
> $7.50, readiness equity bar $11.00. The $3 run's numbers below are kept for
> reference; its state is archived in hidden_files/spotter-test-20261122-v2-3usd/
> (final: $2.39 after 92 polls, 6 trades, 1 win / 5 losses).

Starting equity is $3.00. That is a paper and learning-first account, not a normal compounding bankroll. The research behind this profile found a minimum viable position of 0.15 to 0.62 SOL under normal sniper settings, which implies a 4 to 15 SOL bankroll floor. At $3, about 0.02 SOL, the desk only works when fees are near zero and exits are few.

## v2.7 changes (2026-11-22 overnight)

- Sizing 22% x max 3 open (see Sizing above).
- LP lock verified post-migration from Rugcheck markets[].lp.lpLockedPct; migrated coin with 0% locked or no LP data blocks fail-closed. Pre-migration stays N/A.
- Sell simulation: Jupiter swap quote tried when Rugcheck lists no markets; quote can only add passes.
- Rugged flag blocks outright; creator's current balance pct journaled on entry (devSoldPct still not derivable, still 0, still not gated).
- Discovery fallback to Jupiter /tokens/v2/recent if Pump.fun frontend-api-v3 fails (it still answered 200 from this VM on 2026-11-22).
- Stale-lock recovery (lock older than 5 min reclaimed + journaled) and state normalisation (null counters repaired on load).
- Readiness equity bar derived as startEquity x 1.1.

## Fee math

Light path, per leg: base 0.000005 SOL, priority 0.00005 SOL, Jito tip 0 SOL. Pool fee 1 percent and slippage 2 percent per side. ATA rent 0.00203928 SOL per new mint, reclaimed on final close with CloseAccount.

On a 0.008 SOL position (40 percent of $3 at $150 per SOL), light break-even is about 7 percent gross. Sniper defaults, tip 0.001 SOL and priority 0.001 SOL per leg, break even at over 50 percent gross on the same position. That is why the sniper path is blocked at $3 size and why the tip must be 0.

Fixed costs alone must be under 10 percent of the position, and modelled break-even must be under 25 percent gross, before a signal is actionable.

## Sizing

Max position 22 percent of equity, start 22 percent. Max 3 open positions. Max 15 trades per day — raised from 6 to 10 on 2026-11-23 at Newton's call (the 6/day cap was hit within 20 minutes of midnight and silenced the desk all day), then to 15 the same evening on his instruction to decide decisively: paper trading should reach a productive state faster, and the daily loss halt (not the trade cap) is the real downside guardrail.

Fresh run v2.12 from 2026-11-23 ~20:30 SAST (Newton's call): the previous $10 run halted 19:52 SAST at equity $8.20 reported / ~$6.69 restated (audit BUG-1: buy-leg fees were never charged) and is archived in hidden_files/spotter-test-20261122-v2-10usd-halted/. The v2.12 audit fixes charge the buy leg on entry, fix the fresh-tier predicate, count closes (not entries) for readiness, write state.json atomically, keep partial Pump.fun lists, and count halt-settled closes. Poll 1 verified clean: equity $9.8604, trades 2. Daily loss limit 25 percent of starting equity, $2.50 on the $10 rerun. Halt on breach and flatten open positions.

v2.7 sizing (2026-11-22 overnight, from the "Tweeter post" doc: the Grok Bot run that went $100 -> $13,849 in ~24h used 3 coins max, ~22% of the wallet each, a take-profit and a stop-loss on every buy, out on the first 15-minute candle past either level, every win reinvested). One -30% stop now costs 6.6% of equity instead of 9% at the old 30% size, and three positions diversify the single-coin blow-up. Cost: max deployed 60% -> 66%, more fee legs per unit of equity, and the 6-trades/day cap binds faster with 3 slots to fill. This is a paper test of that sizing — the $10 rerun's first 2 trades were at the old 30% size, everything after v2.7 is at 22%. Revert is one line each in packages/core/src/micro.ts (startPositionPct 0.22 -> 0.30, maxOpenPositions 3 -> 2). Do not read the Tweeter post's $13,849 as a promise: it is one run, on $100, with no rugs in the sample; our $3 run lost 20% and the $10 rerun is 2 trades in.

## Exit ladder, max 2 exits

Rung 1 at plus 50 percent: sell 50 percent of the remaining position.
Rung 2 at plus 100 percent: sell 100 percent of the remainder.
Trailing stop 18 percent under the peak, only after rung 1.
Hard stop minus 30 percent from entry.
Time exit 120 minutes, close the rest.
Stall exit: no new high for 20 minutes while below plus 20 percent, close.

Two exits, not three, because every extra sell is another paid leg. Never hold for a moon move.

## Gem signal wiring

Scout finds a candidate. Anti-rug runs first and blocks on any missing, timed-out, or failed hard check. Gem-signal scores the survivors 0 to 100 and is actionable only when the rug pass is clean, the score is at least 70, and the fee break-even passes. Coordinator and Risk then decide. Risk can veto. Exit owns all closes.

## Kill switches

Halt flattens every open position and locks automation. Kill disarms new buys while exits keep running. Pause stops discovery only. Sell All flattens without locking.

## How to run the paper simulation

```bash
npm install
npm test
npx tsx apps/coordinator/src/index.ts --paper-sim
```

Paper mode uses the exact same sizing, stop, trailing, and exit logic as live. If paper loses, live will lose the same way.
