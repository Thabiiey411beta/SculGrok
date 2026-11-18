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

## Forex path

Same agent structure. The bridge is currently a stub. Once you connect MT5 / cTrader / a broker REST API, the Executor calls the same `submit` / `close` interface.

## Latency targets (Solana)

- Event → anti-rug verdict: < 80 ms
- Verdict → decision: < 50 ms
- Decision → signed bundle: < 40 ms

Paper mode has no latency pressure; correctness comes first.
