//
//  Message.swift
//  Vlaude
//
//  Created by Claude on 2025/11/16.
//

import Foundation

// MARK: - ContentBlock 类型（服务端解析后的结构化内容）

/// 结构化内容块（用于富文本 UI 渲染）
enum ContentBlock: Codable {
    case text(TextBlock)
    case toolUse(ToolUseBlock)
    case toolResult(ToolResultBlock)
    case thinking(ThinkingBlock)
    case unknown(UnknownBlock)

    struct TextBlock: Codable {
        let text: String
    }

    struct ToolUseBlock: Codable {
        let id: String
        let name: String
        let input: [String: JSONValue]?
        let displayText: String  // 人类可读描述，如"读取文件: config.json"
        let iconName: String     // SF Symbol 名称
    }

    struct ToolResultBlock: Codable {
        let toolUseId: String
        let isError: Bool
        let content: String
        let preview: String      // 前 200 字符
        let hasMore: Bool
        let sizeDescription: String
    }

    struct ThinkingBlock: Codable {
        let thinking: String
    }

    struct UnknownBlock: Codable {
        let raw: String
    }

    // Custom Codable 实现
    enum CodingKeys: String, CodingKey {
        case type
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)

        switch type {
        case "text":
            let block = try TextBlock(from: decoder)
            self = .text(block)
        case "tool_use":
            let block = try ToolUseBlock(from: decoder)
            self = .toolUse(block)
        case "tool_result":
            let block = try ToolResultBlock(from: decoder)
            self = .toolResult(block)
        case "thinking":
            let block = try ThinkingBlock(from: decoder)
            self = .thinking(block)
        default:
            let block = try UnknownBlock(from: decoder)
            self = .unknown(block)
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .text(let block):
            try container.encode("text", forKey: .type)
            try block.encode(to: encoder)
        case .toolUse(let block):
            try container.encode("tool_use", forKey: .type)
            try block.encode(to: encoder)
        case .toolResult(let block):
            try container.encode("tool_result", forKey: .type)
            try block.encode(to: encoder)
        case .thinking(let block):
            try container.encode("thinking", forKey: .type)
            try block.encode(to: encoder)
        case .unknown(let block):
            try container.encode("unknown", forKey: .type)
            try block.encode(to: encoder)
        }
    }
}

// MARK: - Message

// Claude Code 原始消息格式
struct Message: Identifiable, Codable {
    // 不同类型的消息有不同的唯一标识
    var id: String {
        if let uuid = uuid {
            return uuid
        } else if let leafUuid = leafUuid {
            return "summary-\(leafUuid)"
        } else {
            return "unknown-\(type)-\(timestamp ?? "0")"
        }
    }

    // ========================================
    // 通用字段 (所有类型都有)
    // ========================================
    let uuid: String?
    let type: String
    let timestamp: String?
    let sessionId: String?
    let parentUuid: String?
    let message: MessageInner?

    // 结构化内容块（服务端解析后返回，用于富文本渲染）
    let contentBlocks: [ContentBlock]?

    // ========================================
    // user/assistant 类型字段
    // ========================================
    let isSidechain: Bool?
    let userType: String?
    let cwd: String?
    let version: String?
    let gitBranch: String?
    let requestId: String?
    let agentId: String?  // Agent 消息标识
    let isApiErrorMessage: Bool?  // API 错误消息
    let eventType: String?  // V2: 主 block 类型: "thinking" | "text" | "tool_use" | "tool_result" | "user_text"

    // user 类型特有字段
    let toolUseResult: JSONValue?  // 工具执行结果
    let thinkingMetadata: JSONValue?  // 思考元数据
    let isVisibleInTranscriptOnly: Bool?  // 仅在 transcript 中可见
    let isCompactSummary: Bool?  // 压缩摘要
    let isMeta: Bool?  // 元数据消息

    // ========================================
    // system 类型字段
    // ========================================
    let subtype: String?  // system 子类型: local_command, compact_boundary, hook_result 等
    let level: String?  // 日志级别: info, warn, error
    let systemContent: String?  // 系统消息内容 (避免与计算属性 content 冲突)
    let toolUseID: String?  // 关联的工具执行 ID

    // Hook 相关
    let hookCount: Int?
    let hookInfos: JSONValue?
    let hookErrors: JSONValue?
    let preventedContinuation: Bool?
    let stopReason: String?
    let hasOutput: Bool?

    // 错误和重试相关
    let error: JSONValue?
    let retryInMs: Double?  // 注意：API 返回的是浮点数（如 17293.864131744864）
    let retryAttempt: Int?
    let maxRetries: Int?
    let cause: JSONValue?

    // 压缩相关
    let logicalParentUuid: String?
    let compactMetadata: JSONValue?

