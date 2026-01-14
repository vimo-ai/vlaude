//
//  WebSocketManager.swift
//  Vlaude
//
//  Created by Claude on 2025/11/16.
//

import Foundation
import Combine
import SocketIO

// MARK: - WebSocket 事件类型
enum WebSocketEvent: String {
    case messageNew = "message:new"
    case projectUpdated = "project:updated"
    case sessionUpdated = "session:updated"
    case sessionListUpdated = "session:listUpdate"  // Session 列表更新（新 session 创建/删除）
    case approvalRequest = "approval-request"  // 权限请求
    case statuslineMetricsUpdate = "statusline:metricsUpdate"  // Statusline 指标更新
}

// MARK: - WebSocket 消息结构
struct WebSocketMessage: Codable {
    let sessionId: String?
    let message: Message?
    let projectPath: String?
    let metadata: [String: AnyCodable]?

    enum CodingKeys: String, CodingKey {
        case sessionId, message, projectPath, metadata
    }
}

// 用于处理动态 JSON
struct AnyCodable: Codable {
    let value: Any

    init(_ value: Any) {
        self.value = value
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let string = try? container.decode(String.self) {
            self.value = string
        } else if let int = try? container.decode(Int.self) {
            self.value = int
        } else if let double = try? container.decode(Double.self) {
            self.value = double
        } else if let bool = try? container.decode(Bool.self) {
            self.value = bool
        } else {
            self.value = [:]
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        if let string = value as? String {
            try container.encode(string)
        } else if let int = value as? Int {
            try container.encode(int)
        } else if let double = value as? Double {
            try container.encode(double)
        } else if let bool = value as? Bool {
            try container.encode(bool)
        }
    }
}

// MARK: - 权限请求消息结构
struct ApprovalRequest: Codable {
    let requestId: String
    let sessionId: String
    let toolName: String
    let input: [String: AnyCodable]?
    let toolUseID: String
    let description: String
}

// MARK: - Status Update Types

/// Sessions 页面订阅返回的初始状态
struct SessionsPageState {
    let onlineSessions: [String]
}

/// Sessions 状态更新（用于 Combine Publisher）
struct SessionsStatusUpdate {
    let projectPath: String
    let onlineSessions: [String]
}

/// Session 状态更新（单个 session 的 inEterm 状态）
struct SessionStatusUpdate {
    let sessionId: String
    let inEterm: Bool
}

/// 订阅错误
enum SubscriptionError: Error {
    case notConnected
    case timeout
    case invalidResponse
}

// MARK: - WebSocket Manager
class WebSocketManager: ObservableObject {
    static let shared = WebSocketManager()

    // MARK: - Published State

    @Published var isConnected = false
    @Published var connectionFailed = false  // 连接失败（所有重试都失败）
    @Published var lastError: Error?
    @Published var isEtermOnline = false
    @Published var etermSessionCounts: [String: Int] = [:]

    // 重连计数
    private var reconnectAttemptCount = 0
    private let maxReconnectAttempts = 5

    // MARK: - Combine Publishers（状态推送）

    /// Sessions 列表在线状态更新
    let sessionsUpdatePublisher = PassthroughSubject<SessionsStatusUpdate, Never>()

    /// 单个 Session 状态更新
    let sessionUpdatePublisher = PassthroughSubject<SessionStatusUpdate, Never>()

    // MARK: - Event Handler Token

    /// 事件监听 Token，用于移除特定的监听器
    struct EventHandlerToken: Hashable {
        let id: UUID
        let event: WebSocketEvent

        init(event: WebSocketEvent) {
            self.id = UUID()
            self.event = event
        }
    }

    /// 带 token 的事件处理器
    private struct TokenizedHandler {
        let token: EventHandlerToken
        let handler: (WebSocketMessage) -> Void
    }

    // MARK: - Private State

    private var eventHandlers: [WebSocketEvent: [TokenizedHandler]] = [:]
    private var joinedSessions: [String: String] = [:]
    private var pendingSubscription: (page: PageType, projectPath: String?, sessionId: String?)?

    // Socket.IO Manager 和 Socket
    private var manager: SocketManager!
    private var socket: SocketIOClient!

