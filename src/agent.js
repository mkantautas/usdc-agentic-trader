/**
 * USDC Agentic Trader
 *
 * An autonomous AI agent that manages a USDC portfolio on Solana devnet.
 * Uses Claude to analyze market data and make trading decisions.
 *
 * Architecture:
 *   Market Data → AI Analysis → Decision → Execute (USDC Transfer / Drift Perps) → Log → Repeat
 *
 * Capabilities:
 *   - USDC treasury management (agent ↔ treasury wallet transfers)
 *   - Perpetual futures via Drift Protocol (LONG/SHORT SOL-PERP on devnet)
 *   - AI-powered decisions with rule-based fallback
 *
 * The agent demonstrates that AI + USDC is faster, smarter, and more
 * consistent than human + USDC for portfolio management.
 */

const { Connection, Keypair, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const {
  getAssociatedTokenAddress,
  getAccount,
  createTransferInstruction,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} = require('@solana/spl-token');
const bs58 = require('bs58').default;
const fs = require('fs');
const path = require('path');

// Format time in 24h Lithuania timezone (EET/EEST)
function formatLT(date = new Date()) {
  return date.toLocaleTimeString('lt-LT', { timeZone: 'Europe/Vilnius', hour12: false });
}

// Safe toFixed — prevents crashes from undefined/null values
function safe(val, decimals = 2) {
  if (val === undefined || val === null || isNaN(val)) return '0.00';
  return Number(val).toFixed(decimals);
}
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), override: true });

// ─── Configuration ───────────────────────────────────────────────────────────

const DEVNET_RPC = process.env.SOLANA_RPC || 'https://api.devnet.solana.com';
const USDC_DEVNET_MINT = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
const CLAUDE_API = process.env.CLAUDE_API_URL || 'http://localhost:8317/v1/chat/completions';
const CLAUDE_MODEL = 'claude-sonnet-4-20250514';

// Trading parameters
const TRADE_INTERVAL_MS = 120_000;  // 2 minutes between cycles
const MAX_CYCLES = 200;
const MIN_USDC_TRADE = 0.5;
const MAX_USDC_TRADE_PCT = 0.25;
const MIN_PERP_SIZE_USD = 1;       // Min $1 for perp positions
const MAX_PERP_SIZE_USD = 10;      // Max $10 per perp trade (conservative for devnet)
const DEFAULT_LEVERAGE = 2;

// Anti-churn parameters
const MIN_POSITION_HOLD_MS = 30 * 60 * 1000;   // Must hold a position for at least 30 minutes
const TRADE_COOLDOWN_MS = 10 * 60 * 1000;       // 10 min cooldown after closing before opening new
const SPREAD_TOLERANCE_PCT = 0.03;               // Don't close if loss < 3% of position size (that's just the spread)

// Limit order parameters
const ORDER_FILL_TIMEOUT_MS = 3 * 60 * 1000;    // Cancel unfilled limit orders after 3 minutes
const ORDER_CHECK_INTERVAL_MS = 10_000;          // Check order fill status every 10 seconds

// Paths
const LOG_DIR = path.join(__dirname, '..', 'logs');
const STATE_FILE = path.join(LOG_DIR, 'agent-state.json');
const DASHBOARD_DATA = path.join(__dirname, '..', 'docs', 'data.json');

// ─── Globals ─────────────────────────────────────────────────────────────────

const connection = new Connection(DEVNET_RPC, 'confirmed');
let wallet;
let treasuryWallet;

// Lazy-loaded Drift module
let drift = null;
let driftAvailable = null; // null = unknown, true/false after check

async function getDrift() {
  if (driftAvailable === false) return null;
  if (drift) return drift;

  try {
    drift = require('./drift-devnet');
    await drift.initializeDrift();
    driftAvailable = true;
    console.log('[Drift] Connected to devnet');
    return drift;
  } catch (err) {
    console.log(`[Drift] Unavailable: ${err.message}`);
    driftAvailable = false;
    return null;
  }
}

// ─── Market Data ─────────────────────────────────────────────────────────────

let lastGoodPrice = null;

async function getSOLPrice() {
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd&include_24hr_change=true');
    const data = await res.json();
    const price = data.solana.usd;
    const change24h = data.solana.usd_24h_change;

    // Sanity check: reject prices that jump more than 30% from last known good price
    if (lastGoodPrice && Math.abs(price - lastGoodPrice) / lastGoodPrice > 0.30) {
      console.log(`⚠️ Price sanity check failed: got $${price}, last good was $${lastGoodPrice}. Using last good price.`);
      return { price: lastGoodPrice, change24h: change24h || 0 };
    }

    lastGoodPrice = price;
    return { price, change24h };
  } catch {
    // Use last known good price instead of random values
    if (lastGoodPrice) {
      console.log(`⚠️ CoinGecko fetch failed, using last known price: $${lastGoodPrice}`);
      return { price: lastGoodPrice, change24h: 0 };
    }
    // Only if we've NEVER had a good price (first cycle + API down), use a safe fallback
    console.log('⚠️ CoinGecko fetch failed and no price history. Using $0 to skip trading.');
    return { price: 0, change24h: 0 };
  }
}

async function getMarketSentiment() {
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/global');
    const data = await res.json();
    return {
      totalMarketCap: data.data.total_market_cap.usd,
      marketCapChange: data.data.market_cap_change_percentage_24h_usd,
      btcDominance: data.data.market_cap_percentage.btc
    };
  } catch {
    return {
      totalMarketCap: 3_000_000_000_000,
      marketCapChange: (Math.random() - 0.5) * 5,
      btcDominance: 54
    };
  }
}

// ─── Wallet & Balance Functions ──────────────────────────────────────────────

function loadWallet() {
  const privateKey = process.env.SOLANA_PRIVATE_KEY;
  if (!privateKey) throw new Error('SOLANA_PRIVATE_KEY not set. Run: npm run setup');
  return Keypair.fromSecretKey(bs58.decode(privateKey));
}

function loadOrCreateTreasury() {
  const treasuryPath = path.join(__dirname, '..', '.treasury-key');
  if (fs.existsSync(treasuryPath)) {
    const key = fs.readFileSync(treasuryPath, 'utf8').trim();
    return Keypair.fromSecretKey(bs58.decode(key));
  }
  const treasury = Keypair.generate();
  fs.writeFileSync(treasuryPath, bs58.encode(treasury.secretKey));
  return treasury;
}

async function getUSDCBalance(pubkey) {
  try {
    const ata = await getAssociatedTokenAddress(USDC_DEVNET_MINT, pubkey);
    const account = await getAccount(connection, ata);
    return Number(account.amount) / 1e6;
  } catch {
    return 0;
  }
}

async function getSOLBalance(pubkey) {
  const balance = await connection.getBalance(pubkey);
  return balance / LAMPORTS_PER_SOL;
}

// ─── Drift Helper: Get Position Info ─────────────────────────────────────────

