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
        setupSocket()
    }

    // MARK: - Socket 设置

    private func setupSocket() {
        // TODO: Move to configuration
        let url = URL(string: "http://192.168.50.229:10005")!

        manager = SocketManager(socketURL: url, config: [
            .log(false),
            .compress,
            .reconnects(true),
            .reconnectAttempts(5),
            .reconnectWait(2)
        ])

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
        print("🔌 [Socket.IO] 正在连接到 \(manager.socketURL)...")
        socket.connect()
    }

    func disconnect() {
        print("🔌 [Socket.IO] 断开连接...")
        socket.disconnect()
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
}
