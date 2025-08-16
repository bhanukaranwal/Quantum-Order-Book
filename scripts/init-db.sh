#!/bin/bash
# Initialize databases with schema and initial data
# Usage: ./scripts/init-db.sh [--local] [--reset]

set -e

# Parse arguments
LOCAL=false
RESET=false

for i in "$@"; do
  case $i in
    --local)
      LOCAL=true
      shift
      ;;
    --reset)
      RESET=true
      shift
      ;;
    *)
      # unknown option
      ;;
  esac
done

# Determine script directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
DB_DIR="$ROOT_DIR/infrastructure/database"

# Connection parameters
if [ "$LOCAL" = true ]; then
  echo "Using local database connections..."
  
  # Load environment variables
  if [ -f "$ROOT_DIR/.env" ]; then
    source "$ROOT_DIR/.env"
  else
    echo "Error: .env file not found. Please create it with database connection details."
    exit 1
  fi
  
  PG_HOST=${POSTGRES_HOST:-localhost}
  PG_PORT=${POSTGRES_PORT:-5432}
  PG_USER=${POSTGRES_USER:-quantum}
  PG_PASSWORD=${POSTGRES_PASSWORD:-quantum}
  PG_DB=${POSTGRES_DB:-quantum_users}
  
  TS_HOST=${TIMESCALEDB_HOST:-localhost}
  TS_PORT=${TIMESCALEDB_PORT:-5433}
  TS_USER=${TIMESCALEDB_USER:-quantum}
  TS_PASSWORD=${TIMESCALEDB_PASSWORD:-quantum}
  TS_DB=${TIMESCALEDB_DB:-market_data}
else
  echo "Using database connections via kubectl port-forward..."
  
  # Forward ports to the database pods
  echo "Setting up port forwarding to PostgreSQL..."
  kubectl port-forward svc/postgresql 5432:5432 &
  PG_PID=$!
  
  echo "Setting up port forwarding to TimescaleDB..."
  kubectl port-forward svc/timescaledb 5433:5432 &
  TS_PID=$!
  
  # Wait for port forwarding to establish
  sleep 5
  
  PG_HOST=localhost
  PG_PORT=5432
  PG_USER=quantum
  PG_PASSWORD=quantum
  PG_DB=quantum_users
  
  TS_HOST=localhost
  TS_PORT=5433
  TS_USER=quantum
  TS_PASSWORD=quantum
  TS_DB=market_data
  
  # Register cleanup function
  cleanup() {
    echo "Cleaning up port forwarding..."
    kill $PG_PID $TS_PID 2>/dev/null || true
    wait $PG_PID $TS_PID 2>/dev/null || true
  }
  
  trap cleanup EXIT
fi

# Function to execute SQL files
execute_sql_files() {
  DB_TYPE=$1
  HOST=$2
  PORT=$3
  USER=$4
  PASSWORD=$5
  DB=$6
  DIR=$7
  
  echo "Executing SQL files for $DB_TYPE..."
  
  # Export password for psql
  export PGPASSWORD=$PASSWORD
  
  # Execute SQL files in order
  for SQL_FILE in $(find "$DIR" -name "*.sql" | sort); do
    echo "Executing $SQL_FILE..."
    if [ "$DB_TYPE" = "postgres" ]; then
      psql -h "$HOST" -p "$PORT" -U "$USER" -d "$DB" -f "$SQL_FILE"
    elif [ "$DB_TYPE" = "timescale" ]; then
      psql -h "$HOST" -p "$PORT" -U "$USER" -d "$DB" -f "$SQL_FILE"
    fi
  done
}

# Reset databases if requested
if [ "$RESET" = true ]; then
  echo "Resetting databases..."
  
  # Export password for psql
  export PGPASSWORD=$PG_PASSWORD
  
  # Drop and recreate PostgreSQL databases
  echo "Resetting PostgreSQL databases..."
  psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d postgres -c "
    DROP DATABASE IF EXISTS quantum_users;
    DROP DATABASE IF EXISTS quantum_analytics;
    DROP DATABASE IF EXISTS quantum_risk;
    CREATE DATABASE quantum_users;
    CREATE DATABASE quantum_analytics;
    CREATE DATABASE quantum_risk;
  "
  
  # Export password for TimescaleDB
  export PGPASSWORD=$TS_PASSWORD
  
  # Drop and recreate TimescaleDB database
  echo "Resetting TimescaleDB database..."
  psql -h "$TS_HOST" -p "$TS_PORT" -U "$TS_USER" -d postgres -c "
    DROP DATABASE IF EXISTS market_data;
    CREATE DATABASE market_data;
  "
fi

# Initialize PostgreSQL
execute_sql_files "postgres" "$PG_HOST" "$PG_PORT" "$PG_USER" "$PG_PASSWORD" "$PG_DB" "$DB_DIR/postgres/init"

# Initialize TimescaleDB
execute_sql_files "timescale" "$TS_HOST" "$TS_PORT" "$TS_USER" "$TS_PASSWORD" "$TS_DB" "$DB_DIR/timescaledb/init"

echo "Database initialization completed successfully!"