#!/usr/bin/env node
/**
 * Load sample data for development
 * Usage: node load-sample-data.js [--symbols=10] [--exchanges=3]
 */

const { Pool } = require('pg');
const redis = require('ioredis');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config({ path: path.join(__dirname, '..', '.env') });

// Parse command line arguments
const args = process.argv.slice(2);
let symbolCount = 10;
let exchangeCount = 3;

for (const arg of args) {
  if (arg.startsWith('--symbols=')) {
    symbolCount = parseInt(arg.split('=')[1], 10);
  } else if (arg.startsWith('--exchanges=')) {
    exchangeCount = parseInt(arg.split('=')[1], 10);
  }
}

console.log(`Loading sample data with ${symbolCount} symbols across ${exchangeCount} exchanges...`);

// Database connection parameters
const pgConfig = {
  host: process.env.POSTGRES_HOST || 'localhost',
  port: process.env.POSTGRES_PORT || 5432,
  user: process.env.POSTGRES_USER || 'quantum',
  password: process.env.POSTGRES_PASSWORD || 'quantum',
  database: process.env.POSTGRES_DB || 'quantum_users'
};

const tsConfig = {
  host: process.env.TIMESCALEDB_HOST || 'localhost',
  port: process.env.TIMESCALEDB_PORT || 5433,
  user: process.env.TIMESCALEDB_USER || 'quantum',
  password: process.env.TIMESCALEDB_PASSWORD || 'quantum',
  database: process.env.TIMESCALEDB_DB || 'market_data'
};

const redisConfig = {
  host: process.env.REDIS_HOST || 'localhost',
  port: process.env.REDIS_PORT || 6379,
  password: process.env.REDIS_PASSWORD || ''
};

// Create database connections
const pgPool = new Pool(pgConfig);
const tsPool = new Pool(tsConfig);
const redisClient = new redis(redisConfig);

// Sample data
const exchanges = ['BINANCE', 'COINBASE', 'KRAKEN', 'HUOBI', 'KUCOIN'];
const baseAssets = ['BTC', 'ETH', 'SOL', 'AVAX', 'DOT', 'ADA', 'MATIC', 'LINK', 'DOGE', 'XRP'];
const quoteAssets = ['USDT', 'USDC', 'USD', 'ETH', 'BTC'];

/**
 * Generate sample symbols
 */
function generateSymbols(count) {
  const symbols = [];
  for (let i = 0; i < count; i++) {
    const baseAsset = baseAssets[i % baseAssets.length];
    const quoteAsset = quoteAssets[i % quoteAssets.length];
    symbols.push(`${baseAsset}-${quoteAsset}`);
  }
  return symbols;
}

/**
 * Generate a random price
 */
function getRandomPrice(baseAsset) {
  switch (baseAsset) {
    case 'BTC': return 30000 + Math.random() * 10000;
    case 'ETH': return 2000 + Math.random() * 500;
    case 'SOL': return 50 + Math.random() * 30;
    case 'AVAX': return 20 + Math.random() * 10;
    case 'DOT': return 10 + Math.random() * 5;
    case 'ADA': return 0.3 + Math.random() * 0.2;
    case 'MATIC': return 0.8 + Math.random() * 0.4;
    case 'LINK': return 10 + Math.random() * 5;
    case 'DOGE': return 0.08 + Math.random() * 0.04;
    case 'XRP': return 0.5 + Math.random() * 0.2;
    default: return 1 + Math.random() * 10;
  }
}

/**
 * Generate order book
 */
function generateOrderBook(symbol, midPrice) {
  const [baseAsset] = symbol.split('-');
  const bids = [];
  const asks = [];
  
  // Generate bids (below mid price)
  for (let i = 0; i < 20; i++) {
    const price = midPrice * (1 - 0.0001 * (i + 1) - Math.random() * 0.0001);
    const quantity = Math.random() * 10;
    bids.push([price, quantity]);
  }
  
  // Generate asks (above mid price)
  for (let i = 0; i < 20; i++) {
    const price = midPrice * (1 + 0.0001 * (i + 1) + Math.random() * 0.0001);
    const quantity = Math.random() * 10;
    asks.push([price, quantity]);
  }
  
  // Sort bids (descending) and asks (ascending)
  bids.sort((a, b) => b[0] - a[0]);
  asks.sort((a, b) => a[0] - b[0]);
  
  return { bids, asks };
}

/**
 * Generate trades
 */
function generateTrades(symbol, price, count = 100) {
  const trades = [];
  const [baseAsset] = symbol.split('-');
  
  for (let i = 0; i < count; i++) {
    const tradePrice = price * (1 - 0.005 + Math.random() * 0.01);
    const quantity = Math.random() * 2;
    const side = Math.random() > 0.5 ? 'buy' : 'sell';
    
    trades.push({
      id: `trade_${Date.now()}_${i}`,
      price: tradePrice,
      quantity,
      side,
      timestamp: Date.now() - Math.floor(Math.random() * 3600000) // Within the last hour
    });
  }
  
  return trades;
}

/**
 * Generate candles
 */
