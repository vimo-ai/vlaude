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
        // 启动 WebSocket 连接
        WebSocketManager.shared.connect()
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
        }
        .modelContainer(sharedModelContainer)
    }
}
