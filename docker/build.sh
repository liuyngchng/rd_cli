#!/bin/bash
set -euo pipefail

# ---------------------------------------------------------------------------
# Build script for rd_cli Docker image
#
# Includes:
#   - Node.js v22.23.2 + Claude Code CLI + rdCLI web UI
#   - Python virtualenv /opt/llm_py_env (Office doc processing: Word, PDF, Excel, PPT)
#   - LibreOffice (doc → docx conversion)
#
# Usage:
#   ./build.sh                    # Version from package.json, fallback to "1.0"
#   ./build.sh 2.0                # Explicit version (positional)
#   VERSION=2.0 ./build.sh        # Via environment variable
#
# Proxy (optional; falls back to environment variables):
#   http_proxy=<url>    HTTP proxy for apt/npm/pip/docker
#   https_proxy=<url>   HTTPS proxy
#   no_proxy=<url>      Comma-separated list of hosts to bypass
#
#   ./build.sh http_proxy=http://127.0.0.1:7890 https_proxy=http://127.0.0.1:7890
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
IMAGE_NAME="${IMAGE_NAME:-rd_cli}"

# ── Usage ────────────────────────────────────────────────────────
usage() {
  cat <<'EOF'
用法: ./build.sh [version] [proxy...]

参数说明:
  version                 镜像版本号（位置参数，如 2.0）
  -h | --help             显示本帮助并退出

代理参数（可选，不带 = 时继承环境变量）:
  http_proxy=<url>        设置 HTTP 代理
  https_proxy=<url>       设置 HTTPS 代理
  no_proxy=<url>          设置不走代理的地址列表

示例:
  ./build.sh 1.0.1 http_proxy=http://127.0.0.1:7890 https_proxy=http://127.0.0.1:7890
  VERSION=1.0.1 ./build.sh
EOF
}

# ── 参数解析 ────────────────────────────────────────────────────
TAG_VERSION=""
HTTP_PROXY_VAL=""
HTTPS_PROXY_VAL=""
NO_PROXY_VAL=""

for arg in "$@"; do
  case "$arg" in
    http_proxy=*|HTTP_PROXY=*)   HTTP_PROXY_VAL="${arg#*=}" ;;
    https_proxy=*|HTTPS_PROXY=*) HTTPS_PROXY_VAL="${arg#*=}" ;;
    no_proxy=*|NO_PROXY=*)       NO_PROXY_VAL="${arg#*=}" ;;
    -h|--help|help)              usage; exit 0 ;;
    -*)                          echo "WARNING: 未知参数 '$arg'，已忽略（用 -h 查看用法）" ;;
    *)                           TAG_VERSION="$arg" ;;
  esac
done

# ---- Resolve version -------------------------------------------------------
# Priority: $VERSION env > positional arg > package.json > "1.0"
if [ -z "$TAG_VERSION" ]; then
  if [ -n "${VERSION:-}" ]; then
    TAG_VERSION="$VERSION"
  else
    PKG_JSON="$PROJECT_ROOT/package.json"
    if [ -f "$PKG_JSON" ]; then
      TAG_VERSION=$(node -e "process.stdout.write(require('$PKG_JSON').version)" 2>/dev/null) || true
    fi
    TAG_VERSION="${TAG_VERSION:-1.0}"
  fi
fi

# 不带 = 时继承环境变量
HTTP_PROXY_VAL="${HTTP_PROXY_VAL:-${HTTP_PROXY:-${http_proxy:-}}}"
HTTPS_PROXY_VAL="${HTTPS_PROXY_VAL:-${HTTPS_PROXY:-${https_proxy:-}}}"
NO_PROXY_VAL="${NO_PROXY_VAL:-${NO_PROXY:-${no_proxy:-}}}"

# 自动补全 scheme（裸 IP:端口 → http://IP:端口）
add_scheme() {
  local v="$1"
  [[ -z "$v" || "$v" == *"://"* ]] && { printf '%s' "$v"; return; }
  printf 'http://%s' "$v"
}
HTTP_PROXY_VAL="$(add_scheme "$HTTP_PROXY_VAL")"
HTTPS_PROXY_VAL="$(add_scheme "$HTTPS_PROXY_VAL")"

FULL_TAG="${IMAGE_NAME}:${TAG_VERSION}"

echo "============================================"
echo " Building ${FULL_TAG}"
echo "============================================"
if [[ -n "$HTTP_PROXY_VAL" || -n "$HTTPS_PROXY_VAL" ]]; then
  echo " 代理: http=$HTTP_PROXY_VAL https=$HTTPS_PROXY_VAL no_proxy=$NO_PROXY_VAL"
fi
echo ""

# ---- Docker build args -----------------------------------------------------
DOCKER_BUILD_ARGS=()
if [[ -n "$HTTP_PROXY_VAL" || -n "$HTTPS_PROXY_VAL" ]]; then
  DOCKER_BUILD_ARGS=(
    --build-arg "HTTP_PROXY=$HTTP_PROXY_VAL"
    --build-arg "HTTPS_PROXY=$HTTPS_PROXY_VAL"
    --build-arg "NO_PROXY=$NO_PROXY_VAL"
  )
fi

docker build \
    "${DOCKER_BUILD_ARGS[@]+"${DOCKER_BUILD_ARGS[@]}"}" \
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
echo "    --add-host api.anthropic.com:127.0.0.1 \\"
echo "    --add-host \"api.anthropic.com:::1\" \\"
echo "    --add-host anthropic.com:127.0.0.1 \\"
echo "    --add-host \"anthropic.com:::1\" \\"
echo "    --add-host claude.ai:127.0.0.1 \\"
echo "    --add-host \"claude.ai:::1\" \\"
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
