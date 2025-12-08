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

// MARK: - WebSocket Manager
class WebSocketManager: ObservableObject {
    static let shared = WebSocketManager()

    @Published var isConnected = false
    @Published var lastError: Error?

    // 事件回调
    private var eventHandlers: [WebSocketEvent: [(WebSocketMessage) -> Void]] = [:]

    // 记录已 join 的 session (sessionId -> projectPath)
    private var joinedSessions: [String: String] = [:]

    // Socket.IO Manager 和 Socket
    private var manager: SocketManager!
    private var socket: SocketIOClient!

    private init() {
        // 延迟连接，等待显式调用 connect()
    }

    // MARK: - Socket 设置

    private func setupSocket(token: String) {
        // TODO: Move to configuration
        // mTLS 模式使用 https，否则使用 http
        let useMTLS = CertificateManager.shared.isReady
        let protocol_ = useMTLS ? "https" : "http"
        let url = URL(string: "\(protocol_)://10.0.0.1:10005")!

        print("✅ [Socket.IO] 使用 Token 设置连接: \(token.prefix(20))...")
        if useMTLS {
            print("🔐 [Socket.IO] mTLS 模式已启用")
        }

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
            print("✅ [Socket.IO] 连接成功")
            DispatchQueue.main.async {
                self?.isConnected = true
            }
        }

        // 连接断开
        socket.on(clientEvent: .disconnect) { [weak self] data, ack in
            print("❌ [Socket.IO] 连接断开")
            DispatchQueue.main.async {
                self?.isConnected = false
            }
        }

        // 连接错误
        socket.on(clientEvent: .error) { [weak self] data, ack in
            print("❌ [Socket.IO] 连接错误: \(data)")

            // 检查是否是认证错误
            if let errorDict = data.first as? [String: Any],
               let message = errorDict["message"] as? String {
                if message.contains("Authentication") || message.contains("Token") {
                    print("❌ [Socket.IO] 认证错误，清除 Token 并重新获取")
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
            print("🔄 [Socket.IO] 重连成功")
        }

        // 重连尝试
        socket.on(clientEvent: .reconnectAttempt) { data, ack in
            print("🔄 [Socket.IO] 尝试重连...")
        }

        // 监听业务事件
        socket.on("message:new") { [weak self] data, ack in
            print("🔔 [Socket.IO] 原始 message:new 事件触发! data count: \(data.count)")
            if let firstData = data.first {
                print("🔔 [Socket.IO] 第一个数据类型: \(type(of: firstData))")
                print("🔔 [Socket.IO] 第一个数据内容: \(firstData)")
            }
            self?.handleBusinessEvent(.messageNew, data: data)
        }

        socket.on("project:updated") { [weak self] data, ack in
            print("🔔 [Socket.IO] 原始 project:updated 事件触发!")
            self?.handleBusinessEvent(.projectUpdated, data: data)
        }

        socket.on("session:updated") { [weak self] data, ack in
            print("🔔 [Socket.IO] 原始 session:updated 事件触发!")
            self?.handleBusinessEvent(.sessionUpdated, data: data)
        }

        // 监听权限请求
        socket.on("approval-request") { [weak self] data, ack in
            print("🔔 [Socket.IO] 收到权限请求!")
            self?.handleApprovalRequest(data: data)
        }

        // 监听权限超时
        socket.on("approval-timeout") { [weak self] data, ack in
            print("⏰ [Socket.IO] 收到权限超时通知!")
            self?.handleApprovalTimeout(data: data)
        }

        // 监听延迟响应
        socket.on("approval-expired") { [weak self] data, ack in
            print("⚠️ [Socket.IO] 收到延迟响应通知!")
            self?.handleApprovalExpired(data: data)
        }

        // 监听 SDK 错误
        socket.on("sdk-error") { [weak self] data, ack in
            print("❌ [Socket.IO] 收到 SDK 错误通知!")
            self?.handleSDKError(data: data)
        }

        // 监听 Statusline 指标更新
        socket.on("statusline:metricsUpdate") { [weak self] data, ack in
            self?.handleStatuslineMetricsUpdate(data: data)
        }
    }

    private func handleBusinessEvent(_ event: WebSocketEvent, data: [Any]) {
        print("📨 [Socket.IO] 收到事件: \(event.rawValue)")
        print("📨 [Socket.IO] 当前事件回调数量: \(eventHandlers[event]?.count ?? 0)")

        guard let payload = data.first else {
            print("⚠️ [Socket.IO] 事件数据为空")
            return
        }

        print("📨 [Socket.IO] 开始解析 payload...")

        do {
            let jsonData = try JSONSerialization.data(withJSONObject: payload)
            print("📨 [Socket.IO] JSON 序列化成功，数据大小: \(jsonData.count) bytes")

            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .iso8601

            let message = try decoder.decode(WebSocketMessage.self, from: jsonData)
            print("📨 [Socket.IO] 解码成功! sessionId: \(message.sessionId ?? "nil"), message: \(message.message != nil)")

            // 触发事件回调
            let handlerCount = eventHandlers[event]?.count ?? 0
            print("📨 [Socket.IO] 准备触发 \(handlerCount) 个回调")

            eventHandlers[event]?.forEach { handler in
                print("📨 [Socket.IO] 调用回调...")
                handler(message)
            }
        } catch {
            print("❌ [Socket.IO] 解析消息失败: \(error)")
            if let decodingError = error as? DecodingError {
                print("❌ [Socket.IO] 详细错误: \(decodingError)")
            }
        }
    }

    // MARK: - 连接管理

    func connect() {
        // 检查是否有 Token
        guard let token = AuthService.shared.getToken() else {
            print("❌ [Socket.IO] 缺少 Token，无法连接")
            print("⚠️ [Socket.IO] 请先调用 AuthService.ensureAuthenticated() 获取 Token")
            return
        }

        // 如果 Socket 未初始化，先设置
        if manager == nil {
            setupSocket(token: token)
        }

        // 连接
        print("🔌 [Socket.IO] 开始连接...")
        socket.connect()
    }

    func disconnect() {
        print("🔌 [Socket.IO] 断开连接...")
        socket.disconnect()
    }

    /// 重新设置 Socket（用于 Token 更新后）
    func reconnectWithNewToken() {
        guard let token = AuthService.shared.getToken() else {
            print("❌ [Socket.IO] Token 仍然缺失，无法重连")
            return
        }

        print("🔄 [Socket.IO] Token 已更新，重新设置连接...")

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
            print("⚠️ [Socket.IO] 未连接,无法加入会话")
            return
        }

        // 避免重复 join
        if joinedSessions[sessionId] != nil {
            print("⚠️ [Socket.IO] 会话已加入,跳过: \(sessionId)")
            return
        }

        socket.emit("join", [
            "sessionId": sessionId,
            "clientType": "swift",
            "projectPath": projectPath
        ])

        // 记录已 join 的 session
        joinedSessions[sessionId] = projectPath

        print("📌 [Socket.IO] 已加入会话: \(sessionId)")
        print("   项目路径: \(projectPath)")
        print("   客户端类型: swift")
    }

