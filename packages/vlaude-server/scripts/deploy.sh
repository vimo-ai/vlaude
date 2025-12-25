#!/bin/bash
# Vlaude Server NAS 部署脚本
# 将镜像传输到群晖 NAS 并启动容器
set -e

IMAGE_NAME="${IMAGE_NAME:-vlaude-server}"
CONTAINER_NAME="${CONTAINER_NAME:-${IMAGE_NAME}}"
TAG="${1:-latest}"
FULL_IMAGE="${IMAGE_NAME}:${TAG}"

# NAS 连接配置
NAS_HOST="${NAS_HOST:-192.168.50.9}"
NAS_USER="${NAS_USER:-aguai}"
NAS_PORT="${NAS_PORT:-22}"
NAS_SSH_KEY="${NAS_SSH_KEY:-${HOME}/.ssh/nas}"

# 端口配置
HTTP_PORT="${HTTP_PORT:-10005}"

# 数据目录
DATA_DIR="/volume2/docker/${CONTAINER_NAME}/data"
CONFIG_DIR="/volume2/docker/${CONTAINER_NAME}/config"
CERTS_DIR="/volume2/docker/${CONTAINER_NAME}/certs"
DB_DIR="/volume2/docker/${CONTAINER_NAME}/db"

# 数据库配置
DATABASE_URL="${DATABASE_URL:-mysql://root:zhangyifan46!@192.168.50.9:6603/vlaude}"

# Daemon 配置 (vlaude-daemon 运行在 Mac 上)
DAEMON_HOST="${DAEMON_HOST:-192.168.50.229}"
DAEMON_PORT="${DAEMON_PORT:-10006}"

# JWT 配置 - 使用文件挂载方式
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
LOCAL_CERTS_DIR="${PROJECT_DIR}/certs"

# 检查本地证书文件
if [ -f "${LOCAL_CERTS_DIR}/jwt-public.pem" ] && [ -f "${LOCAL_CERTS_DIR}/jwt-private.pem" ]; then
    echo "📄 找到 JWT 证书文件，将上传到 NAS"
    UPLOAD_JWT_CERTS=true
else
    echo "⚠️  未找到 JWT 证书文件 (${LOCAL_CERTS_DIR})"
    UPLOAD_JWT_CERTS=false
fi

# 检查 mTLS 证书文件
if [ -f "${LOCAL_CERTS_DIR}/ca.crt" ] && [ -f "${LOCAL_CERTS_DIR}/server.crt" ] && [ -f "${LOCAL_CERTS_DIR}/server.key" ]; then
    echo "🔐 找到 mTLS 证书文件，将上传到 NAS"
    UPLOAD_MTLS_CERTS=true
    ENABLE_MTLS=true
else
    echo "⚠️  未找到 mTLS 证书文件 (${LOCAL_CERTS_DIR})"
    UPLOAD_MTLS_CERTS=false
    ENABLE_MTLS=false
fi

# IP 白名单
IP_WHITELIST="${IP_WHITELIST:-192.168.50.0/24,127.0.0.1,::1}"

# Redis 服务注册中心
REDIS_HOST="${REDIS_HOST:-192.168.50.9}"
REDIS_PORT="${REDIS_PORT:-6379}"

# Server 地址（用于服务注册，其他组件通过这个地址连接）
SERVER_ADDRESS="${SERVER_ADDRESS:-${NAS_HOST}:${HTTP_PORT}}"

echo "🚀 部署 Vlaude Server 到 NAS"
echo "   镜像: ${FULL_IMAGE}"
echo "   目标: ${NAS_USER}@${NAS_HOST}:${NAS_PORT}"
echo "   HTTP 端口: ${HTTP_PORT}"
echo ""

# 检查镜像是否存在
if ! docker image inspect "${FULL_IMAGE}" &>/dev/null; then
    echo "❌ 错误: 镜像 ${FULL_IMAGE} 不存在，请先运行 build.sh"
    exit 1
fi

# 检查 JWT 配置
if [ "${UPLOAD_JWT_CERTS}" = "false" ]; then
    echo "⚠️  警告: JWT 密钥未配置"
    echo "   请将密钥文件放在: certs/jwt-public.pem, certs/jwt-private.pem"
    echo ""
    read -p "是否继续部署（不含 JWT 配置）？[y/N] " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

echo "📤 传输镜像到 NAS..."
docker save "${FULL_IMAGE}" | ssh -i "${NAS_SSH_KEY}" -p ${NAS_PORT} "${NAS_USER}@${NAS_HOST}" "/usr/local/bin/docker load"

echo ""
echo "🔧 配置并启动容器..."

# 先创建远程目录
ssh -i "${NAS_SSH_KEY}" -p ${NAS_PORT} "${NAS_USER}@${NAS_HOST}" "mkdir -p ${DATA_DIR} ${CONFIG_DIR} ${CERTS_DIR} ${DB_DIR}"

