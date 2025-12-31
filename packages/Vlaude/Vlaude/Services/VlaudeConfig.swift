//
//  VlaudeConfig.swift
//  Vlaude
//
//  统一配置管理
//  优先级: 环境变量 > ~/.vimo/config.json > Info.plist > 默认值
//

import Foundation

/// Vlaude 服务配置
struct VlaudeServiceConfig: Codable {
    let host: String
    let port: Int

    var url: String {
        return "\(host):\(port)"
    }
}

/// Vlaude 配置文件结构
struct VlaudeConfigFile: Codable {
    let services: VlaudeServices?

    struct VlaudeServices: Codable {
        let vlaudeServer: VlaudeServiceConfig?
        let vlaudeDaemon: VlaudeServiceConfig?
        let redis: VlaudeServiceConfig?

        enum CodingKeys: String, CodingKey {
            case vlaudeServer = "vlaude-server"
            case vlaudeDaemon = "vlaude-daemon"
            case redis
        }
    }
}

/// 统一配置管理器
final class VlaudeConfig {
    static let shared = VlaudeConfig()

    private var configFile: VlaudeConfigFile?
    private let configPath: String

    // MARK: - 默认值

    private struct Defaults {
        static let serverHost = "localhost"
        static let serverPort = 10005
        static let daemonHost = "localhost"
        static let daemonPort = 10006
        static let redisHost = "localhost"
        static let redisPort = 6379
    }

    // MARK: - 初始化

    private init() {
        // 配置文件路径: ~/.vimo/config.json
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        self.configPath = "\(home)/.vimo/config.json"
        loadConfigFile()
    }

    /// 加载配置文件
    private func loadConfigFile() {
        guard FileManager.default.fileExists(atPath: configPath),
              let data = FileManager.default.contents(atPath: configPath) else {
            print("[VlaudeConfig] 配置文件不存在: \(configPath)，使用默认值")
            return
        }

        do {
            configFile = try JSONDecoder().decode(VlaudeConfigFile.self, from: data)
            print("[VlaudeConfig] 已加载配置文件: \(configPath)")
        } catch {
            print("[VlaudeConfig] 配置文件解析失败: \(error)，使用默认值")
        }
    }

    /// 重新加载配置
    func reload() {
        loadConfigFile()
    }

    // MARK: - Vlaude Server 配置

    var serverHost: String {
        // 1. 环境变量
        if let env = ProcessInfo.processInfo.environment["VLAUDE_SERVER_HOST"], !env.isEmpty {
            return env
        }
        // 2. 配置文件
        if let host = configFile?.services?.vlaudeServer?.host {
            return host
        }
        // 3. Info.plist
        if let plist = Bundle.main.object(forInfoDictionaryKey: "VLAUDE_SERVER_HOST") as? String, !plist.isEmpty {
            return plist
        }
        // 4. 默认值
        return Defaults.serverHost
    }

    var serverPort: Int {
        // 1. 环境变量
        if let env = ProcessInfo.processInfo.environment["VLAUDE_SERVER_PORT"],
           let port = Int(env) {
            return port
        }
        // 2. 配置文件
        if let port = configFile?.services?.vlaudeServer?.port {
            return port
        }
        // 3. Info.plist
        if let plist = Bundle.main.object(forInfoDictionaryKey: "VLAUDE_SERVER_PORT") as? Int {
            return plist
        }
        // 4. 默认值
        return Defaults.serverPort
    }

    var serverURL: String {
        return "\(serverHost):\(serverPort)"
    }

    // MARK: - Vlaude Daemon 配置

    var daemonHost: String {
        if let env = ProcessInfo.processInfo.environment["VLAUDE_DAEMON_HOST"], !env.isEmpty {
            return env
        }
        if let host = configFile?.services?.vlaudeDaemon?.host {
            return host
        }
        return Defaults.daemonHost
    }

    var daemonPort: Int {
        if let env = ProcessInfo.processInfo.environment["VLAUDE_DAEMON_PORT"],
           let port = Int(env) {
            return port
        }
        if let port = configFile?.services?.vlaudeDaemon?.port {
            return port
        }
        return Defaults.daemonPort
    }

    var daemonURL: String {
        return "\(daemonHost):\(daemonPort)"
    }

    // MARK: - Redis 配置

    var redisHost: String {
        if let env = ProcessInfo.processInfo.environment["REDIS_HOST"], !env.isEmpty {
            return env
        }
        if let host = configFile?.services?.redis?.host {
            return host
        }
        return Defaults.redisHost
    }

    var redisPort: Int {
        if let env = ProcessInfo.processInfo.environment["REDIS_PORT"],
           let port = Int(env) {
            return port
        }
        if let port = configFile?.services?.redis?.port {
            return port
        }
        return Defaults.redisPort
    }
}
