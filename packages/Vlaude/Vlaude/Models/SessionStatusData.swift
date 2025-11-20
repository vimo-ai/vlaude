//
//  SessionStatusData.swift
//  Vlaude
//
//  Created by Claude on 2025/11/20.
//

import Foundation

/// Session 状态栏数据模型
struct SessionStatusData: Codable {
    /// WebSocket 连接状态
    let connected: Bool

    /// 连接模式（本地/远程）
    let mode: ConnectionMode?

    /// 当前 Context Length（input tokens + cache tokens）
    let contextLength: Int?

    /// Context 使用百分比（0-100）
    let contextPercentage: Double?

    /// 累计 Input Tokens
    let inputTokens: Int?

    /// 累计 Output Tokens
    let outputTokens: Int?

    /// 最后更新时间
    let timestamp: Date

    enum CodingKeys: String, CodingKey {
        case connected, mode, contextLength, contextPercentage
        case inputTokens, outputTokens, timestamp
    }

    /// 默认空状态
    static let empty = SessionStatusData(
        connected: false,
        mode: nil,
        contextLength: nil,
        contextPercentage: nil,
        inputTokens: nil,
        outputTokens: nil,
        timestamp: Date()
    )
}

/// 连接模式
enum ConnectionMode: String, Codable {
    case local = "local"
    case remote = "remote"
}

/// 格式化 Token 数量（5500 -> "5.5k"）
extension Int {
    func formatAsTokenCount() -> String {
        let count = Double(self)
        if count >= 1_000_000 {
            return String(format: "%.1fM", count / 1_000_000)
        } else if count >= 1_000 {
            return String(format: "%.1fk", count / 1_000)
        } else {
            return "\(self)"
        }
    }
}
