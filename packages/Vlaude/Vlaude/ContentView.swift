//
//  ContentView.swift
//  Vlaude
//
//  Created by 💻higuaifan on 2025/11/16.
//

import SwiftUI

struct ContentView: View {
    @ObservedObject private var webSocket = WebSocketManager.shared
    @State private var isReconnecting = false
    @State private var hasConnectedOnce = false  // 是否曾经连接成功过

    var body: some View {
        ZStack {
            ProjectListView()

            // 首次连接中 - 显示 loading（仅当未失败时）
            if !webSocket.isConnected && !hasConnectedOnce && !webSocket.connectionFailed {
                InitialConnectingView()
            }

            // 断连覆盖层 - 曾经连接成功后断开 或 首次连接失败
            if !webSocket.isConnected && (hasConnectedOnce || webSocket.connectionFailed) {
                DisconnectedOverlayView(
                    isReconnecting: $isReconnecting,
                    onReconnect: reconnect
                )
            }
        }
        .onChange(of: webSocket.isConnected) { _, isConnected in
            if isConnected {
                hasConnectedOnce = true
            }
        }
    }

    private func reconnect() {
        isReconnecting = true
        webSocket.reconnectWithNewToken()

        // 3 秒后重置状态（无论成功失败）
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
            isReconnecting = false
        }
    }
}

// MARK: - 首次连接中
struct InitialConnectingView: View {
    var body: some View {
        ZStack {
            Color.black.opacity(0.85)
                .ignoresSafeArea()

            VStack(spacing: 20) {
                ProgressView()
                    .progressViewStyle(CircularProgressViewStyle(tint: .white))
                    .scaleEffect(1.5)

                Text("正在连接服务器...")
                    .font(.headline)
                    .foregroundColor(.white)
            }
        }
    }
}

// MARK: - 断连覆盖层
struct DisconnectedOverlayView: View {
    @Binding var isReconnecting: Bool
    let onReconnect: () -> Void

    var body: some View {
        ZStack {
            // 半透明背景
            Color.black.opacity(0.85)
                .ignoresSafeArea()

            VStack(spacing: 24) {
                // 图标
                Image(systemName: "wifi.slash")
                    .font(.system(size: 60))
                    .foregroundColor(.red)

                // 标题
                Text("连接已断开")
                    .font(.title)
                    .fontWeight(.bold)
                    .foregroundColor(.white)

                // 说明
                Text("与服务器的连接已中断\n请检查网络后重新连接")
                    .font(.body)
                    .foregroundColor(.gray)
                    .multilineTextAlignment(.center)

                // 重连按钮
                Button(action: onReconnect) {
                    HStack {
                        if isReconnecting {
                            ProgressView()
                                .progressViewStyle(CircularProgressViewStyle(tint: .white))
                                .scaleEffect(0.8)
                        } else {
                            Image(systemName: "arrow.clockwise")
                        }
                        Text(isReconnecting ? "连接中..." : "重新连接")
                    }
                    .font(.headline)
                    .foregroundColor(.white)
                    .frame(width: 160, height: 50)
                    .background(isReconnecting ? Color.gray : Color.blue)
                    .cornerRadius(25)
                }
                .disabled(isReconnecting)
            }
        }
    }
}

#Preview {
    ContentView()
}
