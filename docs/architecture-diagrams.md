# Vlaude 架构图示 (Mermaid)

> 本文档包含 Mermaid 流程图，配合 `VLAUDE_ARCHITECTURE_V2.md` 阅读
>
> 使用支持 Mermaid 的工具查看此文档：
> - VS Code: 安装 "Markdown Preview Mermaid Support" 插件
> - Typora: 原生支持
> - 在线查看: https://mermaid.live/

---

## 1. 系统整体架构

```mermaid
graph TB
    subgraph "客户端层"
        CLI[CLI 终端]
        iOS[iOS App]
    end

    subgraph "服务层 (本地)"
        Server[Vlaude Server<br/>WebSocket Gateway<br/>Port: 10005]
        Daemon[Vlaude Daemon<br/>文件监听 + SDK<br/>Port: 10006]
    end

    subgraph "Claude 生态"
        ClaudeProcess[Claude CLI 进程]
        Transcript[Transcript 文件<br/>~/.claude/projects/]
        ClaudeAPI[Claude API]
    end

    CLI -->|WebSocket| Server
    iOS -->|WebSocket| Server
    Server -->|HTTP| Daemon
    Server -->|WebSocket<br/>双向通信| Daemon

    Daemon -->|fs.watch 监听| Transcript
    Daemon -->|SDK query()| ClaudeAPI
    ClaudeAPI -->|写入响应| Transcript

    CLI -->|spawn 子进程| ClaudeProcess
    ClaudeProcess -->|读写 JSONL| Transcript
```

**说明**:
- **CLI**: 用户在终端使用 Claude 的命令行工具
- **iOS App**: Swift 开发的移动端应用
- **Server**: 负责 WebSocket 路由和消息中转
- **Daemon**: 负责文件监听和 SDK 集成
- **Claude 进程**: 官方 Claude Code CLI
- **Transcript**: 会话记录文件 (JSONL 格式)

---

## 2. Local 模式 - 完整消息流程

### 场景：用户在 CLI 输入消息，iOS 实时查看

```mermaid
sequenceDiagram
    participant User as 👤 用户
    participant CLI as 💻 CLI (Local)
    participant Claude as 🤖 Claude 进程
    participant Transcript as 📄 Transcript
    participant FileWatcher as 👁️ FileWatcher
    participant Server as 🌐 Server
    participant iOS as 📱 iOS App

    Note over CLI,iOS: === 初始化阶段 ===
    User->>CLI: 启动 vlaude --resume sessionId
    CLI->>Server: WebSocket 连接
    CLI->>Server: join(sessionId, type: cli, projectPath)
    CLI->>Claude: spawn claude --resume sessionId
    Claude->>Transcript: 读取历史记录

    iOS->>Server: WebSocket 连接
    iOS->>Server: join(sessionId, type: swift, projectPath)
    iOS->>Server: subscribe(sessionId)
    Server->>Daemon: emit('daemon.startWatching')
    Daemon->>FileWatcher: 启动文件监听器
    FileWatcher->>Transcript: fs.watch 监听

    Note over CLI,iOS: === 用户交互阶段 ===
    User->>Claude: 输入消息: "hello"
    Claude->>Transcript: append 用户消息
    Note over Claude: 调用 Claude API<br/>生成回复
    Claude->>Transcript: append assistant 消息

    Note over FileWatcher,iOS: === 实时推送阶段 ===
    Transcript-->>FileWatcher: 文件变化事件
    FileWatcher->>FileWatcher: 读取最新 1 条消息
    FileWatcher->>Server: notifyNewMessage(assistant)
    Server->>iOS: emit('message:new', assistant)
    iOS->>iOS: 显示 assistant 消息
```

**关键点**:
1. ✅ CLI 直接运行 Claude 进程，用户可以正常交互
2. ✅ FileWatcher 监听文件变化，实时推送给 iOS
3. ✅ iOS 被动接收，只读模式

---

## 3. Remote 模式 - 切换流程

### 场景：iOS 发送第一条消息，CLI 切换到 Remote 模式

