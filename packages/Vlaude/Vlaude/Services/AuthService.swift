//
//  AuthService.swift
//  Vlaude
//
//  Created by Claude on 2025/11/21.
//

import Foundation
import Security
import UIKit

// MARK: - Keychain 错误类型
enum KeychainError: Error {
    case saveFailed(OSStatus)
    case loadFailed(OSStatus)
    case deleteFailed(OSStatus)
    case unexpectedData
    case itemNotFound
}

// MARK: - Token 响应结构
struct TokenResponse: Codable {
    let token: String
}

// MARK: - 认证服务
class AuthService {
    static let shared = AuthService()

    private let keychainKey = "com.vlaude.jwt.token"
    private let keychainService = "com.vlaude.app"

    private init() {}

    // MARK: - Keychain 存储管理

    /// 保存 Token 到 Keychain
    func saveToken(_ token: String) -> Bool {
        // 先删除旧的 Token
        _ = deleteToken()

        guard let data = token.data(using: .utf8) else {
            print("❌ [AuthService] Token 转换为 Data 失败")
            return false
        }

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: keychainKey,
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock
        ]

        let status = SecItemAdd(query as CFDictionary, nil)

        if status == errSecSuccess {
            print("✅ [AuthService] Token 保存成功")
            return true
        } else {
            print("❌ [AuthService] Token 保存失败: \(status)")
            return false
        }
    }

    /// 从 Keychain 获取 Token
    func getToken() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: keychainKey,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)

        if status == errSecSuccess {
            if let data = item as? Data,
               let token = String(data: data, encoding: .utf8) {
                print("✅ [AuthService] Token 读取成功: \(token.prefix(20))...")
                return token
            }
        } else if status == errSecItemNotFound {
            print("⚠️ [AuthService] Token 未找到")
        } else {
            print("❌ [AuthService] Token 读取失败: \(status)")
        }

        return nil
    }

    /// 从 Keychain 删除 Token
    func deleteToken() -> Bool {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: keychainKey
        ]

        let status = SecItemDelete(query as CFDictionary)

        if status == errSecSuccess || status == errSecItemNotFound {
            print("✅ [AuthService] Token 删除成功")
            return true
        } else {
            print("❌ [AuthService] Token 删除失败: \(status)")
            return false
        }
    }

    // MARK: - Token 获取

    /// 从服务器获取 Token
    func fetchToken(completion: @escaping (Result<String, Error>) -> Void) {
        // 获取设备信息
        let deviceId = UIDevice.current.identifierForVendor?.uuidString ?? UUID().uuidString
        let deviceName = UIDevice.current.name

        print("📱 [AuthService] 设备信息:")
        print("   Device ID: \(deviceId)")
        print("   Device Name: \(deviceName)")

        Task {
            do {
                // 调用 VlaudeClient 获取 Token（包含 deviceName 用于设备白名单注册）
                let token = try await VlaudeClient.shared.generateToken(clientId: deviceId, clientType: "ios", deviceName: deviceName)

                // 保存 Token 到 Keychain
                if self.saveToken(token) {
                    print("✅ [AuthService] Token 获取并保存成功")
                    DispatchQueue.main.async {
                        completion(.success(token))
                    }
                } else {
                    let error = NSError(domain: "AuthService", code: -1, userInfo: [
                        NSLocalizedDescriptionKey: "Token 保存失败"
                    ])
                    DispatchQueue.main.async {
                        completion(.failure(error))
                    }
                }
            } catch {
                print("❌ [AuthService] Token 获取失败: \(error.localizedDescription)")
                DispatchQueue.main.async {
                    completion(.failure(error))
                }
            }
        }
    }

    /// 确保已认证（有 Token）
    func ensureAuthenticated(completion: @escaping (Result<String, Error>) -> Void) {
        if let token = getToken() {
            // 已有 Token，直接返回
            completion(.success(token))
        } else {
            // 没有 Token，重新获取
            print("⚠️ [AuthService] 未找到 Token，开始获取...")
            fetchToken(completion: completion)
        }
    }
}
