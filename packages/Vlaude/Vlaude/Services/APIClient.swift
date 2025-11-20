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

class APIClient {
    static let shared = APIClient()

    private let baseURL: String
    private let session: URLSession

    private init() {
        // TODO: Move to configuration
        self.baseURL = "http://10.0.0.1:10005"

        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 30
        config.timeoutIntervalForResource = 300
        self.session = URLSession(configuration: config)
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
    func createSession(projectPath: String, prompt: String? = nil) async throws -> Session {
        let body = try JSONEncoder().encode(CreateSessionRequest(projectPath: projectPath, prompt: prompt))

        let response: CreateSessionResponse = try await request(
            path: "/sessions",
            method: "POST",
            body: body
        )

        guard response.success, let session = response.data else {
            throw APIError.serverError(response.message ?? "创建会话失败")
        }

        return session
    }
}

// MARK: - Request/Response Types
private struct CreateSessionRequest: Codable {
    let projectPath: String
    let prompt: String?
}

private struct CreateSessionResponse: Codable {
    let success: Bool
    let data: Session?
    let message: String?
}

// Helper response types
private struct ProjectDetailResponse: Codable {
    let success: Bool
    let data: Project?
    let message: String?
}
