//
//  ApprovalAlertView.swift
//  Vlaude
//
//  Created by Claude on 2025/11/19.
//

import SwiftUI

/// 权限请求响应动作
enum ApprovalAction: String {
    case allowOnce = "y"      // 允许一次
    case allowAll = "a"       // 始终允许此类操作
    case deny = "n"           // 拒绝

    /// 带理由拒绝
    static func denyWithReason(_ reason: String) -> String {
        return "n: \(reason)"
    }
}

/// 权限请求 Alert 辅助
extension View {
    /// 显示权限请求确认对话框（支持多选项）
    func approvalAlert(
        isPresented: Binding<Bool>,
        requestId: String,
        sessionId: String,
        toolName: String,
        description: String,
        onAction: @escaping (String) -> Void
    ) -> some View {
        confirmationDialog("Claude 需要执行操作", isPresented: isPresented, titleVisibility: .visible) {
            Button("允许一次") {
                onAction(ApprovalAction.allowOnce.rawValue)
            }
            Button("始终允许") {
                onAction(ApprovalAction.allowAll.rawValue)
            }
            Button("拒绝", role: .destructive) {
                onAction(ApprovalAction.deny.rawValue)
            }
            Button("取消", role: .cancel) { }
        } message: {
            Text("\(description)\n\n工具: \(toolName)")
        }
    }
}

/// 使用示例（在 SessionDetailView 中）：
///
/// @State private var showApprovalAlert = false
/// @State private var currentApprovalRequest: (requestId: String, sessionId: String, toolName: String, description: String)?
///
/// var body: some View {
///     // ... 你的UI代码
///
///     .approvalAlert(
///         isPresented: $showApprovalAlert,
///         requestId: currentApprovalRequest?.requestId ?? "",
///         sessionId: currentApprovalRequest?.sessionId ?? "",
///         toolName: currentApprovalRequest?.toolName ?? "",
///         description: currentApprovalRequest?.description ?? ""
///     ) { action in
///         // 用户选择了某个动作 (y/n/a)
///         VlaudeWebSocketClient.shared.sendApprovalResponse(
///             requestId: currentApprovalRequest?.requestId ?? "",
///             sessionId: currentApprovalRequest?.sessionId ?? "",
///             action: action
///         )
///         showApprovalAlert = false
///     }
///     .onReceive(NotificationCenter.default.publisher(for: NSNotification.Name("ApprovalRequest"))) { notification in
///         // 收到权限请求通知
///         if let requestId = notification.userInfo?["requestId"] as? String,
///            let sessionId = notification.userInfo?["sessionId"] as? String,
///            let toolName = notification.userInfo?["toolName"] as? String,
///            let description = notification.userInfo?["description"] as? String {
///             currentApprovalRequest = (requestId, sessionId, toolName, description)
///             showApprovalAlert = true
///         }
///     }
/// }
