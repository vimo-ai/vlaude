//
//  CertificateManager.swift
//  Vlaude
//
//  mTLS 客户端证书管理
//

import Foundation
import Security

class CertificateManager {
    static let shared = CertificateManager()

    // 证书配置
    private let p12FileName = "ios-client"  // 不含扩展名
    private let p12Password = "vlaude123"
    private let caFileName = "ca"           // 不含扩展名

    // 缓存
    private var clientIdentity: SecIdentity?
    private var clientCertificate: SecCertificate?
    private var caCertificate: SecCertificate?

    private init() {
        loadCertificates()
    }

    // MARK: - 加载证书

    private func loadCertificates() {
        loadClientIdentity()
        loadCACertificate()
    }

    /// 加载客户端身份（私钥 + 证书）
    private func loadClientIdentity() {
        guard let p12URL = Bundle.main.url(forResource: p12FileName, withExtension: "p12"),
              let p12Data = try? Data(contentsOf: p12URL) else {
            print("⚠️ [CertificateManager] 找不到客户端证书文件: \(p12FileName).p12")
            return
        }

        let options: [String: Any] = [
            kSecImportExportPassphrase as String: p12Password
        ]

        var items: CFArray?
        let status = SecPKCS12Import(p12Data as CFData, options as CFDictionary, &items)

        guard status == errSecSuccess,
              let itemsArray = items as? [[String: Any]],
              let firstItem = itemsArray.first,
              let identity = firstItem[kSecImportItemIdentity as String] as! SecIdentity? else {
            print("❌ [CertificateManager] 客户端证书导入失败: \(status)")
            return
        }

        self.clientIdentity = identity

        // 从 identity 提取证书
        var certificate: SecCertificate?
        SecIdentityCopyCertificate(identity, &certificate)
        self.clientCertificate = certificate

        print("✅ [CertificateManager] 客户端证书加载成功")
    }

    /// 加载 CA 证书（用于验证服务端）
    private func loadCACertificate() {
        guard let caURL = Bundle.main.url(forResource: caFileName, withExtension: "crt"),
              let caData = try? Data(contentsOf: caURL) else {
            // 尝试 .cer 格式
            guard let caURL = Bundle.main.url(forResource: caFileName, withExtension: "cer"),
                  let caData = try? Data(contentsOf: caURL) else {
                print("⚠️ [CertificateManager] 找不到 CA 证书文件")
                return
            }
            loadCAFromData(caData)
            return
        }
        loadCAFromData(caData)
    }

    private func loadCAFromData(_ data: Data) {
        // 尝试 DER 格式
        if let cert = SecCertificateCreateWithData(nil, data as CFData) {
            self.caCertificate = cert
            print("✅ [CertificateManager] CA 证书加载成功 (DER)")
            return
        }

        // 尝试 PEM 格式
        if let pemString = String(data: data, encoding: .utf8) {
            let base64 = pemString
                .replacingOccurrences(of: "-----BEGIN CERTIFICATE-----", with: "")
                .replacingOccurrences(of: "-----END CERTIFICATE-----", with: "")
                .replacingOccurrences(of: "\n", with: "")
                .replacingOccurrences(of: "\r", with: "")

            if let derData = Data(base64Encoded: base64),
               let cert = SecCertificateCreateWithData(nil, derData as CFData) {
                self.caCertificate = cert
                print("✅ [CertificateManager] CA 证书加载成功 (PEM)")
                return
            }
        }

        print("❌ [CertificateManager] CA 证书格式无法识别")
    }

    // MARK: - 公开接口

    /// 检查证书是否可用
    var isReady: Bool {
        return clientIdentity != nil
    }

    /// 获取客户端身份凭证（用于 URLSession）
    func getClientCredential() -> URLCredential? {
        guard let identity = clientIdentity else {
            print("⚠️ [CertificateManager] 客户端身份未加载")
            return nil
        }

        var certificates: [SecCertificate] = []
        if let cert = clientCertificate {
            certificates.append(cert)
        }

        return URLCredential(
            identity: identity,
            certificates: certificates as [Any],
            persistence: .forSession
        )
    }

    /// 获取服务端信任评估用的锚点证书
    func getServerTrustAnchors() -> [SecCertificate] {
        if let ca = caCertificate {
            return [ca]
        }
        return []
    }

    /// 验证服务端证书（自签名证书场景）
    func validateServerTrust(_ serverTrust: SecTrust, for host: String) -> Bool {
        // 设置自定义锚点证书
        let anchors = getServerTrustAnchors()
        if !anchors.isEmpty {
            SecTrustSetAnchorCertificates(serverTrust, anchors as CFArray)
            SecTrustSetAnchorCertificatesOnly(serverTrust, true)
        }

        // 执行信任评估
        var error: CFError?
        let isValid = SecTrustEvaluateWithError(serverTrust, &error)

        if !isValid {
            print("❌ [CertificateManager] 服务端证书验证失败: \(error?.localizedDescription ?? "未知错误")")
        }

        return isValid
    }
}