async function getDriftInfo() {
  const d = await getDrift();
  if (!d) return { available: false, position: null, driftBalance: 0, freeCollateral: 0, openOrders: [] };

  try {
    const info = await d.getAccountInfo();
    const openOrders = await d.getOpenOrders();
    return {
      available: true,
      hasAccount: info.hasAccount,
      position: info.position,
      driftBalance: info.usdcBalance,
      freeCollateral: info.freeCollateral,
      openOrders,
    };
  } catch (err) {
    console.log(`[Drift] Info error: ${err.message}`);
    return { available: true, position: null, driftBalance: 0, freeCollateral: 0, openOrders: [] };
  }
}

// ─── Limit Order Fill Monitoring ─────────────────────────────────────────────

async function waitForOrderFill(oraclePrice, limitPrice, direction, orderTimeoutMs = ORDER_FILL_TIMEOUT_MS) {
  const d = await getDrift();
  if (!d) return { filled: false, reason: 'drift unavailable' };

  const startTime = Date.now();
  let lastOrderCount = -1;

  while (Date.now() - startTime < orderTimeoutMs) {
    const openOrders = await d.getOpenOrders();

    if (openOrders.length === 0) {
      const fillTimeMs = Date.now() - startTime;
      const fillTimeSec = (fillTimeMs / 1000).toFixed(1);

      // Determine likely fill type based on how fast it filled
      // Instant fills (< 2s) are almost certainly taker fills (crossed the book)
      // Delayed fills (> 5s) are more likely maker fills
      let fillType = 'unknown';
      if (fillTimeMs < 2000) fillType = 'TAKER (instant fill - likely crossed the book)';
      else if (fillTimeMs < 5000) fillType = 'LIKELY_TAKER (fast fill)';
      else fillType = 'LIKELY_MAKER (delayed fill)';

      console.log(`  [Limit] Order filled! (took ${fillTimeSec}s)`);
      console.log(`  [Limit] Fill analysis: ${fillType}`);
      console.log(`  [Limit]   Oracle: $${safe(oraclePrice)} | Our limit: $${safe(limitPrice)} | Direction: ${direction || '?'}`);

      // Get position info after fill to see actual entry price
      try {
        const info = await d.getAccountInfo();
        if (info.position) {
          const entryPrice = Math.abs(info.position.quoteAmount / info.position.baseAmount);
          const spreadPaid = Math.abs(entryPrice - (oraclePrice || entryPrice));
          console.log(`  [Limit]   Entry price: $${safe(entryPrice)} | Spread from oracle: $${safe(spreadPaid, 4)} (${safe(spreadPaid / (oraclePrice || 1) * 100, 3)}%)`);
        }
      } catch (e) {
        // Non-critical, just skip
      }

      return { filled: true, timeMs: fillTimeMs, fillType };
    }

    if (lastOrderCount !== openOrders.length) {
      console.log(`  [Limit] Waiting for fill... ${openOrders.length} open order(s), ${((orderTimeoutMs - (Date.now() - startTime)) / 1000).toFixed(0)}s remaining`);
      lastOrderCount = openOrders.length;
    }

    await new Promise(r => setTimeout(r, ORDER_CHECK_INTERVAL_MS));
  }

  // Timeout — cancel unfilled orders
  console.log(`  [Limit] Order not filled after ${(orderTimeoutMs / 1000).toFixed(0)}s — cancelling...`);
  const cancelTx = await d.cancelAllOrders();
  if (cancelTx) {
    console.log(`  [Limit] Stale orders cancelled`);
  }
  return { filled: false, reason: 'timeout', timeMs: Date.now() - startTime };
}

// ─── USDC Transfer Functions ─────────────────────────────────────────────────

