//
//  AskUserQuestionToolView.swift
//  Vlaude
//
//  AskUserQuestion 工具专用视图 - 问题选项卡片
//

import SwiftUI

/// AskUserQuestion 工具视图 - 问题选项
struct AskUserQuestionToolView: View {
    let execution: ToolExecution
    let sessionId: String

    // 是否需要用户输入（工具正在等待回答）
    private var needsUserInput: Bool {
        execution.result == nil
    }

    // 解析 questions 数组
    private var questions: [QuestionItem] {
        guard let questionsJson = execution.input["questions"] else { return [] }

        guard let data = questionsJson.data(using: .utf8),
              let array = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
            return []
        }

        return array.compactMap { dict in
            guard let question = dict["question"] as? String else { return nil }

            let header = dict["header"] as? String
            let multiSelect = dict["multiSelect"] as? Bool ?? false

            var options: [QuestionOption] = []
            if let optionsArray = dict["options"] as? [[String: Any]] {
                options = optionsArray.compactMap { optDict in
                    guard let label = optDict["label"] as? String else { return nil }
                    let description = optDict["description"] as? String
                    return QuestionOption(label: label, description: description)
                }
            }

            return QuestionItem(
                question: question,
                header: header,
                options: options,
                multiSelect: multiSelect
            )
        }
    }

    // 用户回答
    private var answers: [String: String] {
        guard let answersJson = execution.input["answers"] else { return [:] }
        guard let data = answersJson.data(using: .utf8),
              let dict = try? JSONSerialization.jsonObject(with: data) as? [String: String] else {
            return [:]
        }
        return dict
    }

    // 执行结果（用户的回答）
    private var resultContent: String {
        execution.result?.content ?? ""
    }

    private var isError: Bool {
        execution.result?.isError ?? false
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // 头部
            HStack(spacing: 8) {
                Image(systemName: "questionmark.bubble")
                    .font(.system(size: 12))
                    .foregroundColor(.indigo)

                Text("Question")
                    .font(.system(size: 13, design: .monospaced))
                    .fontWeight(.medium)

                Spacer()

                if execution.result != nil && !isError {
                    HStack(spacing: 4) {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundColor(.green)
                        Text("已回答")
                            .font(.system(size: 11))
                            .foregroundColor(.green)
                    }
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(Color.indigo.opacity(0.1))

            // 问题列表
            VStack(alignment: .leading, spacing: 12) {
                ForEach(Array(questions.enumerated()), id: \.offset) { questionIndex, question in
                    QuestionCard(
                        question: question,
                        questionIndex: questionIndex,
                        isInteractive: needsUserInput,
                        sessionId: sessionId
                    )
                }

                // 显示用户回答
                if !resultContent.isEmpty && !isError {
                    Divider()

                    VStack(alignment: .leading, spacing: 4) {
                        Text("用户回答")
                            .font(.system(size: 11))
                            .foregroundColor(.secondary)

                        Text(resultContent)
                            .font(.system(size: 12))
                            .foregroundColor(.primary)
                            .padding(8)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(Color.green.opacity(0.08))
                            .cornerRadius(6)
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
                .stroke(isError ? Color.red.opacity(0.3) : Color.indigo.opacity(0.2), lineWidth: 1)
        )
    }
}

// 问题数据模型
struct QuestionItem {
    let question: String
    let header: String?
    let options: [QuestionOption]
    let multiSelect: Bool
}

struct QuestionOption {
    let label: String
    let description: String?
}

// 问题卡片
struct QuestionCard: View {
    let question: QuestionItem
    let questionIndex: Int
    let isInteractive: Bool
    let sessionId: String

    // 本地状态：当前选中的选项索引
    @State private var selectedIndex: Int?

    // 是否已回答（本地选择或服务器返回）
    private var hasAnswered: Bool {
        selectedIndex != nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            // 问题头部
            HStack {
                if let header = question.header {
                    Text(header)
                        .font(.system(size: 10, weight: .medium))
                        .foregroundColor(.indigo)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Color.indigo.opacity(0.15))
                        .cornerRadius(4)
                }

                if question.multiSelect {
                    Text("多选")
                        .font(.system(size: 10))
                        .foregroundColor(.secondary)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Color.gray.opacity(0.15))
                        .cornerRadius(4)
                }

                Spacer()

                // 状态指示
                if hasAnswered {
                    HStack(spacing: 4) {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundColor(.green)
                        Text("已回答")
                            .font(.system(size: 10))
                            .foregroundColor(.green)
                    }
                } else if isInteractive {
                    HStack(spacing: 4) {
                        ProgressView()
                            .scaleEffect(0.6)
                        Text("等待回答")
                            .font(.system(size: 10))
                            .foregroundColor(.orange)
                    }
                }
            }

            // 问题文本
            Text(question.question)
                .font(.system(size: 13))
                .foregroundColor(.primary)

            // 选项
            if !question.options.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(Array(question.options.enumerated()), id: \.offset) { index, option in
                        OptionRow(
                            option: option,
                            index: index,
                            multiSelect: question.multiSelect,
                            isInteractive: isInteractive,
                            sessionId: sessionId,
                            selectedIndex: $selectedIndex
                        )
                    }
                }
            }
        }
    }
}

