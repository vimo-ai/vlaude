//
//  VlaudeWebSocketClient.swift
//  Vlaude
//
//  基于 CoreNetworkKit WebSocketClient 的业务封装层
//  解决原 WebSocketManager 的多订阅问题
//

import Foundation
import Combine
import CoreNetworkKit

// MARK: - WebSocket 事件类型

enum VlaudeWebSocketEvent: String {
    case messageNew = "message:new"
    case projectUpdated = "project:updated"
    case sessionUpdated = "session:updated"
    case sessionListUpdated = "session:listUpdate"
    case approvalRequest = "approval-request"
    case statuslineMetricsUpdate = "statusline:metricsUpdate"
}

// MARK: - 订阅类型

/// 页面订阅类型
enum SubscriptionPage: String, Hashable {
    case projects = "projects"
    case sessions = "sessions"
    case chat = "chat"
}

/// 订阅信息
struct Subscription: Hashable {
    let page: SubscriptionPage
    let projectPath: String?
    let sessionId: String?

    func hash(into hasher: inout Hasher) {
        hasher.combine(page)
        hasher.combine(projectPath)
        hasher.combine(sessionId)
    }

    static func == (lhs: Subscription, rhs: Subscription) -> Bool {
        lhs.page == rhs.page && lhs.projectPath == rhs.projectPath && lhs.sessionId == rhs.sessionId
    }
}

// MARK: - Status Update Types

/// Sessions 状态更新
struct SessionsStatusUpdate {
    let projectPath: String
    let onlineSessions: [String]
}

/// Session 状态更新
struct SessionStatusUpdate {
    let sessionId: String
    let inEterm: Bool
}

// MARK: - WebSocket 消息结构

struct VlaudeWSMessage: Codable {
    let sessionId: String?
    let message: Message?
    let projectPath: String?
    let preview: String?
}

// MARK: - VlaudeWebSocketClient

@MainActor
class VlaudeWebSocketClient: ObservableObject {

    static let shared = VlaudeWebSocketClient()

    // MARK: - Published State

    @Published private(set) var isConnected = false
    @Published private(set) var connectionFailed = false
    @Published var isEtermOnline = false
    @Published var etermSessionCounts: [String: Int] = [:]

    // MARK: - Combine Publishers

    let sessionsUpdatePublisher = PassthroughSubject<SessionsStatusUpdate, Never>()
    let sessionUpdatePublisher = PassthroughSubject<SessionStatusUpdate, Never>()

    // MARK: - Private Properties

    private var client: WebSocketClient?
    private var cancellables = Set<AnyCancellable>()

    /// 多订阅管理（核心改进）
    private var activeSubscriptions = Set<Subscription>()

    /// 实时消息订阅：sessionId -> projectPath（session:subscribe，需重连恢复）
    private var activeMessageSubscriptions: [String: String] = [:]

    /// 已加入的 sessions
    private var joinedSessions: [String: String] = [:]

    /// 事件 Token 管理
    private var eventTokens: [String: EventHandlerToken] = [:]

    /// 重连计数
    private var reconnectAttemptCount = 0
    private let maxReconnectAttempts = 5

    // MARK: - Initialization

    private init() {}

    // MARK: - Connection Management

    func connect() {
        guard let token = AuthService.shared.getToken() else {
            print("⚠️ [VlaudeWebSocketClient] 无 Token，无法连接")
            return
        }

        if client != nil {
            print("⚠️ [VlaudeWebSocketClient] 已连接或正在连接")
            return
        }

        setupClient(token: token)
        client?.connect()
    }

    func disconnect() {
        client?.disconnect()
        cleanup()
    }

    func reconnectWithNewToken() {
        guard let token = AuthService.shared.getToken() else {
            return
        }

        reconnectAttemptCount = 0
        connectionFailed = false

        client?.disconnect()
        client = nil

        setupClient(token: token)
        client?.connect()
    }

    // MARK: - Setup

