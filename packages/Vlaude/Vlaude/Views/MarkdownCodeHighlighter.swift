//
//  MarkdownCodeHighlighter.swift
//  Vlaude
//
//  Created by Claude on 2025/11/16.
//

import SwiftUI
import MarkdownUI

/// 自定义 Markdown 代码语法高亮器（使用 HighlightSwift）
struct HighlightrCodeSyntaxHighlighter: CodeSyntaxHighlighter {
    private let highlighter = SyntaxHighlighter.shared

    func highlightCode(_ code: String, language: String?) -> Text {
        // 由于 HighlightSwift 是异步的，这里先返回普通文本
        // 实际高亮会在视图层面通过异步加载实现
        let attributedString = highlighter.highlightSync(code, language: language)
        return Text(attributedString)
    }
}
