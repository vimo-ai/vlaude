//
//  MarkdownEventView.swift
//  Vlaude
//
//  Equatable 包裹 Markdown 渲染：内容不变时跳过重新渲染
//  解决 SwiftUI 布局递归导致的主线程卡死
//

import SwiftUI
import MarkdownUI

/// Equatable Markdown 视图：id + text 不变则不重新渲染
struct MarkdownEventView: View, Equatable {
    let id: String
    let text: String

    var body: some View {
        Markdown(text)
            .markdownTheme(.claudeCode)
            .markdownCodeSyntaxHighlighter(HighlightrCodeSyntaxHighlighter())
            .textSelection(.enabled)
    }

    static func == (lhs: MarkdownEventView, rhs: MarkdownEventView) -> Bool {
        lhs.id == rhs.id && lhs.text == rhs.text
    }
}
