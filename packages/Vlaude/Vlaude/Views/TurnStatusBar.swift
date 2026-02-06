//
//  TurnStatusBar.swift
//  Vlaude
//
//  Turn 状态指示器：active/waitingTool/completed/interrupted
//

import SwiftUI

struct TurnStatusBar: View {
    let status: TurnStatus

    var body: some View {
        HStack(spacing: 6) {
            statusIcon
            statusText
            Spacer()
        }
        .font(.caption2)
        .foregroundColor(statusColor)
        .padding(.horizontal, 4)
    }

    @ViewBuilder
    private var statusIcon: some View {
        switch status {
        case .active:
            ProgressView()
                .scaleEffect(0.6)
        case .waitingTool:
            Image(systemName: "wrench.and.screwdriver")
                .font(.system(size: 10))
        case .completed:
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 10))
        case .interrupted:
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 10))
        }
    }

    private var statusText: Text {
        switch status {
        case .active:
            return Text("处理中...")
        case .waitingTool:
            return Text("等待工具结果")
        case .completed:
            return Text("已完成")
        case .interrupted:
            return Text("已中断")
        }
    }

    private var statusColor: Color {
        switch status {
        case .active: return .orange
        case .waitingTool: return .blue
        case .completed: return .green
        case .interrupted: return .red
        }
    }
}
