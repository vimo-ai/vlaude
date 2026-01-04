//
//  WriteToolView.swift
//  Vlaude
//
//  Write 工具专用视图 - 显示写入文件的详细信息
//

import SwiftUI
import MarkdownUI

/// Write 工具视图 - 文件写入
struct WriteToolView: View {
    let execution: ToolExecution
    @State private var isExpanded = false

    private var filePath: String {
        execution.input["file_path"] ?? ""
    }

    private var fileName: String {
        filePath.split(separator: "/").last.map(String.init) ?? filePath
    }

    private var fileExtension: String {
        fileName.split(separator: ".").last.map(String.init) ?? "txt"
    }

    // 写入的内容
    private var writeContent: String {
        execution.input["content"] ?? ""
    }

    private var isContentLong: Bool {
        writeContent.count > 500
    }

    private var displayContent: String {
        if isExpanded || !isContentLong {
            return writeContent
        }
        return String(writeContent.prefix(500))
    }

    // 执行结果
    private var resultContent: String {
        execution.result?.content ?? ""
    }

    private var isError: Bool {
        execution.result?.isError ?? false
    }

    private var isSuccess: Bool {
        execution.result != nil && !isError
    }

    // 语言映射
    private var language: String {
        switch fileExtension.lowercased() {
        case "swift": return "swift"
        case "ts", "tsx": return "typescript"
        case "js", "jsx": return "javascript"
        case "py": return "python"
        case "rs": return "rust"
        case "go": return "go"
        case "java": return "java"
        case "kt": return "kotlin"
        case "rb": return "ruby"
        case "c", "h": return "c"
        case "cpp", "cc", "cxx", "hpp": return "cpp"
        case "json": return "json"
        case "yaml", "yml": return "yaml"
        case "md": return "markdown"
        case "sh", "bash": return "bash"
        case "sql": return "sql"
        case "html": return "html"
        case "css": return "css"
        case "xml": return "xml"
        case "vue": return "vue"
        default: return "text"
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // 文件头
            HStack(spacing: 8) {
                Image(systemName: "square.and.pencil")
                    .font(.system(size: 12))
                    .foregroundColor(.blue)

                Text("Write")
                    .font(.system(size: 13, design: .monospaced))
                    .fontWeight(.medium)

                Spacer()

                // 状态指示
                if isSuccess {
                    HStack(spacing: 4) {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundColor(.green)
                        Text("已创建")
                            .font(.system(size: 11))
                            .foregroundColor(.green)
                    }
                } else if isError {
                    HStack(spacing: 4) {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundColor(.red)
                        Text("失败")
                            .font(.system(size: 11))
                            .foregroundColor(.red)
                    }
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(Color.blue.opacity(0.1))

            // 文件路径
            HStack(spacing: 6) {
                Image(systemName: "doc.text")
                    .font(.system(size: 10))
                    .foregroundColor(.secondary)

                Text(filePath)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundColor(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.gray.opacity(0.05))

            // 写入内容预览
            if !writeContent.isEmpty {
                Divider()

                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Text("写入内容")
                            .font(.system(size: 11))
                            .foregroundColor(.secondary)

                        Spacer()

                        Text("\(writeContent.count) 字符")
                            .font(.system(size: 10))
                            .foregroundColor(.secondary)
                    }

                    // 代码预览
                    Markdown("```\(language)\n\(displayContent)\n```")
                        .markdownTheme(.gitHub)
                        .textSelection(.enabled)

                    if isContentLong {
                        Button(action: { isExpanded.toggle() }) {
                            HStack(spacing: 4) {
                                Text(isExpanded ? "收起" : "展开全部")
                                Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                            }
                            .font(.caption)
                            .foregroundColor(.blue)
                        }
                    }
                }
                .padding(12)
            }

            // 错误信息
            if isError && !resultContent.isEmpty {
                Divider()

                Text(resultContent)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundColor(.red)
                    .padding(12)
            }
        }
        .background(Color.gray.opacity(0.05))
        .cornerRadius(8)
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(isError ? Color.red.opacity(0.3) : Color.blue.opacity(0.2), lineWidth: 1)
        )
    }
}
