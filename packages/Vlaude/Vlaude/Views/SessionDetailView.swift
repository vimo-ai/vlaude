//
//  SessionDetailView.swift
//  Vlaude
//
//  Created by Claude on 2025/11/16.
//

import SwiftUI
import MarkdownUI
import Combine

struct SessionDetailView: View {
    let sessionId: String
    let projectPath: String

    @StateObject private var viewModel = SessionDetailViewModel()
    @State private var inputText = ""
    @State private var selectedMessageForDetail: DisplayMessage?
    @State private var isNearBottom: Bool = true   // 用户是否在底部附近

    // 权限请求错误状态（审批按钮已移至 ToolView 内嵌方式）
    @State private var showTimeoutError = false
    @State private var showExpiredError = false
    @State private var errorMessage = ""
    @State private var navigateToChildSession: String?

    var body: some View {
        mainContent
            .navigationTitle(String(sessionId.prefix(8)))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { toolbarContent }
            .task {
                await viewModel.loadSessionDetail(sessionId: sessionId, projectPath: projectPath)
            }
            .sheet(item: $selectedMessageForDetail) { message in
                MessageDetailSheet(message: message)
            }
            .modifier(ApprovalErrorModifiers(
                showTimeoutError: $showTimeoutError,
                showExpiredError: $showExpiredError,
                errorMessage: $errorMessage,
                sessionId: sessionId,
                viewModel: viewModel
            ))
            .navigationDestination(item: $navigateToChildSession) { childId in
                SessionDetailView(sessionId: childId, projectPath: projectPath)
            }
    }

    // MARK: - 主内容区域

    @ViewBuilder
    private var mainContent: some View {
        VStack(spacing: 0) {
            messageListContent
            Divider()
            SessionStatusBar(statusData: viewModel.statusData)
            MessageInputView(text: $inputText) {
                sendMessage()
            }
        }
    }

    // MARK: - 消息列表内容

    @ViewBuilder
    private var messageListContent: some View {
        if viewModel.isLoading {
            loadingView
        } else if let error = viewModel.errorMessage {
            errorView(error)
        } else if viewModel.displayMessages.isEmpty {
            emptyView
        } else {
            messageScrollView
        }
    }

    private var loadingView: some View {
        VStack {
            Spacer()
            ProgressView("加载中...")
            Spacer()
        }
    }

    private func errorView(_ error: String) -> some View {
        VStack {
            Spacer()
            VStack(spacing: 16) {
                Image(systemName: "exclamationmark.triangle")
                    .font(.system(size: 48))
                    .foregroundColor(.orange)
                Text(error)
                    .foregroundColor(.secondary)
                Button("重试") {
                    Task {
                        await viewModel.loadSessionDetail(sessionId: sessionId, projectPath: projectPath)
                    }
                }
                .buttonStyle(.bordered)
            }
            Spacer()
        }
    }

    private var emptyView: some View {
        VStack {
            Spacer()
            VStack(spacing: 16) {
                Image(systemName: "message")
                    .font(.system(size: 48))
                    .foregroundColor(.gray)
                Text("暂无消息")
                    .foregroundColor(.secondary)
            }
            Spacer()
        }
    }

    private var messageScrollView: some View {
        VStack(spacing: 0) {
            // Turn-Based Pagination 保证历史加载包含完整 Turn，TurnBuilder 一定能构建
            if !viewModel.turnBuilder.turns.isEmpty {
                timelineScrollView
            } else {
                legacyMessageScrollView
            }
        }
    }

