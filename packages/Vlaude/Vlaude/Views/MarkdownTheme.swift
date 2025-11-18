//
//  MarkdownTheme.swift
//  Vlaude
//
//  Created by Claude on 2025/11/16.
//

import SwiftUI
import MarkdownUI

extension Theme {
    /// Claude Code 风格的 Markdown 主题
    static let claudeCode = Theme()
        // 文本样式
        .text {
            ForegroundColor(.primary)
            FontSize(14)
        }
        // 段落间距
        .paragraph { configuration in
            configuration.label
                .fixedSize(horizontal: false, vertical: true)
                .padding(.bottom, 8)
        }
        // 标题样式
        .heading1 { configuration in
            configuration.label
                .font(.title.bold())
                .foregroundColor(.primary)
                .padding(.bottom, 4)
        }
        .heading2 { configuration in
            configuration.label
                .font(.title2.bold())
                .foregroundColor(.primary)
                .padding(.bottom, 4)
        }
        .heading3 { configuration in
            configuration.label
                .font(.title3.bold())
                .foregroundColor(.primary)
                .padding(.bottom, 4)
        }
        // 行内代码
        .code {
            FontFamilyVariant(.monospaced)
            FontSize(14)
            ForegroundColor(.purple)
            BackgroundColor(Color.purple.opacity(0.1))
        }
        .codeBlock { configuration in
            VStack(alignment: .leading, spacing: 0) {
                // 语言标签
                if let language = configuration.language, !language.isEmpty {
                    HStack {
                        Text(language.uppercased())
                            .font(.caption)
                            .fontWeight(.medium)
                            .foregroundColor(.white)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 4)
                            .background(Color.blue)
                            .cornerRadius(4)

                        Spacer()
                    }
                    .padding(.horizontal, 12)
                    .padding(.top, 8)
                    .padding(.bottom, 4)
                    .background(Color(uiColor: .systemGray6))
                }

                // 代码内容
                ScrollView(.horizontal, showsIndicators: true) {
                    configuration.label
                        .relativeLineSpacing(.em(0.2))
                        .markdownTextStyle {
                            FontFamilyVariant(.monospaced)
                            FontSize(14)
                        }
                        .padding(12)
                }
                .background(Color(uiColor: .systemGray6))
            }
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .overlay(
                RoundedRectangle(cornerRadius: 8)
                    .stroke(Color.gray.opacity(0.3), lineWidth: 1)
            )
        }
        // 引用块
        .blockquote { configuration in
            HStack(alignment: .top, spacing: 8) {
                RoundedRectangle(cornerRadius: 2)
                    .fill(Color.blue)
                    .frame(width: 4)

                configuration.label
                    .markdownTextStyle {
                        ForegroundColor(.secondary)
                    }
            }
            .padding(.vertical, 8)
        }
        // 列表
        .listItem { configuration in
            configuration.label
                .markdownMargin(top: 4, bottom: 4)
        }
        // 链接
        .link {
            ForegroundColor(.blue)
            UnderlineStyle(.single)
        }
        // 强调
        .strong {
            FontWeight(.bold)
        }
        .emphasis {
            FontStyle(.italic)
        }
        // 分割线
        .thematicBreak {
            Divider()
                .padding(.vertical, 8)
        }
        // 表格
        .table { configuration in
            configuration.label
                .fixedSize(horizontal: false, vertical: true)
                .markdownTableBorderStyle(.init(color: .gray))
                .markdownTableBackgroundStyle(
                    .alternatingRows(Color(uiColor: .systemGray6), Color.clear)
                )
                .padding(.vertical, 8)
        }
}
