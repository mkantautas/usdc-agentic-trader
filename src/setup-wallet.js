/**
 * Wallet Setup for USDC Agentic Trader
 * Generates a new Solana devnet keypair and requests SOL airdrop
 */

const { Keypair, Connection, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const bs58 = require('bs58').default;
const fs = require('fs');
const path = require('path');

const DEVNET_RPC = 'https://api.devnet.solana.com';

async function setup() {
  console.log('=== USDC Agentic Trader - Wallet Setup ===\n');

  // Check if .env already exists
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    console.log('.env file already exists. Reading existing wallet...');
    require('dotenv').config({ path: envPath });

    if (process.env.SOLANA_PRIVATE_KEY) {
      const secretKey = bs58.decode(process.env.SOLANA_PRIVATE_KEY);
      const wallet = Keypair.fromSecretKey(secretKey);
      console.log(`Existing wallet: ${wallet.publicKey.toString()}`);

      const connection = new Connection(DEVNET_RPC, 'confirmed');
      const balance = await connection.getBalance(wallet.publicKey);
      console.log(`Balance: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);

      if (balance < LAMPORTS_PER_SOL) {
        console.log('\nRequesting SOL airdrop...');
        try {
          const sig = await connection.requestAirdrop(wallet.publicKey, 2 * LAMPORTS_PER_SOL);
          await connection.confirmTransaction(sig, 'confirmed');
          console.log('Airdrop successful! +2 SOL');
        } catch (err) {
          console.log(`Airdrop failed (rate limited?): ${err.message}`);
          console.log('Try again later or use https://faucet.solana.com/');
        }
      }
      return;
    }
  }

  // Generate new keypair
  const wallet = Keypair.generate();
  const privateKeyB58 = bs58.encode(wallet.secretKey);

  console.log(`New wallet generated!`);
  console.log(`Public Key:  ${wallet.publicKey.toString()}`);
  console.log(`Private Key: ${privateKeyB58.slice(0, 8)}...`);

  // Save to .env
  const envContent = `# USDC Agentic Trader - Solana Devnet
SOLANA_PRIVATE_KEY=${privateKeyB58}
SOLANA_RPC=https://api.devnet.solana.com
ANTHROPIC_API_KEY=\${ANTHROPIC_API_KEY}
`;

  fs.writeFileSync(envPath, envContent);
  console.log(`\nSaved to ${envPath}`);

  // Request airdrop
  const connection = new Connection(DEVNET_RPC, 'confirmed');
  console.log('\nRequesting SOL airdrop (2 SOL)...');
  try {
    const sig = await connection.requestAirdrop(wallet.publicKey, 2 * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig, 'confirmed');
    const balance = await connection.getBalance(wallet.publicKey);
    console.log(`Airdrop successful! Balance: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  } catch (err) {
    console.log(`Airdrop failed: ${err.message}`);
    console.log('Visit https://faucet.solana.com/ to manually airdrop SOL');
  }

  console.log('\n=== Next Steps ===');
  console.log('1. Get devnet USDC from https://faucet.circle.com/');
  console.log('2. Run: npm run fund  (to check balances)');
  console.log('3. Run: npm start     (to launch the agent)');
}

setup().catch(console.error);
