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
    // 全部去掉 @Published，用 didSet + isBatching 手动控制 objectWillChange
    var status: TurnStatus = .active {
        didSet { if !isBatching { objectWillChange.send() } }
    }
    var subagentTurns: [SubagentTurn] = [] {
        didSet { if !isBatching { objectWillChange.send() } }
    }
    var isExpanded: Bool = false {              // 用户交互触发，始终通知
        didSet { objectWillChange.send() }
    }
    var hasCompactionBefore: Bool = false       // 此 Turn 前有上下文压缩

    // events + eventVersion 都不用 @Published，手动控制 objectWillChange
    private(set) var events: [TurnEvent] = []
    private(set) var eventVersion: Int = 0

    // 批处理抑制：TurnBuilder 批量处理时设为 true，结束后统一通知
    var isBatching = false

    // 缓存：按 eventVersion 失效
    private var cachedSegments: [CollapsedSegment]?
    private var cachedStatistics: TurnStatistics?
    private var cacheVersion: Int = -1

    init(id: String, userMessage: DisplayMessage) {
        self.id = id
        self.userMessage = userMessage
    }

    /// 批量追加事件
    func appendEvents(_ newEvents: [TurnEvent]) {
        events.append(contentsOf: newEvents)
        invalidateCache()
        eventVersion += 1
        if !isBatching { objectWillChange.send() }
    }

    /// 追加单个事件
    func appendEvent(_ event: TurnEvent) {
        events.append(event)
        invalidateCache()
        eventVersion += 1
        if !isBatching { objectWillChange.send() }
    }

    /// 替换指定位置的事件（用于 tool result 合并、approval 更新等）
    func replaceEvent(at index: Int, with event: TurnEvent) {
        guard index >= 0 && index < events.count else { return }
        events[index] = event
        invalidateCache()
        eventVersion += 1
        if !isBatching { objectWillChange.send() }
    }

    /// 结束批处理，发送一次 objectWillChange
    func endBatch() {
        isBatching = false
        objectWillChange.send()
    }

    private func invalidateCache() {
        cachedSegments = nil
        cachedStatistics = nil
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
    var isExpanded: Bool = false {             // 用户交互触发，始终通知
        didSet { objectWillChange.send() }
    }
    var summary: String?        // 子代理最终回复摘要

    // events + eventVersion 不用 @Published，手动控制 objectWillChange
    private(set) var events: [TurnEvent] = []
    private(set) var eventVersion: Int = 0
    var isBatching = false

    init(id: String, agentModel: String? = nil) {
        self.id = id
        self.agentModel = agentModel
    }

    /// 追加事件
    func appendEvent(_ event: TurnEvent) {
        events.append(event)
        eventVersion += 1
        if !isBatching { objectWillChange.send() }
    }

    func appendEvents(_ newEvents: [TurnEvent]) {
        events.append(contentsOf: newEvents)
        eventVersion += 1
        if !isBatching { objectWillChange.send() }
    }

    /// 替换指定位置的事件
    func replaceEvent(at index: Int, with event: TurnEvent) {
        guard index >= 0 && index < events.count else { return }
        events[index] = event
        eventVersion += 1
        if !isBatching { objectWillChange.send() }
    }

    func endBatch() {
        isBatching = false
        objectWillChange.send()
    }
}

// MARK: - CollapsedSegment

/// 折叠态段落：text 事件和内联指示器交替排列
enum CollapsedSegment: Identifiable {
    case text(event: TurnEvent)
    case indicator(id: String, toolCount: Int, thinkingCount: Int)

    var id: String {
        switch self {
        case .text(let event): return "seg-\(event.id)"
        case .indicator(let id, _, _): return id
        }
    }
}

// MARK: - TurnStatistics

/// Turn 统计信息
struct TurnStatistics {
    let toolCountsByType: [String: Int]
    let totalToolCount: Int
    let thinkingCount: Int
    let duration: TimeInterval?
}

// MARK: - Turn Computed Properties

extension Turn {
    /// 提取所有 ToolExecution
    var toolExecutions: [ToolExecution] {
        events.compactMap { event in
            if case .toolUse(let execution) = event.content { return execution }
            return nil
        }
    }

    /// 折叠态段落（带缓存，按 eventVersion 失效）
    var collapsedSegments: [CollapsedSegment] {
        if let cached = cachedSegments, cacheVersion == eventVersion {
            return cached
        }
        let result = computeCollapsedSegments()
        cachedSegments = result
        cacheVersion = eventVersion
        return result
    }

    private func computeCollapsedSegments() -> [CollapsedSegment] {
        var segments: [CollapsedSegment] = []
        var pendingToolCount = 0
        var pendingThinkingCount = 0
        var gapIndex = 0

        func flushGap() {
            if pendingToolCount > 0 || pendingThinkingCount > 0 {
                segments.append(.indicator(
                    id: "gap-\(id)-\(gapIndex)",
                    toolCount: pendingToolCount,
                    thinkingCount: pendingThinkingCount
                ))
                gapIndex += 1
                pendingToolCount = 0
                pendingThinkingCount = 0
            }
        }

        for event in events {
            switch event.eventType {
            case .text:
                flushGap()
                segments.append(.text(event: event))
            case .toolUse:
                pendingToolCount += 1
            case .thinking:
                pendingThinkingCount += 1
            case .toolResult:
                break // 已合并到 toolUse，不计数
            }
        }
        flushGap() // 末尾残余

        return segments
    }

    /// Turn 统计信息（带缓存）
    var statistics: TurnStatistics {
        if let cached = cachedStatistics, cacheVersion == eventVersion {
            return cached
        }
        let result = computeStatistics()
        cachedStatistics = result
        // Note: cacheVersion is updated by collapsedSegments,
        // but if statistics is called first, we need to ensure it's set
        if cacheVersion != eventVersion {
            cacheVersion = eventVersion
        }
        return result
    }

    private func computeStatistics() -> TurnStatistics {
        var toolCounts: [String: Int] = [:]
        var thinkingCount = 0

        for event in events {
            switch event.eventType {
            case .toolUse:
                if case .toolUse(let exec) = event.content {
                    toolCounts[exec.name, default: 0] += 1
                }
            case .thinking:
                thinkingCount += 1
            default:
                break
            }
        }

        let totalTools = toolCounts.values.reduce(0, +)

        // 耗时：首条事件到末条事件
        var duration: TimeInterval? = nil
        if let first = events.first, let last = events.last, events.count > 1 {
            let diff = last.timestamp.timeIntervalSince(first.timestamp)
            if diff > 0 { duration = diff }
        }

        return TurnStatistics(
            toolCountsByType: toolCounts,
            totalToolCount: totalTools,
            thinkingCount: thinkingCount,
            duration: duration
        )
    }
}
