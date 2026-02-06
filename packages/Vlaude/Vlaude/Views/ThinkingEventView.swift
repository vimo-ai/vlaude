//
//  ThinkingEventView.swift
//  Vlaude
//
//  Thinking 折叠视图：显示思考内容的字数 + 可展开查看
//

import SwiftUI

struct ThinkingEventView: View {
    let text: String
    @State private var isExpanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button(action: { isExpanded.toggle() }) {
                HStack(spacing: 6) {
                    Image(systemName: "brain")
                        .font(.system(size: 12))
                        .foregroundColor(.purple)

                    Text("思考中")
                        .font(.caption)
                        .foregroundColor(.purple)

                    Text("(\(text.count) 字)")
                        .font(.caption2)
                        .foregroundColor(.secondary)

                    Spacer()

                    Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                        .font(.caption2)
                        .foregroundColor(.secondary)
                }
            }
            .buttonStyle(.plain)

            if isExpanded {
                Text(text)
                    .font(.system(size: 13))
                    .foregroundColor(.secondary)
                    .textSelection(.enabled)
                    .padding(8)
                    .background(Color.purple.opacity(0.05))
                    .cornerRadius(6)
            }
        }
        .padding(8)
        .background(
            RoundedRectangle(cornerRadius: 8)
                .fill(Color.purple.opacity(0.03))
        )
    }
}