    // ========================================
    // summary 类型字段
    // ========================================
    let summary: String?
    let leafUuid: String?

    // ========================================
    // queue-operation 类型字段
    // ========================================
    let operation: String?  // enqueue, dequeue

    // ========================================
    // file-history-snapshot 类型字段
    // ========================================
    let messageId: String?
    let snapshot: JSONValue?
    let isSnapshotUpdate: Bool?

    // ========================================
    // clientMessageId 去重字段
    // ========================================
    let clientMessageId: String?  // 客户端生成的消息 ID，用于乐观更新去重

    // ========================================
    // Server DB 同步字段（Phase 4）
    // ========================================
    let toolCallId: String?         // tool_use block 的 ID（Server sync 模式返回）
    let approvalStatus: String?     // pending, approved, rejected, timeout
    let approvalResolvedAt: Int64?  // 审批完成时间戳（毫秒），使用 Int64 确保不溢出

    // 用于显示的合并后的工具执行结果（在 ViewModel 中填充）
    var mergedToolExecutions: [ToolExecution] = []

    // 用于显示的属性
    var role: String {
        if let msg = message {
            return msg.role
        }
        return type
    }

    var content: String {
        // summary 类型显示摘要
        if type == "summary", let summaryText = summary {
            return "📝 \(summaryText)"
        }

        // system 类型显示 systemContent 字段
        if type == "system", let sysContent = systemContent {
            return sysContent
        }

        // 优先使用 contentBlocks（服务端解析的结构化内容）
        if let blocks = contentBlocks, !blocks.isEmpty {
            return extractContentFromBlocks(blocks)
        }

        // fallback: user/assistant 类型显示 message 内容
        if let msg = message {
            return msg.extractedContent
        }

        return ""
    }

    /// 从 contentBlocks 提取显示内容
    private func extractContentFromBlocks(_ blocks: [ContentBlock]) -> String {
        var parts: [String] = []

        for block in blocks {
            switch block {
            case .text(let textBlock):
                parts.append(textBlock.text)

            case .toolUse(let toolBlock):
                // 使用服务端生成的人类可读描述
                parts.append("🔧 \(toolBlock.displayText)")

            case .toolResult(let resultBlock):
                let prefix = resultBlock.isError ? "❌ " : "✅ "
                parts.append("\(prefix)\(resultBlock.preview)")

            case .thinking:
                // 思考过程目前隐藏
                break

            case .unknown:
                break
            }
        }

        return parts.joined(separator: "\n")
    }

    var timestampDate: Date {
        if let ts = timestamp {
            let formatter = ISO8601DateFormatter()
            return formatter.date(from: ts) ?? Date()
        }
        return Date()
    }

    // 提取工具调用信息（不包含结果）
    var toolExecutions: [ToolExecution] {
        // 如果有合并的结果，优先返回
        if !mergedToolExecutions.isEmpty {
            return mergedToolExecutions
        }
        // 否则返回原始的工具调用
        guard let msg = message else { return [] }
        return msg.extractToolExecutions()
    }

    // ========================================
    // 便捷判断属性
    // ========================================

    /// 是否为 Agent 消息
    var isAgentMessage: Bool {
        agentId != nil
    }

    /// 是否为元数据消息
    var isMetaMessage: Bool {
        isMeta == true || isVisibleInTranscriptOnly == true
    }

    /// 是否为 API 错误消息
    var isApiError: Bool {
        isApiErrorMessage == true
    }

    /// 是否为系统消息
    var isSystemMessage: Bool {
        type == "system"
    }

    /// system 消息的日志级别颜色
    var systemLevelColor: String {
        switch level {
        case "error": return "red"
        case "warn": return "orange"
        default: return "blue"
        }
    }

    /// 是否有思考元数据
    var hasThinkingMetadata: Bool {
        thinkingMetadata != nil
    }

    /// 是否为压缩边界
    var isCompactBoundary: Bool {
        type == "system" && subtype == "compact_boundary"
    }

    enum CodingKeys: String, CodingKey {
        // 通用字段
        case uuid, type, timestamp, sessionId, parentUuid, message, contentBlocks

        // user/assistant 字段
        case isSidechain, userType, cwd, version, gitBranch, requestId, agentId, isApiErrorMessage, eventType

        // user 特有字段
        case toolUseResult, thinkingMetadata, isVisibleInTranscriptOnly, isCompactSummary, isMeta

        // system 字段
        case subtype, level, toolUseID
        case systemContent = "content"  // JSON 中是 content，Swift 中是 systemContent
        case hookCount, hookInfos, hookErrors, preventedContinuation, stopReason, hasOutput
        case error, retryInMs, retryAttempt, maxRetries, cause
        case logicalParentUuid, compactMetadata

