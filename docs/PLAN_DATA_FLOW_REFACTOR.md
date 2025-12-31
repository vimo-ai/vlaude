# 数据流重构计划

> 目标：修复 Server 数据不更新问题，让 Server 直接读 SharedDb
> 最后更新: 2025-12-30

## 一、问题回顾

### 现象
Vlaude Swift 端显示 12 月 28 号的旧数据

### 根本原因
```
ProjectService.getAllProjects()
  ↓
  先返回 Prisma 缓存（旧数据）
  ↓
  后台调用 HTTP API 刷新 → 失败（Daemon 没有 HTTP server）
  ↓
  缓存永远不更新
```

---

## 二、架构决策（已确定）

### 决策 1: Server 直接读 SharedDb

**不是纯中转**，Server 应该直接读 SharedDb（SQLite），不需要依赖 Daemon/VlaudeKit 做数据中转。

### 决策 2: 自动检测本地/远程模式

```typescript
const sharedDbPath = '~/.vimo/db/claude-session.db';
const isLocalMode = fs.existsSync(sharedDbPath);

if (isLocalMode) {
  // 直接读 SharedDb
} else {
  // 远程模式：SharedDb 通过 rsync 同步过来，同样直接读
}
```

### 决策 3: 远程模式用 rsync 同步 SharedDb

SharedDb 本质是 SQLite 文件，可以直接 rsync 同步到服务器。

| 模式 | SharedDb 位置 | 同步方式 |
|------|---------------|----------|
| 本地 | Mac `~/.vimo/db/claude-session.db` | 无需同步 |
| 远程 | NAS `~/.vimo/db/claude-session.db` | rsync 从 Mac 同步 |

### 决策 4: Prisma 数据库保留但不再作为主数据源

先保留 Prisma，验证新逻辑稳定后再决定是否移除。

---

## 三、已完成

- [x] 路径统一迁移：`~/.eterm/session.db` → `~/.vimo/db/claude-session.db`
  - ETermPaths.swift (ETerm 主应用 + ETermKit SDK)
  - VlaudeKit/SharedDbBridge.swift
  - MemexKit/SharedDbBridge.swift
  - daemon-logic/src/shared_db.rs
  - memex-rs/src/shared_adapter.rs

- [x] 阶段 1: 读操作 - Server 直接读 SharedDb
  - 添加 better-sqlite3 依赖
  - 创建 SharedDbService (claude-server, vlaude-server)
  - 修改 ProjectService 使用 SharedDb
  - 修改 SessionService 使用 SharedDb

- [x] 阶段 2: 写操作 - HTTP 改 WebSocket (2025-12-30)
  - daemon.gateway.ts 添加 WebSocket 方法:
    - `createSessionViaWebSocket()` - 创建会话
    - `checkLoadingViaWebSocket()` - 检查加载状态
    - `sendMessageViaWebSocket()` - 发送消息
  - 添加响应事件处理:
    - `daemon:sessionCreatedResult`
    - `daemon:checkLoadingResult`
    - `daemon:sendMessageResult`
  - session.service.ts 改用 WebSocket 创建会话
  - app.gateway.ts 移除 HTTP 调用，改用 WebSocket
  - gateway.module.ts 移除 HttpModule
  - socket-client (Rust) 添加事件监听和响应方法
  - daemon-logic (Rust) 添加事件处理方法

---

## 四、待实现

### 阶段 1: 读操作 - Server 直接读 SharedDb

#### Task 1.1: 添加 SQLite 依赖

```bash
cd packages/claude-server
pnpm add better-sqlite3
pnpm add -D @types/better-sqlite3
```

#### Task 1.2: 创建 SharedDb 服务

