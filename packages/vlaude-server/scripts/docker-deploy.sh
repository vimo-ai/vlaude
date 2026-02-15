#!/bin/bash
# Vlaude Server NAS 部署脚本
# 构建 → SSH 管道传输 → 启动容器
set -e

IMAGE_NAME="${IMAGE_NAME:-vlaude-server}"
CONTAINER_NAME="${CONTAINER_NAME:-vlaude-server}"
TAG="${1:-latest}"
FULL_IMAGE="${IMAGE_NAME}:${TAG}"

# NAS 连接配置
NAS_HOST="${NAS_HOST:-10.0.0.1}"
NAS_USER="${NAS_USER:-aguai}"
NAS_DOCKER="/usr/local/bin/docker"

# 服务发现注册地址（必须是外部可达的地址）
SERVER_ADDRESS="${SERVER_ADDRESS:-***REMOVED-domain***:10005}"

# NAS 上的 Redis（服务发现 + 状态管理）
REDIS_HOST="${REDIS_HOST:-127.0.0.1}"
REDIS_PORT="${REDIS_PORT:-6379}"
REDIS_PASSWORD="${REDIS_PASSWORD:-***REMOVED-redis***}"

# mTLS 证书目录（NAS 上的路径）
NAS_CERTS_DIR="${NAS_CERTS_DIR:-/var/services/homes/aguai/vlaude-certs}"

echo "🚀 部署 ${FULL_IMAGE} → ${NAS_HOST}"
echo ""

# 1. 传输镜像
echo "📤 传输镜像到 NAS..."
docker save "${FULL_IMAGE}" | ssh "${NAS_USER}@${NAS_HOST}" "${NAS_DOCKER} load"
echo ""

# 2. 停止旧容器 + 启动新容器
echo "🔄 重启容器..."
ssh "${NAS_USER}@${NAS_HOST}" << EOF
set -e
${NAS_DOCKER} stop ${CONTAINER_NAME} 2>/dev/null || true
${NAS_DOCKER} rm -f ${CONTAINER_NAME} 2>/dev/null || true

${NAS_DOCKER} run -d \
  --name ${CONTAINER_NAME} \
  --restart unless-stopped \
  --network host \
  -v ${NAS_CERTS_DIR}:/app/certs:ro \
  -e NODE_ENV=production \
  -e PORT=10005 \
  -e ENABLE_MTLS=true \
  -e IP_WHITELIST=192.168.0.0/16,10.0.0.0/8,172.16.0.0/12,127.0.0.1 \
  -e SERVER_ADDRESS=${SERVER_ADDRESS} \
  -e REDIS_HOST=${REDIS_HOST} \
  -e REDIS_PORT=${REDIS_PORT} \
  -e REDIS_PASSWORD=${REDIS_PASSWORD} \
  ${FULL_IMAGE}

echo ""
echo "📋 容器状态:"
${NAS_DOCKER} ps --filter name=${CONTAINER_NAME} --format 'table {{.Names}}\t{{.Status}}'
EOF

echo ""
echo "✅ 部署完成"
echo "   内网: https://${NAS_HOST}:10005/health (mTLS)"
echo "   外网: https://***REMOVED-domain***:10005/health (mTLS)"
