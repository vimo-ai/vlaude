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

    // MCP 工具名解析
    private var isMCP: Bool { execution.name.hasPrefix("mcp__") }
    private var mcpParts: (server: String, tool: String) {
        let parts = execution.name.components(separatedBy: "__")
        guard parts.count >= 3 else {
            return (parts.count >= 2 ? parts[1] : "mcp", execution.name)
        }
        let server = parts[1]
        // mcp__server__tool → 直接取 tool
        // mcp__mcp-router__subserver__tool → 取最后一段 tool（sub-server 冗余）
        let toolPart = parts.last ?? parts[2]
        return (server, toolPart)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // 折叠头：一行摘要
            Button(action: { withAnimation(.easeInOut(duration: 0.2)) { isExpanded.toggle() } }) {
                HStack(spacing: 8) {
                    Image(systemName: iconName)
                        .font(.system(size: 11))
                        .foregroundColor(toolColor)
                        .frame(width: 16)

                    if isMCP {
                        // MCP: server 标签 + tool 名
                        Text(mcpParts.server)
                            .font(.system(size: 10))
                            .foregroundColor(.teal)
                            .padding(.horizontal, 4)
                            .padding(.vertical, 1)
                            .background(Color.teal.opacity(0.12))
                            .cornerRadius(3)

                        Text(mcpParts.tool)
                            .font(.system(size: 13, design: .monospaced))
                            .foregroundColor(.primary)
                    } else {
                        Text(execution.name)
                            .font(.system(size: 13, design: .monospaced))
                            .foregroundColor(.primary)
                    }

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

            // 审批按钮直接展示（不需要展开详情）
            if execution.approvalStatus == .awaitingPermission, let handler = onApprovalAction {
                ApprovalButtonsView(
                    status: .awaitingPermission,
                    onApprove: { action in handler(execution.id, action) }
                )
                .padding(.horizontal, 8)
                .padding(.bottom, 6)
            }

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
        if execution.approvalStatus == .awaitingPermission {
            ApprovalStatusBadge(status: .awaitingPermission)
        } else if execution.approvalStatus == .timeout && execution.result == nil {
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
            // MCP 工具：提取最有意义的参数作为摘要
            if isMCP {
                return mcpCompactSummary
            }
        }
        // Fallback: 使用 Rust 端生成的 displayText（summary 模式下 input 被裁剪时）
        if let displayText = execution.displayText, !displayText.isEmpty {
            return displayText
        }
        let formatted = execution.formattedInput.components(separatedBy: .newlines).first ?? ""
        return formatted.isEmpty ? "" : formatted
    }

    /// MCP 工具摘要：从 input 里挑最有意义的字段
    private var mcpCompactSummary: String {
        let input = execution.input
        // 常见有意义的参数名，按优先级排列
        let meaningfulKeys = ["query", "url", "command", "text", "path", "file_path",
                              "pattern", "description", "prompt", "action", "skill"]
        for key in meaningfulKeys {
            if let value = input[key], !value.isEmpty {
                let firstLine = value.components(separatedBy: .newlines).first ?? value
                return String(firstLine.prefix(50))
            }
        }
        // fallback: 取第一个非 tabId 参数
        if let first = input.first(where: { $0.key != "tabId" && $0.key != "ref_id" }) {
            let val = String(first.value.prefix(40))
            return "\(first.key): \(val)"
        }
        return ""
    }

    // MARK: - 图标/颜色

    private var iconName: String {
        if isMCP { return "puzzlepiece.extension" }
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
        if isMCP { return .teal }
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
