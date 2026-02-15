# Vlaude Server Dockerfile
# 构建命令: docker build --platform linux/amd64 -t vlaude-server .
# 架构: amd64 (群晖 NAS x86_64)
#
# 纯 forward 代理模式
# - 无数据库依赖，所有请求透传到 Daemon
# - Server 部署在 NAS，Daemon/VlaudeKit 运行在 Mac

# ================================
# Builder Stage
# ================================
FROM --platform=linux/amd64 node:22-alpine AS builder

# 安装构建依赖
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    git \
    openssl

WORKDIR /app

# 安装 pnpm
RUN npm install -g pnpm@9.15.0

# shared-core tarball（由 docker-build.sh 预先打包）
ARG SHARED_CORE_TGZ=vimo-ai-vlaude-shared-core-0.0.1-beta.1.tgz

# 复制 package.json + shared-core tarball
COPY package.json ./
COPY ${SHARED_CORE_TGZ} ./shared-core.tgz

# workspace 依赖替换为本地 tarball
RUN sed -i 's/"@vimo-ai\/vlaude-shared-core": "workspace:\*"/"@vimo-ai\/vlaude-shared-core": "file:shared-core.tgz"/g' package.json

# 安装依赖
RUN pnpm install

# 复制源码
COPY . .

# 构建
RUN pnpm build

# ================================
# Production Stage
# ================================
FROM --platform=linux/amd64 node:22-alpine

RUN apk add --no-cache \
    curl \
    bash \
    ca-certificates

WORKDIR /app

# 从 builder 复制构建产物
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

# 创建证书目录（mTLS 可选）
RUN mkdir -p /app/certs

EXPOSE 10005

# 环境变量:
# PORT            服务端口 (默认 10005)
# NODE_ENV        环境 (production)
# IP_WHITELIST    IP 白名单 (逗号分隔 CIDR)
# REDIS_HOST      Redis 地址 (服务发现/状态管理)
# REDIS_PORT      Redis 端口
# REDIS_PASSWORD  Redis 密码
# JWT_PUBLIC_KEY  JWT 公钥 (可选)
# ENABLE_MTLS     启用 mTLS (可选)

ENV NODE_ENV=production
ENV PORT=10005

HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
    CMD curl -f http://localhost:10005/health || exit 1

CMD ["node", "dist/main.js"]
