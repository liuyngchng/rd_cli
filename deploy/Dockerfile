# syntax=docker/dockerfile:1

# ============================================================================
# Stage 1 – build rdcli from local source
# ============================================================================
FROM ubuntu:24.04 AS rdcli-builder

# ---- Proxy support (apt + npm in this stage) -------------------------------
ARG HTTP_PROXY=""
ARG HTTPS_PROXY=""
ARG NO_PROXY=""
ENV HTTP_PROXY="$HTTP_PROXY" HTTPS_PROXY="$HTTPS_PROXY" NO_PROXY="$NO_PROXY" \
    http_proxy="$HTTP_PROXY" https_proxy="$HTTPS_PROXY" no_proxy="$NO_PROXY"

RUN if [ -n "$HTTP_PROXY" ]; then \
        echo 'Acquire::http::Proxy "'$HTTP_PROXY'";' > /etc/apt/apt.conf.d/01proxy; \
    fi; \
    if [ -n "$HTTPS_PROXY" ]; then \
        echo 'Acquire::https::Proxy "'$HTTPS_PROXY'";' >> /etc/apt/apt.conf.d/01proxy; \
    fi

# Build tools for native npm modules (better-sqlite3, bcrypt, node-pty)
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git build-essential python3 python3-setuptools

# Node.js from local tarball
COPY deploy/node-v22.23.2-linux-x64.tar.xz /tmp/
RUN tar -xJf /tmp/node-v22.23.2-linux-x64.tar.xz -C /usr/local --strip-components=1 \
    && rm /tmp/node-v22.23.2-linux-x64.tar.xz

# Skip Electron binary download (not needed for server build)
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1

# Install all dependencies + build
WORKDIR /build
COPY . .
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund \
    && npm run build

# ============================================================================
# Stage 2 – final runtime image
# ============================================================================
FROM ubuntu:24.04

# ---- Proxy support (apt + npm + pip in this stage) -------------------------
ARG HTTP_PROXY=""
ARG HTTPS_PROXY=""
ARG NO_PROXY=""
ENV HTTP_PROXY="$HTTP_PROXY" HTTPS_PROXY="$HTTPS_PROXY" NO_PROXY="$NO_PROXY" \
    http_proxy="$HTTP_PROXY" https_proxy="$HTTPS_PROXY" no_proxy="$NO_PROXY"

RUN if [ -n "$HTTP_PROXY" ]; then \
        echo 'Acquire::http::Proxy "'$HTTP_PROXY'";' > /etc/apt/apt.conf.d/01proxy; \
    fi; \
    if [ -n "$HTTPS_PROXY" ]; then \
        echo 'Acquire::https::Proxy "'$HTTPS_PROXY'";' >> /etc/apt/apt.conf.d/01proxy; \
    fi

# ---------------------------------------------------------------------------
# Locale, timezone & misc
# ---------------------------------------------------------------------------
ENV LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    TZ=Asia/Shanghai \
    NODE_TLS_REJECT_UNAUTHORIZED=0

# ---------------------------------------------------------------------------
# System dependencies
# ---------------------------------------------------------------------------
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    build-essential \
    python3 \
    python3-venv \
    python3-pip \
    python3-setuptools \
    pandoc \
    ffmpeg \
    libreoffice-writer \
    libreoffice-calc \
    libreoffice-impress \
    libreoffice-draw \
    jq \
    ripgrep \
    sqlite3 \
    zip \
    unzip \
    tree \
    vim-tiny


# ---------------------------------------------------------------------------
# Python virtualenv – Office document processing
# ---------------------------------------------------------------------------
# Set PIP_OFFLINE_=1 to install from pre-downloaded packages offline
# (build.sh pip_download_dir=<dir> does this automatically).
ARG PIP_OFFLINE_=""
COPY deploy/requirements.txt /opt/requirements.txt

# Pre-downloaded pip packages (build.sh populates deploy/.pip-offline/ when
# pip_download_dir=<dir> is given; otherwise it contains only a .gitkeep).
COPY deploy/.pip-offline/ /opt/.pip-offline/

RUN python3 -m venv /opt/llm_py_env