    // V2: Timeline 滚动视图
    private var timelineScrollView: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(spacing: 0) {
                    LazyVStack(spacing: 16) {
                        loadMoreButton

                        SessionTimelineView(
                            turnBuilder: viewModel.turnBuilder,
                            sessionId: sessionId,
                            pendingApprovalToolId: viewModel.pendingApprovalToolId(),
                            approvalResponseState: viewModel.approvalResponseState,
                            onApprovalAction: { action in
                                viewModel.sendApprovalResponse(action: action)
                            }
                        )
                    }
                    .padding()

                    // 底部哨兵：在 LazyVStack 外部，保证始终渲染
                    Color.clear
                        .frame(height: 1)
                        .id("timeline-bottom")
                        .background(
                            GeometryReader { geo in
                                Color.clear.preference(
                                    key: BottomVisibleKey.self,
                                    value: geo.frame(in: .named("timelineScroll")).maxY
                                )
                            }
                        )
                }
            }
            .coordinateSpace(name: "timelineScroll")
            .onPreferenceChange(BottomVisibleKey.self) { bottomY in
                if bottomY > 0 {
                    isNearBottom = bottomY < UIScreen.main.bounds.height + 100
                }
            }
            .onAppear {
                scrollToLastTurn(proxy: proxy)
            }
            // 内容变化时，仅在用户处于底部附近才自动滚动
            .onReceive(
                viewModel.turnBuilder.objectWillChange
                    .debounce(for: .milliseconds(300), scheduler: RunLoop.main)
            ) { _ in
                if isNearBottom {
                    scrollToLastTurn(proxy: proxy)
                }
            }
        }
    }

    // 旧版消息列表（回退用）
    private var legacyMessageScrollView: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 16) {
                    loadMoreButton
                    messageList
                    waitingIndicator
                }
                .padding()
            }
            .onAppear {
                scrollToLastMessage(proxy: proxy)
            }
            .onChange(of: viewModel.displayMessages.count) { oldCount, newCount in
                if newCount > oldCount {
                    scrollToLastMessage(proxy: proxy)
                }
            }
            .onChange(of: viewModel.isWaitingForResponse) { oldValue, newValue in
                if newValue {
                    scrollToWaitingIndicator(proxy: proxy)
                }
            }
        }
    }

    @ViewBuilder
    private var loadMoreButton: some View {
        if viewModel.hasMore {
            Button {
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
            .disabled(viewModel.isLoadingMore)
            .padding()
            .id("loadMoreButton")
        }
    }

    private var messageList: some View {
        ForEach(viewModel.displayMessages) { message in
            DisplayMessageBubble(
                message: message,
                sessionId: sessionId,
                pendingApprovalToolId: viewModel.pendingApprovalToolId(),
                approvalResponseState: viewModel.approvalResponseState,
                onApprovalAction: { action in
                    viewModel.sendApprovalResponse(action: action)
                }
            )
            .id(message.id)
            .contentShape(Rectangle())
            .onTapGesture(count: 2) {
                selectedMessageForDetail = message
            }
        }
    }

    @ViewBuilder
    private var waitingIndicator: some View {
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

    // MARK: - Toolbar

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .principal) {
            HStack(spacing: 6) {
                Text(String(sessionId.prefix(8)))
                    .font(.headline)
                if viewModel.session?.inEterm == true {
                    Image(systemName: "terminal.fill")
                        .font(.system(size: 12))
                        .foregroundColor(.green)
                }
                if viewModel.session?.sessionType == "subagent" {
                    Image(systemName: "cpu")
                        .font(.system(size: 12))
                        .foregroundColor(.indigo)
                }
                if let count = viewModel.session?.childrenCount, count > 0 {
                    HStack(spacing: 2) {
                        Image(systemName: "arrow.triangle.branch")
                            .font(.system(size: 10))
                        Text("\(count)")
                            .font(.system(size: 10, weight: .medium))
                    }
                    .foregroundColor(.indigo)
                }
            }
        }
        ToolbarItem(placement: .topBarTrailing) {
            HStack(spacing: 8) {
                // Continuation chain: prev/next
                if let prevId = viewModel.session?.continuationPrevId {
                    Button {
                        navigateToChildSession = prevId
                    } label: {
                        Image(systemName: "chevron.left")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundColor(.orange)
                    }
                }
                if let nextIds = viewModel.session?.continuationNextIds, !nextIds.isEmpty {
                    if nextIds.count == 1 {
                        Button {
                            navigateToChildSession = nextIds[0]
                        } label: {
                            Image(systemName: "chevron.right")
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundColor(.orange)
                        }
                    } else {
                        Menu {
                            ForEach(nextIds, id: \.self) { nextId in
                                Button {
                                    navigateToChildSession = nextId
                                } label: {
                                    Label(String(nextId.prefix(8)), systemImage: "arrow.right")
                                }
                            }
                        } label: {
                            HStack(spacing: 1) {
                                Image(systemName: "chevron.right")
                                    .font(.system(size: 12, weight: .semibold))
                                Text("\(nextIds.count)")
                                    .font(.system(size: 10, weight: .medium))
                            }
                            .foregroundColor(.orange)
                        }
                    }
                }
                // Subagent children
                if let childIds = viewModel.session?.childSessionIds, !childIds.isEmpty {
                    Menu {
                        ForEach(childIds, id: \.self) { childId in
                            Button {
                                navigateToChildSession = childId
                            } label: {
                                Label(String(childId.prefix(8)), systemImage: "cpu")
                            }
                        }
                    } label: {
                        HStack(spacing: 2) {
                            Image(systemName: "arrow.triangle.branch")
                                .font(.system(size: 12))
                            Text("\(childIds.count)")
                                .font(.system(size: 12, weight: .medium))
                        }
                        .foregroundColor(.indigo)
                    }
                }
            }
        }
    }

    // MARK: - Helper Methods

    private func scrollToLastTurn(proxy: ScrollViewProxy) {
        if let lastTurn = viewModel.turnBuilder.turns.last {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                proxy.scrollTo(lastTurn.id, anchor: .bottom)
            }
        }
    }

    private func scrollToLastMessage(proxy: ScrollViewProxy) {
        if let lastMessage = viewModel.displayMessages.last {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                proxy.scrollTo(lastMessage.id, anchor: .bottom)
            }
        }
    }

    private func scrollToWaitingIndicator(proxy: ScrollViewProxy) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
            withAnimation {
                proxy.scrollTo("waitingIndicator", anchor: .bottom)
            }
        }
    }

    private func sendMessage() {
        print("🔴 [SessionDetailView.sendMessage] 被调用, inputText.count=\(inputText.count)")
        let message = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !message.isEmpty else {
            print("🔴 [SessionDetailView.sendMessage] 消息为空，return")
            return
        }

        print("🔴 [SessionDetailView.sendMessage] 调用 viewModel.sendMessage, text=\(message.prefix(30))...")
        viewModel.sendMessage(message)
        inputText = ""
        print("🔴 [SessionDetailView.sendMessage] inputText 已清空")
    }
}

