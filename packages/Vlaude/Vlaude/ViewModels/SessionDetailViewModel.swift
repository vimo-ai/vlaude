//
//  SessionDetailViewModel.swift
//  Vlaude
//
//  Created by Claude on 2025/11/16.
//

import Foundation
import Combine

@MainActor
class SessionDetailViewModel: ObservableObject {
    @Published var session: Session?
    @Published var displayMessages: [DisplayMessage] = []
    @Published var isLoading = false
    @Published var isLoadingMore = false
    @Published var errorMessage: String?
    @Published var hasMore = false
    @Published var isWaitingForResponse = false  // Remote 模式等待响应
    // 状态栏数据（初始显示占位数据，等待 WebSocket 推送真实数据）
    @Published var statusData: SessionStatusData = SessionStatusData(
        connected: true,
        mode: .local,
        contextLength: 0,
        contextPercentage: 0,
        inputTokens: 0,
        outputTokens: 0,
        timestamp: Date()
    )

    private let client = VlaudeClient.shared
    private let wsManager = WebSocketManager.shared
    private let messageTransformer = MessageTransformer()
    private var rawMessages: [Message] = []  // 保存原始消息用于转换
    private var currentOffset = 0
    private let pageSize = 20 // 改为每次加载 20 条
    private var currentSessionId: String?
    private var loadMessagesTask: Task<Void, Never>?

    // clientMessageId 去重：存储待确认的消息 (clientMessageId -> 乐观更新的消息索引)
    private var pendingMessages: [String: Int] = [:]


    func loadSessionDetail(sessionId: String) async {
        isLoading = true
        errorMessage = nil

        do {
            session = try await client.getSessionDetail(sessionId: sessionId)
            await loadMessages(sessionId: sessionId, reset: true)

            // 订阅 WebSocket 实时消息
            subscribeToSession(sessionId)
        } catch {
            errorMessage = error.localizedDescription
        }

        isLoading = false
    }

    // MARK: - WebSocket 实时推送

    func subscribeToSession(_ sessionId: String) {
        guard let session = session else {
            print("⚠️ [SessionDetailViewModel] 无法订阅：session 未加载")
            return
        }

        // 取消之前的订阅
        if let oldSessionId = currentSessionId {
            wsManager.unsubscribeFromSession(oldSessionId)
        }

        currentSessionId = sessionId

        let projectPath = session.project?.path ?? ""

        // 注意：这里只订阅消息推送，不加入会话
        // 只有在发送消息时才会触发 join（通知 CLI 进入 remote 模式）
        wsManager.subscribeToSession(sessionId, projectPath: projectPath)

        // 监听新消息事件
        wsManager.on(.messageNew) { [weak self] wsMessage in
            guard let self = self,
                  wsMessage.sessionId == sessionId,
                  let newMessage = wsMessage.message else {
                return
            }

            Task { @MainActor in
                print("📨 [SessionDetailViewModel] 收到新消息推送: \(newMessage.id), type=\(newMessage.type)")

                // 收到 assistant 响应，隐藏 loading
                if newMessage.type == "assistant" {
                    self.isWaitingForResponse = false
                }

                // clientMessageId 去重逻辑
                if let clientMsgId = newMessage.clientMessageId,
                   let pendingIndex = self.pendingMessages[clientMsgId] {
                    // 找到匹配的乐观更新消息，用真实消息替换
                    print("✅ [SessionDetailViewModel] clientMessageId 匹配成功: \(clientMsgId)")
                    self.rawMessages[pendingIndex] = newMessage
                    self.pendingMessages.removeValue(forKey: clientMsgId)
                    self.displayMessages = self.messageTransformer.transform(messages: self.rawMessages)
                    return
                }

                // 常规 uuid 去重
                if !self.rawMessages.contains(where: { $0.id == newMessage.id }) {
                    self.rawMessages.append(newMessage)
                    // 重新转换所有消息
                    self.displayMessages = self.messageTransformer.transform(messages: self.rawMessages)
                } else {
                    print("⚠️ [SessionDetailViewModel] 消息已存在，跳过: \(newMessage.id)")
                }
            }
        }

        // 监听 statusline 指标更新（通过 NotificationCenter）
        NotificationCenter.default.addObserver(
            forName: NSNotification.Name("StatuslineMetricsUpdate"),
            object: nil,
            queue: .main
        ) { [weak self] notification in
            guard let self = self,
                  let userInfo = notification.userInfo,
                  let notificationSessionId = userInfo["sessionId"] as? String,
                  notificationSessionId == sessionId else {
                return
            }

            // 更新状态数据
            let connected = userInfo["connected"] as? Bool ?? false
            let mode = (userInfo["mode"] as? String).flatMap { ConnectionMode(rawValue: $0) }
            let contextLength = userInfo["contextLength"] as? Int
            let contextPercentage = userInfo["contextPercentage"] as? Double
            let inputTokens = userInfo["inputTokens"] as? Int
            let outputTokens = userInfo["outputTokens"] as? Int

            self.statusData = SessionStatusData(
                connected: connected,
                mode: mode,
                contextLength: contextLength,
                contextPercentage: contextPercentage,
                inputTokens: inputTokens,
                outputTokens: outputTokens,
                timestamp: Date()
            )
        }
    }

    // MARK: - 发送消息

