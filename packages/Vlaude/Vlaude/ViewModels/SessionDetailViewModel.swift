//
//  SessionDetailViewModel.swift
//  Vlaude
//
//  Created by Claude on 2025/11/16.
//

import Foundation
import Combine

/// 待处理的权限请求
struct PendingApproval {
    let requestId: String
    let sessionId: String
    let toolUseId: String
    let toolName: String
    let input: [String: Any]
    let description: String
    let timestamp: Date
}

/// 审批响应状态（Session 级唯一，由 ViewModel 管理）
enum ApprovalResponseState: Equatable {
    case none           // 无审批
    case awaiting       // 等待用户决定
    case pendingAck     // 已批准，等待 ETerm ACK
    case executing      // ETerm ACK 收到，执行中
}

@MainActor
class SessionDetailViewModel: ObservableObject {
    @Published var session: Session?
    @Published var displayMessages: [DisplayMessage] = []
    @Published var turnBuilder = TurnBuilder()
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

    // Session 级单一审批状态（同一时刻只有一个 pending permission）
    @Published var currentPendingApproval: PendingApproval? = nil
    @Published var approvalResponseState: ApprovalResponseState = .none

    private let client = VlaudeClient.shared
    private let wsClient = VlaudeWebSocketClient.shared
    private let messageTransformer = MessageTransformer()
    private(set) var rawMessages: [Message] = []  // 保存原始消息用于转换
    private var nextCursor: Int?  // Turn-based 分页游标
    private var currentSessionId: String?
    private var loadMessagesTask: Task<Void, Never>?

    // 嵌套 ObservableObject 变化转发（turnBuilder 内部变化 → ViewModel.objectWillChange）
    private var turnBuilderCancellable: AnyCancellable?

    // 通知订阅 tokens
    private var approvalRequestObserver: NSObjectProtocol?
    private var approvalTimeoutObserver: NSObjectProtocol?
    private var approvalExpiredObserver: NSObjectProtocol?
    private var approvalAckObserver: NSObjectProtocol?
    private var approvalCancelledObserver: NSObjectProtocol?
    private var statuslineMetricsObserver: NSObjectProtocol?

    // WebSocket 事件 token（用于精确移除，不影响其他 ViewModel）
    private var messageNewToken: VlaudeWebSocketClient.VlaudeEventToken?

    // clientMessageId 去重：存储待确认的消息 (clientMessageId -> 乐观更新的消息索引)
    private var pendingMessages: [String: Int] = [:]

    // 当前项目路径（从 SessionListView 传入）
    private var currentProjectPath: String = ""

    // 消息批处理
    private var messageBuffer: [Message] = []
    private var batchFlushTask: Task<Void, Never>?
    private let batchInterval: UInt64 = 100_000_000 // 100ms in nanoseconds

    init() {
        // C1: 只在 turns 数量变化时转发 objectWillChange
        // Turn 内部 events 增长不再触发 ViewModel 全量刷新
        // SessionTimelineView 通过 @ObservedObject turnBuilder 直接观察
        turnBuilderCancellable = turnBuilder.$turnsCount
            .removeDuplicates()
            .sink { [weak self] _ in
                self?.objectWillChange.send()
            }
    }

    func loadSessionDetail(sessionId: String, projectPath: String) async {
        isLoading = true
        errorMessage = nil
        currentProjectPath = projectPath

        do {
            print("🔍 [loadSessionDetail] 请求 sessionId=\(sessionId), projectPath=\(projectPath)")
            session = try await client.getSessionDetail(sessionId: sessionId, projectPath: projectPath)
            print("🔍 [loadSessionDetail] 返回 session=\(session?.id ?? "nil")")
            await loadMessages(sessionId: sessionId, reset: true)

            // 订阅 WebSocket 实时消息
            subscribeToSession(sessionId)
        } catch {
            print("❌ [loadSessionDetail] 错误: \(error)")
            errorMessage = error.localizedDescription
        }

        isLoading = false
    }

