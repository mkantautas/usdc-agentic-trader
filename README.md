# USDC Agentic Trader

**An autonomous AI agent that manages a USDC portfolio on Solana devnet.**

Built for the [USDC Hackathon](https://www.moltbook.com/m/usdc) on Moltbook — **Track: AgenticCommerce**

> Proving: AI agents + USDC > humans + USDC

**[Live Dashboard](https://mkantautas.github.io/usdc-agentic-trader/)** | **[Solana Explorer](https://explorer.solana.com/address/BGYMcHT1XkWP2a9b6YNAjw5cBKYPoJh3R1ujao7i3Mgq?cluster=devnet)**

---

## What It Does

This is a fully autonomous trading agent that:

1. **Fetches real market data** — SOL price, 24h change, market sentiment from CoinGecko
2. **Analyzes with AI** — Sends market context to Claude for trading decisions
3. **Executes real USDC transfers** — On-chain Solana devnet transactions (not simulated)
4. **Manages two wallets** — Agent wallet (active capital) and Treasury wallet (reserve)
5. **Logs everything** — Every decision with reasoning, confidence scores, and tx hashes
6. **Repeats autonomously** — 30-second cycles, up to 200 cycles per session

The agent makes 4 types of decisions:
- **ALLOCATE_TO_TREASURY** — Bearish signal detected, protect capital in reserve
- **WITHDRAW_FROM_TREASURY** — Bullish signal, deploy capital from reserve
- **REBALANCE** — Portfolio skewed, restore 50/50 balance
- **HOLD** — No clear signal, wait for better opportunity

## Architecture

```
┌─────────────┐    ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│  Market Data │───→│  AI Analysis │───→│   Decision   │───→│ USDC Transfer│
│  (CoinGecko) │    │   (Claude)   │    │   Engine     │    │  (Solana TX) │
└─────────────┘    └──────────────┘    └──────────────┘    └──────────────┘
                                                                    │
                          ┌─────────────────────────────────────────┘
                          ▼
                   ┌──────────────┐    ┌──────────────┐
                   │  Agent Wallet│◄──►│   Treasury   │
                   │   (Active)   │    │   (Reserve)  │
                   └──────────────┘    └──────────────┘
```

**Data Flow:**
1. Every 30 seconds, the agent fetches live SOL price and global market data
2. Price history (last 200 readings) and recent trades are compiled into context
3. Claude analyzes the full picture: price trends, momentum, portfolio balance
4. The AI returns a structured decision with action, amount, confidence, and reasoning
5. If action requires a transfer, real USDC moves between wallets on Solana devnet
6. Everything is logged and published to the live dashboard

## Why Agents + USDC > Humans + USDC

| | Human Trader | AI Agent |
|---|---|---|
| **Speed** | Minutes to analyze | Milliseconds |
| **Consistency** | Emotional, biased | Rule-based + AI reasoning |
| **Availability** | 8-16 hours/day | 24/7/365 |
| **Transparency** | "I had a gut feeling" | Every decision logged with reasoning |
| **Execution** | Manual, error-prone | Atomic, on-chain, verifiable |

The agent doesn't sleep, doesn't panic sell, doesn't FOMO buy. It analyzes, decides, executes, and logs — every 30 seconds, with full transparency.

## Tech Stack

- **Runtime:** Node.js
- **Blockchain:** Solana (devnet)
- **Token:** USDC (Circle's official devnet USDC)
- **AI:** Claude (Anthropic) with rule-based fallback
- **Market Data:** CoinGecko API
- **Dashboard:** GitHub Pages (vanilla HTML/JS/Canvas)
- **Libraries:** @solana/web3.js, @solana/spl-token

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
│   ├── agent.js          # Main trading agent (AI + on-chain execution)
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

- Total USDC balance across both wallets
- Real-time SOL price feed
- Agent status (cycles, transactions, volume, uptime)
- Balance distribution (agent vs treasury)
- Wallet addresses with Solana Explorer links
- SOL price chart
- Full trade history with reasoning and tx links

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

Every trade the agent makes creates a real Solana transaction that can be independently verified.

## License

MIT