    private init() {
        // 延迟连接，等待显式调用 connect()
    }

    // MARK: - Socket 设置

    private func setupSocket(token: String) {
        let useMTLS = CertificateManager.shared.isReady
        let protocol_ = useMTLS ? "https" : "http"
        let url = URL(string: "\(protocol_)://\(VlaudeConfig.serverURL)")!

        var config: SocketIOClientConfiguration = [
            .log(false),
            .compress,
            .reconnects(true),
            .reconnectAttempts(5),
            .reconnectWait(2),
            .connectParams(["token": token])  // Token 作为 query 参数传递
        ]

        // mTLS 模式：配置自定义 URLSessionDelegate
        if useMTLS {
            let sessionDelegate = SocketURLSessionDelegate()
            config.insert(.sessionDelegate(sessionDelegate))

            // 允许自签名证书
            config.insert(.secure(true))
            config.insert(.selfSigned(true))
        }

        manager = SocketManager(socketURL: url, config: config)
        socket = manager.defaultSocket

        // 设置事件监听
        setupEventHandlers()
    }

    private func setupEventHandlers() {
        // 连接成功
        socket.on(clientEvent: .connect) { [weak self] data, ack in
            DispatchQueue.main.async {
                self?.isConnected = true
                self?.connectionFailed = false  // 重置连接失败状态
                self?.reconnectAttemptCount = 0  // 重置重连计数
            }

            // Phase 3: 重试待订阅的页面
            self?.retryPendingSubscription()
        }

        // 连接断开
        socket.on(clientEvent: .disconnect) { [weak self] data, ack in
            DispatchQueue.main.async {
                self?.isConnected = false
            }
        }

        // 连接错误
        socket.on(clientEvent: .error) { [weak self] data, ack in
            // 检查是否是认证错误
            if let errorDict = data.first as? [String: Any],
               let message = errorDict["message"] as? String {
                if message.contains("Authentication") || message.contains("Token") {
                    _ = AuthService.shared.deleteToken()

                    // 通知应用重新认证
                    NotificationCenter.default.post(
                        name: NSNotification.Name("AuthenticationError"),
                        object: nil
                    )
                }
            }

            if let error = data.first as? Error {
                DispatchQueue.main.async {
                    self?.lastError = error
                }
            }
        }

        // 重连中
        socket.on(clientEvent: .reconnect) { data, ack in
        }

        // 重连尝试
        socket.on(clientEvent: .reconnectAttempt) { [weak self] data, ack in
            guard let self = self else { return }
            self.reconnectAttemptCount += 1
            print("🔄 [WebSocket] 重连尝试 \(self.reconnectAttemptCount)/\(self.maxReconnectAttempts)")

            // 达到最大重试次数，标记连接失败
            if self.reconnectAttemptCount >= self.maxReconnectAttempts {
                DispatchQueue.main.async {
                    self.connectionFailed = true
                    print("❌ [WebSocket] 连接失败：已达最大重试次数")
                }
            }
        }

        // 监听业务事件
        socket.on("message:new") { [weak self] data, ack in
            self?.handleBusinessEvent(.messageNew, data: data)
        }

        socket.on("project:updated") { [weak self] data, ack in
            self?.handleBusinessEvent(.projectUpdated, data: data)
        }

        socket.on("session:updated") { [weak self] data, ack in
            self?.handleBusinessEvent(.sessionUpdated, data: data)
        }

        // 监听 Session 列表更新（新 session 创建/删除）
        socket.on("session:listUpdate") { [weak self] data, ack in
            self?.handleBusinessEvent(.sessionListUpdated, data: data)
        }

        // 监听权限请求
        socket.on("approval-request") { [weak self] data, ack in
            self?.handleApprovalRequest(data: data)
        }

        // 监听权限超时
        socket.on("approval-timeout") { [weak self] data, ack in
            self?.handleApprovalTimeout(data: data)
        }

        // 监听延迟响应
        socket.on("approval-expired") { [weak self] data, ack in
            self?.handleApprovalExpired(data: data)
        }

        // 监听 ETerm 审批确认
        socket.on("approval-ack") { [weak self] data, ack in
            self?.handleApprovalAck(data: data)
        }

        // 监听 SDK 错误
        socket.on("sdk-error") { [weak self] data, ack in
            self?.handleSDKError(data: data)
        }

        // 监听 Statusline 指标更新
        socket.on("statusline:metricsUpdate") { [weak self] data, ack in
            self?.handleStatuslineMetricsUpdate(data: data)
        }

        // 监听 ETerm 会话创建完成（保留：用于创建会话回调）
        socket.on("eterm:sessionCreated") { [weak self] data, ack in
            self?.handleEtermSessionCreated(data: data)
        }

        // =================== StatusManager 状态事件（Phase 3）===================

        // Daemon 上线（Server StatusManager 推送）
        socket.on("status:daemonOnline") { [weak self] data, ack in
            self?.handleStatusDaemonOnline(data: data)
        }

        // Daemon 下线（Server StatusManager 推送）
        socket.on("status:daemonOffline") { [weak self] data, ack in
            self?.handleStatusDaemonOffline(data: data)
        }

        // 项目列表更新（sessionCounts 变化）
        socket.on("status:projectsUpdate") { [weak self] data, ack in
            self?.handleStatusProjectsUpdate(data: data)
        }

        // Session 列表更新（某项目的在线 sessions 变化）
        socket.on("status:sessionsUpdate") { [weak self] data, ack in
            self?.handleStatusSessionsUpdate(data: data)
        }

        // 单个 Session 状态更新（inEterm 状态）
        socket.on("status:sessionUpdate") { [weak self] data, ack in
            self?.handleStatusSessionUpdate(data: data)
        }
    }

