//
//  TurnCard.swift
//  Vlaude
//
//  Turn 卡片：三段式布局
//  一、用户消息（蓝色色带 + 首行加粗）
//  二、执行过程（紧凑工具行 / 摘要折叠条）
//  三、AI 回复（紫色色带 + Markdown）
//

import SwiftUI
import MarkdownUI

// MARK: - Turn Card

struct TurnCard: View {
    @ObservedObject var turn: Turn
    let sessionId: String
    var turnIndex: Int = 1
    var onApprovalAction: ((String, String) -> Void)? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            // Turn 编号
            Text(String(format: "%02d", turnIndex))
                .font(.system(size: 11, weight: .medium, design: .monospaced))
                .foregroundStyle(.tertiary)
                .padding(.leading, 2)

            // 一、用户消息
            userPromptSection

            // 二、执行过程
            activitySection

            // Subagent 子时间线
            ForEach(turn.subagentTurns) { sub in
                SubagentRow(subagent: sub, sessionId: sessionId)
            }

            // 三、AI 最终回复
            if let finalResponse = turn.finalResponse,
               case .text(let text, _) = finalResponse.content,
               !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                finalResponseSection(text: text)
            }

            // 状态（仅活跃时显示）
            if turn.status != .completed {
                TurnStatusBar(status: turn.status)
            }
        }
    }

    // MARK: - 一、用户消息

    /// 色带透明度：活跃时鲜明，完成后退居幕后
    private var accentOpacity: Double {
        turn.status == .completed ? 0.4 : 1.0
    }

    @ViewBuilder
    private var userPromptSection: some View {
        HStack(alignment: .top, spacing: 0) {
            // 蓝色色带
            RoundedRectangle(cornerRadius: 1.5)
                .fill(Color.blue.opacity(accentOpacity))
                .frame(width: 3)
                .padding(.vertical, 2)

            VStack(alignment: .leading, spacing: 4) {
                let lines = splitUserText()
                if let firstLine = lines.first {
                    Text(firstLine)
                        .font(.system(size: 16, weight: .semibold))
                        .tracking(-0.3)
                        .foregroundColor(.primary)
                }
                if lines.count > 1 {
                    Text(lines.dropFirst().joined(separator: "\n"))
                        .font(.system(size: 14))
                        .foregroundColor(.secondary)
                }
            }
            .padding(.leading, 10)
        }
    }

    private func splitUserText() -> [String] {
        let text = turn.userMessage.textContent ?? ""
        guard !text.isEmpty else { return [""] }
        let lines = text.components(separatedBy: .newlines).filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
        guard !lines.isEmpty else { return [text] }
        return lines
    }

    // MARK: - 二、执行过程

    @ViewBuilder
    private var activitySection: some View {
        let activity = turn.activityEvents
        if !activity.isEmpty {
            if turn.status == .completed {
                // 已完成：摘要折叠条
                ExecutionSummaryBar(
                    turn: turn,
                    sessionId: sessionId,
                    onApprovalAction: onApprovalAction
                )
            } else {
                // 活跃中：实时工具列表
                activeToolList(events: activity)
            }
        }
    }

    @ViewBuilder
    private func activeToolList(events: [TurnEvent]) -> some View {
        let visibleCount = 3
        let overflow = events.count > 5

        VStack(spacing: 2) {
            if overflow {
                // 超过 5 个：显示折叠提示 + 最近 3 个
                HStack(spacing: 6) {
                    Image(systemName: "ellipsis.circle")
                        .font(.system(size: 11))
                        .foregroundStyle(.tertiary)
                    Text("还有 \(events.count - visibleCount) 个工具调用")
                        .font(.system(size: 12))
                        .foregroundStyle(.tertiary)
                    Spacer()
                }
                .padding(.vertical, 4)
                .padding(.horizontal, 8)

                ForEach(events.suffix(visibleCount)) { event in
                    activeEventRow(event)
                }
            } else {
                ForEach(events) { event in
                    activeEventRow(event)
                }
            }
        }
    }

    @ViewBuilder
    private func activeEventRow(_ event: TurnEvent) -> some View {
        switch event.content {
        case .toolUse(let execution):
            CompactToolRow(
                execution: execution,
                sessionId: sessionId,
                isActive: turn.status != .completed,
                onApprovalAction: onApprovalAction
            )
        case .thinking(let text):
            ThinkingEventView(text: text)
        case .text(let text, _):
            if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Text(text)
                    .font(.system(size: 13))
                    .foregroundColor(.secondary)
                    .padding(.vertical, 4)
                    .padding(.horizontal, 8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(
                        RoundedRectangle(cornerRadius: 4)
                            .fill(Color(uiColor: .systemGray6).opacity(0.3))
                    )
            }
        case .toolResult:
            EmptyView()
        }
    }

    // MARK: - 三、AI 回复

    @ViewBuilder
    private func finalResponseSection(text: String) -> some View {
        HStack(alignment: .top, spacing: 0) {
            // 紫色色带
            RoundedRectangle(cornerRadius: 1.5)
                .fill(Color.purple.opacity(accentOpacity))
                .frame(width: 3)
                .padding(.vertical, 2)

            Markdown(text)
                .markdownTheme(.claudeCode)
                .markdownCodeSyntaxHighlighter(HighlightrCodeSyntaxHighlighter())
                .textSelection(.enabled)
                .padding(.leading, 10)
        }
    }
}
