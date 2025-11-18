# User 消息场景分析报告

> 基于对 50,097 条真实 user 消息的分析
> 数据来源：760 个 JSONL 文件
> 分析时间：2025-11-17

---

## 核心发现

**80.97% 的 "user" 类型消息实际上是工具执行结果，不应该作为用户消息显示！**

这些消息应该被合并到 Assistant 的工具调用流程中，而不是显示为独立的用户消息。

---

## 场景统计汇总

| 场景 | 占比 | 数量 | 显示建议 |
|------|------|------|----------|
| 工具执行结果 | 80.97% | 40,563 | ❌ 不显示（合并到 Assistant） |
| 用户消息+思考元数据 | 13.29% | 6,659 | ✅ 显示（可选展示思考过程） |
| 用户中断请求 | 2.41% | 1,209 | ✅ 显示 |
| 普通文本消息 | 1.15% | 575 | ✅ 显示 |
| 压缩摘要 | 0.80% | 398 | ❌ 不显示 |
| Agent 消息 | 0.37% | 187 | ✅ 显示（加 Agent 标识） |
| 其他场景 | 1.01% | 506 | 按规则处理 |

---

## 详细场景分析

### 场景 1: 工具执行结果（80.97%）

**特征**:
- `hasToolUseResult: true`
- `hasToolResultInContent: true`
- `messageContentType: array[tool_result]`

**真实数据示例**:
```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": [{
      "type": "tool_result",
      "content": "文件内容...",
      "tool_use_id": "toolu_01Bgx7Ph539BpQoGUxEfveut"
    }]
  },
  "toolUseResult": {
    "toolName": "Read",
    "result": "...",
    "isError": false
  }
}
```

**显示建议**: ❌ **不应该显示为用户消息**
- 原因：这是工具执行结果，应合并到 Assistant 的工具调用流程
- UI 处理：在 Assistant 消息中显示 "调用 Read 工具 → 返回结果"

---

### 场景 2: 用户消息 + 思考元数据（13.29%）

**特征**:
- `hasThinkingMetadata: true`
- `messageContentType: string`

**真实数据示例**:
```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": "帮我分析一下这段代码"
  },
  "thinkingMetadata": {
    "thinkingBudget": 10000,
    "thinkingEnabled": true
  }
}
```

**显示建议**: ✅ **应该显示**
- 原因：这是真正的用户输入消息
- UI 处理：显示为普通用户消息，可选展示"思考过程"图标

---

### 场景 3: 用户中断请求（2.41%）

**特征**:
- `messageContentType: array[text]`
- 内容包含 `[Request interrupted by user for tool use]`

**真实数据示例**:
```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": [{
      "type": "text",
      "text": "[Request interrupted by user for tool use]"
    }]
  }
}
```

**显示建议**: ✅ **应该显示**
- 原因：用户主动中断，需要显示这个操作
- UI 处理：显示为系统提示消息，如"用户中断了请求"

---

### 场景 4: 普通文本消息（1.15%）

**特征**:
- `messageContentType: string`
- 无其他特殊字段

**真实数据示例**:
```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": "你好"
  }
}
```

**显示建议**: ✅ **应该显示**
- 原因：标准的用户输入
- UI 处理：显示为普通用户消息

---

### 场景 5: 压缩摘要（0.80%）

**特征**:
- `isVisibleInTranscriptOnly: true`
- `isCompactSummary: true`
- `messageContentType: string`

**真实数据示例**:
```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": "会话压缩摘要..."
  },
  "isVisibleInTranscriptOnly": true,
  "isCompactSummary": true
}
```

**显示建议**: ❌ **不应该显示**
- 原因：这是会话压缩的产物，仅用于调试
- UI 处理：完全过滤，不显示

---

### 场景 6: Agent 消息（0.37%）

**特征**:
- `hasAgentId: true`
- `messageContentType: string`

**真实数据示例**:
```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": "执行代码审查..."
  },
  "agentId": "code-reviewer-agent-123"
}
```

**显示建议**: ✅ **应该显示**
- 原因：这是 Agent 任务的输入
- UI 处理：显示为用户消息，但加上 Agent 标识（如"🤖 Agent 任务"）

---

### 场景 7-17: 其他少见场景（1.01%）

包括：
- `isMeta: true` - 元数据消息（不显示）
- `content: array[text, image]` - 多模态消息（显示）
- `content: none` - 空消息（不显示）
- 其他组合场景