    // MARK: - ETerm 会话创建

    /// 处理 ETerm 会话创建完成事件
    private func handleEtermSessionCreated(data: [Any]) {
        guard let payload = data.first as? [String: Any],
              let requestId = payload["requestId"] as? String,
              let sessionId = payload["sessionId"] as? String else {
            return
        }

        let projectPath = payload["projectPath"] as? String

        // 通过通知发送，让 SessionListView 监听并跳转
        NotificationCenter.default.post(
            name: NSNotification.Name("EtermSessionCreated"),
            object: nil,
            userInfo: [
                "requestId": requestId,
                "sessionId": sessionId,
                "projectPath": projectPath as Any
            ]
        )
    }

    // MARK: - StatusManager 事件处理（Phase 3）

    /// 处理 Daemon 上线事件（新架构）
    private func handleStatusDaemonOnline(data: [Any]) {
        guard let payload = data.first as? [String: Any],
              let deviceId = payload["deviceId"] as? String else {
            return
        }

        let isReconnect = payload["isReconnect"] as? Bool ?? false

        // 解析 info（可选）
        let info = payload["info"] as? [String: Any]
        let deviceName = info?["deviceName"] as? String
        let platform = info?["platform"] as? String

        DispatchQueue.main.async { [weak self] in
            // 更新 isEtermOnline（如果是 eterm 设备，支持 eterm-main 等变体）
            if deviceId.hasPrefix("eterm") {
                self?.isEtermOnline = true
            }

            // 通过通知转发（供 ViewModel 使用）
            NotificationCenter.default.post(
                name: NSNotification.Name("StatusDaemonOnline"),
                object: nil,
                userInfo: [
                    "deviceId": deviceId,
                    "deviceName": deviceName ?? "Unknown",
                    "platform": platform ?? "unknown",
                    "isReconnect": isReconnect
                ]
            )
        }
    }

    /// 处理 Daemon 下线事件（新架构）
    private func handleStatusDaemonOffline(data: [Any]) {
        guard let payload = data.first as? [String: Any],
              let deviceId = payload["deviceId"] as? String else {
            return
        }

        let affectedProjects = payload["affectedProjects"] as? [String] ?? []

        // 更新 sessionCounts（如果有）
        if let sessionCounts = payload["sessionCounts"] as? [String: Int] {
            DispatchQueue.main.async { [weak self] in
                self?.etermSessionCounts = sessionCounts
            }
        }

        DispatchQueue.main.async { [weak self] in
            // 更新 isEtermOnline（如果是 eterm 设备，支持 eterm-main 等变体）
            if deviceId.hasPrefix("eterm") {
                self?.isEtermOnline = false
                self?.etermSessionCounts = [:]  // 清空会话计数
            }

            // 通过通知转发
            NotificationCenter.default.post(
                name: NSNotification.Name("StatusDaemonOffline"),
                object: nil,
                userInfo: [
                    "deviceId": deviceId,
                    "affectedProjects": affectedProjects
                ]
            )
        }
    }