    func subscribeToSession(_ sessionId: String, projectPath: String) {
        guard isConnected else {
            print("⚠️ [Socket.IO] 未连接,无法订阅会话")
            return
        }

        socket.emit("session:subscribe", [
            "sessionId": sessionId,
            "projectPath": projectPath
        ])

        print("📌 [Socket.IO] 已订阅会话: \(sessionId)")
        print("   项目路径: \(projectPath)")
    }

    func unsubscribeFromSession(_ sessionId: String) {
        guard isConnected else { return }

        socket.emit("session:unsubscribe", [
            "sessionId": sessionId
        ])

        // 清理 join 记录
        joinedSessions.removeValue(forKey: sessionId)

        print("📌 [Socket.IO] 已取消订阅会话: \(sessionId)")
    }

    // MARK: - 发送消息

    func sendMessage(_ text: String, sessionId: String) {
        guard isConnected else {
            print("⚠️ [Socket.IO] 未连接,无法发送消息")
            return
        }

        socket.emit("message:send", [
            "sessionId": sessionId,
            "text": text
        ])

        print("📤 [Socket.IO] 已发送消息: sessionId=\(sessionId), length=\(text.count)")
    }

    // MARK: - 事件监听

    func on(_ event: WebSocketEvent, handler: @escaping (WebSocketMessage) -> Void) {
        if eventHandlers[event] == nil {
            eventHandlers[event] = []
        }
        eventHandlers[event]?.append(handler)
    }

    func off(_ event: WebSocketEvent) {
        eventHandlers[event] = nil
    }

    // MARK: - 权限请求处理

