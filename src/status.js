/**
 * Quick status check for the agent
 */

const fs = require('fs');
const path = require('path');

const DASHBOARD_DATA = path.join(__dirname, '..', 'docs', 'data.json');
const STATE_FILE = path.join(__dirname, '..', 'logs', 'agent-state.json');

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ${s % 60}s`;
}

function main() {
  if (!fs.existsSync(DASHBOARD_DATA) && !fs.existsSync(STATE_FILE)) {
    console.log('No agent data found. Run: npm start');
    return;
  }

  let data;
  if (fs.existsSync(DASHBOARD_DATA)) {
    data = JSON.parse(fs.readFileSync(DASHBOARD_DATA, 'utf8'));
  } else {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    data = { stats: state, trades: state.trades, balances: { agent: 0, treasury: 0, total: 0 } };
  }

  console.log('=== USDC Agentic Trader Status ===\n');
  console.log(`Last Updated:  ${data.lastUpdated || 'N/A'}`);
  console.log(`Agent Wallet:  ${data.wallet || 'N/A'}`);
  console.log(`Treasury:      ${data.treasury || 'N/A'}`);
  console.log('');
  console.log('Balances:');
  console.log(`  Agent:    ${data.balances.agent?.toFixed(2) || 0} USDC`);
  console.log(`  Treasury: ${data.balances.treasury?.toFixed(2) || 0} USDC`);
  console.log(`  Total:    ${data.balances.total?.toFixed(2) || 0} USDC`);
  console.log('');
  console.log('Stats:');
  console.log(`  Cycles:       ${data.stats.totalCycles || 0}`);
  console.log(`  Transactions: ${data.stats.totalTransactions || 0}`);
  console.log(`  Volume:       ${data.stats.totalVolumeUSDC?.toFixed(2) || 0} USDC`);
  console.log(`  Uptime:       ${data.stats.uptime ? formatUptime(data.stats.uptime) : 'N/A'}`);

  if (data.trades && data.trades.length > 0) {
    console.log('');
    console.log('Recent Trades:');
    data.trades.slice(-5).forEach(t => {
      const time = new Date(t.time).toLocaleTimeString();
      console.log(`  [${time}] ${t.action} ${t.amount?.toFixed(2) || 0} USDC | ${t.reason || ''}`);
      if (t.txSig) console.log(`    TX: https://explorer.solana.com/tx/${t.txSig}?cluster=devnet`);
    });
  }
}

main();
