//
//  WebSearchToolView.swift
//  Vlaude
//
//  WebSearch 工具专用视图 - 搜索结果卡片
//

import SwiftUI

/// WebSearch 工具视图 - 网页搜索
struct WebSearchToolView: View {
    let execution: ToolExecution
    @State private var isExpanded = false

    // 搜索查询
    private var query: String {
        execution.input["query"] ?? ""
    }

    // 域名过滤
    private var allowedDomains: [String] {
        guard let domainsJson = execution.input["allowed_domains"] else { return [] }
        guard let data = domainsJson.data(using: .utf8),
              let array = try? JSONSerialization.jsonObject(with: data) as? [String] else {
            return []
        }
        return array
    }

    private var blockedDomains: [String] {
        guard let domainsJson = execution.input["blocked_domains"] else { return [] }
        guard let data = domainsJson.data(using: .utf8),
              let array = try? JSONSerialization.jsonObject(with: data) as? [String] else {
            return []
        }
        return array
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
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 12))
                    .foregroundColor(.teal)

                Text("WebSearch")
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
                        Text("搜索中")
                            .font(.system(size: 11))
                            .foregroundColor(.secondary)
                    }
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(Color.teal.opacity(0.1))

            // 搜索查询
            HStack(spacing: 6) {
                Image(systemName: "text.magnifyingglass")
                    .font(.system(size: 10))
                    .foregroundColor(.secondary)

                Text(query)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(.primary)
                    .lineLimit(2)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.gray.opacity(0.05))

            // 域名过滤
            if !allowedDomains.isEmpty || !blockedDomains.isEmpty {
                HStack(spacing: 8) {
                    if !allowedDomains.isEmpty {
                        HStack(spacing: 4) {
                            Image(systemName: "checkmark.shield")
                                .font(.system(size: 10))
                                .foregroundColor(.green)
                            Text(allowedDomains.joined(separator: ", "))
                                .font(.system(size: 10))
                                .foregroundColor(.secondary)
                                .lineLimit(1)
                        }
                    }

                    if !blockedDomains.isEmpty {
                        HStack(spacing: 4) {
                            Image(systemName: "xmark.shield")
                                .font(.system(size: 10))
                                .foregroundColor(.red)
                            Text(blockedDomains.joined(separator: ", "))
                                .font(.system(size: 10))
                                .foregroundColor(.secondary)
                                .lineLimit(1)
                        }
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
            }

            // 搜索结果
            if !resultContent.isEmpty {
                Divider()

                VStack(alignment: .leading, spacing: 8) {
                    Text(isError ? "错误" : "搜索结果")
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
                            .foregroundColor(.teal)
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
                .stroke(isError ? Color.red.opacity(0.3) : Color.teal.opacity(0.2), lineWidth: 1)
        )
    }
}