    // MARK: - WebSocket 实时推送

    func subscribeToSession(_ sessionId: String) {
        // 取消之前的订阅
        if let oldSessionId = currentSessionId {
            wsClient.unsubscribeFromSession(oldSessionId)
        }

        currentSessionId = sessionId

        // 注意：这里只订阅消息推送，不加入会话
        // 只有在发送消息时才会触发 join（通知 CLI 进入 remote 模式）
        wsClient.subscribeToSession(sessionId, projectPath: currentProjectPath)

        // 查询当前 session 的 pending approvals（解决离开页面后审批丢失的问题）
        Task { @MainActor in
            let pendingApprovalStates = await wsClient.getApprovalState(sessionId: sessionId)
            // 取第一个（session 同一时刻最多一个 pending）
            guard let approvalDict = pendingApprovalStates.first,
                  let requestId = approvalDict["requestId"] as? String,
                  let toolName = approvalDict["toolName"] as? String else {
                return
            }

            // requestId 去重：如果当前已经在处理同一个请求，跳过
            if self.currentPendingApproval?.requestId == requestId { return }

            let toolUseId = approvalDict["toolUseId"] as? String ?? ""
            let description = approvalDict["description"] as? String ?? toolName
            let input = approvalDict["input"] as? [String: Any] ?? [:]

            let approval = PendingApproval(
                requestId: requestId,
                sessionId: sessionId,
                toolUseId: toolUseId,
                toolName: toolName,
                input: input,
                description: description,
                timestamp: Date()
            )
            self.currentPendingApproval = approval
            self.approvalResponseState = .awaiting
        }

        // 移除旧的 messageNew 监听（避免叠加）
        if let token = messageNewToken {
            wsClient.off(token: token)
            messageNewToken = nil
        }

        // 监听新消息事件（保存 token 用于精确移除）
        messageNewToken = wsClient.on(.messageNew) { [weak self] wsMessage in
            guard let self = self,
                  wsMessage.sessionId == sessionId,
                  let newMessage = wsMessage.message else {
                return
            }

            Task { @MainActor in
                let df = DateFormatter(); df.dateFormat = "HH:mm:ss.SSS"
                print("[DIAG] recv ts=\(df.string(from: Date())) sid=\(sessionId.prefix(8)) uuid=\(newMessage.id.prefix(8)) role=\(newMessage.type)")

                // 检测 interrupted 消息 → 取消当前 pending 审批
                if newMessage.content.contains("interrupted") {
                    self.clearCurrentApproval(terminalStatus: .cancelled)
                }

                self.bufferMessage(newMessage)
            }
        }

        // 移除旧的 statusline observer（避免叠加）
        if let observer = statuslineMetricsObserver {
            NotificationCenter.default.removeObserver(observer)
            statuslineMetricsObserver = nil
        }

        // 监听 statusline 指标更新（通过 NotificationCenter，保存 observer 用于移除）
        statuslineMetricsObserver = NotificationCenter.default.addObserver(
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

        // 监听权限请求
        setupApprovalObservers(sessionId: sessionId)
    }

    // MARK: - 权限审批

    private func setupApprovalObservers(sessionId: String) {
        // 移除旧的观察者
        removeApprovalObservers()

        // 监听权限请求 → 直接设置 session 级单一审批
        approvalRequestObserver = NotificationCenter.default.addObserver(
            forName: NSNotification.Name("ApprovalRequest"),
            object: nil,
            queue: .main
        ) { [weak self] notification in
            guard let self = self,
                  let userInfo = notification.userInfo,
                  let requestSessionId = userInfo["sessionId"] as? String else {
                return
            }

            let trimmedRequestSessionId = requestSessionId.trimmingCharacters(in: .whitespacesAndNewlines)
            let trimmedSessionId = sessionId.trimmingCharacters(in: .whitespacesAndNewlines)
            guard trimmedRequestSessionId == trimmedSessionId else { return }

            guard let requestId = userInfo["requestId"] as? String,
                  let rawToolName = userInfo["toolName"] as? String,
                  let rawDescription = userInfo["description"] as? String else {
                return
            }

            let toolName = rawToolName.trimmingCharacters(in: .whitespacesAndNewlines)
            let description = rawDescription.trimmingCharacters(in: .whitespacesAndNewlines)
            let input = userInfo["input"] as? [String: Any] ?? [:]
            let rawToolUseId = userInfo["toolUseID"] as? String ?? ""
            let effectiveToolUseId = rawToolUseId.trimmingCharacters(in: .whitespacesAndNewlines)

            let df = DateFormatter(); df.dateFormat = "HH:mm:ss.SSS"
            print("[DIAG] hook-recv ts=\(df.string(from: Date())) event=PermissionRequest sid=\(trimmedSessionId.prefix(8)) tool=\(toolName) toolUseId=\(effectiveToolUseId.isEmpty ? "?" : String(effectiveToolUseId.prefix(12)))")

            // Session 级单一审批：直接设置
            self.currentPendingApproval = PendingApproval(
                requestId: requestId,
                sessionId: trimmedRequestSessionId,
                toolUseId: effectiveToolUseId,
                toolName: toolName,
                input: input,
                description: description,
                timestamp: Date()
            )
            self.approvalResponseState = .awaiting
        }

        // 监听审批超时 → 标记终态，清空审批
        approvalTimeoutObserver = NotificationCenter.default.addObserver(
            forName: NSNotification.Name("ApprovalTimeout"),
            object: nil,
            queue: .main
        ) { [weak self] notification in
            guard let self = self,
                  let userInfo = notification.userInfo,
                  let requestId = userInfo["requestId"] as? String,
                  self.currentPendingApproval?.requestId == requestId else {
                return
            }
            self.clearCurrentApproval(terminalStatus: .timeout)
        }

        // 监听审批过期（延迟响应）→ 标记终态，清空审批
        approvalExpiredObserver = NotificationCenter.default.addObserver(
            forName: NSNotification.Name("ApprovalExpired"),
            object: nil,
            queue: .main
        ) { [weak self] notification in
            guard let self = self,
                  let userInfo = notification.userInfo,
                  let requestId = userInfo["requestId"] as? String,
                  self.currentPendingApproval?.requestId == requestId else {
                return
            }
            self.clearCurrentApproval(terminalStatus: .timeout)
        }

        // 监听 approval-ack（ETerm 确认收到审批响应）
        approvalAckObserver = NotificationCenter.default.addObserver(
            forName: NSNotification.Name("ApprovalAck"),
            object: nil,
            queue: .main
        ) { [weak self] notification in
            guard let self = self,
                  let userInfo = notification.userInfo,
                  let success = userInfo["success"] as? Bool else {
                return
            }

            if success {
                // ETerm 确认收到 → 进入 executing 状态，下一条消息到来时清空
                self.approvalResponseState = .executing
            } else {
                // ETerm 处理失败 → 清空审批
                self.currentPendingApproval = nil
                self.approvalResponseState = .none
            }
        }

        // 监听 approval-cancelled（ETerm Interrupt/PromptSubmit/ResponseComplete 导致审批过期）
        approvalCancelledObserver = NotificationCenter.default.addObserver(
            forName: NSNotification.Name("ApprovalCancelled"),
            object: nil,
            queue: .main
        ) { [weak self] notification in
            guard let self = self,
                  let userInfo = notification.userInfo,
                  let cancelledSessionId = userInfo["sessionId"] as? String,
                  cancelledSessionId == sessionId else {
                return
            }
            self.clearCurrentApproval(terminalStatus: .cancelled)
        }
    }

    private func removeApprovalObservers() {
        if let observer = approvalRequestObserver {
            NotificationCenter.default.removeObserver(observer)
            approvalRequestObserver = nil
        }
        if let observer = approvalTimeoutObserver {
            NotificationCenter.default.removeObserver(observer)
            approvalTimeoutObserver = nil
        }
        if let observer = approvalExpiredObserver {
            NotificationCenter.default.removeObserver(observer)
            approvalExpiredObserver = nil
        }
        if let observer = approvalAckObserver {
            NotificationCenter.default.removeObserver(observer)
            approvalAckObserver = nil
        }
        if let observer = approvalCancelledObserver {
            NotificationCenter.default.removeObserver(observer)
            approvalCancelledObserver = nil
        }
    }

    /// 清空当前审批并标记终态到对应的 ToolExecution
    private func clearCurrentApproval(terminalStatus: ToolApprovalStatus? = nil) {
        if let status = terminalStatus, let pending = currentPendingApproval {
            // 标记终态到 ToolExecution（用于历史显示）
            let toolId = pendingApprovalToolId()
            if let toolId = toolId {
                if !turnBuilder.turns.isEmpty {
                    turnBuilder.markToolTerminalStatus(toolUseId: toolId, status: status)
                } else {
                    // Legacy 模式
                    markLegacyToolTerminalStatus(toolUseId: toolId, status: status)
                }
            }
        }
        currentPendingApproval = nil
        approvalResponseState = .none
    }

    /// Legacy 模式下标记 displayMessages 中工具的终态
    private func markLegacyToolTerminalStatus(toolUseId: String, status: ToolApprovalStatus) {
        for i in 0..<displayMessages.count {
            for j in 0..<displayMessages[i].toolExecutions.count {
                if displayMessages[i].toolExecutions[j].id == toolUseId {
                    var updatedExecution = displayMessages[i].toolExecutions[j]
                    updatedExecution.approvalStatus = status
                    var updatedToolExecutions = displayMessages[i].toolExecutions
                    updatedToolExecutions[j] = updatedExecution
                    var updatedMessage = displayMessages[i]
                    updatedMessage.toolExecutions = updatedToolExecutions
                    displayMessages[i] = updatedMessage
                    return
                }
            }
        }
    }

    /// 判断某个 tool 是否是当前活跃审批的目标，返回其 toolUseId
    func pendingApprovalToolId() -> String? {
        guard let pending = currentPendingApproval else { return nil }
        if !pending.toolUseId.isEmpty { return pending.toolUseId }
        // fallback: 当前 active Turn 的最后一个无 result 的同名 tool
        return turnBuilder.findLastUnresultedToolId(name: pending.toolName)
    }

    /// 发送审批响应（不再需要 toolUseId 参数，session 只有一个审批）
    func sendApprovalResponse(action: String) {
        guard let approval = currentPendingApproval else { return }

        let toolId = pendingApprovalToolId() ?? ""

        if action == "n" {
            // 拒绝 → 标记终态，清空审批
            clearCurrentApproval(terminalStatus: .rejected)
        } else {
            // 允许（y 或 a）→ 等待 ETerm 确认
            approvalResponseState = .pendingAck
        }

        // 发送响应到服务器
        wsClient.sendApprovalResponse(
            requestId: approval.requestId,
            sessionId: approval.sessionId,
            action: action,
            toolUseId: toolId
        )
    }

    // MARK: - 发送消息

    func sendMessage(_ text: String) {
        print("📤 [ViewModel.sendMessage] 被调用, text=\(text.prefix(20))...")
        print("📤 [ViewModel.sendMessage] currentSessionId=\(currentSessionId ?? "nil")")
        print("📤 [ViewModel.sendMessage] wsClient.isConnected=\(wsClient.isConnected)")

        guard let sessionId = currentSessionId else {
            print("❌ [ViewModel.sendMessage] currentSessionId 为 nil，提前返回")
            return
        }

        // 注意：不再依赖 session 对象，只需要 sessionId 和 projectPath
        let projectPath = currentProjectPath

        // 生成 clientMessageId 用于去重
        let clientMessageId = UUID().uuidString


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
            eventType: "user_text",
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
            clientMessageId: clientMessageId,  // 携带 clientMessageId
            toolCallId: nil,
            approvalStatus: nil,
            approvalResolvedAt: nil as Int64?,
            mergedToolExecutions: []
        )

        // 记录 pending 状态（存储消息索引，用于后续替换）
        let messageIndex = rawMessages.count
        pendingMessages[clientMessageId] = messageIndex

        rawMessages.append(userMessage)
        // 跳过 transform — Timeline 模式不依赖 displayMessages 渲染
        // displayMessages 在下一次 message:new 或 loadMessages 时自然更新
        // C2: 同步到 TurnBuilder（开启新 Turn，确保 Timeline 立即显示用户消息）
        turnBuilder.processMessage(userMessage)

        // 发送消息前先加入会话（触发 CLI 进入 remote 模式）
        wsClient.joinSession(sessionId, projectPath: projectPath)

        // 发送消息到 Server，携带 clientMessageId
        wsClient.sendMessage(text, sessionId: sessionId, clientMessageId: clientMessageId)
    }

