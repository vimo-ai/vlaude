//
//  SessionStatusBar.swift
//  Vlaude
//
//  Created by Claude on 2025/11/20.
//

import SwiftUI

/// Session 状态栏组件
/// 显示：连接状态 | Context 进度条 | Token 统计
struct SessionStatusBar: View {
    let statusData: SessionStatusData

    var body: some View {
        HStack(spacing: 8) {
            // 1. 连接状态图标
            if statusData.connected {
                connectionStatusIcon
            }

            // 2. Context 进度条
            if let percentage = statusData.contextPercentage {
                contextProgressView(percentage: percentage)
            }

            Spacer()

            // 3. Token 统计
            if let inputTokens = statusData.inputTokens,
               let outputTokens = statusData.outputTokens {
                tokenStatsView(input: inputTokens, output: outputTokens)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Color(UIColor.systemBackground))
        .overlay(
            Rectangle()
                .frame(height: 0.5)
                .foregroundColor(Color.gray.opacity(0.3)),
            alignment: .bottom
        )
    }

    // MARK: - 子视图

    /// 连接状态图标
    private var connectionStatusIcon: some View {
        Group {
            if statusData.mode == .remote {
                Text("📱")
                    .font(.system(size: 14))
            } else {
                Text("✅")
                    .font(.system(size: 14))
            }
        }
    }

    /// Context 进度条视图
    private func contextProgressView(percentage: Double) -> some View {
        HStack(spacing: 6) {
            // 进度条
            ContextProgressBar(percentage: percentage)
                .frame(width: 80, height: 8)

            // 百分比文字
            Text(String(format: "%.1f%%", percentage))
                .font(.system(size: 11, design: .monospaced))
                .foregroundColor(.secondary)
        }
    }

    /// Token 统计视图
    private func tokenStatsView(input: Int, output: Int) -> some View {
        HStack(spacing: 8) {
            // Input tokens
            HStack(spacing: 2) {
                Text("↑")
                    .font(.system(size: 11))
                    .foregroundColor(Color(red: 0.5, green: 0.7, blue: 0.9))  // 柔和蓝
                Text(input.formatAsTokenCount())
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundColor(Color(red: 0.5, green: 0.7, blue: 0.9))
            }

            // Output tokens
            HStack(spacing: 2) {
                Text("↓")
                    .font(.system(size: 11))
                    .foregroundColor(Color(red: 0.5, green: 0.8, blue: 0.85))  // 柔和青
                Text(output.formatAsTokenCount())
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundColor(Color(red: 0.5, green: 0.8, blue: 0.85))
            }
        }
    }
}

// MARK: - Context 进度条组件

/// 彩色渐变进度条（通过遮罩切割显示进度）
/// 参考 Statusline 的渲染逻辑：
/// - 0-15%: 深灰色
/// - 15%+: 完整的绿→黄→红渐变，通过圆角矩形遮罩切割
struct ContextProgressBar: View {
    let percentage: Double

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                // 背景（空进度）
                RoundedRectangle(cornerRadius: 4)
                    .fill(Color.gray.opacity(0.2))

                // 前景（已填充进度）
                if percentage < 15 {
                    // 0-15%: 深灰色
                    RoundedRectangle(cornerRadius: 4)
                        .fill(Color(red: 0.47, green: 0.47, blue: 0.47))
                        .frame(width: geometry.size.width * clampedPercentage)
                } else {
                    // 15%+: 完整渐变 + 遮罩切割
                    fullGradientBar
                        .frame(width: geometry.size.width)
                        .mask(
                            HStack(spacing: 0) {
                                // 左侧：可见区域（圆角矩形）
                                RoundedRectangle(cornerRadius: 4)
                                    .frame(width: geometry.size.width * clampedPercentage)

                                Spacer(minLength: 0)
                            }
                        )
                }
            }
        }
    }

    /// 限制百分比在 0-1 之间，并将 90% 映射为 100%（参考 Statusline 逻辑）
    private var clampedPercentage: Double {
        let normalized = min(100, max(0, percentage)) / 90.0
        return min(1.0, normalized)
    }

    /// 完整的绿→黄→红渐变条（马卡龙色系）
    private var fullGradientBar: some View {
        RoundedRectangle(cornerRadius: 4)
            .fill(
                LinearGradient(
                    colors: [
                        Color(red: 0.5, green: 0.95, blue: 0.75),   // 薄荷绿
                        Color(red: 1.0, green: 0.95, blue: 0.65),   // 奶油黄
                        Color(red: 1.0, green: 0.7, blue: 0.6)      // 蜜桃粉
                    ],
                    startPoint: .leading,
                    endPoint: .trailing
                )
            )
    }
}

// MARK: - Preview

#Preview("连接状态 - 本地") {
    SessionStatusBar(statusData: SessionStatusData(
        connected: true,
        mode: .local,
        contextLength: 45200,
        contextPercentage: 22.6,
        inputTokens: 25300,
        outputTokens: 12100,
        timestamp: Date()
    ))
}

#Preview("连接状态 - 远程") {
    SessionStatusBar(statusData: SessionStatusData(
        connected: true,
        mode: .remote,
        contextLength: 90000,
        contextPercentage: 45.0,
        inputTokens: 125000,
        outputTokens: 68000,
        timestamp: Date()
    ))
}

#Preview("高使用率") {
    SessionStatusBar(statusData: SessionStatusData(
        connected: true,
        mode: .local,
        contextLength: 150000,
        contextPercentage: 75.0,
        inputTokens: 1500000,
        outputTokens: 850000,
        timestamp: Date()
    ))
}

#Preview("未连接") {
    SessionStatusBar(statusData: SessionStatusData(
        connected: false,
        mode: nil,
        contextLength: 10000,
        contextPercentage: 5.0,
        inputTokens: 5000,
        outputTokens: 2000,
        timestamp: Date()
    ))
}
