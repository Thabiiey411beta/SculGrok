# Solana desk line

This is the Solana desk line of SculGrok (same repo as the BSC line).

Scope: `apps/coordinator` (spotter, 1-min watcher, WS relay),
`packages/signals`, `packages/core`, `packages/anti-rug`,
`packages/exit`, `packages/backtest`. Paper-first, fail-closed;
live trading needs two explicit locks.

BSC work lives in `packages/bsc` and is developed on the `bsc`
branch. Shared packages are used by both lines, so both branches
start from the same full snapshot — the split is by branch line
going forward, not by deleting shared code.
