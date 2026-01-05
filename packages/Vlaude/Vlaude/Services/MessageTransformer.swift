//
//  MessageTransformer.swift
//  Vlaude
//
//  消息转换器 - 将原始消息流转换为展示用的消息流
//  支持增量更新、工具结果合并、消息过滤
//

import Foundation

// MARK: - 展示用消息模型

/// 展示用的消息（经过转换和合并）
public struct DisplayMessage: Identifiable {
    public let id: String  // uuid
    public let type: DisplayMessageType
    public let timestamp: Date

    // 通用内容
    public var textContent: String = ""
    public var images: [ImageData] = []

    // Assistant 特有
    public var toolExecutions: [ToolExecution] = []
    public var thinkingContent: String?
    public var isAgentMessage: Bool = false
    public var agentId: String?

    // User 特有
    public var isInterrupted: Bool = false
    public var thinkingMetadata: ThinkingMetadata?

    // System 特有
    public var systemSubtype: String?
    public var systemLevel: String?  // info, warn, error

    public init(id: String, type: DisplayMessageType, timestamp: Date) {
        self.id = id
        self.type = type
        self.timestamp = timestamp
    }
}

public enum DisplayMessageType {
    case user
    case assistant
    case system
}

/// 图片数据
public struct ImageData: Identifiable {
    public let id = UUID()
    public let type: String  // "base64"
    public let mediaType: String  // "image/png"
    public let data: String  // base64 data

    public init(type: String, mediaType: String, data: String) {
        self.type = type
        self.mediaType = mediaType
        self.data = data
    }
}

/// 思考元数据
public struct ThinkingMetadata {
    public let budget: Int?
    public let enabled: Bool

    public init(budget: Int?, enabled: Bool) {
        self.budget = budget
        self.enabled = enabled
    }
}

// MARK: - 消息转换器

/// 消息转换器 - 负责将原始消息转换为展示消息
/// 支持增量更新、缓存、工具结果合并
class MessageTransformer {

    // ISO8601 日期格式化器
    private static let iso8601Formatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    // 将 String timestamp 转换为 Date
    private func parseTimestamp(_ timestamp: String?) -> Date {
        guard let timestamp = timestamp,
              let date = Self.iso8601Formatter.date(from: timestamp) else {
            return Date()  // 默认返回当前时间
        }
        return date
    }

    // MARK: - 缓存管理

    /// 已转换的消息缓存 (uuid -> DisplayMessage)
    private var cache: [String: DisplayMessage] = [:]

    /// 工具执行缓存 (tool_use_id -> ToolExecution)
    private var toolCache: [String: ToolExecution] = [:]

    /// 上次转换的消息 ID 列表（用于检测删除）
    private var lastMessageIds: Set<String> = []

    /// 清空缓存
    func clearCache() {
        cache.removeAll()
        toolCache.removeAll()
        lastMessageIds.removeAll()
    }

    // MARK: - 核心转换逻辑

    /// 转换消息列表（支持增量更新）
    /// - Parameter messages: 原始消息列表
    /// - Returns: 展示消息列表
    func transform(messages: [Message]) -> [DisplayMessage] {
        let currentMessageIds = Set(messages.compactMap { $0.uuid })

        // 检测删除的消息，清理缓存
        let deletedIds = lastMessageIds.subtracting(currentMessageIds)
        for deletedId in deletedIds {
            cache.removeValue(forKey: deletedId)
        }
        lastMessageIds = currentMessageIds

        // 第一遍：提取所有工具结果，更新工具缓存
        updateToolCache(from: messages)

        // 第二遍：转换消息
        var displayMessages: [DisplayMessage] = []

        for msg in messages {
            guard let uuid = msg.uuid else { continue }

            // 检查是否需要更新
            if let cached = cache[uuid], !needsUpdate(msg, in: messages) {
                displayMessages.append(cached)
                continue
            }

            // 转换消息
            if let displayMsg = transformMessage(msg, context: messages) {
                cache[uuid] = displayMsg
                displayMessages.append(displayMsg)
            }
        }

        return displayMessages
    }

    /// 判断消息是否需要重新转换
    private func needsUpdate(_ msg: Message, in messages: [Message]) -> Bool {
        // Assistant 消息：检查是否有新的工具结果
        if msg.type == "assistant" {
            // 提取 tool_use_id 列表
            let toolIds = extractToolUseIds(from: msg)

            // 检查工具缓存中是否有更新
            for toolId in toolIds {
                if let uuid = msg.uuid,
                   let cachedTool = toolCache[toolId],
                   let cachedMsg = cache[uuid] {
                    // 检查结果是否变化
                    let cachedExecution = cachedMsg.toolExecutions.first { $0.id == toolId }
                    if cachedExecution?.result == nil && cachedTool.result != nil {
                        return true  // 有新结果
                    }
                }
            }
        }

        // 其他消息类型暂时不需要更新
        return false
    }

