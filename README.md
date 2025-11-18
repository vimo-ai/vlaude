# Vlaude

跨设备 Claude Code 对话系统

## 项目结构

```
vlaude/
├── packages/
│   ├── shared-core/          # 共享领域模型(纯 TypeScript)
│   ├── vlaude-daemon/         # MAC 本地服务(NestJS)
│   ├── vlaude-server/         # NAS 服务器(NestJS)
│   └── vlaude-cli/            # CLI 工具
├── pnpm-workspace.yaml        # pnpm workspace 配置
├── package.json               # 根 package.json
└── README.md
```

## 技术栈

- **语言**: TypeScript
- **包管理**: pnpm workspace
- **测试框架**: Vitest
- **编译器**: SWC
- **后端框架**: NestJS (Fastify)
- **数据库**: MySQL + Prisma
- **实时通信**: Socket.IO + WebSocket

## 快速开始

### 安装依赖

```bash
pnpm install
```

### 开发

```bash
# 启动 daemon
pnpm dev:daemon

# 启动 server
pnpm dev:server
```

### 测试

```bash
# 运行所有测试
pnpm test

# 运行单元测试
pnpm test:unit

# 运行 E2E 测试
pnpm test:e2e

# 测试覆盖率
pnpm test:coverage
```

### 构建

```bash
pnpm build
```

## 架构说明

### shared-core

纯领域模型包,无外部依赖,提供:
- `ClaudeSessionAR`: Session 聚合根
- `ClaudeMessageEntity`: Message 实体
- `IClaudeSessionBaseRepo`: Repository 接口

### vlaude-daemon

MAC 本地服务,提供:
- HTTP API (供 server 调用)
- WebSocket Server (与 CLI 通信)
- Socket.IO Client (推送事件给 server)
- Claude SDK 集成
- 文件监听与数据采集

### vlaude-server

NAS 服务器,提供:
- HTTP REST API (供 mobile 调用)
- Socket.IO Server (实时通信)
- MySQL 数据持久化
- 跨设备状态协调

## 开发规范

- 所有项目遵循 DDD 分层架构
- 测试覆盖率 > 80%
- 使用 Vitest 进行测试
- 使用 SWC 编译,提升性能

## License

ISC