    private func handleApprovalRequest(data: [Any]) {
        print("🔐 [Socket.IO] 处理权限请求")

        guard let payload = data.first else {
            print("⚠️ [Socket.IO] 权限请求数据为空")
            return
        }

        do {
            let jsonData = try JSONSerialization.data(withJSONObject: payload)
            let decoder = JSONDecoder()
            let request = try decoder.decode(ApprovalRequest.self, from: jsonData)

            print("🔐 [Socket.IO] 权限请求解析成功:")
            print("   RequestID: \(request.requestId)")
            print("   Tool: \(request.toolName)")
            print("   Description: \(request.description)")

            // 触发权限请求事件回调
            eventHandlers[.approvalRequest]?.forEach { handler in
                // 将 ApprovalRequest 包装成 WebSocketMessage 格式
                let message = WebSocketMessage(
                    sessionId: request.sessionId,
                    message: nil,
                    projectPath: nil,
                    metadata: nil
                )
                handler(message)
            }

            // 同时通过通知发送，方便 ViewModel 监听
            NotificationCenter.default.post(
                name: NSNotification.Name("ApprovalRequest"),
                object: nil,
                userInfo: [
                    "requestId": request.requestId,
                    "toolName": request.toolName,
                    "description": request.description
                ]
            )

        } catch {
            print("❌ [Socket.IO] 权限请求解析失败: \(error)")
        }
    }

    /// 发送权限响应
    func sendApprovalResponse(requestId: String, approved: Bool, reason: String? = nil) {
        guard isConnected else {
            print("⚠️ [Socket.IO] 未连接,无法发送权限响应")
            return
        }

        var payload: [String: Any] = [
            "requestId": requestId,
            "approved": approved
        ]

        if let reason = reason {
            payload["reason"] = reason
        }

        socket.emit("approval-response", payload)

        print("✅ [Socket.IO] 已发送权限响应:")
        print("   RequestID: \(requestId)")
        print("   Approved: \(approved)")
        if let reason = reason {
            print("   Reason: \(reason)")
        }
    }

    /// 处理权限超时通知
    private func handleApprovalTimeout(data: [Any]) {
        print("⏰ [Socket.IO] 处理权限超时")

        guard let payload = data.first else {
            print("⚠️ [Socket.IO] 超时通知数据为空")
            return
        }

        do {
            let jsonData = try JSONSerialization.data(withJSONObject: payload)
            if let json = try JSONSerialization.jsonObject(with: jsonData) as? [String: Any],
               let requestId = json["requestId"] as? String,
               let message = json["message"] as? String {

                print("⏰ [Socket.IO] 权限超时:")
                print("   RequestID: \(requestId)")
                print("   Message: \(message)")

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
            print("❌ [Socket.IO] 超时通知解析失败: \(error)")
        }
    }

    /// 处理延迟响应通知
    private func handleApprovalExpired(data: [Any]) {
        print("⚠️ [Socket.IO] 处理延迟响应")

        guard let payload = data.first else {
            print("⚠️ [Socket.IO] 延迟响应数据为空")
            return
        }

        do {
            let jsonData = try JSONSerialization.data(withJSONObject: payload)
            if let json = try JSONSerialization.jsonObject(with: jsonData) as? [String: Any],
               let requestId = json["requestId"] as? String,
               let message = json["message"] as? String {

                print("⚠️ [Socket.IO] 延迟响应:")
                print("   RequestID: \(requestId)")
                print("   Message: \(message)")

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
            print("❌ [Socket.IO] 延迟响应解析失败: \(error)")
        }
    }

    /// 处理 SDK 错误通知
    private func handleSDKError(data: [Any]) {
        print("❌ [Socket.IO] 处理 SDK 错误")

        guard let payload = data.first else {
            print("⚠️ [Socket.IO] SDK 错误数据为空")
            return
        }

        do {
            let jsonData = try JSONSerialization.data(withJSONObject: payload)
            if let json = try JSONSerialization.jsonObject(with: jsonData) as? [String: Any],
               let sessionId = json["sessionId"] as? String,
               let error = json["error"] as? [String: Any],
               let errorType = error["type"] as? String,
               let errorMessage = error["message"] as? String {

                print("❌ [Socket.IO] SDK 错误:")
                print("   SessionId: \(sessionId)")
                print("   Type: \(errorType)")
                print("   Message: \(errorMessage)")

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
            print("❌ [Socket.IO] SDK 错误解析失败: \(error)")
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
            print("❌ [Socket.IO] Statusline 数据解析失败: \(error)")
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
            print("✅ [Socket.IO] 服务端证书验证通过: \(host)")
        } else {
            print("❌ [Socket.IO] 服务端证书验证失败: \(host)")
            completionHandler(.cancelAuthenticationChallenge, nil)
        }
    }

    private func handleClientCertificate(
        _ challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        if let credential = CertificateManager.shared.getClientCredential() {
            print("✅ [Socket.IO] 提供客户端证书")
            completionHandler(.useCredential, credential)
        } else {
            print("❌ [Socket.IO] 无法提供客户端证书")
            completionHandler(.cancelAuthenticationChallenge, nil)
        }
    }
}