    /// 更新工具缓存
    private func updateToolCache(from messages: [Message]) {
        for msg in messages {
            // 只处理 user 类型的工具结果
            guard msg.type == "user" else { continue }

            // 提取工具结果
            if let results = extractToolResults(from: msg) {
                for (toolId, result) in results {
                    // 查找对应的工具执行
                    if var execution = toolCache[toolId] {
                        execution.result = result
                        toolCache[toolId] = execution
                    } else {
                        // 创建新的工具执行（没有 input 信息）
                        toolCache[toolId] = ToolExecution(
                            id: toolId,
                            name: extractToolName(from: msg, toolId: toolId),
                            input: [:],
                            result: result
                        )
                    }
                }
            }
        }
    }

    // MARK: - 消息转换

    /// 转换单个消息
    private func transformMessage(_ msg: Message, context: [Message]) -> DisplayMessage? {
        switch msg.type {
        case "assistant":
            return transformAssistantMessage(msg, context: context)

        case "user":
            // 先检查是否是工具结果消息
            if isToolResultMessage(msg) {
                return transformToolResultMessage(msg)
            }
            // 判断是否应该显示为普通用户消息
            if shouldDisplayUserMessage(msg) {
                return transformUserMessage(msg)
            }
            return nil

        case "system":
            return transformSystemMessage(msg)

        default:
            return nil
        }
    }

    /// 转换工具结果消息（单独的气泡）
    private func transformToolResultMessage(_ msg: Message) -> DisplayMessage? {
        guard let uuid = msg.uuid else { return nil }

        var displayMsg = DisplayMessage(
            id: uuid,
            type: .assistant,  // 显示为 assistant 类型，使用工具结果样式
            timestamp: parseTimestamp(msg.timestamp)
        )

        var executions: [ToolExecution] = []

        // 优先从 contentBlocks 提取
        if let blocks = msg.contentBlocks {
            for block in blocks {
                if case .toolResult(let resultBlock) = block {
                    // 查找对应的工具调用以获取工具名
                    let toolName = findToolName(forToolUseId: resultBlock.toolUseId)

                    let execution = ToolExecution(
                        id: resultBlock.toolUseId,
                        name: toolName,
                        input: [:],
                        result: ToolExecution.ToolResult(
                            content: resultBlock.content,
                            isError: resultBlock.isError,
                            timestamp: parseTimestamp(msg.timestamp)
                        )
                    )
                    executions.append(execution)
                }
            }
        } else if let message = msg.message, case .array(let items) = message.content {
            // fallback: 从 message.content 提取
            for item in items {
                guard case .object(let dict) = item,
                      case .string(let type) = dict["type"],
                      type == "tool_result",
                      case .string(let toolUseId) = dict["tool_use_id"] else { continue }

                let content: String
                if case .string(let str) = dict["content"] {
                    content = str
                } else if case .array(let arr) = dict["content"] {
                    content = arr.compactMap { item -> String? in
                        if case .object(let obj) = item,
                           case .string(let text) = obj["text"] {
                            return text
                        }
                        return nil
                    }.joined(separator: "\n")
                } else {
                    content = ""
                }

                let isError: Bool
                if case .bool(let err) = dict["is_error"] {
                    isError = err
                } else {
                    isError = false
                }

                let toolName = findToolName(forToolUseId: toolUseId)

                let execution = ToolExecution(
                    id: toolUseId,
                    name: toolName,
                    input: [:],
                    result: ToolExecution.ToolResult(
                        content: content,
                        isError: isError,
                        timestamp: parseTimestamp(msg.timestamp)
                    )
                )
                executions.append(execution)
            }
        }

        displayMsg.toolExecutions = executions
        return displayMsg
    }

    /// 从缓存中查找工具名
    private func findToolName(forToolUseId toolId: String) -> String {
        if let cached = toolCache[toolId] {
            return cached.name
        }
        return "Tool"  // 默认名称
    }

