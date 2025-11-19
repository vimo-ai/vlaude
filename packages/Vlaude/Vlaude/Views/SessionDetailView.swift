//
//  SessionDetailView.swift
//  Vlaude
//
//  Created by Claude on 2025/11/16.
//

import SwiftUI
import MarkdownUI

struct SessionDetailView: View {
    let sessionId: String

    @StateObject private var viewModel = SessionDetailViewModel()
    @State private var inputText = ""
    @State private var selectedMessageForDetail: DisplayMessage?

    // 权限请求相关状态
    @State private var showApprovalAlert = false
    @State private var currentApprovalRequest: (requestId: String, toolName: String, description: String)?

    var body: some View {
        VStack(spacing: 0) {
            // 消息列表
            if viewModel.isLoading {
                Spacer()
                ProgressView("加载中...")
                Spacer()
            } else if let error = viewModel.errorMessage {
                Spacer()
                VStack(spacing: 16) {
                    Image(systemName: "exclamationmark.triangle")
                        .font(.system(size: 48))
                        .foregroundColor(.orange)
                    Text(error)
                        .foregroundColor(.secondary)
                    Button("重试") {
                        Task {
                            await viewModel.loadSessionDetail(sessionId: sessionId)
                        }
                    }
                    .buttonStyle(.bordered)
                }
                Spacer()
            } else if viewModel.displayMessages.isEmpty {
                Spacer()
                VStack(spacing: 16) {
                    Image(systemName: "message")
                        .font(.system(size: 48))
                        .foregroundColor(.gray)
                    Text("暂无消息")
                        .foregroundColor(.secondary)
                }
                Spacer()
            } else {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(spacing: 16) {
                            // 「加载更多」按钮在顶部
                            if viewModel.hasMore {
                                Button {
                                    // 直接调用 ViewModel 方法,不在视图层创建 Task
                                    Task {
                                        await viewModel.loadMessages(sessionId: sessionId)
                                    }
                                } label: {
                                    if viewModel.isLoadingMore {
                                        ProgressView()
                                    } else {
                                        Text("加载更早消息")
                                            .foregroundColor(.blue)
                                    }
                                }
                                .disabled(viewModel.isLoadingMore)  // 加载中禁用按钮
                                .padding()
                                .id("loadMoreButton")
                            }

                            // 消息列表
                            ForEach(viewModel.displayMessages) { message in
                                DisplayMessageBubble(message: message)
                                    .id(message.id)
                                    .contentShape(Rectangle())
                                    .onTapGesture(count: 2) {
                                        selectedMessageForDetail = message
                                    }
                            }

                            // 等待响应的 loading 指示器
                            if viewModel.isWaitingForResponse {
                                HStack(spacing: 8) {
                                    ProgressView()
                                        .scaleEffect(0.8)
                                    Text("Claude 正在思考...")
                                        .font(.caption)
                                        .foregroundColor(.secondary)
                                }
                                .padding(.vertical, 8)
                                .id("waitingIndicator")
                            }
                        }
                        .padding()
                    }
                    .onAppear {
                        // 首次加载后滚动到底部（不使用动画）
                        if let lastMessage = viewModel.displayMessages.last {
                            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                                proxy.scrollTo(lastMessage.id, anchor: .bottom)
                            }
                        }
                    }
                    .onChange(of: viewModel.displayMessages.count) { oldCount, newCount in
                        // 消息数量变化时，如果是首次加载，滚动到底部（不使用动画）
                        if newCount > oldCount {
                            if let lastMessage = viewModel.displayMessages.last {
                                DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                                    proxy.scrollTo(lastMessage.id, anchor: .bottom)
                                }
                            }
                        }
                    }
                    .onChange(of: viewModel.isWaitingForResponse) { oldValue, newValue in
                        // 显示 loading 时自动滚动到底部
                        if newValue {
                            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                                withAnimation {
                                    proxy.scrollTo("waitingIndicator", anchor: .bottom)
                                }
                            }
                        }
                    }
                }
            }

            Divider()

            // 底部输入框
            MessageInputView(text: $inputText) {
                sendMessage()
            }
        }
        .navigationTitle("会话详情")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            await viewModel.loadSessionDetail(sessionId: sessionId)
        }
        .sheet(item: $selectedMessageForDetail) { message in
            MessageDetailSheet(message: message)
        }
        // 权限请求 Alert
        .approvalAlert(
            isPresented: $showApprovalAlert,
            requestId: currentApprovalRequest?.requestId ?? "",
            toolName: currentApprovalRequest?.toolName ?? "",
            description: currentApprovalRequest?.description ?? ""
        ) {
            // 用户点击"允许"
            if let requestId = currentApprovalRequest?.requestId {
                WebSocketManager.shared.sendApprovalResponse(
                    requestId: requestId,
                    approved: true
                )
            }
            showApprovalAlert = false
        } onDeny: {
            // 用户点击"拒绝"
            if let requestId = currentApprovalRequest?.requestId {
                WebSocketManager.shared.sendApprovalResponse(
                    requestId: requestId,
                    approved: false,
                    reason: "用户拒绝"
                )
            }
            showApprovalAlert = false
        }
        // 监听权限请求通知
        .onReceive(NotificationCenter.default.publisher(for: NSNotification.Name("ApprovalRequest"))) { notification in
            print("🔐 [UI] 收到权限请求通知")
            if let requestId = notification.userInfo?["requestId"] as? String,
               let toolName = notification.userInfo?["toolName"] as? String,
               let description = notification.userInfo?["description"] as? String {
                print("🔐 [UI] 设置权限请求数据: \(toolName)")
                currentApprovalRequest = (requestId, toolName, description)
                showApprovalAlert = true
            }
        }
    }

    private func sendMessage() {
        let message = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !message.isEmpty else { return }

        // 发送消息到 Server
        viewModel.sendMessage(message)
        inputText = ""
    }
}

