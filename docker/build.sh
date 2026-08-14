#!/bin/bash
set -euo pipefail

# ---------------------------------------------------------------------------
# Build script for rdCLI Docker image
#
# Includes:
#   - Node.js v22.23.2 + Pi Coding Agent + rdCLI web UI
#   - Python virtualenv /opt/llm_py_env (Office doc processing: Word, PDF, Excel, PPT)
#   - LibreOffice (doc → docx conversion)
#
# Usage:
#   ./build.sh              # Use version from package.json, fallback to "1.0"
#   ./build.sh 2.0          # Explicit version
#   VERSION=2.0 ./build.sh  # Via environment variable
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
IMAGE_NAME="${IMAGE_NAME:-rd_cli}"

# ---- Resolve version -------------------------------------------------------
if [ -n "${VERSION:-}" ]; then
    TAG_VERSION="$VERSION"
elif [ -n "${1:-}" ]; then
    TAG_VERSION="$1"
else
    # Try to read from the project's package.json
    PKG_JSON="$SCRIPT_DIR/../package.json"
    if [ -f "$PKG_JSON" ]; then
        TAG_VERSION=$(node -e "process.stdout.write(require('$PKG_JSON').version)" 2>/dev/null) || true
    fi
    TAG_VERSION="${TAG_VERSION:-1.0}"
fi

FULL_TAG="${IMAGE_NAME}:${TAG_VERSION}"

echo "============================================"
echo " Building ${FULL_TAG}"
echo "============================================"
echo ""

docker build \
    -t "${FULL_TAG}" \
    -t "${IMAGE_NAME}:latest" \
    -f "${SCRIPT_DIR}/Dockerfile" \
    "${PROJECT_ROOT}"

echo ""
echo "============================================"
echo " Build complete: ${FULL_TAG}"
echo "============================================"
echo ""
echo "Run with:"
echo ""
echo "  docker run -dit \\"
echo "    --name my_rd_cli \\"
echo "    --rm \\"
echo "    -v /data/remote/workspace:/opt/workspace \\"
echo "    -w /opt/workspace \\"
echo "    -p 19004:3001 \\"
echo "    ${FULL_TAG}"
echo ""
echo "Pi uses ~/.pi/agent/auth.json for API keys. Set up keys inside the"
echo "container or mount a pre-configured auth.json:"
echo ""
echo "  docker run -dit \\"
echo "    ..."
echo "    -v /path/to/auth.json:/root/.pi/agent/auth.json \\"
echo "    ${FULL_TAG}"
