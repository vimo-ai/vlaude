# Claude JSONL 消息类型与前端渲染策略

## 📊 消息类型统计

基于 `/Users/higuaifan/.claude/projects` 的实际数据分析：

| 类型 | 数量 | 占比 | 是否显示 | 当前渲染方式 |
|------|------|------|---------|-------------|
| `assistant` | 91,725 | 39.58% | ✅ 显示 | MessageBubble (蓝色/灰色背景) |
| `file-history-snapshot` | 86,275 | 37.23% | ❌ 过滤 | - |
| `user` | 50,911 | 21.97% | ✅ 显示 | MessageBubble (用户侧) |
| `system` | 2,138 | 0.92% | ⚠️ 部分显示 | 当前按 type 显示 |
| `summary` | 564 | 0.24% | ❌ 过滤 | - |
| `queue-operation` | 141 | 0.06% | ❌ 过滤 | - |

---

## 1️⃣ `user` 消息 (用户消息)

### 基本结构
```json
{
  "type": "user",
  "uuid": "cfb50b95-933d-4ab4-ae6c-1f7d3843bb57",
  "timestamp": "2025-11-05T18:34:51.994Z",
  "sessionId": "e951e3c4-4732-4d04-850c-bbb2e43c2bdd",
  "parentUuid": null,
  "isSidechain": true,
  "message": {
    "role": "user",
    "content": "..."
  }
}
```

### 特殊字段及含义

| 字段 | 出现率 | 含义 | 前端处理建议 |
|------|--------|------|-------------|
| `toolUseResult` | 80.6% | 工具执行结果（user 消息包含工具返回） | ✅ 当前已处理：显示为 ToolExecutionBubble |
| `thinkingMetadata` | 13.9% | 思考元数据 | 🔍 可添加思考过程展示 |
| `isVisibleInTranscriptOnly` | 0.8% | 仅在 transcript 可见 | ⚠️ 建议：添加半透明标记 |
| `isCompactSummary` | 0.8% | 压缩摘要消息 | 🔍 建议：特殊样式显示 |
| `isMeta` | 0.4% | 元数据消息 | ⚠️ 建议：灰色背景或折叠 |
| `agentId` | 1.8% | Agent ID（Agent 任务的用户输入） | 🤖 建议：添加 Agent 标识 |

### 当前渲染逻辑
```swift
// SessionDetailView.swift:131-133
private var isUser: Bool {
    message.role == "user"
}

// MessageBubble 显示:
// - 蓝色背景气泡
// - 右对齐
// - 如果有 toolUseResult，显示 ToolExecutionBubble
```

### 优化建议

#### 1. 区分 Agent 消息
```swift
private var isAgentMessage: Bool {
    message.agentId != nil
}

// 显示时添加 Agent 徽章:
if isAgentMessage {
    Label("Agent", systemImage: "brain")
        .font(.caption2)
        .padding(4)
        .background(Color.purple.opacity(0.2))
        .cornerRadius(6)
}
```

#### 2. 处理元数据消息
```swift
private var isMetaMessage: Bool {
    message.isMeta == true || message.isVisibleInTranscriptOnly == true
}

// 样式调整:
.opacity(isMetaMessage ? 0.6 : 1.0)
.overlay(
    isMetaMessage ?
        Text("仅调试可见")
            .font(.caption2)
            .foregroundColor(.orange)
        : nil
)
```

#### 3. 显示思考元数据
```swift
if let thinking = message.thinkingMetadata {
    DisclosureGroup("💭 思考过程") {
        // 显示思考元数据
    }
}
```

---

## 2️⃣ `assistant` 消息 (AI 回复)

### 基本结构
```json
{
  "type": "assistant",
  "uuid": "5c680472-0489-44a6-ada6-9daa996e0b55",
  "timestamp": "2025-11-05T18:35:02.068Z",
  "parentUuid": "cfb50b95-933d-4ab4-ae6c-1f7d3843bb57",
  "isSidechain": true,
  "requestId": "req_011CUqDyBiWfp3UffHjBeVXM",
  "message": {
    "role": "assistant",
    "content": [
      { "type": "text", "text": "..." },
      { "type": "tool_use", "id": "...", "name": "Read", "input": {...} }
    ]
  }
}
```

