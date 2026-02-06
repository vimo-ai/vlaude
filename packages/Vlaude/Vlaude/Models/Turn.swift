//
//  Turn.swift
//  Vlaude
//
//  Turn 模型：一个 Turn = 用户提问 → Claude 回复完成
//  支持实时事件流 + Turn 分组渲染为 Timeline
//

import Foundation
import SwiftUI
import Combine

// MARK: - Turn

/// 一个 Turn = 用户提问 → Claude 回复完成（stopReason=end_turn）
class Turn: ObservableObject, Identifiable {
    let id: String                             // 用户消息 UUID
    let userMessage: DisplayMessage
    @Published var events: [TurnEvent] = []
    @Published var status: TurnStatus = .active
    @Published var subagentTurns: [SubagentTurn] = []

    init(id: String, userMessage: DisplayMessage) {
        self.id = id
        self.userMessage = userMessage
    }
}

// MARK: - TurnStatus

enum TurnStatus: Equatable {
    case active              // Claude 正在工作
    case waitingTool         // stopReason=tool_use，等待工具返回
    case completed           // stopReason=end_turn
    case interrupted         // 用户中断
}

// MARK: - TurnEvent

/// Turn 内的单个事件节点
struct TurnEvent: Identifiable {
    let id: String                  // message UUID
    let eventType: EventType
    let timestamp: Date
    let content: TurnEventContent
    let isFinal: Bool               // stopReason=end_turn 的那条

    enum EventType: String, Codable {
        case thinking
        case text
        case toolUse = "tool_use"
        case toolResult = "tool_result"
    }
}

// MARK: - TurnEventContent

/// 事件内容（不同类型携带不同数据）
enum TurnEventContent {
    case thinking(text: String)
    case text(text: String, isMarkdown: Bool)
    case toolUse(execution: ToolExecution)
    case toolResult(result: ToolExecution.ToolResult, toolName: String?)
}

// MARK: - SubagentTurn

/// Subagent 子时间线
class SubagentTurn: ObservableObject, Identifiable {
    let id: String              // agentId
    let agentModel: String?     // sonnet/haiku
    @Published var events: [TurnEvent] = []
    @Published var isExpanded: Bool = false  // 默认折叠
    var summary: String?        // 子代理最终回复摘要

    init(id: String, agentModel: String? = nil) {
        self.id = id
        self.agentModel = agentModel
    }
}

// MARK: - Turn Computed Properties

extension Turn {
    /// 活动事件（thinking + 工具 + 中间文本），不含 final text 和 toolResult
    var activityEvents: [TurnEvent] {
        events.filter { event in
            if event.isFinal && event.eventType == .text { return false }
            if event.eventType == .toolResult { return false }
            return true
        }
    }

    /// 最终 AI 回复（isFinal 的 text 事件，或 turn 完成后的最后一条 text）
    var finalResponse: TurnEvent? {
        if let final = events.last(where: { $0.eventType == .text && $0.isFinal }) {
            return final
        }
        if status == .completed {
            return events.last(where: { $0.eventType == .text })
        }
        return nil
    }

    /// 提取所有 ToolExecution
    var toolExecutions: [ToolExecution] {
        events.compactMap { event in
            if case .toolUse(let execution) = event.content { return execution }
            return nil
        }
    }

    /// 摘要条图标：基于主要操作类型
    var summaryIcon: String {
        let tools = toolExecutions
        guard !tools.isEmpty else { return "checkmark.circle" }

        // 按出现次数找主要操作
        var counts: [String: Int] = [:]
        for tool in tools { counts[tool.name, default: 0] += 1 }
        let dominant = counts.max(by: { $0.value < $1.value })?.key ?? ""

        switch dominant {
        case "Edit", "Write": return "pencil"
        case "Read": return "doc.text"
        case "Bash": return "terminal"
        case "Grep", "Glob": return "magnifyingglass"
        case "WebSearch", "WebFetch": return "globe"
        case "Task": return "list.bullet"
        default: return "bolt.fill"
        }
    }

    /// 摘要条图标颜色
    var summaryIconColor: String {
        let tools = toolExecutions
        var counts: [String: Int] = [:]
        for tool in tools { counts[tool.name, default: 0] += 1 }
        let dominant = counts.max(by: { $0.value < $1.value })?.key ?? ""

        switch dominant {
        case "Edit", "Write": return "blue"
        case "Bash": return "purple"
        case "Grep", "Glob": return "orange"
        case "WebSearch", "WebFetch": return "cyan"
        case "Task": return "indigo"
        default: return "orange"
        }
    }

    /// 语义化执行摘要（结构化：动词 + 文件名列表 + 状态）
    struct ExecutionSummaryInfo {
        let verb: String           // "Edited" / "Searched" / ...
        let fileNames: [String]    // 胶囊显示的文件名
        let extraCount: Int        // "+N files"
        let hasError: Bool
        let fallbackText: String?  // 无文件时的纯文本摘要
    }

    var executionSummaryInfo: ExecutionSummaryInfo {
        let tools = toolExecutions
        guard !tools.isEmpty else {
            return ExecutionSummaryInfo(verb: "", fileNames: [], extraCount: 0, hasError: false, fallbackText: "已完成")
        }

        let hasError = tools.contains { $0.result?.isError == true }

        let editedFiles = tools.compactMap { tool -> String? in
            guard tool.name == "Edit" || tool.name == "Write" else { return nil }
            guard let path = tool.input["file_path"] else { return nil }
            return (path as NSString).lastPathComponent
        }

        if !editedFiles.isEmpty {
            let display = Array(editedFiles.prefix(2))
            let extra = editedFiles.count > 2 ? editedFiles.count - 2 : 0
            return ExecutionSummaryInfo(verb: "Edited", fileNames: display, extraCount: extra, hasError: hasError, fallbackText: nil)
        }

        let readFiles = tools.compactMap { tool -> String? in
            guard tool.name == "Read" else { return nil }
            guard let path = tool.input["file_path"] else { return nil }
            return (path as NSString).lastPathComponent
        }
        if !readFiles.isEmpty {
            let display = Array(readFiles.prefix(2))
            let extra = readFiles.count > 2 ? readFiles.count - 2 : 0
            return ExecutionSummaryInfo(verb: "Read", fileNames: display, extraCount: extra, hasError: hasError, fallbackText: nil)
        }

        var counts: [String: Int] = [:]
        for tool in tools { counts[tool.name, default: 0] += 1 }
        let parts = counts.map { "\($0.key) ×\($0.value)" }.joined(separator: "  ")
        return ExecutionSummaryInfo(verb: "", fileNames: [], extraCount: 0, hasError: hasError, fallbackText: "\(tools.count) tools — \(parts)")
    }

    /// 纯文本版摘要（保留兼容）
    var executionSummary: String {
        let info = executionSummaryInfo
        if let fallback = info.fallbackText { return fallback }
        let files = info.fileNames.joined(separator: ", ")
        let extra = info.extraCount > 0 ? " +\(info.extraCount) files" : ""
        let icon = info.hasError ? "⚠️" : "✓"
        return "\(info.verb) \(files)\(extra) \(icon)"
    }
}
