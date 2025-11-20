//
//  SessionListViewModel.swift
//  Vlaude
//
//  Created by Claude on 2025/11/16.
//

import Foundation
import Combine

@MainActor
class SessionListViewModel: ObservableObject {
    @Published var sessions: [Session] = []
    @Published var isLoading = false
    @Published var isLoadingMore = false
    @Published var errorMessage: String?
    @Published var isCreatingSession = false
    @Published var hasMore = false

    private let apiClient = APIClient.shared
    private let wsManager = WebSocketManager.shared
    private var loadTask: Task<Void, Never>?
    private var currentOffset = 0
    private let pageSize = 20
    private var currentProjectPath: String?

    init() {
        setupWebSocketListeners()
    }

    func loadSessions(projectPath: String, reset: Bool = false) async {
        // 保存当前项目路径（用于 WebSocket 过滤）
        currentProjectPath = projectPath

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

            // 使用 defer 确保状态一定会被重置
            defer {
                isLoading = false
                isLoadingMore = false
                loadTask = nil
            }

            do {
                // 检查是否被取消
                try Task.checkCancellation()

                let result = try await apiClient.getSessions(
                    projectPath: projectPath,
                    limit: pageSize,
                    offset: currentOffset
                )

                // 再次检查取消状态(请求完成后)
                try Task.checkCancellation()

                if reset {
                    sessions = result.sessions
                } else {
                    sessions.append(contentsOf: result.sessions)
                }

                hasMore = result.hasMore
                currentOffset += result.sessions.count

                print("📱 [SessionListViewModel] 加载完成: 当前\(sessions.count)个, hasMore=\(hasMore)")
            } catch is CancellationError {
                // Task 被取消,静默处理
                print("⚠️ [SessionListViewModel] 加载被取消")
            } catch let error as APIError {
                errorMessage = handleAPIError(error)
            } catch {
                errorMessage = "未知错误: \(error.localizedDescription)"
            }
        }

        await loadTask?.value
    }

    private func handleAPIError(_ error: APIError) -> String {
        switch error {
        case .invalidURL:
            return "无效的 URL"
        case .networkError(let error):
            return "网络错误: \(error.localizedDescription)"
        case .decodingError(let error):
            return "数据解析错误: \(error.localizedDescription)"
        case .serverError(let message):
            return "服务器错误: \(message)"
        case .unknown:
            return "未知错误"
        }
    }

    /// 创建新会话
    /// - Parameters:
    ///   - projectPath: 项目路径
    ///   - prompt: 可选的初始提示词(默认 "Hi")
    /// - Returns: 创建的 Session,失败返回 nil
    func createSession(projectPath: String, prompt: String? = nil) async -> Session? {
        isCreatingSession = true
        errorMessage = nil

        defer {
            isCreatingSession = false
        }

        do {
            let session = try await apiClient.createSession(projectPath: projectPath, prompt: prompt)
            print("✅ [SessionListViewModel] 会话创建成功: \(session.sessionId)")

            // 创建成功后刷新列表
            await loadSessions(projectPath: projectPath)

            return session
        } catch let error as APIError {
            errorMessage = handleAPIError(error)
            print("❌ [SessionListViewModel] 创建会话失败: \(errorMessage ?? "")")
            return nil
        } catch {
            errorMessage = "创建会话失败: \(error.localizedDescription)"
            print("❌ [SessionListViewModel] 创建会话失败: \(errorMessage ?? "")")
            return nil
        }
    }

    // MARK: - WebSocket 热更新

    /// 设置 WebSocket 监听器
    private func setupWebSocketListeners() {
        wsManager.on(.sessionUpdated) { [weak self] message in
            guard let self = self else { return }

            print("🔔 [SessionListViewModel] 收到会话更新事件")

            // 异步刷新会话列表（简单策略：重新加载）
            Task { @MainActor in
                guard let projectPath = self.currentProjectPath else {
                    print("⚠️ [SessionListViewModel] 当前项目路径为空，跳过刷新")
                    return
                }

                await self.refreshSilently(projectPath: projectPath)
            }
        }
    }

    /// 静默刷新（后台更新，不显示 loading）
    private func refreshSilently(projectPath: String) async {
        do {
            let result = try await apiClient.getSessions(
                projectPath: projectPath,
                limit: currentOffset + pageSize,  // 加载当前已显示的所有数据
                offset: 0
            )

            // 更新会话列表
            sessions = result.sessions
            hasMore = result.hasMore

            print("✅ [SessionListViewModel] 静默刷新完成: \(sessions.count) 个会话")
        } catch {
            print("⚠️ [SessionListViewModel] 静默刷新失败: \(error.localizedDescription)")
            // 静默失败，不显示错误信息
        }
    }
}