// MARK: - Approval Error Modifiers

/// 封装审批错误相关的修饰符（超时/过期/SDK错误）
/// 审批按钮已移至 ToolView 内嵌方式，由 SessionDetailViewModel 管理
private struct ApprovalErrorModifiers: ViewModifier {
    @Binding var showTimeoutError: Bool
    @Binding var showExpiredError: Bool
    @Binding var errorMessage: String
    let sessionId: String
    let viewModel: SessionDetailViewModel

    func body(content: Content) -> some View {
        content
            .onReceive(NotificationCenter.default.publisher(for: NSNotification.Name("ApprovalTimeout"))) { notification in
                handleApprovalTimeout(notification)
            }
            .onReceive(NotificationCenter.default.publisher(for: NSNotification.Name("ApprovalExpired"))) { notification in
                handleApprovalExpired(notification)
            }
            .onReceive(NotificationCenter.default.publisher(for: NSNotification.Name("SDKError"))) { notification in
                handleSDKError(notification)
            }
            .alert("权限请求超时", isPresented: $showTimeoutError) {
                Button("确定", role: .cancel) {
                    showTimeoutError = false
                }
            } message: {
                Text(errorMessage)
            }
            .alert("操作失败", isPresented: $showExpiredError) {
                Button("确定", role: .cancel) {
                    showExpiredError = false
                }
            } message: {
                Text(errorMessage)
            }
    }

    private func handleApprovalTimeout(_ notification: Notification) {
        if let message = notification.userInfo?["message"] as? String {
            errorMessage = message
            showTimeoutError = true
        }
    }