        // summary 字段
        case summary, leafUuid

        // queue-operation 字段
        case operation

        // file-history-snapshot 字段
        case messageId, snapshot, isSnapshotUpdate

        // clientMessageId 去重字段
        case clientMessageId

        // Server DB 同步字段（Phase 4）
        case toolCallId, approvalStatus, approvalResolvedAt
    }
}

// 工具执行审批状态
public enum ToolApprovalStatus: Equatable {
    case none                      // 不需要审批或未知
    case awaitingPermission        // 等待用户审批
    case pendingAck                // 用户已审批，等待 ETerm 确认
    case executing                 // ETerm 确认收到，正在执行
    case completed                 // 执行完成（有 tool_result）
    case rejected                  // 用户拒绝
    case timeout                   // 审批超时
}

// 工具执行信息
public struct ToolExecution: Identifiable {
    public let id: String          // tool_use_id
    public let name: String
    public let input: [String: String]  // 简化的参数存储
    public var result: ToolResult?
    public var approvalStatus: ToolApprovalStatus  // 审批状态
    public var approvalRequestId: String?          // 关联的权限请求 ID

    public struct ToolResult {
        public let content: String
        public let isError: Bool
        public let timestamp: Date

        public init(content: String, isError: Bool, timestamp: Date) {
            self.content = content
            self.isError = isError
            self.timestamp = timestamp
        }
    }

    public init(id: String, name: String, input: [String: String], result: ToolResult?, approvalStatus: ToolApprovalStatus = .none, approvalRequestId: String? = nil) {
        self.id = id
        self.name = name
        self.input = input
        self.result = result
        self.approvalStatus = approvalStatus
        self.approvalRequestId = approvalRequestId
    }

    // 格式化显示工具输入参数
    public var formattedInput: String {
        if input.isEmpty {
            return ""
        }

        // 特殊处理常见工具的参数显示
        switch name {
        case "Bash":
            if let command = input["command"] {
                return command
            }
        case "Edit":
            if let filePath = input["file_path"] {
                return "编辑文件: \(filePath)"
            }
        case "Write":
            if let filePath = input["file_path"] {
                return "写入文件: \(filePath)"
            }
        case "Read":
            if let filePath = input["file_path"] {
                return "读取文件: \(filePath)"
            }
        default:
            break
        }

        // 默认显示所有参数
        return input.map { "\($0.key): \($0.value)" }.joined(separator: "\n")
    }

    // MARK: - Diff 渲染相关

    /// 判断是否是 Edit 工具（需要特殊的 diff 显示）
    public var isEditTool: Bool {
        name == "Edit"
    }

    /// 判断工具结果是否应该用 Markdown 渲染
    /// 目前支持：Edit 工具的代码 diff
    public var shouldRenderAsMarkdown: Bool {
        guard let content = result?.content else { return false }

        // Edit 工具返回的内容包含代码片段，适合 Markdown 渲染
        if isEditTool {
            return true
        }

        // 可以扩展其他需要 Markdown 渲染的工具
        return false
    }

    /// 将工具结果格式化为 Markdown
    /// 用于在 UI 中优雅地显示代码 diff 等内容
    public var formattedResultAsMarkdown: String? {
        guard shouldRenderAsMarkdown, let content = result?.content else { return nil }

        if isEditTool {
            // Edit 工具返回的 content 格式：
            // "The file xxx has been updated. Here's the result of running `cat -n`..."
            // 后面跟着带行号的代码片段，直接用 swift 代码块包装

            // 提取文件扩展名以确定语言
            let fileExt = extractFileExtension(from: content)
            let language = languageForExtension(fileExt)

            return """
```\(language)
\(content)
```
"""
        }

        // TODO: 未来可以支持其他工具的 Markdown 格式化
        return nil
    }

    // MARK: - 升级方案备注
    // 🚀 方案二：专业 Diff 组件（待实现）
    // 利用 Message 中的 toolUseResult 字段，可以获取：
    // - oldString: 修改前的代码
    // - newString: 修改后的代码
    // - originalFile: 完整的原始文件
    //
    // 实现思路：
    // 1. 在 ToolExecution 中添加 toolUseResult 引用
    // 2. 创建 DiffView 组件，支持：
    //    - Unified Diff（统一视图，类似 git diff）
    //    - Split Diff（左右对比视图）
    //    - 语法高亮
    //    - 行级 diff 和字符级 diff
    // 3. 可选使用算法库（如 Difference）生成精确的 diff

    // MARK: - Helper Methods

    private func extractFileExtension(from content: String) -> String {
        // 从 "The file /path/to/file.swift has been updated..." 中提取扩展名
        if let filePathMatch = content.range(of: #"/[^\s]+\.\w+"#, options: .regularExpression) {
            let filePath = String(content[filePathMatch])
            if let ext = filePath.split(separator: ".").last {
                return String(ext)
            }
        }
        return "txt"
    }

