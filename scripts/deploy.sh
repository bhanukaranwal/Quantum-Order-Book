#!/bin/bash
# Deploy the application to Kubernetes
# Usage: ./scripts/deploy.sh --environment=<env> [--version=<version>] [--namespace=<namespace>]

set -e

# Parse arguments
for i in "$@"; do
  case $i in
    --environment=*)
      ENVIRONMENT="${i#*=}"
      shift
      ;;
    --version=*)
      VERSION="${i#*=}"
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
VERSION=${VERSION:-latest}
NAMESPACE=${NAMESPACE:-quantum-order-book}

echo "Deploying to environment: $ENVIRONMENT, version: $VERSION, namespace: $NAMESPACE"

# Determine script directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
K8S_DIR="$ROOT_DIR/infrastructure/kubernetes"

# Check if namespace exists, create if not
if ! kubectl get namespace "$NAMESPACE" &> /dev/null; then
  echo "Creating namespace $NAMESPACE..."
  kubectl create namespace "$NAMESPACE"
fi

# Set kubectl context to use the namespace
kubectl config set-context --current --namespace="$NAMESPACE"

# Apply ConfigMaps and Secrets first
echo "Applying ConfigMaps and Secrets..."
kubectl apply -f "$K8S_DIR/config/configmaps-${ENVIRONMENT}.yaml"
kubectl apply -f "$K8S_DIR/config/secrets-${ENVIRONMENT}.yaml"

# Apply Storage resources
echo "Applying Storage resources..."
kubectl apply -f "$K8S_DIR/storage/"

# Wait for storage to be ready
echo "Waiting for storage resources to be ready..."
sleep 5

# Apply Database resources
echo "Deploying databases..."
kubectl apply -f "$K8S_DIR/deployments/postgres.yaml"
kubectl apply -f "$K8S_DIR/deployments/timescaledb.yaml"
kubectl apply -f "$K8S_DIR/deployments/redis.yaml"
kubectl apply -f "$K8S_DIR/deployments/kafka.yaml"

# Wait for databases to be ready
echo "Waiting for databases to be ready..."
kubectl wait --for=condition=ready pod -l app=postgres --timeout=300s
kubectl wait --for=condition=ready pod -l app=timescaledb --timeout=300s
kubectl wait --for=condition=ready pod -l app=redis --timeout=300s
kubectl wait --for=condition=ready pod -l app=kafka --timeout=300s

# Run database initialization jobs
echo "Running database initialization jobs..."
kubectl apply -f "$K8S_DIR/jobs/db-init-job.yaml"
kubectl wait --for=condition=complete job/db-init-job --timeout=300s

# Deploy services in order
echo "Deploying core services..."
SERVICES=(
  "user-service"
  "market-data-service"
  "order-book-service"
  "analytics-service"
  "risk-management"
  "api-gateway"
  "frontend"
)

for SERVICE in "${SERVICES[@]}"; do
  echo "Deploying $SERVICE..."
  
  # Replace version in deployment file
  sed "s/{{VERSION}}/$VERSION/g" "$K8S_DIR/deployments/${SERVICE}.yaml" | kubectl apply -f -
  
  # Apply service
  kubectl apply -f "$K8S_DIR/services/${SERVICE}-service.yaml"
done

# Apply ingress resources
echo "Applying ingress resources..."
kubectl apply -f "$K8S_DIR/ingress/"

# Apply monitoring resources
echo "Deploying monitoring resources..."
kubectl apply -f "$K8S_DIR/monitoring/"

echo "Deployment completed successfully!"
echo "Checking deployment status..."

kubectl get pods -n "$NAMESPACE"

echo "To check the application, run: ./scripts/health-check.sh --environment=$ENVIRONMENT"