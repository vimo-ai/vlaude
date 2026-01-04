//
//  GenericToolView.swift
//  Vlaude
//
//  通用工具视图 - Fallback
//

import SwiftUI

/// 通用工具视图 - 用于未特殊处理的工具
struct GenericToolView: View {
    let execution: ToolExecution
    @State private var isExpanded = false

    private var resultContent: String {
        execution.result?.content ?? ""
    }

    private var isResultLong: Bool {
        resultContent.count > 500
    }

    private var displayContent: String {
        if isExpanded || !isResultLong {
            return resultContent
        }
        return String(resultContent.prefix(500)) + "..."
    }

    private var isError: Bool {
        execution.result?.isError ?? false
    }

    // 格式化输入参数
    private var formattedInput: String {
        if execution.input.isEmpty {
            return ""
        }

        // 特殊处理常见工具
        switch execution.name {
        case "Edit":
            if let filePath = execution.input["file_path"] {
                return "编辑文件: \(filePath)"
            }
        case "Write":
            if let filePath = execution.input["file_path"] {
                return "写入文件: \(filePath)"
            }
        case "Task":
            if let description = execution.input["description"] {
                return description
            }
        case "WebFetch":
            if let url = execution.input["url"] {
                return url
            }
        case "WebSearch":
            if let query = execution.input["query"] {
                return "搜索: \(query)"
            }
        default:
            break
        }

        return execution.input.map { "\($0.key): \($0.value)" }.joined(separator: "\n")
    }

    // 获取工具图标
    private var iconName: String {
        switch execution.name {
        case "Edit": return "pencil"
        case "Write": return "square.and.pencil"
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

    // 获取工具颜色
    private var toolColor: Color {
        switch execution.name {
        case "Edit", "Write": return .blue
        case "Task", "TaskOutput": return .indigo
        case "WebFetch", "WebSearch": return .cyan
        case "TodoWrite": return .green
        case "AskUserQuestion": return .yellow
        case "KillShell": return .red
        default: return .gray
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // 工具头
            HStack(spacing: 8) {
                Image(systemName: iconName)
                    .font(.system(size: 12))
                    .foregroundColor(toolColor)

                Text(execution.name)
                    .font(.system(size: 13, design: .monospaced))
                    .fontWeight(.medium)

                Spacer()
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(toolColor.opacity(0.1))

            // 输入参数
            if !formattedInput.isEmpty {
                Text(formattedInput)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundColor(.secondary)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.gray.opacity(0.05))
            }

            // 结果
            if execution.result != nil {
                Divider()

                VStack(alignment: .leading, spacing: 4) {
                    if isError {
                        HStack(spacing: 6) {
                            Image(systemName: "xmark.circle.fill")
                                .foregroundColor(.red)
                            Text("执行失败")
                                .font(.system(size: 11))
                                .foregroundColor(.red)
                        }
                    }

                    Text(displayContent)
                        .font(.system(size: 12, design: .monospaced))
                        .foregroundColor(isError ? .red : .primary)
                        .textSelection(.enabled)

                    if isResultLong {
                        Button(action: { isExpanded.toggle() }) {
                            Text(isExpanded ? "收起" : "展开全部")
                                .font(.caption)
                                .foregroundColor(.blue)
                        }
                    }
                }
                .padding(12)
            }
        }
        .background(Color.gray.opacity(0.05))
        .cornerRadius(8)
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(isError ? Color.red.opacity(0.3) : toolColor.opacity(0.2), lineWidth: 1)
        )
    }
}