    private func languageForExtension(_ ext: String) -> String {
        switch ext.lowercased() {
        case "swift": return "swift"
        case "ts", "tsx": return "typescript"
        case "js", "jsx": return "javascript"
        case "py": return "python"
        case "rs": return "rust"
        case "go": return "go"
        case "java": return "java"
        case "kt": return "kotlin"
        case "rb": return "ruby"
        case "cpp", "cc", "cxx": return "cpp"
        case "c": return "c"
        case "h", "hpp": return "cpp"
        case "json": return "json"
        case "yaml", "yml": return "yaml"
        case "md": return "markdown"
        case "sh", "bash": return "bash"
        default: return "text"
        }
    }
}

// 消息内部结构
struct MessageInner: Codable {
    let role: String
    let content: JSONValue

    var extractedContent: String {
        switch content {
        case .string(let str):
            return str
        case .array(let items):
            return extractTextFromContent(items)
        default:
            return ""
        }
    }

    // 提取工具执行信息
    func extractToolExecutions() -> [ToolExecution] {
        guard case .array(let items) = content else { return [] }

        var executions: [ToolExecution] = []

        for item in items {
            guard case .object(let dict) = item else { continue }

            if case .string(let typeStr) = dict["type"], typeStr == "tool_use" {
                // 提取工具调用信息
                guard case .string(let toolId) = dict["id"],
                      case .string(let toolName) = dict["name"] else { continue }

                // 提取输入参数
                var inputParams: [String: String] = [:]
                if case .object(let inputDict) = dict["input"] {
                    for (key, value) in inputDict {
                        if case .string(let strValue) = value {
                            inputParams[key] = strValue
                        }
                    }
                }

                executions.append(ToolExecution(
                    id: toolId,
                    name: toolName,
                    input: inputParams,
                    result: nil
                ))
            }
        }

        return executions
    }

    private func extractTextFromContent(_ items: [JSONValue]) -> String {
        var texts: [String] = []

        for item in items {
            guard case .object(let dict) = item else { continue }

            if case .string(let typeStr) = dict["type"] {
                switch typeStr {
                case "text":
                    if case .string(let text) = dict["text"] {
                        texts.append(text)
                    }
                case "tool_use":
                    if case .string(let name) = dict["name"] {
                        texts.append("🔧 \(name)")
                    }
                case "tool_result":
                    // 提取工具执行结果
                    if case .string(let content) = dict["content"] {
                        // 检查是否是错误
                        let isError: Bool = {
                            if case .bool(let err) = dict["is_error"] {
                                return err
                            }
                            return false
                        }()

                        // 添加状态前缀
                        let prefix = isError ? "❌ " : "✅ "

                        // 不在这里截断，让 UI 层处理
                        texts.append("\(prefix)\(content)")
                    }
                case "thinking":
                    // 思考过程可选显示（目前隐藏）
                    // if case .string(let thinking) = dict["thinking"] {
                    //     texts.append("💭 \(thinking)")
                    // }
                    break
                default:
                    break
                }
            }
        }

        return texts.joined(separator: "\n")
    }
}

// 用于处理任意 JSON 值的枚举
enum JSONValue: Codable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case array([JSONValue])
    case object([String: JSONValue])
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()

        if container.decodeNil() {
            self = .null
        } else if let string = try? container.decode(String.self) {
            self = .string(string)
        } else if let bool = try? container.decode(Bool.self) {
            // Bool 必须在 number 之前检查，因为 JSON 中 true/false 可能被解码为数字
            self = .bool(bool)
        } else if let number = try? container.decode(Double.self) {
            self = .number(number)
        } else if let intNumber = try? container.decode(Int64.self) {
            // 兼容处理：某些高精度数字可能无法直接解码为 Double
            // 先尝试 Int64，然后转换为 Double
            self = .number(Double(intNumber))
        } else if let array = try? container.decode([JSONValue].self) {
            self = .array(array)
        } else if let object = try? container.decode([String: JSONValue].self) {
            self = .object(object)
        } else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "无法解码 JSON 值")
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()

        switch self {
        case .string(let string):
            try container.encode(string)
        case .number(let number):
            try container.encode(number)
        case .bool(let bool):
            try container.encode(bool)
        case .array(let array):
            try container.encode(array)
        case .object(let object):
            try container.encode(object)
        case .null:
            try container.encodeNil()
        }
    }
}

struct MessageListResponse: Codable {
    let success: Bool
    let data: [Message]?
    let total: Int?
    let hasMore: Bool?
    let message: String?
}
