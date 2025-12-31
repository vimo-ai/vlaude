//
//  VlaudeRequests.swift
//  Vlaude
//
//  定义所有 API 请求，使用 CoreNetworkKit Request 协议
//

import Foundation
import CoreNetworkKit

// MARK: - Base Configuration

enum VlaudeAPI {
    /// 服务器主机地址（可通过 Info.plist 的 VLAUDE_SERVER_HOST 配置，默认 localhost）
    static var serverHost: String {
        Bundle.main.object(forInfoDictionaryKey: "VLAUDE_SERVER_HOST") as? String ?? "localhost"
    }

    /// 服务器端口（可通过 Info.plist 的 VLAUDE_SERVER_PORT 配置，默认 10005）
    static var serverPort: Int {
        Bundle.main.object(forInfoDictionaryKey: "VLAUDE_SERVER_PORT") as? Int ?? 10005
    }

    static var baseURL: URL {
        let useMTLS = CertificateManager.shared.isReady
        let scheme = useMTLS ? "https" : "http"
        return URL(string: "\(scheme)://\(serverHost):\(serverPort)")!
    }
}

// MARK: - Token Storage (目前无需认证)

final class VlaudeTokenStorage: TokenStorage {
    func getToken() async -> String? {
        return nil
    }
}

// MARK: - Session Requests

struct GetSessionsRequest: Request {
    typealias Response = SessionListResponse

    let projectPath: String
    let limit: Int
    let offset: Int

    var baseURL: URL { VlaudeAPI.baseURL }
    var path: String { "/sessions/by-path" }
    var method: HTTPMethod { .get }

    var query: [String: Any]? {
        [
            "path": projectPath,
            "limit": limit,
            "offset": offset
        ]
    }
}

struct GetSessionDetailRequest: Request {
    typealias Response = SessionDetailResponse

    let sessionId: String

    var baseURL: URL { VlaudeAPI.baseURL }
    var path: String { "/sessions/by-session-id/\(sessionId)" }
    var method: HTTPMethod { .get }
}

struct GetSessionMessagesRequest: Request {
    typealias Response = MessageListResponse

    let sessionId: String
    let projectPath: String
    let limit: Int
    let offset: Int
    let order: String

    var baseURL: URL { VlaudeAPI.baseURL }
    var path: String { "/sessions/\(sessionId)/messages" }
    var method: HTTPMethod { .get }

    var query: [String: Any]? {
        [
            "limit": limit,
            "offset": offset,
            "order": order,
            "projectPath": projectPath
        ]
    }
}

struct CreateSessionRequestBody: Codable {
    let projectPath: String
    let prompt: String?
    let requestId: String?
}

struct CreateSessionRequest: Request {
    typealias Response = CreateSessionResponse
    typealias Body = CreateSessionRequestBody

    let projectPath: String
    let prompt: String?
    let requestId: String?

    var baseURL: URL { VlaudeAPI.baseURL }
    var path: String { "/sessions" }
    var method: HTTPMethod { .post }

    var body: CreateSessionRequestBody? {
        CreateSessionRequestBody(projectPath: projectPath, prompt: prompt, requestId: requestId)
    }

    var headers: [String: String]? {
        ["Content-Type": "application/json"]
    }
}

// MARK: - Project Requests

struct GetProjectsRequest: Request {
    typealias Response = ProjectListResponse

    let limit: Int
    let offset: Int

    var baseURL: URL { VlaudeAPI.baseURL }
    var path: String { "/projects" }
    var method: HTTPMethod { .get }

    var query: [String: Any]? {
        ["limit": limit, "offset": offset]
    }
}

struct GetProjectRequest: Request {
    typealias Response = ProjectDetailResponse

    let id: Int

    var baseURL: URL { VlaudeAPI.baseURL }
    var path: String { "/projects/\(id)" }
    var method: HTTPMethod { .get }
}

// MARK: - Auth Requests

struct GenerateTokenRequestBody: Codable {
    let clientId: String
    let clientType: String
    let deviceName: String
}

struct GenerateTokenRequest: Request {
    typealias Response = GenerateTokenResponse
    typealias Body = GenerateTokenRequestBody

    let clientId: String
    let clientType: String
    let deviceName: String

    var baseURL: URL { VlaudeAPI.baseURL }
    var path: String { "/auth/generate-token" }
    var method: HTTPMethod { .post }

    var body: GenerateTokenRequestBody? {
        GenerateTokenRequestBody(clientId: clientId, clientType: clientType, deviceName: deviceName)
    }

    var headers: [String: String]? {
        ["Content-Type": "application/json"]
    }
}

// MARK: - Response Types

struct CreateSessionResponse: Codable {
    let success: Bool
    let mode: String?
    let data: Session?
    let message: String?
    let requestId: String?
}

struct ProjectDetailResponse: Codable {
    let success: Bool
    let data: Project?
    let message: String?
}

struct GenerateTokenResponse: Codable {
    let success: Bool
    let data: TokenData?
    let message: String?

    struct TokenData: Codable {
        let token: String
    }
}
