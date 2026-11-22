# Micro $3 profile

Starting equity is $3.00. That is a paper and learning-first account, not a normal compounding bankroll. The research behind this profile found a minimum viable position of 0.15 to 0.62 SOL under normal sniper settings, which implies a 4 to 15 SOL bankroll floor. At $3, about 0.02 SOL, the desk only works when fees are near zero and exits are few.

## Fee math

Light path, per leg: base 0.000005 SOL, priority 0.00005 SOL, Jito tip 0 SOL. Pool fee 1 percent and slippage 2 percent per side. ATA rent 0.00203928 SOL per new mint, reclaimed on final close with CloseAccount.

On a 0.008 SOL position (40 percent of $3 at $150 per SOL), light break-even is about 7 percent gross. Sniper defaults, tip 0.001 SOL and priority 0.001 SOL per leg, break even at over 50 percent gross on the same position. That is why the sniper path is blocked at $3 size and why the tip must be 0.

Fixed costs alone must be under 10 percent of the position, and modelled break-even must be under 25 percent gross, before a signal is actionable.

## Sizing

Max position 40 percent of equity, start 30 to 40 percent. Max 2 open positions. Max 6 trades per day. Daily loss limit 25 percent of starting equity, $0.75. Halt on breach and flatten open positions.

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