### 特殊字段及含义

| 字段 | 出现率 | 含义 | 前端处理建议 |
|------|--------|------|-------------|
| `agentId` | 1.3% | Agent ID（Agent 任务的回复） | 🤖 建议：添加 Agent 标识 |
| `isApiErrorMessage` | 0.1% | API 错误消息 | ❌ 建议：红色警告样式 |
| `requestId` | 99.4% | Claude API 请求 ID | 🔍 调试信息，可折叠显示 |
| `isSidechain` | 100% | 是否为侧链消息 | ℹ️ 可用于区分主线/支线对话 |

### 当前渲染逻辑
```swift
// MessageBubble 显示:
// - 灰色背景气泡（普通文本）或 Markdown 渲染
// - 左对齐
// - 工具执行显示为 ToolExecutionBubble
```

### 优化建议

#### 1. 区分 Agent 回复
```swift
private var isAgentResponse: Bool {
    message.agentId != nil
}

// 添加 Agent 徽章
if isAgentResponse {
    HStack {
        Image(systemName: "brain.head.profile")
        Text("Agent 回复")
    }
    .font(.caption)
    .foregroundColor(.purple)
}
```

#### 2. 显示 API 错误
```swift
if message.isApiErrorMessage == true {
    HStack {
        Image(systemName: "exclamationmark.triangle.fill")
        Text("API 错误")
    }
    .foregroundColor(.red)
    .padding(8)
    .background(Color.red.opacity(0.1))
    .cornerRadius(8)
}
```

#### 3. Sidechain 标识
```swift
if message.isSidechain == true {
    // 添加侧链标识（可选）
    Text("↳")
        .font(.caption)
        .foregroundColor(.secondary)
}
```

---

## 3️⃣ `system` 消息 (系统消息)

### 基本结构
```json
{
  "type": "system",
  "uuid": "df2a4c81-4c20-4c06-a01d-20393c1d5d88",
  "timestamp": "2025-11-02T16:06:03.901Z",
  "subtype": "local_command",
  "level": "info",
  "content": "<command-name>/mcp</command-name>..."
}
```

### ⭐ 子类型系统 (98.9% 的 system 消息都有 subtype)

| Subtype | 含义 | 前端处理建议 |
|---------|------|-------------|
| `local_command` | 本地命令执行 | 🔧 建议：命令执行样式，可折叠 |
| `compact_boundary` | 会话压缩边界 | 📦 建议：分隔线 + 提示信息 |
| `hook_result` | Hook 执行结果 | 🪝 建议：特殊样式，显示 hook 信息 |
| `api_error` | API 错误（带重试信息） | ❌ 建议：错误样式 + 重试倒计时 |
| 其他 | 待发现... | - |

### 特殊字段

| 字段 | 出现率 | 含义 | 前端处理建议 |
|------|--------|------|-------------|
| `subtype` | 98.9% | **子类型标识** | ⭐ 核心字段：决定渲染样式 |
| `level` | 100% | 日志级别 (info/warn/error) | 🎨 用于颜色区分 |
| `content` | 52.9% | 消息内容 | 📄 显示内容 |
| `toolUseID` | 50.2% | 关联的工具执行 ID | 🔗 可关联显示 |
| `hookCount` | 26.2% | Hook 执行数量 | 🪝 显示 Hook 统计 |
| `hookInfos` | 26.2% | Hook 详细信息 | 🔍 可展开显示 |
| `error` | 20.9% | 错误对象 | ❌ 错误详情 |
| `retryInMs` | 20.9% | 重试倒计时 | ⏱️ 显示倒计时 |
| `compactMetadata` | 19.8% | 压缩元数据 | 📦 显示压缩信息 |

### 当前渲染逻辑
```swift
// Message.swift:38-43
var role: String {
    if let msg = message {
        return msg.role
    }
    return type  // system 消息会显示为 "system"
}
```