async function transferUSDC(from, toPubkey, amountUSDC) {
  const amountRaw = Math.floor(amountUSDC * 1e6);

  const fromAta = await getAssociatedTokenAddress(USDC_DEVNET_MINT, from.publicKey);
  const toAta = await getAssociatedTokenAddress(USDC_DEVNET_MINT, toPubkey);

  const transaction = new Transaction();

  try {
    await getAccount(connection, toAta);
  } catch {
    transaction.add(
      createAssociatedTokenAccountInstruction(
        from.publicKey, toAta, toPubkey, USDC_DEVNET_MINT,
        TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );
  }

  transaction.add(
    createTransferInstruction(fromAta, toAta, from.publicKey, amountRaw, [], TOKEN_PROGRAM_ID)
  );

  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  transaction.recentBlockhash = blockhash;
  transaction.feePayer = from.publicKey;

  transaction.sign(from);
  const txSig = await connection.sendRawTransaction(transaction.serialize(), {
    skipPreflight: false, maxRetries: 3
  });

  await connection.confirmTransaction(txSig, 'confirmed');
  return txSig;
}

// ─── Trend Analysis & Conviction Scoring ─────────────────────────────────────

function analyzeTrend(priceHistory) {
  if (priceHistory.length < 5) return { trend: 'neutral', strength: 0, momentum: 0, support: null, resistance: null };

  const prices = priceHistory.map(p => p.price);
  const recent = prices.slice(-10);
  const oldest = prices.slice(0, Math.min(5, prices.length));

  // Simple moving averages
  const smaShort = recent.slice(-5).reduce((a, b) => a + b, 0) / Math.min(5, recent.length);
  const smaLong = recent.reduce((a, b) => a + b, 0) / recent.length;

  // Momentum: % change over observation window
  const momentum = (recent[recent.length - 1] - recent[0]) / recent[0] * 100;

  // Trend direction based on SMA crossover
  const smaDiff = ((smaShort - smaLong) / smaLong) * 100;

  // Support/resistance from recent highs/lows
  const support = Math.min(...recent);
  const resistance = Math.max(...recent);
  const currentPrice = recent[recent.length - 1];
  const range = resistance - support;

  // Trend strength: how far from mean, how consistent the direction
  let consecutiveUp = 0, consecutiveDown = 0;
  for (let i = recent.length - 1; i > 0; i--) {
    if (recent[i] > recent[i - 1]) { if (consecutiveDown > 0) break; consecutiveUp++; }
    else if (recent[i] < recent[i - 1]) { if (consecutiveUp > 0) break; consecutiveDown++; }
    else break;
  }

  const trend = smaDiff > 0.1 ? 'bullish' : smaDiff < -0.1 ? 'bearish' : 'neutral';
  const strength = Math.min(100, Math.abs(smaDiff) * 20 + Math.max(consecutiveUp, consecutiveDown) * 10);

  return {
    trend,
    strength: Math.round(strength),
    momentum: Math.round(momentum * 100) / 100,
    support: Math.round(support * 100) / 100,
    resistance: Math.round(resistance * 100) / 100,
    smaShort: Math.round(smaShort * 100) / 100,
    smaLong: Math.round(smaLong * 100) / 100,
    consecutiveUp,
    consecutiveDown,
    priceVsRange: range > 0 ? Math.round(((currentPrice - support) / range) * 100) : 50,
  };
}

// ─── AI Decision Engine ──────────────────────────────────────────────────────

async function askClaude(context) {
  const positionHoldTime = context.positionOpenTime ? ((Date.now() - context.positionOpenTime) / 60000).toFixed(1) : null;
  const cooldownRemaining = context.lastCloseTime ? Math.max(0, (TRADE_COOLDOWN_MS - (Date.now() - context.lastCloseTime)) / 60000).toFixed(1) : null;

  const driftSection = context.driftAvailable ? `
Drift Protocol (Perpetual Futures):
- Drift Account: ${context.driftHasAccount ? 'Active' : 'Not initialized'}
- Drift USDC Balance: ${safe(context.driftBalance)} USDC (collateral)
- Free Collateral: ${safe(context.freeCollateral)} USDC
- Current Position: ${context.driftPosition ? `${context.driftPosition.direction} ${safe(Math.abs(context.driftPosition.baseAmount), 4)} SOL (PnL: $${safe(context.driftPosition.unrealizedPnl)}, held for ${positionHoldTime || '?'}min)` : 'None'}
${cooldownRemaining && cooldownRemaining > 0 ? `- COOLDOWN ACTIVE: ${cooldownRemaining}min remaining — do NOT open new positions yet` : ''}
` : '';

  const driftActions = context.driftAvailable ? `
Perpetual Futures Actions (via Drift Protocol):
- OPEN_SHORT: Open a SHORT position on SOL-PERP (profit when SOL drops). Specify size_usd (1-10) and leverage (1-5).
- CLOSE_SHORT: Close existing short position and realize PnL.
- OPEN_LONG: Open a LONG position on SOL-PERP (profit when SOL rises). Specify size_usd (1-10) and leverage (1-5).
- CLOSE_LONG: Close existing long position and realize PnL.
- DEPOSIT_TO_DRIFT: Deposit USDC from wallet into Drift as collateral. Specify amount.
` : '';

  // Trend analysis
  const trendData = context.trendAnalysis;
  const trendSection = trendData ? `
Trend Analysis:
- Trend: ${trendData.trend} (strength: ${trendData.strength}/100)
- Short-term momentum: ${trendData.momentum}%
- SMA(5): $${trendData.smaShort} | SMA(10): $${trendData.smaLong}
- Support: $${trendData.support} | Resistance: $${trendData.resistance}
- Price in range: ${trendData.priceVsRange}% (0%=at support, 100%=at resistance)
- Consecutive candles: ${trendData.consecutiveUp > 0 ? `${trendData.consecutiveUp} up` : trendData.consecutiveDown > 0 ? `${trendData.consecutiveDown} down` : 'mixed'}
` : '';

  const prompt = `You are an autonomous AI trading agent managing a USDC portfolio on Solana devnet.
Your goal: maximize returns through smart allocation and derivatives trading.

Current State:
- Agent USDC Balance: ${safe(context.agentBalance)} USDC (wallet)
- Treasury USDC Balance: ${safe(context.treasuryBalance)} USDC
- Total USDC: ${safe((context.agentBalance || 0) + (context.treasuryBalance || 0) + (context.driftBalance || 0))} USDC
${driftSection}
Market Data:
- SOL Price: $${safe(context.solPrice)}
- SOL 24h Change: ${safe(context.solChange24h)}%
- Market Cap Change: ${safe(context.marketCapChange)}%
- BTC Dominance: ${safe(context.btcDominance, 1)}%
${trendSection}
Recent Price History (last ${context.priceHistory.length} readings, 2min intervals):
${context.priceHistory.map(p => `  $${safe(p.price)} @ ${formatLT(new Date(p.time))}`).join('\n')}

Recent Trades:
${context.recentTrades.length > 0 ? context.recentTrades.map(t =>
  `  ${t.action} ${safe(t.amount)} USDC | ${t.reason || 'N/A'} @ ${formatLT(new Date(t.time))}`
).join('\n') : '  No trades yet'}

Trading Cycle: ${context.cycle}/${MAX_CYCLES}

Available Actions:

USDC Treasury Management:
- ALLOCATE_TO_TREASURY: Move USDC from agent to treasury (bearish - protect capital)
- WITHDRAW_FROM_TREASURY: Move USDC from treasury to agent (bullish - deploy capital)
- REBALANCE: Move USDC to equalize agent/treasury (neutral - reduce risk)
- HOLD: Do nothing (wait for better opportunity)
${driftActions}
CRITICAL TRADING DISCIPLINE:
1. HOLD is almost always the right answer. Only trade when you have HIGH conviction (70%+) and a clear trend.
2. Positions need TIME to play out. When you open a position, commit to it for AT LEAST 30 minutes.
3. We now use LIMIT ORDERS (not market orders). This drastically reduces spread costs (~$0.05-$0.15 vs old $0.50-$0.70). But still avoid unnecessary churn.
4. A position showing -$0.05 to -$0.15 PnL immediately after opening is the residual limit order fee, not a real loss. IGNORE IT.
5. Do NOT close a position and reopen in the same direction — that still pays fees twice for nothing.
6. Only close a position when: (a) your original thesis is CLEARLY wrong (trend reversed), OR (b) you hit take-profit target (8%+ of collateral), OR (c) you hit stop-loss (-10% of collateral).
7. Small fluctuations within a larger trend are NOISE. A $0.30 bounce in a $5 downtrend is not a reversal.
8. Use the trend analysis data: if trend strength is low and momentum is near 0, HOLD. Don't force trades in choppy markets.
9. If you closed a position recently, WAIT. Don't immediately reopen. The 10-minute cooldown exists for a reason.
10. Think like a swing trader, not a scalper. We check every 2 minutes — that's NOT fast enough for scalping.

Respond ONLY with this JSON (no other text):
{
  "action": "<ACTION_NAME>",
  "amount": <number in USDC for treasury actions, or 0 for perp actions>,
  "size_usd": <number for perp position size, 1-10>,
  "leverage": <number 1-5, default 2>,
  "confidence": <0-100>,
  "reason": "<brief explanation>",
  "market_outlook": "bullish" | "bearish" | "neutral"
}`;

  try {
    const res = await fetch(CLAUDE_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 400,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!res.ok) {
      const err = await res.text();
      console.log(`Claude API error: ${err}`);
      return makeRuleBasedDecision(context);
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content?.trim()
      || data.content?.[0]?.text?.trim();
    if (!content) return makeRuleBasedDecision(context);

    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return makeRuleBasedDecision(context);

    return JSON.parse(jsonMatch[0]);
  } catch (err) {
    console.log(`AI error: ${err.message}, using rule-based fallback`);
    return makeRuleBasedDecision(context);
  }
}

function makeRuleBasedDecision(context) {
  const { agentBalance, treasuryBalance, solChange24h, priceHistory, driftAvailable, driftPosition, freeCollateral } = context;
  const total = agentBalance + treasuryBalance;

  // Calculate momentum
  let momentum = 0;
  if (priceHistory.length >= 3) {
    const recent = priceHistory.slice(-3).map(p => p.price);
    momentum = (recent[2] - recent[0]) / recent[0] * 100;
  }

  // Drift-based decisions (if available)
  if (driftAvailable) {
    // Close position if direction is wrong
    if (driftPosition) {
      if (driftPosition.direction === 'LONG' && (solChange24h < -3 || momentum < -2)) {
        return {
          action: 'CLOSE_LONG', amount: 0, size_usd: 0, leverage: 2, confidence: 75,
          reason: `Closing LONG - market turning bearish (SOL ${safe(solChange24h, 1)}%, momentum ${safe(momentum, 1)}%)`,
          market_outlook: 'bearish'
        };
      }
      if (driftPosition.direction === 'SHORT' && (solChange24h > 3 || momentum > 2)) {
        return {
          action: 'CLOSE_SHORT', amount: 0, size_usd: 0, leverage: 2, confidence: 75,
          reason: `Closing SHORT - market turning bullish (SOL ${safe(solChange24h, 1)}%, momentum ${safe(momentum, 1)}%)`,
          market_outlook: 'bullish'
        };
      }
      // Take profit at 8% of collateral (scales with portfolio)
      const takeProfitUsd = (freeCollateral || 10) * 0.08;
      if (driftPosition.unrealizedPnl > takeProfitUsd) {
        const closeAction = driftPosition.direction === 'LONG' ? 'CLOSE_LONG' : 'CLOSE_SHORT';
        return {
          action: closeAction, amount: 0, size_usd: 0, leverage: 2, confidence: 70,
          reason: `Taking profit: $${safe(driftPosition.unrealizedPnl)} PnL (above ${safe(takeProfitUsd)} = 8% of collateral)`,
          market_outlook: 'neutral'
        };
      }

      // Cut losses at 10% of collateral (scales with portfolio)
      const stopLossUsd = (freeCollateral || 10) * 0.10;
      if (driftPosition.unrealizedPnl < -stopLossUsd) {
        const closeAction = driftPosition.direction === 'LONG' ? 'CLOSE_LONG' : 'CLOSE_SHORT';
        return {
          action: closeAction, amount: 0, size_usd: 0, leverage: 2, confidence: 65,
          reason: `Cutting loss: $${safe(driftPosition.unrealizedPnl)} PnL exceeds -$${safe(stopLossUsd)} stop-loss (10% of collateral)`,
          market_outlook: driftPosition.direction === 'LONG' ? 'bearish' : 'bullish'
        };
      }
    }

    // Open new position if no position and clear signal
    if (!driftPosition && freeCollateral >= MIN_PERP_SIZE_USD) {
      if (solChange24h < -4 || momentum < -2) {
        const size = Math.min(freeCollateral * 0.5, MAX_PERP_SIZE_USD);
        return {
          action: 'OPEN_SHORT', amount: 0, size_usd: size, leverage: 2, confidence: 70,
          reason: `Bearish signal (SOL ${safe(solChange24h, 1)}%, momentum ${safe(momentum, 1)}%) - shorting SOL`,
          market_outlook: 'bearish'
        };
      }
      if (solChange24h > 4 || momentum > 2) {
        const size = Math.min(freeCollateral * 0.5, MAX_PERP_SIZE_USD);
        return {
          action: 'OPEN_LONG', amount: 0, size_usd: size, leverage: 2, confidence: 70,
          reason: `Bullish signal (SOL ${safe(solChange24h, 1)}%, momentum ${safe(momentum, 1)}%) - longing SOL`,
          market_outlook: 'bullish'
        };
      }
    }

    // Deposit to Drift if we have USDC but no collateral
    if (freeCollateral < MIN_PERP_SIZE_USD && agentBalance > 5) {
      const depositAmt = Math.min(agentBalance * 0.3, 10);
      return {
        action: 'DEPOSIT_TO_DRIFT', amount: depositAmt, size_usd: 0, leverage: 2, confidence: 65,
        reason: `Depositing USDC to Drift for perp trading collateral`,
        market_outlook: 'neutral'
      };
    }
  }

  // Fallback: original USDC treasury logic
  if (total < MIN_USDC_TRADE * 2) {
    return { action: 'HOLD', amount: 0, size_usd: 0, leverage: 2, confidence: 50, reason: 'Insufficient balance', market_outlook: 'neutral' };
  }

  const agentRatio = agentBalance / total;

  if (solChange24h < -3 || momentum < -1.5) {
    if (agentBalance > MIN_USDC_TRADE) {
      const amount = Math.min(agentBalance * 0.3, agentBalance - MIN_USDC_TRADE);
      return {
        action: 'ALLOCATE_TO_TREASURY', amount: Math.max(MIN_USDC_TRADE, amount), size_usd: 0, leverage: 2,
        confidence: 70, reason: `Bearish signal (SOL ${safe(solChange24h, 1)}%, momentum ${safe(momentum, 1)}%) - protecting capital`,
        market_outlook: 'bearish'
      };
    }
  }

  if (solChange24h > 3 || momentum > 1.5) {
    if (treasuryBalance > MIN_USDC_TRADE) {
      const amount = Math.min(treasuryBalance * 0.3, treasuryBalance - MIN_USDC_TRADE);
      return {
        action: 'WITHDRAW_FROM_TREASURY', amount: Math.max(MIN_USDC_TRADE, amount), size_usd: 0, leverage: 2,
        confidence: 65, reason: `Bullish signal (SOL ${safe(solChange24h, 1)}%, momentum ${safe(momentum, 1)}%) - deploying capital`,
        market_outlook: 'bullish'
      };
    }
  }

  if (agentRatio > 0.7 || agentRatio < 0.3) {
    const targetAmount = total * 0.5;
    const diff = agentBalance - targetAmount;
    if (Math.abs(diff) > MIN_USDC_TRADE) {
      return {
        action: 'REBALANCE', amount: Math.abs(diff), size_usd: 0, leverage: 2,
        confidence: 60, reason: `Portfolio skewed (agent: ${safe(agentRatio * 100, 0)}%) - rebalancing to 50/50`,
        market_outlook: 'neutral'
      };
    }
  }

  return { action: 'HOLD', amount: 0, size_usd: 0, leverage: 2, confidence: 55, reason: 'No clear signal - maintaining positions', market_outlook: 'neutral' };
}

// ─── State Management ────────────────────────────────────────────────────────

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch {}
  return {
    prices: [],
    trades: [],
    cycle: 0,
    startTime: Date.now(),
    totalTransactions: 0,
    totalVolumeUSDC: 0,
    initialBalance: null,        // Set on first cycle
    balanceHistory: [],          // Track total balance over time
    realizedPnL: 0,             // Accumulated realized P&L from Drift trades
    strategyPnL: 0,             // Strategy P&L: what we'd have made at oracle prices (no spread)
    strategyTrades: [],         // History of strategy-level trade records {direction, oracleOpen, oracleClose, size, pnl}
    currentOpenOracle: null,    // Oracle price when current position was opened
    currentOpenDirection: null, // Direction of current position ('LONG' or 'SHORT')
    currentOpenSize: null,      // Size of current position in SOL
    lastPositionOpenTime: null,  // When the current position was opened
    lastPositionCloseTime: null, // When the last position was closed (for cooldown)
  };
}

function saveState(state) {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function saveDashboardData(state, agentBalance, treasuryBalance, driftInfo) {
  const docsDir = path.join(__dirname, '..', 'docs');
  if (!fs.existsSync(docsDir)) fs.mkdirSync(docsDir, { recursive: true });

  const unrealizedPnL = driftInfo?.position?.unrealizedPnl || 0;
  const totalNow = agentBalance + treasuryBalance + (driftInfo?.driftBalance || 0) + unrealizedPnL;
  const initialBal = state.initialBalance || totalNow;
  const realizedPnL = state.realizedPnL || 0;
  const totalPnL = totalNow - initialBal;

  // Calculate unrealized strategy P&L for current open position
  let unrealizedStrategyPnL = 0;
  if (state.currentOpenOracle && state.currentOpenDirection && state.currentOpenSize) {
    const currentPrice = (state.prices && state.prices.length > 0) ? state.prices[state.prices.length - 1].price : 0;
    if (currentPrice > 0) {
      const priceDiff = currentPrice - state.currentOpenOracle;
      unrealizedStrategyPnL = state.currentOpenDirection === 'LONG' ? priceDiff * state.currentOpenSize : -priceDiff * state.currentOpenSize;
    }
  }

  const dashData = {
    lastUpdated: new Date().toISOString(),
    wallet: wallet.publicKey.toString(),
    treasury: treasuryWallet.publicKey.toString(),
    balances: {
      agent: agentBalance,
      treasury: treasuryBalance,
      total: totalNow
    },
    performance: {
      initialBalance: initialBal,
      currentBalance: totalNow,
      totalPnL: totalPnL,
      totalPnLPercent: initialBal > 0 ? (totalPnL / initialBal * 100) : 0,
      realizedPnL: realizedPnL,
      unrealizedPnL: unrealizedPnL,
      strategyPnL: (state.strategyPnL || 0) + unrealizedStrategyPnL,
      strategyRealizedPnL: state.strategyPnL || 0,
      strategyUnrealizedPnL: unrealizedStrategyPnL,
      strategyTrades: (state.strategyTrades || []).slice(-20),
      spreadCost: (state.realizedPnL || 0) - (state.strategyPnL || 0),
    },
    balanceHistory: (state.balanceHistory || []).slice(-200),
    drift: driftInfo?.available ? {
      balance: driftInfo.driftBalance || 0,
      freeCollateral: driftInfo.freeCollateral || 0,
      position: driftInfo.position || null,
      hasAccount: driftInfo.hasAccount || false,
    } : null,
    stats: {
      totalCycles: state.cycle,
      totalTransactions: state.totalTransactions,
      totalVolumeUSDC: state.totalVolumeUSDC,
      uptime: Date.now() - state.startTime,
      avgCycleTime: state.cycle > 0 ? (Date.now() - state.startTime) / state.cycle : 0
    },
    prices: state.prices.slice(-50),
    trades: state.trades.slice(-50),
    network: 'devnet',
    explorer: `https://explorer.solana.com/address/${wallet.publicKey.toString()}?cluster=devnet`
  };

  fs.writeFileSync(DASHBOARD_DATA, JSON.stringify(dashData, null, 2));
}

// ─── Trade Execution ─────────────────────────────────────────────────────────

async function executeTrade(decision, agentBalance, treasuryBalance, driftInfo, state) {
  let txSig = null;
  let executedAction = decision.action;
  let executedAmount = decision.amount || 0;

  const action = decision.action;
  const now = Date.now();

  // ── Anti-churn guards for Drift trades ──
  if (['CLOSE_SHORT', 'CLOSE_LONG'].includes(action)) {
    // Guard 1: Minimum hold time
    if (state.lastPositionOpenTime) {
      const holdDuration = now - state.lastPositionOpenTime;
      if (holdDuration < MIN_POSITION_HOLD_MS) {
        const remainMin = ((MIN_POSITION_HOLD_MS - holdDuration) / 60000).toFixed(1);
        console.log(`  [Anti-churn] Position held for ${(holdDuration / 60000).toFixed(1)}min — need ${remainMin}min more before closing`);
        return { txSig: null, action: 'HOLD', amount: 0 };
      }
    }

    // Guard 2: Don't close if loss is just the spread (percentage-based)
    if (driftInfo?.position) {
      const pnl = driftInfo.position.unrealizedPnl;
      const positionValue = driftInfo.collateral || driftInfo.position.sizeUsd || 10;
      const spreadToleranceUsd = positionValue * SPREAD_TOLERANCE_PCT;
      if (pnl < 0 && Math.abs(pnl) <= spreadToleranceUsd) {
        console.log(`  [Anti-churn] PnL $${safe(pnl)} is within spread tolerance (${safe(SPREAD_TOLERANCE_PCT * 100, 1)}% of $${safe(positionValue)} = $${safe(spreadToleranceUsd)}). Holding.`);
        return { txSig: null, action: 'HOLD', amount: 0 };
      }
    }
  }

  if (['OPEN_SHORT', 'OPEN_LONG'].includes(action)) {
    // Guard 3: Cooldown after closing
    if (state.lastPositionCloseTime) {
      const timeSinceClose = now - state.lastPositionCloseTime;
      if (timeSinceClose < TRADE_COOLDOWN_MS) {
        const remainMin = ((TRADE_COOLDOWN_MS - timeSinceClose) / 60000).toFixed(1);
        console.log(`  [Anti-churn] Cooldown: ${remainMin}min remaining before opening new position`);
        return { txSig: null, action: 'HOLD', amount: 0 };
      }
    }

    // Guard 4: Don't stack positions — if we already have a position in the same direction, HOLD
    if (driftInfo?.position) {
      const existingDir = driftInfo.position.direction;
      const requestedDir = action === 'OPEN_LONG' ? 'LONG' : 'SHORT';
      if (existingDir === requestedDir) {
        console.log(`  [Anti-churn] Already have a ${existingDir} position. Not stacking.`);
        return { txSig: null, action: 'HOLD', amount: 0 };
      }
    }
  }

  // ── Drift Perpetual Actions ──
  if (['OPEN_SHORT', 'OPEN_LONG', 'CLOSE_SHORT', 'CLOSE_LONG', 'DEPOSIT_TO_DRIFT'].includes(action)) {
    const d = await getDrift();
    if (!d) {
      console.log('  [Drift] Not available, falling back to HOLD');
      return { txSig: null, action: 'HOLD', amount: 0 };
    }

    if (action === 'DEPOSIT_TO_DRIFT') {
      const depositAmt = Math.min(decision.amount || 5, agentBalance * 0.5);
      if (depositAmt < 1) {
        console.log('  [Drift] Insufficient USDC for deposit');
        return { txSig: null, action: 'HOLD', amount: 0 };
      }
      console.log(`\n  [Drift] Depositing ${safe(depositAmt)} USDC as collateral...`);
      try {
        txSig = await d.depositUSDC(depositAmt);
        console.log(`  [Drift] Deposit TX: https://explorer.solana.com/tx/${txSig}?cluster=devnet`);
        executedAmount = depositAmt;
      } catch (err) {
        console.log(`  [Drift] Deposit failed: ${err.message}`);
        return { txSig: null, action: 'FAILED', amount: 0 };
      }
    } else if (action === 'OPEN_SHORT' || action === 'OPEN_LONG') {
      const direction = action === 'OPEN_SHORT' ? 'SHORT' : 'LONG';
      const sizeUsd = Math.min(decision.size_usd || 5, MAX_PERP_SIZE_USD);
      const leverage = Math.min(decision.leverage || DEFAULT_LEVERAGE, 5);

      if (sizeUsd < MIN_PERP_SIZE_USD) {
        console.log('  [Drift] Position size too small');
        return { txSig: null, action: 'HOLD', amount: 0 };
      }

      // Check if we already have a position in the opposite direction
      if (driftInfo?.position) {
        if ((direction === 'SHORT' && driftInfo.position.direction === 'LONG') ||
            (direction === 'LONG' && driftInfo.position.direction === 'SHORT')) {
          console.log(`  [Drift] Closing existing ${driftInfo.position.direction} position first...`);
          try {
            await d.closePosition();
          } catch (err) {
            console.log(`  [Drift] Close failed: ${err.message}`);
          }
        }
      }

      console.log(`\n  [Drift] Opening ${direction} (LIMIT ORDER): $${safe(sizeUsd)} @ ${leverage}x leverage`);
      try {
        const result = await d.openPosition(direction, sizeUsd, leverage);
        txSig = result.txSig;
        const limitPriceUsd = result.price * (direction === 'LONG' ? 1.001 : 0.999);
        console.log(`  [Drift] Limit order placed: https://explorer.solana.com/tx/${txSig}?cluster=devnet`);
        console.log(`  [Drift] Oracle: $${safe(result.price)}, Limit: $${safe(limitPriceUsd)}, Size: ${safe(result.baseAmount, 4)} SOL`);

        // Wait for limit order to fill
        const fillResult = await waitForOrderFill(result.price, limitPriceUsd, direction);
        if (!fillResult.filled) {
          console.log(`  [Drift] Order not filled — no position opened`);
          return { txSig, action: 'HOLD', amount: 0 };
        }
        executedAmount = sizeUsd;
      } catch (err) {
        console.log(`  [Drift] Open position failed: ${err.message}`);
        return { txSig: null, action: 'FAILED', amount: 0 };
      }
    } else if (action === 'CLOSE_SHORT' || action === 'CLOSE_LONG') {
      if (!driftInfo?.position) {
        console.log('  [Drift] No position to close');
        return { txSig: null, action: 'HOLD', amount: 0 };
      }
      console.log(`\n  [Drift] Closing ${driftInfo.position.direction} (LIMIT ORDER) (PnL: $${safe(driftInfo.position.unrealizedPnl)})`);
      try {
        const result = await d.closePosition();
        if (result) {
          txSig = result.txSig;
          const closeDir = driftInfo.position.direction === 'LONG' ? 'SELL' : 'BUY_BACK';
          console.log(`  [Drift] Close limit order placed: https://explorer.solana.com/tx/${txSig}?cluster=devnet`);
          console.log(`  [Drift] Oracle: $${safe(result.oraclePrice)}, Limit: $${safe(result.limitPrice)}, Dir: ${closeDir}`);

          // Wait for limit order to fill
          const fillResult = await waitForOrderFill(result.oraclePrice, result.limitPrice, closeDir);
          if (!fillResult.filled) {
            console.log(`  [Drift] Close order not filled — position still open`);
            return { txSig, action: 'HOLD', amount: 0 };
          }
          executedAmount = Math.abs(result.pnl || 0);
          console.log(`  [Drift] Realized PnL: $${safe(result.pnl)}`);
        }
      } catch (err) {
        console.log(`  [Drift] Close position failed: ${err.message}`);
        return { txSig: null, action: 'FAILED', amount: 0 };
      }
    }

    return { txSig, action: executedAction, amount: executedAmount };
  }

  // ── USDC Treasury Actions (original logic) ──
  if (action === 'HOLD' || (executedAmount || 0) < MIN_USDC_TRADE) {
    console.log(`\n  HOLD - No trade executed`);
    return { txSig: null, action: 'HOLD', amount: 0 };
  }

  if (action === 'ALLOCATE_TO_TREASURY') {
    const maxAmount = Math.min(executedAmount, agentBalance * MAX_USDC_TRADE_PCT, agentBalance - MIN_USDC_TRADE);
    if (maxAmount >= MIN_USDC_TRADE) {
      executedAmount = Math.round(maxAmount * 100) / 100;
      console.log(`\n  Transferring ${executedAmount} USDC -> Treasury`);
      try {
        txSig = await transferUSDC(wallet, treasuryWallet.publicKey, executedAmount);
        console.log(`  TX: https://explorer.solana.com/tx/${txSig}?cluster=devnet`);
      } catch (err) {
        console.log(`  Transfer failed: ${err.message}`);
        return { txSig: null, action: 'FAILED', amount: 0 };
      }
    } else {
      return { txSig: null, action: 'HOLD', amount: 0 };
    }
  } else if (action === 'WITHDRAW_FROM_TREASURY') {
    const maxAmount = Math.min(executedAmount, treasuryBalance * MAX_USDC_TRADE_PCT, treasuryBalance - MIN_USDC_TRADE);
    if (maxAmount >= MIN_USDC_TRADE) {
      executedAmount = Math.round(maxAmount * 100) / 100;
      console.log(`\n  Withdrawing ${executedAmount} USDC <- Treasury`);
      try {
        txSig = await transferUSDC(treasuryWallet, wallet.publicKey, executedAmount);
        console.log(`  TX: https://explorer.solana.com/tx/${txSig}?cluster=devnet`);
      } catch (err) {
        console.log(`  Withdrawal failed: ${err.message}`);
        return { txSig: null, action: 'FAILED', amount: 0 };
      }
    } else {
      return { txSig: null, action: 'HOLD', amount: 0 };
    }
  } else if (action === 'REBALANCE') {
    const total = agentBalance + treasuryBalance;
    const target = total / 2;
    const diff = agentBalance - target;
    if (Math.abs(diff) >= MIN_USDC_TRADE) {
      executedAmount = Math.round(Math.abs(diff) * 100) / 100;
      const from = diff > 0 ? wallet : treasuryWallet;
      const to = diff > 0 ? treasuryWallet.publicKey : wallet.publicKey;
      const dir = diff > 0 ? '->' : '<-';
      console.log(`\n  Rebalancing: ${executedAmount} USDC ${dir} Treasury`);
      try {
        txSig = await transferUSDC(from, to, executedAmount);
        console.log(`  TX: https://explorer.solana.com/tx/${txSig}?cluster=devnet`);
      } catch (err) {
        console.log(`  Rebalance failed: ${err.message}`);
        return { txSig: null, action: 'FAILED', amount: 0 };
      }
    } else {
      return { txSig: null, action: 'HOLD', amount: 0 };
    }
  }

  return { txSig, action: executedAction, amount: executedAmount };
}

// ─── Main Trading Loop ───────────────────────────────────────────────────────

async function tradingCycle(state) {
  state.cycle++;
  const cycleStart = Date.now();

  console.log(`\n${'='.repeat(60)}`);
  console.log(`  Cycle ${state.cycle}/${MAX_CYCLES} | ${formatLT()}`);
  console.log(`${'='.repeat(60)}`);

  // 0. Cancel any stale/unfilled limit orders from previous cycles
  const dPre = await getDrift();
  if (dPre) {
    const staleOrders = await dPre.getOpenOrders();
    if (staleOrders.length > 0) {
      console.log(`  [Limit] Found ${staleOrders.length} stale open order(s) — cancelling...`);
      await dPre.cancelAllOrders();
    }
  }

  // 1. Gather market data + Drift info
  const [solData, sentiment, driftInfo] = await Promise.all([
    getSOLPrice(),
    getMarketSentiment(),
    getDriftInfo()
  ]);

  state.prices.push({ time: Date.now(), price: solData.price });
  if (state.prices.length > 200) state.prices = state.prices.slice(-200);

  console.log(`  SOL: $${safe(solData.price)} (${solData.change24h >= 0 ? '+' : ''}${safe(solData.change24h)}%)`);

  // 2. Get balances
  const [agentBalance, treasuryBalance, agentSOL] = await Promise.all([
    getUSDCBalance(wallet.publicKey),
    getUSDCBalance(treasuryWallet.publicKey),
    getSOLBalance(wallet.publicKey)
  ]);

  const driftUnrealizedPnL = driftInfo.position?.unrealizedPnl || 0;
  const totalBalance = agentBalance + treasuryBalance + (driftInfo.driftBalance || 0) + driftUnrealizedPnL;

  // Track initial balance on first cycle
  if (state.initialBalance === null || state.initialBalance === undefined) {
    state.initialBalance = totalBalance;
    console.log(`  Initial balance recorded: ${safe(totalBalance)} USDC`);
  }

  // Track balance history (every cycle)
  state.balanceHistory = state.balanceHistory || [];
  state.balanceHistory.push({ time: Date.now(), total: totalBalance, agent: agentBalance, treasury: treasuryBalance, drift: (driftInfo.driftBalance || 0) + driftUnrealizedPnL });
  if (state.balanceHistory.length > 500) state.balanceHistory = state.balanceHistory.slice(-500);

  console.log(`  Agent:    ${safe(agentBalance)} USDC | ${safe(agentSOL, 4)} SOL`);
  console.log(`  Treasury: ${safe(treasuryBalance)} USDC`);
  console.log(`  Total:    ${safe(totalBalance)} USDC`);

  if (driftInfo.available) {
    console.log(`  [Drift]   ${safe(driftInfo.driftBalance)} USDC collateral | Free: ${safe(driftInfo.freeCollateral)}`);
    if (driftInfo.position) {
      console.log(`  [Drift]   Position: ${driftInfo.position.direction} ${safe(Math.abs(driftInfo.position.baseAmount), 4)} SOL | PnL: $${safe(driftInfo.position.unrealizedPnl)}`);
    }
  }

  // 3. Build context for AI
  const trendAnalysis = analyzeTrend(state.prices.slice(-20));
  const context = {
    agentBalance,
    treasuryBalance,
    solPrice: solData.price,
    solChange24h: solData.change24h,
    marketCapChange: sentiment.marketCapChange,
    btcDominance: sentiment.btcDominance,
    priceHistory: state.prices.slice(-20),
    recentTrades: state.trades.slice(-10),
    cycle: state.cycle,
    driftAvailable: driftInfo.available,
    driftHasAccount: driftInfo.hasAccount,
    driftPosition: driftInfo.position,
    driftBalance: driftInfo.driftBalance || 0,
    freeCollateral: driftInfo.freeCollateral || 0,
    positionOpenTime: state.lastPositionOpenTime,
    lastCloseTime: state.lastPositionCloseTime,
    trendAnalysis,
  };

  if (trendAnalysis.trend !== 'neutral') {
    console.log(`  Trend:    ${trendAnalysis.trend} (strength: ${trendAnalysis.strength}, momentum: ${trendAnalysis.momentum}%)`);
  }

  // 4. Get AI decision
  console.log(`\n  Analyzing...`);
  const decision = await askClaude(context);

  console.log(`  Decision: ${decision.action}`);
  if (decision.amount > 0) console.log(`  Amount:   ${safe(decision.amount)} USDC`);
  if (decision.size_usd > 0) console.log(`  Size:     $${decision.size_usd} @ ${decision.leverage || 2}x`);
  console.log(`  Outlook:  ${decision.market_outlook}`);
  console.log(`  Confidence: ${decision.confidence}%`);
  console.log(`  Reason:   ${decision.reason}`);

  // 5. Execute trade (pass state for anti-churn guards)
  const result = await executeTrade(decision, agentBalance, treasuryBalance, driftInfo, state);

  // 6. Record trade
  const trade = {
    time: Date.now(),
    cycle: state.cycle,
    action: result.action,
    amount: result.amount,
    txSig: result.txSig,
    confidence: decision.confidence,
    reason: decision.reason,
    market_outlook: decision.market_outlook,
    solPrice: solData.price,
    agentBalance,
    treasuryBalance,
    driftPosition: driftInfo.position ? {
      direction: driftInfo.position.direction,
      size: Math.abs(driftInfo.position.baseAmount),
      pnl: driftInfo.position.unrealizedPnl
    } : null,
  };

  state.trades.push(trade);
  if (state.trades.length > 500) state.trades = state.trades.slice(-500);

  if (result.txSig) {
    state.totalTransactions++;
    state.totalVolumeUSDC += result.amount;
  }

  // Track position open/close times for anti-churn
  if (['OPEN_SHORT', 'OPEN_LONG'].includes(result.action) && result.txSig) {
    state.lastPositionOpenTime = Date.now();
    // Record oracle price at open for strategy P&L tracking
    state.currentOpenOracle = solData.price;
    state.currentOpenDirection = result.action === 'OPEN_LONG' ? 'LONG' : 'SHORT';
    state.currentOpenSize = driftInfo.position ? Math.abs(driftInfo.position.baseAmount) : (decision.size_usd / solData.price);
    console.log(`  Position opened — hold timer started (min ${MIN_POSITION_HOLD_MS / 60000}min)`);
    console.log(`  [Strategy] Recorded oracle open: $${safe(solData.price)} ${state.currentOpenDirection} ${safe(state.currentOpenSize, 4)} SOL`);
  }
  if (['CLOSE_SHORT', 'CLOSE_LONG'].includes(result.action) && result.txSig) {
    state.lastPositionCloseTime = Date.now();
    state.lastPositionOpenTime = null;

    // ── Strategy P&L: calculate what we'd have made at oracle prices (no spread) ──
    state.strategyPnL = state.strategyPnL || 0;
    state.strategyTrades = state.strategyTrades || [];
    const oracleClose = solData.price;
    const oracleOpen = state.currentOpenOracle;
    const dir = state.currentOpenDirection;
    const size = state.currentOpenSize || (driftInfo.position ? Math.abs(driftInfo.position.baseAmount) : 0);

    if (oracleOpen && dir && size > 0) {
      const priceDiff = oracleClose - oracleOpen;
      const stratPnl = dir === 'LONG' ? priceDiff * size : -priceDiff * size;
      state.strategyPnL += stratPnl;

      state.strategyTrades.push({
        time: Date.now(),
        direction: dir,
        oracleOpen,
        oracleClose,
        size,
        pnl: stratPnl,
      });
      if (state.strategyTrades.length > 100) state.strategyTrades = state.strategyTrades.slice(-100);

      console.log(`  [Strategy] Oracle open: $${safe(oracleOpen)} → close: $${safe(oracleClose)} | ${dir} ${safe(size, 4)} SOL`);
      console.log(`  [Strategy] Strategy P&L this trade: $${safe(stratPnl, 4)} | Cumulative: $${safe(state.strategyPnL, 4)}`);
    } else {
      console.log(`  [Strategy] No oracle open price recorded — skipping strategy P&L for this close`);
    }

    // Clear the open position tracking
    state.currentOpenOracle = null;
    state.currentOpenDirection = null;
    state.currentOpenSize = null;

    console.log(`  Position closed — cooldown started (${TRADE_COOLDOWN_MS / 60000}min before next open)`);
  }

  // Track realized P&L from Drift position closes (execution P&L — includes spread)
  state.realizedPnL = state.realizedPnL || 0;
  if (['CLOSE_SHORT', 'CLOSE_LONG'].includes(result.action) && result.txSig) {
    const closePnl = driftInfo.position?.unrealizedPnl || 0;
    state.realizedPnL += closePnl;
    console.log(`  Realized (execution) P&L from close: $${safe(closePnl, 4)} (cumulative: $${safe(state.realizedPnL, 4)})`);
  }

  // 7. Save state and dashboard
  saveState(state);
  const [newAgentBal, newTreasuryBal] = await Promise.all([
    getUSDCBalance(wallet.publicKey),
    getUSDCBalance(treasuryWallet.publicKey)
  ]);
  const newDriftInfo = await getDriftInfo();
  saveDashboardData(state, newAgentBal, newTreasuryBal, newDriftInfo);

  const cycleTime = Date.now() - cycleStart;
  console.log(`\n  Cycle completed in ${(cycleTime / 1000).toFixed(1)}s`);

  return state;
}

// ─── Main Entry Point ────────────────────────────────────────────────────────

async function main() {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║              USDC AGENTIC TRADER                             ║
║     Autonomous AI + USDC + Drift Perps on Solana Devnet      ║
║                                                              ║
║     Proving: AI agents + USDC > humans + USDC                ║
╚══════════════════════════════════════════════════════════════╝
  `);

  // Initialize wallets
  wallet = loadWallet();
  treasuryWallet = loadOrCreateTreasury();

  console.log(`Agent wallet:    ${wallet.publicKey.toString()}`);
  console.log(`Treasury wallet: ${treasuryWallet.publicKey.toString()}`);
  console.log(`Network:         Solana Devnet`);
  console.log(`AI Model:        ${CLAUDE_MODEL} (with rule-based fallback)`);
  console.log(`Interval:        ${TRADE_INTERVAL_MS / 1000}s between cycles`);
  console.log(`Features:        USDC Treasury + Drift Perpetuals (SHORT/LONG)`);

  // Check initial balances
  const [agentUSDC, treasuryUSDC, agentSOL] = await Promise.all([
    getUSDCBalance(wallet.publicKey),
    getUSDCBalance(treasuryWallet.publicKey),
    getSOLBalance(wallet.publicKey)
  ]);

  console.log(`\nInitial Balances:`);
  console.log(`  Agent:    ${safe(agentUSDC)} USDC | ${safe(agentSOL, 4)} SOL`);
  console.log(`  Treasury: ${safe(treasuryUSDC)} USDC`);

  if (agentUSDC < MIN_USDC_TRADE && treasuryUSDC < MIN_USDC_TRADE) {
    console.log(`\nLow USDC balance. Get devnet USDC from https://faucet.circle.com/`);
    console.log(`   Wallet address: ${wallet.publicKey.toString()}`);
    console.log(`   The agent will still run and make decisions (HOLD until funded).`);
  }

  if (agentSOL < 0.01) {
    console.log(`\nLow SOL balance. Requesting airdrop...`);
    try {
      const sig = await connection.requestAirdrop(wallet.publicKey, 2 * LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig, 'confirmed');
      console.log('   Airdrop successful! +2 SOL');
    } catch (err) {
      console.log(`   Airdrop failed: ${err.message}`);
    }
  }

  // Fund treasury with SOL for fees if needed
  const treasurySOL = await getSOLBalance(treasuryWallet.publicKey);
  if (treasurySOL < 0.01) {
    console.log(`\n  Funding treasury with SOL for transaction fees...`);
    try {
      const sig = await connection.requestAirdrop(treasuryWallet.publicKey, LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig, 'confirmed');
      console.log('   Treasury airdrop successful! +1 SOL');
    } catch {
      try {
        const tx = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: wallet.publicKey,
            toPubkey: treasuryWallet.publicKey,
            lamports: 0.1 * LAMPORTS_PER_SOL
          })
        );
        const { blockhash } = await connection.getLatestBlockhash('confirmed');
        tx.recentBlockhash = blockhash;
        tx.feePayer = wallet.publicKey;
        tx.sign(wallet);
        const sig = await connection.sendRawTransaction(tx.serialize());
        await connection.confirmTransaction(sig, 'confirmed');
        console.log('   Sent 0.1 SOL to treasury for fees');
      } catch (err) {
        console.log(`   Warning: Could not fund treasury: ${err.message}`);
      }
    }
  }

  // Try to initialize Drift early
  console.log(`\nInitializing Drift Protocol...`);
  const d = await getDrift();
  if (d) {
    const driftInfo = await getDriftInfo();
    console.log(`  Drift: Connected`);
    if (driftInfo.hasAccount) {
      console.log(`  Drift USDC: ${safe(driftInfo.driftBalance)} | Free Collateral: ${safe(driftInfo.freeCollateral)}`);
      if (driftInfo.position) {
        console.log(`  Position: ${driftInfo.position.direction} ${safe(Math.abs(driftInfo.position.baseAmount), 4)} SOL`);
      }
    } else {
      console.log(`  Drift account not yet initialized (will init on first deposit)`);
    }
  } else {
    console.log(`  Drift: Not available (agent will use USDC treasury management only)`);
  }

  // Load or initialize state
  let state = loadState();

  console.log(`\nStarting trading loop...`);
  console.log(`${'─'.repeat(60)}`);

  // Trading loop
  for (let i = 0; i < MAX_CYCLES; i++) {
    try {
      state = await tradingCycle(state);
    } catch (err) {
      console.error(`\n  Cycle error: ${err.message}`);
      saveState(state);
    }

    if (i < MAX_CYCLES - 1) {
      console.log(`\n  Next cycle in ${TRADE_INTERVAL_MS / 1000}s...`);
      await new Promise(r => setTimeout(r, TRADE_INTERVAL_MS));
    }
  }

  // Cleanup
  if (drift) {
    await drift.shutdown();
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`  Trading session complete.`);
  console.log(`  Total cycles: ${state.cycle}`);
  console.log(`  Total transactions: ${state.totalTransactions}`);
  console.log(`  Total volume: ${safe(state.totalVolumeUSDC)} USDC`);
  console.log(`${'='.repeat(60)}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