```mermaid
sequenceDiagram
    participant iOS as 📱 iOS App
    participant Server as 🌐 Server
    participant CLI as 💻 CLI
    participant Claude as 🤖 Claude 进程
    participant Daemon as 🔧 Daemon
    participant FileWatcher as 👁️ FileWatcher
    participant SDK as 🎯 Claude SDK
    participant Transcript as 📄 Transcript

    Note over CLI,Claude: 🟢 Local 模式运行中

    iOS->>iOS: 用户输入 "test message"
    iOS->>iOS: 乐观更新：立即显示用户消息
    iOS->>Server: sendMessage("test message")

    Note over Server,CLI: === Remote 切换阶段 ===
    Server->>Server: 检查 sessionClients[sessionId]
    Server->>CLI: emit('remote-connect')

    CLI->>CLI: currentSwitchHandler()
    CLI->>Claude: kill SIGTERM
    Claude->>Claude: 进程退出
    CLI->>CLI: runLocalMode resolve('switch')
    CLI->>CLI: mode = 'remote'
    CLI->>CLI: 显示 Remote 等待 UI

    Note over Daemon,SDK: === Remote 处理阶段 ===
    Server->>Daemon: HTTP POST /sessions/send-message
    Daemon->>FileWatcher: emit('session.pausePush', sessionId)
    FileWatcher->>FileWatcher: pausedSessions.add(sessionId)
    Note over FileWatcher: ⏸️ 暂停推送<br/>但继续监听

    Daemon->>SDK: query({<br/>  prompt: "test message",<br/>  resume: sessionId,<br/>  cwd: projectPath<br/>})
    SDK->>Transcript: append 用户消息
    SDK->>SDK: 调用 Claude API
    SDK->>Transcript: append assistant 消息
    SDK->>Daemon: 返回 assistant 响应

    Note over Daemon,iOS: === 主动推送阶段 ===
    Daemon->>Server: notifyNewMessage(assistant)
    Server->>iOS: emit('message:new', assistant)
    iOS->>iOS: 显示 assistant 消息

    Daemon->>FileWatcher: emit('session.resumePush', sessionId)
    FileWatcher->>FileWatcher: pausedSessions.delete(sessionId)
    Note over FileWatcher: ▶️ 恢复推送
```

**关键点**:
1. ✅ iOS 乐观更新用户消息（本地显示）
2. ✅ CLI 杀掉 Claude 进程，进入 Remote 等待 UI
3. ✅ FileWatcher **暂停推送**但不停止监听
4. ✅ Daemon SDK 处理完后**主动推送** assistant 消息
5. ✅ 推送完成后**恢复** FileWatcher 推送

---

## 4. Remote 模式切回 Local

### 场景 A：用户在 CLI 按 'q' 退出 Remote

```mermaid
sequenceDiagram
    participant User as 👤 用户
    participant CLI as 💻 CLI (Remote UI)
    participant Claude as 🤖 Claude 进程
    participant Server as 🌐 Server
    participant FileWatcher as 👁️ FileWatcher

    Note over CLI: 🟡 Remote 模式等待中<br/>显示: "Press q to exit"

    User->>CLI: 按下 'q' 键
    CLI->>CLI: keyHandler 检测到 'q'
    CLI->>CLI: cleanup() 清理 stdin
    CLI->>CLI: runRemoteMode resolve('switch')
    CLI->>CLI: mode = 'local'

    Note over CLI,Claude: === 恢复 Local 模式 ===
    CLI->>Claude: spawn claude --resume sessionId
    Claude->>Claude: 启动成功
    Note over Claude: 用户可以继续输入

    Note over FileWatcher: FileWatcher 已经在运行<br/>在 Remote 期间只是暂停推送
    Note over FileWatcher: 现在可以正常推送了
```

### 场景 B：iOS 断开连接，自动切回 Local