    /// 转换 Assistant 消息
    private func transformAssistantMessage(_ msg: Message, context: [Message]) -> DisplayMessage {
        guard let uuid = msg.uuid else {
            fatalError("Assistant message must have uuid")
        }

        var displayMsg = DisplayMessage(
            id: uuid,
            type: .assistant,
            timestamp: parseTimestamp(msg.timestamp)
        )

        // 优先使用服务端解析好的 contentBlocks
        if let blocks = msg.contentBlocks, !blocks.isEmpty {
            var texts: [String] = []
            var executions: [ToolExecution] = []

            for block in blocks {
                switch block {
                case .text(let textBlock):
                    texts.append(textBlock.text)

                case .thinking(let thinkingBlock):
                    displayMsg.thinkingContent = thinkingBlock.thinking

                case .toolUse(let toolBlock):
                    // 从 contentBlocks 提取工具执行
                    var input: [String: String] = [:]
                    if let inputDict = toolBlock.input {
                        for (key, value) in inputDict {
                            input[key] = jsonValueToString(value)
                        }
                    }

                    // 查找工具结果
                    let result = findToolResultFromContentBlocks(toolId: toolBlock.id, in: context)

                    let execution = ToolExecution(
                        id: toolBlock.id,
                        name: toolBlock.name,
                        input: input,
                        result: result
                    )
                    executions.append(execution)
                    toolCache[execution.id] = execution

                case .toolResult:
                    // tool_result 在 assistant 消息中不应出现，跳过
                    break

                case .unknown:
                    break
                }
            }

            displayMsg.textContent = texts.joined(separator: "\n")
            displayMsg.toolExecutions = executions
        } else {
            // fallback: 从 message.content 解析（旧逻辑）
            guard let message = msg.message else { return displayMsg }
            if case .array(let items) = message.content {
                var texts: [String] = []
                var executions: [ToolExecution] = []

                for item in items {
                    guard case .object(let dict) = item else { continue }

                    if case .string(let type) = dict["type"] {
                        switch type {
                        case "text":
                            if case .string(let text) = dict["text"] {
                                texts.append(text)
                            }

                        case "thinking":
                            if case .string(let thinking) = dict["thinking"] {
                                displayMsg.thinkingContent = thinking
                            }

                        case "tool_use":
                            if let execution = extractToolExecution(from: dict, context: context) {
                                executions.append(execution)
                                toolCache[execution.id] = execution
                            }

                        default:
                            break
                        }
                    }
                }

                displayMsg.textContent = texts.joined(separator: "\n")
                displayMsg.toolExecutions = executions
            } else if case .string(let text) = message.content {
                displayMsg.textContent = text
            }
        }

        // Agent 消息标识
        if let agentId = msg.agentId {
            displayMsg.isAgentMessage = true
            displayMsg.agentId = agentId
        }

        return displayMsg
    }

    /// 从 context 中的 contentBlocks 查找工具结果
    private func findToolResultFromContentBlocks(toolId: String, in messages: [Message]) -> ToolExecution.ToolResult? {
        // 先检查缓存
        if let cached = toolCache[toolId], cached.result != nil {
            return cached.result
        }

        // 从 user 消息的 contentBlocks 中查找
        for msg in messages {
            guard msg.type == "user", let blocks = msg.contentBlocks else { continue }

            for block in blocks {
                if case .toolResult(let resultBlock) = block, resultBlock.toolUseId == toolId {
                    return ToolExecution.ToolResult(
                        content: resultBlock.content,
                        isError: resultBlock.isError,
                        timestamp: parseTimestamp(msg.timestamp)
                    )
                }
            }
        }

        // fallback: 从原始 message.content 查找
        return findToolResult(toolId: toolId, in: messages)
    }

    /// 转换 User 消息
    private func transformUserMessage(_ msg: Message) -> DisplayMessage {
        guard let uuid = msg.uuid else {
            fatalError("User message must have uuid")
        }

        var displayMsg = DisplayMessage(
            id: uuid,
            type: .user,
            timestamp: parseTimestamp(msg.timestamp)
        )

        // 提取文本内容和图片
        guard let message = msg.message else { return displayMsg }
        if case .array(let items) = message.content {
            var texts: [String] = []
            var images: [ImageData] = []

            for item in items {
                guard case .object(let dict) = item else { continue }

                if case .string(let type) = dict["type"] {
                    switch type {
                    case "text":
                        if case .string(let text) = dict["text"] {
                            texts.append(text)

                            // 检查是否是中断消息
                            if text.contains("[Request interrupted by user for tool use]") {
                                displayMsg.isInterrupted = true
                            }
                        }

                    case "image":
                        if let imageData = extractImageData(from: dict) {
                            images.append(imageData)
                        }

                    default:
                        break
                    }
                }
            }

            displayMsg.textContent = texts.joined(separator: "\n")
            displayMsg.images = images
        } else if case .string(let text) = message.content {
            displayMsg.textContent = text
        }

        // 思考元数据
        if let metadata = msg.thinkingMetadata {
            displayMsg.thinkingMetadata = extractThinkingMetadata(from: metadata)
        }

        return displayMsg
    }

