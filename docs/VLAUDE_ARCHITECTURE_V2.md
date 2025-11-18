# Vlaude 架构设计文档 V2

> 本文档基于 2025-11-16 的架构重构讨论整理而成

## 目录
- [核心理念](#核心理念)
- [数据优先级](#数据优先级)
- [文件监听策略](#文件监听策略)
- [增量解析机制](#增量解析机制)
- [软删除策略](#软删除策略)
- [数据库 Schema](#数据库-schema)
- [实现清单](#实现清单)

---

## 核心理念

### 1. 数据源优先级

**文件系统 > 数据库**

- 数据源头：`~/.claude/projects/` 文件夹是**唯一真实数据源**
- 数据库角色：仅作为**缓存/备份**，用于提高查询速度
- 数据一致性：如果文件和数据库不一致，**以文件为准**

### 2. 增量更新策略

```
项目列表请求
  ↓
扫描文件系统，获取所有项目的 mtime
  ↓
对比数据库记录：
  - 文件 mtime > 数据库 mtime → 重新读取文件（增量更新）
  - 文件 mtime = 数据库 mtime → 直接返回数据库缓存
  ↓
返回最近 10 个项目（按 mtime 倒序）
```

**优势**：
- ✅ 性能优化：大部分旧项目直接读缓存，只有活跃项目才读文件
- ✅ 数据准确：始终以文件系统为准
- ✅ 扩展性好：可以添加更智能的缓存策略

---

## 数据优先级

### 项目（Project）的最后修改时间

```typescript
// 项目的 lastModified = 该项目下所有 session 文件中最新的 mtime
function getProjectLastModified(projectPath: string): Date {
  const projectDir = `~/.claude/projects/${encodeProjectPath(projectPath)}/`;

  // 读取所有 .jsonl 文件
  const sessionFiles = fs.readdirSync(projectDir)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => path.join(projectDir, f));

  if (sessionFiles.length === 0) {
    return fs.statSync(projectDir).mtime;
  }

  // 找出所有 session 文件中最新的 mtime
  return sessionFiles
    .map(f => fs.statSync(f).mtime)
    .reduce((max, mtime) => mtime > max ? mtime : max);
}
```

**重要**：
- ❌ 不要监听项目文件夹的 mtime
- ✅ 监听项目内部所有 `.jsonl` 文件的 mtime
- ✅ 项目排序按**最新 session 的 mtime**排序

---

## 文件监听策略

### 监听生命周期

```
用户打开 App
  ↓
【监听 1】监听项目列表（~/.claude/projects/ 下所有 .jsonl 的 mtime）
  ↓
用户点击某个项目
  ↓
停止【监听 1】
  ↓
【监听 2】监听该项目的会话列表（project/*.jsonl 的 mtime）
  ↓
用户点击某个会话
  ↓
停止【监听 2】
  ↓
【监听 3】监听该会话文件的变化（增量解析新消息）
  ↓
用户返回
  ↓
根据导航恢复对应监听
```

### 监听 1：项目列表

**监听目标**：`~/.claude/projects/` 目录（递归监听）

```typescript
fs.watch('~/.claude/projects/', { recursive: true }, (eventType, filename) => {
  // 只关心 .jsonl 文件的变化
  if (!filename?.endsWith('.jsonl')) return;

  const projectDirName = filename.split('/')[0];
  const projectPath = decodeProjectPath(projectDirName);

  if (eventType === 'rename') {
    const fullPath = path.join('~/.claude/projects/', filename);

    if (fs.existsSync(fullPath)) {
      // 新建文件或恢复文件
      handleSessionCreated(projectPath, filename);
    } else {
      // 文件被删除
      handleSessionDeleted(projectPath, filename);
    }
  } else if (eventType === 'change') {
    // 文件内容变化（追加新消息）
    handleSessionUpdated(projectPath, filename);
  }

  // 更新项目列表（重新排序）
  updateProjectList();
});
```

**监听内容**：
- ✅ 只看 `.jsonl` 文件的 mtime
- ✅ 不需要读取文件内容
- ✅ 不需要解析 JSONL

### 监听 2：会话列表

**监听目标**：某个项目目录下所有 `.jsonl` 文件

```typescript
fs.watch(projectDir, (eventType, filename) => {
  if (!filename?.endsWith('.jsonl')) return;

  // 重新扫描该项目下所有 session 的 mtime
  const sessions = scanSessionFiles(projectDir);

  // 按 mtime 倒序排列
  const sorted = sessions.sort((a, b) => b.mtime - a.mtime);

  // 推送更新到 iOS App
  pushToApp('sessions:updated', { projectPath, sessions: sorted });
});
```

### 监听 3：会话详情

**监听目标**：某个具体的 `.jsonl` 文件

```typescript
fs.watch(sessionFile, (eventType) => {
  if (eventType === 'change') {
    const stats = fs.statSync(sessionFile);
    const dbRecord = db.getSession(sessionId);

    // 检查是否有新增内容
    if (stats.mtime > dbRecord.lastMtime) {
      // 增量解析新消息
      const newMessages = parseIncrementalMessages(
        sessionFile,
        dbRecord.lastParsedLine
      );

      // 推送新消息到 iOS App
      pushToApp('messages:new', { sessionId, messages: newMessages });
    }
  }
});
```

---

## 增量解析机制

### 数据库记录字段

```typescript
Session {
  lastParsedLine: number   // 上次解析到第几行
  lastFileSize: BigInt     // 上次解析时的文件大小（字节）
  lastMtime: DateTime      // 上次解析时的文件修改时间
}
```

### 三重检查机制

1. **mtime（修改时间）**：快速判断文件是否被修改
2. **fileSize（文件大小）**：快速判断是否有新增内容
3. **lineCount（行数）**：精确判断新增了多少行消息

### 增量解析逻辑

```typescript
async function getSessionMessages(sessionId: string) {
  const filePath = getSessionFilePath(sessionId);
  const fileStats = fs.statSync(filePath);
  const dbRecord = await db.getSession(sessionId);

  if (!dbRecord) {
    // 第一次解析，读取整个文件
    const allLines = readAllLines(filePath);
    const messages = parseJSONL(allLines);

    await db.saveSession({
      sessionId,
      lastParsedLine: allLines.length,
      lastFileSize: fileStats.size,
      lastMtime: fileStats.mtime,
      messageCount: messages.length
    });

    return messages;
  }

  // 快速检查：文件没变化
  if (fileStats.size === dbRecord.lastFileSize &&
      fileStats.mtime <= dbRecord.lastMtime) {
    return db.getMessages(sessionId);
  }

  // 读取总行数
  const totalLines = countLines(filePath);

  if (totalLines === dbRecord.lastParsedLine) {
    // 行数没变，不需要重新解析
    return db.getMessages(sessionId);
  }

  if (totalLines > dbRecord.lastParsedLine) {
    // 有新增行，只读取新增部分
    const newLines = readLinesFromOffset(
      filePath,
      dbRecord.lastParsedLine
    );

    const newMessages = parseJSONL(newLines);

    await db.insertMessages(sessionId, newMessages);
    await db.updateSession(sessionId, {
      lastParsedLine: totalLines,
      lastFileSize: fileStats.size,
      lastMtime: fileStats.mtime,
      messageCount: dbRecord.messageCount + newMessages.length
    });

    return db.getMessages(sessionId);
  }

  // 行数变少，文件可能被修改，全量重新解析
  if (totalLines < dbRecord.lastParsedLine) {
    await db.deleteMessages(sessionId);
    const allLines = readAllLines(filePath);
    const messages = parseJSONL(allLines);

    await db.saveMessages(sessionId, messages);
    await db.updateSession(sessionId, {
      lastParsedLine: totalLines,
      lastFileSize: fileStats.size,
      lastMtime: fileStats.mtime,
      messageCount: messages.length
    });

    return messages;
  }
}
```

### 高效读取指定行

```typescript
function readLinesFromOffset(filePath: string, startLine: number): string[] {
  const lines: string[] = [];
  const fileStream = fs.createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: fileStream });

  let currentLine = 0;

  return new Promise((resolve) => {
    rl.on('line', (line) => {
      currentLine++;
      if (currentLine > startLine) {
        lines.push(line);
      }
    });

    rl.on('close', () => {
      resolve(lines);
    });
  });
}
```

---

## 软删除策略

### 为什么使用软删除？

❌ **硬删除的问题**：
- 用户可能误删文件，恢复后数据丢失
- 无法追溯历史记录
- 可能有其他数据关联（如收藏、标签等）

✅ **软删除的优势**：
- 支持文件恢复场景
- 保留历史记录
- 数据安全

### 数据库 Schema

```typescript
Project {
  isDeleted: boolean
  deletedAt: DateTime | null
}

Session {
  isDeleted: boolean
  deletedAt: DateTime | null
}
```

### 删除处理逻辑

```typescript
function handleSessionDeleted(projectPath: string, filename: string) {
  const sessionId = path.basename(filename, '.jsonl');

  // 标记为已删除，不直接删除记录
  db.updateSession(sessionId, {
    isDeleted: true,
    deletedAt: new Date()
  });

  logger.log(`🗑️ Session 标记为已删除: ${sessionId}`);

  pushToApp('session:deleted', {
    sessionId,
    projectPath,
    deletedAt: new Date()
  });
}
```

### 恢复处理逻辑

```typescript
function handleSessionRestored(projectPath: string, filename: string) {
  const sessionId = path.basename(filename, '.jsonl');
  const existingRecord = db.getSession(sessionId);

  if (existingRecord && existingRecord.isDeleted) {
    // 恢复已删除的 session
    db.updateSession(sessionId, {
      isDeleted: false,
      deletedAt: null
    });

    logger.log(`♻️ Session 已恢复: ${sessionId}`);

    // 检查文件是否被修改过
    const sessionFilePath = getSessionFilePath(sessionId);
    const stats = fs.statSync(sessionFilePath);

    if (stats.mtime > existingRecord.lastMtime) {
      // 文件有变化，重新解析
      reParseSession(sessionId, sessionFilePath);
    }

    pushToApp('session:restored', { sessionId, projectPath });
  }
}
```

### 查询时过滤

```typescript
// 获取项目列表
function getTop10Projects(): Project[] {
  return db.getProjects()
    .filter(p => !p.isDeleted)  // 过滤已删除
    .sort((a, b) => b.lastModified - a.lastModified)
    .slice(0, 10);
}

// 获取会话列表
function getProjectSessions(projectId: string): Session[] {
  return db.getSessions(projectId)
    .filter(s => !s.isDeleted)  // 过滤已删除
    .sort((a, b) => b.lastMtime - a.lastMtime);
}
```

**注意**：不要定期删除软删除记录，保留即可。

---

## 数据库 Schema

### Project 表

```prisma
model Project {
  id           Int       @id @default(autoincrement())
  name         String    @db.VarChar(255)
  path         String    @unique @db.VarChar(500)
  lastAccessed DateTime?
  lastModified DateTime?  // 项目最后修改时间（所有 session 中最新的 mtime）
  sessionCount Int       @default(0)  // session 数量
  isDeleted    Boolean   @default(false)  // 软删除标记
  deletedAt    DateTime?  // 删除时间
  createdAt    DateTime  @default(now())
  updatedAt    DateTime  @updatedAt

  sessions Session[]

  @@index([isDeleted, lastModified])
  @@map("vlaude_project")
}
```

### Session 表

```prisma
model Session {
  id             Int      @id @default(autoincrement())
  sessionId      String   @unique @db.VarChar(255)
  projectId      Int
  messageCount   Int      @default(0)
  lastMessageAt  DateTime?
  lastParsedLine Int      @default(0)  // 上次解析到第几行
  lastFileSize   BigInt   @default(0)  // 上次解析时的文件大小（字节）
  lastMtime      DateTime?  // 上次解析时的文件修改时间
  isDeleted      Boolean  @default(false)  // 软删除标记
  deletedAt      DateTime?  // 删除时间
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  project  Project   @relation(fields: [projectId], references: [id], onDelete: Cascade)
  messages Message[]

  @@index([projectId])
  @@index([isDeleted, lastMtime])
  @@map("claude_session")
}
```

### Message 表

```prisma
model Message {
  id        Int      @id @default(autoincrement())
  sessionId Int
  role      String   @db.VarChar(20)
  content   String   @db.Text
  metadata  Json?
  sequence  Int
  timestamp DateTime
  createdAt DateTime @default(now())

  session Session @relation(fields: [sessionId], references: [id], onDelete: Cascade)

  @@index([sessionId])
  @@index([sequence])
  @@map("claude_message")
}
```

---

## 实现清单

### ✅ 已完成
1. 数据库 Schema 更新
   - 添加软删除字段
   - 添加增量解析字段
   - 添加项目统计字段

### 📋 待实现

#### Daemon 端

1. **文件监听服务**（新建文件 `file-watcher.service.ts`）
   - [ ] 实现项目列表监听
   - [ ] 实现会话列表监听
   - [ ] 实现会话详情监听
   - [ ] 实现监听模式切换（根据 iOS App 页面状态）

2. **增量解析服务**（修改 `data-collector.service.ts`）
   - [ ] 实现 `readLinesFromOffset()` 函数
   - [ ] 实现 `countLines()` 函数
   - [ ] 实现增量解析逻辑
   - [ ] 实现全量重新解析逻辑

3. **软删除处理**（在 `file-watcher.service.ts` 中）
   - [ ] 实现 `handleSessionDeleted()`
   - [ ] 实现 `handleSessionRestored()`
   - [ ] 实现 `handleProjectDeleted()`
   - [ ] 实现 `handleProjectRestored()`

4. **项目最后修改时间计算**
   - [ ] 实现 `getProjectLastModified()` 函数
   - [ ] 在项目列表查询时使用

#### Server 端

1. **清理旧代码**
   - [ ] 删除 `daemon.startWatching` 相关事件
   - [ ] 删除 `daemon.stopWatching` 相关事件
   - [ ] 删除 AppGateway 中的订阅管理逻辑（`sessionSubscriptions`）
   - [ ] 删除 DaemonGateway 中的监听转发逻辑

2. **适配新的数据结构**
   - [ ] 更新 ProjectController 查询逻辑（过滤 `isDeleted`）
   - [ ] 更新 SessionController 查询逻辑（过滤 `isDeleted`）
   - [ ] 更新消息查询逻辑（支持增量获取）

3. **新增 API**
   - [ ] `POST /daemon/watch-mode` - 切换监听模式
   - [ ] `GET /projects?limit=10` - 获取最近项目（自动增量更新）
   - [ ] `GET /sessions/:sessionId/messages?offset=0&limit=20` - 支持分页

#### Swift 端

1. **修复 API 响应解码错误**
   - [ ] 检查所有 API 响应格式
   - [ ] 确保所有响应都包含 `data` 字段或调整 Swift 模型

2. **适配软删除**
   - [ ] 过滤掉 `isDeleted = true` 的 session
   - [ ] 显示恢复提示（如果检测到文件恢复）

3. **监听模式切换**
   - [ ] 页面进入时通知 Server 切换监听模式
   - [ ] 页面退出时恢复上一级监听

---

## 架构对比

### ❌ 旧架构（过度设计）

```
Swift 订阅 session
  → Server 发送 daemon.startWatching 事件
  → DaemonGateway 转发到 Daemon
  → Daemon 开始监听特定 session 文件
  → 需要管理订阅关系、事件转发等
```

**问题**：
- 依赖链太长
- Daemon 需要等待 Server 指令才能工作
- 订阅/取消订阅管理复杂

### ✅ 新架构（简洁高效）

```
Daemon 根据 iOS App 的页面状态，自动切换监听目标：

1. 项目列表页 → 监听 ~/.claude/projects/ 的所有 .jsonl mtime
2. 会话列表页 → 监听 /project-xxx/*.jsonl 的 mtime
3. 会话详情页 → 监听 /session-xxx.jsonl 并增量解析
```

**优势**：
- ✅ 逻辑简单清晰
- ✅ Daemon 独立工作
- ✅ 监听随页面切换自动启停
- ✅ 所有监听都只看 mtime，非常轻量

---

## 数据流示意图

### 项目列表

```
iOS App 打开
  ↓
请求 GET /projects?limit=10
  ↓
Server 调用 Daemon
  ↓
Daemon 扫描 ~/.claude/projects/
  - 获取所有项目的 mtime（取所有 session 中最大值）
  - 对比数据库缓存
  - 只对有变化的项目重新读取
  ↓
返回最近 10 个项目
  ↓
Daemon 开始监听 ~/.claude/projects/ (recursive)
  - 监听所有 .jsonl 文件的变化
  - 有变化时推送更新到 App
```

### 会话列表

```
用户进入项目
  ↓
请求 GET /sessions/by-project/:projectId
  ↓
Daemon 停止项目列表监听
  ↓
Daemon 扫描该项目下所有 .jsonl
  - 对比数据库缓存
  - 增量更新
  ↓
返回会话列表（按 mtime 倒序）
  ↓
Daemon 开始监听该项目目录
  - 监听所有 .jsonl 文件的变化
  - 有变化时推送更新到 App
```

### 会话详情

```
用户进入会话
  ↓
请求 GET /sessions/:sessionId/messages?offset=0&limit=20
  ↓
Daemon 停止会话列表监听
  ↓
Daemon 增量解析该 session 文件
  - 检查 lastParsedLine
  - 只读取新增行
  ↓
返回消息列表（支持分页）
  ↓
Daemon 开始监听该 session 文件
  - 检测到新消息时增量解析
  - 推送新消息到 App
```

---

## 关键技术点

### 1. fs.watch 事件说明

- **`'rename'`**：文件/文件夹被创建、删除、重命名
  - 新建文件 → `rename` + `fs.existsSync() === true`
  - 删除文件 → `rename` + `fs.existsSync() === false`

- **`'change'`**：文件内容被修改
  - 追加新消息 → `change`
  - 编辑文件 → `change`

### 2. 项目路径编码

Claude Code 的项目路径编码格式：

```typescript
// /Users/xxx/project → -Users-xxx-project
function encodeProjectPath(path: string): string {
  return '-' + path.replace(/^\//, '').replace(/\//g, '-');
}

function decodeProjectPath(encoded: string): string {
  return '/' + encoded.replace(/^-/, '').replace(/-/g, '/');
}
```

### 3. JSONL 文件格式

Claude Code 的 session 文件格式：

```jsonl
{"type":"user","message":{"role":"user","content":"Hello"},"timestamp":"2025-11-16T..."}
{"type":"assistant","message":{"role":"assistant","content":"Hi"},"timestamp":"2025-11-16T..."}
{"type":"user","message":{"role":"user","content":"How are you?"},"timestamp":"2025-11-16T..."}
```

每行是一个 JSON 对象，按时间顺序追加。

---

## 注意事项

1. **不要监听文件夹的 mtime**
   - 文件夹的 mtime 只在文件夹本身被修改时才变
   - 修改内部文件不会更新文件夹 mtime

2. **项目路径问题**
   - 发现项目路径有异常（多个斜杠）：`/Users/xxx/////claude`
   - 需要检查路径处理逻辑

3. **数据库连接**
   - 远程数据库：192.168.50.9:6603
   - 数据库名：vlaude
   - 已完成 Schema 更新

4. **CLI 劫持功能**
   - 之前实现的 CLI 劫持和消息发送功能保持不变
   - 本次重构主要针对数据查询和监听逻辑

---

## 后续优化方向

1. **性能优化**
   - 添加文件读取缓存
   - 优化大文件解析性能
   - 添加分页优化

2. **功能扩展**
   - 支持全文搜索
   - 支持会话收藏
   - 支持会话标签

3. **监控和日志**
   - 添加文件监听事件统计
   - 添加解析性能监控
   - 添加错误告警

---

**文档版本**：V2.0
**更新时间**：2025-11-16
**状态**：设计完成，待实现
