#!/bin/bash
# Build Docker images for all services
# Usage: ./scripts/build-images.sh [version] [registry]

set -e

VERSION=${1:-latest}
REGISTRY=${2:-quantumorderbook}

echo "Building images with version: $VERSION for registry: $REGISTRY"

# Determine script directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

# Services to build
SERVICES=(
  "api-gateway"
  "order-book"
  "market-data"
  "analytics"
  "risk-management"
  "user"
)

# Build each service
for SERVICE in "${SERVICES[@]}"; do
  echo "Building $SERVICE:$VERSION..."
  
  # Navigate to service directory
  cd "$ROOT_DIR/services/$SERVICE"
  
  # Build the image
  docker build -t "$REGISTRY/$SERVICE:$VERSION" .
  
  # Tag as latest if not already latest
  if [ "$VERSION" != "latest" ]; then
    docker tag "$REGISTRY/$SERVICE:$VERSION" "$REGISTRY/$SERVICE:latest"
  fi
  
  echo "Successfully built $REGISTRY/$SERVICE:$VERSION"
done

# Build frontend
echo "Building frontend:$VERSION..."
cd "$ROOT_DIR/frontend"
docker build -t "$REGISTRY/frontend:$VERSION" .

# Tag as latest if not already latest
if [ "$VERSION" != "latest" ]; then
  docker tag "$REGISTRY/frontend:$VERSION" "$REGISTRY/frontend:latest"
fi

echo "Successfully built $REGISTRY/frontend:$VERSION"

echo "All images built successfully!"

# Push images if requested
if [ "$3" == "--push" ]; then
  echo "Pushing images to registry..."
  
  for SERVICE in "${SERVICES[@]}"; do
    echo "Pushing $REGISTRY/$SERVICE:$VERSION..."
    docker push "$REGISTRY/$SERVICE:$VERSION"
    
    if [ "$VERSION" != "latest" ]; then
      docker push "$REGISTRY/$SERVICE:latest"
    fi
  done
  
  echo "Pushing $REGISTRY/frontend:$VERSION..."
  docker push "$REGISTRY/frontend:$VERSION"
  
  if [ "$VERSION" != "latest" ]; then
    docker push "$REGISTRY/frontend:latest"
  fi
  
  echo "All images pushed successfully!"
fi