    /// 处理项目列表更新事件（sessionCounts 变化）
    private func handleStatusProjectsUpdate(data: [Any]) {
        guard let payload = data.first as? [String: Any],
              let sessionCounts = payload["sessionCounts"] as? [String: Int] else {
            return
        }


        DispatchQueue.main.async { [weak self] in
            self?.etermSessionCounts = sessionCounts

            // 通过通知转发
            NotificationCenter.default.post(
                name: NSNotification.Name("StatusProjectsUpdate"),
                object: nil,
                userInfo: ["sessionCounts": sessionCounts]
            )
        }
    }

    /// 处理 Session 列表更新事件（某项目的在线 sessions 变化）
    private func handleStatusSessionsUpdate(data: [Any]) {
        guard let payload = data.first as? [String: Any],
              let projectPath = payload["projectPath"] as? String,
              let onlineSessions = payload["onlineSessions"] as? [String] else {
            return
        }


        // 通过 Combine Publisher 推送（新架构）
        sessionsUpdatePublisher.send(SessionsStatusUpdate(
            projectPath: projectPath,
            onlineSessions: onlineSessions
        ))
    }

    /// 处理单个 Session 状态更新事件（inEterm 状态）
    private func handleStatusSessionUpdate(data: [Any]) {
        guard let payload = data.first as? [String: Any],
              let sessionId = payload["sessionId"] as? String else {
            return
        }

        let inEterm = payload["inEterm"] as? Bool ?? false


        // 通过 Combine Publisher 推送（新架构）
        sessionUpdatePublisher.send(SessionStatusUpdate(
            sessionId: sessionId,
            inEterm: inEterm
        ))
    }

    private func handleBusinessEvent(_ event: WebSocketEvent, data: [Any]) {

        guard let payload = data.first else {
            return
        }


        do {
            let jsonData = try JSONSerialization.data(withJSONObject: payload)

            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .iso8601

            let message = try decoder.decode(WebSocketMessage.self, from: jsonData)

            // 触发事件回调
            let handlerCount = eventHandlers[event]?.count ?? 0

            eventHandlers[event]?.forEach { tokenizedHandler in
                tokenizedHandler.handler(message)
            }
        } catch {
            if let decodingError = error as? DecodingError {
            }
        }
    }

    // MARK: - 连接管理

    func connect() {
        // 检查是否有 Token
        guard let token = AuthService.shared.getToken() else {
            return
        }

        // 如果 Socket 未初始化，先设置
        if manager == nil {
            setupSocket(token: token)
        }

        // 连接
        socket.connect()
    }

    func disconnect() {
        socket.disconnect()
    }

    /// 重新设置 Socket（用于 Token 更新后）
    func reconnectWithNewToken() {
        guard let token = AuthService.shared.getToken() else {
            return
        }

        // 重置连接状态
        reconnectAttemptCount = 0
        DispatchQueue.main.async { [weak self] in
            self?.connectionFailed = false
        }

        // 断开旧连接
        if socket != nil {
            disconnect()
        }

        // 重新设置并连接
        setupSocket(token: token)
        socket.connect()
    }

    // MARK: - 订阅管理

    func joinSession(_ sessionId: String, projectPath: String) {
        guard isConnected else {
            return
        }

        // 避免重复 join
        if joinedSessions[sessionId] != nil {
            return
        }

        socket.emit("join", [
            "sessionId": sessionId,
            "clientType": "swift",
            "projectPath": projectPath
        ])

        // 记录已 join 的 session
        joinedSessions[sessionId] = projectPath

    }

    func subscribeToSession(_ sessionId: String, projectPath: String) {
        guard isConnected else {
            return
        }

        socket.emit("session:subscribe", [
            "sessionId": sessionId,
            "projectPath": projectPath
        ])

    }

