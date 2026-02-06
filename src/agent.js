/**
 * USDC Agentic Trader
 *
 * An autonomous AI agent that manages a USDC portfolio on Solana devnet.
 * Uses Claude to analyze market data and make trading decisions.
 *
 * Architecture:
 *   Market Data → AI Analysis → Decision → Execute USDC Transfer → Log → Repeat
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
  getOrCreateAssociatedTokenAccount
} = require('@solana/spl-token');
const bs58 = require('bs58').default;
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), override: true });

// ─── Configuration ───────────────────────────────────────────────────────────

const DEVNET_RPC = process.env.SOLANA_RPC || 'https://api.devnet.solana.com';
const USDC_DEVNET_MINT = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
const CLAUDE_API = process.env.CLAUDE_API_URL || 'http://localhost:8317/v1/chat/completions';
const CLAUDE_MODEL = 'claude-sonnet-4-20250514';

// Trading parameters
const TRADE_INTERVAL_MS = 30_000; // 30 seconds between decisions
const MAX_CYCLES = 200;           // Max trading cycles per run
const MIN_USDC_TRADE = 0.5;      // Minimum trade size in USDC
const MAX_USDC_TRADE_PCT = 0.25; // Max 25% of balance per trade

// Paths
const LOG_DIR = path.join(__dirname, '..', 'logs');
const STATE_FILE = path.join(LOG_DIR, 'agent-state.json');
const TRADE_LOG = path.join(LOG_DIR, 'trades.json');
const DASHBOARD_DATA = path.join(__dirname, '..', 'docs', 'data.json');

// ─── Globals ─────────────────────────────────────────────────────────────────

const connection = new Connection(DEVNET_RPC, 'confirmed');
let wallet;
let treasuryWallet; // Second wallet for agent-to-agent transfers

// ─── Market Data (simulated with real price feeds) ───────────────────────────

async function getSOLPrice() {
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd&include_24hr_change=true');
    const data = await res.json();
    return {
      price: data.solana.usd,
      change24h: data.solana.usd_24h_change
    };
  } catch {
    // Fallback: use a slightly randomized price for demo purposes
    const basePrice = 200;
    const variance = (Math.random() - 0.5) * 20;
    return { price: basePrice + variance, change24h: variance / basePrice * 100 };
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
  // Generate treasury wallet (simulates another agent/service)
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

// ─── USDC Transfer Functions ─────────────────────────────────────────────────

async function transferUSDC(from, toPubkey, amountUSDC) {
  const amountRaw = Math.floor(amountUSDC * 1e6);

  const fromAta = await getAssociatedTokenAddress(USDC_DEVNET_MINT, from.publicKey);
  const toAta = await getAssociatedTokenAddress(USDC_DEVNET_MINT, toPubkey);

  const transaction = new Transaction();

  // Check if destination ATA exists, create if needed
  try {
    await getAccount(connection, toAta);
  } catch {
    transaction.add(
      createAssociatedTokenAccountInstruction(
        from.publicKey,
        toAta,
        toPubkey,
        USDC_DEVNET_MINT,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );
  }

  // Add transfer instruction
  transaction.add(
    createTransferInstruction(
      fromAta,
      toAta,
      from.publicKey,
      amountRaw,
      [],
      TOKEN_PROGRAM_ID
    )
  );

  // Get recent blockhash
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  transaction.recentBlockhash = blockhash;
  transaction.feePayer = from.publicKey;

  // Sign and send
  transaction.sign(from);
  const txSig = await connection.sendRawTransaction(transaction.serialize(), {
    skipPreflight: false,
    maxRetries: 3
  });

  await connection.confirmTransaction(txSig, 'confirmed');
  return txSig;
}

// ─── AI Decision Engine ──────────────────────────────────────────────────────

async function askClaude(context) {
  const prompt = `You are an autonomous AI trading agent managing a USDC treasury on Solana devnet.
Your goal: maximize returns through smart allocation between USDC (stable) and market exposure.

Current State:
- Agent USDC Balance: ${context.agentBalance.toFixed(2)} USDC
- Treasury USDC Balance: ${context.treasuryBalance.toFixed(2)} USDC
- Total USDC: ${(context.agentBalance + context.treasuryBalance).toFixed(2)} USDC

Market Data:
- SOL Price: $${context.solPrice.toFixed(2)}
- SOL 24h Change: ${context.solChange24h.toFixed(2)}%
- Market Cap Change: ${context.marketCapChange.toFixed(2)}%
- BTC Dominance: ${context.btcDominance.toFixed(1)}%

Recent Price History (last ${context.priceHistory.length} readings):
${context.priceHistory.map(p => `  $${p.price.toFixed(2)} @ ${new Date(p.time).toLocaleTimeString()}`).join('\n')}

Recent Trades:
${context.recentTrades.length > 0 ? context.recentTrades.map(t =>
  `  ${t.action} ${t.amount.toFixed(2)} USDC | ${t.reason} @ ${new Date(t.time).toLocaleTimeString()}`
).join('\n') : '  No trades yet'}

Trading Cycle: ${context.cycle}/${MAX_CYCLES}

Strategy Guidelines:
- ALLOCATE_TO_TREASURY: Move USDC from agent to treasury (bearish - protect capital)
- WITHDRAW_FROM_TREASURY: Move USDC from treasury to agent (bullish - deploy capital)
- REBALANCE: Move USDC to equalize agent/treasury (neutral - reduce risk)
- HOLD: Do nothing (wait for better opportunity)

Respond ONLY with this JSON (no other text):
{
  "action": "ALLOCATE_TO_TREASURY" | "WITHDRAW_FROM_TREASURY" | "REBALANCE" | "HOLD",
  "amount": <number in USDC>,
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
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!res.ok) {
      const err = await res.text();
      console.log(`Claude API error: ${err}`);
      return makeRuleBasedDecision(context);
    }

    const data = await res.json();
    // Handle both OpenAI-compatible and Anthropic response formats
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
  const { agentBalance, treasuryBalance, solChange24h, priceHistory } = context;
  const total = agentBalance + treasuryBalance;

  if (total < MIN_USDC_TRADE * 2) {
    return { action: 'HOLD', amount: 0, confidence: 50, reason: 'Insufficient balance', market_outlook: 'neutral' };
  }

  // Calculate momentum from price history
  let momentum = 0;
  if (priceHistory.length >= 3) {
    const recent = priceHistory.slice(-3).map(p => p.price);
    momentum = (recent[2] - recent[0]) / recent[0] * 100;
  }

  const agentRatio = agentBalance / total;

  // Bearish: protect capital
  if (solChange24h < -3 || momentum < -1.5) {
    if (agentBalance > MIN_USDC_TRADE) {
      const amount = Math.min(agentBalance * 0.3, agentBalance - MIN_USDC_TRADE);
      return {
        action: 'ALLOCATE_TO_TREASURY',
        amount: Math.max(MIN_USDC_TRADE, amount),
        confidence: 70,
        reason: `Bearish signal (SOL ${solChange24h.toFixed(1)}%, momentum ${momentum.toFixed(1)}%) - protecting capital`,
        market_outlook: 'bearish'
      };
    }
  }

  // Bullish: deploy capital
  if (solChange24h > 3 || momentum > 1.5) {
    if (treasuryBalance > MIN_USDC_TRADE) {
      const amount = Math.min(treasuryBalance * 0.3, treasuryBalance - MIN_USDC_TRADE);
      return {
        action: 'WITHDRAW_FROM_TREASURY',
        amount: Math.max(MIN_USDC_TRADE, amount),
        confidence: 65,
        reason: `Bullish signal (SOL ${solChange24h.toFixed(1)}%, momentum ${momentum.toFixed(1)}%) - deploying capital`,
        market_outlook: 'bullish'
      };
    }
  }

  // Rebalance if skewed
  if (agentRatio > 0.7 || agentRatio < 0.3) {
    const targetAmount = total * 0.5;
    const diff = agentBalance - targetAmount;
    if (Math.abs(diff) > MIN_USDC_TRADE) {
      return {
        action: 'REBALANCE',
        amount: Math.abs(diff),
        confidence: 60,
        reason: `Portfolio skewed (agent: ${(agentRatio * 100).toFixed(0)}%) - rebalancing to 50/50`,
        market_outlook: 'neutral'
      };
    }
  }

  return {
    action: 'HOLD',
    amount: 0,
    confidence: 55,
    reason: 'No clear signal - maintaining positions',
    market_outlook: 'neutral'
  };
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
    totalVolumeUSDC: 0
  };
}

function saveState(state) {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function saveDashboardData(state, agentBalance, treasuryBalance) {
  const docsDir = path.join(__dirname, '..', 'docs');
  if (!fs.existsSync(docsDir)) fs.mkdirSync(docsDir, { recursive: true });

  const dashData = {
    lastUpdated: new Date().toISOString(),
    wallet: wallet.publicKey.toString(),
    treasury: treasuryWallet.publicKey.toString(),
    balances: {
      agent: agentBalance,
      treasury: treasuryBalance,
      total: agentBalance + treasuryBalance
    },
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

// ─── Main Trading Loop ───────────────────────────────────────────────────────

async function tradingCycle(state) {
  state.cycle++;
  const cycleStart = Date.now();

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  Cycle ${state.cycle}/${MAX_CYCLES} | ${new Date().toLocaleTimeString()}`);
  console.log(`${'═'.repeat(60)}`);

  // 1. Gather market data
  const [solData, sentiment] = await Promise.all([
    getSOLPrice(),
    getMarketSentiment()
  ]);

  state.prices.push({ time: Date.now(), price: solData.price });
  if (state.prices.length > 200) state.prices = state.prices.slice(-200);

  console.log(`  SOL: $${solData.price.toFixed(2)} (${solData.change24h >= 0 ? '+' : ''}${solData.change24h.toFixed(2)}%)`);

  // 2. Get balances
  const [agentBalance, treasuryBalance, agentSOL] = await Promise.all([
    getUSDCBalance(wallet.publicKey),
    getUSDCBalance(treasuryWallet.publicKey),
    getSOLBalance(wallet.publicKey)
  ]);

  console.log(`  Agent:    ${agentBalance.toFixed(2)} USDC | ${agentSOL.toFixed(4)} SOL`);
  console.log(`  Treasury: ${treasuryBalance.toFixed(2)} USDC`);
  console.log(`  Total:    ${(agentBalance + treasuryBalance).toFixed(2)} USDC`);

  // 3. Build context for AI
  const context = {
    agentBalance,
    treasuryBalance,
    solPrice: solData.price,
    solChange24h: solData.change24h,
    marketCapChange: sentiment.marketCapChange,
    btcDominance: sentiment.btcDominance,
    priceHistory: state.prices.slice(-20),
    recentTrades: state.trades.slice(-10),
    cycle: state.cycle
  };

  // 4. Get AI decision
  console.log(`\n  🤖 Analyzing...`);
  const decision = await askClaude(context);

  console.log(`  Decision: ${decision.action}`);
  console.log(`  Amount:   ${decision.amount.toFixed(2)} USDC`);
  console.log(`  Outlook:  ${decision.market_outlook}`);
  console.log(`  Confidence: ${decision.confidence}%`);
  console.log(`  Reason:   ${decision.reason}`);

  // 5. Execute trade
  let txSig = null;
  let executedAction = decision.action;
  let executedAmount = decision.amount;

  if (decision.action === 'HOLD' || decision.amount < MIN_USDC_TRADE) {
    console.log(`\n  ⏸️  HOLD - No trade executed`);
    executedAction = 'HOLD';
    executedAmount = 0;
  } else if (decision.action === 'ALLOCATE_TO_TREASURY') {
    const maxAmount = Math.min(decision.amount, agentBalance * MAX_USDC_TRADE_PCT, agentBalance - MIN_USDC_TRADE);
    if (maxAmount >= MIN_USDC_TRADE) {
      executedAmount = Math.round(maxAmount * 100) / 100;
      console.log(`\n  📤 Transferring ${executedAmount} USDC → Treasury`);
      try {
        txSig = await transferUSDC(wallet, treasuryWallet.publicKey, executedAmount);
        console.log(`  ✅ TX: https://explorer.solana.com/tx/${txSig}?cluster=devnet`);
      } catch (err) {
        console.log(`  ❌ Transfer failed: ${err.message}`);
        executedAction = 'FAILED';
      }
    } else {
      console.log(`  ⚠️  Insufficient balance for transfer`);
      executedAction = 'HOLD';
      executedAmount = 0;
    }
  } else if (decision.action === 'WITHDRAW_FROM_TREASURY') {
    const maxAmount = Math.min(decision.amount, treasuryBalance * MAX_USDC_TRADE_PCT, treasuryBalance - MIN_USDC_TRADE);
    if (maxAmount >= MIN_USDC_TRADE) {
      executedAmount = Math.round(maxAmount * 100) / 100;
      console.log(`\n  📥 Withdrawing ${executedAmount} USDC ← Treasury`);
      try {
        txSig = await transferUSDC(treasuryWallet, wallet.publicKey, executedAmount);
        console.log(`  ✅ TX: https://explorer.solana.com/tx/${txSig}?cluster=devnet`);
      } catch (err) {
        console.log(`  ❌ Withdrawal failed: ${err.message}`);
        executedAction = 'FAILED';
      }
    } else {
      console.log(`  ⚠️  Insufficient treasury balance`);
      executedAction = 'HOLD';
      executedAmount = 0;
    }
  } else if (decision.action === 'REBALANCE') {
    const total = agentBalance + treasuryBalance;
    const target = total / 2;
    const diff = agentBalance - target;
    if (Math.abs(diff) >= MIN_USDC_TRADE) {
      executedAmount = Math.round(Math.abs(diff) * 100) / 100;
      if (diff > 0) {
        // Agent has more, send to treasury
        console.log(`\n  ⚖️  Rebalancing: ${executedAmount} USDC → Treasury`);
        try {
          txSig = await transferUSDC(wallet, treasuryWallet.publicKey, executedAmount);
          console.log(`  ✅ TX: https://explorer.solana.com/tx/${txSig}?cluster=devnet`);
        } catch (err) {
          console.log(`  ❌ Rebalance failed: ${err.message}`);
          executedAction = 'FAILED';
        }
      } else {
        // Treasury has more, withdraw to agent
        console.log(`\n  ⚖️  Rebalancing: ${executedAmount} USDC ← Treasury`);
        try {
          txSig = await transferUSDC(treasuryWallet, wallet.publicKey, executedAmount);
          console.log(`  ✅ TX: https://explorer.solana.com/tx/${txSig}?cluster=devnet`);
        } catch (err) {
          console.log(`  ❌ Rebalance failed: ${err.message}`);
          executedAction = 'FAILED';
        }
      }
    } else {
      console.log(`  ⏸️  Already balanced`);
      executedAction = 'HOLD';
      executedAmount = 0;
    }
  }

  // 6. Record trade
  const trade = {
    time: Date.now(),
    cycle: state.cycle,
    action: executedAction,
    amount: executedAmount,
    txSig,
    confidence: decision.confidence,
    reason: decision.reason,
    market_outlook: decision.market_outlook,
    solPrice: solData.price,
    agentBalance,
    treasuryBalance
  };

  state.trades.push(trade);
  if (state.trades.length > 500) state.trades = state.trades.slice(-500);

  if (txSig) {
    state.totalTransactions++;
    state.totalVolumeUSDC += executedAmount;
  }

  // 7. Save state and dashboard
  saveState(state);
  const [newAgentBal, newTreasuryBal] = await Promise.all([
    getUSDCBalance(wallet.publicKey),
    getUSDCBalance(treasuryWallet.publicKey)
  ]);
  saveDashboardData(state, newAgentBal, newTreasuryBal);

  const cycleTime = Date.now() - cycleStart;
  console.log(`\n  Cycle completed in ${(cycleTime / 1000).toFixed(1)}s`);

  return state;
}

// ─── Main Entry Point ────────────────────────────────────────────────────────

async function main() {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║                  USDC AGENTIC TRADER                        ║
║         Autonomous AI + USDC on Solana Devnet               ║
║                                                              ║
║  Proving: AI agents + USDC > humans + USDC                  ║
╚══════════════════════════════════════════════════════════════╝
  `);

  // Initialize wallets
  wallet = loadWallet();
  treasuryWallet = loadOrCreateTreasury();

  console.log(`Agent wallet:    ${wallet.publicKey.toString()}`);
  console.log(`Treasury wallet: ${treasuryWallet.publicKey.toString()}`);
  console.log(`Network:         Solana Devnet`);
  console.log(`AI Model:        ${ANTHROPIC_API_KEY ? CLAUDE_MODEL : 'Rule-based (no API key)'}`);
  console.log(`Interval:        ${TRADE_INTERVAL_MS / 1000}s between cycles`);

  // Check initial balances
  const [agentUSDC, treasuryUSDC, agentSOL] = await Promise.all([
    getUSDCBalance(wallet.publicKey),
    getUSDCBalance(treasuryWallet.publicKey),
    getSOLBalance(wallet.publicKey)
  ]);

  console.log(`\nInitial Balances:`);
  console.log(`  Agent:    ${agentUSDC.toFixed(2)} USDC | ${agentSOL.toFixed(4)} SOL`);
  console.log(`  Treasury: ${treasuryUSDC.toFixed(2)} USDC`);

  if (agentUSDC < MIN_USDC_TRADE && treasuryUSDC < MIN_USDC_TRADE) {
    console.log(`\n⚠️  Low USDC balance. Get devnet USDC from https://faucet.circle.com/`);
    console.log(`   Wallet address: ${wallet.publicKey.toString()}`);
    console.log(`   The agent will still run and make decisions (HOLD until funded).`);
  }

  if (agentSOL < 0.01) {
    console.log(`\n⚠️  Low SOL balance. Requesting airdrop...`);
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
      // Try airdrop first
      const sig = await connection.requestAirdrop(treasuryWallet.publicKey, LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig, 'confirmed');
      console.log('   Treasury airdrop successful! +1 SOL');
    } catch {
      // Transfer from agent wallet
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

  // Load or initialize state
  let state = loadState();

  console.log(`\nStarting trading loop...`);
  console.log(`${'─'.repeat(60)}`);

  // Trading loop
  for (let i = 0; i < MAX_CYCLES; i++) {
    try {
      state = await tradingCycle(state);
    } catch (err) {
      console.error(`\n  ❌ Cycle error: ${err.message}`);
      saveState(state);
    }

    // Wait for next cycle
    if (i < MAX_CYCLES - 1) {
      console.log(`\n  ⏳ Next cycle in ${TRADE_INTERVAL_MS / 1000}s...`);
      await new Promise(r => setTimeout(r, TRADE_INTERVAL_MS));
    }
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  Trading session complete.`);
  console.log(`  Total cycles: ${state.cycle}`);
  console.log(`  Total transactions: ${state.totalTransactions}`);
  console.log(`  Total volume: ${state.totalVolumeUSDC.toFixed(2)} USDC`);
  console.log(`${'═'.repeat(60)}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
