//
//  TodoWriteToolView.swift
//  Vlaude
//
//  TodoWrite 工具专用视图 - 任务列表 checkbox 样式
//

import SwiftUI

/// TodoWrite 工具视图 - 任务列表
struct TodoWriteToolView: View {
    let execution: ToolExecution

    // 解析 todos 数组
    private var todos: [TodoItem] {
        // todos 在 input 中是 JSON 字符串
        guard let todosJson = execution.input["todos"] else { return [] }

        // 尝试解析 JSON
        guard let data = todosJson.data(using: .utf8),
              let array = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
            return []
        }

        return array.compactMap { dict in
            guard let content = dict["content"] as? String,
                  let status = dict["status"] as? String else {
                return nil
            }
            let activeForm = dict["activeForm"] as? String
            return TodoItem(content: content, status: status, activeForm: activeForm)
        }
    }

    // 统计
    private var completedCount: Int {
        todos.filter { $0.status == "completed" }.count
    }

    private var inProgressCount: Int {
        todos.filter { $0.status == "in_progress" }.count
    }

    private var pendingCount: Int {
        todos.filter { $0.status == "pending" }.count
    }

    // 执行结果
    private var isError: Bool {
        execution.result?.isError ?? false
    }

    private var isSuccess: Bool {
        execution.result != nil && !isError
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // 头部
            HStack(spacing: 8) {
                Image(systemName: "checklist")
                    .font(.system(size: 12))
                    .foregroundColor(.purple)

                Text("Todo")
                    .font(.system(size: 13, design: .monospaced))
                    .fontWeight(.medium)

                Spacer()

                // 统计
                if !todos.isEmpty {
                    HStack(spacing: 8) {
                        if completedCount > 0 {
                            StatBadge(count: completedCount, color: .green, icon: "checkmark")
                        }
                        if inProgressCount > 0 {
                            StatBadge(count: inProgressCount, color: .blue, icon: "arrow.right")
                        }
                        if pendingCount > 0 {
                            StatBadge(count: pendingCount, color: .gray, icon: "circle")
                        }
                    }
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(Color.purple.opacity(0.1))

            // 任务列表
            if !todos.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(Array(todos.enumerated()), id: \.offset) { _, todo in
                        TodoRow(todo: todo)
                    }
                }
                .padding(12)
            } else {
                Text("无任务")
                    .font(.system(size: 12))
                    .foregroundColor(.secondary)
                    .padding(12)
            }

            // 错误信息
            if isError, let errorContent = execution.result?.content, !errorContent.isEmpty {
                Divider()

                Text(errorContent)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundColor(.red)
                    .padding(12)
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

// Todo 数据模型
struct TodoItem {
    let content: String
    let status: String
    let activeForm: String?

    var statusIcon: String {
        switch status {
        case "completed": return "checkmark.circle.fill"
        case "in_progress": return "arrow.right.circle.fill"
        default: return "circle"
        }
    }

    var statusColor: Color {
        switch status {
        case "completed": return .green
        case "in_progress": return .blue
        default: return .gray
        }
    }

    var displayText: String {
        if status == "in_progress", let active = activeForm, !active.isEmpty {
            return active
        }
        return content
    }
}

// 单个任务行
struct TodoRow: View {
    let todo: TodoItem

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: todo.statusIcon)
                .font(.system(size: 14))
                .foregroundColor(todo.statusColor)
                .frame(width: 16)

            Text(todo.displayText)
                .font(.system(size: 12))
                .foregroundColor(todo.status == "completed" ? .secondary : .primary)
                .strikethrough(todo.status == "completed")
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, 4)
        .padding(.horizontal, 8)
        .background(
            RoundedRectangle(cornerRadius: 6)
                .fill(todo.status == "in_progress" ? Color.blue.opacity(0.08) : Color.clear)
        )
    }
}

// 统计徽章
struct StatBadge: View {
    let count: Int
    let color: Color
    let icon: String

    var body: some View {
        HStack(spacing: 2) {
            Image(systemName: icon)
                .font(.system(size: 8))
            Text("\(count)")
                .font(.system(size: 10, weight: .medium))
        }
        .foregroundColor(color)
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .background(color.opacity(0.15))
        .cornerRadius(4)
    }
}