// 新的 DisplayMessage 气泡组件
struct DisplayMessageBubble: View {
    let message: DisplayMessage
    @State private var isExpanded = false

    private var isUser: Bool {
        message.type == .user
    }

    // 判断是否有工具执行
    private var hasToolExecutions: Bool {
        !message.toolExecutions.isEmpty
    }

    // 检测是否包含 Markdown 标记
    private var hasMarkdown: Bool {
        let content = message.textContent
        return content.contains("```") ||       // 代码块
               content.contains("**") ||        // 粗体
               content.contains("__") ||        // 粗体
               content.contains("*") ||         // 斜体
               content.contains("_") ||         // 斜体
               content.contains("#") ||         // 标题
               content.contains("[") ||         // 链接
               content.contains("|") ||         // 表格
               content.contains(">")            // 引用
    }

    // 判断是否是长文本（超过 500 字符）
    private var isLongText: Bool {
        message.textContent.count > 500
    }

    // 显示的内容 - 优化内存占用
    private var displayContent: String {
        if !isLongText {
            return message.textContent
        }

        if isExpanded {
            return message.textContent
        } else {
            return String(message.textContent.prefix(500))
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            if isUser { Spacer(minLength: 50) }

            VStack(alignment: isUser ? .trailing : .leading, spacing: 8) {
                // 角色标签
                HStack(spacing: 4) {
                    Text(message.type == .user ? "User" : message.type == .assistant ? "Assistant" : "System")
                        .font(.caption)
                        .foregroundColor(.secondary)

                    // 思考元数据标识
                    if let metadata = message.thinkingMetadata, metadata.enabled {
                        Text("💭")
                            .font(.caption)
                    }

                    // 中断标识
                    if message.isInterrupted {
                        Text("⏸️")
                            .font(.caption)
                    }

                    // Agent 标识
                    if message.isAgentMessage {
                        Text("🤖")
                            .font(.caption)
                    }
                }

                // 如果有工具执行，使用工具执行组件
                if hasToolExecutions {
                    ForEach(message.toolExecutions) { toolExecution in
                        ToolExecutionBubble(execution: toolExecution)
                    }
                }

                // 显示文本内容（可能与工具执行共存）
                if !message.textContent.isEmpty {
                    // 根据内容类型选择渲染方式
                    if hasMarkdown {
                        // Markdown 内容
                        Markdown(displayContent)
                            .markdownTheme(.claudeCode)
                            .markdownCodeSyntaxHighlighter(HighlightrCodeSyntaxHighlighter())
                            .padding(12)
                            .background(isUser ? Color.blue.opacity(0.1) : Color.gray.opacity(0.1))
                            .cornerRadius(16)
                            .overlay(
                                RoundedRectangle(cornerRadius: 16)
                                    .stroke(isUser ? Color.blue.opacity(0.3) : Color.gray.opacity(0.3), lineWidth: 1)
                            )

                        // 展开/收起按钮（Markdown）
                        if isLongText {
                            Button(action: {
                                isExpanded.toggle()
                            }) {
                                Text(isExpanded ? "收起" : "查看更多")
                                    .font(.caption)
                                    .foregroundColor(.blue)
                            }
                            .padding(.top, 4)
                        }
                    } else {
                        // 普通文本
                        VStack(alignment: .leading, spacing: 8) {
                            Text(displayContent)
                                .font(.system(size: 14))
                                .textSelection(.enabled)

                            // 展开/收起按钮
                            if isLongText {
                                Button(action: {
                                    isExpanded.toggle()
                                }) {
                                    Text(isExpanded ? "收起" : "查看更多")
                                        .font(.caption)
                                        .foregroundColor(isUser ? .white.opacity(0.8) : .blue)
                                }
                            }
                        }
                        .padding(12)
                        .background(isUser ? Color.blue : Color.gray.opacity(0.2))
                        .foregroundColor(isUser ? .white : .primary)
                        .cornerRadius(16)
                    }
                }

                // 显示图片
                if !message.images.isEmpty {
                    ForEach(message.images) { image in
                        if let imageData = Data(base64Encoded: image.data),
                           let uiImage = UIImage(data: imageData) {
                            Image(uiImage: uiImage)
                                .resizable()
                                .scaledToFit()
                                .frame(maxWidth: 300)
                                .cornerRadius(8)
                        }
                    }
                }

                // 时间戳
                Text(message.timestamp, style: .time)
                    .font(.caption2)
                    .foregroundColor(.secondary)
            }

            if !isUser { Spacer(minLength: 50) }
        }
    }
}

