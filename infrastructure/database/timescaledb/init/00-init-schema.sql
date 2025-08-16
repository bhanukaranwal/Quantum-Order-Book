-- Connect to market_data database
\c market_data;

-- Enable TimescaleDB extension
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- Create order book snapshots table
CREATE TABLE order_book_snapshots (
    time TIMESTAMPTZ NOT NULL,
    venue TEXT NOT NULL,
    symbol TEXT NOT NULL,
    bids JSONB NOT NULL,
    asks JSONB NOT NULL,
    mid_price NUMERIC NOT NULL,
    spread NUMERIC NOT NULL,
    bids_sum NUMERIC NOT NULL,
    asks_sum NUMERIC NOT NULL,
    last_update_id BIGINT NOT NULL,
    source TEXT NOT NULL
);

-- Convert to hypertable
SELECT create_hypertable('order_book_snapshots', 'time');

-- Create index on venue, symbol
CREATE INDEX idx_order_book_snapshots_venue_symbol ON order_book_snapshots(venue, symbol);

-- Create trades table
CREATE TABLE trades (
    time TIMESTAMPTZ NOT NULL,
    venue TEXT NOT NULL,
    symbol TEXT NOT NULL,
    trade_id TEXT NOT NULL,
    price NUMERIC NOT NULL,
    quantity NUMERIC NOT NULL,
    side TEXT NOT NULL,
    buyer TEXT,
    seller TEXT,
    is_maker BOOLEAN,
    is_best_match BOOLEAN,
    is_liquidation BOOLEAN DEFAULT FALSE
);

-- Convert to hypertable
SELECT create_hypertable('trades', 'time');

-- Create index on venue, symbol
CREATE INDEX idx_trades_venue_symbol ON trades(venue, symbol);
CREATE INDEX idx_trades_trade_id ON trades(trade_id);

-- Create technical indicators table
CREATE TABLE technical_indicators (
    time TIMESTAMPTZ NOT NULL,
    venue TEXT NOT NULL,
    symbol TEXT NOT NULL,
    timeframe TEXT NOT NULL,
    indicator TEXT NOT NULL,
    value NUMERIC NOT NULL,
    parameters JSONB
);

-- Convert to hypertable
SELECT create_hypertable('technical_indicators', 'time');

-- Create index on venue, symbol, indicator
CREATE INDEX idx_technical_indicators_venue_symbol_indicator ON technical_indicators(venue, symbol, indicator);

-- Create OHLCV table for candlestick data
CREATE TABLE ohlcv (
    time TIMESTAMPTZ NOT NULL,
    venue TEXT NOT NULL,
    symbol TEXT NOT NULL,
    timeframe TEXT NOT NULL,
    open NUMERIC NOT NULL,
    high NUMERIC NOT NULL,
    low NUMERIC NOT NULL,
    close NUMERIC NOT NULL,
    volume NUMERIC NOT NULL,
    trade_count INTEGER,
    vwap NUMERIC
);

-- Convert to hypertable
SELECT create_hypertable('ohlcv', 'time');

-- Create index on venue, symbol, timeframe
CREATE INDEX idx_ohlcv_venue_symbol_timeframe ON ohlcv(venue, symbol, timeframe);

-- Create volatility metrics table
CREATE TABLE volatility_metrics (
    time TIMESTAMPTZ NOT NULL,
    venue TEXT NOT NULL,
    symbol TEXT NOT NULL,
    timeframe TEXT NOT NULL,
    historical_volatility NUMERIC NOT NULL,
    implied_volatility NUMERIC,
    rsi NUMERIC,
    bollinger_upper NUMERIC,
    bollinger_lower NUMERIC,
    atr NUMERIC
);

-- Convert to hypertable
SELECT create_hypertable('volatility_metrics', 'time');

-- Create index on venue, symbol, timeframe
CREATE INDEX idx_volatility_metrics_venue_symbol_timeframe ON volatility_metrics(venue, symbol, timeframe);

