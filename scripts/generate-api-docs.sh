#!/bin/bash
# Generate API documentation
# Usage: ./scripts/generate-api-docs.sh [--output=<dir>]

set -e

# Parse arguments
for i in "$@"; do
  case $i in
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
OUTPUT_DIR=${OUTPUT_DIR:-"$ROOT_DIR/api-docs"}

echo "Generating API documentation to: $OUTPUT_DIR"

# Ensure output directory exists
mkdir -p "$OUTPUT_DIR"

# Install OpenAPI generator if needed
if ! command -v openapi-generator &> /dev/null; then
  echo "Installing OpenAPI generator..."
  npm install -g @openapitools/openapi-generator-cli
fi

# Generate documentation from OpenAPI spec
echo "Generating documentation from OpenAPI spec..."
openapi-generator generate \
  -i "$ROOT_DIR/services/api-gateway/src/openapi/spec.yaml" \
  -g html2 \
  -o "$OUTPUT_DIR/html"

# Generate Postman collection
echo "Generating Postman collection..."
openapi-generator generate \
  -i "$ROOT_DIR/services/api-gateway/src/openapi/spec.yaml" \
  -g postman-collection \
  -o "$OUTPUT_DIR/postman"

# Generate Markdown documentation
echo "Generating Markdown documentation..."
openapi-generator generate \
  -i "$ROOT_DIR/services/api-gateway/src/openapi/spec.yaml" \
  -g markdown \
  -o "$OUTPUT_DIR/markdown"

echo "API documentation generated successfully!"
echo "HTML documentation: $OUTPUT_DIR/html/index.html"
echo "Postman collection: $OUTPUT_DIR/postman/QuantumOrderBookAPI.postman_collection.json"
echo "Markdown documentation: $OUTPUT_DIR/markdown/README.md"