    func unsubscribeFromSession(_ sessionId: String) {
        guard isConnected else { return }

        socket.emit("session:unsubscribe", [
            "sessionId": sessionId
        ])

        // 清理 join 记录
        joinedSessions.removeValue(forKey: sessionId)

    }

    // MARK: - 页面订阅（StatusManager 新架构）

    /// 页面类型枚举
    enum PageType: String {
        case projects = "projects"
        case sessions = "sessions"
        case chat = "chat"
    }

    /// 订阅页面状态更新
    /// - Parameters:
    ///   - page: 页面类型
    ///   - projectPath: 项目路径（sessions 页面需要）
    ///   - sessionId: 会话 ID（chat 页面需要）
    func subscribe(page: PageType, projectPath: String? = nil, sessionId: String? = nil) {
        // 保存待订阅信息（用于连接成功后重试）
        pendingSubscription = (page, projectPath, sessionId)

        guard isConnected else {
            return
        }

        doSubscribe(page: page, projectPath: projectPath, sessionId: sessionId)
    }

    /// 执行订阅（内部方法）
    private func doSubscribe(page: PageType, projectPath: String?, sessionId: String?) {
        var payload: [String: Any] = ["page": page.rawValue]

        if let projectPath = projectPath {
            payload["projectPath"] = projectPath
        }
        if let sessionId = sessionId {
            payload["sessionId"] = sessionId
        }

        // 使用 emitWithAck 接收初始状态
        socket.emitWithAck("app:subscribe", payload).timingOut(after: 10) { [weak self] data in
            guard let self = self else { return }


            // 检查是否超时
            if let status = data.first as? String, status == "NO ACK" {
                return
            }

            guard let response = data.first as? [String: Any],
                  let success = response["success"] as? Bool, success else {
                return
            }

            // 处理初始状态
            switch page {
            case .projects:
                DispatchQueue.main.async {
                    if let isOnline = response["isEtermOnline"] as? Bool {
                        self.isEtermOnline = isOnline
                    }
                    if let counts = response["sessionCounts"] as? [String: Int] {
                        self.etermSessionCounts = counts
                    }
                }

            case .sessions:
                // 通过 Combine Publisher 推送
                if let onlineSessions = response["onlineSessions"] as? [String],
                   let path = projectPath {
                    self.sessionsUpdatePublisher.send(SessionsStatusUpdate(
                        projectPath: path,
                        onlineSessions: onlineSessions
                    ))
                }

            case .chat:
                // 通过 Combine Publisher 推送
                if let inEterm = response["inEterm"] as? Bool,
                   let sid = sessionId {
                    self.sessionUpdatePublisher.send(SessionStatusUpdate(
                        sessionId: sid,
                        inEterm: inEterm
                    ))
                }
            }
        }

        if let projectPath = projectPath {
        }
        if let sessionId = sessionId {
        }
    }

    /// 重试待订阅（连接成功后调用）
    private func retryPendingSubscription() {
        guard let pending = pendingSubscription else { return }

        doSubscribe(page: pending.page, projectPath: pending.projectPath, sessionId: pending.sessionId)
    }

    // MARK: - Async Subscribe Methods（新架构）

    /// 订阅 Sessions 页面，返回初始状态
    /// - Parameter projectPath: 项目路径
    /// - Returns: 初始在线 session 列表
    func subscribeSessionsPage(projectPath: String) async throws -> SessionsPageState {
        // 记录订阅信息，用于断线重连恢复
        pendingSubscription = (.sessions, projectPath, nil)

        if !isConnected {
            try await waitForConnection()
        }

        return try await withCheckedThrowingContinuation { continuation in
            let payload: [String: Any] = [
                "page": PageType.sessions.rawValue,
                "projectPath": projectPath
            ]

            socket.emitWithAck("app:subscribe", payload).timingOut(after: 10) { [weak self] data in
                if let status = data.first as? String, status == "NO ACK" {
                    continuation.resume(throwing: SubscriptionError.timeout)
                    return
                }

                guard let response = data.first as? [String: Any],
                      let success = response["success"] as? Bool, success else {
                    continuation.resume(throwing: SubscriptionError.invalidResponse)
                    return
                }

                let onlineSessions = response["onlineSessions"] as? [String] ?? []

                // 重连时通过 Publisher 推送初始状态
                self?.sessionsUpdatePublisher.send(SessionsStatusUpdate(
                    projectPath: projectPath,
                    onlineSessions: onlineSessions
                ))

                continuation.resume(returning: SessionsPageState(onlineSessions: onlineSessions))
            }
        }
    }

