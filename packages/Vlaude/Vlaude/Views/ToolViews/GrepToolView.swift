//
//  GrepToolView.swift
//  Vlaude
//
//  Grep 工具专用视图 - 搜索结果列表
//

import SwiftUI

/// Grep 搜索结果项
struct GrepResultItem: Identifiable {
    // 用 filePath + lineNumber 作为稳定 ID，避免重渲染时生成新 UUID
    var id: String {
        "\(filePath):\(lineNumber ?? 0):\(content.prefix(50))"
    }
    let filePath: String
    let lineNumber: Int?
    let content: String
}

/// Grep 工具视图 - 搜索结果列表
struct GrepToolView: View {
    let execution: ToolExecution
    @State private var isExpanded = false

    private var pattern: String {
        execution.input["pattern"] ?? ""
    }

    private var searchPath: String {
        execution.input["path"] ?? ""
    }

    private var resultContent: String {
        execution.result?.content ?? ""
    }

    private var isError: Bool {
        execution.result?.isError ?? false
    }

    // 解析搜索结果
    private var results: [GrepResultItem] {
        guard !isError else { return [] }

        var items: [GrepResultItem] = []
        let lines = resultContent.components(separatedBy: "\n")

        for line in lines {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty { continue }

            // 尝试解析 "file:line:content" 格式
            let parts = trimmed.split(separator: ":", maxSplits: 2)
            if parts.count >= 2 {
                let filePath = String(parts[0])
                let lineNum = Int(parts[1])
                let content = parts.count > 2 ? String(parts[2]) : ""
                items.append(GrepResultItem(filePath: filePath, lineNumber: lineNum, content: content))
            } else {
                // 纯文件路径
                items.append(GrepResultItem(filePath: trimmed, lineNumber: nil, content: ""))
            }
        }

        return items
    }

    private var displayResults: [GrepResultItem] {
        if isExpanded {
            return results
        }
        return Array(results.prefix(10))
    }

    private var hasMore: Bool {
        results.count > 10
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // 搜索头
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 12))
                    .foregroundColor(.orange)

                Text(pattern)
                    .font(.system(size: 13, design: .monospaced))
                    .fontWeight(.medium)
                    .foregroundColor(.orange)

                Spacer()

                if !results.isEmpty {
                    Text("\(results.count) 个匹配")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(Color.orange.opacity(0.1))

            // 结果列表
            if execution.result != nil {
                if isError {
                    HStack(spacing: 6) {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundColor(.red)
                        Text(resultContent)
                            .font(.system(size: 12))
                            .foregroundColor(.red)
                    }
                    .padding(12)
                } else if results.isEmpty {
                    Text("无匹配结果")
                        .font(.system(size: 12))
                        .foregroundColor(.secondary)
                        .padding(12)
                } else {
                    VStack(alignment: .leading, spacing: 2) {
                        ForEach(displayResults) { item in
                            HStack(alignment: .top, spacing: 8) {
                                // 文件路径
                                Text(item.filePath.split(separator: "/").last.map(String.init) ?? item.filePath)
                                    .font(.system(size: 11, design: .monospaced))
                                    .foregroundColor(.blue)

                                // 行号
                                if let lineNum = item.lineNumber {
                                    Text(":\(lineNum)")
                                        .font(.system(size: 11, design: .monospaced))
                                        .foregroundColor(.secondary)
                                }

                                // 匹配内容
                                if !item.content.isEmpty {
                                    Text(item.content)
                                        .font(.system(size: 11, design: .monospaced))
                                        .foregroundColor(.primary)
                                        .lineLimit(1)
                                }

                                Spacer()
                            }
                            .padding(.vertical, 4)
                            .padding(.horizontal, 12)
                        }

                        if hasMore && !isExpanded {
                            Button(action: { isExpanded = true }) {
                                Text("显示全部 \(results.count) 个结果")
                                    .font(.caption)
                                    .foregroundColor(.blue)
                            }
                            .padding(.horizontal, 12)
                            .padding(.vertical, 8)
                        } else if isExpanded {
                            Button(action: { isExpanded = false }) {
                                Text("收起")
                                    .font(.caption)
                                    .foregroundColor(.blue)
                            }
                            .padding(.horizontal, 12)
                            .padding(.vertical, 8)
                        }
                    }
                }
            }
        }
        .background(Color.gray.opacity(0.05))
        .cornerRadius(8)
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(isError ? Color.red.opacity(0.3) : Color.orange.opacity(0.2), lineWidth: 1)
        )
    }
}
