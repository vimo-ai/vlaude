//
//  Session.swift
//  Vlaude
//
//  Created by Claude on 2025/11/16.
//

import Foundation

struct Session: Identifiable, Codable {
    let id: Int
    let sessionId: String
    let projectId: Int
    let messageCount: Int
    let lastMessageAt: Date?
    let createdAt: Date
    let updatedAt: Date

    var project: Project?

    // 会话列表 API 返回最后一条消息作为预览(从 Daemon 实时获取)
    var lastMessage: Message?
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

struct SessionListResponse: Codable {
    let success: Bool
    let data: [Session]
    let total: Int
    let hasMore: Bool
}

struct SessionDetailResponse: Codable {
    let success: Bool
    let data: Session?
    let message: String?
}
