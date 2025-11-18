# 中文路径编码问题追踪文档

## 📋 项目背景

**Vlaude** 是一个多端同步的 Claude Code 项目管理系统，包含：
- **Daemon**: 本地守护进程，监控 Claude 项目文件系统变化
- **Server**: 中央服务器，管理项目和会话数据
- **Swift APP**: iOS 客户端，可远程查看和发送消息
- **CLI**: 命令行客户端，与 Claude Code 交互，支持 remote 模式

## 🔴 核心问题

### 问题现象
1. Swift APP 显示"暂无项目"
2. Swift APP 发送消息后，Daemon 报错"会话文件不存在"
3. CLI 不进入 remote 模式（因为监听失败）

### 根本原因
**Claude Code 对含中文字符的路径使用特殊编码方式**：
- 真实路径: `/Users/higuaifan/Desktop/hi/小工具/claude`
- Claude 编码: `-Users-higuaifan-Desktop-hi-----claude`
- 我们的编码: `-Users-higuaifan-Desktop-hi-小工具-claude` ❌

简单的字符串替换 `/` → `-` 无法处理中文字符，导致文件路径错误。

## 🔍 调查路径

### 第一阶段：发现问题（2025-11-16 14:00-15:00）
1. 用户报告 Swift APP 显示"暂无项目"
2. 检查 Server 日志，发现项目列表返回正常
3. 检查 Daemon 日志，发现路径编码不匹配

### 第二阶段：定位根因（2025-11-16 15:00-16:00）
1. 分析 Claude Code 目录结构：`~/.claude/projects/`
2. 发现编码规则：中文字符 → 多个连字符（"小工具" → "-----"，5个连字符）
3. 确认无法通过算法推导编码，必须从文件系统读取

### 第三阶段：设计方案（2025-11-16 16:00-17:00）
**V2 架构方案：从 JSONL 文件提取真实路径**

原理：
- Claude Code 的 JSONL 文件包含 `cwd` 字段，记录项目真实路径
- 读取前 20 行，提取 `cwd` 字段
- 将真实路径和编码目录名一起存入数据库
- 所有文件操作使用数据库中的 `encodedDirName`

数据库 Schema 改动：
```prisma
model Project {
  encodedDirName String?   @db.VarChar(500)  // Claude 编码的目录名
  projectPath    String?   @db.VarChar(500)  // 项目路径
  @@index([encodedDirName])
}

model Session {
  projectPath    String?  @db.VarChar(500)  // 项目路径(冗余)
  @@index([projectPath])
}
```

### 第四阶段：实现修复（2025-11-16 17:00-18:30）

#### 修改的文件清单

**1. Daemon 层（packages/vlaude-daemon/）**

- ✅ `src/module/data-collector/data-collector.service.ts`
  - 添加 `extractProjectPathFromJsonl()` 方法
  - 修改 `collectProjects()` 返回 `encodedDirName`
  - 修改 `collectSessions()` 接受 `encodedDirName` 参数
  - 修改 `startWatchingSession()` 接受 `encodedDirName` 参数
  - 修改 `getSessionMessages()` 接受 `encodedDirName` 参数
  - 修改 `collectProjectsAndSessions()` 传递 `encodedDirName`

- ✅ `src/common/controllers/session.controller.ts`
  - GET `/sessions` 接受 `encodedDirName` 参数
  - POST `/sessions/send-message` 接受 `encodedDirName` 参数

- ✅ `src/module/server-client/server-client.service.ts`
  - 修改 `handleStartWatchingRequest()` 接受并传递 `encodedDirName`
  - 修改 `handleSessionMessagesRequest()` 接受并传递 `encodedDirName`

**2. Server 层（packages/vlaude-server/）**

- ✅ `prisma/schema.prisma`
  - 添加 `Project.encodedDirName` 字段
  - 添加 `Project.projectPath` 字段
  - 添加 `Session.projectPath` 字段

- ✅ `src/module/project/project.service.ts`
  - 修改 `updateProjectCache()` 保存 `encodedDirName`