    // MARK: - 消息批处理

    /// 缓冲消息，100ms 窗口内合并为一次处理（节流模式）
    private func bufferMessage(_ message: Message) {
        messageBuffer.append(message)

        // 节流：首条消息启动 100ms 窗口，后续消息只入队不重置定时
        // 避免持续流式输出时定时器永远被重置导致 UI 冻结
        guard batchFlushTask == nil else { return }
        batchFlushTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: batchInterval)
            guard !Task.isCancelled else { return }
            self.flushMessageBuffer()
        }
    }

    /// 刷新消息缓冲区，一次性处理所有缓冲消息
    private func flushMessageBuffer() {
        guard !messageBuffer.isEmpty else { return }
        let batch = messageBuffer
        messageBuffer.removeAll()
        batchFlushTask = nil
        processBatch(batch)
    }

    /// 批量处理消息（核心：去重 + 条件 transform + 批量 TurnBuilder）
    private func processBatch(_ messages: [Message]) {
        var newMessages: [Message] = []

        for msg in messages {
            // clientMessageId 去重（乐观更新替换）
            if let clientMsgId = msg.clientMessageId,
               let pendingIndex = pendingMessages[clientMsgId] {
                rawMessages[pendingIndex] = msg
                pendingMessages.removeValue(forKey: clientMsgId)
                continue
            }

            // uuid 去重
            guard !rawMessages.contains(where: { $0.id == msg.id }) else { continue }

            rawMessages.append(msg)
            newMessages.append(msg)
        }

        // 处理新消息
        if !newMessages.isEmpty {
            turnBuilder.processMessages(newMessages)
        }

        // 新消息到达且有活跃审批 → 审批流结束，清空
        // 无论是 awaiting/pendingAck/executing，只要有新消息就说明 ETerm 侧已通过
        if approvalResponseState != .none && !newMessages.isEmpty {
            currentPendingApproval = nil
            approvalResponseState = .none
        }

        // Legacy 模式：保留 transform 逻辑
        if turnBuilder.turns.isEmpty {
            displayMessages = messageTransformer.transform(messages: rawMessages)
        }

        // 收到 assistant 响应，隐藏 loading
        if messages.contains(where: { $0.type == "assistant" }) {
            isWaitingForResponse = false
        }
    }

    func unsubscribeFromCurrentSession() {
        if let sessionId = currentSessionId {
            wsClient.unsubscribeFromSession(sessionId)
        }
        // 使用 token 精确移除，不影响其他 ViewModel 的监听
        if let token = messageNewToken {
            wsClient.off(token: token)
            messageNewToken = nil
        }
        // 移除 statusline observer
        if let observer = statuslineMetricsObserver {
            NotificationCenter.default.removeObserver(observer)
            statuslineMetricsObserver = nil
        }
        removeApprovalObservers()
        currentPendingApproval = nil
        approvalResponseState = .none
        // S4: 切换 session 时清空 TurnBuilder 和 pendingMessages，避免残留旧数据
        pendingMessages.removeAll()
        turnBuilder.clear()
        // 清理消息批处理缓冲
        batchFlushTask?.cancel()
        batchFlushTask = nil
        messageBuffer.removeAll()
        currentSessionId = nil
    }

    deinit {
        // deinit 是 nonisolated，使用专门的 nonisolated 方法
        if let sessionId = currentSessionId {
            VlaudeWebSocketClient.shared.unsubscribeFromSessionInDeinit(sessionId)
        }
        // 使用 nonisolated 方法精确移除
        if let token = messageNewToken {
            VlaudeWebSocketClient.shared.offFromDeinit(token: token)
        }

        // 清理 NotificationCenter 观察者（NotificationCenter 是线程安全的）
        if let observer = statuslineMetricsObserver {
            NotificationCenter.default.removeObserver(observer)
        }
        if let observer = approvalRequestObserver {
            NotificationCenter.default.removeObserver(observer)
        }
        if let observer = approvalTimeoutObserver {
            NotificationCenter.default.removeObserver(observer)
        }
        if let observer = approvalExpiredObserver {
            NotificationCenter.default.removeObserver(observer)
        }
        if let observer = approvalAckObserver {
            NotificationCenter.default.removeObserver(observer)
        }
        if let observer = approvalCancelledObserver {
            NotificationCenter.default.removeObserver(observer)
        }

        // 清理批处理任务
        // 注意：Task.cancel() 是线程安全的，可以在 nonisolated deinit 中调用
        batchFlushTask?.cancel()
    }

    func loadMessages(sessionId: String, reset: Bool = false) async {
        // 防止重复加载
        if loadMessagesTask != nil {
            print("⚠️ [loadMessages] loadMessagesTask != nil, 跳过 (reset=\(reset))")
            return
        }

        print("📄 [loadMessages] 开始 reset=\(reset), nextCursor=\(nextCursor?.description ?? "nil"), hasMore=\(hasMore)")

        loadMessagesTask = Task {
            if reset {
                nextCursor = nil
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

                let beforeValue = reset ? nil : nextCursor
                print("📄 [loadMessages] 请求参数: turnsLimit=3, before=\(beforeValue?.description ?? "nil")")

                // Turn-based 分页：Daemon 返回 asc 排序的完整 Turn
                let result = try await client.getSessionMessages(
                    sessionId: sessionId,
                    projectPath: currentProjectPath,
                    turnsLimit: 3,
                    before: beforeValue
                )

                // 再次检查取消状态(请求完成后)
                try Task.checkCancellation()

                print("📄 [loadMessages] 响应: messages=\(result.messages.count), hasMore=\(result.hasMore), openTurn=\(result.openTurn), nextCursor=\(result.nextCursor?.description ?? "nil")")

                if reset {
                    // 首次加载：消息已是 asc 顺序，直接赋值
                    rawMessages = result.messages
                } else {
                    // 加载更早消息：插入到顶部
                    let oldCount = rawMessages.count
                    rawMessages.insert(contentsOf: result.messages, at: 0)
                    print("📄 [loadMessages] loadMore: 插入 \(result.messages.count) 条到顶部, rawMessages: \(oldCount) → \(rawMessages.count)")
                }

                // 使用 MessageTransformer 转换消息
                displayMessages = messageTransformer.transform(messages: rawMessages)

                // V2: 从历史消息构建 Turn 时间线
                turnBuilder.processHistoryMessages(rawMessages, openTurn: result.openTurn)

                print("📄 [loadMessages] 处理完成: displayMessages=\(displayMessages.count), turns=\(turnBuilder.turns.count)")

                hasMore = result.hasMore
                nextCursor = result.nextCursor

                print("📄 [loadMessages] 更新游标: hasMore=\(hasMore), nextCursor=\(nextCursor?.description ?? "nil")")

            } catch is CancellationError {
                print("📄 [loadMessages] Task 被取消")
            } catch {
                print("❌ [loadMessages] 错误: \(error)")
                errorMessage = error.localizedDescription
            }
        }

        await loadMessagesTask?.value
    }
}
