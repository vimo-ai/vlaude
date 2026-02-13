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

    // V5: lastMessage 预览字段
    /// 最后一条消息类型 ("user" / "assistant")
    let lastMessageType: String?
    /// 最后一条消息预览（纯文本，100 字符）
    let lastMessagePreview: String?
    /// 最后一条消息时间戳（毫秒）
    let lastMessageTimestamp: Int64?

    // 兼容旧字段（可选）
    let projectId: Int?
    let messageCount: Int?
    let lastMessageAt: Date?
    let createdAt: Date?
    let updatedAt: Date?
    var project: Project?
    var lastMessage: Message?
    var inEterm: Bool?

    // V6: Session Chain 关系
    let sessionType: String?       // "main" / "subagent"
    let childrenCount: Int?        // 子会话数量
    let parentSessionId: String?   // 父会话 ID（subagent 时有值）
    let childSessionIds: [String]? // 子会话 ID 列表

    // V4: 使用 sessionId 或 rawId 作为唯一标识
    var id: String {
        sessionId ?? rawId ?? path ?? UUID().uuidString
    }

    enum CodingKeys: String, CodingKey {
        case rawId = "id"
        case sessionId, projectPath, projectName, path, encodedDirName, lastModified
        case lastMessageType, lastMessagePreview, lastMessageTimestamp
        case projectId, messageCount, lastMessageAt, createdAt, updatedAt
        case project, lastMessage, inEterm
        case sessionType, childrenCount, parentSessionId, childSessionIds
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

    /// 返回带有新预览信息的副本
    func withPreview(type: String, preview: String, timestamp: Int64?) -> Session {
        Session(
            rawId: self.rawId,
            sessionId: self.sessionId,
            projectPath: self.projectPath,
            projectName: self.projectName,
            path: self.path,
            encodedDirName: self.encodedDirName,
            lastModified: timestamp ?? self.lastModified,
            lastMessageType: type,
            lastMessagePreview: preview,
            lastMessageTimestamp: timestamp ?? self.lastMessageTimestamp,
            projectId: self.projectId,
            messageCount: self.messageCount,
            lastMessageAt: self.lastMessageAt,
            createdAt: self.createdAt,
            updatedAt: self.updatedAt,
            project: self.project,
            lastMessage: self.lastMessage,
            inEterm: self.inEterm,
            sessionType: self.sessionType,
            childrenCount: self.childrenCount,
            parentSessionId: self.parentSessionId,
            childSessionIds: self.childSessionIds
        )
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
