//
//  Project.swift
//  Vlaude
//
//  Created by Claude on 2025/11/16.
//

import Foundation

struct Project: Identifiable, Codable, Hashable {
    let name: String
    let projectPath: String
    let sessionCount: Int?
    let messageCount: Int?
    let lastActive: Int64?

    // V4: 使用 projectPath 作为唯一标识
    var id: String { projectPath }

    // Hashable: 只用 projectPath
    func hash(into hasher: inout Hasher) {
        hasher.combine(projectPath)
    }

    static func == (lhs: Project, rhs: Project) -> Bool {
        lhs.projectPath == rhs.projectPath
    }
}

/// 项目列表 API 响应
/// @see vlaude-server/docs/DATA_STRUCTURE_SYNC.md#1-projectlistresponse
/// @see vlaude-server/src/module/project/project.controller.ts - NestJS 端返回格式
struct ProjectListResponse: Codable {
    let success: Bool
    let status: String?  // V4: "ok" | "offline" | "error"
    let message: String?
    let data: [Project]
    let total: Int
    let hasMore: Bool
    // ETerm 在线状态（解决时序问题）
    let etermOnline: Bool?
    let etermSessions: [String]?
}