# 上传 JWT 证书文件（如果存在）- 使用 ssh + cat 方式
if [ "${UPLOAD_JWT_CERTS}" = "true" ]; then
    echo "📄 上传 JWT 证书到 NAS..."
    cat "${LOCAL_CERTS_DIR}/jwt-public.pem" | ssh -i "${NAS_SSH_KEY}" -p ${NAS_PORT} "${NAS_USER}@${NAS_HOST}" "cat > ${CERTS_DIR}/jwt-public.pem"
    cat "${LOCAL_CERTS_DIR}/jwt-private.pem" | ssh -i "${NAS_SSH_KEY}" -p ${NAS_PORT} "${NAS_USER}@${NAS_HOST}" "cat > ${CERTS_DIR}/jwt-private.pem"
    echo "   ✅ JWT 证书已上传"
fi

# 上传 mTLS 证书文件（如果存在）
if [ "${UPLOAD_MTLS_CERTS}" = "true" ]; then
    echo "🔐 上传 mTLS 证书到 NAS..."
    cat "${LOCAL_CERTS_DIR}/ca.crt" | ssh -i "${NAS_SSH_KEY}" -p ${NAS_PORT} "${NAS_USER}@${NAS_HOST}" "cat > ${CERTS_DIR}/ca.crt"
    cat "${LOCAL_CERTS_DIR}/server.crt" | ssh -i "${NAS_SSH_KEY}" -p ${NAS_PORT} "${NAS_USER}@${NAS_HOST}" "cat > ${CERTS_DIR}/server.crt"
    cat "${LOCAL_CERTS_DIR}/server.key" | ssh -i "${NAS_SSH_KEY}" -p ${NAS_PORT} "${NAS_USER}@${NAS_HOST}" "cat > ${CERTS_DIR}/server.key"
    echo "   ✅ mTLS 证书已上传"
fi

ssh -i "${NAS_SSH_KEY}" -p ${NAS_PORT} "${NAS_USER}@${NAS_HOST}" << EOF
set -e

# 停止并删除旧容器
/usr/local/bin/docker stop ${CONTAINER_NAME} 2>/dev/null || true
/usr/local/bin/docker rm -f ${CONTAINER_NAME} 2>/dev/null || true

# 启动新容器
# 使用 --network host 模式
/usr/local/bin/docker run -d \
    --name ${CONTAINER_NAME} \
    --restart unless-stopped \
    --network host \
    -v ${DATA_DIR}:/app/data \
    -v ${CONFIG_DIR}:/app/config \
    -v ${CERTS_DIR}:/app/certs \
    -v ${DB_DIR}:/app/prisma \
    -e NODE_ENV=production \
    -e PORT=${HTTP_PORT} \
    -e "DATABASE_URL=${DATABASE_URL}" \
    -e "IP_WHITELIST=${IP_WHITELIST}" \
    -e "PRISMA_QUERY_ENGINE_LIBRARY=/app/dist/generated/prisma/libquery_engine-linux-musl-openssl-3.0.x.so.node" \
    -e "JWT_PUBLIC_KEY_PATH=certs/jwt-public.pem" \
    -e "JWT_PRIVATE_KEY_PATH=certs/jwt-private.pem" \
    -e "ENABLE_MTLS=${ENABLE_MTLS}" \
    -e "DAEMON_HOST=${DAEMON_HOST}" \
    -e "DAEMON_PORT=${DAEMON_PORT}" \
    -e "REDIS_HOST=${REDIS_HOST}" \
    -e "REDIS_PORT=${REDIS_PORT}" \
    -e "SERVER_ADDRESS=${SERVER_ADDRESS}" \
    ${FULL_IMAGE}

echo ""
echo "📋 容器状态:"
/usr/local/bin/docker ps | grep ${CONTAINER_NAME} || echo "容器未运行"

echo ""
echo "📝 容器日志 (最近 10 行):"
sleep 2
/usr/local/bin/docker logs --tail 10 ${CONTAINER_NAME} 2>&1 || true
EOF

echo ""
echo "✅ 部署完成!"
if [ "${ENABLE_MTLS}" = "true" ]; then
    echo "🔐 mTLS 已启用"
    echo "   HTTPS API: https://${NAS_HOST}:${HTTP_PORT}"
    echo "   健康检查: https://${NAS_HOST}:${HTTP_PORT}/health"
else
    echo "   HTTP API: http://${NAS_HOST}:${HTTP_PORT}"
    echo "   健康检查: http://${NAS_HOST}:${HTTP_PORT}/health"
fi
echo ""
echo "📌 后续操作:"
echo "   查看日志: ssh -i ${NAS_SSH_KEY} ${NAS_USER}@${NAS_HOST} '/usr/local/bin/docker logs -f ${CONTAINER_NAME}'"
echo "   进入容器: ssh -i ${NAS_SSH_KEY} ${NAS_USER}@${NAS_HOST} '/usr/local/bin/docker exec -it ${CONTAINER_NAME} sh'"