    private func setupClient(token: String) {
        let useMTLS = CertificateManager.shared.isReady
        let protocol_ = useMTLS ? "https" : "http"
        let url = URL(string: "\(protocol_)://\(VlaudeConfig.serverURL)")!

        var config: WebSocketConfiguration

        if useMTLS {
            let sessionDelegate = VlaudeWebSocketSessionDelegate()
            config = WebSocketConfiguration(
                url: url,
                token: token,
                authMethod: .queryParam(),
                enableLogging: false,
                reconnects: true,
                reconnectAttempts: 5,
                reconnectWait: 2,
                sessionDelegate: sessionDelegate,
                secure: true,
                selfSigned: true
            )
        } else {
            config = WebSocketConfiguration(
                url: url,
                token: token,
                authMethod: .queryParam(),
                enableLogging: false,
                reconnects: true,
                reconnectAttempts: 5,
                reconnectWait: 2
            )
        }

        client = WebSocketClient(configuration: config)
        setupClientObservers()
        setupEventHandlers()
    }

    private func setupClientObservers() {
        guard let client = client else { return }

        client.$isConnected
            .receive(on: DispatchQueue.main)
            .sink { [weak self] connected in
                guard let self = self else { return }
                self.isConnected = connected

                if connected {
                    self.connectionFailed = false
                    self.reconnectAttemptCount = 0
                    // 重连后恢复所有订阅
                    Task { @MainActor in
                        await self.restoreSubscriptions()
                    }
                }
            }
            .store(in: &cancellables)

        client.$connectionState
            .receive(on: DispatchQueue.main)
            .sink { [weak self] state in
                guard let self = self else { return }
                if state == .reconnecting {
                    self.reconnectAttemptCount += 1
                    if self.reconnectAttemptCount >= self.maxReconnectAttempts {
                        self.connectionFailed = true
                    }
                }
            }
            .store(in: &cancellables)
    }

    private func setupEventHandlers() {
        guard let client = client else { return }

        // 业务事件
        registerEvent("message:new", client: client)
        registerEvent("project:updated", client: client)
        registerEvent("session:updated", client: client)
        registerEvent("session:listUpdate", client: client)
        registerEvent("approval-request", client: client)
        registerEvent("approval-timeout", client: client)
        registerEvent("approval-expired", client: client)
        registerEvent("approval-ack", client: client)
        registerEvent("approval-cancelled", client: client)
        registerEvent("sdk-error", client: client)
        registerEvent("statusline:metricsUpdate", client: client)
        registerEvent("eterm:sessionCreated", client: client)

        // StatusManager 事件
        registerEvent("status:daemonOnline", client: client)
        registerEvent("status:daemonOffline", client: client)
        registerEvent("status:projectsUpdate", client: client)
        registerEvent("status:sessionsUpdate", client: client)
        registerEvent("status:sessionUpdate", client: client)
    }

    private func registerEvent(_ event: String, client: WebSocketClient) {
        let token: EventHandlerToken = client.onRaw(event) { [weak self] data in
            self?.handleRawEvent(event, data: data)
        }
        eventTokens[event] = token
    }

    // MARK: - Subscription Management（核心改进）

    /// 订阅页面状态 - 支持多订阅共存
    func subscribe(page: SubscriptionPage, projectPath: String? = nil, sessionId: String? = nil) {
        let subscription = Subscription(page: page, projectPath: projectPath, sessionId: sessionId)

        // 添加到活跃订阅集合
        activeSubscriptions.insert(subscription)

        guard isConnected else {
            print("📡 [VlaudeWebSocketClient] 未连接，订阅已缓存: \(page.rawValue)")
            return
        }

        Task {
            await performSubscribe(subscription)
        }
    }

    /// 取消订阅
    func unsubscribe(page: SubscriptionPage, projectPath: String? = nil, sessionId: String? = nil) {
        let subscription = Subscription(page: page, projectPath: projectPath, sessionId: sessionId)
        activeSubscriptions.remove(subscription)
    }

