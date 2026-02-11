//
//  TurnCard.swift
//  Vlaude
//
//  Turn 卡片 V2：折叠/展开双模式
//  折叠态 — AI text 全部可见 + 工具/thinking 折叠为内联指示器
//  展开态 — 所有事件按时间顺序完整展示
//  底部统计栏始终可见
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
            // Turn 编号 + 折叠/展开切换
            turnHeader

            // 用户消息
            userPromptSection

            // 事件区域
            if turn.isExpanded {
                expandedEventsView
            } else {
                collapsedEventsView
            }

            // Subagent 子时间线
            ForEach(turn.subagentTurns) { sub in
                SubagentRow(subagent: sub, sessionId: sessionId)
            }

            // 统计栏
            let stats = turn.statistics
            if stats.totalToolCount > 0 || stats.thinkingCount > 0 {
                turnStatsBar(stats)
            }

            // 活跃状态指示
            if turn.status == .active || turn.status == .waitingTool {
                TurnStatusBar(status: turn.status)
            }
        }
    }

    // MARK: - Turn Header

    @ViewBuilder
    private var turnHeader: some View {
        HStack {
            Text(String(format: "%02d", turnIndex))
                .font(.system(size: 11, weight: .medium, design: .monospaced))
                .foregroundStyle(.tertiary)

            Spacer()

            // 折叠/展开按钮（仅当有非 text 事件时显示）
            let stats = turn.statistics
            if stats.totalToolCount > 0 || stats.thinkingCount > 0 {
                Button(action: {
                    withAnimation(.easeInOut(duration: 0.2)) {
                        turn.isExpanded.toggle()
                    }
                }) {
                    HStack(spacing: 4) {
                        Image(systemName: turn.isExpanded ? "rectangle.compress.vertical" : "rectangle.expand.vertical")
                            .font(.system(size: 10))
                        Text(turn.isExpanded ? "折叠" : "展开")
                            .font(.system(size: 11))
                    }
                    .foregroundStyle(.tertiary)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.leading, 2)
    }

    // MARK: - 用户消息

    @ViewBuilder
    private var userPromptSection: some View {
        HStack(alignment: .top, spacing: 0) {
            // 蓝色色带
            RoundedRectangle(cornerRadius: 1.5)
                .fill(Color.blue)
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

                // 用户粘贴的图片
                if !turn.userMessage.images.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(turn.userMessage.images) { img in
                                if let uiImage = Self.cachedImage(for: img) {
                                    Image(uiImage: uiImage)
                                        .resizable()
                                        .aspectRatio(contentMode: .fit)
                                        .frame(maxHeight: 200)
                                        .clipShape(RoundedRectangle(cornerRadius: 8))
                                }
                            }
                        }
                    }
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

    // MARK: - 折叠态：text 全部可见 + 内联指示器

    @ViewBuilder
    private var collapsedEventsView: some View {
        let segments = turn.collapsedSegments
        if !segments.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(segments) { segment in
                    switch segment {
                    case .text(let event):
                        textEventView(event)
                    case .indicator(_, let tools, let thinkings):
                        inlineCollapsedIndicator(tools: tools, thinkings: thinkings)
                    }
                }
            }
        }
    }

    // MARK: - 展开态：所有事件按时间顺序

    @ViewBuilder
    private var expandedEventsView: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(turn.events) { event in
                switch event.eventType {
                case .text:
                    textEventView(event)
                case .toolUse:
                    if case .toolUse(let execution) = event.content {
                        CompactToolRow(
                            execution: execution,
                            sessionId: sessionId,
                            isActive: turn.status != .completed,
                            onApprovalAction: onApprovalAction
                        )
                    }
                case .thinking:
                    if case .thinking(let text) = event.content {
                        ThinkingEventView(text: text)
                    }
                case .toolResult:
                    EmptyView()
                }
            }
        }
    }

    // MARK: - Text 事件渲染（折叠/展开态共用）

    @ViewBuilder
    private func textEventView(_ event: TurnEvent) -> some View {
        if case .text(let text, _) = event.content,
           !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            MarkdownEventView(id: event.id, text: text)
                .equatable()
        }
    }

    // MARK: - 内联折叠指示器

    @ViewBuilder
    private func inlineCollapsedIndicator(tools: Int, thinkings: Int) -> some View {
        Button(action: {
            withAnimation(.easeInOut(duration: 0.2)) {
                turn.isExpanded = true
            }
        }) {
            HStack(spacing: 6) {
                Image(systemName: "wrench.and.screwdriver")
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)

                // 构建描述文本
                let parts = buildIndicatorParts(tools: tools, thinkings: thinkings)
                Text(parts)
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)

                Spacer()

                Image(systemName: "chevron.right")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(.tertiary)
            }
            .padding(.vertical, 6)
            .padding(.horizontal, 10)
            .background(
                RoundedRectangle(cornerRadius: 6)
                    .fill(Color(uiColor: .systemGray6).opacity(0.5))
            )
        }
        .buttonStyle(.plain)
    }

    private func buildIndicatorParts(tools: Int, thinkings: Int) -> String {
        var parts: [String] = []
        if tools > 0 {
            parts.append("\(tools) tool\(tools > 1 ? "s" : "")")
        }
        if thinkings > 0 {
            parts.append("\(thinkings) thinking")
        }
        return parts.joined(separator: " \u{00B7} ")
    }

    // MARK: - 统计栏

    @ViewBuilder
    private func turnStatsBar(_ stats: TurnStatistics) -> some View {
        VStack(spacing: 6) {
            // 细分隔线
            Rectangle()
                .fill(Color(uiColor: .separator).opacity(0.3))
                .frame(height: 0.5)

            HStack(spacing: 0) {
                Text(buildStatsText(stats))
                    .font(.system(size: 11))
                    .foregroundStyle(.tertiary)

                Spacer()

                // Turn 耗时
                if let duration = stats.duration {
                    Text(formatDuration(duration))
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(.tertiary)
                }
            }
        }
    }

    private func buildStatsText(_ stats: TurnStatistics) -> String {
        var parts: [String] = []

        // 按工具类型细分
        let sortedTools = stats.toolCountsByType.sorted { $0.value > $1.value }
        for (name, count) in sortedTools {
            let label = name.lowercased()
            parts.append("\(count) \(label)")
        }

        if stats.thinkingCount > 0 {
            parts.append("\(stats.thinkingCount) thinking")
        }

        return parts.joined(separator: " \u{00B7} ")
    }

    private func formatDuration(_ seconds: TimeInterval) -> String {
        if seconds < 60 {
            return String(format: "%.0fs", seconds)
        }
        let minutes = Int(seconds) / 60
        let secs = Int(seconds) % 60
        return "\(minutes)m \(secs)s"
    }

    // MARK: - Pending Approval Card

    @ViewBuilder
    private func pendingApprovalCard(execution: ToolExecution) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "exclamationmark.shield.fill")
                    .foregroundColor(.orange)
                    .font(.system(size: 14))

                Text("需要权限")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundColor(.orange)
            }

            // 工具信息
            HStack(spacing: 6) {
                Text(execution.name)
                    .font(.system(size: 13, design: .monospaced))
                    .foregroundColor(.primary)

                Text(execution.formattedInput.components(separatedBy: .newlines).first ?? "")
                    .font(.system(size: 12))
                    .foregroundColor(.secondary)
                    .lineLimit(2)
            }

            // 审批按钮
            if let handler = onApprovalAction {
                ApprovalButtonsView(
                    status: .awaitingPermission,
                    onApprove: { action in handler(execution.id, action) }
                )
            }
        }
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: 8)
                .fill(Color.orange.opacity(0.08))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(Color.orange.opacity(0.3), lineWidth: 1)
        )
    }

    // MARK: - Image Cache

    private static let imageCache = NSCache<NSString, UIImage>()

    private static func cachedImage(for img: ImageData) -> UIImage? {
        let key = NSString(string: img.id.uuidString)
        if let cached = imageCache.object(forKey: key) {
            return cached
        }
        guard let data = Data(base64Encoded: img.data),
              let image = UIImage(data: data) else {
            return nil
        }
        imageCache.setObject(image, forKey: key)
        return image
    }
}
