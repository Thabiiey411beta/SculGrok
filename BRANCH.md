# BSC desk line

This is the BSC (four.meme) desk line of SculGrok (same repo as
the Solana line).

Scope: `packages/bsc` (discovery via GeckoTerminal, GoPlus gate,
NodeReal cluster gate, fees) plus `apps/coordinator/src/bsc-spotter-run.ts`.
Paper-first, fail-closed; pre-grad entries block at $15 equity
(four.meme 1% fee, min 0.001 BNB) — effectively graduated-only
until size grows.

Solana work is developed on the `solana` branch. Shared packages
(`core`, `anti-rug`, `exit`, `backtest`) are used by both lines,
so both branches start from the same full snapshot — the split is
by branch line going forward, not by deleting shared code.
