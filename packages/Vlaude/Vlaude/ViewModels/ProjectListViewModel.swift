//
//  ProjectListViewModel.swift
//  Vlaude
//
//  Created by Claude on 2025/11/16.
//

import Foundation
import Combine

@MainActor
class ProjectListViewModel: ObservableObject {
    @Published var projects: [Project] = []
    @Published var isLoading = false
    @Published var isLoadingMore = false
    @Published var errorMessage: String?
    @Published var hasMore = false

    private let apiClient = APIClient.shared
    private let wsManager = WebSocketManager.shared
    private var loadTask: Task<Void, Never>?
    private var currentOffset = 0
    private let pageSize = 10
    private var isListening = false  // 监听状态标记

    func loadProjects(reset: Bool = false) async {
        // 防止重复加载
        if loadTask != nil {
            return
        }

        loadTask = Task {
            if reset {
                isLoading = true
                currentOffset = 0
                projects = []
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

                let result = try await apiClient.getProjects(
                    limit: pageSize,
                    offset: currentOffset
                )

                // 再次检查取消状态(请求完成后)
                try Task.checkCancellation()

                if reset {
                    projects = result.projects
                } else {
                    projects.append(contentsOf: result.projects)
                }

                hasMore = result.hasMore
                currentOffset += result.projects.count
            } catch is CancellationError {
                // Task 被取消,静默处理
                print("⚠️ [ProjectListViewModel] 加载被取消")
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

    // MARK: - WebSocket 热更新

    /// 开始监听项目更新事件
    func startListening() {
        guard !isListening else {
            print("⚠️ [ProjectListViewModel] 已在监听中，跳过重复注册")
            return
        }

        isListening = true

        wsManager.on(.projectUpdated) { [weak self] message in
            guard let self = self else { return }

            print("🔔 [ProjectListViewModel] 收到项目更新事件")

            // 异步刷新项目列表（简单策略：重新加载）
            Task { @MainActor in
                // 静默刷新（不显示 loading）
                await self.refreshSilently()
            }
        }

        print("👂 [ProjectListViewModel] 开始监听项目更新")
    }

    /// 停止监听项目更新事件
    func stopListening() {
        guard isListening else {
            print("⚠️ [ProjectListViewModel] 未在监听中，跳过取消")
            return
        }

        isListening = false
        wsManager.off(.projectUpdated)
        print("🛑 [ProjectListViewModel] 停止监听项目更新")
    }

    deinit {
        // deinit 不能访问 @MainActor 方法，需要直接调用 WebSocketManager
        if isListening {
            WebSocketManager.shared.off(.projectUpdated)
            print("🛑 [ProjectListViewModel] deinit 时停止监听项目更新")
        }
        print("♻️ [ProjectListViewModel] 已销毁")
    }

    /// 静默刷新（后台更新，不显示 loading）
    private func refreshSilently() async {
        do {
            let result = try await apiClient.getProjects(
                limit: currentOffset + pageSize,  // 加载当前已显示的所有数据
                offset: 0
            )

            // 更新项目列表
            projects = result.projects
            hasMore = result.hasMore

            print("✅ [ProjectListViewModel] 静默刷新完成: \(projects.count) 个项目")
        } catch {
            print("⚠️ [ProjectListViewModel] 静默刷新失败: \(error.localizedDescription)")
            // 静默失败，不显示错误信息
        }
    }
}