- ✅ `src/module/session/session.service.ts`
  - 修改 `getSessionsByProjectPath()` 查询并传递 `encodedDirName`
  - 修改 `fetchSessionsFromDaemon()` 传递 `encodedDirName`
  - 修改 `updateSessionCache()` 更新 `lastParsedLine` 和 `projectPath`

- ✅ `src/gateway/app.gateway.ts`
  - 注入 `PrismaService`
  - 修改 `handleSessionSubscribe()` 查询并传递 `encodedDirName`
  - 修改 `handleMessageSend()` 查询并传递 `encodedDirName`

- ✅ `src/module/daemon-gateway/daemon.gateway.ts`
  - 注入 `PrismaService`
  - 修改 `requestSessionMessages()` 查询并传递 `encodedDirName`
  - 修改 `requestStartWatching()` 查询并传递 `encodedDirName`
  - 修改 `handleStartWatchingEvent()` 接受并传递 `encodedDirName`

**3. Swift APP（packages/Vlaude/）**

- ✅ `Vlaude/Services/APIClient.swift`
  - 修改 `getSessions()` 从 projectId 改为 projectPath

## 📊 当前进度

### ✅ 已完成
1. ✅ 数据库 Schema 更新
2. ✅ Daemon 数据采集逻辑修改
3. ✅ Server 查询和传递 `encodedDirName`
4. ✅ 所有文件路径操作使用 `encodedDirName`
5. ✅ 代码编译成功

### 🔄 测试中
1. 🔄 Swift APP → Server 获取项目列表（部分成功）
2. 🔄 Swift APP → Daemon 发送消息（仍有问题）
3. 🔄 CLI remote 模式（未进入）

### ❓ 待排查问题

#### 问题 1: Swift 发送消息仍报错
**错误日志：**
```
[Nest] 28122 - WARN [DataCollectorService] getSessionMessages: 未提供 encodedDirName，使用编码方式
[Nest] 28122 - WARN [DataCollectorService] 会话文件不存在: /Users/higuaifan/.claude/projects/-Users-higuaifan-Desktop-hi-小工具-claude-packages-vlaude-cli/469b3880-cfb4-4d9a-85c5-5ad0dcee3796.jsonl
```

**分析：**
- Server 编译后的代码正确（已验证 `dist/gateway/app.gateway.js`）
- `handleMessageSend()` 确实会查询数据库并传递 `encodedDirName`
- 但 Daemon 仍收到空的 `encodedDirName`

**可能原因：**
1. 数据库中该项目的 `encodedDirName` 为 `null`
2. 项目路径不匹配，数据库查询返回 `null`
3. Server 热重启未生效？

**下一步调查：**
```bash
# 1. 确认数据库中是否有正确的 encodedDirName
node -e "
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
prisma.project.findUnique({
  where: { path: '/Users/higuaifan/Desktop/hi/小工具/claude/packages/vlaude-cli' },
  select: { path: true, encodedDirName: true }
})
  .then(r => console.log(JSON.stringify(r, null, 2)))
  .finally(() => prisma.\$disconnect());
"

# 2. 添加 Server 日志，确认查询结果
# 在 app.gateway.ts handleMessageSend 中添加：
this.logger.log(`   查询到的 encodedDirName: ${project?.encodedDirName || 'null'}`);

# 3. 检查 clientInfo.projectPath 是否正确
this.logger.log(`   客户端项目路径: ${clientInfo.projectPath}`);
```

#### 问题 2: CLI 不进入 remote 模式

**预期行为：**
1. CLI 启动，连接 Server，发送 `join` 消息
2. Swift 连接同一 session，Server 通知 CLI `remote-connect`
3. CLI 显示 "Remote mode activated"

**实际情况：**
CLI 没有显示 remote 提示（可能是因为文件监听失败）

**依赖关系：**
CLI remote 模式依赖于会话文件监听成功，而监听失败是因为 `encodedDirName` 问题。

**解决方案：**
先解决问题 1，问题 2 应该会随之解决。

