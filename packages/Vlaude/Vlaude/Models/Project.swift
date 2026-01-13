//
//  Project.swift
//  Vlaude
//
//  Created by Claude on 2025/11/16.
//

import Foundation

struct Project: Identifiable, Codable, Hashable {
    let name: String
    let path: String
    let encodedName: String?
    let sessionCount: Int?
    let lastModified: Int64?

    // 兼容旧字段（可选）
    let source: String?
    let encodedDirName: String?
    let lastAccessed: Date?
    let createdAt: Date?
    let updatedAt: Date?
    var sessions: [Session]?

    // V4: 使用 path 作为唯一标识（Daemon 透传模式没有数据库 id）
    var id: String { path }

    // Hashable: 只用 path
    func hash(into hasher: inout Hasher) {
        hasher.combine(path)
    }

    static func == (lhs: Project, rhs: Project) -> Bool {
        lhs.path == rhs.path
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
