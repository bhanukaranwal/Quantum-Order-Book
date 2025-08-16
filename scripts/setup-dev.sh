#!/bin/bash
# Set up a development environment
# Usage: ./scripts/setup-dev.sh [--with-data]

set -e

# Parse arguments
WITH_DATA=false

for i in "$@"; do
  case $i in
    --with-data)
      WITH_DATA=true
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

echo "Setting up development environment..."

# Check prerequisites
echo "Checking prerequisites..."

# Check Node.js
if ! command -v node &> /dev/null; then
  echo "Error: Node.js is not installed"
  exit 1
fi

NODE_VERSION=$(node -v | cut -d 'v' -f 2)
NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d '.' -f 1)
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "Error: Node.js 18 or higher is required"
  exit 1
fi

# Check npm
if ! command -v npm &> /dev/null; then
  echo "Error: npm is not installed"
  exit 1
fi

# Check Docker
if ! command -v docker &> /dev/null; then
  echo "Error: Docker is not installed"
  exit 1
fi

# Check Docker Compose
if ! command -v docker-compose &> /dev/null; then
  echo "Error: Docker Compose is not installed"
  exit 1
fi

# Create .env file if it doesn't exist
if [ ! -f "$ROOT_DIR/.env" ]; then
  echo "Creating .env file..."
  cp "$ROOT_DIR/.env.example" "$ROOT_DIR/.env"
  echo "Please update .env file with your configuration"
fi

# Install dependencies
echo "Installing dependencies..."
cd "$ROOT_DIR"
npm install

# Build shared packages
echo "Building shared packages..."
npm run build --scope=@quantum/shared

# Start infrastructure services with Docker Compose
echo "Starting infrastructure services..."
docker-compose up -d postgres timescaledb redis kafka zookeeper

# Wait for services to be ready
echo "Waiting for services to be ready..."
sleep 10

# Initialize databases
echo "Initializing databases..."
"$SCRIPT_DIR/init-db.sh" --local

# Load sample data if requested
if [ "$WITH_DATA" = true ]; then
  echo "Loading sample data..."
  node "$SCRIPT_DIR/load-sample-data.js"
fi

echo "Development environment setup completed!"
echo "To start all services, run: npm run dev"
echo "To start the frontend, run: cd frontend && npm start"