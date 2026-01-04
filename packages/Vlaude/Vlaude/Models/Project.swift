//
//  Project.swift
//  Vlaude
//
//  Created by Claude on 2025/11/16.
//

import Foundation

struct Project: Identifiable, Codable {
    let id: Int
    let name: String
    let path: String
    let source: String?
    let encodedDirName: String?
    let lastAccessed: Date?
    let createdAt: Date
    let updatedAt: Date

    var sessions: [Session]?
}

/// 项目列表 API 响应
/// @see vlaude-server/docs/DATA_STRUCTURE_SYNC.md#1-projectlistresponse
/// @see vlaude-server/src/module/project/project.controller.ts - NestJS 端返回格式
struct ProjectListResponse: Codable {
    let success: Bool
    let data: [Project]
    let total: Int
    let hasMore: Bool
    // ETerm 在线状态（解决时序问题）
    let etermOnline: Bool?
    let etermSessions: [String]?
}
