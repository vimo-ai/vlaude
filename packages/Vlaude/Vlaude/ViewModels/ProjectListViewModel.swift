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

    private let client = VlaudeClient.shared
    private let wsClient = VlaudeWebSocketClient.shared
    private var loadTask: Task<Void, Never>?
    private var currentOffset = 0
    private let pageSize = 10
    private var isListening = false  // 监听状态标记
    private var projectUpdatedToken: VlaudeWebSocketClient.VlaudeEventToken?  // 保存 token 用于精确移除

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

                let result = try await client.getProjects(
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
            } catch {
                errorMessage = error.localizedDescription
            }
        }

        await loadTask?.value
    }

    // MARK: - WebSocket 热更新

    /// 开始监听项目更新事件
    func startListening() {
        guard !isListening else {
            print("⚠️ [ProjectListViewModel] 已在监听中，跳过重复注册")
            return
        }

        isListening = true

        // 保存 token 用于精确移除
        projectUpdatedToken = wsClient.on(.projectUpdated) { [weak self] message in
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
        // 使用 token 精确移除，不影响其他模块
        if let token = projectUpdatedToken {
            wsClient.off(token: token)
            projectUpdatedToken = nil
        }
        print("🛑 [ProjectListViewModel] 停止监听项目更新")
    }

    deinit {
        // deinit 是 nonisolated，使用专门的 nonisolated 方法
        if let token = projectUpdatedToken {
            VlaudeWebSocketClient.shared.offFromDeinit(token: token)
            print("🛑 [ProjectListViewModel] deinit 时停止监听项目更新")
        }
        print("♻️ [ProjectListViewModel] 已销毁")
    }

    /// 静默刷新（后台更新，不显示 loading）
    private func refreshSilently() async {
        do {
            let result = try await client.getProjects(
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
