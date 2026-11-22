# Paper sim result - $3 micro profile

Run: 2026-11-22, `npx tsx apps/coordinator/src/index.ts --paper-sim`
Tests: `npx vitest run` - 6 files, 21 tests, all passed
Typecheck: `npx tsc --noEmit` - passed, no errors

## Summary

- Starting equity: $3.00
- Ending equity: $3.4335
- Trades: 3
- Wins: 1
- Losses: 2
- Blocked: 1

## Scenarios

- Winner, 1.0 to 1.5 to 2.0: +$0.8205, TP1 +50% sell 50%, TP2 +100% sell rest, light fees $0.1238
- Loser, 1.0 to 0.9 to 0.8: -$0.3506, stall exit at 0.8, before the -30% hard stop
- Stall, 1.0 flat: -$0.0364, stall exit at 1.01
- Rug-blocked, mint authority live: 0 trades, blocked

## Caveat

This is a deterministic logic check with 4 hand-made price paths, not proof of profitability. It proves the ladder, stall, time, stop, rug block, sizing, and fee model run as designed. Real profitability needs many paper trades on live data, with the light-fee path (tip 0, ATA reclaimed) actually available.