**问题**：当前没有区分 system 的子类型！

### 优化建议

#### 1. 新增 System 消息模型
```swift
// Message.swift 中添加
let subtype: String?  // system 子类型
let level: String?    // info/warn/error
let content: String?  // 系统消息内容
let hookInfos: [String: Any]?
let error: [String: Any]?
let retryInMs: Int?
let compactMetadata: [String: Any]?

enum CodingKeys: String, CodingKey {
    case uuid, type, timestamp, sessionId, parentUuid, message
    case summary, leafUuid
    case subtype, level, content, hookInfos, error, retryInMs, compactMetadata
}
```

#### 2. System 消息专用渲染组件
```swift
struct SystemMessageBubble: View {
    let message: Message

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            // 根据 subtype 显示不同样式
            switch message.subtype {
            case "local_command":
                LocalCommandView(message: message)
            case "compact_boundary":
                CompactBoundaryView(message: message)
            case "hook_result":
                HookResultView(message: message)
            default:
                DefaultSystemView(message: message)
            }
        }
        .padding(12)
        .background(levelColor.opacity(0.1))
        .cornerRadius(12)
    }

    private var levelColor: Color {
        switch message.level {
        case "error": return .red
        case "warn": return .orange
        default: return .blue
        }
    }
}
```

#### 3. 压缩边界样式
```swift
struct CompactBoundaryView: View {
    let message: Message

    var body: some View {
        VStack(spacing: 8) {
            Divider()
            HStack {
                Image(systemName: "arrow.triangle.2.circlepath")
                Text("会话已压缩")
                    .font(.caption)
                Spacer()
                if let metadata = message.compactMetadata {
                    Text("节省 Token")
                        .font(.caption2)
                        .foregroundColor(.secondary)
                }
            }
            Divider()
        }
        .foregroundColor(.blue)
    }
}
```

#### 4. Hook 结果显示
```swift
struct HookResultView: View {
    let message: Message

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Image(systemName: "hook")
                Text("Hook 执行结果")
                    .font(.headline)
                Spacer()
                if let count = message.hookCount {
                    Text("\(count) 个")
                        .font(.caption)
                        .padding(4)
                        .background(Color.blue.opacity(0.2))
                        .cornerRadius(4)
                }
            }

            if let content = message.content {
                Text(content)
                    .font(.system(size: 12, design: .monospaced))
            }
        }
    }
}
```

---

## 4️⃣ `queue-operation` 消息 (队列操作)

### 基本结构
```json
{
  "type": "queue-operation",
  "operation": "enqueue",  // 或 "dequeue"
  "timestamp": "2025-11-03T03:08:06.616Z",
  "content": "继续",
  "sessionId": "a6f754e4-d3fb-405e-8fef-e19f5afa18ee"
}
```

### 子类型：operation 字段

| Operation | 含义 | 前端处理建议 |
|-----------|------|-------------|
| `enqueue` | 消息入队 | 📥 可选：显示入队提示 |
| `dequeue` | 消息出队 | 📤 可选：显示处理完成 |

### 当前处理
❌ **已过滤，不显示**

### 可选优化
如果需要调试队列状态，可以添加：
```swift
struct QueueOperationIndicator: View {
    let operation: String

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: operation == "enqueue" ? "arrow.down.circle" : "arrow.up.circle")
            Text(operation == "enqueue" ? "排队中" : "处理完成")
        }
        .font(.caption2)
        .foregroundColor(.secondary)
        .padding(4)
        .background(Color.gray.opacity(0.1))
        .cornerRadius(6)
    }
}
```

---

## 5️⃣ `file-history-snapshot` 消息 (文件历史快照)

### 基本结构
```json
{
  "type": "file-history-snapshot",
  "messageId": "9ee808d9-158a-4fc9-9c18-d6ddba6ae970",
  "snapshot": {
    "messageId": "...",
    "trackedFileBackups": [...],
    "timestamp": "..."
  },
  "isSnapshotUpdate": false
}
```

### 当前处理
❌ **已过滤，不显示**（占 37.23%，数量最多的内部类型）

