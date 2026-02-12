//
//  SessionListView.swift
//  Vlaude
//
//  Created by Claude on 2025/11/16.
//

import SwiftUI

struct SessionListView: View {
    // MARK: - Properties

    let projectPath: String
    let projectName: String

    @StateObject private var viewModel: SessionListViewModel
    @ObservedObject private var wsClient = VlaudeWebSocketClient.shared

    @State private var showingCreateAlert = false
    @State private var newSessionPrompt = ""
    @State private var navigateToSession: String?
    @State private var showingEtermAlert = false
    @State private var pendingRequestId: String?

    // MARK: - Initialization

    init(projectPath: String, projectName: String) {
        self.projectPath = projectPath
        self.projectName = projectName
        // ViewModel 在初始化时就拥有 projectPath
        _viewModel = StateObject(wrappedValue: SessionListViewModel(projectPath: projectPath))
    }

    // MARK: - Body

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
                            await viewModel.loadSessions(reset: true)
                        }
                    }
                    .buttonStyle(.bordered)
                }
            }
            // 空状态
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
                    await viewModel.loadSessions(reset: true)
                }
            }
            // 列表
            else {
                List {
                    ForEach(viewModel.sessions) { session in
                        NavigationLink {
                            SessionDetailView(sessionId: session.id, projectPath: projectPath)
                        } label: {
                            SessionRow(session: session)
                        }
                    }

                    // 加载更多
                    if viewModel.hasMore {
                        HStack {
                            Spacer()
                            Button {
                                Task {
                                    await viewModel.loadSessions(reset: false)
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
                    await viewModel.loadSessions(reset: true)
                }
            }

            // 首次加载 loading
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
                        .fill(wsClient.isEtermOnline ? Color.green : Color.gray)
                        .frame(width: 8, height: 8)
                    Text(wsClient.isEtermOnline ? "ETerm" : "SDK")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
            }

            // 新建对话按钮
            ToolbarItem(placement: .navigationBarTrailing) {
                Button {
                    if wsClient.isEtermOnline {
                        Task {
                            await createEtermSession()
                        }
                    } else {
                        showingCreateAlert = true
                    }
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: wsClient.isEtermOnline ? "terminal" : "plus")
                        if wsClient.isEtermOnline {
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
            // ViewModel 统一管理数据加载和状态订阅
            await viewModel.startListening()
        }
        .onDisappear {
            viewModel.stopListening()
        }
        .onChange(of: wsClient.isConnected) { oldValue, newValue in
            // WebSocket 重连成功后自动刷新会话列表
            if !oldValue && newValue {
                Task {
                    await viewModel.startListening()
                }
            }
        }
        .navigationDestination(item: $navigateToSession) { sessionId in
            SessionDetailView(sessionId: sessionId, projectPath: projectPath)
        }
        .onReceive(NotificationCenter.default.publisher(for: NSNotification.Name("EtermSessionCreated"))) { notification in
            guard let userInfo = notification.userInfo,
                  let requestId = userInfo["requestId"] as? String,
                  let sessionId = userInfo["sessionId"] as? String else {
                return
            }

            if let pending = pendingRequestId, pending == requestId {
                pendingRequestId = nil
                showingEtermAlert = false
                navigateToSession = sessionId
                Task {
                    await viewModel.loadSessions(reset: true)
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

    // MARK: - Actions

    /// SDK 模式创建会话
    private func createNewSession() async {
        let prompt = newSessionPrompt.trimmingCharacters(in: .whitespacesAndNewlines)
        let finalPrompt = prompt.isEmpty ? nil : prompt
        newSessionPrompt = ""

        if let result = await viewModel.createSession(prompt: finalPrompt) {
            switch result {
            case .session(let session):
                navigateToSession = session.sessionId
            case .etermPending(_, let requestId):
                pendingRequestId = requestId
                showingEtermAlert = true
            }
        }
    }

    /// ETerm 模式创建会话
    private func createEtermSession() async {
        let requestId = UUID().uuidString

        if let result = await viewModel.createSession(prompt: nil, requestId: requestId) {
            switch result {
            case .session:
                break
            case .etermPending(_, let returnedRequestId):
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
                Text(session.id)
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

                // Session Chain 标记
                if session.sessionType == "subagent" {
                    HStack(spacing: 2) {
                        Image(systemName: "cpu")
                            .font(.system(size: 9))
                        Text("子代理")
                            .font(.system(size: 9))
                    }
                    .foregroundColor(.indigo)
                    .padding(.horizontal, 4)
                    .padding(.vertical, 1)
                    .background(Color.indigo.opacity(0.1))
                    .cornerRadius(3)
                }
                if let count = session.childrenCount, count > 0 {
                    HStack(spacing: 2) {
                        Image(systemName: "arrow.triangle.branch")
                            .font(.system(size: 9))
                        Text("\(count)")
                            .font(.system(size: 9))
                    }
                    .foregroundColor(.secondary)
                }

                Spacer(minLength: 8)
                // 时间（优先用 lastModified，兼容 createdAt）
                if let ts = session.lastModified {
                    Text(formatTimestamp(ts))
                        .font(.caption)
                        .foregroundColor(.secondary)
                } else if let date = session.createdAt {
                    Text(formatDate(date))
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
            }

            HStack {
                // 消息数量
                Text("\(session.messageCount ?? 0) 条消息")
                    .font(.caption)
                    .foregroundColor(.secondary)
                Spacer()
            }

            // 显示最后一条消息预览（优先使用 V5 新字段）
            if let preview = session.lastMessagePreview {
                HStack(spacing: 4) {
                    // 消息类型图标
                    Text(session.lastMessageType == "user" ? "👤" : "🤖")
                        .font(.caption)
                    Text(preview)
                        .font(.caption)
                        .foregroundColor(.secondary)
                        .lineLimit(2)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            } else if let lastMessage = session.lastMessage {
                // 回退：使用旧的 lastMessage 字段
                Text(messagePreview(for: lastMessage))
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            // 时间戳（优先使用 V5 新字段）
            if let ts = session.lastMessageTimestamp, ts > 0 {
                Text(formatTimestamp(ts))
                    .font(.caption2)
                    .foregroundColor(.secondary)
            } else if let lastMessageTime = session.lastMessageAt {
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

    /// V4: 格式化时间戳（毫秒）
    private func formatTimestamp(_ ts: Int64) -> String {
        let date = Date(timeIntervalSince1970: Double(ts) / 1000.0)
        return formatDate(date)
    }
}

#Preview {
    NavigationStack {
        SessionListView(projectPath: "/Users/example/project", projectName: "示例项目")
    }
}