    /// 订阅 Chat 页面，返回初始状态
    /// - Parameter sessionId: 会话 ID
    /// - Returns: 初始 inEterm 状态
    func subscribeChatPage(sessionId: String) async throws -> SessionStatusUpdate {
        // 记录订阅信息，用于断线重连恢复
        pendingSubscription = (.chat, nil, sessionId)

        if !isConnected {
            try await waitForConnection()
        }

        return try await withCheckedThrowingContinuation { continuation in
            let payload: [String: Any] = [
                "page": PageType.chat.rawValue,
                "sessionId": sessionId
            ]

            socket.emitWithAck("app:subscribe", payload).timingOut(after: 10) { [weak self] data in
                if let status = data.first as? String, status == "NO ACK" {
                    continuation.resume(throwing: SubscriptionError.timeout)
                    return
                }

                guard let response = data.first as? [String: Any],
                      let success = response["success"] as? Bool, success else {
                    continuation.resume(throwing: SubscriptionError.invalidResponse)
                    return
                }

                let inEterm = response["inEterm"] as? Bool ?? false

                // 重连时通过 Publisher 推送初始状态
                self?.sessionUpdatePublisher.send(SessionStatusUpdate(
                    sessionId: sessionId,
                    inEterm: inEterm
                ))

                continuation.resume(returning: SessionStatusUpdate(sessionId: sessionId, inEterm: inEterm))
            }
        }
    }

    /// 等待 WebSocket 连接（带超时）
    private func waitForConnection(timeout: TimeInterval = 10) async throws {
        let startTime = Date()

        while !isConnected {
            if Date().timeIntervalSince(startTime) > timeout {
                throw SubscriptionError.notConnected
            }
            try await Task.sleep(nanoseconds: 100_000_000) // 100ms
        }
    }

    /// 获取完整状态快照（首屏加载用）
    /// - Parameter completion: 完成回调，返回快照数据
    func getSnapshot(completion: @escaping ([String: Any]?) -> Void) {
        guard isConnected else {
            completion(nil)
            return
        }

        socket.emitWithAck("app:getSnapshot", []).timingOut(after: 10) { data in
            // 检查是否超时
            if let status = data.first as? String, status == "NO ACK" {
                completion(nil)
                return
            }

            guard let snapshot = data.first as? [String: Any] else {
                completion(nil)
                return
            }

            completion(snapshot)
        }
    }

    // MARK: - 发送消息

    func sendMessage(_ text: String, sessionId: String, clientMessageId: String? = nil) {
        print("📤 [WS] sendMessage called, isConnected=\(isConnected), socket=\(socket != nil ? "OK" : "NIL")")

        guard isConnected else {
            print("❌ [WS] Not connected, message dropped")
            return
        }

        var payload: [String: Any] = [
            "sessionId": sessionId,
            "text": text
        ]

        if let clientMsgId = clientMessageId {
            payload["clientMessageId"] = clientMsgId
        }

        print("📤 [WS] Emitting message:send, sessionId=\(sessionId)")
        socket.emit("message:send", payload)
        print("📤 [WS] Emit done")
    }

    // MARK: - 事件监听

    /// 注册事件监听，返回 token 用于后续移除
    @discardableResult
    func on(_ event: WebSocketEvent, handler: @escaping (WebSocketMessage) -> Void) -> EventHandlerToken {
        let token = EventHandlerToken(event: event)
        let tokenizedHandler = TokenizedHandler(token: token, handler: handler)

        if eventHandlers[event] == nil {
            eventHandlers[event] = []
        }
        eventHandlers[event]?.append(tokenizedHandler)

        return token
    }