    private func handleApprovalExpired(_ notification: Notification) {
        if let message = notification.userInfo?["message"] as? String {
            errorMessage = message
            showExpiredError = true
        }
    }

    private func handleSDKError(_ notification: Notification) {
        if let sessionIdFromError = notification.userInfo?["sessionId"] as? String,
           sessionIdFromError == sessionId,
           let _ = notification.userInfo?["errorType"] as? String,
           let errorMsg = notification.userInfo?["errorMessage"] as? String {
            viewModel.isWaitingForResponse = false
            errorMessage = "处理失败: \(errorMsg)"
            showExpiredError = true
        }
    }
}

// 新的 DisplayMessage 气泡组件
struct DisplayMessageBubble: View {
    let message: DisplayMessage
    let sessionId: String
    var pendingApprovalToolId: String? = nil
    var approvalResponseState: ApprovalResponseState = .none
    var onApprovalAction: ((String) -> Void)? = nil
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
                        ToolExecutionBubble(
                            execution: toolExecution,
                            sessionId: sessionId,
                            isActiveApproval: toolExecution.id == pendingApprovalToolId,
                            approvalResponseState: toolExecution.id == pendingApprovalToolId ? approvalResponseState : .none,
                            onApprovalAction: toolExecution.id == pendingApprovalToolId ? onApprovalAction : nil
                        )
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

// 工具执行气泡组件 - 根据工具类型分发到专用视图
struct ToolExecutionBubble: View {
    let execution: ToolExecution
    let sessionId: String
    var isActiveApproval: Bool = false
    var approvalResponseState: ApprovalResponseState = .none
    var onApprovalAction: ((String) -> Void)? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            switch execution.name {
            case "Bash":
                BashToolView(
                    execution: execution,
                    isActiveApproval: isActiveApproval,
                    approvalResponseState: approvalResponseState,
                    onApprovalAction: onApprovalAction
                )
            case "Read":
                ReadToolView(execution: execution)
            case "Grep":
                GrepToolView(execution: execution)
            case "Glob":
                GlobToolView(execution: execution)
            case "Write":
                WriteToolView(execution: execution)
            case "Edit":
                EditToolView(execution: execution)
            case "TodoWrite":
                TodoWriteToolView(execution: execution)
            case "AskUserQuestion":
                AskUserQuestionToolView(execution: execution, sessionId: sessionId)
            case "Task":
                TaskToolView(execution: execution)
            case "WebSearch":
                WebSearchToolView(execution: execution)
            case "WebFetch":
                WebFetchToolView(execution: execution)
            case let name where name.hasPrefix("mcp__"):
                MCPToolView(execution: execution)
            default:
                GenericToolView(execution: execution)
            }

            // 通用审批（Bash 已内置，其他工具在此统一处理）
            if execution.name != "Bash" {
                if isActiveApproval, let onApprove = onApprovalAction {
                    // 活跃审批：按钮/spinner
                    ApprovalButtonsView(responseState: approvalResponseState, onApprove: onApprove)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                } else if execution.approvalStatus != .none {
                    // 终态 badge
                    ApprovalStatusBadge(status: execution.approvalStatus)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                }
            }
        }
    }
}

// 消息详情 Sheet
struct MessageDetailSheet: View {
    let message: DisplayMessage
    @Environment(\.dismiss) var dismiss

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

                            // 根据内容类型选择渲染方式
                            if hasMarkdown {
                                // Markdown 内容
                                Markdown(message.textContent)
                                    .markdownTheme(.claudeCode)
                                    .markdownCodeSyntaxHighlighter(HighlightrCodeSyntaxHighlighter())
                                    .textSelection(.enabled)
                            } else {
                                // 普通文本
                                Text(message.textContent)
                                    .font(.body)
                                    .textSelection(.enabled)
                            }
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

// MARK: - Bottom Visible PreferenceKey

/// 用于检测底部哨兵在 ScrollView 中的 Y 位置
private struct BottomVisibleKey: PreferenceKey {
    static var defaultValue: CGFloat = .infinity
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = nextValue()
    }
}

