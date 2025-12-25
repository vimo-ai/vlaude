#!/bin/bash
# Vlaude Server Docker 构建脚本
# 构建 amd64 镜像（适配群晖 NAS）
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

IMAGE_NAME="${IMAGE_NAME:-vlaude-server}"
IMAGE_TAG="${1:-latest}"

echo "📦 构建 Vlaude Server Docker 镜像"
echo "   镜像: ${IMAGE_NAME}:${IMAGE_TAG}"
echo "   架构: linux/amd64"
echo "   项目目录: ${PROJECT_DIR}"
echo ""

cd "${PROJECT_DIR}"

# 检查必要文件
if [ ! -f "Dockerfile" ]; then
    echo "❌ 错误: 未找到 Dockerfile"
    exit 1
fi

if [ ! -f "package.json" ]; then
    echo "❌ 错误: 未找到 package.json"
    exit 1
fi

# 构建镜像
docker build \
    --platform linux/amd64 \
    -t "${IMAGE_NAME}:${IMAGE_TAG}" \
    .

echo ""
echo "✅ 构建完成: ${IMAGE_NAME}:${IMAGE_TAG}"
docker inspect "${IMAGE_NAME}:${IMAGE_TAG}" --format='   架构: {{.Architecture}}'
docker images "${IMAGE_NAME}:${IMAGE_TAG}" --format='   大小: {{.Size}}'
