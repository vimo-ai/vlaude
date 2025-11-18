//
//  Message.swift
//  Vlaude
//
//  Created by Claude on 2025/11/16.
//

import Foundation

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
    let retryInMs: Int?
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

        // user/assistant 类型显示 message 内容
        if let msg = message {
            return msg.extractedContent
        }

        return ""
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
        case uuid, type, timestamp, sessionId, parentUuid, message

        // user/assistant 字段
        case isSidechain, userType, cwd, version, gitBranch, requestId, agentId, isApiErrorMessage

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
    }
}

// 工具执行信息
public struct ToolExecution: Identifiable {
    public let id: String
    public let name: String
    public let input: [String: String]  // 简化的参数存储
    public var result: ToolResult?

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

    public init(id: String, name: String, input: [String: String], result: ToolResult?) {
        self.id = id
        self.name = name
        self.input = input
        self.result = result
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
        } else if let number = try? container.decode(Double.self) {
            self = .number(number)
        } else if let bool = try? container.decode(Bool.self) {
            self = .bool(bool)
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
    let data: [Message]
    let total: Int
    let hasMore: Bool
}
