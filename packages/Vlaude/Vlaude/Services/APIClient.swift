//
//  APIClient.swift
//  Vlaude
//
//  Created by Claude on 2025/11/16.
//

import Foundation

enum APIError: Error {
    case invalidURL
    case networkError(Error)
    case decodingError(Error)
    case serverError(String)
    case unknown
}

class APIClient: NSObject {
    static let shared = APIClient()

    private let baseURL: String
    private var session: URLSession!

    private override init() {
        // 使用统一配置管理器
        let vlaudeConfig = VlaudeConfig.shared
        let useMTLS = CertificateManager.shared.isReady
        let protocol_ = useMTLS ? "https" : "http"
        self.baseURL = "\(protocol_)://\(vlaudeConfig.serverURL)"

        super.init()

        let sessionConfig = URLSessionConfiguration.default
        sessionConfig.timeoutIntervalForRequest = 30
        sessionConfig.timeoutIntervalForResource = 300

        // 使用自定义 delegate 处理证书挑战
        self.session = URLSession(configuration: sessionConfig, delegate: self, delegateQueue: nil)

        if useMTLS {
            print("🔐 [APIClient] mTLS 模式已启用")
        } else {
            print("⚠️ [APIClient] 未找到客户端证书，使用普通 HTTP")
        }
    }

    // MARK: - Generic Request
    private func request<T: Decodable>(
        path: String,
        method: String = "GET",
        body: Data? = nil
    ) async throws -> T {
        guard let url = URL(string: "\(baseURL)\(path)") else {
            throw APIError.invalidURL
        }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body

        do {
            let (data, response) = try await session.data(for: request)

            guard let httpResponse = response as? HTTPURLResponse else {
                throw APIError.unknown
            }

            guard (200...299).contains(httpResponse.statusCode) else {
                let errorMessage = String(data: data, encoding: .utf8) ?? "Unknown error"
                throw APIError.serverError(errorMessage)
            }

            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .iso8601
            let result = try decoder.decode(T.self, from: data)
            return result

        } catch let error as APIError {
            throw error
        } catch let error as DecodingError {
            throw APIError.decodingError(error)
        } catch {
            throw APIError.networkError(error)
        }
    }

    // MARK: - Session APIs
    func getSessions(projectPath: String, limit: Int = 20, offset: Int = 0) async throws -> (sessions: [Session], total: Int, hasMore: Bool) {
        // URL 编码项目路径
        let encodedPath = projectPath.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? projectPath

        let response: SessionListResponse = try await request(
            path: "/sessions/by-path?path=\(encodedPath)&limit=\(limit)&offset=\(offset)"
        )
        return (response.data, response.total, response.hasMore)
    }

    func getSessionDetail(sessionId: String) async throws -> Session? {
        let response: SessionDetailResponse = try await request(
            path: "/sessions/by-session-id/\(sessionId)"
        )
        return response.data
    }

    func getSessionMessages(
        sessionId: String,
        limit: Int = 50,
        offset: Int = 0,
        order: String = "asc"
    ) async throws -> (messages: [Message], total: Int, hasMore: Bool) {
        let path = "/sessions/\(sessionId)/messages?limit=\(limit)&offset=\(offset)&order=\(order)"
        print("🌐 [APIClient] 请求消息: \(baseURL)\(path)")

        do {
            let response: MessageListResponse = try await request(path: path)

            // 检查响应是否成功
            guard response.success else {
                let errorMsg = response.message ?? "获取消息失败"
                print("❌ [APIClient] 服务器返回错误: \(errorMsg)")
                throw APIError.serverError(errorMsg)
            }

            // 确保 data 存在
            guard let data = response.data,
                  let total = response.total,
                  let hasMore = response.hasMore else {
                print("❌ [APIClient] 响应数据不完整")
                throw APIError.serverError("响应数据不完整")
            }

            print("✅ [APIClient] 成功获取消息: \(data.count) 条")
            return (data, total, hasMore)
        } catch {
            print("❌ [APIClient] 请求失败: \(error)")
            throw error
        }
    }

