# Vlaude Server Dockerfile
# 构建命令: docker build --platform linux/amd64 -t vlaude-server .
# 架构: amd64 (群晖 NAS x86_64)

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

# 复制 package.json
COPY package.json ./

# 移除 workspace 依赖（如果有的话）
RUN sed -i 's/"@vimo-ai\/vlaude-shared-core": "workspace:\*"/"@vimo-ai\/vlaude-shared-core": "^0.0.1-beta.1"/g' package.json || true

# 安装依赖
RUN pnpm install

# 复制源码
COPY . .

# 生成 Prisma Client 并构建
RUN pnpm prisma:generate
RUN pnpm build

# ================================
# Production Stage
# ================================
FROM --platform=linux/amd64 node:22-alpine

# 安装运行时依赖
RUN apk add --no-cache \
    curl \
    bash \
    ca-certificates

WORKDIR /app

# 从 builder 复制构建产物
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/prisma ./prisma
# 复制 Prisma 生成的客户端到 dist 目录
COPY --from=builder /app/src/generated ./dist/generated

# 创建必要的目录
RUN mkdir -p /app/certs

# 暴露端口
EXPOSE 10005

# 环境变量说明:
# - DATABASE_URL: MySQL 连接字符串
# - PORT: 服务端口 (默认 10005)
# - NODE_ENV: 环境 (production)
# - JWT_PUBLIC_KEY / JWT_PRIVATE_KEY: JWT 密钥
# - IP_WHITELIST: IP 白名单
# - ENABLE_MTLS: 是否启用 mTLS (可选)

# 设置默认环境变量
ENV NODE_ENV=production
ENV PORT=10005

# 健康检查
HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
    CMD curl -f http://localhost:10005/health || exit 1

# 启动命令
CMD ["node", "dist/main.js"]