function generateCandles(symbol, price, timeframe = '1h', count = 24) {
  const candles = [];
  const [baseAsset] = symbol.split('-');
  const now = Date.now();
  const interval = timeframe === '1h' ? 3600000 : 300000;
  
  let currentPrice = price * 0.9;
  
  for (let i = 0; i < count; i++) {
    const timestamp = now - (count - i) * interval;
    const movement = 0.98 + Math.random() * 0.04; // -2% to +2%
    currentPrice *= movement;
    
    const open = currentPrice;
    const close = currentPrice * (0.998 + Math.random() * 0.004); // -0.2% to +0.2%
    const high = Math.max(open, close) * (1 + Math.random() * 0.01); // Up to 1% higher
    const low = Math.min(open, close) * (1 - Math.random() * 0.01); // Up to 1% lower
    const volume = Math.random() * 100;
    
    candles.push({
      timestamp,
      open,
      high,
      low,
      close,
      volume
    });
  }
  
  return candles;
}

/**
 * Create a test user
 */
async function createTestUser(pgPool) {
  try {
    // Create test user
    const userResult = await pgPool.query(`
      INSERT INTO users (
        uuid, username, email, password_hash, first_name, last_name, 
        tier, created_at, updated_at, status, email_verified
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
      ) ON CONFLICT (username) DO NOTHING
      RETURNING id
    `, [
      'test-user-uuid',
      'testuser',
      'test@example.com',
      '$2b$10$EpRnTzVlqHNP0.fUbXUwSOyuiXe/QLSUG6xNekdHgTGmrpHEfIoxm', // 'password123'
      'Test',
      'User',
      'premium',
      new Date(),
      new Date(),
      'active',
      true
    ]);
    
    // Create API key
    if (userResult.rows.length > 0) {
      const userId = userResult.rows[0].id;
      
      await pgPool.query(`
        INSERT INTO api_keys (
          user_id, key_name, api_key, api_secret, permissions, created_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6
        ) ON CONFLICT DO NOTHING
      `, [
        userId,
        'Test API Key',
        'test-api-key',
        'test-api-secret',
        ['read', 'trade'],
        new Date()
      ]);
      
      console.log(`Created test user 'testuser' with password 'password123'`);
    } else {
      console.log(`Test user already exists`);
    }
  } catch (error) {
    console.error('Error creating test user:', error);
  }
}

/**
 * Load sample data
 */
async function loadSampleData() {
  try {
    console.log('Connecting to databases...');
    
    // Create test user
    await createTestUser(pgPool);
    
    // Generate symbols
    const symbols = generateSymbols(symbolCount);
    
    // Select exchanges
    const selectedExchanges = exchanges.slice(0, exchangeCount);
    
    console.log(`Loading sample data for symbols: ${symbols.join(', ')}`);
    console.log(`Using exchanges: ${selectedExchanges.join(', ')}`);
    
    // For each exchange and symbol
    for (const exchange of selectedExchanges) {
      for (const symbol of symbols) {
        const [baseAsset, quoteAsset] = symbol.split('-');
        
        // Generate a price
        const price = getRandomPrice(baseAsset);
        
        // Generate order book
        const orderBook = generateOrderBook(symbol, price);
        
        // Generate trades
        const trades = generateTrades(symbol, price);
        
        // Generate candles
        const candles1h = generateCandles(symbol, price, '1h', 24);
        
        // Store order book in Redis
        await redisClient.set(
          `orderbook:${exchange}:${symbol}`,
          JSON.stringify({
            venue: exchange,
            symbol,
            bids: orderBook.bids,
            asks: orderBook.asks,
            timestamp: Date.now(),
            lastUpdateId: Date.now()
          })
        );
        
        // Store in TimescaleDB
        // 1. Order book snapshot
        await tsPool.query(`
          INSERT INTO order_book_snapshots (
            time, venue, symbol, bids, asks, mid_price, spread, bids_sum, asks_sum, last_update_id, source
          ) VALUES (
            NOW(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
          )
        `, [
          exchange,
          symbol,
          JSON.stringify(orderBook.bids),
          JSON.stringify(orderBook.asks),
          price,
          orderBook.asks[0][0] - orderBook.bids[0][0],
          orderBook.bids.reduce((sum, [price, qty]) => sum + qty, 0),
          orderBook.asks.reduce((sum, [price, qty]) => sum + qty, 0),
          Date.now(),
          'sample_data'
        ]);
        
        // 2. Trades
        for (const trade of trades.slice(0, 20)) {
          await tsPool.query(`
            INSERT INTO trades (
              time, venue, symbol, trade_id, price, quantity, side
            ) VALUES (
              TO_TIMESTAMP($1 / 1000.0), $2, $3, $4, $5, $6, $7
            )
          `, [
            trade.timestamp,
            exchange,
            symbol,
            trade.id,
            trade.price,
            trade.quantity,
            trade.side
          ]);
        }
        
        // 3. OHLCV data
        for (const candle of candles1h) {
          await tsPool.query(`
            INSERT INTO ohlcv (
              time, venue, symbol, timeframe, open, high, low, close, volume
            ) VALUES (
              TO_TIMESTAMP($1 / 1000.0), $2, $3, $4, $5, $6, $7, $8, $9
            )
          `, [
            candle.timestamp,
            exchange,
            symbol,
            '1h',
            candle.open,
            candle.high,
            candle.low,
            candle.close,
            candle.volume
          ]);
        }
        
        console.log(`Loaded sample data for ${exchange}:${symbol}`);
      }
    }
    
    console.log('Sample data loaded successfully!');
  } catch (error) {
    console.error('Error loading sample data:', error);
  } finally {
    // Close connections
    await pgPool.end();
    await tsPool.end();
    await redisClient.quit();
  }
}

// Run the data loading
loadSampleData();