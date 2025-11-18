//
//  MessageInputView.swift
//  Vlaude
//
//  Created by Claude on 2025/11/16.
//

import SwiftUI

struct MessageInputView: View {
    @Binding var text: String
    let onSend: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            // 输入框
            TextField("输入消息...", text: $text, axis: .vertical)
                .textFieldStyle(.plain)
                .padding(10)
                .background(Color.gray.opacity(0.1))
                .cornerRadius(20)
                .lineLimit(1...5)

            // 发送按钮
            Button(action: onSend) {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.system(size: 32))
                    .foregroundColor(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? .gray : .blue)
            }
            .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(Color(uiColor: .systemBackground))
    }
}

#Preview {
    VStack {
        Spacer()
        MessageInputView(text: .constant("测试消息")) {
            print("发送消息")
        }
    }
}
