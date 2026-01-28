//
//  VlaudeWebSocketSessionDelegate.swift
//  Vlaude
//
//  WebSocket mTLS Session Delegate
//  Note: This is similar to CoreNetworkKit's MTLSSessionDelegate but uses URLSessionDelegate
//  instead of Alamofire's SessionDelegate, as required by Socket.IO
//

import Foundation
import Security

/// WebSocket mTLS Session Delegate
/// 处理 URLSession 的证书挑战，用于 Socket.IO 连接
final class VlaudeWebSocketSessionDelegate: NSObject, URLSessionDelegate {

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
            completionHandler(.cancelAuthenticationChallenge, nil)
        }
    }
}