```mermaid
sequenceDiagram
    participant iOS as 📱 iOS App
    participant Server as 🌐 Server
    participant CLI as 💻 CLI (Remote UI)
    participant Claude as 🤖 Claude 进程

    Note over CLI: 🟡 Remote 模式等待中

    iOS->>Server: disconnect 或 unsubscribe
    Server->>Server: cleanupClient(clientId)
    Server->>Server: sessionClients[sessionId].swift.delete()
    Server->>CLI: emit('remote-disconnect')

    CLI->>CLI: currentRemoteModeResolver()
    CLI->>CLI: cleanup() 清理 stdin
    CLI->>CLI: runRemoteMode resolve('switch')
    CLI->>CLI: mode = 'local'

    CLI->>Claude: spawn claude --resume sessionId
    Claude->>Claude: 启动成功
    Note over CLI,Claude: 🟢 恢复 Local 模式
```

**关键点**:
1. ✅ CLI 重新启动 `claude --resume sessionId`
2. ✅ FileWatcher 一直在运行，无需重新启动
3. ✅ 用户可以继续在 CLI 输入

---

## 5. FileWatcher 推送控制机制

```mermaid
flowchart TD
    Start[📄 Transcript 文件变化] --> Detect[👁️ FileWatcher 检测到变化]
    Detect --> Check{检查 pausedSessions}

    Check -->|sessionId 在暂停列表中| Skip[⏸️ 跳过推送<br/>🟡 Remote 模式处理中]
    Check -->|sessionId 不在列表中| Read[📖 读取最新 1 条消息]

    Read --> Push[📤 推送给 Server]
    Push --> Server[🌐 Server 转发]
    Server --> iOS[📱 iOS 接收显示]

    Skip --> Wait[⏳ 等待 resumePush 事件]
    Wait --> Resume[▶️ 恢复推送]
    Resume --> Detect

    style Skip fill:#fff3cd
    style Resume fill:#d1ecf1
    style iOS fill:#d4edda
```

**状态管理**:
```typescript
// Daemon/SessionController
emit('session.pausePush', { sessionId })  // Remote 开始
emit('session.resumePush', { sessionId }) // Remote 结束

// Daemon/DataCollector
pausedSessions = new Set<string>()
// 推送前检查：if (pausedSessions.has(sessionId)) return
```

---

## 6. SDK 内部机制与消息过滤

### 6.1 SDK 自动生成的文件类型

当使用 `@anthropic-ai/claude-agent-sdk` 的 `query()` 方法时,SDK 会自动生成多种内部文件:

| 文件类型 | 用途 | 是否推送给客户端 | 是否显示在会话列表 |
|---------|------|-----------------|------------------|
| `type: user/assistant/system` | 真实对话消息 | ✅ 推送 | ✅ 显示 |
| `type: queue-operation` | 队列管理 (enqueue/dequeue) | ❌ 过滤 | ❌ 不显示 |
| `type: summary` | 会话摘要 | ❌ 过滤 | ❌ 不显示 |
| `type: checkpoint` | 状态快照 | ❌ 过滤 | ❌ 不显示 |
| `type: file-history-snapshot` | 文件历史记录 | ❌ 过滤 | ❌ 不显示 |
| `agent-*.jsonl` | Agent 子任务(Explore等) | ❌ 不推送 | ❌ 不显示 |

### 6.2 FileWatcher 过滤逻辑

```mermaid
flowchart TD
    Start[📄 读取 JSONL 文件] --> Parse[解析每一行 JSON]
    Parse --> FilterAgent{是否为 agent-*.jsonl?}

    FilterAgent -->|是| Skip1[❌ 跳过,不加入会话列表]
    FilterAgent -->|否| FilterType{检查 message.type}

    FilterType -->|queue-operation| Skip2[❌ 过滤掉]
    FilterType -->|checkpoint| Skip2
    FilterType -->|file-history-snapshot| Skip2
    FilterType -->|summary| Skip2
    FilterType -->|user/assistant/system| Keep[✅ 保留并推送]

    Keep --> Push[📤 推送给客户端]

    style Skip1 fill:#ffe6e6
    style Skip2 fill:#ffe6e6
    style Keep fill:#d4edda
```

**实现位置**:
- `vlaude-daemon/src/module/data-collector/data-collector.service.ts:354-366` (过滤 summary 和 agent 文件)
- `vlaude-daemon/src/module/data-collector/data-collector.service.ts:641-648` (过滤消息类型)

