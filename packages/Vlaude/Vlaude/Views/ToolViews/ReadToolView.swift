//
//  ReadToolView.swift
//  Vlaude
//
//  Read 工具专用视图 - 代码预览
//

import SwiftUI
import MarkdownUI

/// Read 工具视图 - 代码预览
struct ReadToolView: View {
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

    private var resultContent: String {
        execution.result?.content ?? ""
    }

    private var isResultLong: Bool {
        resultContent.count > 1000
    }

    private var displayContent: String {
        if isExpanded || !isResultLong {
            return resultContent
        }
        return String(resultContent.prefix(1000))
    }

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
        default: return "text"
        }
    }

    private var isError: Bool {
        execution.result?.isError ?? false
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // 文件头
            HStack(spacing: 8) {
                Image(systemName: "doc.text")
                    .font(.system(size: 12))
                    .foregroundColor(.blue)

                Text(fileName)
                    .font(.system(size: 13, design: .monospaced))
                    .fontWeight(.medium)

                Spacer()

                Text(fileExtension.uppercased())
                    .font(.system(size: 10))
                    .foregroundColor(.secondary)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(Color.gray.opacity(0.2))
                    .cornerRadius(4)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(Color.gray.opacity(0.1))

            // 代码内容
            if execution.result != nil {
                if isError {
                    // 错误显示
                    HStack(spacing: 6) {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundColor(.red)
                        Text(resultContent)
                            .font(.system(size: 12))
                            .foregroundColor(.red)
                    }
                    .padding(12)
                } else {
                    // 代码预览
                    VStack(alignment: .leading, spacing: 4) {
                        Markdown("```\(language)\n\(displayContent)\n```")
                            .markdownTheme(.claudeCode)
                            .markdownCodeSyntaxHighlighter(HighlightrCodeSyntaxHighlighter())
                            .textSelection(.enabled)

                        if isResultLong {
                            HStack {
                                Button(action: { isExpanded.toggle() }) {
                                    Text(isExpanded ? "收起" : "展开全部")
                                        .font(.caption)
                                        .foregroundColor(.blue)
                                }

                                Spacer()

                                Text("\(resultContent.count) 字符")
                                    .font(.caption2)
                                    .foregroundColor(.secondary)
                            }
                        }
                    }
                    .padding(12)
                }
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