// 工具执行气泡组件
struct ToolExecutionBubble: View {
    let execution: ToolExecution
    @State private var isExpanded = false

    private var hasResult: Bool {
        execution.result != nil
    }

    private var resultContent: String {
        execution.result?.content ?? ""
    }

    private var isResultLong: Bool {
        resultContent.count > 500  // 提高阈值，减少不必要的折叠
    }

    // 优化：只在需要时才截断字符串
    private var displayResultContent: String {
        if !isResultLong {
            return resultContent
        }

        if isExpanded {
            return resultContent
        } else {
            // 使用 prefix 而不是创建新字符串
            return String(resultContent.prefix(500))
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            // 工具名称和输入
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text("⏺")
                        .font(.system(size: 12))
                    Text(execution.name)
                        .font(.system(size: 13, design: .monospaced))
                        .fontWeight(.semibold)
                }

                if !execution.formattedInput.isEmpty {
                    Text(execution.formattedInput)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundColor(.secondary)
                        .padding(.leading, 20)
                }
            }

            // 工具执行结果
            if hasResult {
                Divider()

                HStack(alignment: .top, spacing: 6) {
                    Text("⎿")
                        .font(.system(size: 12))
                        .foregroundColor(.secondary)

                    VStack(alignment: .leading, spacing: 4) {
                        if execution.result?.isError == true {
                            Label("执行失败", systemImage: "xmark.circle.fill")
                                .font(.system(size: 11))
                                .foregroundColor(.red)
                        }

                        VStack(alignment: .leading, spacing: 4) {
                            Text(displayResultContent)
                                .font(.system(size: 12, design: .monospaced))
                                .foregroundColor(execution.result?.isError == true ? .red : .primary)
                                .textSelection(.enabled)

                            if isResultLong {
                                Button(action: {
                                    // 不使用动画，直接切换
                                    isExpanded.toggle()
                                }) {
                                    Text(isExpanded ? "收起" : "查看更多")
                                        .font(.caption)
                                        .foregroundColor(.blue)
                                }
                            }
                        }
                    }
                }
            }
        }
        .padding(12)
        .background(Color.gray.opacity(0.1))
        .cornerRadius(12)
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .stroke(Color.gray.opacity(0.3), lineWidth: 1)
        )
    }
}

// 消息详情 Sheet
struct MessageDetailSheet: View {
    let message: DisplayMessage
    @Environment(\.dismiss) var dismiss

