#!/bin/bash
set -euo pipefail

# ---------------------------------------------------------------------------
# Build script for my_claude_code Docker image
# ---------------------------------------------------------------------------
# Usage:
#   ./build.sh              # Use version from package.json, fallback to "1.0"
#   ./build.sh 2.0          # Explicit version
#   VERSION=2.0 ./build.sh  # Via environment variable
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE_NAME="${IMAGE_NAME:-my_claude_code}"

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
    "${SCRIPT_DIR}"

echo ""
echo "============================================"
echo " Build complete: ${FULL_TAG}"
echo "============================================"
echo ""
echo "Run with:"
echo ""
echo "  docker run -dit \\"
echo "    --name my_claude_code \\"
echo "    --rm \\"
echo "    -v /data/remote/workspace:/opt/workspace \\"
echo "    -w /opt/workspace \\"
echo "    -e ANTHROPIC_BASE_URL=http://127.0.0.1:16001 \\"
echo "    -e ANTHROPIC_AUTH_TOKEN=sk-xxx \\"
echo "    -e API_TIMEOUT_MS=600000 \\"
echo "    -e ANTHROPIC_MODEL=deepseek-chat \\"
echo "    -e ANTHROPIC_SMALL_FAST_MODEL=deepseek-chat \\"
echo "    -e CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \\"
echo "    -e CLAUDE_CODE_ATTRIBUTION_HEADER=0 \\"
echo "    -p 19004:3001 \\"
echo "    ${FULL_TAG}"
echo ""
echo "NOTE: If your API proxy listens on the host's 127.0.0.1:16001,"
echo "      add --network=host (simplest) or use host.docker.internal."
echo "      From inside a container, 127.0.0.1 is the container itself,"
echo "      NOT the host."
