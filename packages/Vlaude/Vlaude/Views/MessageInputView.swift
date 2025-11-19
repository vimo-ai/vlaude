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

    @StateObject private var speechService = SpeechRecognitionService()
    @State private var showErrorAlert = false

    var body: some View {
        HStack(spacing: 12) {
            // 输入框
            TextField("输入消息...", text: $text, axis: .vertical)
                .textFieldStyle(.plain)
                .padding(10)
                .background(Color.gray.opacity(0.1))
                .cornerRadius(20)
                .lineLimit(1...5)

            // 语音输入按钮
            Button {
                handleVoiceInput()
            } label: {
                Image(systemName: speechService.isRecording ? "mic.fill" : "mic")
                    .font(.system(size: 24))
                    .foregroundColor(speechService.isRecording ? .red : .blue)
                    .symbolEffect(.pulse, isActive: speechService.isRecording)
            }

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
        .onAppear {
            // 启动时请求权限
            if !speechService.isAuthorized {
                speechService.requestAuthorization()
            }
        }
        .onChange(of: speechService.recognizedText) { _, newValue in
            text = newValue
        }
        .onChange(of: speechService.errorMessage) { _, newValue in
            if newValue != nil {
                showErrorAlert = true
            }
        }
        .alert("语音识别错误", isPresented: $showErrorAlert) {
            Button("确定", role: .cancel) {
                speechService.errorMessage = nil
            }
        } message: {
            if let error = speechService.errorMessage {
                Text(error)
            }
        }
    }

    private func handleVoiceInput() {
        if speechService.isRecording {
            speechService.stopRecording()
        } else {
            speechService.startRecording()
        }
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