    /// 移除特定的事件监听（按 token）
    func off(token: EventHandlerToken) {
        eventHandlers[token.event]?.removeAll { $0.token.id == token.id }
    }

    /// 移除某事件的所有监听（慎用，会影响其他模块）
    func off(_ event: WebSocketEvent) {
        eventHandlers[event] = nil
    }

    // MARK: - 权限请求处理

    private func handleApprovalRequest(data: [Any]) {

        guard let payload = data.first else {
            return
        }

        do {
            let jsonData = try JSONSerialization.data(withJSONObject: payload)
            let decoder = JSONDecoder()
            let request = try decoder.decode(ApprovalRequest.self, from: jsonData)


            // 触发权限请求事件回调
            eventHandlers[.approvalRequest]?.forEach { tokenizedHandler in
                // 将 ApprovalRequest 包装成 WebSocketMessage 格式
                let message = WebSocketMessage(
                    sessionId: request.sessionId,
                    message: nil,
                    projectPath: nil,
                    metadata: nil
                )
                tokenizedHandler.handler(message)
            }

            // 同时通过通知发送，方便 ViewModel 监听
            NotificationCenter.default.post(
                name: NSNotification.Name("ApprovalRequest"),
                object: nil,
                userInfo: [
                    "requestId": request.requestId,
                    "sessionId": request.sessionId,
                    "toolName": request.toolName,
                    "toolUseID": request.toolUseID,
                    "input": request.input ?? [:],
                    "description": request.description
                ]
            )

        } catch {
        }
    }

    /// 发送权限响应
    /// - Parameters:
    ///   - requestId: 请求 ID
    ///   - sessionId: 会话 ID
    ///   - action: 响应动作 (y=允许一次, n=拒绝, a=始终允许, 或 "n: 理由")
    ///   - toolUseId: 工具调用 ID（用于 ETerm 返回 approval-ack），可选，旧的 Alert 审批方式不传此参数
    func sendApprovalResponse(requestId: String, sessionId: String, action: String, toolUseId: String = "") {
        guard isConnected else {
            return
        }

        let payload: [String: Any] = [
            "requestId": requestId,
            "sessionId": sessionId,
            "action": action,
            "toolUseId": toolUseId
        ]

        socket.emit("approval-response", payload)

    }

    /// 处理权限超时通知
    private func handleApprovalTimeout(data: [Any]) {

        guard let payload = data.first else {
            return
        }

        do {
            let jsonData = try JSONSerialization.data(withJSONObject: payload)
            if let json = try JSONSerialization.jsonObject(with: jsonData) as? [String: Any],
               let requestId = json["requestId"] as? String,
               let message = json["message"] as? String {


                // 通过通知发送，让 ViewModel 关闭 Alert
                NotificationCenter.default.post(
                    name: NSNotification.Name("ApprovalTimeout"),
                    object: nil,
                    userInfo: [
                        "requestId": requestId,
                        "message": message
                    ]
                )
            }
        } catch {
        }
    }

    /// 处理延迟响应通知
    private func handleApprovalExpired(data: [Any]) {

        guard let payload = data.first else {
            return
        }

        do {
            let jsonData = try JSONSerialization.data(withJSONObject: payload)
            if let json = try JSONSerialization.jsonObject(with: jsonData) as? [String: Any],
               let requestId = json["requestId"] as? String,
               let message = json["message"] as? String {


                // 通过通知发送，让 UI 显示错误提示
                NotificationCenter.default.post(
                    name: NSNotification.Name("ApprovalExpired"),
                    object: nil,
                    userInfo: [
                        "requestId": requestId,
                        "message": message
                    ]
                )
            }
        } catch {
        }
    }

    /// 处理 ETerm 审批确认
    private func handleApprovalAck(data: [Any]) {

        guard let payload = data.first else {
            return
        }

        do {
            let jsonData = try JSONSerialization.data(withJSONObject: payload)
            if let json = try JSONSerialization.jsonObject(with: jsonData) as? [String: Any],
               let toolUseId = json["toolUseId"] as? String,
               let success = json["success"] as? Bool {

                let message = json["message"] as? String

                if let msg = message {
                }

                // 通过通知发送，让 ViewModel 更新状态
                var userInfo: [String: Any] = [
                    "toolUseId": toolUseId,
                    "success": success
                ]
                if let msg = message {
                    userInfo["message"] = msg
                }

                NotificationCenter.default.post(
                    name: NSNotification.Name("ApprovalAck"),
                    object: nil,
                    userInfo: userInfo
                )
            }
        } catch {
        }
    }

