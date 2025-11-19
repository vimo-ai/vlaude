//
//  ApprovalAlertView.swift
//  Vlaude
//
//  Created by Claude on 2025/11/19.
//

import SwiftUI

/// 权限请求 Alert 辅助
extension View {
    /// 显示权限请求确认对话框
    func approvalAlert(
        isPresented: Binding<Bool>,
        requestId: String,
        toolName: String,
        description: String,
        onApprove: @escaping () -> Void,
        onDeny: @escaping () -> Void
    ) -> some View {
        alert("Claude 需要执行操作", isPresented: isPresented) {
            Button("允许", role: .none) {
                onApprove()
            }
            Button("拒绝", role: .cancel) {
                onDeny()
            }
        } message: {
            Text("\(description)\n\n工具: \(toolName)")
        }
    }
}

/// 使用示例（在 SessionDetailView 中）：
///
/// @State private var showApprovalAlert = false
/// @State private var currentApprovalRequest: (requestId: String, toolName: String, description: String)?
///
/// var body: some View {
///     // ... 你的UI代码
///
///     .approvalAlert(
///         isPresented: $showApprovalAlert,
///         requestId: currentApprovalRequest?.requestId ?? "",
///         toolName: currentApprovalRequest?.toolName ?? "",
///         description: currentApprovalRequest?.description ?? ""
///     ) {
///         // 用户点击"允许"
///         WebSocketManager.shared.sendApprovalResponse(
///             requestId: currentApprovalRequest?.requestId ?? "",
///             approved: true
///         )
///         showApprovalAlert = false
///     } onDeny: {
///         // 用户点击"拒绝"
///         WebSocketManager.shared.sendApprovalResponse(
///             requestId: currentApprovalRequest?.requestId ?? "",
///             approved: false,
///             reason: "用户拒绝"
///         )
///         showApprovalAlert = false
///     }
///     .onReceive(NotificationCenter.default.publisher(for: NSNotification.Name("ApprovalRequest"))) { notification in
///         // 收到权限请求通知
///         if let requestId = notification.userInfo?["requestId"] as? String,
///            let toolName = notification.userInfo?["toolName"] as? String,
///            let description = notification.userInfo?["description"] as? String {
///             currentApprovalRequest = (requestId, toolName, description)
///             showApprovalAlert = true
///         }
///     }
/// }
