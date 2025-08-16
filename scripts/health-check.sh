#!/bin/bash
# Check the health of deployed services
# Usage: ./scripts/health-check.sh [--environment=<env>] [--namespace=<namespace>]

set -e

# Parse arguments
for i in "$@"; do
  case $i in
    --environment=*)
      ENVIRONMENT="${i#*=}"
      shift
      ;;
    --namespace=*)
      NAMESPACE="${i#*=}"
      shift
      ;;
    *)
      # unknown option
      ;;
  esac
done

# Set defaults
ENVIRONMENT=${ENVIRONMENT:-dev}
NAMESPACE=${NAMESPACE:-quantum-order-book}

# Determine API URL based on environment
case $ENVIRONMENT in
  dev)
    API_URL="http://localhost:8080"
    ;;
  staging)
    API_URL="https://api-staging.quantum-order-book.com"
    ;;
  prod)
    API_URL="https://api.quantum-order-book.com"
    ;;
  *)
    API_URL="http://localhost:8080"
    ;;
esac

echo "Checking health for environment: $ENVIRONMENT, namespace: $NAMESPACE"
echo "API URL: $API_URL"

# Check if namespace exists
if ! kubectl get namespace "$NAMESPACE" &> /dev/null; then
  echo "Error: Namespace $NAMESPACE does not exist"
  exit 1
fi

# Check pod status
echo "Checking pod status..."
kubectl get pods -n "$NAMESPACE" -o wide

# Check for any pods not in Running state
NON_RUNNING_PODS=$(kubectl get pods -n "$NAMESPACE" --no-headers | grep -v "Running" | grep -v "Completed" | wc -l)
if [ "$NON_RUNNING_PODS" -gt 0 ]; then
  echo "Warning: $NON_RUNNING_PODS pods are not in Running state"
  kubectl get pods -n "$NAMESPACE" --no-headers | grep -v "Running" | grep -v "Completed"
else
  echo "All pods are running"
fi

# Check service health endpoints
echo "Checking service health endpoints..."

# Function to check a health endpoint
check_health() {
  SERVICE=$1
  ENDPOINT=$2
  
  echo -n "Checking $SERVICE health... "
  
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$ENDPOINT")
  
  if [ "$HTTP_CODE" -eq 200 ]; then
    echo "OK (HTTP $HTTP_CODE)"
    return 0
  else
    echo "FAIL (HTTP $HTTP_CODE)"
    return 1
  fi
}

# Check API Gateway
check_health "API Gateway" "$API_URL/health"

# Check WebSocket
echo -n "Checking WebSocket connection... "
if command -v wscat &> /dev/null; then
  WS_URL=$(echo "$API_URL" | sed 's/http/ws/')
  if echo -n | timeout 5 wscat -c "$WS_URL/ws" &> /dev/null; then
    echo "OK"
  else
    echo "FAIL"
  fi
else
  echo "SKIPPED (wscat not installed)"
fi

# Check ingress
echo "Checking ingress..."
kubectl get ingress -n "$NAMESPACE"

# Check services
echo "Checking services..."
kubectl get services -n "$NAMESPACE"

# Check logs for errors
echo "Checking logs for errors in the last 10 minutes..."
for pod in $(kubectl get pods -n "$NAMESPACE" -o name | grep -v "job"); do
  ERROR_COUNT=$(kubectl logs "$pod" -n "$NAMESPACE" --since=10m | grep -i "error" | wc -l)
  WARNING_COUNT=$(kubectl logs "$pod" -n "$NAMESPACE" --since=10m | grep -i "warn" | wc -l)
  
  if [ "$ERROR_COUNT" -gt 0 ] || [ "$WARNING_COUNT" -gt 0 ]; then
    echo "$pod: $ERROR_COUNT errors, $WARNING_COUNT warnings"
  fi
done

echo "Health check completed"