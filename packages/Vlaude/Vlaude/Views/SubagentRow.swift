//
//  SubagentRow.swift
//  Vlaude
//
//  Subagent 折叠行：显示子代理摘要，点击展开子时间线
//

import SwiftUI

struct SubagentRow: View {
    @ObservedObject var subagent: SubagentTurn
    let sessionId: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            // 折叠头
            Button(action: { subagent.isExpanded.toggle() }) {
                HStack(spacing: 6) {
                    Image(systemName: "cpu")
                        .font(.system(size: 12))
                        .foregroundColor(.indigo)

                    Text("子代理")
                        .font(.caption)
                        .fontWeight(.medium)
                        .foregroundColor(.indigo)

                    if let model = subagent.agentModel {
                        Text(model)
                            .font(.caption2)
                            .padding(.horizontal, 4)
                            .padding(.vertical, 1)
                            .background(Color.indigo.opacity(0.1))
                            .cornerRadius(4)
                    }

                    Text("\(subagent.events.count) 事件")
                        .font(.caption2)
                        .foregroundColor(.secondary)

                    Spacer()

                    if let summary = subagent.summary {
                        Text(summary)
                            .font(.caption)
                            .foregroundColor(.secondary)
                            .lineLimit(1)
                            .frame(maxWidth: 150, alignment: .trailing)
                    }

                    Image(systemName: subagent.isExpanded ? "chevron.up" : "chevron.down")
                        .font(.caption2)
                        .foregroundColor(.secondary)
                }
            }
            .buttonStyle(.plain)

            // 展开的子时间线
            if subagent.isExpanded {
                VStack(spacing: 4) {
                    ForEach(subagent.events) { event in
                        switch event.content {
                        case .toolUse(let execution):
                            CompactToolRow(
                                execution: execution,
                                sessionId: sessionId
                            )
                        case .thinking(let text):
                            ThinkingEventView(text: text)
                        case .text(let text, _):
                            if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                                Text(text)
                                    .font(.system(size: 13))
                                    .foregroundColor(.secondary)
                                    .padding(.vertical, 2)
                                    .padding(.horizontal, 8)
                            }
                        case .toolResult:
                            EmptyView()
                        }
                    }
                }
                .padding(.leading, 16)
                .padding(.top, 4)
            }
        }
        .padding(8)
        .background(
            RoundedRectangle(cornerRadius: 8)
                .fill(Color.indigo.opacity(0.03))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(Color.indigo.opacity(0.1), lineWidth: 1)
        )
    }
}
