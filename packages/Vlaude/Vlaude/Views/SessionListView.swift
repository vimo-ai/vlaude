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
    @State private var showingCreateAlert = false
    @State private var newSessionPrompt = ""
    @State private var navigateToSession: String?

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
            // 空状态
            else if viewModel.sessions.isEmpty && !viewModel.isLoading {
                VStack(spacing: 16) {
                    Image(systemName: "bubble.left.and.bubble.right")
                        .font(.system(size: 48))
                        .foregroundColor(.gray)
                    Text("暂无会话")
                        .foregroundColor(.secondary)
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
            ToolbarItem(placement: .navigationBarTrailing) {
                Button {
                    showingCreateAlert = true
                } label: {
                    Label("新建对话", systemImage: "plus")
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
    }

    private func createNewSession() async {
        let prompt = newSessionPrompt.trimmingCharacters(in: .whitespacesAndNewlines)
        let finalPrompt = prompt.isEmpty ? nil : prompt

        // 清空输入框
        newSessionPrompt = ""

        // 创建会话
        if let session = await viewModel.createSession(projectPath: projectPath, prompt: finalPrompt) {
            // 创建成功,导航到会话详情
            navigateToSession = session.sessionId
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
