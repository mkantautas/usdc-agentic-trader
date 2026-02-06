# USDC Agentic Trader v2

**An autonomous AI agent that manages a USDC portfolio on Solana devnet — with perpetual futures shorting/longing via Drift Protocol.**

Built for the [USDC Hackathon](https://www.moltbook.com/m/usdc) on Moltbook — **Track: AgenticCommerce**

> Proving: AI agents + USDC > humans + USDC

**[Live Dashboard](https://mkantautas.github.io/usdc-agentic-trader/)** | **[Solana Explorer](https://explorer.solana.com/address/BGYMcHT1XkWP2a9b6YNAjw5cBKYPoJh3R1ujao7i3Mgq?cluster=devnet)**

---

## What It Does

This is a fully autonomous trading agent that:

1. **Fetches real market data** — SOL price, 24h change, market sentiment from CoinGecko
2. **Analyzes with AI** — Sends market context to Claude for trading decisions
3. **Executes real transactions** — On-chain Solana devnet USDC transfers + Drift perpetual futures
4. **Manages three venues** — Agent wallet (active), Treasury wallet (reserve), Drift Protocol (derivatives)
5. **Opens SHORT/LONG positions** — Via Drift Protocol perpetual futures with configurable leverage
6. **Logs everything** — Every decision with reasoning, confidence scores, and tx hashes
7. **Repeats autonomously** — 30-second cycles, up to 200 cycles per session

### Trading Actions

**USDC Treasury Management:**
- **ALLOCATE_TO_TREASURY** — Bearish signal, protect capital in reserve
- **WITHDRAW_FROM_TREASURY** — Bullish signal, deploy capital from reserve
- **REBALANCE** — Portfolio skewed, restore balance
- **HOLD** — No clear signal, wait

**Drift Perpetual Futures:**
- **OPEN_SHORT** — Bearish conviction → short SOL-PERP (profit from price decline)
- **CLOSE_SHORT** — Take profit or cut losses on short position
- **OPEN_LONG** — Bullish conviction → long SOL-PERP (amplify gains with leverage)
- **CLOSE_LONG** — Take profit or cut losses on long position
- **DEPOSIT_TO_DRIFT** — Move USDC into Drift as collateral for futures trading

## Architecture

```
┌─────────────┐    ┌──────────────┐    ┌──────────────┐    ┌──────────────────┐
│  Market Data │───>│  AI Analysis │───>│   Decision   │───>│  Execute Trade   │
│  (CoinGecko) │    │   (Claude)   │    │   Engine     │    │                  │
└─────────────┘    └──────────────┘    └──────────────┘    │  USDC Transfers  │
                                                            │  Drift SHORT/LONG│
                                                            └────────┬─────────┘
                          ┌──────────────────────────────────────────┘
                          v
                   ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
                   │  Agent Wallet│<──>│   Treasury   │    │  Drift Perps │
                   │   (Active)   │    │   (Reserve)  │    │  (SHORT/LONG)│
                   └──────────────┘    └──────────────┘    └──────────────┘
```

**Data Flow:**
1. Every 30 seconds, the agent fetches live SOL price and global market data
2. Price history (last 200 readings) and recent trades are compiled into context
3. Drift Protocol position info (direction, PnL, collateral) is included
4. Claude analyzes the full picture: price trends, momentum, portfolio balance, open positions
5. The AI returns a structured decision with action, amount, confidence, and reasoning
6. If action requires a transfer or position change, real transactions execute on Solana devnet
7. Everything is logged and published to the live dashboard

## Why Agents + USDC > Humans + USDC

| | Human Trader | AI Agent |
|---|---|---|
| **Speed** | Minutes to analyze | Milliseconds |
| **Consistency** | Emotional, biased | Rule-based + AI reasoning |
| **Availability** | 8-16 hours/day | 24/7/365 |
| **Transparency** | "I had a gut feeling" | Every decision logged with reasoning |
| **Execution** | Manual, error-prone | Atomic, on-chain, verifiable |
| **Derivatives** | Complex manual management | Automatic position sizing, entry/exit |
| **Risk Management** | Panic sells, FOMO buys | Systematic profit-taking & stop losses |

The agent doesn't sleep, doesn't panic sell, doesn't FOMO buy. It analyzes, decides, executes, and logs — every 30 seconds, with full transparency. When it's bearish, it can **short SOL** to profit from the decline. When bullish, it **goes long with leverage**.

## Tech Stack

- **Runtime:** Node.js
- **Blockchain:** Solana (devnet)
- **Token:** USDC (Circle's official devnet USDC)
- **Derivatives:** Drift Protocol (perpetual futures on devnet)
- **AI:** Claude (Anthropic) with rule-based fallback
- **Market Data:** CoinGecko API
- **Dashboard:** GitHub Pages (vanilla HTML/JS/Canvas)
- **Libraries:** @solana/web3.js, @solana/spl-token, @drift-labs/sdk, @coral-xyz/anchor

## Quick Start

```bash
# Clone
git clone https://github.com/mkantautas/usdc-agentic-trader.git
cd usdc-agentic-trader

# Install
npm install

# Setup wallet (generates devnet keypair + SOL airdrop)
npm run setup

# Get devnet USDC from Circle's faucet:
# https://faucet.circle.com/ → Solana Devnet → paste your wallet address

# Check balances
npm run fund

# Launch the agent
npm start
```

## Project Structure

```
usdc-agentic-trader/
├── src/
│   ├── agent.js          # Main trading agent (AI + USDC + Drift)
│   ├── drift-devnet.js   # Drift Protocol devnet integration (perps)
│   ├── faucet.js         # Balance checker + SOL airdrop
│   ├── setup-wallet.js   # Wallet generation
│   └── status.js         # Quick status check
├── docs/
│   ├── index.html        # Live dashboard (GitHub Pages)
│   └── data.json         # Dashboard data (auto-updated by agent)
├── logs/                  # Trading logs and state
├── .env.example          # Configuration template
└── package.json
```

## Live Dashboard

The dashboard at [mkantautas.github.io/usdc-agentic-trader](https://mkantautas.github.io/usdc-agentic-trader/) shows:

- Total USDC balance across all wallets + Drift collateral
- Real-time SOL price feed
- Agent status (cycles, transactions, volume, uptime)
- Balance distribution (agent vs treasury vs Drift collateral)
- **Drift perpetual position** (direction, size, unrealized PnL)
- Wallet addresses with Solana Explorer links
- SOL price chart
- Full trade history with reasoning and tx links (Drift trades tagged)

## Configuration

| Variable | Description | Default |
|---|---|---|
| `SOLANA_PRIVATE_KEY` | Devnet wallet private key (base58) | Required |
| `SOLANA_RPC` | Solana RPC endpoint | `https://api.devnet.solana.com` |
| `CLAUDE_API_URL` | Claude API endpoint (OpenAI-compatible) | `http://localhost:8317/v1/chat/completions` |

## On-Chain Proof

All transactions are verifiable on Solana devnet:
- **Agent Wallet:** [BGYMcHT1XkWP2a9b6YNAjw5cBKYPoJh3R1ujao7i3Mgq](https://explorer.solana.com/address/BGYMcHT1XkWP2a9b6YNAjw5cBKYPoJh3R1ujao7i3Mgq?cluster=devnet)
- **Network:** Solana Devnet
- **Token:** Circle USDC (mint: `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`)
- **Derivatives:** Drift Protocol (devnet program: `dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH`)

Every trade creates a real Solana transaction that can be independently verified.

## License

MIT
