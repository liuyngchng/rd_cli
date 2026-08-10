FROM docker/sandbox-templates:claude-code

USER root
COPY shared/install-rdcli.sh /tmp/install-rdcli.sh
RUN chmod +x /tmp/install-rdcli.sh && /tmp/install-rdcli.sh

USER agent
RUN --mount=type=cache,target=/tmp/npm-cache,sharing=locked,mode=0777 \
    npm install -g @rdcli-ai/rdcli \
      --cache=/tmp/npm-cache \
      --fetch-retries=5 \
      --fetch-retry-mintimeout=20000 \
      --fetch-retry-maxtimeout=120000 \
      --fetch-timeout=600000 \
      --no-audit \
      --no-fund && \
    cloudcli --version

COPY --chown=agent:agent shared/start-rdcli.sh /home/agent/.rdcli-start.sh
RUN echo '. ~/.rdcli-start.sh' >> /home/agent/.bashrc
