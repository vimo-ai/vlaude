//
//  SyntaxHighlighter.swift
//  Vlaude
//
//  Created by Claude on 2025/11/16.
//

import Foundation
import SwiftUI
import HighlightSwift

/// 代码语法高亮管理器（使用 HighlightSwift）
@MainActor
class SyntaxHighlighter {
    static let shared = SyntaxHighlighter()

    private let highlight: Highlight
    private var cache: [String: AttributedString] = [:]

    private init() {
        // 初始化 HighlightSwift
        self.highlight = Highlight()
    }

    /// 高亮代码（异步）
    /// - Parameters:
    ///   - code: 代码内容
    ///   - language: 语言（如 "swift", "javascript", "python" 等）
    /// - Returns: 高亮后的 AttributedString
    func highlight(_ code: String, language: String?) async -> AttributedString {
        // 生成缓存键
        let cacheKey = "\(language ?? "auto"):\(code.hashValue)"

        // 检查缓存
        if let cached = cache[cacheKey] {
            return cached
        }

        // 执行高亮
        let highlighted: AttributedString
        do {
            if let language = language {
                // 指定语言高亮
                highlighted = try await highlight.attributedText(code, language: language)
            } else {
                // 自动检测语言
                highlighted = try await highlight.attributedText(code)
            }
        } catch {
            // 高亮失败，返回普通文本
            print("⚠️ [SyntaxHighlighter] 高亮失败: \(error)")
            return AttributedString(code)
        }

        // 存入缓存（限制缓存大小）
        if cache.count > 100 {
            cache.removeAll()
        }
        cache[cacheKey] = highlighted

        return highlighted
    }

    /// 同步高亮代码（用于非异步上下文，返回普通文本）
    /// - Parameters:
    ///   - code: 代码内容
    ///   - language: 语言
    /// - Returns: 普通 AttributedString
    func highlightSync(_ code: String, language: String?) -> AttributedString {
        // 检查缓存
        let cacheKey = "\(language ?? "auto"):\(code.hashValue)"
        if let cached = cache[cacheKey] {
            return cached
        }
        // 返回普通文本，稍后会异步更新
        return AttributedString(code)
    }

    /// 获取所有支持的语言
    func supportedLanguages() -> [String] {
        // HighlightSwift 支持 50+ 语言
        return [
            "swift", "javascript", "typescript", "python", "java",
            "kotlin", "go", "rust", "c", "cpp", "csharp",
            "php", "ruby", "bash", "shell", "json", "xml",
            "html", "css", "scss", "sql", "yaml", "markdown"
        ]
    }
}