```typescript
// src/shared-db/shared-db.service.ts
@Injectable()
export class SharedDbService {
  private db: Database | null = null;

  constructor() {
    const dbPath = path.join(os.homedir(), '.vimo', 'db', 'claude-session.db');
    if (fs.existsSync(dbPath)) {
      this.db = new Database(dbPath, { readonly: true });
    }
  }

  isAvailable(): boolean {
    return this.db !== null;
  }

  getProjects(limit: number, offset: number): Project[] { ... }
  getSessions(projectPath: string): Session[] { ... }
  getMessages(sessionId: string): Message[] { ... }
  search(query: string, limit: number): SearchResult[] { ... }
}
```

#### Task 1.3: 修改 ProjectService

```typescript
// project.service.ts
async getAllProjects(limit: number, offset: number) {
  // 直接使用 SharedDb
  if (this.sharedDbService.isAvailable()) {
    return this.sharedDbService.getProjects(limit, offset);
  }
  throw new Error('SharedDb not available');
}
```

#### Task 1.4: 修改 SessionService

同上，直接读 SharedDb。

### 阶段 2: 写操作 - HTTP 改 WebSocket

当前失败的 HTTP 调用需要改成 WebSocket：

| 位置 | HTTP API | 用途 | 改成 WebSocket 事件 |
|------|----------|------|---------------------|
| `session.service.ts:320` | `POST /sessions` | 创建新会话 | `server:createSession` |
| `app.gateway.ts:617` | `POST /sessions/send-message` | 发送消息 | `server:sendMessage` |
| `app.gateway.ts:305` | `POST /sessions/check-loading` | 检查加载状态 | `server:checkLoading` |

#### Task 2.1: DaemonGateway 新增写操作方法

```typescript
// daemon.gateway.ts
createSession(projectPath: string, prompt?: string): Promise<{ sessionId: string }>
sendMessage(sessionId: string, message: string): Promise<void>
checkLoading(sessionId: string): Promise<boolean>
```

#### Task 2.2: 修改 SessionService 创建会话

改用 WebSocket 调用 Daemon/VlaudeKit。

#### Task 2.3: 修改 AppGateway 发送消息

改用 WebSocket 调用 Daemon/VlaudeKit。

### 阶段 3: 远程模式 rsync 同步

#### Task 3.1: 创建同步脚本

```bash
#!/bin/bash
# scripts/sync-shared-db.sh
rsync -avz ~/.vimo/db/claude-session.db nas:~/.vimo/db/
```

#### Task 3.2: Daemon 数据变更时触发同步

在 Daemon 写入 SharedDb 后，触发 rsync。

### 阶段 4: 清理

#### Task 4.1: 移除无用的 HTTP 调用代码

删除 `fetchProjectsFromDaemon`、`fetchSessionsFromDaemon` 中的 HTTP 逻辑。

#### Task 4.2: 评估 Prisma 数据库

验证稳定后决定是否移除。

---

## 五、验收标准

- [ ] iOS 客户端请求项目列表，返回最新数据
- [ ] iOS 客户端请求会话列表，返回最新数据
- [ ] Server 日志不再显示 "fetch failed" 错误
- [ ] 本地模式：直接读 SharedDb，不依赖 Daemon/VlaudeKit
- [ ] 远程模式：rsync 同步后，同样直接读 SharedDb

---

## 六、相关文件

| 文件 | 改动 |
|------|------|
| `packages/claude-server/package.json` | 添加 better-sqlite3 |
| `packages/claude-server/src/shared-db/` | 新建 SharedDb 服务 |
| `packages/claude-server/src/project/project.service.ts` | 使用 SharedDb |
| `packages/claude-server/src/session/session.service.ts` | 使用 SharedDb |
| `scripts/sync-shared-db.sh` | 新建 rsync 脚本 |

---

## 七、核心认知（实现时必读）

1. **SharedDb 是 SQLite 文件** - 可以直接读，不需要 FFI
2. **Server 直接读 SharedDb** - 不是纯中转，不依赖 Daemon/VlaudeKit
3. **Daemon 和 VlaudeKit 是等价的** - 都是 SharedDb 的 Writer
4. **路径已统一** - `~/.vimo/db/claude-session.db`
5. **自动检测模式** - SharedDb 存在就直接读
