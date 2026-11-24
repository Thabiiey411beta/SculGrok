# Architecture

SculGrok follows a strict separation of concerns so that a bug in one agent cannot take the whole desk down or move money without checks.

## Process boundaries

```
┌─────────────┐     signals      ┌──────────────┐
│   Scout     │ ───────────────► │              │
│   News      │                  │  Coordinator │
│   Scalper   │ ◄── assignments ─│              │
│   Hedge     │                  └──────┬───────┘
│   Exit      │                         │
└─────────────┘                         │ allow / deny
                                        ▼
                               ┌────────────────┐
                               │     Risk       │  (absolute veto)
                               └────────┬───────┘
                                        │
                                        ▼
                               ┌────────────────┐
                               │   Executor     │  (only process that can sign)
                               │  Solana bridge │
                               │  Forex bridge  │
                               └────────────────┘
```

- Coordinator never signs or submits.
- Risk can halt the desk at any moment.
- Executor is the only process that holds private keys / broker sessions.
- Anti-rug runs before any signal reaches the Coordinator for auto mode.

## Data flow (Solana path)

1. Ingest (PumpPortal / Geyser / Helius) → normalized mint + trade events
2. Anti-rug hard checks (fail-closed)
3. Scout scores survivors
4. Coordinator + Risk decide
5. Executor builds, simulates, and (if live) submits via Jito or private RPC
6. Exit + Risk monitor the position until flat

## Spotter v2.7 data flow (what actually runs in paper)

```
Pump.fun frontend-api-v3 (newest / market-cap / last-trade feeds)
  └─ on failure → Jupiter Tokens v2 /recent (keyless fallback)
  → Rugcheck /report (authorities, top holders, markets[].lp.lpLockedPct,
     rugged flag, creatorBalance) → fail-closed rug gate
  → Helius funder-cluster gate (authority for bundles)
  → Cabal-Hunter second opinion (blocks only HIGH / score >= 65 /
     honeypot HIGH; failed scan never blocks)
  → OKX bundle/dev/details/cluster (logged signal only, never gates)
  → FomoAPI smart-money feed + 30-min alerts (+10 gem boost on a
     tracked smart buy in the last 60 min)
  → paper entry at 22% of equity, max 3 open
  → exits enforced by the 5-min spotter AND the 1-min Jupiter watcher
     (same ladder: TP1 +50% sell half, TP2 +100%, trailing 18% after
     TP1, hard stop -30%, time exit 120 min, stall 20 min)
```

State lives in spotter-test-20261122-v2/state.json, shared by spotter
and watcher under one lock dir; a lock older than 5 min is reclaimed
as orphaned (crons cap runs at 180s/60s with `timeout`). Counters are
normalised on load so a null in state.json can never poison a poll.

## Forex path

Same agent structure. The bridge is currently a stub. Once you connect MT5 / cTrader / a broker REST API, the Executor calls the same `submit` / `close` interface.

## Latency targets (Solana)

- Event → anti-rug verdict: < 80 ms
- Verdict → decision: < 50 ms
- Decision → signed bundle: < 40 ms

Paper mode has no latency pressure; correctness comes first.
