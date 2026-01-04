//
//  TaskToolView.swift
//  Vlaude
//
//  Task 工具专用视图 - 子代理任务状态
//

import SwiftUI

/// Task 工具视图 - 子代理
struct TaskToolView: View {
    let execution: ToolExecution
    @State private var isExpanded = false

    // 任务描述
    private var taskDescription: String {
        execution.input["description"] ?? ""
    }

    // 任务提示
    private var taskPrompt: String {
        execution.input["prompt"] ?? ""
    }

    // 子代理类型
    private var subagentType: String {
        execution.input["subagent_type"] ?? "general-purpose"
    }

    // 是否后台运行
    private var runInBackground: Bool {
        execution.input["run_in_background"]?.lowercased() == "true"
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

    // 是否结果过长
    private var isResultLong: Bool {
        resultContent.count > 500
    }

    private var displayResult: String {
        if isExpanded || !isResultLong {
            return resultContent
        }
        return String(resultContent.prefix(500))
    }

    // 代理类型图标和颜色
    private var agentIcon: String {
        switch subagentType.lowercased() {
        case "architect": return "building.columns"
        case "engineer": return "hammer"
        case "debugger": return "ant"
        case "tutor": return "graduationcap"
        case "business-analyst": return "chart.bar.doc.horizontal"
        case "explore": return "magnifyingglass"
        case "plan": return "map"
        default: return "cpu"
        }
    }

    private var agentColor: Color {
        switch subagentType.lowercased() {
        case "architect": return .purple
        case "engineer": return .blue
        case "debugger": return .red
        case "tutor": return .green
        case "business-analyst": return .orange
        case "explore": return .cyan
        case "plan": return .indigo
        default: return .gray
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // 头部
            HStack(spacing: 8) {
                Image(systemName: agentIcon)
                    .font(.system(size: 12))
                    .foregroundColor(agentColor)

                Text("Task")
                    .font(.system(size: 13, design: .monospaced))
                    .fontWeight(.medium)

                // 代理类型标签
                Text(subagentType)
                    .font(.system(size: 10))
                    .foregroundColor(agentColor)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(agentColor.opacity(0.15))
                    .cornerRadius(4)

                if runInBackground {
                    Text("后台")
                        .font(.system(size: 10))
                        .foregroundColor(.secondary)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Color.gray.opacity(0.15))
                        .cornerRadius(4)
                }

                Spacer()

                // 状态
                if isSuccess {
                    HStack(spacing: 4) {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundColor(.green)
                        Text("完成")
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
                } else {
                    HStack(spacing: 4) {
                        ProgressView()
                            .scaleEffect(0.6)
                        Text("执行中")
                            .font(.system(size: 11))
                            .foregroundColor(.secondary)
                    }
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(agentColor.opacity(0.1))

            // 任务描述
            if !taskDescription.isEmpty {
                HStack(spacing: 6) {
                    Image(systemName: "text.alignleft")
                        .font(.system(size: 10))
                        .foregroundColor(.secondary)

                    Text(taskDescription)
                        .font(.system(size: 12))
                        .foregroundColor(.primary)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.gray.opacity(0.05))
            }

            // 任务结果
            if !resultContent.isEmpty {
                Divider()

                VStack(alignment: .leading, spacing: 8) {
                    Text(isError ? "错误" : "结果")
                        .font(.system(size: 11))
                        .foregroundColor(.secondary)

                    Text(displayResult)
                        .font(.system(size: 12))
                        .foregroundColor(isError ? .red : .primary)
                        .textSelection(.enabled)

                    if isResultLong {
                        Button(action: { isExpanded.toggle() }) {
                            HStack(spacing: 4) {
                                Text(isExpanded ? "收起" : "展开全部")
                                Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                            }
                            .font(.caption)
                            .foregroundColor(agentColor)
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
                .stroke(isError ? Color.red.opacity(0.3) : agentColor.opacity(0.2), lineWidth: 1)
        )
    }
}
