-- Create extension if it doesn't exist
CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;

-- Enable compression
ALTER DATABASE quantum_market_data SET timescaledb.enable_transparent_decompression = true;

-- Create venues table
CREATE TABLE IF NOT EXISTS venues (
    id SERIAL PRIMARY KEY,
    venue_code VARCHAR(50) NOT NULL UNIQUE,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    venue_type VARCHAR(50) NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create instruments table
CREATE TABLE IF NOT EXISTS instruments (
    id SERIAL PRIMARY KEY,
    symbol VARCHAR(50) NOT NULL,
    venue_id INTEGER REFERENCES venues(id),
    base_asset VARCHAR(50) NOT NULL,
    quote_asset VARCHAR(50) NOT NULL,
    asset_type VARCHAR(50) NOT NULL,
    tick_size NUMERIC(18,10) NOT NULL,
    lot_size NUMERIC(18,10) NOT NULL,
    min_qty NUMERIC(18,10) NOT NULL,
    max_qty NUMERIC(18,10),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(symbol, venue_id)
);

-- Create order_book_snapshots table
CREATE TABLE IF NOT EXISTS order_book_snapshots (
    id BIGSERIAL,
    instrument_id INTEGER NOT NULL REFERENCES instruments(id),
    timestamp TIMESTAMPTZ NOT NULL,
    received_at TIMESTAMPTZ NOT NULL,
    sequence_id BIGINT,
    bid_levels JSONB NOT NULL,
    ask_levels JSONB NOT NULL,
    md_flags INTEGER DEFAULT 0,
    PRIMARY KEY(id, timestamp)
);

-- Convert to hypertable
SELECT create_hypertable('order_book_snapshots', 'timestamp', 
                         chunk_time_interval => INTERVAL '1 day',
                         if_not_exists => TRUE);

-- Add compression policy
ALTER TABLE order_book_snapshots SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'instrument_id'
);

SELECT add_compression_policy('order_book_snapshots', INTERVAL '7 days');

-- Create order_book_updates table for L3 data
CREATE TABLE IF NOT EXISTS order_book_updates (
    id BIGSERIAL,
    instrument_id INTEGER NOT NULL REFERENCES instruments(id),
    timestamp TIMESTAMPTZ NOT NULL,
    received_at TIMESTAMPTZ NOT NULL,
    sequence_id BIGINT,
    update_type VARCHAR(20) NOT NULL,
    order_id VARCHAR(100) NOT NULL,
    price NUMERIC(18,10) NOT NULL,
    quantity NUMERIC(18,10) NOT NULL,
    side VARCHAR(4) NOT NULL,
    participant_type VARCHAR(50),
    is_aggressor BOOLEAN,
    PRIMARY KEY(id, timestamp)
);

-- Convert to hypertable
SELECT create_hypertable('order_book_updates', 'timestamp', 
                         chunk_time_interval => INTERVAL '1 day',
                         if_not_exists => TRUE);

-- Add compression policy
ALTER TABLE order_book_updates SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'instrument_id,update_type'
);

SELECT add_compression_policy('order_book_updates', INTERVAL '3 days');

-- Create trades table
CREATE TABLE IF NOT EXISTS trades (
    id BIGSERIAL,
    instrument_id INTEGER NOT NULL REFERENCES instruments(id),
    timestamp TIMESTAMPTZ NOT NULL,
    received_at TIMESTAMPTZ NOT NULL,
    trade_id VARCHAR(100) NOT NULL,
    price NUMERIC(18,10) NOT NULL,
    quantity NUMERIC(18,10) NOT NULL,
    notional NUMERIC(18,10) GENERATED ALWAYS AS (price * quantity) STORED,
    buyer_order_id VARCHAR(100),
    seller_order_id VARCHAR(100),
    is_buyer_maker BOOLEAN,
    buyer_participant_type VARCHAR(50),
    seller_participant_type VARCHAR(50),
    flags INTEGER DEFAULT 0,
    PRIMARY KEY(id, timestamp)
);

-- Convert to hypertable
SELECT create_hypertable('trades', 'timestamp', 
                         chunk_time_interval => INTERVAL '1 day',
                         if_not_exists => TRUE);

-- Add compression policy
ALTER TABLE trades SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'instrument_id'
);

SELECT add_compression_policy('trades', INTERVAL '7 days');

-- Create candles table
CREATE TABLE IF NOT EXISTS candles (
    id BIGSERIAL,
    instrument_id INTEGER NOT NULL REFERENCES instruments(id),
    timeframe VARCHAR(10) NOT NULL,
    timestamp TIMESTAMPTZ NOT NULL,
    open NUMERIC(18,10) NOT NULL,
    high NUMERIC(18,10) NOT NULL,
    low NUMERIC(18,10) NOT NULL,
    close NUMERIC(18,10) NOT NULL,
    volume NUMERIC(18,10) NOT NULL,
    vwap NUMERIC(18,10),
    trades_count INTEGER,
    is_complete BOOLEAN DEFAULT TRUE,
    PRIMARY KEY(id, timestamp)
);

