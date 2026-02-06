/**
 * Faucet & Balance Checker
 * Gets devnet SOL and checks USDC balances
 */

const { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } = require('@solana/web3.js');
const { getAssociatedTokenAddress, getAccount } = require('@solana/spl-token');
const bs58 = require('bs58').default;
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), override: true });

// Devnet USDC mint address (Circle's official devnet USDC)
const USDC_DEVNET_MINT = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
const DEVNET_RPC = process.env.SOLANA_RPC || 'https://api.devnet.solana.com';

async function checkBalances() {
  const connection = new Connection(DEVNET_RPC, 'confirmed');

  const privateKey = process.env.SOLANA_PRIVATE_KEY;
  if (!privateKey) {
    console.log('No wallet found. Run: npm run setup');
    return;
  }

  const secretKey = bs58.decode(privateKey);
  const wallet = Keypair.fromSecretKey(secretKey);

  console.log('=== Wallet Balances (Devnet) ===\n');
  console.log(`Address: ${wallet.publicKey.toString()}`);
  console.log(`Explorer: https://explorer.solana.com/address/${wallet.publicKey.toString()}?cluster=devnet\n`);

  // SOL balance
  const solBalance = await connection.getBalance(wallet.publicKey);
  console.log(`SOL:  ${(solBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);

  // USDC balance
  try {
    const usdcAta = await getAssociatedTokenAddress(USDC_DEVNET_MINT, wallet.publicKey);
    const tokenAccount = await getAccount(connection, usdcAta);
    const usdcBalance = Number(tokenAccount.amount) / 1e6;
    console.log(`USDC: ${usdcBalance.toFixed(2)} USDC`);
    console.log(`\nUSDC Token Account: ${usdcAta.toString()}`);
  } catch (err) {
    console.log('USDC: 0.00 USDC (no token account yet)');
    console.log('\nGet devnet USDC:');
    console.log(`  1. Go to https://faucet.circle.com/`);
    console.log(`  2. Select "Solana Devnet"`);
    console.log(`  3. Paste address: ${wallet.publicKey.toString()}`);
    console.log(`  4. Request USDC`);
  }

  // Request more SOL if low
  if (solBalance < LAMPORTS_PER_SOL) {
    console.log('\nSOL balance low. Requesting airdrop...');
    try {
      const sig = await connection.requestAirdrop(wallet.publicKey, 2 * LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig, 'confirmed');
      console.log('Airdrop successful! +2 SOL');
    } catch (err) {
      console.log(`Airdrop failed (rate limited): ${err.message}`);
    }
  }
}

checkBalances().catch(console.error);