---

## 消息过滤规则

### 不应该显示的消息（占 82.77%）

```typescript
function shouldHideMessage(msg: Message): boolean {
  // 1. 工具执行结果
  if (msg.toolUseResult || hasToolResultInContent(msg)) {
    return true;
  }

  // 2. 仅 Transcript 可见
  if (msg.isVisibleInTranscriptOnly) {
    return true;
  }

  // 3. 压缩摘要
  if (msg.isCompactSummary) {
    return true;
  }

  // 4. 元数据消息
  if (msg.isMeta) {
    return true;
  }

  return false;
}
```

### 应该显示的消息（占 17.23%）

```typescript
function getMessageDisplayType(msg: Message): MessageDisplayType {
  // 1. Agent 消息
  if (msg.agentId) {
    return { show: true, type: 'agent' };
  }

  // 2. 思考元数据
  if (msg.thinkingMetadata) {
    return { show: true, type: 'user-with-thinking' };
  }

  // 3. 中断请求
  if (isInterruptMessage(msg)) {
    return { show: true, type: 'system-interrupt' };
  }

  // 4. 普通用户消息
  return { show: true, type: 'normal-user' };
}
```

---

## UI 实现建议

### Swift 端过滤逻辑

```swift
extension Message {
    /// 是否应该在聊天列表中显示
    var shouldDisplayInChat: Bool {
        // 工具执行结果 - 不显示
        if toolUseResult != nil || hasToolResultInContent {
            return false
        }

        // 仅 Transcript 可见 - 不显示
        if isVisibleInTranscriptOnly == true {
            return false
        }

        // 压缩摘要 - 不显示
        if isCompactSummary == true {
            return false
        }

        // 元数据消息 - 不显示
        if isMeta == true {
            return false
        }

        return true
    }

    /// 消息显示类型
    var displayType: MessageDisplayType {
        if agentId != nil {
            return .agent
        }

        if thinkingMetadata != nil {
            return .userWithThinking
        }

        if isInterruptMessage {
            return .systemInterrupt
        }

        return .normalUser
    }

    /// 是否是中断消息
    private var isInterruptMessage: Bool {
        guard let content = message.content else { return false }

        if case .array(let items) = content {
            return items.contains { item in
                if case .text(let text) = item {
                    return text.contains("[Request interrupted by user for tool use]")
                }
                return false
            }
        }

        return false
    }
}

enum MessageDisplayType {
    case normalUser
    case agent
    case userWithThinking
    case systemInterrupt
}
```

### 工具执行结果合并到 Assistant

```swift
/// 将工具执行结果合并到 Assistant 消息
func mergeToolResults(messages: [Message]) -> [DisplayMessage] {
    var displayMessages: [DisplayMessage] = []
    var pendingToolResults: [Message] = []

    for msg in messages {
        if msg.type == "assistant" {
            // 检查下一条是否是工具结果
            // 如果是，合并到当前 assistant 消息
            let toolResults = collectFollowingToolResults(after: msg)

            displayMessages.append(DisplayMessage(
                original: msg,
                toolExecutions: toolResults
            ))
        } else if msg.type == "user" && msg.shouldDisplayInChat {
            displayMessages.append(DisplayMessage(original: msg))
        }
    }

    return displayMessages
}
```

---

## 性能优化建议

1. **前端过滤**: 在 Swift 端直接过滤，减少渲染开销
2. **服务端预处理**: Server 可以预先标记 `shouldDisplay` 字段
3. **索引优化**: 数据库添加 `messageType` 索引，加速查询

---

## 数据源

- **脚本**: `/scripts/analyze-user-message-types.js`
- **JSON 报告**: `/scripts/user-message-scenarios.json`
- **扫描范围**: `~/.claude/projects/**/*.jsonl`
- **总消息数**: 50,097 条 user 消息
- **场景数**: 17 种不同组合

---

## 下一步行动

1. ✅ 在 Swift Message 模型中添加 `shouldDisplayInChat` 计算属性
2. ✅ 在 SessionDetailView 中实现消息过滤逻辑
3. ✅ 实现工具执行结果合并到 Assistant 消息
4. ⬜ 添加 Agent 消息的特殊 UI 标识
5. ⬜ 添加思考过程的可选展示功能

---

**总结**: 通过正确过滤和合并消息，可以将显示的消息数量减少 **82.77%**，大幅提升用户体验和性能！
