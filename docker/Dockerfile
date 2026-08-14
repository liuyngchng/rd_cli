# ============================================================================
# Stage 1 – build rdcli + Pi from local source
# ============================================================================
FROM ubuntu:24.04 AS rdcli-builder

# Build tools for native npm modules (better-sqlite3, bcrypt, node-pty)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git build-essential python3 python3-setuptools \
    && rm -rf /var/lib/apt/lists/*

# Node.js from local tarball
COPY docker/node-v22.23.2-linux-x64.tar.xz /tmp/
RUN tar -xJf /tmp/node-v22.23.2-linux-x64.tar.xz -C /usr/local --strip-components=1 \
    && rm /tmp/node-v22.23.2-linux-x64.tar.xz

# Skip Electron binary download (not needed for server build)
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1

# Install all dependencies + build rdCLI
WORKDIR /build
COPY . .
RUN npm ci --no-audit --no-fund \
    && npm run build

# Build Pi from source (monorepo at ../pi relative to rdCLI)
COPY ../pi /opt/pi
WORKDIR /opt/pi
RUN npm ci --no-audit --no-fund \
    && npm run build:offline

# ============================================================================
# Stage 2 – final runtime image
# ============================================================================
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
# Python virtualenv – Office document processing
# ---------------------------------------------------------------------------
COPY docker/requirements.txt /opt/requirements.txt

RUN python3 -m venv /opt/llm_py_env \
    && . /opt/llm_py_env/bin/activate \
    && pip install --no-cache-dir -r /opt/requirements.txt \
    && rm -rf /root/.cache/pip

# ---------------------------------------------------------------------------
# Node.js – install from local tarball
# ---------------------------------------------------------------------------
ENV NVM_DIR=/root/.nvm \
    NODE_VERSION=v22.23.2

COPY docker/node-v22.23.2-linux-x64.tar.xz /tmp/

RUN mkdir -p "$NVM_DIR/versions/node" \
    && tar -xJf /tmp/node-v22.23.2-linux-x64.tar.xz -C "$NVM_DIR/versions/node" \
    && mv "$NVM_DIR/versions/node/node-v22.23.2-linux-x64" "$NVM_DIR/versions/node/$NODE_VERSION" \
    && mkdir -p "$NVM_DIR/alias" \
    && echo "$NODE_VERSION" > "$NVM_DIR/alias/default" \
    && rm /tmp/node-v22.23.2-linux-x64.tar.xz

ENV NODE_HOME=/root/.nvm/versions/node/v22.23.2
ENV PATH=/opt/llm_py_env/bin:${NODE_HOME}/bin:${PATH}

# ---------------------------------------------------------------------------
# Pi Coding Agent – built from local source (Stage 1)
# ---------------------------------------------------------------------------
# Copy Pi workspace packages (built dist/ + package.json) and external deps
WORKDIR /opt/pi
COPY --from=rdcli-builder /opt/pi/node_modules /opt/pi/node_modules
COPY --from=rdcli-builder /opt/pi/packages /opt/pi/packages

# Create symlinks so @earendil-works/* resolve to the built packages
RUN ln -s /opt/pi/packages/agent /opt/pi/node_modules/@earendil-works/pi-agent-core \
    && ln -s /opt/pi/packages/ai /opt/pi/node_modules/@earendil-works/pi-ai \
    && ln -s /opt/pi/packages/client /opt/pi/node_modules/@earendil-works/pi-client \
    && ln -s /opt/pi/packages/coding-agent /opt/pi/node_modules/@earendil-works/pi-coding-agent \
    && ln -s /opt/pi/packages/protocol /opt/pi/node_modules/@earendil-works/pi-protocol \
    && ln -s /opt/pi/packages/tui /opt/pi/node_modules/@earendil-works/pi-tui \
    && ln -s /opt/pi/packages/telemetry /opt/pi/node_modules/@earendil-works/pi-telemetry

# Wire up 'pi' command
RUN printf '#!/bin/sh\nexec node /opt/pi/packages/coding-agent/dist/cli.js "$@"\n' > ${NODE_HOME}/bin/pi \
    && chmod +x ${NODE_HOME}/bin/pi

# Set PI_PACKAGE_DIR so Pi's config.ts can locate its assets
ENV PI_PACKAGE_DIR=/opt/pi/packages/coding-agent

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
RUN npm ci --omit=dev --no-audit --no-fund \
    && npm cache clean --force

# Wire up the rdcli command
# (tsc emits cli.js with 0644 perms and no exec bit – chmod it so runc can exec it)
RUN chmod +x /opt/rdcli/dist-server/server/modules/cli/cli.js \
    && ln -s /opt/rdcli/dist-server/server/modules/cli/cli.js ${NODE_HOME}/bin/rdcli

# ---------------------------------------------------------------------------
# Pi agent config – default settings
# ---------------------------------------------------------------------------
RUN mkdir -p /root/.pi/agent

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------
WORKDIR /opt/workspace
EXPOSE 3001

CMD ["/root/.nvm/versions/node/v22.23.2/bin/rdcli"]
