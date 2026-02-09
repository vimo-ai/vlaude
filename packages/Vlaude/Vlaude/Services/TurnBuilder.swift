//
//  TurnBuilder.swift
//  Vlaude
//
//  核心职责：接收实时消息流 → 构建 Turn 列表
//  从 chat bubble 模型转为 timeline/activity feed
//

import Foundation
import Combine

// MARK: - TurnBuilder

class TurnBuilder: ObservableObject {
    @Published var turns: [Turn] = []
    private var currentTurn: Turn?
    private let transformer: MessageTransformer

    // ISO8601 日期格式化器
    private static let iso8601Formatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    init(transformer: MessageTransformer = MessageTransformer()) {
        self.transformer = transformer
    }

    // MARK: - Public API

    /// 处理实时推送的新消息
    func processMessage(_ message: Message) {
        // 跳过非 user/assistant 类型（system, summary, queue-operation 等）
        guard message.type == "user" || message.type == "assistant" else { return }

        // 跳过压缩摘要、仅 transcript 可见、元数据行（不是真正的用户输入）
        if message.isCompactSummary == true { return }
        if message.isVisibleInTranscriptOnly == true { return }
        if message.isMeta == true { return }

        // 1. user_text → 开启新 Turn
        let isUserText = message.eventType == "user_text" ||
            (message.type == "user" && !looksLikeToolResult(message) && !looksLikeCommandOutput(message))
        if isUserText {
            // 前一个 Turn 自动关闭（用户已发送新消息 = 上一轮已结束）
            if let prev = currentTurn, prev.status != .completed {
                prev.status = .completed
            }
            let displayMsg = transformToDisplayMessage(message)
            let turn = Turn(id: message.uuid ?? UUID().uuidString, userMessage: displayMsg)
            turns.append(turn)
            currentTurn = turn
            return
        }

        guard let turn = currentTurn else {
            // 没有当前 Turn，可能是历史加载不完整，创建一个占位 Turn
            if message.type == "user" && message.eventType == "tool_result" {
                // tool_result 没有对应 Turn，忽略（正常情况会在 Turn 内被匹配）
                return
            }
            return
        }

        // 2. tool_result → 匹配到对应 tool_use 事件（兼容无 eventType 的历史消息）
        if message.eventType == "tool_result" || (message.type == "user" && looksLikeToolResult(message)) {
            appendToolResult(message, to: turn)
            // tool_result 到来意味着工具执行完毕，Turn 可能继续
            if turn.status == .waitingTool {
                turn.status = .active
            }
            return
        }

        // 3. subagent 消息 → 归到子时间线
        if let agentId = message.agentId, !agentId.isEmpty {
            appendSubagentEvent(message, agentId: agentId, to: turn)
            return
        }

        // 4. 普通事件 → 追加到当前 Turn（一条消息可能含多个 content blocks）
        let events = buildEvents(from: message)
        turn.events.append(contentsOf: events)

        // 5. 检查 Turn 状态变化
        if message.stopReason == "end_turn" {
            turn.status = .completed
        } else if message.stopReason == "tool_use" {
            turn.status = .waitingTool
        }
    }

