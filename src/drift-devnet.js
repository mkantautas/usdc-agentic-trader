/**
 * Drift Protocol Integration - Devnet
 * Handles perpetual futures (long/short) on Solana devnet via Drift Protocol
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), override: true });

// Resolve Drift SDK and dependencies from root project to avoid version conflicts
const ROOT_MODULES = path.join(__dirname, '..', '..', 'node_modules');
const { Connection, Keypair, PublicKey } = require(path.join(ROOT_MODULES, '@solana', 'web3.js'));
const { Wallet } = require(path.join(ROOT_MODULES, '@coral-xyz', 'anchor'));
const {
  DriftClient,
  PositionDirection,
  MarketType,
  BASE_PRECISION,
  QUOTE_PRECISION,
  convertToNumber,
  getMarketOrderParams,
  initialize,
  BN,
} = require(path.join(ROOT_MODULES, '@drift-labs', 'sdk'));
const bs58 = require('bs58').default;

// Config
const DEVNET_RPC = process.env.SOLANA_RPC || 'https://api.devnet.solana.com';
const SOL_MARKET_INDEX = 0; // SOL-PERP
const MAX_LEVERAGE = 5;     // Conservative for hackathon demo

let driftClient = null;
let isInitialized = false;
let initPromise = null;

function getKeypair() {
  const privateKey = process.env.SOLANA_PRIVATE_KEY;
  if (!privateKey) throw new Error('SOLANA_PRIVATE_KEY not set');
  return Keypair.fromSecretKey(bs58.decode(privateKey));
}

async function initializeDrift() {
  // Prevent multiple concurrent initializations
  if (isInitialized && driftClient) return driftClient;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      const connection = new Connection(DEVNET_RPC, 'confirmed');
      const keypair = getKeypair();
      const wallet = new Wallet(keypair);

      const sdkConfig = initialize({ env: 'devnet' });

      driftClient = new DriftClient({
        connection,
        wallet,
        programID: new PublicKey(sdkConfig.DRIFT_PROGRAM_ID),
        env: 'devnet',
        accountSubscription: {
          type: 'websocket',
        },
      });

      await driftClient.subscribe();
      isInitialized = true;
      console.log('[Drift] Client initialized on devnet');
      return driftClient;
    } catch (err) {
      initPromise = null;
      throw err;
    }
  })();

  return initPromise;
}

async function getAccountInfo() {
  const client = await initializeDrift();

  try {
    const user = client.getUser();

    const usdcBalance = convertToNumber(
      user.getSpotMarketBalance(0),
      QUOTE_PRECISION
    );
    const freeCollateral = convertToNumber(
      user.getFreeCollateral(),
      QUOTE_PRECISION
    );

    const solPerpPosition = user.getPerpPosition(SOL_MARKET_INDEX);

    let position = null;
    if (solPerpPosition && !solPerpPosition.baseAssetAmount.isZero()) {
      position = {
        baseAmount: convertToNumber(solPerpPosition.baseAssetAmount, BASE_PRECISION),
        quoteAmount: convertToNumber(solPerpPosition.quoteAssetAmount, QUOTE_PRECISION),
        direction: solPerpPosition.baseAssetAmount.gt(new BN(0)) ? 'LONG' : 'SHORT',
        unrealizedPnl: convertToNumber(
          user.getUnrealizedPNL(true, SOL_MARKET_INDEX),
          QUOTE_PRECISION
        ),
      };
    }

    return {
      usdcBalance,
      freeCollateral,
      position,
      hasAccount: true,
    };
  } catch (err) {
    if (err.message && (err.message.includes('User account not found') || err.message.includes('has no user'))) {
      return {
        usdcBalance: 0,
        freeCollateral: 0,
        position: null,
        hasAccount: false,
      };
    }
    throw err;
  }
}

async function initializeUserAccount() {
  const client = await initializeDrift();
  console.log('[Drift] Initializing user account...');
  const [txSig] = await client.initializeUserAccount();
  console.log(`[Drift] Account created: https://explorer.solana.com/tx/${txSig}?cluster=devnet`);
  await client.subscribe();
  return txSig;
}

async function depositUSDC(amount) {
  const client = await initializeDrift();

  // Check if user exists
  try {
    client.getUser();
  } catch (err) {
    if (err.message && err.message.includes('has no user')) {
      await initializeUserAccount();
    } else {
      throw err;
    }
  }

  const marketIndex = 0; // USDC
  const spotPrecision = client.convertToSpotPrecision(marketIndex, amount);
  const associatedTokenAccount = await client.getAssociatedTokenAccount(marketIndex);

  console.log(`[Drift] Depositing $${amount} USDC as collateral...`);
  const txSig = await client.deposit(
    spotPrecision,
    marketIndex,
    associatedTokenAccount,
  );
  console.log(`[Drift] Deposit TX: https://explorer.solana.com/tx/${txSig}?cluster=devnet`);
  return txSig;
}

async function openPosition(direction, sizeUsd, leverage = 2) {
  const client = await initializeDrift();

  if (leverage > MAX_LEVERAGE) {
    throw new Error(`Leverage ${leverage}x exceeds max ${MAX_LEVERAGE}x`);
  }

  // Get SOL price from oracle
  const solMarket = client.getPerpMarketAccount(SOL_MARKET_INDEX);
  const oraclePrice = convertToNumber(
    solMarket.amm.historicalOracleData.lastOraclePrice,
    QUOTE_PRECISION
  );

  // Calculate base amount
  const baseAmount = (sizeUsd / oraclePrice) * BASE_PRECISION.toNumber();

  const orderParams = getMarketOrderParams({
    marketIndex: SOL_MARKET_INDEX,
    direction: direction === 'LONG' ? PositionDirection.LONG : PositionDirection.SHORT,
    baseAssetAmount: new BN(Math.floor(baseAmount)),
    marketType: MarketType.PERP,
  });

  console.log(`[Drift] Opening ${direction}: $${sizeUsd} (${(sizeUsd / oraclePrice).toFixed(4)} SOL) @ ${leverage}x`);
  const txSig = await client.placePerpOrder(orderParams);
  console.log(`[Drift] TX: https://explorer.solana.com/tx/${txSig}?cluster=devnet`);

  return {
    txSig,
    direction,
    sizeUsd,
    baseAmount: sizeUsd / oraclePrice,
    price: oraclePrice,
    leverage,
  };
}

async function closePosition() {
  const client = await initializeDrift();
  const info = await getAccountInfo();

  if (!info.position) {
    console.log('[Drift] No open position to close');
    return null;
  }

  const pos = info.position;
  const closeDirection = pos.direction === 'LONG' ? PositionDirection.SHORT : PositionDirection.LONG;
  const baseAmount = Math.abs(pos.baseAmount * BASE_PRECISION.toNumber());

  const orderParams = getMarketOrderParams({
    marketIndex: SOL_MARKET_INDEX,
    direction: closeDirection,
    baseAssetAmount: new BN(Math.floor(baseAmount)),
    marketType: MarketType.PERP,
    reduceOnly: true,
  });

  console.log(`[Drift] Closing ${pos.direction}: ${Math.abs(pos.baseAmount).toFixed(4)} SOL (PnL: $${pos.unrealizedPnl.toFixed(2)})`);
  const txSig = await client.placePerpOrder(orderParams);
  console.log(`[Drift] TX: https://explorer.solana.com/tx/${txSig}?cluster=devnet`);

  return {
    txSig,
    closedDirection: pos.direction,
    closedAmount: Math.abs(pos.baseAmount),
    pnl: pos.unrealizedPnl,
  };
}

async function getMarketInfo() {
  const client = await initializeDrift();
  const solMarket = client.getPerpMarketAccount(SOL_MARKET_INDEX);

  const oraclePrice = convertToNumber(
    solMarket.amm.historicalOracleData.lastOraclePrice,
    QUOTE_PRECISION
  );
  const fundingRate = convertToNumber(
    solMarket.amm.lastFundingRate,
    QUOTE_PRECISION
  ) * 100;

  return {
    price: oraclePrice,
    fundingRate,
    openInterest: convertToNumber(
      solMarket.amm.baseAssetAmountLong.add(solMarket.amm.baseAssetAmountShort.abs()),
      BASE_PRECISION
    ),
  };
}

async function shutdown() {
  if (driftClient) {
    try {
      await driftClient.unsubscribe();
    } catch {}
    driftClient = null;
    isInitialized = false;
    initPromise = null;
  }
}

module.exports = {
  initializeDrift,
  getAccountInfo,
  initializeUserAccount,
  depositUSDC,
  openPosition,
  closePosition,
  getMarketInfo,
  shutdown,
};
