#!/bin/bash
# Vlaude Server Docker 构建脚本
# Mac ARM64 → NAS x86_64 跨架构构建
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
SHARED_CORE_DIR="$(cd "${PROJECT_DIR}/../shared-core" && pwd)"

IMAGE_NAME="${IMAGE_NAME:-vlaude-server}"
IMAGE_TAG="${1:-latest}"

echo "📦 构建 Vlaude Server Docker 镜像"
echo "   镜像: ${IMAGE_NAME}:${IMAGE_TAG}"
echo "   架构: linux/amd64"
echo "   项目: ${PROJECT_DIR}"
echo ""

# 1. 打包 shared-core（Docker 构建上下文只有 vlaude-server，需要把依赖带进来）
echo "📋 打包 shared-core..."
cd "${SHARED_CORE_DIR}"
pnpm build
TARBALL=$(pnpm pack --pack-destination "${PROJECT_DIR}" 2>&1 | tail -1)
TARBALL_NAME=$(basename "${TARBALL}")
echo "   产物: ${TARBALL_NAME}"
echo ""

# 2. 构建 Docker 镜像
cd "${PROJECT_DIR}"
docker build --platform linux/amd64 \
  --build-arg SHARED_CORE_TGZ="${TARBALL_NAME}" \
  -t "${IMAGE_NAME}:${IMAGE_TAG}" .

# 3. 清理 tarball
rm -f "${PROJECT_DIR}/${TARBALL_NAME}"

echo ""
echo "✅ 构建完成: ${IMAGE_NAME}:${IMAGE_TAG}"
docker inspect "${IMAGE_NAME}:${IMAGE_TAG}" --format='   架构: {{.Architecture}}'
docker images "${IMAGE_NAME}:${IMAGE_TAG}" --format='   大小: {{.Size}}'
