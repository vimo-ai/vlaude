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

    // 权限审批状态管理 (toolUseId -> PendingApproval)
    @Published var pendingApprovals: [String: PendingApproval] = [:]

    private let client = VlaudeClient.shared
    private let wsManager = WebSocketManager.shared
    private let messageTransformer = MessageTransformer()
    private var rawMessages: [Message] = []  // 保存原始消息用于转换
    private var currentOffset = 0
    private let pageSize = 20 // 改为每次加载 20 条
    private var currentSessionId: String?
    private var loadMessagesTask: Task<Void, Never>?

    // 通知订阅 tokens
    private var approvalRequestObserver: NSObjectProtocol?
    private var approvalTimeoutObserver: NSObjectProtocol?
    private var approvalExpiredObserver: NSObjectProtocol?
    private var approvalAckObserver: NSObjectProtocol?

    // clientMessageId 去重：存储待确认的消息 (clientMessageId -> 乐观更新的消息索引)
    private var pendingMessages: [String: Int] = [:]

    // 当前项目路径（从 SessionListView 传入）
    private var currentProjectPath: String = ""

    func loadSessionDetail(sessionId: String, projectPath: String) async {
        isLoading = true
        errorMessage = nil
        currentProjectPath = projectPath

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
        // 取消之前的订阅
        if let oldSessionId = currentSessionId {
            wsManager.unsubscribeFromSession(oldSessionId)
        }

        currentSessionId = sessionId

        // 注意：这里只订阅消息推送，不加入会话
        // 只有在发送消息时才会触发 join（通知 CLI 进入 remote 模式）
        wsManager.subscribeToSession(sessionId, projectPath: currentProjectPath)

        // 监听新消息事件
        wsManager.on(.messageNew) { [weak self] wsMessage in
            guard let self = self,
                  wsMessage.sessionId == sessionId,
                  let newMessage = wsMessage.message else {
                return
            }

            Task { @MainActor in

                // 收到 assistant 响应，隐藏 loading
                if newMessage.type == "assistant" {
                    self.isWaitingForResponse = false
                }

                // clientMessageId 去重逻辑
                if let clientMsgId = newMessage.clientMessageId,
                   let pendingIndex = self.pendingMessages[clientMsgId] {
                    // 找到匹配的乐观更新消息，用真实消息替换
                    self.rawMessages[pendingIndex] = newMessage
                    self.pendingMessages.removeValue(forKey: clientMsgId)
                    self.displayMessages = self.messageTransformer.transform(messages: self.rawMessages)
                    self.applyPendingApprovals()  // 应用 pending approvals
                    return
                }

                // 常规 uuid 去重
                if !self.rawMessages.contains(where: { $0.id == newMessage.id }) {
                    self.rawMessages.append(newMessage)
                    // 重新转换所有消息
                    self.displayMessages = self.messageTransformer.transform(messages: self.rawMessages)
                    self.applyPendingApprovals()  // 应用 pending approvals
                } else {
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

        // 监听权限请求
        setupApprovalObservers(sessionId: sessionId)
    }

    // MARK: - 权限审批

    private func setupApprovalObservers(sessionId: String) {
        // 移除旧的观察者
        removeApprovalObservers()

        // 监听权限请求
        approvalRequestObserver = NotificationCenter.default.addObserver(
            forName: NSNotification.Name("ApprovalRequest"),
            object: nil,
            queue: .main
        ) { [weak self] notification in
            guard let self = self else {
                return
            }

            guard let userInfo = notification.userInfo else {
                return
            }

            // 调试日志：打印所有字段

            guard let requestSessionId = userInfo["sessionId"] as? String else {
                return
            }

            // trim 空白字符（包括换行符）后再比较
            let trimmedRequestSessionId = requestSessionId.trimmingCharacters(in: .whitespacesAndNewlines)
            let trimmedSessionId = sessionId.trimmingCharacters(in: .whitespacesAndNewlines)

            guard trimmedRequestSessionId == trimmedSessionId else {
                return
            }

            guard let requestId = userInfo["requestId"] as? String else {
                return
            }

            guard let rawToolName = userInfo["toolName"] as? String else {
                return
            }
            let toolName = rawToolName.trimmingCharacters(in: .whitespacesAndNewlines)

            guard let rawDescription = userInfo["description"] as? String else {
                return
            }
            let description = rawDescription.trimmingCharacters(in: .whitespacesAndNewlines)

            let input = userInfo["input"] as? [String: Any] ?? [:]

            // toolUseID 可能为空（Claude Code SDK 限制）
            let rawToolUseId = userInfo["toolUseID"] as? String ?? ""
            var effectiveToolUseId = rawToolUseId.trimmingCharacters(in: .whitespacesAndNewlines)

            // 如果 toolUseId 为空，尝试从 displayMessages 中查找匹配的 ToolExecution
            if effectiveToolUseId.isEmpty {
                if let matchedId = self.findPendingToolUseId(toolName: toolName) {
                    effectiveToolUseId = matchedId
                } else {
                }
            }


            // 存储 pending approval
            let approval = PendingApproval(
                requestId: requestId,
                sessionId: trimmedRequestSessionId,
                toolUseId: effectiveToolUseId,
                toolName: toolName,
                input: input,
                description: description,
                timestamp: Date()
            )
            self.pendingApprovals[effectiveToolUseId] = approval

            // 更新对应 ToolExecution 的状态
            if !effectiveToolUseId.isEmpty {
                self.updateToolExecutionStatus(toolUseId: effectiveToolUseId, status: .awaitingPermission, requestId: requestId)
            }
        }

        // 监听审批超时
        approvalTimeoutObserver = NotificationCenter.default.addObserver(
            forName: NSNotification.Name("ApprovalTimeout"),
            object: nil,
            queue: .main
        ) { [weak self] notification in
            guard let self = self,
                  let userInfo = notification.userInfo,
                  let requestId = userInfo["requestId"] as? String else {
                return
            }


            // 找到对应的 toolUseId 并更新状态
            if let (toolUseId, _) = self.pendingApprovals.first(where: { $0.value.requestId == requestId }) {
                self.updateToolExecutionStatus(toolUseId: toolUseId, status: .timeout, requestId: nil)
                self.pendingApprovals.removeValue(forKey: toolUseId)
            }
        }

        // 监听审批过期（延迟响应）
        approvalExpiredObserver = NotificationCenter.default.addObserver(
            forName: NSNotification.Name("ApprovalExpired"),
            object: nil,
            queue: .main
        ) { [weak self] notification in
            guard let self = self,
                  let userInfo = notification.userInfo,
                  let requestId = userInfo["requestId"] as? String else {
                return
            }


            // 找到对应的 toolUseId 并更新状态
            if let (toolUseId, _) = self.pendingApprovals.first(where: { $0.value.requestId == requestId }) {
                self.updateToolExecutionStatus(toolUseId: toolUseId, status: .timeout, requestId: nil)
                self.pendingApprovals.removeValue(forKey: toolUseId)
            }
        }

        // 监听 approval-ack（ETerm 确认收到审批响应）
        approvalAckObserver = NotificationCenter.default.addObserver(
            forName: NSNotification.Name("ApprovalAck"),
            object: nil,
            queue: .main
        ) { [weak self] notification in
            guard let self = self,
                  let userInfo = notification.userInfo,
                  let toolUseId = userInfo["toolUseId"] as? String,
                  let success = userInfo["success"] as? Bool else {
                return
            }


            if success {
                // ETerm 确认收到，更新为 executing
                self.updateToolExecutionStatus(toolUseId: toolUseId, status: .executing, requestId: nil)
            } else {
                // ETerm 处理失败，显示错误
                let message = userInfo["message"] as? String ?? "处理失败"
                // 可以考虑回退状态或显示错误
            }

            // 清理 pending
            self.pendingApprovals.removeValue(forKey: toolUseId)
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
    }

    /// 更新 ToolExecution 的审批状态
    private func updateToolExecutionStatus(toolUseId: String, status: ToolApprovalStatus, requestId: String?) {
        // 遍历所有 displayMessages，找到对应的 ToolExecution 并更新状态
        for i in 0..<displayMessages.count {
            for j in 0..<displayMessages[i].toolExecutions.count {
                if displayMessages[i].toolExecutions[j].id == toolUseId {
                    // 创建更新后的 toolExecution
                    var updatedExecution = displayMessages[i].toolExecutions[j]
                    updatedExecution.approvalStatus = status
                    if let reqId = requestId {
                        updatedExecution.approvalRequestId = reqId
                    }

                    // 创建更新后的 toolExecutions 数组
                    var updatedToolExecutions = displayMessages[i].toolExecutions
                    updatedToolExecutions[j] = updatedExecution

                    // 创建更新后的 displayMessage
                    var updatedMessage = displayMessages[i]
                    updatedMessage.toolExecutions = updatedToolExecutions

                    // 替换整个 displayMessage 以触发 SwiftUI 更新
                    displayMessages[i] = updatedMessage

                    return
                }
            }
        }

        // 如果没找到，可能是 tool_use 消息还没到达，pending approval 已缓存
    }

    /// 查找最近的、状态为 none 的 ToolExecution（用于 toolUseId 为空时的匹配）
    /// - Parameter toolName: 工具名称
    /// - Returns: 匹配的 toolUseId，如果没找到返回 nil
    private func findPendingToolUseId(toolName: String) -> String? {

        // 倒序查找最近的消息
        for (msgIndex, message) in displayMessages.reversed().enumerated() {
            if !message.toolExecutions.isEmpty {
                for execution in message.toolExecutions {
                    // 匹配工具名称，且状态为 none（未处理）
                    if execution.name == toolName && execution.approvalStatus == .none {
                        return execution.id
                    }
                }
            }
        }
        return nil
    }

    /// 应用缓存的 pending approvals 到新到达的 ToolExecutions
    /// 处理时序问题：permission_request 可能先于 tool_use 消息到达
    private func applyPendingApprovals() {
        guard !pendingApprovals.isEmpty else { return }

        var hasUpdates = false

        for (toolUseId, approval) in pendingApprovals {
            // 尝试找到对应的 ToolExecution
            for i in 0..<displayMessages.count {
                for j in 0..<displayMessages[i].toolExecutions.count {
                    if displayMessages[i].toolExecutions[j].id == toolUseId {
                        // 只有当状态是 none 时才更新（避免覆盖已有状态）
                        if displayMessages[i].toolExecutions[j].approvalStatus == .none {
                            // 创建更新后的 toolExecution
                            var updatedExecution = displayMessages[i].toolExecutions[j]
                            updatedExecution.approvalStatus = .awaitingPermission
                            updatedExecution.approvalRequestId = approval.requestId

                            // 创建更新后的 toolExecutions 数组
                            var updatedToolExecutions = displayMessages[i].toolExecutions
                            updatedToolExecutions[j] = updatedExecution

                            // 创建更新后的 displayMessage
                            var updatedMessage = displayMessages[i]
                            updatedMessage.toolExecutions = updatedToolExecutions

                            // 替换整个 displayMessage 以触发 SwiftUI 更新
                            displayMessages[i] = updatedMessage
                            hasUpdates = true

                        }
                    }
                }
            }
        }

        if hasUpdates {
        }
    }

    /// 发送审批响应
    func sendApprovalResponse(toolUseId: String, action: String) {
        guard let approval = pendingApprovals[toolUseId] else {
            return
        }


        // 根据 action 更新状态
        if action == "n" {
            // 拒绝
            updateToolExecutionStatus(toolUseId: toolUseId, status: .rejected, requestId: nil)
            pendingApprovals.removeValue(forKey: toolUseId)
        } else {
            // 允许（y 或 a），等待 ETerm 确认
            updateToolExecutionStatus(toolUseId: toolUseId, status: .pendingAck, requestId: nil)
        }

        // 发送响应到服务器（包含 toolUseId 供 ETerm 返回 ack）
        wsManager.sendApprovalResponse(
            requestId: approval.requestId,
            sessionId: approval.sessionId,
            action: action,
            toolUseId: toolUseId
        )
    }

    /// 获取 tool 的审批状态（供 ToolView 使用）
    func getApprovalStatus(for toolUseId: String) -> ToolApprovalStatus {
        // 先检查 pending approvals
        if pendingApprovals[toolUseId] != nil {
            return .awaitingPermission
        }

        // 再从 displayMessages 中查找
        for message in displayMessages {
            for execution in message.toolExecutions {
                if execution.id == toolUseId {
                    return execution.approvalStatus
                }
            }
        }

        return .none
    }

    // MARK: - 发送消息

    func sendMessage(_ text: String) {
        guard let sessionId = currentSessionId else {
            return
        }

        guard let session = session else {
            return
        }

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
            mergedToolExecutions: []
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
        removeApprovalObservers()
        pendingApprovals.removeAll()
        currentSessionId = nil
    }

    deinit {
        // deinit 不能访问 @MainActor 方法，需要直接调用
        if let sessionId = currentSessionId {
            WebSocketManager.shared.unsubscribeFromSession(sessionId)
        }
        WebSocketManager.shared.off(.messageNew)

        // 清理 NotificationCenter 观察者
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


                // 使用倒序（desc）加载最新消息
                let result = try await client.getSessionMessages(
                    sessionId: sessionId,
                    projectPath: currentProjectPath,
                    limit: pageSize,
                    offset: currentOffset,
                    order: "desc"
                )

                // 再次检查取消状态(请求完成后)
                try Task.checkCancellation()


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

            } catch is CancellationError {
                // Task 被取消,静默处理
            } catch {
                errorMessage = error.localizedDescription
            }
        }

        await loadMessagesTask?.value
    }
}