    /// 转换 System 消息
    private func transformSystemMessage(_ msg: Message) -> DisplayMessage? {
        // 过滤不需要显示的系统消息
        if msg.subtype == "compact_boundary" {
            return nil
        }

        guard let uuid = msg.uuid else {
            return nil  // System 消息没有 uuid 就跳过
        }

        var displayMsg = DisplayMessage(
            id: uuid,
            type: .system,
            timestamp: parseTimestamp(msg.timestamp)
        )

        displayMsg.textContent = msg.systemContent ?? ""
        displayMsg.systemSubtype = msg.subtype
        displayMsg.systemLevel = msg.level

        return displayMsg
    }

    // MARK: - 消息过滤

    /// 判断 User 消息是否应该显示
    private func shouldDisplayUserMessage(_ msg: Message) -> Bool {
        // 1. 工具执行结果 - 特殊处理，不作为普通 User 显示
        // 但会在 transformToolResultMessage 中单独处理
        if msg.toolUseResult != nil {
            return false
        }

        // 2. 检查 contentBlocks 中是否只包含 tool_result
        // 如果只有 tool_result，交给专门的处理逻辑
        if let blocks = msg.contentBlocks, !blocks.isEmpty {
            let hasOnlyToolResults = blocks.allSatisfy { block in
                if case .toolResult = block { return true }
                return false
            }
            if hasOnlyToolResults {
                return false  // 交给 transformToolResultMessage 处理
            }
        }

        // 3. 检查 message.content 中是否只包含 tool_result（fallback）
        if let message = msg.message,
           case .array(let items) = message.content {
            let hasOnlyToolResults = items.allSatisfy { item in
                if case .object(let dict) = item,
                   case .string(let type) = dict["type"] {
                    return type == "tool_result"
                }
                return false
            }
            if hasOnlyToolResults && !items.isEmpty {
                return false  // 交给 transformToolResultMessage 处理
            }
        }

        // 4. 仅 Transcript 可见 - 不显示
        if msg.isVisibleInTranscriptOnly == true {
            return false
        }

        // 5. 压缩摘要 - 不显示
        if msg.isCompactSummary == true {
            return false
        }

        // 6. 元数据消息 - 不显示
        if msg.isMeta == true {
            return false
        }

        return true
    }

    /// 判断是否是工具结果消息
    private func isToolResultMessage(_ msg: Message) -> Bool {
        // 检查 contentBlocks
        if let blocks = msg.contentBlocks, !blocks.isEmpty {
            return blocks.contains { block in
                if case .toolResult = block { return true }
                return false
            }
        }

        // fallback: 检查 message.content
        if let message = msg.message,
           case .array(let items) = message.content {
            return items.contains { item in
                if case .object(let dict) = item,
                   case .string(let type) = dict["type"] {
                    return type == "tool_result"
                }
                return false
            }
        }

        return false
    }

    // MARK: - 工具执行提取

    /// 从 Assistant 消息中提取工具执行
    private func extractToolExecution(from dict: [String: JSONValue], context: [Message]) -> ToolExecution? {
        guard case .string(let toolId) = dict["id"],
              case .string(let toolName) = dict["name"] else {
            return nil
        }

        // 提取输入参数
        var input: [String: String] = [:]
        if case .object(let inputDict) = dict["input"] {
            for (key, value) in inputDict {
                if case .string(let strValue) = value {
                    input[key] = strValue
                } else {
                    // 非字符串值转为 JSON 字符串
                    input[key] = jsonValueToString(value)
                }
            }
        }

        // 查找对应的工具结果（先从缓存查找）
        let result: ToolExecution.ToolResult?
        if let cachedExecution = toolCache[toolId] {
            result = cachedExecution.result
        } else {
            result = findToolResult(toolId: toolId, in: context)
        }

        return ToolExecution(
            id: toolId,
            name: toolName,
            input: input,
            result: result
        )
    }