    /// 处理历史消息（批量加载）
    /// 使用原子赋值避免 UI 闪烁（先构建到临时变量，最后一次性赋值）
    /// - Parameter openTurn: 后端标记最新 Turn 是否未结束，false 时强制标记完成
    func processHistoryMessages(_ messages: [Message], openTurn: Bool = false) {
        var tempTurns: [Turn] = []
        var tempCurrentTurn: Turn? = nil

        var pendingCompaction = false

        for msg in messages {
            // 检测 compact_boundary（在 user/assistant 过滤之前）
            if msg.type == "system" && msg.subtype == "compact_boundary" {
                pendingCompaction = true
                continue
            }

            guard msg.type == "user" || msg.type == "assistant" else { continue }

            // 跳过压缩摘要、仅 transcript 可见、元数据行
            if msg.isCompactSummary == true { continue }
            if msg.isVisibleInTranscriptOnly == true { continue }
            if msg.isMeta == true { continue }

            let isUserText = msg.eventType == "user_text" ||
                (msg.type == "user" && !looksLikeToolResult(msg))
            if isUserText {
                if let prev = tempCurrentTurn, prev.status != .completed {
                    prev.status = .completed
                }
                let displayMsg = transformToDisplayMessage(msg)
                let turn = Turn(id: msg.uuid ?? UUID().uuidString, userMessage: displayMsg)
                // Fix 3: 标记 compaction 边界
                if pendingCompaction {
                    turn.hasCompactionBefore = true
                    pendingCompaction = false
                }
                tempTurns.append(turn)
                tempCurrentTurn = turn
                continue
            }

            guard let turn = tempCurrentTurn else {
                if msg.type == "user" && (msg.eventType == "tool_result" || looksLikeToolResult(msg)) {
                    continue
                }
                continue
            }

            if msg.eventType == "tool_result" || (msg.type == "user" && looksLikeToolResult(msg)) {
                appendToolResult(msg, to: turn)
                if turn.status == .waitingTool {
                    turn.status = .active
                }
                continue
            }

            if let agentId = msg.agentId, !agentId.isEmpty {
                appendSubagentEvent(msg, agentId: agentId, to: turn)
                continue
            }

            let events = buildEvents(from: msg)
            turn.events.append(contentsOf: events)

            if msg.stopReason == "end_turn" {
                turn.status = .completed
            } else if msg.stopReason == "tool_use" {
                turn.status = .waitingTool
            }
        }

        // 历史数据已经发生过，仅在非 openTurn 时强制标记完成
        if !openTurn, let last = tempTurns.last, last.status != .completed {
            last.status = .completed
        }

        // Fix 4: 标记中断的 tool_use（有 tool_use 但没有对应 tool_result）
        for turn in tempTurns where turn.status == .completed {
            for (i, event) in turn.events.enumerated() {
                if case .toolUse(var exec) = event.content, exec.result == nil {
                    exec.approvalStatus = .timeout
                    turn.events[i] = TurnEvent(
                        id: event.id, eventType: event.eventType,
                        timestamp: event.timestamp,
                        content: .toolUse(execution: exec),
                        isFinal: event.isFinal
                    )
                }
            }
        }

        // 原子赋值 — 只触发一次 @Published
        self.turns = tempTurns
        self.currentTurn = tempCurrentTurn
    }

    /// 清空所有状态
    func clear() {
        turns.removeAll()
        currentTurn = nil
    }

    // MARK: - Event Building

    /// 从单条消息构建多个 TurnEvent（一条 assistant 消息可含多个 content blocks）
    private func buildEvents(from message: Message) -> [TurnEvent] {
        let timestamp = parseTimestamp(message.timestamp)
        let isFinal = message.stopReason == "end_turn"
        let msgId = message.uuid ?? UUID().uuidString

        // 优先：有 contentBlocks 时，每个 block 一个 event
        if let blocks = message.contentBlocks, !blocks.isEmpty {
            return buildEventsFromBlocks(blocks, msgId: msgId, timestamp: timestamp, isFinal: isFinal)
        }

        // 有 eventType：单事件快速路径（实时推送已标记类型）
        if let eventTypeStr = message.eventType,
           let eventType = TurnEvent.EventType(rawValue: eventTypeStr) {
            let content: TurnEventContent
            switch eventType {
            case .thinking:
                content = .thinking(text: extractThinkingText(from: message))
            case .text:
                let text = extractTextContent(from: message)
                guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return [] }
                content = .text(text: text, isMarkdown: hasMarkdown(text))
            case .toolUse:
                content = .toolUse(execution: buildToolExecution(from: message))
            case .toolResult:
                content = .toolResult(result: buildToolResult(from: message), toolName: nil)
            }
            return [TurnEvent(id: msgId, eventType: eventType, timestamp: timestamp, content: content, isFinal: isFinal)]
        }

        // 无 eventType + 无 contentBlocks：从 message.content 推断（兼容旧数据）
        if message.type == "assistant" {
            return buildEventsFromMessageContent(message, msgId: msgId, timestamp: timestamp, isFinal: isFinal)
        }

