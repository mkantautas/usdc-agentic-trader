# Changelog

## 2026-02-08 — Limit Orders (Major Cost Reduction)

### Changed
- **Market orders → Limit orders** — All Drift perp trades (open/close) now use `getLimitOrderParams` with `PostOnlyParams.TRY_POST_ONLY`. This reduces per-trade spread cost from ~$0.55 to ~$0.05-$0.15 (70-90% reduction).
- **Limit price strategy** — LONG orders bid 0.1% above oracle price; SHORT orders ask 0.1% below oracle. Close orders use the inverse to ensure quick fills while still saving on spread.
- **AI prompt updated** — Reflects the new lower spread costs so the model doesn't overweight spread fear in its decisions.

### Added
- **Order fill monitoring** — After placing a limit order, the agent polls every 10 seconds to check if it filled. If unfilled after 3 minutes, the order is automatically cancelled and the cycle continues with no position change.
- **Stale order cleanup** — At the start of every trading cycle, any leftover open orders from previous cycles (e.g. from crashes) are cancelled before making new decisions.
- **`getOpenOrders()` and `cancelAllOrders()`** — New Drift SDK wrapper functions for order management.

### Why
Market orders were the #1 reason for losses. The agent's directional calls (when to long/short) were correct, but every round trip cost ~$0.55-$0.60 in spread — more than the actual price movements at our position sizes. Over 319 transactions, this accumulated to -$55 in realized P&L. Limit orders (maker) avoid paying the taker spread, making it possible for correct trades to actually be profitable.

---

## 2026-02-08 — Smarter Trading (Sonnet + Anti-Churn v2)

### Changed
- **Model: Haiku → Sonnet** — Better reasoning for nuanced "hold vs close" decisions. Haiku was misreading consolidation as reversal, causing unnecessary churn.
- **Cycle interval: 30s → 2min** — Fewer decision points = less opportunity to second-guess. Token usage stays similar (fewer calls × higher per-call cost). Matches swing trading style better than scalping.
- **Hold time: 10min → 30min** — Positions need time to play out. The old 10min hold was still too short; agent kept closing and reopening the same direction, paying spread each time.
- **Cooldown: 5min → 10min** — More breathing room between closing one position and opening another.

### Added
- **Trend analysis engine** — Calculates SMA crossover, momentum, support/resistance, consecutive candle direction, and trend strength score (0-100). Fed into both the AI prompt and rule-based fallback.
- **AI prompt overhaul** — 10 explicit trading discipline rules. Emphasizes: HOLD is default, don't churn, spread is not a loss, think like a swing trader, respect cooldowns.

### Why
The agent was losing money not from bad directional calls (shorts/longs were correct) but from **churning** — closing and reopening the same position repeatedly, paying ~$0.56 spread each time. Over 151 Drift trades, it paid ~$48 in spread for trades that would have been profitable if held. These changes address the root cause: too many decision points + too little patience.

---

## 2026-02-08 — Anti-Churn Guards v1

### Added
- 10-minute minimum position hold time
- 5-minute cooldown after closing before opening new
- 3% spread tolerance (percentage-based, scales with portfolio)
- No position stacking (can't open LONG if already LONG)
- Percentage-based take-profit (8% of collateral) and stop-loss (10% of collateral)

---

## 2026-02-08 — Price Sanity & Bug Fixes

### Fixed
- **Fake $200 SOL spike** — Fallback price was random $190-$210 when CoinGecko failed. Now uses last known good price.
- **30% price jump rejection** — If new price differs >30% from last known, it's rejected as bad data.
- Cleaned bad spike data from historical records.

---

## 2026-02-07 — Drift Protocol Integration

### Added
- Drift Protocol devnet integration for perpetual futures (SHORT/LONG SOL-PERP)
- 9 total agent actions (4 USDC treasury + 5 Drift perps)
- Auto-minting of Drift devnet USDC via on-chain faucet
- Dashboard: Drift position card, color-coded trade history

---

## 2026-02-07 — Portfolio Tracking

### Added
- Initial balance tracking and P&L calculation
- Portfolio performance card on dashboard (dollar + % change)
- Portfolio value over time chart
- Realized and unrealized P&L tracking

---

## 2026-02-06 — Initial Release

### Added
- Autonomous AI trading agent with Claude (Sonnet) + rule-based fallback
- USDC treasury management (allocate/withdraw/rebalance/hold)
- Live dashboard on GitHub Pages
- CoinGecko market data integration
- 30-second trading cycles
- Lithuania timezone (24h format)
