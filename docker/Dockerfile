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
# ---------------------------------------------------------------------------
# python3-venv + python3-pip        → Python virtualenv & package management
# build-essential + python3-setuptools → compile native npm modules
# LibreOffice writer/calc/impress/draw → Office doc processing (doc→docx, etc.)
# pandoc                            → document format conversion (pypandoc)
# ffmpeg                            → media processing
# ripgrep / jq / sqlite3 / zip ...  → runtime tooling for Claude Code
# ---------------------------------------------------------------------------
RUN apt-get update && apt-get install -y --no-install-recommends \
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
    vim-tiny \
    && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# Python virtualenv – Office document processing (Word, PDF, Excel, PPT)
# ---------------------------------------------------------------------------
# Activating: the venv bin directory is prepended to PATH below so Python
# scripts and Claude Code always see the venv packages.
# ---------------------------------------------------------------------------
COPY requirements.txt /opt/requirements.txt

RUN python3 -m venv /opt/llm_py_env \
    && . /opt/llm_py_env/bin/activate \
    && pip install --no-cache-dir -r /opt/requirements.txt \
    && rm -rf /root/.cache/pip

# ---------------------------------------------------------------------------
# Node.js – install from local tarball (no network needed for this step)
# ---------------------------------------------------------------------------
# Uses nvm-compatible directory layout so npm global packages land in the
# expected path and CMD can use the familiar nvm-style absolute path.
# ---------------------------------------------------------------------------
ENV NVM_DIR=/root/.nvm \
    NODE_VERSION=v22.23.2

COPY node-v22.23.2-linux-x64.tar.xz /tmp/

RUN mkdir -p "$NVM_DIR/versions/node" \
    && tar -xJf /tmp/node-v22.23.2-linux-x64.tar.xz -C "$NVM_DIR/versions/node" \
    && mv "$NVM_DIR/versions/node/node-v22.23.2-linux-x64" "$NVM_DIR/versions/node/$NODE_VERSION" \
    && mkdir -p "$NVM_DIR/alias" \
    && echo "$NODE_VERSION" > "$NVM_DIR/alias/default" \
    && rm /tmp/node-v22.23.2-linux-x64.tar.xz

# Prepend both nvm Node bin and Python venv to PATH
ENV NODE_HOME=/root/.nvm/versions/node/v22.23.2
ENV PATH=/opt/llm_py_env/bin:${NODE_HOME}/bin:${PATH}

# ---------------------------------------------------------------------------
# Claude Code CLI
# ---------------------------------------------------------------------------
RUN npm install -g @anthropic-ai/claude-code \
    --fetch-retries=5 \
    --fetch-retry-mintimeout=20000 \
    --fetch-retry-maxtimeout=120000 \
    --fetch-timeout=600000 \
    --no-audit \
    --no-fund \
    && npm cache clean --force

# ---------------------------------------------------------------------------
# rdCLI – web-based UI for Claude Code
# ---------------------------------------------------------------------------
RUN npm install -g @rdcli-ai/rdcli \
    --fetch-retries=5 \
    --fetch-retry-mintimeout=20000 \
    --fetch-retry-maxtimeout=120000 \
    --fetch-timeout=600000 \
    --no-audit \
    --no-fund \
    && npm cache clean --force

# ---------------------------------------------------------------------------
# Claude Code global memory – office document assistant role
# ---------------------------------------------------------------------------
RUN mkdir -p /root/.claude
COPY CLAUDE.md /root/.claude/CLAUDE.md

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------
EXPOSE 3001

CMD ["/root/.nvm/versions/node/v22.23.2/bin/rdcli"]