    // MARK: - Project APIs
    func getProjects(limit: Int = 10, offset: Int = 0) async throws -> (projects: [Project], total: Int, hasMore: Bool) {
        let response: ProjectListResponse = try await request(
            path: "/projects?limit=\(limit)&offset=\(offset)"
        )
        return (response.data, response.total, response.hasMore)
    }

    func getProject(id: Int) async throws -> Project {
        let response: ProjectDetailResponse = try await request(
            path: "/projects/\(id)"
        )
        guard let project = response.data else {
            throw APIError.serverError(response.message ?? "Project not found")
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
        let body = try JSONEncoder().encode(CreateSessionRequest(projectPath: projectPath, prompt: prompt, requestId: requestId))

        let response: CreateSessionResponse = try await request(
            path: "/sessions",
            method: "POST",
            body: body
        )

        guard response.success else {
            throw APIError.serverError(response.message ?? "创建会话失败")
        }

        // 检查是否是 ETerm 模式
        if response.mode == "eterm" {
            return .eterm(response.message ?? "已通知 ETerm 创建会话", response.requestId ?? "")
        }

        // SDK 模式，返回 Session
        guard let session = response.data else {
            throw APIError.serverError("创建会话失败：未返回会话数据")
        }

        return .session(session)
    }

    // MARK: - Auth APIs
    func generateToken(clientId: String, clientType: String, deviceName: String) async throws -> String {
        let body = try JSONEncoder().encode(GenerateTokenRequest(clientId: clientId, clientType: clientType, deviceName: deviceName))

        let response: GenerateTokenResponse = try await request(
            path: "/auth/generate-token",
            method: "POST",
            body: body
        )

        guard response.success, let token = response.data?.token else {
            throw APIError.serverError(response.message ?? "生成 Token 失败")
        }

        return token
    }
}

// MARK: - Request/Response Types
private struct CreateSessionRequest: Codable {
    let projectPath: String
    let prompt: String?
    let requestId: String?
}

private struct CreateSessionResponse: Codable {
    let success: Bool
    let mode: String?      // "eterm" 或 "sdk"
    let data: Session?
    let message: String?
    let requestId: String? // ETerm 模式时返回的 requestId
}

private struct GenerateTokenRequest: Codable {
    let clientId: String
    let clientType: String
    let deviceName: String
}

private struct GenerateTokenResponse: Codable {
    let success: Bool
    let data: TokenData?
    let message: String?
}

private struct TokenData: Codable {
    let token: String
}

// Helper response types
private struct ProjectDetailResponse: Codable {
    let success: Bool
    let data: Project?
    let message: String?
}

// MARK: - URLSessionDelegate (mTLS 证书处理)
extension APIClient: URLSessionDelegate {
    func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        let authMethod = challenge.protectionSpace.authenticationMethod

        switch authMethod {
        case NSURLAuthenticationMethodServerTrust:
            // 服务端证书验证（自签名证书）
            handleServerTrust(challenge, completionHandler: completionHandler)

        case NSURLAuthenticationMethodClientCertificate:
            // 服务端要求客户端证书
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

        // 使用 CertificateManager 验证服务端证书
        if CertificateManager.shared.validateServerTrust(serverTrust, for: host) {
            let credential = URLCredential(trust: serverTrust)
            completionHandler(.useCredential, credential)
            print("✅ [APIClient] 服务端证书验证通过: \(host)")
        } else {
            print("❌ [APIClient] 服务端证书验证失败: \(host)")
            completionHandler(.cancelAuthenticationChallenge, nil)
        }
    }

    private func handleClientCertificate(
        _ challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        if let credential = CertificateManager.shared.getClientCredential() {
            print("✅ [APIClient] 提供客户端证书")
            completionHandler(.useCredential, credential)
        } else {
            print("❌ [APIClient] 无法提供客户端证书")
            completionHandler(.cancelAuthenticationChallenge, nil)
        }
    }
}
