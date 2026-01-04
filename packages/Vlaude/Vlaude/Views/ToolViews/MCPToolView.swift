//
//  MCPToolView.swift
//  Vlaude
//
//  MCP 工具专用视图 - 统一样式
//

import SwiftUI

/// MCP 工具视图 - 统一样式
struct MCPToolView: View {
    let execution: ToolExecution
    @State private var isExpanded = false

    // 解析 MCP 工具名: mcp__{server}__{tool}
    private var serverName: String {
        // 用 "__" 分割，支持 server/tool 名中包含下划线
        let parts = execution.name.components(separatedBy: "__")
        // mcp__server__tool -> ["mcp", "server", "tool"]
        if parts.count >= 2 {
            return parts[1]
        }
        return "mcp"
    }

    private var toolName: String {
        let parts = execution.name.components(separatedBy: "__")
        if parts.count >= 3 {
            return parts[2]
        }
        return execution.name
    }

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
        return execution.input.map { "\($0.key): \($0.value)" }.joined(separator: "\n")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // MCP 头
            HStack(spacing: 8) {
                Image(systemName: "puzzlepiece.extension")
                    .font(.system(size: 12))
                    .foregroundColor(.teal)

                Text(serverName)
                    .font(.system(size: 11))
                    .foregroundColor(.secondary)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(Color.teal.opacity(0.2))
                    .cornerRadius(4)

                Text(toolName)
                    .font(.system(size: 13, design: .monospaced))
                    .fontWeight(.medium)

                Spacer()
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(Color.teal.opacity(0.1))

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
                .stroke(isError ? Color.red.opacity(0.3) : Color.teal.opacity(0.2), lineWidth: 1)
        )
    }
}
