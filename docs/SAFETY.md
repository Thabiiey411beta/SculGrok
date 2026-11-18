# SAFETY.md — Read this before anything else

SculGrok is designed so that the most common ways people blow up accounts are structurally difficult.

## Two locks for real money

1. `LIVE=0` in `.env` (default)
2. You must also pass the `--live` flag when starting the process

Either one alone does nothing. Both must be present.

## Paper mode is not a toy

Paper mode uses the **exact same** sizing, stop, trailing, and exit logic as live. The only difference is the fill path. If the paper desk is losing, the live desk will lose the same way.

## Anti-rug is fail-closed

Any hard check that times out or returns unknown is treated as **block**, never pass.

Solana hard checks include:
- Mint authority still set
- Freeze authority still set
- Top-10 concentration above limit
- Bundle / same-slot concentration above limit
- Dev already sold too much of their bag
- Buy simulation fails or returns toxic tax

## Keys

- Hot wallet private key is loaded only by the executor process.
- Prefer encrypted-at-rest + OS keyring.
- Never log the key material.
- The Coordinator, Scout, Risk, etc. never see the key.

## Kill switches

- Risk agent can issue `halt` at any time.
- Daily loss limit is hard.
- Manual `bot:halt` flag in Redis (or equivalent) is checked every loop.
- SIGUSR1 / kill file on the host cancels in-flight submits that have not left the machine.

## Human still owns the money

The bot can trade. It cannot withdraw, transfer, or change the hot wallet destination without explicit human approval (Face ID / 2FA / signed message — whatever you wire).

## No financial advice

This software is a tool. You are responsible for the capital you put at risk and for understanding the rules you enable.