    /// 查找工具结果
    private func findToolResult(toolId: String, in messages: [Message]) -> ToolExecution.ToolResult? {
        for msg in messages {
            guard msg.type == "user",
                  let message = msg.message,
                  case .array(let items) = message.content else { continue }

            for item in items {
                guard case .object(let dict) = item,
                      case .string(let type) = dict["type"],
                      type == "tool_result",
                      case .string(let useId) = dict["tool_use_id"],
                      useId == toolId else { continue }

                // 找到匹配的结果
                let content: String
                if case .string(let str) = dict["content"] {
                    content = str
                } else if case .array(let arr) = dict["content"] {
                    // content 可能是数组
                    content = arr.compactMap { item -> String? in
                        if case .object(let obj) = item,
                           case .string(let text) = obj["text"] {
                            return text
                        }
                        return nil
                    }.joined(separator: "\n")
                } else {
                    content = ""
                }

                let isError: Bool
                if case .bool(let err) = dict["is_error"] {
                    isError = err
                } else {
                    isError = false
                }

                return ToolExecution.ToolResult(
                    content: content,
                    isError: isError,
                    timestamp: parseTimestamp(msg.timestamp)
                )
            }
        }

        return nil
    }

    /// 从 User 消息中提取工具结果
    private func extractToolResults(from msg: Message) -> [String: ToolExecution.ToolResult]? {
        guard let message = msg.message,
              case .array(let items) = message.content else { return nil }

        var results: [String: ToolExecution.ToolResult] = [:]

        for item in items {
            guard case .object(let dict) = item,
                  case .string(let type) = dict["type"],
                  type == "tool_result",
                  case .string(let toolId) = dict["tool_use_id"] else { continue }

            let content: String
            if case .string(let str) = dict["content"] {
                content = str
            } else if case .array(let arr) = dict["content"] {
                content = arr.compactMap { item -> String? in
                    if case .object(let obj) = item,
                       case .string(let text) = obj["text"] {
                        return text
                    }
                    return nil
                }.joined(separator: "\n")
            } else {
                content = ""
            }

            let isError: Bool
            if case .bool(let err) = dict["is_error"] {
                isError = err
            } else {
                isError = false
            }

            results[toolId] = ToolExecution.ToolResult(
                content: content,
                isError: isError,
                timestamp: parseTimestamp(msg.timestamp)
            )
        }

        return results.isEmpty ? nil : results
    }

    /// 提取 tool_use_id 列表
    private func extractToolUseIds(from msg: Message) -> [String] {
        guard let message = msg.message,
              case .array(let items) = message.content else { return [] }

        var ids: [String] = []
        for item in items {
            if case .object(let dict) = item,
               case .string(let type) = dict["type"],
               type == "tool_use",
               case .string(let id) = dict["id"] {
                ids.append(id)
            }
        }
        return ids
    }

    /// 提取工具名称
    private func extractToolName(from msg: Message, toolId: String) -> String {
        // 尝试从 toolUseResult 中提取
        if case .object(let result) = msg.toolUseResult,
           case .string(let name) = result["toolName"] {
            return name
        }
        return "Unknown"
    }

    // MARK: - 辅助方法

    /// 提取图片数据
    private func extractImageData(from dict: [String: JSONValue]) -> ImageData? {
        guard case .object(let source) = dict["source"],
              case .string(let sourceType) = source["type"],
              case .string(let mediaType) = source["media_type"],
              case .string(let data) = source["data"] else {
            return nil
        }

        return ImageData(
            type: sourceType,
            mediaType: mediaType,
            data: data
        )
    }

    /// 提取思考元数据
    private func extractThinkingMetadata(from json: JSONValue) -> ThinkingMetadata? {
        guard case .object(let dict) = json else { return nil }

        let budget: Int?
        if case .number(let num) = dict["thinkingBudget"] {
            budget = Int(num)
        } else {
            budget = nil
        }

        let enabled: Bool
        if case .bool(let flag) = dict["thinkingEnabled"] {
            enabled = flag
        } else {
            enabled = false
        }

        return ThinkingMetadata(budget: budget, enabled: enabled)
    }

    /// JSONValue 转字符串
    private func jsonValueToString(_ value: JSONValue) -> String {
        switch value {
        case .string(let str):
            return str
        case .number(let num):
            return "\(num)"
        case .bool(let flag):
            return "\(flag)"
        case .null:
            return "null"
        case .array, .object:
            // 数组和对象需要序列化为 JSON 字符串
            if let data = try? JSONEncoder().encode(value),
               let jsonString = String(data: data, encoding: .utf8) {
                return jsonString
            }
            return ""
        }
    }
}
