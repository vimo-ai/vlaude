//
//  VlaudeClient.swift
//  Vlaude
//
//  统一的 API 客户端，基于 CoreNetworkKit
//

import Foundation
import CoreNetworkKit

/// Vlaude API 客户端
final class VlaudeClient {
    static let shared = VlaudeClient()

    private let client: APIClient

    private init() {
        let engine = VlaudeNetworkEngine()
        let tokenStorage = VlaudeTokenStorage()

        let jsonDecoder = JSONDecoder()
        jsonDecoder.dateDecodingStrategy = .iso8601

        self.client = APIClient(
            engine: engine,
            tokenStorage: tokenStorage,
            jsonDecoder: jsonDecoder
        )

        let useMTLS = CertificateManager.shared.isReady
        print("🌐 [VlaudeClient] 服务器: \(VlaudeConfig.serverURL)")
        if useMTLS {
            print("🔐 [VlaudeClient] mTLS 模式已启用")
        } else {
            print("⚠️ [VlaudeClient] 未找到客户端证书，使用普通 HTTP")
        }
    }

    // MARK: - Session APIs

    func getSessions(projectPath: String, limit: Int = 20, offset: Int = 0) async throws -> (sessions: [Session], total: Int, hasMore: Bool) {
        let request = GetSessionsRequest(projectPath: projectPath, limit: limit, offset: offset)
        let response = try await client.send(request)
        return (response.data, response.total, response.hasMore)
    }

    func getSessionDetail(sessionId: String) async throws -> Session? {
        let request = GetSessionDetailRequest(sessionId: sessionId)
        let response = try await client.send(request)
        return response.data
    }

    func getSessionMessages(
        sessionId: String,
        projectPath: String,
        limit: Int = 50,
        offset: Int = 0,
        order: String = "asc"
    ) async throws -> (messages: [Message], total: Int, hasMore: Bool) {
        let request = GetSessionMessagesRequest(
            sessionId: sessionId,
            projectPath: projectPath,
            limit: limit,
            offset: offset,
            order: order
        )
        print("🌐 [VlaudeClient] 请求消息: \(request.baseURL)\(request.path)")

        let response = try await client.send(request)

        guard response.success else {
            let errorMsg = response.message ?? "获取消息失败"
            print("❌ [VlaudeClient] 服务器返回错误: \(errorMsg)")
            throw CoreNetworkKit.APIError.custom(code: -1, message: errorMsg)
        }

        guard let data = response.data,
              let total = response.total,
              let hasMore = response.hasMore else {
            print("❌ [VlaudeClient] 响应数据不完整")
            throw CoreNetworkKit.APIError.noData(message: "响应数据不完整")
        }

        print("✅ [VlaudeClient] 成功获取消息: \(data.count) 条")
        return (data, total, hasMore)
    }

    // MARK: - Project APIs

    func getProjects(limit: Int = 10, offset: Int = 0) async throws -> (projects: [Project], total: Int, hasMore: Bool) {
        let request = GetProjectsRequest(limit: limit, offset: offset)
        let response = try await client.send(request)
        return (response.data, response.total, response.hasMore)
    }

    func getProject(id: Int) async throws -> Project {
        let request = GetProjectRequest(id: id)
        let response = try await client.send(request)
        guard let project = response.data else {
            throw CoreNetworkKit.APIError.custom(code: -1, message: response.message ?? "Project not found")
        }
        return project
    }

    // MARK: - Create Session

    /// 创建会话的结果
    enum CreateSessionResult {
        case session(Session)           // SDK 模式，直接返回 Session
        case eterm(String, String)      // ETerm 模式，返回 (提示消息, requestId)
    }

    func createSession(projectPath: String, prompt: String? = nil, requestId: String? = nil) async throws -> CreateSessionResult {
        let request = CreateSessionRequest(projectPath: projectPath, prompt: prompt, requestId: requestId)
        let response = try await client.send(request)

        guard response.success else {
            throw CoreNetworkKit.APIError.custom(code: -1, message: response.message ?? "创建会话失败")
        }

        // 检查是否是 ETerm 模式
        if response.mode == "eterm" {
            return .eterm(response.message ?? "已通知 ETerm 创建会话", response.requestId ?? "")
        }

        // SDK 模式，返回 Session
        guard let session = response.data else {
            throw CoreNetworkKit.APIError.noData(message: "创建会话失败：未返回会话数据")
        }

        return .session(session)
    }

    // MARK: - Auth APIs

    func generateToken(clientId: String, clientType: String, deviceName: String) async throws -> String {
        let request = GenerateTokenRequest(clientId: clientId, clientType: clientType, deviceName: deviceName)
        let response = try await client.send(request)

        guard response.success, let token = response.data?.token else {
            throw CoreNetworkKit.APIError.custom(code: -1, message: response.message ?? "生成 Token 失败")
        }

        return token
    }
}
