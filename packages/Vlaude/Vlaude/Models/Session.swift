//
//  Session.swift
//  Vlaude
//
//  Created by Claude on 2025/11/16.
//

import Foundation

/// 会话模型 (V4: 适配 Daemon 透传格式)
/// Daemon 返回的是文件系统数据，不是数据库记录
struct Session: Identifiable, Codable, Hashable {
    // V4 新字段（Daemon 透传）
    /// Daemon 返回的 id 其实就是 sessionId（用 rawId 避免与计算属性 id 冲突）
    let rawId: String?
    let sessionId: String?
    let projectPath: String?
    let projectName: String?
    let path: String?  // session 文件路径
    let encodedDirName: String?
    let lastModified: Int64?

    // 兼容旧字段（可选）
    let projectId: Int?
    let messageCount: Int?
    let lastMessageAt: Date?
    let createdAt: Date?
    let updatedAt: Date?
    var project: Project?
    var lastMessage: Message?
    var inEterm: Bool?

    // V4: 使用 sessionId 或 rawId 作为唯一标识
    var id: String {
        sessionId ?? rawId ?? path ?? UUID().uuidString
    }

    enum CodingKeys: String, CodingKey {
        case rawId = "id"
        case sessionId, projectPath, projectName, path, encodedDirName, lastModified
        case projectId, messageCount, lastMessageAt, createdAt, updatedAt
        case project, lastMessage, inEterm
    }

    // Hashable
    func hash(into hasher: inout Hasher) {
        hasher.combine(id)
    }

    static func == (lhs: Session, rhs: Session) -> Bool {
        lhs.id == rhs.id
    }

    /// 返回带有新 inEterm 状态的副本
    func withInEterm(_ value: Bool) -> Session {
        var copy = self
        copy.inEterm = value
        return copy
    }
}

// 会话列表中的简化消息结构(数据库格式)
struct SessionMessage: Identifiable, Codable {
    let id: Int
    let sessionId: Int
    let role: String
    let content: String
    let sequence: Int
    let timestamp: Date
}

/// 会话列表 API 响应
/// @see vlaude-server/docs/DATA_STRUCTURE_SYNC.md#2-sessionlistresponse
/// @see vlaude-server/src/module/session/session.controller.ts - NestJS 端返回格式
struct SessionListResponse: Codable {
    let success: Bool
    let status: String?  // V4: "ok" | "offline" | "error"
    let message: String?
    let data: [Session]
    let total: Int
    let hasMore: Bool
    // ETerm 在线状态（解决时序问题）
    let etermOnline: Bool?
}

struct SessionDetailResponse: Codable {
    let success: Bool
    let data: Session?
    let message: String?
}
