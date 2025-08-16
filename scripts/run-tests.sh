#!/bin/bash
# Run tests for all services
# Usage: ./scripts/run-tests.sh [--unit|--integration|--e2e] [--coverage] [--verbose]

set -e

# Parse arguments
TEST_TYPE="all"
COVERAGE=false
VERBOSE=false

for i in "$@"; do
  case $i in
    --unit)
      TEST_TYPE="unit"
      shift
      ;;
    --integration)
      TEST_TYPE="integration"
      shift
      ;;
    --e2e)
      TEST_TYPE="e2e"
      shift
      ;;
    --coverage)
      COVERAGE=true
      shift
      ;;
    --verbose)
      VERBOSE=true
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

echo "Running tests: type=$TEST_TYPE, coverage=$COVERAGE, verbose=$VERBOSE"

# Function to run tests for a service
run_service_tests() {
  SERVICE=$1
  TEST_CMD="npm run test"
  
  if [ "$TEST_TYPE" != "all" ]; then
    TEST_CMD="npm run test:$TEST_TYPE"
  fi
  
  if [ "$COVERAGE" = true ]; then
    TEST_CMD="$TEST_CMD:coverage"
  fi
  
  if [ "$VERBOSE" = true ]; then
    TEST_CMD="$TEST_CMD -- --verbose"
  fi
  
  echo "Running tests for $SERVICE..."
  cd "$ROOT_DIR/services/$SERVICE"
  
  if [ -f "package.json" ]; then
    # Check if the test script exists
    if grep -q "\"test\":" "package.json"; then
      eval "$TEST_CMD"
    else
      echo "No tests found for $SERVICE, skipping."
    fi
  else
    echo "No package.json found for $SERVICE, skipping."
  fi
}

# Run tests for shared library first
echo "Running tests for shared library..."
cd "$ROOT_DIR/services/shared"
if [ "$TEST_TYPE" = "all" ]; then
  npm test
else
  npm run "test:$TEST_TYPE"
fi

# Services to test
SERVICES=(
  "api-gateway"
  "order-book"
  "market-data"
  "analytics"
  "risk-management"
  "user"
)

# Run tests for each service
for SERVICE in "${SERVICES[@]}"; do
  run_service_tests "$SERVICE"
done

# Run frontend tests
echo "Running tests for frontend..."
cd "$ROOT_DIR/frontend"
if [ -f "package.json" ]; then
  if [ "$TEST_TYPE" = "all" ]; then
    npm test
  else
    npm run "test:$TEST_TYPE"
  fi
fi

echo "All tests completed!"

# Generate combined coverage report if requested
if [ "$COVERAGE" = true ]; then
  echo "Generating combined coverage report..."
  cd "$ROOT_DIR"
  
  # Merge coverage reports
  npx nyc merge .nyc_output .nyc_output/coverage.json
  
  # Generate HTML report
  npx nyc report --reporter=html --report-dir=coverage
  
  echo "Combined coverage report generated at: $ROOT_DIR/coverage/index.html"
fi