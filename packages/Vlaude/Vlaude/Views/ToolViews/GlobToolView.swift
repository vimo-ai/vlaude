//
//  GlobToolView.swift
//  Vlaude
//
//  Glob 工具专用视图 - 文件列表
//

import SwiftUI

/// Glob 工具视图 - 文件列表
struct GlobToolView: View {
    let execution: ToolExecution
    @State private var isExpanded = false

    private var pattern: String {
        execution.input["pattern"] ?? ""
    }

    private var resultContent: String {
        execution.result?.content ?? ""
    }

    private var isError: Bool {
        execution.result?.isError ?? false
    }

    // 解析文件列表
    private var files: [String] {
        guard !isError else { return [] }
        return resultContent
            .components(separatedBy: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
    }

    private var displayFiles: [String] {
        if isExpanded {
            return files
        }
        return Array(files.prefix(15))
    }

    private var hasMore: Bool {
        files.count > 15
    }

    // 获取文件图标
    private func iconForFile(_ path: String) -> String {
        let ext = path.split(separator: ".").last.map(String.init)?.lowercased() ?? ""
        switch ext {
        case "swift": return "s.circle"
        case "ts", "tsx", "js", "jsx": return "chevron.left.forwardslash.chevron.right"
        case "py": return "text.badge.star"
        case "rs": return "gearshape"
        case "json", "yaml", "yml": return "doc.text"
        case "md": return "doc.richtext"
        case "png", "jpg", "jpeg", "gif", "svg": return "photo"
        default: return "doc"
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // 搜索头
            HStack(spacing: 8) {
                Image(systemName: "folder.badge.questionmark")
                    .font(.system(size: 12))
                    .foregroundColor(.purple)

                Text(pattern)
                    .font(.system(size: 13, design: .monospaced))
                    .fontWeight(.medium)
                    .foregroundColor(.purple)

                Spacer()

                if !files.isEmpty {
                    Text("\(files.count) 个文件")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(Color.purple.opacity(0.1))

            // 文件列表
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
                } else if files.isEmpty {
                    Text("无匹配文件")
                        .font(.system(size: 12))
                        .foregroundColor(.secondary)
                        .padding(12)
                } else {
                    VStack(alignment: .leading, spacing: 2) {
                        ForEach(Array(displayFiles.enumerated()), id: \.offset) { _, file in
                            HStack(spacing: 8) {
                                Image(systemName: iconForFile(file))
                                    .font(.system(size: 10))
                                    .foregroundColor(.secondary)
                                    .frame(width: 14)

                                Text(file.split(separator: "/").last.map(String.init) ?? file)
                                    .font(.system(size: 11, design: .monospaced))
                                    .foregroundColor(.primary)

                                Spacer()
                            }
                            .padding(.vertical, 3)
                            .padding(.horizontal, 12)
                        }

                        if hasMore && !isExpanded {
                            Button(action: { isExpanded = true }) {
                                Text("显示全部 \(files.count) 个文件")
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
                .stroke(isError ? Color.red.opacity(0.3) : Color.purple.opacity(0.2), lineWidth: 1)
        )
    }
}
