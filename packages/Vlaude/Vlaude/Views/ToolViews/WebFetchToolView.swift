//
//  WebFetchToolView.swift
//  Vlaude
//
//  WebFetch 工具专用视图 - 网页内容获取
//

import SwiftUI

/// WebFetch 工具视图 - 网页获取
struct WebFetchToolView: View {
    let execution: ToolExecution
    @State private var isExpanded = false

    // URL
    private var url: String {
        execution.input["url"] ?? ""
    }

    // 提示词
    private var prompt: String {
        execution.input["prompt"] ?? ""
    }

    // 从 URL 提取域名
    private var domain: String {
        guard let urlObj = URL(string: url) else { return url }
        return urlObj.host ?? url
    }

    // 执行结果
    private var resultContent: String {
        execution.result?.content ?? ""
    }

    private var isError: Bool {
        execution.result?.isError ?? false
    }

    private var isSuccess: Bool {
        execution.result != nil && !isError
    }

    // 结果过长
    private var isResultLong: Bool {
        resultContent.count > 600
    }

    private var displayResult: String {
        if isExpanded || !isResultLong {
            return resultContent
        }
        return String(resultContent.prefix(600))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // 头部
            HStack(spacing: 8) {
                Image(systemName: "globe")
                    .font(.system(size: 12))
                    .foregroundColor(.mint)

                Text("WebFetch")
                    .font(.system(size: 13, design: .monospaced))
                    .fontWeight(.medium)

                Spacer()

                // 状态
                if isSuccess {
                    HStack(spacing: 4) {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundColor(.green)
                        Text("完成")
                            .font(.system(size: 11))
                            .foregroundColor(.green)
                    }
                } else if isError {
                    HStack(spacing: 4) {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundColor(.red)
                        Text("失败")
                            .font(.system(size: 11))
                            .foregroundColor(.red)
                    }
                } else {
                    HStack(spacing: 4) {
                        ProgressView()
                            .scaleEffect(0.6)
                        Text("获取中")
                            .font(.system(size: 11))
                            .foregroundColor(.secondary)
                    }
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(Color.mint.opacity(0.1))

            // URL
            HStack(spacing: 6) {
                Image(systemName: "link")
                    .font(.system(size: 10))
                    .foregroundColor(.secondary)

                Text(domain)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundColor(.mint)
                    .lineLimit(1)

                Spacer()

                // 完整 URL 提示
                if url != domain {
                    Image(systemName: "ellipsis")
                        .font(.system(size: 10))
                        .foregroundColor(.secondary)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.gray.opacity(0.05))

            // 提示词
            if !prompt.isEmpty {
                HStack(alignment: .top, spacing: 6) {
                    Image(systemName: "text.bubble")
                        .font(.system(size: 10))
                        .foregroundColor(.secondary)

                    Text(prompt)
                        .font(.system(size: 11))
                        .foregroundColor(.secondary)
                        .lineLimit(2)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
            }

            // 获取结果
            if !resultContent.isEmpty {
                Divider()

                VStack(alignment: .leading, spacing: 8) {
                    Text(isError ? "错误" : "内容摘要")
                        .font(.system(size: 11))
                        .foregroundColor(.secondary)

                    Text(displayResult)
                        .font(.system(size: 12))
                        .foregroundColor(isError ? .red : .primary)
                        .textSelection(.enabled)

                    if isResultLong {
                        Button(action: { isExpanded.toggle() }) {
                            HStack(spacing: 4) {
                                Text(isExpanded ? "收起" : "展开全部")
                                Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                            }
                            .font(.caption)
                            .foregroundColor(.mint)
                        }
                    }
                }
                .padding(12)
            }
        }
        .background(Color.gray.opacity(0.05))
        .cornerRadius(8)
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(isError ? Color.red.opacity(0.3) : Color.mint.opacity(0.2), lineWidth: 1)
        )
    }
}
