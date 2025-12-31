# Vlaude 数据流架构文档

> 此文档用于建立固定的架构认知，避免分析和开发时出现错误。
> 最后更新: 2025-12-30

## 一、核心组件

| 组件 | 运行位置 | 职责 |
|------|----------|------|
| **JSONL 文件** | Mac `~/.claude/projects/` | Claude Code 原始会话数据（真正的数据源） |
| **SharedDb** | Mac `~/.vimo/db/claude-session.db` | 本地 SQLite 缓存，支持全文搜索 |
| **Daemon (Rust)** | Mac | 读取 JSONL，写入 SharedDb |
| **VlaudeKit (Swift)** | Mac (ETerm 内) | 同 Daemon，与 Daemon 二选一作为 Writer |
| **vlaude-server (NestJS)** | Mac 或 NAS | **直接读 SharedDb**，服务 iOS 客户端 |
| **iOS/Swift 客户端** | iPhone | 通过 WebSocket 连接 Server |

---

## 二、关键认知

### 1. SharedDb 是核心

```
JSONL 文件 (Claude Code 写入)
      ↓
Daemon/VlaudeKit (索引写入)
      ↓
SharedDb (SQLite) ← Server 直接读取
      ↓
iOS 客户端
```

- **SharedDb 是 SQLite 文件**，可以直接读，不需要 FFI
- **路径**：`~/.vimo/db/claude-session.db`（已统一）
- **Server 直接读 SharedDb**，不依赖 Daemon/VlaudeKit 做数据中转

### 2. Daemon 和 VlaudeKit 是等价的 Writer

- 都可以索引 JSONL 并写入 SharedDb
- Writer 协调机制：同时只有一个 Writer
- **Server 不需要连接它们获取数据**（直接读 SharedDb）

### 3. 自动检测本地/远程模式

```typescript
const sharedDbPath = '~/.vimo/db/claude-session.db';
if (fs.existsSync(sharedDbPath)) {
  // 直接读 SharedDb
} else {
  // 降级到 WebSocket（远程模式且未同步时）
}
```

### 4. 远程模式用 rsync 同步

| 模式 | SharedDb 位置 | 同步方式 |
|------|---------------|----------|
| 本地 | Mac `~/.vimo/db/claude-session.db` | 无需同步 |
| 远程 | NAS `~/.vimo/db/claude-session.db` | rsync 从 Mac 同步 |

---

## 三、数据源层次

```
┌─────────────────────────────────────────────────────────────────┐
│  Layer 0: 真实数据源                                             │
│  ~/.claude/projects/**/*.jsonl                                  │
│  (Claude Code 直接写入)                                          │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│  Layer 1: 索引器                                                 │
│  Daemon (Rust) 或 VlaudeKit (Swift)                             │
│  - 读取 JSONL，写入 SharedDb                                     │
│  - Writer 协调机制                                               │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│  Layer 2: SharedDb (SQLite)                                     │
│  ~/.vimo/db/claude-session.db                                   │
│  - 支持 FTS5 全文搜索                                            │
│  - 可被 Server 直接读取                                          │
│  - 可通过 rsync 同步到远程                                       │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│  Layer 3: vlaude-server                                         │
│  - 直接读取 SharedDb                                             │
│  - 服务 iOS 客户端的 WebSocket 连接                              │
│  - 自动检测本地/远程模式                                         │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│  Layer 4: 客户端                                                 │
│  iOS App / Swift App                                            │
│  - 通过 WebSocket 连接 Server                                    │
│  - 展示数据，发送操作请求                                        │
└─────────────────────────────────────────────────────────────────┘
```

---

## 四、部署场景

### 场景 A: Server 在本地 Mac

```
Mac:
├── ~/.claude/projects/**/*.jsonl  (Claude Code)
├── ~/.vimo/db/claude-session.db   (SharedDb)
├── Daemon/VlaudeKit               (写入 SharedDb)
└── vlaude-server                  (直接读 SharedDb)
```

### 场景 B: Server 在远程 (NAS)

```
Mac:                               NAS:
├── JSONL 文件                     ├── ~/.vimo/db/claude-session.db (rsync 同步)
├── SharedDb ─────rsync──────────► └── vlaude-server (直接读 SharedDb)
└── Daemon/VlaudeKit
```

---

## 五、已有的 WebSocket 事件（降级使用）

当 SharedDb 不可用时，Server 可降级使用 WebSocket：

### Server → Daemon/VlaudeKit (请求)

| 事件 | 用途 |
|------|------|
| `server:requestProjectData` | 请求项目列表 |
| `server:requestSessionMetadata` | 请求会话列表 |
| `server:requestSessionMessages` | 请求会话消息 |
| `server:requestSearch` | 全文搜索 |

### Daemon/VlaudeKit → Server (响应)

| 事件 | 用途 |
|------|------|
| `daemon:projectData` | 推送项目数据 |
| `daemon:sessionMetadata` | 推送会话元数据 |
| `daemon:sessionMessages` | 推送会话消息 |
| `daemon:searchResults` | 推送搜索结果 |

---

## 六、目标架构（已确定）

1. **Server 直接读 SharedDb** - 不是纯中转
2. **自动检测模式** - SharedDb 存在就直接读，不存在就降级 WebSocket
3. **远程模式用 rsync** - Daemon 写入 SharedDb 后触发同步
4. **Prisma 数据库保留** - 验证稳定后再决定是否移除

---

## 七、路径配置

| 组件 | 路径配置位置 |
|------|--------------|
| ETerm (Swift) | `ETermPaths.claudeSessionDatabase` |
| ETermKit (SDK) | `ETermPaths.claudeSessionDatabase` |
| VlaudeKit | 使用 ETermPaths |
| MemexKit | 使用 ETermPaths |
| Daemon (Rust) | `daemon-logic/src/shared_db.rs` |
| memex-rs | `src/shared_adapter.rs` |

统一路径：`~/.vimo/db/claude-session.db`
