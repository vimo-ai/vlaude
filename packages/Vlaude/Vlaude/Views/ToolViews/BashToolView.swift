//
//  BashToolView.swift
//  Vlaude
//
//  Bash 工具专用视图 - 终端风格显示
//

import SwiftUI

/// Bash 工具视图 - 终端风格
struct BashToolView: View {
    let execution: ToolExecution
    @State private var isExpanded = false

    private var command: String {
        execution.input["command"] ?? ""
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

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // 命令输入行
            HStack(spacing: 6) {
                Image(systemName: "terminal")
                    .font(.system(size: 12))
                    .foregroundColor(.green)

                Text("$")
                    .font(.system(size: 13, design: .monospaced))
                    .foregroundColor(.green)

                Text(command)
                    .font(.system(size: 13, design: .monospaced))
                    .foregroundColor(.white)
                    .lineLimit(isExpanded ? nil : 3)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.black.opacity(0.9))

            // 输出结果
            if execution.result != nil {
                VStack(alignment: .leading, spacing: 4) {
                    Text(displayContent)
                        .font(.system(size: 12, design: .monospaced))
                        .foregroundColor(isError ? .red : .green.opacity(0.9))
                        .textSelection(.enabled)

                    if isResultLong {
                        Button(action: { isExpanded.toggle() }) {
                            Text(isExpanded ? "收起" : "展开全部")
                                .font(.caption)
                                .foregroundColor(.blue)
                        }
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.black.opacity(0.85))
            }
        }
        .cornerRadius(8)
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(isError ? Color.red.opacity(0.5) : Color.green.opacity(0.3), lineWidth: 1)
        )
    }
}
