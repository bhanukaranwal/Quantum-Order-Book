-- Create databases
CREATE DATABASE quantum_users;
CREATE DATABASE quantum_analytics;
CREATE DATABASE quantum_risk;

-- Connect to quantum_users database
\c quantum_users;

-- Users table
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    uuid VARCHAR(36) NOT NULL UNIQUE,
    username VARCHAR(100) NOT NULL UNIQUE,
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    first_name VARCHAR(100),
    last_name VARCHAR(100),
    tier VARCHAR(50) NOT NULL DEFAULT 'free',
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    last_login TIMESTAMP WITH TIME ZONE,
    status VARCHAR(20) NOT NULL DEFAULT 'active', -- active, suspended, deleted
    email_verified BOOLEAN NOT NULL DEFAULT FALSE,
    mfa_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    mfa_secret VARCHAR(100)
);

-- User permissions
CREATE TABLE permissions (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE,
    description TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- User roles
CREATE TABLE roles (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE,
    description TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Role permissions mapping
CREATE TABLE role_permissions (
    role_id INTEGER REFERENCES roles(id) ON DELETE CASCADE,
    permission_id INTEGER REFERENCES permissions(id) ON DELETE CASCADE,
    granted_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    PRIMARY KEY (role_id, permission_id)
);

-- User roles mapping
CREATE TABLE user_roles (
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    role_id INTEGER REFERENCES roles(id) ON DELETE CASCADE,
    granted_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, role_id)
);

-- API keys for users
CREATE TABLE api_keys (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key_name VARCHAR(100) NOT NULL,
    api_key VARCHAR(64) NOT NULL UNIQUE,
    api_secret VARCHAR(255) NOT NULL,
    permissions TEXT[],
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE,
    last_used_at TIMESTAMP WITH TIME ZONE,
    status VARCHAR(20) NOT NULL DEFAULT 'active', -- active, revoked
    ip_whitelist TEXT[]
);

-- Authentication sessions
CREATE TABLE auth_sessions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_token VARCHAR(100) NOT NULL UNIQUE,
    refresh_token VARCHAR(100) UNIQUE,
    user_agent TEXT,
    ip_address VARCHAR(45),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    last_active_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Exchange integrations for users
CREATE TABLE exchange_integrations (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    exchange_name VARCHAR(50) NOT NULL,
    api_key VARCHAR(255) NOT NULL,
    api_secret VARCHAR(255) NOT NULL,
    api_passphrase VARCHAR(255),
    label VARCHAR(100),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    status VARCHAR(20) NOT NULL DEFAULT 'active', -- active, revoked, error
    permissions TEXT[],
    test_mode BOOLEAN NOT NULL DEFAULT FALSE,
    UNIQUE (user_id, exchange_name, label)
);

-- User preferences
CREATE TABLE user_preferences (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    theme VARCHAR(20) NOT NULL DEFAULT 'light',
    default_fiat VARCHAR(10) NOT NULL DEFAULT 'USD',
    notification_settings JSONB NOT NULL DEFAULT '{}',
    ui_settings JSONB NOT NULL DEFAULT '{}',
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- User activity log
CREATE TABLE user_activity (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    activity_type VARCHAR(50) NOT NULL,
    ip_address VARCHAR(45),
    user_agent TEXT,
    details JSONB,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Create indexes
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_username ON users(username);
CREATE INDEX idx_users_status ON users(status);
CREATE INDEX idx_api_keys_user_id ON api_keys(user_id);
CREATE INDEX idx_auth_sessions_user_id ON auth_sessions(user_id);
CREATE INDEX idx_exchange_integrations_user_id ON exchange_integrations(user_id);
CREATE INDEX idx_user_activity_user_id ON user_activity(user_id);
CREATE INDEX idx_user_activity_created_at ON user_activity(created_at);

-- Connect to quantum_risk database
\c quantum_risk;

-- Risk profiles
CREATE TABLE risk_profiles (
    id SERIAL PRIMARY KEY,
    profile_id VARCHAR(50) NOT NULL UNIQUE,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    position_limits JSONB NOT NULL,
    order_limits JSONB NOT NULL,
    margin_limits JSONB NOT NULL,
    risk_limits JSONB NOT NULL,
    actions JSONB NOT NULL,
    default_exemptions TEXT[],
    priority INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Account risk limits
CREATE TABLE account_risk_limits (
    id SERIAL PRIMARY KEY,
    account_id VARCHAR(36) NOT NULL UNIQUE,
    position_limits JSONB NOT NULL,
    order_limits JSONB NOT NULL,
    margin_limits JSONB NOT NULL,
    risk_limits JSONB NOT NULL,
    actions JSONB NOT NULL,
    exemptions TEXT[],
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Risk events
CREATE TABLE risk_events (
    id SERIAL PRIMARY KEY,
    event_id VARCHAR(100) NOT NULL UNIQUE,
    account_id VARCHAR(36) NOT NULL,
    user_id VARCHAR(36) NOT NULL,
    timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
    event_type VARCHAR(50) NOT NULL,
    limit_type VARCHAR(50) NOT NULL,
    action VARCHAR(50) NOT NULL,
    current_value NUMERIC NOT NULL,
    limit_value NUMERIC NOT NULL,
    percentage NUMERIC NOT NULL,
    context JSONB NOT NULL,
    details JSONB
);

-- Circuit breaker events
CREATE TABLE circuit_breaker_events (
    id SERIAL PRIMARY KEY,
    event_id VARCHAR(100) NOT NULL UNIQUE,
    venue VARCHAR(50) NOT NULL,
    symbol VARCHAR(50) NOT NULL,
    timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
    previous_state VARCHAR(50) NOT NULL,
    new_state VARCHAR(50) NOT NULL,
    trigger_type VARCHAR(50),
    trigger_details JSONB,
    user_id VARCHAR(36)
);

-- Create indexes
CREATE INDEX idx_risk_events_account_id ON risk_events(account_id);
CREATE INDEX idx_risk_events_timestamp ON risk_events(timestamp);
CREATE INDEX idx_circuit_breaker_events_venue_symbol ON circuit_breaker_events(venue, symbol);
CREATE INDEX idx_circuit_breaker_events_timestamp ON circuit_breaker_events(timestamp);

-- Connect to quantum_analytics database
\c quantum_analytics;

-- Trading strategies
CREATE TABLE strategies (
    id SERIAL PRIMARY KEY,
    strategy_id VARCHAR(50) NOT NULL UNIQUE,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    creator VARCHAR(36) NOT NULL,
    parameters JSONB NOT NULL,
    entry_conditions JSONB NOT NULL,
    exit_conditions JSONB NOT NULL,
    risk_management JSONB NOT NULL,
    timeframes TEXT[] NOT NULL,
    markets JSONB NOT NULL,
    status VARCHAR(20) NOT NULL,
    performance JSONB,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Strategy evaluations
CREATE TABLE strategy_evaluations (
    id SERIAL PRIMARY KEY,
    evaluation_id VARCHAR(100) NOT NULL UNIQUE,
    strategy_id VARCHAR(50) NOT NULL,
    timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
    entry_scores JSONB NOT NULL,
    exit_scores JSONB NOT NULL,
    overall_entry_score NUMERIC NOT NULL,
    overall_exit_score NUMERIC NOT NULL,
    recommendation VARCHAR(20) NOT NULL,
    market JSONB NOT NULL,
    suggested_parameters JSONB,
    ai_enhancements JSONB
);

-- Correlation matrices
CREATE TABLE correlation_matrices (
    id SERIAL PRIMARY KEY,
    matrix_id VARCHAR(100) NOT NULL UNIQUE,
    timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
    timeframe VARCHAR(10) NOT NULL,
    symbols TEXT[] NOT NULL,
    values JSONB NOT NULL,
    metadata JSONB NOT NULL
);

-- Correlation alerts
CREATE TABLE correlation_alerts (
    id SERIAL PRIMARY KEY,
    alert_id VARCHAR(100) NOT NULL UNIQUE,
    timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
    type VARCHAR(50) NOT NULL,
    symbol1 VARCHAR(50) NOT NULL,
    symbol2 VARCHAR(50) NOT NULL,
    correlation NUMERIC NOT NULL,
    previous_correlation NUMERIC NOT NULL,
    change NUMERIC NOT NULL,
    timeframe VARCHAR(10) NOT NULL,
    severity VARCHAR(10) NOT NULL,
    message TEXT NOT NULL
);

-- Monitored correlation pairs
CREATE TABLE correlation_pairs (
    id SERIAL PRIMARY KEY,
    symbol1 VARCHAR(50) NOT NULL,
    symbol2 VARCHAR(50) NOT NULL,
    timeframes TEXT[] NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    UNIQUE (symbol1, symbol2)
);

-- Create indexes
CREATE INDEX idx_strategies_creator ON strategies(creator);
CREATE INDEX idx_strategies_status ON strategies(status);
CREATE INDEX idx_strategy_evaluations_strategy_id ON strategy_evaluations(strategy_id);
CREATE INDEX idx_strategy_evaluations_timestamp ON strategy_evaluations(timestamp);
CREATE INDEX idx_correlation_matrices_timestamp ON correlation_matrices(timestamp);
CREATE INDEX idx_correlation_matrices_timeframe ON correlation_matrices(timeframe);
CREATE INDEX idx_correlation_alerts_timestamp ON correlation_alerts(timestamp);
CREATE INDEX idx_correlation_alerts_symbols ON correlation_alerts(symbol1, symbol2);