    func sendMessage(_ text: String) {
        guard let sessionId = currentSessionId else {
            print("⚠️ [SessionDetailViewModel] 无法发送消息：未订阅任何会话")
            return
        }

        guard let session = session else {
            print("⚠️ [SessionDetailViewModel] 无法发送消息：session 未加载")
            return
        }

        let projectPath = session.project?.path ?? ""

        // 生成 clientMessageId 用于去重
        let clientMessageId = UUID().uuidString

        print("📤 [SessionDetailViewModel] 发送消息: sessionId=\(sessionId), clientMsgId=\(clientMessageId)")

        // 乐观更新：立即添加用户消息到本地列表
        let userMessage = Message(
            uuid: UUID().uuidString,
            type: "user",
            timestamp: ISO8601DateFormatter().string(from: Date()),
            sessionId: sessionId,
            parentUuid: nil,
            message: MessageInner(
                role: "user",
                content: .string(text)
            ),
            contentBlocks: nil,
            isSidechain: nil,
            userType: nil,
            cwd: nil,
            version: nil,
            gitBranch: nil,
            requestId: nil,
            agentId: nil,
            isApiErrorMessage: nil,
            toolUseResult: nil,
            thinkingMetadata: nil,
            isVisibleInTranscriptOnly: nil,
            isCompactSummary: nil,
            isMeta: nil,
            subtype: nil,
            level: nil,
            systemContent: nil,
            toolUseID: nil,
            hookCount: nil,
            hookInfos: nil,
            hookErrors: nil,
            preventedContinuation: nil,
            stopReason: nil,
            hasOutput: nil,
            error: nil,
            retryInMs: nil,
            retryAttempt: nil,
            maxRetries: nil,
            cause: nil,
            logicalParentUuid: nil,
            compactMetadata: nil,
            summary: nil,
            leafUuid: nil,
            operation: nil,
            messageId: nil,
            snapshot: nil,
            isSnapshotUpdate: nil,
            mergedToolExecutions: [],
            clientMessageId: clientMessageId  // 携带 clientMessageId
        )

        // 记录 pending 状态（存储消息索引，用于后续替换）
        let messageIndex = rawMessages.count
        pendingMessages[clientMessageId] = messageIndex

        rawMessages.append(userMessage)
        // 重新转换所有消息
        displayMessages = messageTransformer.transform(messages: rawMessages)

        // 发送消息前先加入会话（触发 CLI 进入 remote 模式）
        wsManager.joinSession(sessionId, projectPath: projectPath)

        // 显示等待响应状态
        isWaitingForResponse = true

        // 发送消息到 Server，携带 clientMessageId
        wsManager.sendMessage(text, sessionId: sessionId, clientMessageId: clientMessageId)
    }

    func unsubscribeFromCurrentSession() {
        if let sessionId = currentSessionId {
            wsManager.unsubscribeFromSession(sessionId)
        }
        wsManager.off(.messageNew)
        currentSessionId = nil
    }

    deinit {
        // deinit 不能访问 @MainActor 方法，需要直接调用
        if let sessionId = currentSessionId {
            WebSocketManager.shared.unsubscribeFromSession(sessionId)
        }
        WebSocketManager.shared.off(.messageNew)
    }

    func loadMessages(sessionId: String, reset: Bool = false) async {
        // 防止重复加载
        if loadMessagesTask != nil {
            return
        }

        loadMessagesTask = Task {
            if reset {
                currentOffset = 0
                rawMessages = []
                messageTransformer.clearCache()
            }

            isLoadingMore = true
            errorMessage = nil

            // 使用 defer 确保状态一定会被重置
            defer {
                isLoadingMore = false
                loadMessagesTask = nil
            }

            do {
                // 检查是否被取消
                try Task.checkCancellation()

                print("📱 [SessionDetailViewModel] 开始加载消息: sessionId=\(sessionId), offset=\(currentOffset), limit=\(pageSize), order=desc")

                let projectPath = session?.project?.path ?? ""

                // 使用倒序（desc）加载最新消息
                let result = try await client.getSessionMessages(
                    sessionId: sessionId,
                    projectPath: projectPath,
                    limit: pageSize,
                    offset: currentOffset,
                    order: "desc"
                )

                // 再次检查取消状态(请求完成后)
                try Task.checkCancellation()

                print("📱 [SessionDetailViewModel] 成功获取消息: count=\(result.messages.count), total=\(result.total), hasMore=\(result.hasMore)")

                // 新消息添加到数组末尾（因为后端已经倒序，最新的在前面，我们需要反转后追加）
                if reset {
                    // 首次加载：直接反转后赋值（最新消息在底部）
                    rawMessages = result.messages.reversed()
                } else {
                    // 加载更早消息：反转后插入到顶部
                    rawMessages.insert(contentsOf: result.messages.reversed(), at: 0)
                }

                // 使用 MessageTransformer 转换消息
                displayMessages = messageTransformer.transform(messages: rawMessages)

                hasMore = result.hasMore
                currentOffset += result.messages.count

                print("📱 [SessionDetailViewModel] 当前总消息数: \(rawMessages.count), 显示消息数: \(displayMessages.count)")
            } catch is CancellationError {
                // Task 被取消,静默处理
                print("⚠️ [SessionDetailViewModel] 加载消息被取消")
            } catch {
                print("❌ [SessionDetailViewModel] 错误: \(error)")
                errorMessage = error.localizedDescription
            }
        }

        await loadMessagesTask?.value
    }
}