# Offline path: install from local packages, no network needed.
RUN if [ -n "$PIP_OFFLINE_" ] && ls /opt/.pip-offline/*.whl /opt/.pip-offline/*.tar.gz 2>/dev/null; then \
      echo "Pip offline install from /opt/.pip-offline"; \
      /opt/llm_py_env/bin/pip install \
        --no-index \
        --find-links /opt/.pip-offline \
        -r /opt/requirements.txt; \
    fi

# Online path (skipped when offline install succeeded above).
RUN --mount=type=cache,target=/root/.cache/pip \
    if [ -z "$PIP_OFFLINE_" ] || ! ls /opt/.pip-offline/*.whl /opt/.pip-offline/*.tar.gz 2>/dev/null; then \
      /opt/llm_py_env/bin/pip install -r /opt/requirements.txt; \
    fi

RUN rm -rf /opt/.pip-offline

# ---------------------------------------------------------------------------
# Node.js – install from local tarball
# ---------------------------------------------------------------------------
ENV NVM_DIR=/root/.nvm \
    NODE_VERSION=v22.23.2

COPY deploy/node-v22.23.2-linux-x64.tar.xz /tmp/

RUN mkdir -p "$NVM_DIR/versions/node" \
    && tar -xJf /tmp/node-v22.23.2-linux-x64.tar.xz -C "$NVM_DIR/versions/node" \
    && mv "$NVM_DIR/versions/node/node-v22.23.2-linux-x64" "$NVM_DIR/versions/node/$NODE_VERSION" \
    && mkdir -p "$NVM_DIR/alias" \
    && echo "$NODE_VERSION" > "$NVM_DIR/alias/default" \
    && rm /tmp/node-v22.23.2-linux-x64.tar.xz

ENV NODE_HOME=/root/.nvm/versions/node/v22.23.2
ENV PATH=/opt/llm_py_env/bin:${NODE_HOME}/bin:${PATH}

# ---------------------------------------------------------------------------
# Claude Code CLI
# ---------------------------------------------------------------------------
# When build.sh finds a host-installed claude binary, it copies it into
# deploy/claude-code/ and sets CLAUDE_CODE_OFFLINE=1 — offline install.
# Otherwise falls back to `npm install -g` (requires network).
ARG CLAUDE_CODE_OFFLINE=""
COPY deploy/claude-code/ /opt/claude-code/

# Offline path: use the host-provided binary, no network.
RUN if [ -n "$CLAUDE_CODE_OFFLINE" ] && [ -f /opt/claude-code/claude ]; then \
      echo "Installing Claude Code CLI from local binary"; \
      chmod +x /opt/claude-code/claude; \
      ln -sf /opt/claude-code/claude ${NODE_HOME}/bin/claude; \
    fi

# Online fallback path (skipped when the binary was installed above).
RUN --mount=type=cache,target=/root/.npm \
    if [ -z "$CLAUDE_CODE_OFFLINE" ] || [ ! -f /opt/claude-code/claude ]; then \
      echo "Claude Code CLI local binary not found, falling back to npm install"; \
      npm install -g @anthropic-ai/claude-code \
        --fetch-retries=5 \
        --fetch-retry-mintimeout=20000 \
        --fetch-retry-maxtimeout=120000 \
        --fetch-timeout=600000 \
        --no-audit \
        --no-fund; \
    fi

# ---------------------------------------------------------------------------
# rdCLI – built from local source (Stage 1), never published to npm
# ---------------------------------------------------------------------------
WORKDIR /opt/rdcli

# Copy compiled output + package metadata from builder
COPY --from=rdcli-builder /build/dist        /opt/rdcli/dist
COPY --from=rdcli-builder /build/dist-server /opt/rdcli/dist-server
COPY --from=rdcli-builder /build/public      /opt/rdcli/public
COPY --from=rdcli-builder /build/shared      /opt/rdcli/shared
COPY --from=rdcli-builder /build/package.json      /opt/rdcli/
COPY --from=rdcli-builder /build/package-lock.json /opt/rdcli/
COPY --from=rdcli-builder /build/scripts/fix-node-pty.js /opt/rdcli/scripts/

# Install production dependencies + compile native modules
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --no-audit --no-fund

# Wire up the rdcli command
# (tsc emits cli.js with 0644 perms and no exec bit – chmod it so runc can exec it)
RUN chmod +x /opt/rdcli/dist-server/server/modules/cli/cli.js \
    && ln -s /opt/rdcli/dist-server/server/modules/cli/cli.js ${NODE_HOME}/bin/rdcli

# ---------------------------------------------------------------------------
# Claude Code global memory – office document assistant role
# ---------------------------------------------------------------------------
RUN mkdir -p /root/.claude
COPY deploy/CLAUDE.md /root/.claude/CLAUDE.md

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------
WORKDIR /opt/workspace
EXPOSE 3001

CMD ["/root/.nvm/versions/node/v22.23.2/bin/rdcli"]
