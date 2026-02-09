//
//  CompactToolRow.swift
//  Vlaude
//
//  紧凑工具行：图标 + 工具名 + 摘要 + 状态，点击展开完整 ToolView
//

import SwiftUI

struct CompactToolRow: View {
    let execution: ToolExecution
    let sessionId: String
    var isActive: Bool = false
    var onApprovalAction: ((String, String) -> Void)? = nil
    @State private var isExpanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // 折叠头：一行摘要
            Button(action: { withAnimation(.easeInOut(duration: 0.2)) { isExpanded.toggle() } }) {
                HStack(spacing: 8) {
                    Image(systemName: iconName)
                        .font(.system(size: 11))
                        .foregroundColor(toolColor)
                        .frame(width: 16)

                    Text(execution.name)
                        .font(.system(size: 13, design: .monospaced))
                        .foregroundColor(.primary)

                    Text(compactSummary)
                        .font(.system(size: 12))
                        .foregroundColor(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)

                    Spacer()

                    statusIndicator

                    Image(systemName: "chevron.right")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(.tertiary)
                        .rotationEffect(.degrees(isExpanded ? 90 : 0))
                }
                .padding(.vertical, 6)
                .padding(.horizontal, 8)
            }
            .buttonStyle(.plain)

            // 展开：完整 ToolView
            if isExpanded {
                ToolExecutionBubble(
                    execution: execution,
                    sessionId: sessionId,
                    onApprovalAction: onApprovalAction
                )
                .padding(.top, 4)
                .padding(.horizontal, 4)
            }
        }
        .background(
            RoundedRectangle(cornerRadius: 6)
                .fill(Color(uiColor: .systemGray6).opacity(0.5))
        )
    }

    // MARK: - 状态指示

    @ViewBuilder
    private var statusIndicator: some View {
        if execution.approvalStatus == .timeout && execution.result == nil {
            // 中断的工具调用（无 tool_result）
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 11))
                .foregroundColor(.orange)
        } else if isActive && execution.result == nil {
            ProgressView()
                .scaleEffect(0.5)
                .frame(width: 14, height: 14)
        } else if execution.result?.isError == true {
            Image(systemName: "xmark.circle.fill")
                .font(.system(size: 11))
                .foregroundColor(.red)
        } else if execution.result != nil {
            Image(systemName: "checkmark")
                .font(.system(size: 10, weight: .medium))
                .foregroundColor(.green)
        }
    }

    // MARK: - 紧凑摘要

    private var compactSummary: String {
        // 优先从 input 提取（实时推送有完整 input）
        switch execution.name {
        case "Read", "Edit", "Write":
            if let path = execution.input["file_path"] {
                return (path as NSString).lastPathComponent
            }
        case "Bash":
            if let cmd = execution.input["command"] {
                let firstLine = cmd.components(separatedBy: .newlines).first ?? cmd
                return String(firstLine.prefix(40))
            }
        case "Grep", "Glob":
            if let pattern = execution.input["pattern"] {
                return pattern
            }
        case "WebSearch":
            if let query = execution.input["query"] {
                return query
            }
        case "WebFetch":
            if let url = execution.input["url"] {
                return url
            }
        case "Task":
            if let desc = execution.input["description"] {
                return desc
            }
        default:
            break
        }
        // Fallback: 使用 Rust 端生成的 displayText（summary 模式下 input 被裁剪时）
        if let displayText = execution.displayText, !displayText.isEmpty {
            return displayText
        }
        let formatted = execution.formattedInput.components(separatedBy: .newlines).first ?? ""
        return formatted.isEmpty ? "" : formatted
    }

    // MARK: - 图标/颜色

    private var iconName: String {
        switch execution.name {
        case "Edit": return "pencil"
        case "Write": return "square.and.pencil"
        case "Read": return "doc.text"
        case "Bash": return "terminal"
        case "Grep": return "magnifyingglass"
        case "Glob": return "folder.badge.magnifyingglass" // iOS 17+
        case "Task": return "list.bullet"
        case "TaskOutput": return "text.badge.checkmark"
        case "WebFetch": return "globe"
        case "WebSearch": return "magnifyingglass.circle"
        case "TodoWrite": return "checklist"
        case "AskUserQuestion": return "questionmark.circle"
        case "KillShell": return "xmark.circle"
        default: return "wrench"
        }
    }

    private var toolColor: Color {
        switch execution.name {
        case "Edit", "Write": return .blue
        case "Read": return .teal
        case "Bash": return .purple
        case "Grep", "Glob": return .orange
        case "Task", "TaskOutput": return .indigo
        case "WebFetch", "WebSearch": return .cyan
        case "TodoWrite": return .green
        case "AskUserQuestion": return .yellow
        case "KillShell": return .red
        default: return .gray
        }
    }
}
