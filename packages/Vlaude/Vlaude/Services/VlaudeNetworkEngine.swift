//
//  VlaudeNetworkEngine.swift
//  Vlaude
//
//  mTLS 网络引擎，实现 CoreNetworkKit 的 NetworkEngine 协议
//

import Foundation
import CoreNetworkKit

final class VlaudeNetworkEngine: NSObject, NetworkEngine {

    private var session: URLSession!
    private let useMTLS: Bool

    override init() {
        self.useMTLS = CertificateManager.shared.isReady

        super.init()

        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 30
        config.timeoutIntervalForResource = 300

        // 使用自定义 delegate 处理证书挑战
        self.session = URLSession(configuration: config, delegate: self, delegateQueue: nil)

        if useMTLS {
            print("[VlaudeNetworkEngine] mTLS 模式已启用")
        } else {
            print("[VlaudeNetworkEngine] 未找到客户端证书，使用普通 HTTP")
        }
    }

    static func create() -> VlaudeNetworkEngine {
        return VlaudeNetworkEngine()
    }

    // MARK: - NetworkEngine

    func performRequest(_ request: URLRequest) async throws -> (Data, URLResponse) {
        return try await session.data(for: request)
    }
}

// MARK: - URLSessionDelegate (mTLS 证书处理)
extension VlaudeNetworkEngine: URLSessionDelegate {

    func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        let authMethod = challenge.protectionSpace.authenticationMethod

        switch authMethod {
        case NSURLAuthenticationMethodServerTrust:
            handleServerTrust(challenge, completionHandler: completionHandler)

        case NSURLAuthenticationMethodClientCertificate:
            handleClientCertificate(challenge, completionHandler: completionHandler)

        default:
            completionHandler(.performDefaultHandling, nil)
        }
    }

    private func handleServerTrust(
        _ challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        guard let serverTrust = challenge.protectionSpace.serverTrust else {
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }

        let host = challenge.protectionSpace.host

        if CertificateManager.shared.validateServerTrust(serverTrust, for: host) {
            let credential = URLCredential(trust: serverTrust)
            completionHandler(.useCredential, credential)
        } else {
            print("[VlaudeNetworkEngine] 服务端证书验证失败: \(host)")
            completionHandler(.cancelAuthenticationChallenge, nil)
        }
    }

    private func handleClientCertificate(
        _ challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        if let credential = CertificateManager.shared.getClientCredential() {
            completionHandler(.useCredential, credential)
        } else {
            print("[VlaudeNetworkEngine] 无法提供客户端证书")
            completionHandler(.cancelAuthenticationChallenge, nil)
        }
    }
}