    /// 处理 SDK 错误通知
    private func handleSDKError(data: [Any]) {

        guard let payload = data.first else {
            return
        }

        do {
            let jsonData = try JSONSerialization.data(withJSONObject: payload)
            if let json = try JSONSerialization.jsonObject(with: jsonData) as? [String: Any],
               let sessionId = json["sessionId"] as? String,
               let error = json["error"] as? [String: Any],
               let errorType = error["type"] as? String,
               let errorMessage = error["message"] as? String {


                // 通过通知发送，让 ViewModel 停止 loading
                NotificationCenter.default.post(
                    name: NSNotification.Name("SDKError"),
                    object: nil,
                    userInfo: [
                        "sessionId": sessionId,
                        "errorType": errorType,
                        "errorMessage": errorMessage
                    ]
                )
            }
        } catch {
        }
    }

    /// 处理 Statusline 指标更新
    private func handleStatuslineMetricsUpdate(data: [Any]) {
        guard let payload = data.first else {
            return
        }

        do {
            let jsonData = try JSONSerialization.data(withJSONObject: payload)
            if let json = try JSONSerialization.jsonObject(with: jsonData) as? [String: Any] {

                let sessionId = json["sessionId"] as? String
                let connected = json["connected"] as? Bool ?? false
                let mode = json["mode"] as? String
                let contextLength = json["contextLength"] as? Int
                let contextPercentage = json["contextPercentage"] as? Double
                let inputTokens = json["inputTokens"] as? Int
                let outputTokens = json["outputTokens"] as? Int

                // 通过通知发送给 ViewModel
                var userInfo: [String: Any] = [
                    "connected": connected,
                    "timestamp": Date().timeIntervalSince1970
                ]

                if let sessionId = sessionId {
                    userInfo["sessionId"] = sessionId
                }
                if let mode = mode {
                    userInfo["mode"] = mode
                }
                if let contextLength = contextLength {
                    userInfo["contextLength"] = contextLength
                }
                if let contextPercentage = contextPercentage {
                    userInfo["contextPercentage"] = contextPercentage
                }
                if let inputTokens = inputTokens {
                    userInfo["inputTokens"] = inputTokens
                }
                if let outputTokens = outputTokens {
                    userInfo["outputTokens"] = outputTokens
                }

                NotificationCenter.default.post(
                    name: NSNotification.Name("StatuslineMetricsUpdate"),
                    object: nil,
                    userInfo: userInfo
                )
            }
        } catch {
        }
    }
}

// MARK: - Socket.IO URLSession Delegate (mTLS 支持)
class SocketURLSessionDelegate: NSObject, URLSessionDelegate {
    func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        let authMethod = challenge.protectionSpace.authenticationMethod

        switch authMethod {
        case NSURLAuthenticationMethodServerTrust:
            // 服务端证书验证
            handleServerTrust(challenge, completionHandler: completionHandler)

        case NSURLAuthenticationMethodClientCertificate:
            // 客户端证书
            handleClientCertificate(challenge, completionHandler: completionHandler)

        default:
            completionHandler(.performDefaultHandling, nil)
        }
    }

    private func handleServerTrust(
        _ challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        guard let serverTrust = challenge.protectionSpace.serverTrust else {
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }

        let host = challenge.protectionSpace.host

        if CertificateManager.shared.validateServerTrust(serverTrust, for: host) {
            let credential = URLCredential(trust: serverTrust)
            completionHandler(.useCredential, credential)
        } else {
            completionHandler(.cancelAuthenticationChallenge, nil)
        }
    }

    private func handleClientCertificate(
        _ challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        if let credential = CertificateManager.shared.getClientCredential() {
            completionHandler(.useCredential, credential)
        } else {
            completionHandler(.cancelAuthenticationChallenge, nil)
        }
    }
}