    /// 执行订阅请求
    private func performSubscribe(_ subscription: Subscription) async {
        guard let client = client, isConnected else { return }

        var payload: [String: Any] = ["page": subscription.page.rawValue]

        if let projectPath = subscription.projectPath {
            payload["projectPath"] = projectPath
        }
        if let sessionId = subscription.sessionId {
            payload["sessionId"] = sessionId
        }

        do {
            let response = try await client.emitWithAck("app:subscribe", data: payload, timeout: 10)

            guard let success = response["success"] as? Bool, success else {
                print("⚠️ [VlaudeWebSocketClient] 订阅失败: \(subscription.page.rawValue)")
                return
            }

            // 处理初始状态
            await MainActor.run {
                handleSubscriptionResponse(subscription, response: response)
            }
        } catch {
            print("❌ [VlaudeWebSocketClient] 订阅异常: \(error)")
        }
    }

    /// 处理订阅响应的初始状态
    private func handleSubscriptionResponse(_ subscription: Subscription, response: [String: Any]) {
        switch subscription.page {
        case .projects:
            if let isOnline = response["isEtermOnline"] as? Bool {
                isEtermOnline = isOnline
            }
            if let counts = response["sessionCounts"] as? [String: Int] {
                etermSessionCounts = counts
            }

        case .sessions:
            if let onlineSessions = response["onlineSessions"] as? [String],
               let projectPath = subscription.projectPath {
                sessionsUpdatePublisher.send(SessionsStatusUpdate(
                    projectPath: projectPath,
                    onlineSessions: onlineSessions
                ))
            }

        case .chat:
            if let inEterm = response["inEterm"] as? Bool,
               let sessionId = subscription.sessionId {
                sessionUpdatePublisher.send(SessionStatusUpdate(
                    sessionId: sessionId,
                    inEterm: inEterm
                ))
            }
        }
    }

    /// 恢复所有订阅（重连后）
    private func restoreSubscriptions() async {
        print("🔄 [VlaudeWebSocketClient] 恢复 \(activeSubscriptions.count) 个页面订阅, \(activeMessageSubscriptions.count) 个消息订阅")

        for subscription in activeSubscriptions {
            await performSubscribe(subscription)
        }

        // 恢复 session:subscribe 实时消息订阅
        for (sessionId, projectPath) in activeMessageSubscriptions {
            client?.emit("session:subscribe", data: [
                "sessionId": sessionId,
                "projectPath": projectPath
            ])
            print("🔄 [VlaudeWebSocketClient] 恢复消息订阅: \(sessionId)")
        }
    }

    // MARK: - Async Subscribe Methods

    func subscribeSessionsPage(projectPath: String) async throws -> [String] {
        let subscription = Subscription(page: .sessions, projectPath: projectPath, sessionId: nil)
        activeSubscriptions.insert(subscription)

        guard let client = client else {
            throw WebSocketError.notConnected
        }

        if !isConnected {
            try await waitForConnection()
        }

        let response = try await client.emitWithAck("app:subscribe", data: [
            "page": SubscriptionPage.sessions.rawValue,
            "projectPath": projectPath
        ], timeout: 10)

        print("🔍 [WS] subscribeSessionsPage raw response: \(response)")

        guard let success = response["success"] as? Bool, success else {
            print("❌ [WS] subscribeSessionsPage: success=\(response["success"] ?? "nil")")
            throw WebSocketError.decodingFailed
        }

        let onlineSessions = response["onlineSessions"] as? [String] ?? []
        print("🔍 [WS] subscribeSessionsPage onlineSessions=\(onlineSessions)")

        // 推送初始状态
        sessionsUpdatePublisher.send(SessionsStatusUpdate(
            projectPath: projectPath,
            onlineSessions: onlineSessions
        ))

        return onlineSessions
    }