-- Convert to hypertable
SELECT create_hypertable('candles', 'timestamp', 
                         chunk_time_interval => INTERVAL '1 day',
                         if_not_exists => TRUE);

-- Add compression policy
ALTER TABLE candles SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'instrument_id,timeframe'
);

SELECT add_compression_policy('candles', INTERVAL '30 days');

-- Create market events table
CREATE TABLE IF NOT EXISTS market_events (
    id BIGSERIAL,
    instrument_id INTEGER REFERENCES instruments(id),
    timestamp TIMESTAMPTZ NOT NULL,
    received_at TIMESTAMPTZ NOT NULL,
    event_type VARCHAR(50) NOT NULL,
    event_data JSONB NOT NULL,
    source VARCHAR(100) NOT NULL,
    PRIMARY KEY(id, timestamp)
);

-- Convert to hypertable
SELECT create_hypertable('market_events', 'timestamp', 
                         chunk_time_interval => INTERVAL '1 day',
                         if_not_exists => TRUE);

-- Create indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_order_book_snapshots_instrument_time ON order_book_snapshots (instrument_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_order_book_updates_instrument_time ON order_book_updates (instrument_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_trades_instrument_time ON trades (instrument_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_candles_instrument_timeframe_time ON candles (instrument_id, timeframe, timestamp DESC);

-- Create view for latest order book snapshots
CREATE OR REPLACE VIEW latest_order_books AS
SELECT DISTINCT ON (instrument_id) 
    obs.id,
    obs.instrument_id,
    i.symbol,
    v.venue_code,
    obs.timestamp,
    obs.received_at,
    obs.bid_levels,
    obs.ask_levels
FROM order_book_snapshots obs
JOIN instruments i ON obs.instrument_id = i.id
JOIN venues v ON i.venue_id = v.id
ORDER BY instrument_id, timestamp DESC;

-- Create function to calculate order book imbalance
CREATE OR REPLACE FUNCTION calculate_order_book_imbalance(
    bid_levels JSONB,
    ask_levels JSONB,
    depth INTEGER DEFAULT 10
) RETURNS NUMERIC AS $$
DECLARE
    bid_sum NUMERIC := 0;
    ask_sum NUMERIC := 0;
    imbalance NUMERIC;
BEGIN
    -- Sum bid quantities up to specified depth
    SELECT COALESCE(SUM(CAST(level->>'quantity' AS NUMERIC)), 0)
    INTO bid_sum
    FROM jsonb_array_elements(bid_levels) level
    LIMIT depth;
    
    -- Sum ask quantities up to specified depth
    SELECT COALESCE(SUM(CAST(level->>'quantity' AS NUMERIC)), 0)
    INTO ask_sum
    FROM jsonb_array_elements(ask_levels) level
    LIMIT depth;
    
    -- Calculate imbalance ratio
    IF (bid_sum + ask_sum) > 0 THEN
        imbalance := (bid_sum - ask_sum) / (bid_sum + ask_sum);
    ELSE
        imbalance := 0;
    END IF;
    
    RETURN imbalance;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Create continuous aggregates for analytics
-- 1. Hourly trade volume by instrument
SELECT add_continuous_aggregate_policy('hourly_trade_volume', 
    start_offset => INTERVAL '30 days',
    end_offset => INTERVAL '1 hour',
    schedule_interval => INTERVAL '1 hour');

CREATE MATERIALIZED VIEW hourly_trade_volume
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 hour', timestamp) AS bucket,
    instrument_id,
    SUM(quantity) AS volume,
    SUM(notional) AS notional,
    COUNT(*) AS trade_count,
    AVG(price) AS avg_price
FROM trades
GROUP BY bucket, instrument_id;

-- 2. Daily order book statistics
SELECT add_continuous_aggregate_policy('daily_orderbook_stats', 
    start_offset => INTERVAL '180 days',
    end_offset => INTERVAL '1 day',
    schedule_interval => INTERVAL '1 day');

CREATE MATERIALIZED VIEW daily_orderbook_stats
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 day', timestamp) AS bucket,
    instrument_id,
    AVG(calculate_order_book_imbalance(bid_levels, ask_levels, 10)) AS avg_imbalance,
    AVG((jsonb_array_element(ask_levels, 0)->>'price')::NUMERIC - 
        (jsonb_array_element(bid_levels, 0)->>'price')::NUMERIC) AS avg_spread,
    AVG(jsonb_array_length(bid_levels)) AS avg_bid_depth,
    AVG(jsonb_array_length(ask_levels)) AS avg_ask_depth
FROM order_book_snapshots
GROUP BY bucket, instrument_id;

-- Create retention policy (adjust as needed)
SELECT add_retention_policy('order_book_snapshots', INTERVAL '90 days');
SELECT add_retention_policy('order_book_updates', INTERVAL '30 days');
SELECT add_retention_policy('trades', INTERVAL '365 days');
SELECT add_retention_policy('candles', INTERVAL '730 days');