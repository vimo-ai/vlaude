//
//  ApprovalButtonsView.swift
//  Vlaude
//
//  通用的审批按钮组件 - 用于需要权限审批的工具
//

import SwiftUI

/// 审批按钮组件
struct ApprovalButtonsView: View {
    let status: ToolApprovalStatus
    let onApprove: (String) -> Void  // action: "y" = 允许一次, "a" = 始终允许, "n" = 拒绝

    var body: some View {
        Group {
            switch status {
            case .none:
                EmptyView()

            case .awaitingPermission:
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

            case .completed:
                // 已完成 - 不显示额外状态（结果会在 ToolView 中显示）
                EmptyView()

            case .rejected:
                // 已拒绝
                HStack(spacing: 4) {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundColor(.red)
                    Text("已拒绝")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundColor(.red)
                }
                .padding(.top, 8)

            case .timeout:
                // 已超时
                HStack(spacing: 4) {
                    Image(systemName: "clock.badge.exclamationmark")
                        .foregroundColor(.orange)
                    Text("已超时")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundColor(.orange)
                }
                .padding(.top, 8)

            case .cancelled:
                // 已取消（ETerm Interrupt）
                HStack(spacing: 4) {
                    Image(systemName: "minus.circle.fill")
                        .foregroundColor(.secondary)
                    Text("已取消")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundColor(.secondary)
                }
                .padding(.top, 8)
            }
        }
    }
}

/// 审批状态标签（紧凑版，用于显示在工具标题旁边）
struct ApprovalStatusBadge: View {
    let status: ToolApprovalStatus

    var body: some View {
        switch status {
        case .none, .completed:
            EmptyView()

        case .awaitingPermission:
            Label("需要审批", systemImage: "exclamationmark.shield")
                .font(.system(size: 10, weight: .medium))
                .foregroundColor(.orange)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(Color.orange.opacity(0.15))
                .cornerRadius(4)

        case .pendingAck:
            Label("等待确认", systemImage: "clock")
                .font(.system(size: 10, weight: .medium))
                .foregroundColor(.blue)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(Color.blue.opacity(0.15))
                .cornerRadius(4)

        case .executing:
            Label("执行中", systemImage: "gearshape.2")
                .font(.system(size: 10, weight: .medium))
                .foregroundColor(.green)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(Color.green.opacity(0.15))
                .cornerRadius(4)

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
