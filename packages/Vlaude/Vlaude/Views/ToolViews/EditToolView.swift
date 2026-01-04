//
//  EditToolView.swift
//  Vlaude
//
//  Edit 工具专用视图 - 显示文件编辑的 Diff 视图
//

import SwiftUI
import MarkdownUI

/// Edit 工具视图 - 文件编辑 Diff
struct EditToolView: View {
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

    // 旧内容（被替换的）
    private var oldString: String {
        execution.input["old_string"] ?? ""
    }

    // 新内容（替换后的）
    private var newString: String {
        execution.input["new_string"] ?? ""
    }

    // 是否全部替换
    private var replaceAll: Bool {
        execution.input["replace_all"]?.lowercased() == "true"
    }

    // 内容是否过长
    private var isContentLong: Bool {
        oldString.count > 300 || newString.count > 300
    }

    // 显示的旧内容
    private var displayOldString: String {
        if isExpanded || oldString.count <= 300 {
            return oldString
        }
        return String(oldString.prefix(300))
    }

    // 显示的新内容
    private var displayNewString: String {
        if isExpanded || newString.count <= 300 {
            return newString
        }
        return String(newString.prefix(300))
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
            // 头部
            HStack(spacing: 8) {
                Image(systemName: "pencil.and.outline")
                    .font(.system(size: 12))
                    .foregroundColor(.orange)

                Text("Edit")
                    .font(.system(size: 13, design: .monospaced))
                    .fontWeight(.medium)

                if replaceAll {
                    Text("(全部替换)")
                        .font(.system(size: 10))
                        .foregroundColor(.secondary)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Color.orange.opacity(0.15))
                        .cornerRadius(4)
                }

                Spacer()

                // 状态指示
                if isSuccess {
                    HStack(spacing: 4) {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundColor(.green)
                        Text("已修改")
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
            .background(Color.orange.opacity(0.1))

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

            // Diff 视图
            VStack(alignment: .leading, spacing: 12) {
                // 删除的内容（旧）
                if !oldString.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(spacing: 4) {
                            Image(systemName: "minus.circle.fill")
                                .font(.system(size: 10))
                                .foregroundColor(.red)
                            Text("删除")
                                .font(.system(size: 11, weight: .medium))
                                .foregroundColor(.red)
                            Spacer()
                            Text("\(oldString.components(separatedBy: "\n").count) 行")
                                .font(.system(size: 10))
                                .foregroundColor(.secondary)
                        }

                        DiffCodeBlock(
                            content: displayOldString,
                            language: language,
                            type: .deletion
                        )
                    }
                }

                // 添加的内容（新）
                if !newString.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(spacing: 4) {
                            Image(systemName: "plus.circle.fill")
                                .font(.system(size: 10))
                                .foregroundColor(.green)
                            Text("添加")
                                .font(.system(size: 11, weight: .medium))
                                .foregroundColor(.green)
                            Spacer()
                            Text("\(newString.components(separatedBy: "\n").count) 行")
                                .font(.system(size: 10))
                                .foregroundColor(.secondary)
                        }

                        DiffCodeBlock(
                            content: displayNewString,
                            language: language,
                            type: .addition
                        )
                    }
                }

                // 展开/收起按钮
                if isContentLong {
                    Button(action: { isExpanded.toggle() }) {
                        HStack(spacing: 4) {
                            Text(isExpanded ? "收起" : "展开全部")
                            Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                        }
                        .font(.caption)
                        .foregroundColor(.orange)
                    }
                }
            }
            .padding(12)

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
                .stroke(isError ? Color.red.opacity(0.3) : Color.orange.opacity(0.2), lineWidth: 1)
        )
    }
}

// Diff 代码块类型
enum DiffType {
    case addition
    case deletion
}

// Diff 代码块组件
struct DiffCodeBlock: View {
    let content: String
    let language: String
    let type: DiffType

    private var backgroundColor: Color {
        switch type {
        case .addition:
            return Color.green.opacity(0.08)
        case .deletion:
            return Color.red.opacity(0.08)
        }
    }

    private var borderColor: Color {
        switch type {
        case .addition:
            return Color.green.opacity(0.3)
        case .deletion:
            return Color.red.opacity(0.3)
        }
    }

    private var linePrefix: String {
        switch type {
        case .addition: return "+"
        case .deletion: return "-"
        }
    }

    private var prefixColor: Color {
        switch type {
        case .addition: return .green
        case .deletion: return .red
        }
    }

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(content.components(separatedBy: "\n").enumerated()), id: \.offset) { index, line in
                    HStack(alignment: .top, spacing: 0) {
                        // 行号
                        Text("\(index + 1)")
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundColor(.secondary.opacity(0.5))
                            .frame(width: 28, alignment: .trailing)
                            .padding(.trailing, 4)

                        // +/- 前缀
                        Text(linePrefix)
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundColor(prefixColor)
                            .frame(width: 12)

                        // 代码行
                        Text(line.isEmpty ? " " : line)
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundColor(.primary.opacity(0.9))
                    }
                    .padding(.vertical, 1)
                }
            }
            .padding(8)
        }
        .background(backgroundColor)
        .cornerRadius(6)
        .overlay(
            RoundedRectangle(cornerRadius: 6)
                .stroke(borderColor, lineWidth: 1)
        )
    }
}
