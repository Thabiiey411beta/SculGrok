# SculGrok

**Multi-agent Grok trading desk** — Solana memecoins + Forex/multi-asset.

7 specialized agents. Fail-closed anti-rug. Paper-first. Inspired by the autonomous multi-cursor desks shown by @MyWestLord and the open patterns in CrawlCat / Widow.

> One brain. Seven jobs. Zero discretionary clicks once the rules are locked.

---

## Agents (exactly 7)

| # | Agent | Single Job |
|---|-------|------------|
| 1 | **Scout / Entry** | Finds clean setups (new mints, volume + smart-money clusters, or FX levels) |
| 2 | **Scalper / Stacker** | Only adds size into already-winning positions |
| 3 | **Hedge** | Keeps net exposure and correlation inside limits |
| 4 | **Risk / Margin** | Watches equity, margin level, daily loss. Instant kill on breach |
| 5 | **News / Macro** | Reads X + tape + economic calendar |
| 6 | **Exit** | Closes the second momentum stalls (the “orange banner” behaviour) |
| 7 | **Coordinator** | Assigns work, enforces hard rules, logs every decision with a written reason |

---

## Safety Non-Negotiables

- Paper / dry-run is the default.
- Two explicit locks required for live money (`LIVE=1` + `--live` flag).
- Keys never leave the execution host.
- Fail-closed: any anti-rug timeout or hard check failure = no trade.
- Every trade must have a written reason.
- Hard daily loss limit + position size caps.
- Withdrawal / transfer still requires human approval.

---

## Quick Start (Paper Mode)

```bash
git clone https://github.com/Thabiiey411beta/SculGrok.git
cd SculGrok
cp .env.example .env
# edit .env — leave LIVE=0

npm install          # or bun / pnpm
npm run paper        # starts the 7-agent desk in paper mode
```

Open the local desk UI (coming in `packages/desk`) or just watch the terminal feed.

---

## Repo Layout

```
SculGrok/
├── apps/
│   ├── coordinator/     # Lead agent + rule engine
│   ├── scout/           # Entry / signal discovery
│   ├── risk/            # Risk + margin + kill switch
│   └── executor/        # Isolated order submission (Solana + FX bridges)
├── packages/
│   ├── anti-rug/        # Hard + soft checks (Solana + generic)
│   ├── signals/         # Normalized signal types
│   ├── core/            # Shared types, config, logging
│   └── desk/            # Optional pixel / terminal UI
├── bridges/
│   ├── solana/          # Pump.fun / Raydium / Jupiter + Jito path
│   └── forex/           # MT5 / cTrader / broker REST adapters (stub)
├── prompts/             # Exact system prompts for each of the 7 agents
├── docs/
│   ├── SAFETY.md
│   ├── AGENTS.md
│   └── ARCHITECTURE.md
└── .env.example
```

---

## Status

| Component              | State                          |
|------------------------|--------------------------------|
| Agent prompts          | ✅ Ready                       |
| Anti-rug (Solana)      | ✅ Core checks implemented     |
| Paper trading loop     | ✅ Scaffolded                  |
| Live Solana executor   | ⚠️ Implemented, not battle-tested — start tiny |
| Forex bridge           | 🟡 Stub + interface only       |
| Desk UI                | 🟡 Coming                      |
| Live keys / withdrawals| 🔒 Human-gated                 |

---

## Philosophy

Copied from the best public desks:

- One agent = one job.
- The Coordinator never places an order.
- The Risk agent can veto any other agent at any time.
- Paper mode uses the **exact same** exit and sizing logic as live.
- If you wouldn’t leave it running overnight with real money, the rules are still too soft.

---

Built for the operator who wants the agents to work while the human only clicks “approve withdraw”.

MIT. Use at your own risk. Not financial advice.
