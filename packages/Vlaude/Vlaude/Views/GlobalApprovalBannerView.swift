//
//  GlobalApprovalBannerView.swift
//  Vlaude
//
//  全局审批 Banner — iOS 来电风格的顶部浮层
//  用户不在目标 session 页面时，从顶部滑入显示审批请求
//

import SwiftUI

struct GlobalApprovalBannerView: View {
    let approval: PendingApproval
    let responseState: ApprovalResponseState
    let onAction: (String) -> Void   // "y" / "a" / "n"
    let onDismiss: () -> Void

    @State private var dragOffset: CGFloat = 0

    var body: some View {
        VStack(spacing: 0) {
            cardContent
                .offset(y: dragOffset)
                .gesture(dismissGesture)
                .onAppear {
                    let generator = UINotificationFeedbackGenerator()
                    generator.notificationOccurred(.warning)
                }
        }
        .padding(.horizontal, 12)
        .padding(.top, 8)
    }

    // MARK: - Card Content

    private var cardContent: some View {
        VStack(alignment: .leading, spacing: 10) {
            // 标题行：工具图标 + 工具名 + session 前缀
            HStack(spacing: 8) {
                Image(systemName: toolIcon)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundColor(.white)
                    .frame(width: 28, height: 28)
                    .background(toolColor)
                    .clipShape(RoundedRectangle(cornerRadius: 6))

                VStack(alignment: .leading, spacing: 1) {
                    Text(approval.toolName)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundColor(.primary)

                    Text(String(approval.sessionId.prefix(8)))
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundColor(.secondary)
                }

                Spacer()

                // 上滑关闭提示
                Image(systemName: "chevron.compact.up")
                    .font(.system(size: 12))
                    .foregroundColor(.secondary.opacity(0.5))
            }

            // 描述
            Text(approval.description)
                .font(.system(size: 12))
                .foregroundColor(.secondary)
                .lineLimit(2)

            // 操作按钮 / 状态指示器
            actionArea
        }
        .padding(14)
        .background(.ultraThinMaterial)
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .shadow(color: .black.opacity(0.12), radius: 12, x: 0, y: 4)
    }

    // MARK: - Action Area

    @ViewBuilder
    private var actionArea: some View {
        switch responseState {
        case .none, .awaiting:
            HStack(spacing: 8) {
                bannerButton("允许", icon: "checkmark.circle", color: .green) {
                    onAction("y")
                }
                bannerButton("始终允许", icon: "checkmark.circle.fill", color: .blue) {
                    onAction("a")
                }
                bannerButton("拒绝", icon: "xmark.circle", color: .red) {
                    onAction("n")
                }
            }

        case .pendingAck:
            HStack(spacing: 6) {
                ProgressView()
                    .scaleEffect(0.7)
                Text("等待确认...")
                    .font(.system(size: 12))
                    .foregroundColor(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .center)
            .padding(.vertical, 2)

        case .executing:
            HStack(spacing: 6) {
                ProgressView()
                    .scaleEffect(0.7)
                Text("执行中...")
                    .font(.system(size: 12))
                    .foregroundColor(.orange)
            }
            .frame(maxWidth: .infinity, alignment: .center)
            .padding(.vertical, 2)
        }
    }

    // MARK: - Button Helper

    private func bannerButton(_ title: String, icon: String, color: Color, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 3) {
                Image(systemName: icon)
                    .font(.system(size: 11))
                Text(title)
                    .font(.system(size: 11, weight: .medium))
            }
            .foregroundColor(.white)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(color)
            .clipShape(RoundedRectangle(cornerRadius: 6))
        }
        .buttonStyle(.plain)
    }

    // MARK: - Dismiss Gesture

    private var dismissGesture: some Gesture {
        DragGesture()
            .onChanged { value in
                // 仅允许上滑
                if value.translation.height < 0 {
                    dragOffset = value.translation.height
                }
            }
            .onEnded { value in
                if value.translation.height < -50 {
                    // 上滑超过阈值 → 关闭
                    withAnimation(.spring(response: 0.25)) {
                        dragOffset = -300
                    }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
                        onDismiss()
                    }
                } else {
                    // 回弹
                    withAnimation(.spring(response: 0.25)) {
                        dragOffset = 0
                    }
                }
            }
    }

    // MARK: - Tool Styling

    private var toolIcon: String {
        switch approval.toolName {
        case "Bash": return "terminal.fill"
        case "Write": return "doc.fill"
        case "Edit": return "pencil"
        case "Read": return "doc.text.fill"
        case "Glob": return "folder.fill"
        case "Grep": return "magnifyingglass"
        case "WebFetch": return "globe"
        case "WebSearch": return "magnifyingglass.circle.fill"
        case "Task": return "cpu"
        default:
            if approval.toolName.hasPrefix("mcp__") {
                return "puzzlepiece.fill"
            }
            return "wrench.and.screwdriver.fill"
        }
    }

    private var toolColor: Color {
        switch approval.toolName {
        case "Bash": return .orange
        case "Write", "Edit": return .blue
        case "Read", "Glob", "Grep": return .purple
        case "WebFetch", "WebSearch": return .teal
        case "Task": return .indigo
        default:
            if approval.toolName.hasPrefix("mcp__") {
                return .mint
            }
            return .gray
        }
    }
}