-- Create market depth metrics table
CREATE TABLE market_depth_metrics (
    time TIMESTAMPTZ NOT NULL,
    venue TEXT NOT NULL,
    symbol TEXT NOT NULL,
    bid_ask_ratio NUMERIC NOT NULL,
    book_imbalance NUMERIC NOT NULL,
    depth_1pct NUMERIC NOT NULL,
    depth_2pct NUMERIC NOT NULL,
    depth_5pct NUMERIC NOT NULL,
    weighted_mid_price NUMERIC NOT NULL,
    top_level_sum NUMERIC NOT NULL
);

-- Convert to hypertable
SELECT create_hypertable('market_depth_metrics', 'time');

-- Create index on venue, symbol
CREATE INDEX idx_market_depth_metrics_venue_symbol ON market_depth_metrics(venue, symbol);

-- Create order flow metrics table
CREATE TABLE order_flow_metrics (
    time TIMESTAMPTZ NOT NULL,
    venue TEXT NOT NULL,
    symbol TEXT NOT NULL,
    timeframe TEXT NOT NULL,
    buy_volume NUMERIC NOT NULL,
    sell_volume NUMERIC NOT NULL,
    buy_count INTEGER NOT NULL,
    sell_count INTEGER NOT NULL,
    cancel_volume NUMERIC NOT NULL,
    cancel_count INTEGER NOT NULL,
    aggressive_buy_volume NUMERIC NOT NULL,
    aggressive_sell_volume NUMERIC NOT NULL,
    passive_buy_volume NUMERIC NOT NULL,
    passive_sell_volume NUMERIC NOT NULL
);

-- Convert to hypertable
SELECT create_hypertable('order_flow_metrics', 'time');

-- Create index on venue, symbol, timeframe
CREATE INDEX idx_order_flow_metrics_venue_symbol_timeframe ON order_flow_metrics(venue, symbol, timeframe);

-- Create system metrics table
CREATE TABLE system_metrics (
    time TIMESTAMPTZ NOT NULL,
    service TEXT NOT NULL,
    host TEXT NOT NULL,
    cpu_usage NUMERIC NOT NULL,
    memory_usage NUMERIC NOT NULL,
    network_ingress NUMERIC NOT NULL,
    network_egress NUMERIC NOT NULL,
    request_rate NUMERIC NOT NULL,
    error_rate NUMERIC NOT NULL,
    response_time NUMERIC NOT NULL,
    additional_metrics JSONB
);

-- Convert to hypertable
SELECT create_hypertable('system_metrics', 'time');

-- Create index on service, host
CREATE INDEX idx_system_metrics_service_host ON system_metrics(service, host);

-- Create continuous aggregates for common queries
-- 1-minute OHLCV aggregates
CREATE MATERIALIZED VIEW ohlcv_1m_agg
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 minute', time) AS bucket,
    venue,
    symbol,
    first(open, time) AS open,
    max(high) AS high,
    min(low) AS low,
    last(close, time) AS close,
    sum(volume) AS volume,
    sum(trade_count) AS trade_count
FROM ohlcv
WHERE timeframe = '1m'
GROUP BY bucket, venue, symbol;

-- Add refresh policy (refresh every 2 minutes)
SELECT add_continuous_aggregate_policy('ohlcv_1m_agg',
    start_offset => INTERVAL '1 day',
    end_offset => INTERVAL '1 minute',
    schedule_interval => INTERVAL '2 minutes');

-- Create compression policies
-- Compress order book snapshots older than 1 day
SELECT add_compression_policy('order_book_snapshots', INTERVAL '1 day');

-- Compress trades older than 1 day
SELECT add_compression_policy('trades', INTERVAL '1 day');

-- Compress OHLCV data older than 1 day
SELECT add_compression_policy('ohlcv', INTERVAL '1 day');