//
//  VlaudeConfig.swift
//  Vlaude
//
//  统一配置管理（硬编码）
//

import Foundation

/// Vlaude 配置
enum VlaudeConfig {
    /// 服务器地址（修改这一处即可）
    static let serverHost = "***REMOVED-domain***"
    static let serverPort = 10005

    static var serverURL: String { "\(serverHost):\(serverPort)" }
}