## 🎯 完整数据流向

### 正确的调用链（期望）

**场景 1: Swift APP 发送消息**
```
Swift APP
  → AppGateway.handleMessageSend(sessionId, text)
  → 查询数据库: SELECT encodedDirName FROM Project WHERE path = ?
  → HTTP POST /sessions/send-message { encodedDirName }
  → Daemon SessionController
  → 使用 encodedDirName 构建文件路径
  → 写入 JSONL 文件 ✅
```

**场景 2: Swift APP 订阅会话**
```
Swift APP
  → AppGateway.handleSessionSubscribe(sessionId, projectPath)
  → 查询数据库: SELECT encodedDirName FROM Project WHERE path = ?
  → eventEmitter.emit('daemon.startWatching', { encodedDirName })
  → DaemonGateway.handleStartWatchingEvent
  → Socket emit 'server:startWatching' { encodedDirName }
  → Daemon ServerClient.handleStartWatchingRequest
  → DataCollector.startWatchingSession(encodedDirName)
  → 开始监听文件变化 ✅
```

**场景 3: CLI 启动 + Swift 连接**
```
CLI
  → Socket emit 'join' { clientType: 'cli', sessionId }
  → AppGateway.handleJoin
  → sessionClients.cli = clientId

Swift APP
  → Socket emit 'join' { clientType: 'swift', sessionId }
  → AppGateway.handleJoin
  → sessionClients.swift.add(clientId)
  → 检测到 cli 存在
  → Socket emit 'remote-connect' to CLI ✅
  → CLI 显示 "Remote mode activated" ✅
```

## 📝 技术总结

### 关键发现
1. **Claude Code 的编码规则无法通过算法推导**
   - 中文字符编码为多个连字符，数量不固定
   - 必须从 Claude 自己生成的目录名反向映射

2. **JSONL 文件是唯一可靠的真实路径来源**
   - 每个 session 的 JSONL 文件包含 `cwd` 字段
   - 读取前 20 行即可找到（通常在前几行）

3. **数据库作为编码映射缓存**
   - 避免每次都读取 JSONL 文件
   - 提供快速查询能力

### 架构改进
1. **数据优先级：文件系统 > 数据库**
   - 数据库作为缓存，不是数据源
   - 定期从文件系统同步最新状态

2. **3新7旧增量更新策略**
   - 对比 `mtime` 和 `lastParsedLine`
   - 只更新变化的数据，减少 I/O

3. **参数传递标准化**
   - 所有涉及文件路径的方法都接受 `encodedDirName` 参数
   - 优先使用传入的 `encodedDirName`，否则查询数据库

## 📌 下次继续工作的起点

1. **立即优先：** 排查数据库 `encodedDirName` 字段是否正确填充
2. **验证方法：** 运行上面"下一步调查"中的 SQL 查询
3. **如果为 null：** 触发一次项目列表刷新，重新采集 `encodedDirName`
4. **如果不为 null：** 添加详细日志，追踪 `encodedDirName` 在整个调用链中的传递

## 🔗 相关文件位置

```
packages/vlaude-daemon/
  ├── src/module/data-collector/data-collector.service.ts  (核心采集逻辑)
  ├── src/common/controllers/session.controller.ts         (HTTP API)
  └── src/module/server-client/server-client.service.ts    (Socket 通信)

packages/vlaude-server/
  ├── prisma/schema.prisma                                 (数据库 Schema)
  ├── src/module/project/project.service.ts                (项目服务)
  ├── src/module/session/session.service.ts                (会话服务)
  ├── src/gateway/app.gateway.ts                           (Swift/CLI Gateway)
  └── src/module/daemon-gateway/daemon.gateway.ts          (Daemon Gateway)

packages/Vlaude/
  └── Vlaude/Services/APIClient.swift                      (Swift HTTP Client)
```

---

**文档创建时间:** 2025-11-16 18:30
**最后更新:** 2025-11-16 18:30
**当前状态:** 🔄 测试中，待排查数据库 encodedDirName 字段
