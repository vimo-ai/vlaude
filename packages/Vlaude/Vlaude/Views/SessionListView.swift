//
//  SessionListView.swift
//  Vlaude
//
//  Created by Claude on 2025/11/16.
//

import SwiftUI

struct SessionListView: View {
    let projectPath: String
    let projectName: String

    @StateObject private var viewModel = SessionListViewModel()
    @ObservedObject private var wsManager = WebSocketManager.shared
    @State private var showingCreateAlert = false
    @State private var newSessionPrompt = ""
    @State private var navigateToSession: String?
    @State private var showingEtermAlert = false
    @State private var pendingRequestId: String?  // 等待中的 ETerm 会话创建请求ID

    var body: some View {
        ZStack {
            // 错误状态
            if let error = viewModel.errorMessage {
                VStack(spacing: 16) {
                    Image(systemName: "exclamationmark.triangle")
                        .font(.system(size: 48))
                        .foregroundColor(.orange)
                    Text(error)
                        .foregroundColor(.secondary)
                    Button("重试") {
                        Task {
                            await viewModel.loadSessions(projectPath: projectPath, reset: true)
                        }
                    }
                    .buttonStyle(.bordered)
                }
            }
            // 空状态 - 使用 ScrollView 支持下拉刷新
            else if viewModel.sessions.isEmpty && !viewModel.isLoading {
                ScrollView {
                    VStack(spacing: 16) {
                        Spacer().frame(height: 100)
                        Image(systemName: "bubble.left.and.bubble.right")
                            .font(.system(size: 48))
                            .foregroundColor(.gray)
                        Text("暂无会话")
                            .foregroundColor(.secondary)
                        Text("下拉刷新")
                            .font(.caption)
                            .foregroundColor(.secondary.opacity(0.6))
                    }
                    .frame(maxWidth: .infinity)
                }
                .refreshable {
                    await viewModel.loadSessions(projectPath: projectPath, reset: true)
                }
            }
            // 列表 - 始终保持稳定
            else {
                List {
                    ForEach(viewModel.sessions) { session in
                        NavigationLink {
                            SessionDetailView(sessionId: session.sessionId)
                        } label: {
                            SessionRow(session: session)
                        }
                    }

                    // 加载更多按钮
                    if viewModel.hasMore {
                        HStack {
                            Spacer()
                            Button {
                                Task {
                                    await viewModel.loadSessions(projectPath: projectPath, reset: false)
                                }
                            } label: {
                                if viewModel.isLoadingMore {
                                    ProgressView()
                                        .progressViewStyle(.circular)
                                } else {
                                    Text("加载更多")
                                        .foregroundColor(.blue)
                                }
                            }
                            .disabled(viewModel.isLoadingMore)
                            Spacer()
                        }
                        .padding(.vertical, 8)
                    }
                }
                .refreshable {
                    await viewModel.loadSessions(projectPath: projectPath, reset: true)
                }
            }

            // 首次加载的 loading 覆盖层
            if viewModel.isLoading && viewModel.sessions.isEmpty {
                Color.black.opacity(0.1)
                    .ignoresSafeArea()
                ProgressView("加载中...")
            }
        }
        .navigationTitle(projectName)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            // ETerm 状态指示器
            ToolbarItem(placement: .navigationBarLeading) {
                HStack(spacing: 4) {
                    Circle()
                        .fill(wsManager.isEtermOnline ? Color.green : Color.gray)
                        .frame(width: 8, height: 8)
                    Text(wsManager.isEtermOnline ? "ETerm" : "SDK")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
            }

            // 新建对话按钮
            ToolbarItem(placement: .navigationBarTrailing) {
                Button {
                    if wsManager.isEtermOnline {
                        // ETerm 在线：直接创建，不需要输入 prompt
                        Task {
                            await createEtermSession()
                        }
                    } else {
                        // ETerm 离线：弹出输入框走 SDK 模式
                        showingCreateAlert = true
                    }
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: wsManager.isEtermOnline ? "terminal" : "plus")
                        if wsManager.isEtermOnline {
                            Text("新建")
                                .font(.caption)
                        }
                    }
                }
                .disabled(viewModel.isCreatingSession)
            }
        }
        .alert("新建对话", isPresented: $showingCreateAlert) {
            TextField("初始消息 (可选)", text: $newSessionPrompt)
            Button("取消", role: .cancel) {
                newSessionPrompt = ""
            }
            Button("创建") {
                Task {
                    await createNewSession()
                }
            }
        } message: {
            Text("创建新的 Claude Code 对话\n留空则发送默认消息 \"Hi\"")
        }
        .task {
            await viewModel.loadSessions(projectPath: projectPath, reset: true)
        }
        .navigationDestination(item: $navigateToSession) { sessionId in
            SessionDetailView(sessionId: sessionId)
        }
        .onReceive(NotificationCenter.default.publisher(for: NSNotification.Name("EtermSessionCreated"))) { notification in
            // 处理 ETerm 会话创建完成事件
            guard let userInfo = notification.userInfo,
                  let requestId = userInfo["requestId"] as? String,
                  let sessionId = userInfo["sessionId"] as? String else {
                return
            }

            // 检查是否是我们等待的请求
            if let pending = pendingRequestId, pending == requestId {
                print("✅ [SessionListView] 匹配到创建的会话: \(sessionId)")
                pendingRequestId = nil
                showingEtermAlert = false
                // 自动跳转到新创建的会话
                navigateToSession = sessionId
                // 刷新列表
                Task {
                    await viewModel.loadSessions(projectPath: projectPath, reset: true)
                }
            }
        }
        .overlay {
            if viewModel.isCreatingSession {
                ZStack {
                    Color.black.opacity(0.3)
                        .ignoresSafeArea()
                    VStack(spacing: 16) {
                        ProgressView()
                        Text("正在创建会话...")
                            .foregroundColor(.white)
                    }
                    .padding(24)
                    .background(Color.secondary)
                    .cornerRadius(12)
                }
            }
        }
        .alert("ETerm 创建中", isPresented: $showingEtermAlert) {
            Button("好的") {
                viewModel.clearEtermMessage()
            }
        } message: {
            Text(viewModel.etermMessage ?? "已通知 ETerm 创建会话，请在 Mac 上查看终端")
        }
    }

    /// SDK 模式创建会话（带 prompt 输入框）
    private func createNewSession() async {
        let prompt = newSessionPrompt.trimmingCharacters(in: .whitespacesAndNewlines)
        let finalPrompt = prompt.isEmpty ? nil : prompt

        // 清空输入框
        newSessionPrompt = ""

        // 创建会话
        if let result = await viewModel.createSession(projectPath: projectPath, prompt: finalPrompt) {
            switch result {
            case .session(let session):
                // SDK 模式，直接跳转到会话详情
                navigateToSession = session.sessionId

            case .etermPending(_, let requestId):
                // ETerm 模式，保存 requestId 等待 WebSocket 通知
                pendingRequestId = requestId
                showingEtermAlert = true
            }
        }
    }

    /// ETerm 模式创建会话（直接创建，不需要输入）
    private func createEtermSession() async {
        // 生成 requestId
        let requestId = UUID().uuidString

        // ETerm 模式不需要 prompt，直接创建
        if let result = await viewModel.createSession(projectPath: projectPath, prompt: nil, requestId: requestId) {
            switch result {
            case .session:
                // 理论上 ETerm 在线时不会返回 session
                break

            case .etermPending(_, let returnedRequestId):
                // ETerm 模式，保存 requestId 等待 WebSocket 通知
                pendingRequestId = returnedRequestId
                showingEtermAlert = true
            }
        }
    }
}