    var body: some View {
        NavigationView {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    // 基本信息
                    VStack(alignment: .leading, spacing: 12) {
                        Text("基本信息")
                            .font(.headline)
                            .foregroundColor(.secondary)

                        InfoRow(label: "类型", value: typeString(message.type))
                        InfoRow(label: "时间", value: formatDateTime(message.timestamp))
                        InfoRow(label: "UUID", value: message.id, monospaced: true)
                    }
                    .padding()
                    .background(Color.gray.opacity(0.1))
                    .cornerRadius(12)

                    // 元数据
                    if message.isAgentMessage || message.isInterrupted || (message.thinkingMetadata != nil) {
                        VStack(alignment: .leading, spacing: 12) {
                            Text("元数据")
                                .font(.headline)
                                .foregroundColor(.secondary)

                            if message.isAgentMessage {
                                Label("Agent 消息", systemImage: "cpu")
                                    .font(.caption)
                            }

                            if message.isInterrupted {
                                Label("已中断", systemImage: "pause.circle")
                                    .font(.caption)
                            }

                            if let thinkingMetadata = message.thinkingMetadata, thinkingMetadata.enabled {
                                Label("包含思考过程", systemImage: "brain")
                                    .font(.caption)
                            }
                        }
                        .padding()
                        .background(Color.gray.opacity(0.1))
                        .cornerRadius(12)
                    }

                    // 工具执行
                    if !message.toolExecutions.isEmpty {
                        VStack(alignment: .leading, spacing: 12) {
                            Text("工具执行 (\(message.toolExecutions.count))")
                                .font(.headline)
                                .foregroundColor(.secondary)

                            ForEach(message.toolExecutions) { tool in
                                VStack(alignment: .leading, spacing: 8) {
                                    HStack {
                                        Text(tool.name)
                                            .font(.system(.body, design: .monospaced))
                                            .fontWeight(.semibold)

                                        Spacer()

                                        if tool.result?.isError == true {
                                            Label("失败", systemImage: "xmark.circle.fill")
                                                .font(.caption)
                                                .foregroundColor(.red)
                                        } else if tool.result != nil {
                                            Label("成功", systemImage: "checkmark.circle.fill")
                                                .font(.caption)
                                                .foregroundColor(.green)
                                        }
                                    }

                                    if !tool.formattedInput.isEmpty {
                                        Text("输入:")
                                            .font(.caption)
                                            .foregroundColor(.secondary)
                                        Text(tool.formattedInput)
                                            .font(.system(.caption, design: .monospaced))
                                            .textSelection(.enabled)
                                    }

                                    if let result = tool.result {
                                        Text("输出:")
                                            .font(.caption)
                                            .foregroundColor(.secondary)
                                        Text(result.content)
                                            .font(.system(.caption, design: .monospaced))
                                            .textSelection(.enabled)
                                    }
                                }
                                .padding(12)
                                .background(Color.blue.opacity(0.05))
                                .cornerRadius(8)
                            }
                        }
                        .padding()
                        .background(Color.gray.opacity(0.1))
                        .cornerRadius(12)
                    }

                    // 文本内容
                    if !message.textContent.isEmpty {
                        VStack(alignment: .leading, spacing: 12) {
                            Text("消息内容")
                                .font(.headline)
                                .foregroundColor(.secondary)

                            Text(message.textContent)
                                .font(.body)
                                .textSelection(.enabled)
                        }
                        .padding()
                        .background(Color.gray.opacity(0.1))
                        .cornerRadius(12)
                    }

                    // 图片
                    if !message.images.isEmpty {
                        VStack(alignment: .leading, spacing: 12) {
                            Text("图片 (\(message.images.count))")
                                .font(.headline)
                                .foregroundColor(.secondary)

                            ForEach(message.images) { image in
                                if let imageData = Data(base64Encoded: image.data),
                                   let uiImage = UIImage(data: imageData) {
                                    Image(uiImage: uiImage)
                                        .resizable()
                                        .scaledToFit()
                                        .cornerRadius(8)
                                }
                            }
                        }
                        .padding()
                        .background(Color.gray.opacity(0.1))
                        .cornerRadius(12)
                    }
                }
                .padding()
            }
            .navigationTitle("消息详情")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("关闭") {
                        dismiss()
                    }
                }
            }
        }
    }

    private func formatDateTime(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .medium
        formatter.locale = Locale(identifier: "zh_CN")
        return formatter.string(from: date)
    }

    private func typeString(_ type: DisplayMessageType) -> String {
        switch type {
        case .user:
            return "USER"
        case .assistant:
            return "ASSISTANT"
        case .system:
            return "SYSTEM"
        }
    }
}

// 信息行组件
struct InfoRow: View {
    let label: String
    let value: String
    var monospaced: Bool = false

    var body: some View {
        HStack(alignment: .top) {
            Text(label)
                .foregroundColor(.secondary)
                .frame(width: 80, alignment: .leading)

            Text(value)
                .font(monospaced ? .system(.body, design: .monospaced) : .body)
                .textSelection(.enabled)
        }
    }
}

#Preview {
    NavigationStack {
        SessionDetailView(sessionId: "test-session-id")
    }
}
