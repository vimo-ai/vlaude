//
//  ApprovalButtonsView.swift
//  Vlaude
//
//  通用的审批按钮组件 - 用于需要权限审批的工具
//  只处理活跃态（awaiting 按钮 + pendingAck/executing spinner）
//  终态 badge 由 ApprovalStatusBadge 处理
//

import SwiftUI

/// 审批按钮组件（活跃态）
struct ApprovalButtonsView: View {
    let responseState: ApprovalResponseState
    let onApprove: (String) -> Void  // action: "y" = 允许一次, "a" = 始终允许, "n" = 拒绝

    var body: some View {
        Group {
            switch responseState {
            case .none:
                EmptyView()

            case .awaiting:
                // 等待审批 - 显示三个按钮
                HStack(spacing: 8) {
                    Button(action: { onApprove("y") }) {
                        HStack(spacing: 4) {
                            Image(systemName: "checkmark.circle")
                            Text("允许")
                        }
                        .font(.system(size: 12, weight: .medium))
                        .foregroundColor(.white)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .background(Color.green)
                        .cornerRadius(6)
                    }
                    .buttonStyle(.plain)

                    Button(action: { onApprove("a") }) {
                        HStack(spacing: 4) {
                            Image(systemName: "checkmark.circle.fill")
                            Text("始终允许")
                        }
                        .font(.system(size: 12, weight: .medium))
                        .foregroundColor(.white)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .background(Color.blue)
                        .cornerRadius(6)
                    }
                    .buttonStyle(.plain)

                    Button(action: { onApprove("n") }) {
                        HStack(spacing: 4) {
                            Image(systemName: "xmark.circle")
                            Text("拒绝")
                        }
                        .font(.system(size: 12, weight: .medium))
                        .foregroundColor(.white)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .background(Color.red)
                        .cornerRadius(6)
                    }
                    .buttonStyle(.plain)
                }
                .padding(.top, 8)

            case .pendingAck:
                // 等待 ETerm 确认
                HStack(spacing: 6) {
                    ProgressView()
                        .scaleEffect(0.7)
                    Text("等待确认...")
                        .font(.system(size: 12))
                        .foregroundColor(.secondary)
                }
                .padding(.top, 8)

            case .executing:
                // 正在执行
                HStack(spacing: 6) {
                    ProgressView()
                        .scaleEffect(0.7)
                    Text("执行中...")
                        .font(.system(size: 12))
                        .foregroundColor(.orange)
                }
                .padding(.top, 8)
            }
        }
    }
}

/// 审批状态标签（紧凑版，用于显示在工具标题旁边）
/// 只处理终态（timeout/rejected/cancelled），活跃态由 ApprovalResponseState 管理
struct ApprovalStatusBadge: View {
    let status: ToolApprovalStatus

    var body: some View {
        switch status {
        case .none:
            EmptyView()

        case .rejected:
            Label("已拒绝", systemImage: "xmark.shield")
                .font(.system(size: 10, weight: .medium))
                .foregroundColor(.red)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(Color.red.opacity(0.15))
                .cornerRadius(4)

        case .timeout:
            Label("已超时", systemImage: "clock.badge.exclamationmark")
                .font(.system(size: 10, weight: .medium))
                .foregroundColor(.orange)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(Color.orange.opacity(0.15))
                .cornerRadius(4)

        case .cancelled:
            Label("已取消", systemImage: "minus.circle")
                .font(.system(size: 10, weight: .medium))
                .foregroundColor(.secondary)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(Color.secondary.opacity(0.15))
                .cornerRadius(4)
        }
    }
}
