//
//  SessionTimelineView.swift
//  Vlaude
//
//  Timeline 主视图：以 Turn 为单位展示 Claude Code 完整工作过程
//  纯内容组件，不包含 ScrollView（由外层 SessionDetailView 统一管理滚动）
//

import SwiftUI

struct SessionTimelineView: View {
    @ObservedObject var turnBuilder: TurnBuilder
    let sessionId: String
    var onApprovalAction: ((String, String) -> Void)? = nil

    var body: some View {
        ForEach(Array(turnBuilder.turns.enumerated()), id: \.element.id) { index, turn in
            TurnCard(
                turn: turn,
                sessionId: sessionId,
                turnIndex: index + 1,
                onApprovalAction: onApprovalAction
            )
            .id(turn.id)
        }
    }
}
