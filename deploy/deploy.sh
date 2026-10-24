#!/bin/bash
#
echo 'stop current container'
docker stop my_rd_cli 2>/dev/null || true
echo 'start container'
# 容器内 rdcli 用户。若宿主 /data/remote/workspace 权限不匹配，
# 先执行: sudo chown -R <uid> /data/remote/workspace
# 查看容器内 rdcli 的 uid: docker exec my_rd_cli id -u rdcli
docker run -dit \
    --name my_rd_cli \
    --rm \
    --add-host api.anthropic.com:127.0.0.1 \
    --add-host "api.anthropic.com:::1" \
    --add-host anthropic.com:127.0.0.1 \
    --add-host "anthropic.com:::1" \
    --add-host claude.ai:127.0.0.1 \
    --add-host "claude.ai:::1" \
    -v /data/remote/workspace:/home/rdcli/workspace \
    -w /home/rdcli/workspace \
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
