//
//  ExecutionSummaryBar.swift
//  Vlaude
//
//  已完成 Turn 的执行摘要折叠条
//  默认折叠为一行语义化摘要，点击展开完整工具列表
//

import SwiftUI

struct ExecutionSummaryBar: View {
    @ObservedObject var turn: Turn
    let sessionId: String
    var onApprovalAction: ((String, String) -> Void)? = nil
    @State private var isExpanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // 折叠摘要条
            Button(action: { withAnimation(.easeInOut(duration: 0.2)) { isExpanded.toggle() } }) {
                HStack(spacing: 6) {
                    // 语义化图标
                    Image(systemName: turn.summaryIcon)
                        .font(.system(size: 11))
                        .foregroundColor(summaryColor)

                    // 摘要内容
                    summaryContent

                    Spacer()

                    Text("\(turn.toolExecutions.count)")
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(.tertiary)

                    Image(systemName: "chevron.right")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(.tertiary)
                        .rotationEffect(.degrees(isExpanded ? 90 : 0))
                }
                .padding(.vertical, 8)
                .padding(.horizontal, 10)
            }
            .buttonStyle(.plain)

            // 展开的完整工具列表
            if isExpanded {
                VStack(spacing: 2) {
                    ForEach(turn.activityEvents) { event in
                        switch event.content {
                        case .toolUse(let execution):
                            CompactToolRow(
                                execution: execution,
                                sessionId: sessionId,
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
                            }
                        case .toolResult:
                            EmptyView()
                        }
                    }
                }
                .padding(.horizontal, 4)
                .padding(.bottom, 6)
            }
        }
        .background(
            RoundedRectangle(cornerRadius: 8)
                .fill(Color(uiColor: .systemGray6).opacity(0.3))
        )
    }

    // MARK: - 摘要内容（带胶囊文件名）

    @ViewBuilder
    private var summaryContent: some View {
        let info = turn.executionSummaryInfo

        if let fallback = info.fallbackText {
            Text(fallback)
                .font(.system(size: 13))
                .foregroundColor(.secondary)
        } else {
            // "Edited" + 胶囊文件名 + "+N files" + ✓/⚠️
            HStack(spacing: 4) {
                Text(info.verb)
                    .font(.system(size: 13))
                    .foregroundColor(.secondary)

                ForEach(info.fileNames, id: \.self) { name in
                    Text(name)
                        .font(.system(size: 12, design: .monospaced))
                        .foregroundColor(.primary)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(
                            Capsule()
                                .fill(Color(uiColor: .systemGray5).opacity(0.6))
                        )
                }

                if info.extraCount > 0 {
                    Text("+\(info.extraCount)")
                        .font(.system(size: 12))
                        .foregroundColor(.secondary)
                }

                Text(info.hasError ? "⚠️" : "✓")
                    .font(.system(size: 12))
                    .foregroundColor(info.hasError ? .red : .green)
            }
        }
    }

    // MARK: - 图标颜色

    private var summaryColor: Color {
        switch turn.summaryIconColor {
        case "blue": return .blue
        case "purple": return .purple
        case "orange": return .orange
        case "cyan": return .cyan
        case "indigo": return .indigo
        default: return .orange
        }
    }
}
