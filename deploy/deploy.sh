#!/bin/bash
#
echo 'stop current container'
docker stop my_rd_cli 2>/dev/null || true
echo 'start container'
# 容器内 rdcli 用户 UID=1000。若宿主 /data/remote/workspace 权限不是 1000，
# 先执行: sudo chown -R 1000:1000 /data/remote/workspace
docker run -dit \
    --name my_rd_cli \
    --rm \
    --add-host api.anthropic.com:127.0.0.1 \
    --add-host "api.anthropic.com:::1" \
    --add-host anthropic.com:127.0.0.1 \
    --add-host "anthropic.com:::1" \
    --add-host claude.ai:127.0.0.1 \
    --add-host "claude.ai:::1" \
    -v /data/remote/workspace:/opt/workspace \
    -w /opt/workspace \
    -e ANTHROPIC_BASE_URL=http://192.168.1.104:16002 \
    -e ANTHROPIC_AUTH_TOKEN=sk-12345 \
    -e API_TIMEOUT_MS=600000 \
    -e ANTHROPIC_MODEL=deepseek-v4-pro \
    -e ANTHROPIC_SMALL_FAST_MODEL=deepseek-v4-pro \
    -e CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    -e CLAUDE_CODE_ATTRIBUTION_HEADER=0 \
    -p 19004:3001 \
    rd_cli:1.0.1

docker logs -f my_rd_cli
