FROM ubuntu:24.04

# ---------------------------------------------------------------------------
# Locale, timezone & misc
# ---------------------------------------------------------------------------
ENV LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    TZ=Asia/Shanghai \
    NODE_TLS_REJECT_UNAUTHORIZED=0

# ---------------------------------------------------------------------------
# System dependencies
# build-essential + python3 are required to compile native npm modules
# (better-sqlite3, bcrypt, node-pty). The rest are runtime conveniences.
# ---------------------------------------------------------------------------
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    build-essential \
    python3 \
    python3-setuptools \
    jq \
    ripgrep \
    sqlite3 \
    zip \
    unzip \
    tree \
    vim-tiny \
    && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# nvm + Node.js v22.22.3
# ---------------------------------------------------------------------------
ENV NVM_DIR=/root/.nvm \
    NODE_VERSION=v22.22.3

RUN mkdir -p "$NVM_DIR" \
    && curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash \
    && . "$NVM_DIR/nvm.sh" \
    && nvm install "$NODE_VERSION" \
    && nvm alias default "$NODE_VERSION" \
    && nvm cache clear

# Make node / npm / npx available in all subsequent layers and at runtime
ENV NODE_HOME=/root/.nvm/versions/node/v22.22.3
ENV PATH=${NODE_HOME}/bin:${PATH}

# ---------------------------------------------------------------------------
# Claude Code CLI
# ---------------------------------------------------------------------------
RUN npm install -g @anthropic-ai/claude-code \
    --fetch-retries=5 \
    --fetch-retry-mintimeout=20000 \
    --fetch-retry-maxtimeout=120000 \
    --fetch-timeout=600000 \
    --no-audit \
    --no-fund

# ---------------------------------------------------------------------------
# rdCLI – web-based UI for Claude Code
# ---------------------------------------------------------------------------
RUN npm install -g @rdcli-ai/rdcli \
    --fetch-retries=5 \
    --fetch-retry-mintimeout=20000 \
    --fetch-retry-maxtimeout=120000 \
    --fetch-timeout=600000 \
    --no-audit \
    --no-fund

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------
EXPOSE 3001

CMD ["/root/.nvm/versions/node/v22.22.3/bin/rdcli"]