### 可选优化
如果需要显示文件历史：
```swift
struct FileSnapshotIndicator: View {
    let snapshot: FileSnapshot

    var body: some View {
        DisclosureGroup {
            // 显示备份的文件列表
            ForEach(snapshot.trackedFiles, id: \.self) { file in
                Text(file)
                    .font(.caption)
            }
        } label: {
            HStack {
                Image(systemName: "clock.arrow.circlepath")
                Text("文件快照")
            }
        }
    }
}
```

---

## 6️⃣ `summary` 消息 (会话摘要)

### 基本结构
```json
{
  "type": "summary",
  "summary": "AI Request Optimization Discussion",
  "leafUuid": "a49db710-9163-4710-a76b-96c03e75692b"
}
```

### 当前处理
❌ **已过滤，不显示**

### 可选优化
可以在会话列表中显示摘要：
```swift
// SessionListView 中
if let summary = session.summary {
    Text(summary)
        .font(.caption)
        .foregroundColor(.secondary)
        .lineLimit(1)
}
```

---

## 📱 前端优化路线图

### Phase 1: 区分 System 子类型 (高优先级)
- [ ] 在 Message.swift 中添加 system 相关字段
- [ ] 创建 SystemMessageBubble 组件
- [ ] 实现 local_command, compact_boundary 等样式

### Phase 2: Agent 消息识别 (中优先级)
- [ ] 添加 agentId 字段解析
- [ ] 在 user/assistant 消息上添加 Agent 徽章
- [ ] 可选：Agent 消息分组显示

### Phase 3: 元数据和调试信息 (低优先级)
- [ ] 添加调试模式开关
- [ ] 显示 queue-operation (可选)
- [ ] 显示 file-history-snapshot (可选)
- [ ] 显示 thinkingMetadata

### Phase 4: 高级交互 (未来)
- [ ] Hook 执行详情展示
- [ ] API 错误重试倒计时
- [ ] 会话压缩边界可视化
- [ ] 思考过程动画

---

## 🎨 推荐的视觉设计

### 消息类型颜色方案

```swift
enum MessageTypeColor {
    case user           // 蓝色 (Blue)
    case assistant      // 灰色 (Gray)
    case systemInfo     // 蓝色淡 (Blue.opacity(0.2))
    case systemWarn     // 橙色 (Orange)
    case systemError    // 红色 (Red)
    case agent          // 紫色 (Purple)
    case meta           // 灰色半透明 (Gray.opacity(0.5))
}
```

### 图标建议

| 类型 | SF Symbol |
|------|-----------|
| User | `person.circle.fill` |
| Assistant | `brain.head.profile` |
| Agent | `brain` |
| System Command | `terminal.fill` |
| Compact Boundary | `arrow.triangle.2.circlepath` |
| Hook | `link.circle.fill` |
| Error | `exclamationmark.triangle.fill` |
| Queue | `arrow.down.circle` / `arrow.up.circle` |
| Snapshot | `clock.arrow.circlepath` |

---

## 🔍 调试建议

添加调试面板查看原始消息：
```swift
#if DEBUG
DisclosureGroup("🔍 调试信息") {
    Text("Type: \(message.type)")
    if let subtype = message.subtype {
        Text("Subtype: \(subtype)")
    }
    Text("UUID: \(message.uuid ?? "N/A")")
    Text("Timestamp: \(message.timestamp ?? "N/A")")
}
.font(.system(size: 10, design: .monospaced))
.foregroundColor(.secondary)
#endif
```

---

## 总结

### 当前缺失的处理
1. ❌ `system` 消息的 `subtype` 没有区分
2. ❌ `agentId` 字段未解析和显示
3. ❌ 元数据消息 (`isMeta`, `isVisibleInTranscriptOnly`) 未特殊处理
4. ❌ Hook、压缩边界等系统事件未可视化

### 建议优先实现
1. ✅ **System 子类型区分** - 提升用户对系统事件的理解
2. ✅ **Agent 消息标识** - 帮助用户理解复杂的多 Agent 交互
3. ✅ **错误和警告样式** - 提升错误可见性