```typescript
// 1. 过滤 agent 文件和 summary 文件
if (file.endsWith('.jsonl') && !file.startsWith('agent-')) {
  const firstLine = await this.readFirstLine(sessionPath);
  const entry = JSON.parse(firstLine);
  if (entry.type === 'summary') {
    continue; // 跳过 summary 文件
  }
}

// 2. 过滤消息内部类型
.filter((msg) => {
  if (!msg.type) return true;
  const internalTypes = ['queue-operation', 'checkpoint', 'file-history-snapshot', 'summary'];
  return !internalTypes.includes(msg.type);
})
```

### 6.3 SDK Agent 预热机制

SDK 在执行 `query()` 时会自动创建 Explore Agent 进行任务预热:

```mermaid
sequenceDiagram
    participant Daemon as 🔧 Daemon
    participant SDK as 🎯 Claude SDK
    participant Transcript as 📄 Transcript
    participant Agent as 🤖 Agent 子任务

    Daemon->>SDK: query({ prompt, resume: sessionId })
    SDK->>SDK: 分析任务复杂度
    SDK->>Agent: 创建 Explore agent
    Agent->>Transcript: 写入 agent-{uuid}.jsonl
    Note over Agent,Transcript: Agent 执行探索任务
    Agent->>Agent: 收集上下文信息
    Agent->>SDK: 返回探索结果
    SDK->>SDK: 使用探索结果优化主任务
    SDK->>Transcript: 写入 queue-operation (enqueue)
    SDK->>Transcript: 写入 user 消息
    SDK->>Transcript: 调用 Claude API
    SDK->>Transcript: 写入 assistant 消息
    SDK->>Transcript: 写入 queue-operation (dequeue)
    SDK->>Daemon: 返回最终响应
```

**关键点**:
1. ✅ Agent 文件是 SDK 的内部机制,用户无需感知
2. ✅ FileWatcher 会过滤这些文件,不显示在会话列表中
3. ✅ queue-operation 用于追踪任务队列,也会被过滤

---

## 7. 增量更新策略

### 7.1 数据流优先级

```mermaid
flowchart LR
    MAC[📁 MAC 本地文件系统<br/>~/.claude/projects/] -->|优先级 1| Compare{对比 mtime<br/>和 lineCount}
    DB[(💾 数据库缓存)] -->|优先级 2| Compare

    Compare -->|文件更新| Update[🔄 更新数据库]
    Compare -->|无变化| UseCache[📦 使用缓存]

    Update --> Return[✅ 返回最新数据]
    UseCache --> Return

    style MAC fill:#d4edda
    style DB fill:#d1ecf1
```

### 7.2 增量更新判断逻辑

**实现位置**: `vlaude-server/src/module/session/session.service.ts:335-360`

```typescript
async categorizeSessions(daemonSessions) {
  const newSessions = [];
  const unchangedSessions = [];

  for (const daemonSession of daemonSessions) {
    const dbSession = await this.prisma.session.findUnique({
      where: { sessionId: daemonSession.sessionId }
    });

    if (!dbSession) {
      // 情况 1: 新会话,数据库中不存在
      newSessions.push(daemonSession);
    } else {
      const dbMtime = dbSession.lastMtime?.getTime() || 0;
      const daemonMtime = daemonSession.lastUpdated.getTime();
      const dbLineCount = dbSession.messageCount;
      const daemonLineCount = daemonSession.messageCount;

      if (dbMtime < daemonMtime || dbLineCount < daemonLineCount) {
        // 情况 2: 有更新 (文件更新时间更新或消息数增加)
        newSessions.push(daemonSession);
      } else {
        // 情况 3: 无变化,使用缓存
        unchangedSessions.push(daemonSession);
      }
    }
  }

  return { newSessions, unchangedSessions };
}
```

### 7.3 增量更新流程

```mermaid
flowchart TD
    Start[🔍 获取会话列表] --> Fetch[📡 从 Daemon 获取文件元数据<br/>mtime, lineCount]
    Fetch --> Query[🔎 查询数据库已缓存的会话]

    Query --> Compare{对比每个会话}

    Compare -->|数据库中不存在| New[🆕 标记为新会话]
    Compare -->|mtime 或 lineCount 更大| Update[🔄 标记为需要更新]
    Compare -->|mtime 和 lineCount 相同| Cache[📦 标记为使用缓存]

    New --> UpdateDB[💾 更新数据库缓存]
    Update --> UpdateDB
    Cache --> Skip[⏭️ 跳过更新]

    UpdateDB --> Return[✅ 返回会话列表]
    Skip --> Return

    style New fill:#d4edda
    style Update fill:#fff3cd
    style Cache fill:#d1ecf1
```

