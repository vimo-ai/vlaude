//
//  VlaudeApp.swift
//  Vlaude
//
//  Created by 💻higuaifan on 2025/11/16.
//

import SwiftUI
import SwiftData

@main
struct VlaudeApp: App {
    var sharedModelContainer: ModelContainer = {
        let schema = Schema([
            Item.self,
        ])
        let modelConfiguration = ModelConfiguration(schema: schema, isStoredInMemoryOnly: false)

        do {
            return try ModelContainer(for: schema, configurations: [modelConfiguration])
        } catch {
            fatalError("Could not create ModelContainer: \(error)")
        }
    }()

    init() {
        // 启动认证流程
        Self.ensureAuthenticated()

        // 监听认证错误通知
        NotificationCenter.default.addObserver(
            forName: NSNotification.Name("AuthenticationError"),
            object: nil,
            queue: .main
        ) { _ in
            print("⚠️ [VlaudeApp] 收到认证错误通知，重新认证...")
            Self.ensureAuthenticated()
        }
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
        }
        .modelContainer(sharedModelContainer)
    }

    // MARK: - 认证管理

    private static func ensureAuthenticated() {
        AuthService.shared.ensureAuthenticated { result in
            switch result {
            case .success(let token):
                print("✅ [VlaudeApp] 认证成功，Token: \(token.prefix(20))...")

                // Token 已准备好，连接 WebSocket
                DispatchQueue.main.async {
                    WebSocketManager.shared.reconnectWithNewToken()
                }

            case .failure(let error):
                print("❌ [VlaudeApp] 认证失败: \(error.localizedDescription)")

                // 可以在这里显示错误提示给用户
                // 或者设置一个定时器重试
                DispatchQueue.main.asyncAfter(deadline: .now() + 5) {
                    print("🔄 [VlaudeApp] 5 秒后重试认证...")
                    Self.ensureAuthenticated()
                }
            }
        }
    }
}
