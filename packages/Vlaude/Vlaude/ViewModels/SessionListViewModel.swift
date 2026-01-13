//
//  SessionListViewModel.swift
//  Vlaude
//
//  Created by Claude on 2025/11/16.
//

import Foundation
import Combine
import CoreNetworkKit

/// 创建会话的结果
enum CreateSessionResultType {
    case session(Session)                    // SDK 模式，返回 Session，可以直接跳转
    case etermPending(String, String)        // ETerm 模式，等待终端启动 (message, requestId)
}

@MainActor
class SessionListViewModel: ObservableObject {
    // MARK: - Published State

    @Published var sessions: [Session] = []
    @Published var isLoading = false
    @Published var isLoadingMore = false
    @Published var errorMessage: String?
    @Published var isCreatingSession = false
    @Published var hasMore = false
    @Published var etermMessage: String?

    // MARK: - Dependencies

    private let projectPath: String
    private let client = VlaudeClient.shared
    private let wsManager = WebSocketManager.shared

    // MARK: - Private State

    private var loadTask: Task<Void, Never>?
    private var currentOffset = 0
    private let pageSize = 20
    private var cancellables = Set<AnyCancellable>()
    private var isListening = false
    private var sessionListUpdatedToken: WebSocketManager.EventHandlerToken?

    // MARK: - Initialization

    init(projectPath: String) {
        self.projectPath = projectPath
    }

    deinit {
        // 清理订阅（非 MainActor 上下文，不能直接调用 stopListening）
        // Combine cancellables 会自动清理
    }

    // MARK: - Lifecycle

    /// 开始监听 - View 出现时调用
    /// 加载数据 + 订阅状态更新
    func startListening() async {
        guard !isListening else { return }
        isListening = true


        // 1. 设置 WebSocket 事件监听
        setupWebSocketListeners()

        // 2. 加载初始数据
        await loadSessions(reset: true)

        // 检查是否已被取消（视图可能已消失）
        guard isListening else {
            return
        }

        // 3. 订阅状态更新并应用初始状态
        await subscribeAndApplyInitialState()
    }

    /// 停止监听 - View 消失时调用
    func stopListening() {
        guard isListening else { return }
        isListening = false


        // 清理 WebSocket 监听
        cleanupEventHandler()
        cancellables.removeAll()
    }

    /// 清理事件监听（按 token 移除，不影响其他模块）
    private func cleanupEventHandler() {
        if let token = sessionListUpdatedToken {
            wsManager.off(token: token)
            sessionListUpdatedToken = nil
        }
    }

    // MARK: - Data Loading

    func loadSessions(reset: Bool = false) async {
        // 防止重复加载
        if loadTask != nil {
            return
        }

        loadTask = Task {
            if reset {
                isLoading = true
                currentOffset = 0
                sessions = []
            } else {
                isLoadingMore = true
            }

            errorMessage = nil

            defer {
                isLoading = false
                isLoadingMore = false
                loadTask = nil
            }

            do {
                try Task.checkCancellation()

                let result = try await client.getSessions(
                    projectPath: projectPath,
                    limit: pageSize,
                    offset: currentOffset
                )

                try Task.checkCancellation()

                if reset {
                    sessions = result.sessions
                } else {
                    sessions.append(contentsOf: result.sessions)
                }

                hasMore = result.hasMore
                currentOffset += result.sessions.count

            } catch is CancellationError {
            } catch {
                errorMessage = error.localizedDescription
            }
        }

        await loadTask?.value
    }

    // MARK: - Session Creation

    func createSession(prompt: String? = nil, requestId: String? = nil) async -> CreateSessionResultType? {
        isCreatingSession = true
        errorMessage = nil
        etermMessage = nil

        defer {
            isCreatingSession = false
        }

        do {
            let result = try await client.createSession(
                projectPath: projectPath,
                prompt: prompt,
                requestId: requestId
            )

            switch result {
            case .session(let session):
                await loadSessions(reset: true)
                return .session(session)

            case .eterm(let message, let returnedRequestId):
                etermMessage = message
                await loadSessions(reset: true)
                return .etermPending(message, returnedRequestId)
            }
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    func clearEtermMessage() {
        etermMessage = nil
    }

    // MARK: - Status Subscription

    /// 订阅状态更新并应用初始状态
    private func subscribeAndApplyInitialState() async {
        // 1. 先订阅 Combine Publisher（确保不丢失任何推送）
        wsManager.sessionsUpdatePublisher
            .filter { [weak self] update in
                update.projectPath == self?.projectPath
            }
            .receive(on: DispatchQueue.main)
            .sink { [weak self] update in
                guard let self = self, self.isListening else { return }
                self.updateSessionsOnlineStatus(onlineSessions: update.onlineSessions)
            }
            .store(in: &cancellables)

        // 2. 再发起订阅请求（初始状态会通过 Publisher 推送）
        do {
            _ = try await wsManager.subscribeSessionsPage(projectPath: projectPath)
        } catch {
        }
    }

    // MARK: - WebSocket Event Handlers

    private func setupWebSocketListeners() {
        // 监听 Session 列表更新（新 session 创建/删除）
        sessionListUpdatedToken = wsManager.on(.sessionListUpdated) { [weak self] message in
            guard let self = self else { return }


            // 检查是否是当前项目的更新
            if let msgProjectPath = message.projectPath {
                guard msgProjectPath == self.projectPath else { return }
            }

            Task { @MainActor in
                await self.refreshSilently()
            }
        }
    }

    // MARK: - State Updates

    private func updateSessionsOnlineStatus(onlineSessions: [String]) {
        var updated = false
        for i in sessions.indices {
            let sessionId = sessions[i].id
            let isOnline = onlineSessions.contains(sessionId)

            if sessions[i].inEterm != isOnline {
                sessions[i] = sessions[i].withInEterm(isOnline)
                updated = true
            }
        }

        if updated {
        }
    }

    private func refreshSilently() async {
        do {
            let result = try await client.getSessions(
                projectPath: projectPath,
                limit: currentOffset + pageSize,
                offset: 0
            )

            sessions = result.sessions
            hasMore = result.hasMore

        } catch {
        }
    }
}
