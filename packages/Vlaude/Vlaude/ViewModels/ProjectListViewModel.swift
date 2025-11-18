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
    private var loadTask: Task<Void, Never>?
    private var currentOffset = 0
    private let pageSize = 10

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
}