**优点**:
1. ✅ 减少文件 I/O 操作
2. ✅ 提高响应速度
3. ✅ 保证数据一致性 (MAC 文件为准)

---

## 8. 关键组件职责矩阵

| 组件 | Local 模式 | Remote 模式 | 职责 |
|------|-----------|------------|------|
| **CLI** | 运行 Claude 进程 | 显示等待 UI | 模式切换、进程管理 |
| **Claude 进程** | 处理用户输入 | 不运行 | 与 Claude API 交互 |
| **Server** | 路由消息 | 路由消息 | WebSocket 中继 |
| **Daemon** | 监听文件推送 | SDK 处理消息 | 文件监听 + SDK 集成 |
| **FileWatcher** | 实时推送 | 暂停推送 | 检测文件变化 |
| **iOS** | 只读显示 | 发送 + 显示 | 用户交互 |

---

## 9. 消息类型对比

### Local 模式
```
用户消息: 不推送 (CLI 本地显示)
Assistant 消息: FileWatcher 推送给 iOS
```

### Remote 模式
```
用户消息: iOS 乐观更新 (本地显示)
Assistant 消息: Daemon 主动推送给 iOS
```

---

## 10. 潜在问题和讨论点

### ❓ 问题 1: 并发场景
**场景**: 两个 iOS 设备同时连接同一个 session
```mermaid
graph LR
    iOS1[📱 iOS 设备 1] -->|join| Server
    iOS2[📱 iOS 设备 2] -->|join| Server
    Server --> CLI[💻 CLI]
    CLI -.->|只有一个| Remote[Remote 模式]
```

**当前行为**:
- `sessionClients[sessionId].swift` 是一个 Set
- 所有 Swift 设备都会收到消息
- 但多个设备同时发送消息会怎样？

**需要讨论**:
- 是否需要消息队列？
- 是否需要锁机制？

---

### ❓ 问题 2: 消息去重
**场景**: FileWatcher 推送 + Daemon 主动推送可能重复

**当前解决方案**: 暂停 FileWatcher 推送

**需要确认**:
- iOS 端是否需要额外的去重逻辑？
- 使用 message.uuid 去重？

---

### ❓ 问题 3: 错误恢复
**场景**: SDK 处理失败时

**当前逻辑**:
```typescript
catch (error) {
  // 恢复 FileWatcher
  emit('session.resumePush', { sessionId })
}
```

**需要讨论**:
- 是否需要重试机制？
- 失败消息如何通知 iOS？

---

### ❓ 问题 4: Session 生命周期
**场景**: CLI 退出后，iOS 是否继续监听？

**当前行为**:
- FileWatcher 继续运行（基于 iOS 订阅）
- 但没有 CLI，谁来处理消息？

**需要讨论**:
- 是否需要通知 iOS "CLI 已离线"？
- 是否允许 iOS 独立使用 SDK？

---

### ❓ 问题 5: FileWatcher 订阅计数
**当前逻辑**:
```typescript
subscriberCount++ // Swift subscribe
subscriberCount-- // Swift unsubscribe
// subscriberCount === 0 时关闭监听
```

**Remote 模式不影响订阅计数** ✅

**需要确认**: 这个设计是否合理？

---

## 11. 使用建议

### 查看此文档的方式

1. **VS Code** (推荐)
   ```bash
   # 安装插件
   code --install-extension bierner.markdown-mermaid
   # 打开预览
   # Cmd+Shift+V (Mac) 或 Ctrl+Shift+V (Windows)
   ```

2. **在线查看**
   - 访问 https://mermaid.live/
   - 复制 mermaid 代码块粘贴进去

3. **Typora**
   - 直接打开此文件即可看到图表

### 进一步讨论
请基于以上流程图提出你的疑问和建议！