        return []
    }

    /// 从 contentBlocks 展开为多个 TurnEvent（核心：不再丢失 blocks）
    private func buildEventsFromBlocks(_ blocks: [ContentBlock], msgId: String, timestamp: Date, isFinal: Bool) -> [TurnEvent] {
        var events: [TurnEvent] = []
        for (index, block) in blocks.enumerated() {
            let eventId = index == 0 ? msgId : "\(msgId)-\(index)"
            switch block {
            case .thinking(let thinkingBlock):
                events.append(TurnEvent(
                    id: eventId, eventType: .thinking, timestamp: timestamp,
                    content: .thinking(text: thinkingBlock.thinking), isFinal: false
                ))
            case .text(let textBlock):
                let text = textBlock.text
                guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }
                events.append(TurnEvent(
                    id: eventId, eventType: .text, timestamp: timestamp,
                    content: .text(text: text, isMarkdown: hasMarkdown(text)), isFinal: isFinal
                ))
            case .toolUse(let toolBlock):
                var input: [String: String] = [:]
                if let inputDict = toolBlock.input {
                    for (key, value) in inputDict {
                        input[key] = jsonValueToString(value)
                    }
                }
                let execution = ToolExecution(id: toolBlock.id, name: toolBlock.name, input: input, result: nil, displayText: toolBlock.displayText)
                events.append(TurnEvent(
                    id: eventId, eventType: .toolUse, timestamp: timestamp,
                    content: .toolUse(execution: execution), isFinal: false
                ))
            case .image, .toolResult, .unknown:
                break  // image 在 transformToDisplayMessage 处理; toolResult 走 appendToolResult 路径
            }
        }
        return events
    }

    /// 从 message.message.content 推断事件（无 contentBlocks 的旧格式）
    private func buildEventsFromMessageContent(_ message: Message, msgId: String, timestamp: Date, isFinal: Bool) -> [TurnEvent] {
        guard let msg = message.message, case .array(let items) = msg.content else {
            // 纯文本 content
            let text = extractTextContent(from: message)
            guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return [] }
            return [TurnEvent(
                id: msgId, eventType: .text, timestamp: timestamp,
                content: .text(text: text, isMarkdown: hasMarkdown(text)), isFinal: isFinal
            )]
        }

        var events: [TurnEvent] = []
        for (index, item) in items.enumerated() {
            guard case .object(let dict) = item,
                  case .string(let type) = dict["type"] else { continue }
            let eventId = index == 0 ? msgId : "\(msgId)-\(index)"

            switch type {
            case "thinking":
                if case .string(let text) = dict["thinking"] {
                    events.append(TurnEvent(
                        id: eventId, eventType: .thinking, timestamp: timestamp,
                        content: .thinking(text: text), isFinal: false
                    ))
                }
            case "text":
                if case .string(let text) = dict["text"],
                   !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    events.append(TurnEvent(
                        id: eventId, eventType: .text, timestamp: timestamp,
                        content: .text(text: text, isMarkdown: hasMarkdown(text)), isFinal: isFinal
                    ))
                }
            case "tool_use":
                if case .string(let id) = dict["id"],
                   case .string(let name) = dict["name"] {
                    var input: [String: String] = [:]
                    if case .object(let inputDict) = dict["input"] {
                        for (key, value) in inputDict {
                            input[key] = jsonValueToString(value)
                        }
                    }
                    let execution = ToolExecution(id: id, name: name, input: input, result: nil)
                    events.append(TurnEvent(
                        id: eventId, eventType: .toolUse, timestamp: timestamp,
                        content: .toolUse(execution: execution), isFinal: false
                    ))
                }
            default:
                break
            }
        }
        return events
    }

    // MARK: - Tool Result Matching

    private func appendToolResult(_ message: Message, to turn: Turn) {
        let result = buildToolResult(from: message)
        let toolUseId = extractToolUseId(from: message)

        // 尝试合并到对应的 tool_use 事件（ToolExecutionBubble 需要 result 才能显示结果）
        if let toolUseId = toolUseId,
           let index = turn.events.firstIndex(where: { event in
               if case .toolUse(let exec) = event.content, exec.id == toolUseId {
                   return true
               }
               return false
           }) {
            if case .toolUse(var execution) = turn.events[index].content {
                execution.result = result
                let original = turn.events[index]
                turn.events[index] = TurnEvent(
                    id: original.id,
                    eventType: original.eventType,
                    timestamp: original.timestamp,
                    content: .toolUse(execution: execution),
                    isFinal: original.isFinal
                )
            }
            return
        }

        // 无法匹配时创建独立事件（兜底）
        let toolName = findToolNameFromResult(message)
        let event = TurnEvent(
            id: message.uuid ?? UUID().uuidString,
            eventType: .toolResult,
            timestamp: parseTimestamp(message.timestamp),
            content: .toolResult(result: result, toolName: toolName),
            isFinal: false
        )
        turn.events.append(event)
    }

    private func extractToolUseId(from message: Message) -> String? {
        // 从 contentBlocks 提取
        if let blocks = message.contentBlocks {
            for block in blocks {
                if case .toolResult(let resultBlock) = block {
                    return resultBlock.toolUseId
                }
            }
        }
        // 从 message.content 提取
        if let msg = message.message, case .array(let items) = msg.content {
            for item in items {
                if case .object(let dict) = item,
                   case .string(let type) = dict["type"], type == "tool_result",
                   case .string(let id) = dict["tool_use_id"] {
                    return id
                }
            }
        }
        return nil
    }

    // MARK: - Subagent

    private func appendSubagentEvent(_ message: Message, agentId: String, to turn: Turn) {
        // 找到或创建 SubagentTurn
        var sub = turn.subagentTurns.first(where: { $0.id == agentId })
        if sub == nil {
            let newSub = SubagentTurn(id: agentId, agentModel: inferModel(from: message))
            turn.subagentTurns.append(newSub)
            sub = newSub
        }
        guard let sub = sub else { return }

        let events = buildEvents(from: message)
        sub.events.append(contentsOf: events)
        // 更新摘要（取最后一条 text 事件）
        if let lastText = events.last(where: { $0.eventType == .text }),
           case .text(let text, _) = lastText.content {
            sub.summary = String(text.prefix(100))
        }
    }

    // MARK: - Content Extraction

    func extractThinkingText(from message: Message) -> String {
        // 从 contentBlocks 提取
        if let blocks = message.contentBlocks {
            for block in blocks {
                if case .thinking(let thinkingBlock) = block {
                    return thinkingBlock.thinking
                }
            }
        }
        // 从 message.content 提取
        if let msg = message.message, case .array(let items) = msg.content {
            for item in items {
                if case .object(let dict) = item,
                   case .string(let type) = dict["type"], type == "thinking",
                   case .string(let text) = dict["thinking"] {
                    return text
                }
            }
        }
        return ""
    }

    func extractTextContent(from message: Message) -> String {
        // 从 contentBlocks 提取
        if let blocks = message.contentBlocks {
            let texts = blocks.compactMap { block -> String? in
                if case .text(let textBlock) = block {
                    return textBlock.text
                }
                return nil
            }
            if !texts.isEmpty { return texts.joined(separator: "\n") }
        }
        // 从 message.content 提取
        if let msg = message.message {
            if case .string(let text) = msg.content {
                return text
            }
            if case .array(let items) = msg.content {
                let texts = items.compactMap { item -> String? in
                    if case .object(let dict) = item,
                       case .string(let type) = dict["type"], type == "text",
                       case .string(let text) = dict["text"] {
                        return text
                    }
                    return nil
                }
                return texts.joined(separator: "\n")
            }
        }
        return message.content
    }

    func buildToolExecution(from message: Message) -> ToolExecution {
        // 从 contentBlocks 提取
        if let blocks = message.contentBlocks {
            return buildToolExecutionFromBlocks(message)
        }
        // fallback: 从 message.content 提取
        return buildToolExecutionFromContent(message)
    }

    private func buildToolExecutionFromBlocks(_ message: Message) -> ToolExecution {
        guard let blocks = message.contentBlocks else {
            return ToolExecution(id: UUID().uuidString, name: "Unknown", input: [:], result: nil)
        }

        for block in blocks {
            if case .toolUse(let toolBlock) = block {
                var input: [String: String] = [:]
                if let inputDict = toolBlock.input {
                    for (key, value) in inputDict {
                        input[key] = jsonValueToString(value)
                    }
                }
                return ToolExecution(
                    id: toolBlock.id,
                    name: toolBlock.name,
                    input: input,
                    result: nil,
                    displayText: toolBlock.displayText
                )
            }
        }
        return ToolExecution(id: UUID().uuidString, name: "Unknown", input: [:], result: nil)
    }

    private func buildToolExecutionFromContent(_ message: Message) -> ToolExecution {
        guard let msg = message.message, case .array(let items) = msg.content else {
            return ToolExecution(id: UUID().uuidString, name: "Unknown", input: [:], result: nil)
        }

        for item in items {
            if case .object(let dict) = item,
               case .string(let type) = dict["type"], type == "tool_use",
               case .string(let id) = dict["id"],
               case .string(let name) = dict["name"] {
                var input: [String: String] = [:]
                if case .object(let inputDict) = dict["input"] {
                    for (key, value) in inputDict {
                        input[key] = jsonValueToString(value)
                    }
                }
                return ToolExecution(id: id, name: name, input: input, result: nil)
            }
        }
        return ToolExecution(id: UUID().uuidString, name: "Unknown", input: [:], result: nil)
    }

    func buildToolResult(from message: Message) -> ToolExecution.ToolResult {
        // 从 contentBlocks 提取
        if let blocks = message.contentBlocks {
            for block in blocks {
                if case .toolResult(let resultBlock) = block {
                    return ToolExecution.ToolResult(
                        content: resultBlock.content,
                        isError: resultBlock.isError,
                        timestamp: parseTimestamp(message.timestamp)
                    )
                }
            }
        }
        // 从 message.content 提取
        if let msg = message.message, case .array(let items) = msg.content {
            for item in items {
                if case .object(let dict) = item,
                   case .string(let type) = dict["type"], type == "tool_result" {
                    let content: String
                    if case .string(let str) = dict["content"] {
                        content = str
                    } else {
                        content = ""
                    }
                    let isError = dict["is_error"].flatMap { val -> Bool? in
                        if case .bool(let b) = val { return b }
                        return nil
                    } ?? false
                    return ToolExecution.ToolResult(
                        content: content, isError: isError,
                        timestamp: parseTimestamp(message.timestamp)
                    )
                }
            }
        }
        // fallback: message.content 作为纯文本
        return ToolExecution.ToolResult(
            content: message.content,
            isError: false,
            timestamp: parseTimestamp(message.timestamp)
        )
    }

    private func findToolNameFromResult(_ message: Message) -> String? {
        if let toolResult = message.toolUseResult,
           case .object(let dict) = toolResult,
           case .string(let name) = dict["toolName"] {
            return name
        }
        return nil
    }

    // MARK: - Helpers

    /// 判断 user 消息是否为斜杠命令输出（/copy, /clear 等）
    /// 这些不是真正的用户输入，不应创建 Turn
    private func looksLikeCommandOutput(_ message: Message) -> Bool {
        if message.isMeta == true { return true }
        // 检查 content 文本是否以命令标记开头
        let text = message.content
        if text.hasPrefix("<local-command") || text.hasPrefix("<command-name>") {
            return true
        }
        return false
    }

    /// 判断 user 消息是否实际上是 tool_result（兼容无 eventType 的历史数据）
    private func looksLikeToolResult(_ message: Message) -> Bool {
        // 显式 eventType
        if message.eventType == "tool_result" { return true }
        // 有 toolUseResult 字段
        if message.toolUseResult != nil { return true }
        // contentBlocks 含 tool_result
        if let blocks = message.contentBlocks {
            for block in blocks {
                if case .toolResult = block { return true }
            }
        }
        // message.content 含 tool_result 类型的 item
        if let msg = message.message, case .array(let items) = msg.content {
            for item in items {
                if case .object(let dict) = item,
                   case .string(let type) = dict["type"], type == "tool_result" {
                    return true
                }
            }
        }
        return false
    }

    private func transformToDisplayMessage(_ message: Message) -> DisplayMessage {
        var displayMsg = DisplayMessage(
            id: message.uuid ?? UUID().uuidString,
            type: .user,
            timestamp: parseTimestamp(message.timestamp)
        )
        // 提取文本内容和图片
        if let msg = message.message {
            if case .string(let text) = msg.content {
                displayMsg.textContent = text
            } else if case .array(let items) = msg.content {
                var texts: [String] = []
                for item in items {
                    if case .object(let dict) = item,
                       case .string(let type) = dict["type"] {
                        if type == "text", case .string(let text) = dict["text"] {
                            texts.append(text)
                        } else if type == "image",
                                  case .object(let source) = dict["source"],
                                  case .string(let mediaType) = source["media_type"],
                                  case .string(let data) = source["data"] {
                            displayMsg.images.append(ImageData(type: "base64", mediaType: mediaType, data: data))
                        }
                    }
                }
                displayMsg.textContent = texts.joined(separator: "\n")
            }
        } else {
            displayMsg.textContent = message.content
        }
        return displayMsg
    }

    func parseTimestamp(_ timestamp: String?) -> Date {
        guard let timestamp = timestamp,
              let date = Self.iso8601Formatter.date(from: timestamp) else {
            return Date()
        }
        return date
    }

    func hasMarkdown(_ text: String) -> Bool {
        text.contains("```") || text.contains("**") || text.contains("##") ||
        text.contains("[") || text.contains("|") || text.contains(">")
    }

    private func inferModel(from message: Message) -> String? {
        // subagent 使用不同模型的提示通常在 agentId 或 content 中
        // 简单启发：agentId 包含 model hint
        return nil
    }

    private func jsonValueToString(_ value: JSONValue) -> String {
        switch value {
        case .string(let str): return str
        case .number(let num): return "\(num)"
        case .bool(let flag): return "\(flag)"
        case .null: return "null"
        case .array, .object:
            if let data = try? JSONEncoder().encode(value),
               let str = String(data: data, encoding: .utf8) {
                return str
            }
            return ""
        }
    }
}