struct SessionRow: View {
    let session: Session

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                // Session ID
                Text(session.sessionId)
                    .font(.system(size: 11, weight: .bold, design: .monospaced))
                    .foregroundColor(.primary)
                    .lineLimit(1)

                // ETerm 状态指示器
                if session.inEterm == true {
                    Image(systemName: "terminal.fill")
                        .font(.system(size: 10))
                        .foregroundColor(.green)
                        .help("已连接到 ETerm")
                }

                Spacer(minLength: 8)
                // 创建时间
                Text(formatDate(session.createdAt))
                    .font(.caption)
                    .foregroundColor(.secondary)
            }

            HStack {
                // 消息数量
                Text("\(session.messageCount) 条消息")
                    .font(.caption)
                    .foregroundColor(.secondary)
                Spacer()
            }

            // 显示最后一条消息预览
            if let lastMessage = session.lastMessage {
                Text(messagePreview(for: lastMessage))
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            // 时间戳
            if let lastMessageTime = session.lastMessageAt {
                Text(lastMessageTime, style: .relative)
                    .font(.caption2)
                    .foregroundColor(.secondary)
            }
        }
        .padding(.vertical, 4)
    }

    // 获取角色图标
    private func roleIcon(for message: Message) -> String {
        switch message.type {
        case "user":
            return "👤"
        case "assistant":
            return "🤖"
        case "system":
            return "⚙️"
        default:
            return "💬"
        }
    }

    // 提取消息预览文本
    private func messagePreview(for message: Message) -> String {
        // Message 的 content 计算属性已经处理了所有类型的内容提取
        let text = message.content
        return text.isEmpty ? "[\(message.type)]" : text
    }

    private func formatDate(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "MM-dd HH:mm"
        return formatter.string(from: date)
    }
}

#Preview {
    NavigationStack {
        SessionListView(projectPath: "/Users/example/project", projectName: "示例项目")
    }
}