    func subscribeChatPage(sessionId: String) async throws -> SessionStatusUpdate {
        let subscription = Subscription(page: .chat, projectPath: nil, sessionId: sessionId)
        activeSubscriptions.insert(subscription)

        guard let client = client else {
            throw WebSocketError.notConnected
        }

        if !isConnected {
            try await waitForConnection()
        }

        let response = try await client.emitWithAck("app:subscribe", data: [
            "page": SubscriptionPage.chat.rawValue,
            "sessionId": sessionId
        ], timeout: 10)

        guard let success = response["success"] as? Bool, success else {
            throw WebSocketError.decodingFailed
        }

        let inEterm = response["inEterm"] as? Bool ?? false
        let update = SessionStatusUpdate(sessionId: sessionId, inEterm: inEterm)

        sessionUpdatePublisher.send(update)

        return update
    }

    private func waitForConnection(timeout: TimeInterval = 10) async throws {
        let startTime = Date()

        while !isConnected {
            if Date().timeIntervalSince(startTime) > timeout {
                throw WebSocketError.notConnected
            }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
    }

    // MARK: - Session Management

    func joinSession(_ sessionId: String, projectPath: String) {
        guard isConnected else { return }
        guard joinedSessions[sessionId] == nil else { return }

        client?.emit("join", data: [
            "sessionId": sessionId,
            "clientType": "swift",
            "projectPath": projectPath
        ])

        joinedSessions[sessionId] = projectPath
    }

    func subscribeToSession(_ sessionId: String, projectPath: String) {
        // 追踪订阅，重连时恢复
        activeMessageSubscriptions[sessionId] = projectPath

        guard isConnected else { return }

        client?.emit("session:subscribe", data: [
            "sessionId": sessionId,
            "projectPath": projectPath
        ])
    }

    func unsubscribeFromSession(_ sessionId: String) {
        activeMessageSubscriptions.removeValue(forKey: sessionId)

        guard isConnected else { return }

        client?.emit("session:unsubscribe", data: ["sessionId": sessionId])
        joinedSessions.removeValue(forKey: sessionId)
    }

    // MARK: - Messaging

    func sendMessage(_ text: String, sessionId: String, clientMessageId: String? = nil) {
        print("📨 [WS.sendMessage] 开始, sessionId=\(sessionId), text=\(text.prefix(20))..., clientMsgId=\(clientMessageId ?? "nil")")
        guard isConnected else {
            print("❌ [WS.sendMessage] 未连接，无法发送消息")
            return
        }

        var payload: [String: Any] = [
            "sessionId": sessionId,
            "text": text
        ]

        if let clientMsgId = clientMessageId {
            payload["clientMessageId"] = clientMsgId
        }

        print("📨 [WS.sendMessage] client=\(client != nil ? "有值" : "nil"), payload=\(payload)")
        client?.emit("message:send", data: payload)
        print("📨 [WS.sendMessage] emit 已调用")
    }

    // MARK: - Approval

    /// 查询指定 session 的 pending approvals（进入 session 时调用）
    func getApprovalState(sessionId: String) async -> [[String: Any]] {
        guard let client = client, isConnected else { return [] }

        do {
            let response = try await client.emitWithAck("app:getApprovalState", data: [
                "sessionId": sessionId
            ], timeout: 5)

            return response["approvals"] as? [[String: Any]] ?? []
        } catch {
            print("⚠️ [VlaudeWebSocketClient] 查询审批状态失败: \(error)")
            return []
        }
    }

    func sendApprovalResponse(requestId: String, sessionId: String, action: String, toolUseId: String = "") {
        guard isConnected else { return }

        client?.emit("approval-response", data: [
            "requestId": requestId,
            "sessionId": sessionId,
            "action": action,
            "toolUseId": toolUseId
        ])
    }

    // MARK: - Event Handling

    /// 事件监听 Token
    struct VlaudeEventToken: Hashable {
        let id: UUID
        let event: VlaudeWebSocketEvent

        init(event: VlaudeWebSocketEvent) {
            self.id = UUID()
            self.event = event
        }
    }

    private struct VlaudeTokenizedHandler {
        let token: VlaudeEventToken
        let handler: (VlaudeWSMessage) -> Void
    }

    private var vlaudeEventHandlers: [VlaudeWebSocketEvent: [VlaudeTokenizedHandler]] = [:]

    @discardableResult
    func on(_ event: VlaudeWebSocketEvent, handler: @escaping (VlaudeWSMessage) -> Void) -> VlaudeEventToken {
        let token = VlaudeEventToken(event: event)
        let tokenizedHandler = VlaudeTokenizedHandler(token: token, handler: handler)

        if vlaudeEventHandlers[event] == nil {
            vlaudeEventHandlers[event] = []
        }
        vlaudeEventHandlers[event]?.append(tokenizedHandler)

        return token
    }

    func off(token: VlaudeEventToken) {
        vlaudeEventHandlers[token.event]?.removeAll { $0.token.id == token.id }
    }

    func off(_ event: VlaudeWebSocketEvent) {
        vlaudeEventHandlers[event] = nil
    }

    // MARK: - Nonisolated Cleanup (用于 deinit)

    /// nonisolated 版本的 off，用于 deinit 中调用
    /// 通过 Task 异步在主线程执行清理
    nonisolated func offFromDeinit(token: VlaudeEventToken) {
        Task { @MainActor in
            self.off(token: token)
        }
    }

    /// nonisolated 版本的 unsubscribeFromSession，用于 deinit 中调用
    nonisolated func unsubscribeFromSessionInDeinit(_ sessionId: String) {
        Task { @MainActor in
            self.unsubscribeFromSession(sessionId)
        }
    }

    // MARK: - Raw Event Handling

    private func handleRawEvent(_ event: String, data: [Any]) {
        guard let payload = data.first else { return }

        // 根据事件类型分发处理
        switch event {
        case "message:new", "project:updated", "session:updated", "session:listUpdate":
            handleBusinessEvent(event, payload: payload)

        case "approval-request":
            handleApprovalRequest(payload)

        case "approval-timeout":
            handleApprovalTimeout(payload)

        case "approval-expired":
            handleApprovalExpired(payload)

        case "approval-ack":
            handleApprovalAck(payload)

        case "approval-cancelled":
            handleApprovalCancelled(payload)

        case "sdk-error":
            handleSDKError(payload)

        case "statusline:metricsUpdate":
            handleStatuslineMetricsUpdate(payload)

        case "eterm:sessionCreated":
            handleEtermSessionCreated(payload)

        case "status:daemonOnline":
            handleStatusDaemonOnline(payload)

        case "status:daemonOffline":
            handleStatusDaemonOffline(payload)

        case "status:projectsUpdate":
            handleStatusProjectsUpdate(payload)

        case "status:sessionsUpdate":
            handleStatusSessionsUpdate(payload)

        case "status:sessionUpdate":
            handleStatusSessionUpdate(payload)

        default:
            break
        }
    }

    private func handleBusinessEvent(_ eventName: String, payload: Any) {
        guard let event = VlaudeWebSocketEvent(rawValue: eventName) else { return }

        do {
            let jsonData = try JSONSerialization.data(withJSONObject: payload)
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .iso8601
            let message = try decoder.decode(VlaudeWSMessage.self, from: jsonData)

            // 触发注册的 handlers
            vlaudeEventHandlers[event]?.forEach { $0.handler(message) }
        } catch {
            print("⚠️ [VlaudeWebSocketClient] 解码失败: \(error)")
        }
    }

    // MARK: - Status Event Handlers

    private func handleStatusDaemonOnline(_ payload: Any) {
        guard let dict = payload as? [String: Any],
              let deviceId = dict["deviceId"] as? String else { return }

        Task { @MainActor in
            if deviceId.hasPrefix("eterm") {
                self.isEtermOnline = true
            }

            NotificationCenter.default.post(
                name: NSNotification.Name("StatusDaemonOnline"),
                object: nil,
                userInfo: dict
            )
        }
    }

    private func handleStatusDaemonOffline(_ payload: Any) {
        guard let dict = payload as? [String: Any],
              let deviceId = dict["deviceId"] as? String else { return }

        if let sessionCounts = dict["sessionCounts"] as? [String: Int] {
            Task { @MainActor in
                self.etermSessionCounts = sessionCounts
            }
        }

        Task { @MainActor in
            if deviceId.hasPrefix("eterm") {
                self.isEtermOnline = false
                self.etermSessionCounts = [:]
            }

            NotificationCenter.default.post(
                name: NSNotification.Name("StatusDaemonOffline"),
                object: nil,
                userInfo: dict
            )
        }
    }

    private func handleStatusProjectsUpdate(_ payload: Any) {
        guard let dict = payload as? [String: Any],
              let sessionCounts = dict["sessionCounts"] as? [String: Int] else { return }

        Task { @MainActor in
            self.etermSessionCounts = sessionCounts

            NotificationCenter.default.post(
                name: NSNotification.Name("StatusProjectsUpdate"),
                object: nil,
                userInfo: ["sessionCounts": sessionCounts]
            )
        }
    }

    private func handleStatusSessionsUpdate(_ payload: Any) {
        guard let dict = payload as? [String: Any],
              let projectPath = dict["projectPath"] as? String,
              let onlineSessions = dict["onlineSessions"] as? [String] else { return }

        sessionsUpdatePublisher.send(SessionsStatusUpdate(
            projectPath: projectPath,
            onlineSessions: onlineSessions
        ))
    }

    private func handleStatusSessionUpdate(_ payload: Any) {
        guard let dict = payload as? [String: Any],
              let sessionId = dict["sessionId"] as? String else { return }

        let inEterm = dict["inEterm"] as? Bool ?? false

        sessionUpdatePublisher.send(SessionStatusUpdate(
            sessionId: sessionId,
            inEterm: inEterm
        ))
    }

    // MARK: - Other Event Handlers

    private func handleApprovalRequest(_ payload: Any) {
        guard let dict = payload as? [String: Any] else { return }

        NotificationCenter.default.post(
            name: NSNotification.Name("ApprovalRequest"),
            object: nil,
            userInfo: dict
        )
    }

    private func handleApprovalTimeout(_ payload: Any) {
        guard let dict = payload as? [String: Any] else { return }

        NotificationCenter.default.post(
            name: NSNotification.Name("ApprovalTimeout"),
            object: nil,
            userInfo: dict
        )
    }

    private func handleApprovalExpired(_ payload: Any) {
        guard let dict = payload as? [String: Any] else { return }

        NotificationCenter.default.post(
            name: NSNotification.Name("ApprovalExpired"),
            object: nil,
            userInfo: dict
        )
    }

    private func handleApprovalAck(_ payload: Any) {
        guard let dict = payload as? [String: Any] else { return }

        NotificationCenter.default.post(
            name: NSNotification.Name("ApprovalAck"),
            object: nil,
            userInfo: dict
        )
    }

    private func handleApprovalCancelled(_ payload: Any) {
        guard let dict = payload as? [String: Any] else { return }

        NotificationCenter.default.post(
            name: NSNotification.Name("ApprovalCancelled"),
            object: nil,
            userInfo: dict
        )
    }

    private func handleSDKError(_ payload: Any) {
        guard let dict = payload as? [String: Any] else { return }

        NotificationCenter.default.post(
            name: NSNotification.Name("SDKError"),
            object: nil,
            userInfo: dict
        )
    }

    private func handleStatuslineMetricsUpdate(_ payload: Any) {
        guard let dict = payload as? [String: Any] else { return }

        NotificationCenter.default.post(
            name: NSNotification.Name("StatuslineMetricsUpdate"),
            object: nil,
            userInfo: dict
        )
    }

    private func handleEtermSessionCreated(_ payload: Any) {
        guard let dict = payload as? [String: Any] else { return }

        NotificationCenter.default.post(
            name: NSNotification.Name("EtermSessionCreated"),
            object: nil,
            userInfo: dict
        )
    }

    // MARK: - Cleanup

    private func cleanup() {
        client = nil
        cancellables.removeAll()
        eventTokens.removeAll()
        joinedSessions.removeAll()
        isConnected = false
    }
}
