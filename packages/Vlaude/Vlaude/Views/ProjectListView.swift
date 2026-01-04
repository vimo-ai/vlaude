//
//  ProjectListView.swift
//  Vlaude
//
//  Created by Claude on 2025/11/16.
//

import SwiftUI

struct ProjectListView: View {
    @StateObject private var viewModel = ProjectListViewModel()
    @ObservedObject private var webSocketManager = WebSocketManager.shared

    var body: some View {
        NavigationStack {
            ZStack {
                // 错误状态
                if let error = viewModel.errorMessage {
                    VStack(spacing: 16) {
                        Image(systemName: "exclamationmark.triangle")
                            .font(.system(size: 48))
                            .foregroundColor(.orange)
                        Text(error)
                            .foregroundColor(.secondary)
                        Button("重试") {
                            Task {
                                await viewModel.loadProjects(reset: true)
                            }
                        }
                        .buttonStyle(.bordered)
                    }
                }
                // 空状态
                else if viewModel.projects.isEmpty && !viewModel.isLoading {
                    VStack(spacing: 16) {
                        Image(systemName: "folder")
                            .font(.system(size: 48))
                            .foregroundColor(.gray)
                        Text("暂无项目")
                            .foregroundColor(.secondary)
                    }
                }
                // 列表 - 始终保持稳定
                else {
                    List {
                        ForEach(viewModel.projects) { project in
                            NavigationLink {
                                SessionListView(projectPath: project.path, projectName: project.name)
                            } label: {
                                ProjectRow(
                                    project: project,
                                    etermSessionCount: webSocketManager.etermSessionCounts[project.path] ?? 0
                                )
                            }
                        }

                        // 加载更多按钮
                        if viewModel.hasMore {
                            HStack {
                                Spacer()
                                Button {
                                    Task {
                                        await viewModel.loadProjects(reset: false)
                                    }
                                } label: {
                                    if viewModel.isLoadingMore {
                                        ProgressView()
                                            .progressViewStyle(.circular)
                                    } else {
                                        Text("加载更多")
                                            .foregroundColor(.blue)
                                    }
                                }
                                .disabled(viewModel.isLoadingMore)
                                Spacer()
                            }
                            .padding(.vertical, 8)
                        }
                    }
                    .refreshable {
                        await viewModel.loadProjects(reset: true)
                    }
                }

                // 首次加载的 loading 覆盖层
                if viewModel.isLoading && viewModel.projects.isEmpty {
                    Color.black.opacity(0.1)
                        .ignoresSafeArea()
                    ProgressView("加载中...")
                }
            }
            .navigationTitle("项目列表")
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    EtermStatusIndicator(isOnline: webSocketManager.isEtermOnline)
                }
            }
            .task {
                await viewModel.loadProjects(reset: true)
            }
            .onAppear {
                // 进入页面时开始监听项目更新
                viewModel.startListening()
            }
            .onDisappear {
                // 离开页面时停止监听项目更新
                viewModel.stopListening()
            }
        }
    }
}

// MARK: - ETerm 状态指示器
struct EtermStatusIndicator: View {
    let isOnline: Bool

    var body: some View {
        HStack(spacing: 4) {
            Circle()
                .fill(isOnline ? Color.green : Color.gray)
                .frame(width: 8, height: 8)
            Text("ETerm")
                .font(.caption)
                .foregroundColor(isOnline ? .primary : .secondary)
        }
    }
}

struct ProjectRow: View {
    let project: Project
    let etermSessionCount: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(project.name)
                    .font(.headline)

                Spacer()

                // ETerm 会话计数 badge
                if etermSessionCount > 0 {
                    HStack(spacing: 4) {
                        Image(systemName: "terminal")
                            .font(.caption2)
                        Text("\(etermSessionCount)")
                            .font(.caption2)
                            .fontWeight(.medium)
                    }
                    .foregroundColor(.green)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(
                        Capsule()
                            .fill(Color.green.opacity(0.15))
                    )
                }
            }

            Text(project.path)
                .font(.caption)
                .foregroundColor(.secondary)
                .lineLimit(1)

            if let lastAccessed = project.lastAccessed {
                Text("最后访问: \(lastAccessed, style: .relative)")
                    .font(.caption2)
                    .foregroundColor(.secondary)
            }
        }
        .padding(.vertical, 4)
    }
}

#Preview {
    ProjectListView()
}
