#!/bin/bash
# Backup database data
# Usage: ./scripts/backup-data.sh [--local] [--output=<dir>]

set -e

# Parse arguments
LOCAL=false
OUTPUT_DIR=""

for i in "$@"; do
  case $i in
    --local)
      LOCAL=true
      shift
      ;;
    --output=*)
      OUTPUT_DIR="${i#*=}"
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

# Set default output directory
if [ -z "$OUTPUT_DIR" ]; then
  OUTPUT_DIR="$ROOT_DIR/backups/$(date +%Y-%m-%d)"
fi

# Ensure output directory exists
mkdir -p "$OUTPUT_DIR"

echo "Backing up data to: $OUTPUT_DIR"

# Timestamp for filenames
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

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
  
  TS_HOST=${TIMESCALEDB_HOST:-localhost}
  TS_PORT=${TIMESCALEDB_PORT:-5433}
  TS_USER=${TIMESCALEDB_USER:-quantum}
  TS_PASSWORD=${TIMESCALEDB_PASSWORD:-quantum}
else
  echo "Using database connections via kubectl..."
  
  # Get PostgreSQL pod name
  PG_POD=$(kubectl get pods -l app=postgresql -o jsonpath="{.items[0].metadata.name}")
  
  # Get TimescaleDB pod name
  TS_POD=$(kubectl get pods -l app=timescaledb -o jsonpath="{.items[0].metadata.name}")
  
  if [ -z "$PG_POD" ] || [ -z "$TS_POD" ]; then
    echo "Error: Could not find database pods"
    exit 1
  fi
  
  # Use kubectl exec for the backup
  echo "Backing up PostgreSQL databases..."
  kubectl exec "$PG_POD" -- pg_dumpall -c -U postgres > "$OUTPUT_DIR/postgres_all_$TIMESTAMP.sql"
  
  echo "Backing up TimescaleDB database..."
  kubectl exec "$TS_POD" -- pg_dump -U postgres market_data > "$OUTPUT_DIR/timescaledb_market_data_$TIMESTAMP.sql"
  
  echo "Backup completed successfully!"
  echo "Backup files:"
  echo "  - $OUTPUT_DIR/postgres_all_$TIMESTAMP.sql"
  echo "  - $OUTPUT_DIR/timescaledb_market_data_$TIMESTAMP.sql"
  
  exit 0
fi

# Export password for psql
export PGPASSWORD=$PG_PASSWORD

# Backup PostgreSQL databases
echo "Backing up PostgreSQL databases..."
pg_dump -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d quantum_users -f "$OUTPUT_DIR/postgres_users_$TIMESTAMP.sql"
pg_dump -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d quantum_analytics -f "$OUTPUT_DIR/postgres_analytics_$TIMESTAMP.sql"
pg_dump -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d quantum_risk -f "$OUTPUT_DIR/postgres_risk_$TIMESTAMP.sql"

# Export password for TimescaleDB
export PGPASSWORD=$TS_PASSWORD

# Backup TimescaleDB database
echo "Backing up TimescaleDB database..."
pg_dump -h "$TS_HOST" -p "$TS_PORT" -U "$TS_USER" -d market_data -f "$OUTPUT_DIR/timescaledb_market_data_$TIMESTAMP.sql"

echo "Backup completed successfully!"
echo "Backup files:"
echo "  - $OUTPUT_DIR/postgres_users_$TIMESTAMP.sql"
echo "  - $OUTPUT_DIR/postgres_analytics_$TIMESTAMP.sql"
echo "  - $OUTPUT_DIR/postgres_risk_$TIMESTAMP.sql"
echo "  - $OUTPUT_DIR/timescaledb_market_data_$TIMESTAMP.sql"