// 选项行
struct OptionRow: View {
    let option: QuestionOption
    let index: Int
    let multiSelect: Bool
    let isInteractive: Bool
    let sessionId: String
    @Binding var selectedIndex: Int?

    @State private var isSending = false

    // 是否是当前选中的选项
    private var isSelected: Bool {
        selectedIndex == index
    }

    // 是否禁用（已有选择且不是当前选项）
    private var isDisabled: Bool {
        selectedIndex != nil && !isSelected
    }

    var body: some View {
        if isInteractive && selectedIndex == nil {
            // 可交互模式 - 按钮（未选择状态）
            Button {
                sendSelection()
            } label: {
                optionContent
                    .background(Color.indigo.opacity(0.08))
                    .overlay(
                        RoundedRectangle(cornerRadius: 6)
                            .stroke(Color.indigo.opacity(0.3), lineWidth: 1)
                    )
            }
            .buttonStyle(PlainButtonStyle())
            .disabled(isSending)
        } else if isSelected {
            // 已选中状态 - 显示选中样式
            optionContent
                .background(Color.green.opacity(0.15))
                .overlay(
                    RoundedRectangle(cornerRadius: 6)
                        .stroke(Color.green.opacity(0.5), lineWidth: 1.5)
                )
        } else {
            // 静态模式或已有其他选择 - 普通展示
            optionContent
                .background(Color.gray.opacity(0.06))
                .opacity(isDisabled ? 0.5 : 1.0)
        }
    }

    private var optionContent: some View {
        HStack(alignment: .top, spacing: 8) {
            if isSelected {
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 12))
                    .foregroundColor(.green)
            } else {
                Image(systemName: multiSelect ? "square" : "circle")
                    .font(.system(size: 12))
                    .foregroundColor(isInteractive && selectedIndex == nil ? .indigo : .secondary)
            }

            VStack(alignment: .leading, spacing: 2) {
                Text(option.label)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(.primary)

                if let desc = option.description, !desc.isEmpty {
                    Text(desc)
                        .font(.system(size: 11))
                        .foregroundColor(.secondary)
                }
            }

            Spacer()

            if isSelected {
                Text("已发送")
                    .font(.system(size: 10))
                    .foregroundColor(.green)
            } else if isInteractive && selectedIndex == nil {
                Image(systemName: "chevron.right")
                    .font(.system(size: 10))
                    .foregroundColor(.indigo.opacity(0.6))
            }
        }
        .padding(.vertical, 8)
        .padding(.horizontal, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .cornerRadius(6)
    }

    private func sendSelection() {
        guard !isSending else { return }
        isSending = true

        // 更新选中状态
        selectedIndex = index

        // 发送选项索引到终端（1-based，因为 Claude Code 使用 1, 2, 3...）
        let inputText = "\(index + 1)"
        print("📤 [AskUserQuestion] 发送选择: \(inputText) (选项: \(option.label))")
        VlaudeWebSocketClient.shared.sendMessage(inputText, sessionId: sessionId)
    }
}
