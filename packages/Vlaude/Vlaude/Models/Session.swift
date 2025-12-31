//
//  Session.swift
//  Vlaude
//
//  Created by Claude on 2025/11/16.
//

import Foundation

/// 会话模型
/// @see vlaude-server/docs/DATA_STRUCTURE_SYNC.md#3-session-模型-ineterm-字段
/// @see vlaude-server/src/module/session/session.controller.ts - NestJS 端 serializeSession
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

    // ETerm 状态：该 session 是否在 ETerm 中可用
    // @see vlaude-server/docs/DATA_STRUCTURE_SYNC.md#3-session-模型-ineterm-字段
    var inEterm: Bool?
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
