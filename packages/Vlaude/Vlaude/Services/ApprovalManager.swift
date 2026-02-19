//
//  ApprovalManager.swift
//  Vlaude
//
//  App 级审批状态管理器
//  全局监听审批事件，在用户不在目标 session 页面时显示全局 banner
//

import Foundation
import Combine

@MainActor
final class ApprovalManager: ObservableObject {
    static let shared = ApprovalManager()

    // MARK: - Published State

    /// 全局审批状态：sessionId → PendingApproval（每个 session 同一时刻最多一个 pending）
    @Published private(set) var pendingApprovals: [String: PendingApproval] = [:]

    /// 全局 banner 显示的审批（用户不在目标 session 页面时才有值）
    @Published private(set) var bannerApproval: PendingApproval?

    /// banner 审批的响应状态（awaiting → pendingAck → executing → none）
    @Published private(set) var bannerResponseState: ApprovalResponseState = .none

    // MARK: - Private State

    /// 当前正在查看的 session 页面集合（支持 NavigationStack 中多层 SessionDetailView）
    private var activeSessionPages = Set<String>()

    /// 被用户手动关闭的 banner requestId（避免同一个审批反复弹出）
    private var dismissedBannerIds = Set<String>()

    /// NotificationCenter observers
    private var observers: [NSObjectProtocol] = []

    private let wsClient = VlaudeWebSocketClient.shared

    // MARK: - Init

    private init() {
        setupObservers()
    }

    deinit {
        observers.forEach { NotificationCenter.default.removeObserver($0) }
    }

    // MARK: - Observer Setup

    private func setupObservers() {
        let events: [(String, (Notification) -> Void)] = [
            ("ApprovalRequest", { [weak self] in self?.handleApprovalRequest($0) }),
            ("ApprovalTimeout", { [weak self] in self?.handleApprovalResolved($0) }),
            ("ApprovalExpired", { [weak self] in self?.handleApprovalResolved($0) }),
            ("ApprovalAck", { [weak self] in self?.handleApprovalAck($0) }),
            ("ApprovalCancelled", { [weak self] in self?.handleApprovalCancelled($0) }),
        ]

        for (name, handler) in events {
            let observer = NotificationCenter.default.addObserver(
                forName: NSNotification.Name(name),
                object: nil,
                queue: .main,
                using: handler
            )
            observers.append(observer)
        }
    }

    // MARK: - Event Handlers

    private func handleApprovalRequest(_ notification: Notification) {
        guard let userInfo = notification.userInfo,
              let sessionId = (userInfo["sessionId"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
              let requestId = userInfo["requestId"] as? String,
              let toolName = (userInfo["toolName"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
              let description = (userInfo["description"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) else {
            return
        }

        let toolUseId = (userInfo["toolUseID"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let input = userInfo["input"] as? [String: Any] ?? [:]

        let approval = PendingApproval(
            requestId: requestId,
            sessionId: sessionId,
            toolUseId: toolUseId,
            toolName: toolName,
            input: input,
            description: description,
            timestamp: Date()
        )

        // 存入全局状态
        pendingApprovals[sessionId] = approval

        // 用户不在该 session 页面 → 显示 banner
        if !activeSessionPages.contains(sessionId) && !dismissedBannerIds.contains(requestId) {
            bannerApproval = approval
            bannerResponseState = .awaiting
        }
    }

    private func handleApprovalResolved(_ notification: Notification) {
        guard let userInfo = notification.userInfo,
              let requestId = userInfo["requestId"] as? String else {
            return
        }
        removeApproval(requestId: requestId)
    }

    private func handleApprovalAck(_ notification: Notification) {
        guard let userInfo = notification.userInfo,
              let success = userInfo["success"] as? Bool else {
            return
        }

        if success {
            // ETerm 确认收到 → banner 进入 executing 状态
            if bannerApproval != nil && bannerResponseState == .pendingAck {
                bannerResponseState = .executing
                // 短暂显示 executing 后自动清除
                Task { @MainActor in
                    try? await Task.sleep(nanoseconds: 800_000_000)
                    if self.bannerResponseState == .executing {
                        self.clearBanner()
                        // 同时从 pendingApprovals 中移除
                        if let approval = self.bannerApproval {
                            self.pendingApprovals.removeValue(forKey: approval.sessionId)
                        }
                    }
                }
            }
        } else {
            // ETerm 处理失败 → 清除 banner
            clearBanner()
        }
    }

    private func handleApprovalCancelled(_ notification: Notification) {
        guard let userInfo = notification.userInfo,
              let sessionId = userInfo["sessionId"] as? String else {
            return
        }

        // 移除该 session 的所有 pending approvals
        if let approval = pendingApprovals[sessionId] {
            pendingApprovals.removeValue(forKey: sessionId)
            if bannerApproval?.requestId == approval.requestId {
                clearBanner()
                showNextBanner()
            }
        }
    }

    // MARK: - Approval Removal

    private func removeApproval(requestId: String) {
        // 从 pendingApprovals 中移除
        for (sessionId, approval) in pendingApprovals {
            if approval.requestId == requestId {
                pendingApprovals.removeValue(forKey: sessionId)
                break
            }
        }

        // 清理 banner
        if bannerApproval?.requestId == requestId {
            clearBanner()
            showNextBanner()
        }

        // 清理 dismissed 记录
        dismissedBannerIds.remove(requestId)
    }

    // MARK: - Session Page Lifecycle

    /// SessionDetailView 进入时调用
    func registerSessionPageActive(_ sessionId: String) {
        activeSessionPages.insert(sessionId)

        // 如果 banner 正在显示该 session 的审批，收起 banner（页面内 UI 接管）
        if bannerApproval?.sessionId == sessionId {
            clearBanner()
        }
    }

    /// SessionDetailView 离开时调用
    func registerSessionPageInactive(_ sessionId: String) {
        activeSessionPages.remove(sessionId)

        // 如果该 session 还有 pending 审批，显示 banner
        if let approval = pendingApprovals[sessionId],
           !dismissedBannerIds.contains(approval.requestId) {
            bannerApproval = approval
            bannerResponseState = .awaiting
        }
    }

    // MARK: - Banner Actions

    /// 从 banner 直接发送审批响应
    func sendBannerApprovalResponse(action: String) {
        guard let approval = bannerApproval else { return }

        if action == "n" {
            // 拒绝 → 直接移除
            removeApproval(requestId: approval.requestId)
        } else {
            // 允许（y 或 a）→ 等待 ETerm 确认
            bannerResponseState = .pendingAck
        }

        // 发送 WebSocket 响应
        wsClient.sendApprovalResponse(
            requestId: approval.requestId,
            sessionId: approval.sessionId,
            action: action,
            toolUseId: approval.toolUseId
        )
    }

    /// 用户上滑关闭 banner（不发响应，审批保持 pending）
    func dismissBanner() {
        if let approval = bannerApproval {
            dismissedBannerIds.insert(approval.requestId)
        }
        clearBanner()
        showNextBanner()
    }

    // MARK: - Banner State

    private func clearBanner() {
        bannerApproval = nil
        bannerResponseState = .none
    }

    /// 显示下一个可用的 banner（多 session 同时有 pending 时）
    private func showNextBanner() {
        for (sessionId, approval) in pendingApprovals {
            if !activeSessionPages.contains(sessionId) && !dismissedBannerIds.contains(approval.requestId) {
                bannerApproval = approval
                bannerResponseState = .awaiting
                return
            }
        }
    }

    // MARK: - Public API

    /// 指定 session 的 pending 审批数量（给 SessionRow badge 用）
    func pendingCount(for sessionId: String) -> Int {
        pendingApprovals[sessionId] != nil ? 1 : 0
    }

    /// 同步服务端审批状态（SessionDetailViewModel 进入 session 时调用）
    func syncFromServer(sessionId: String, approvals: [[String: Any]]) {
        guard let dict = approvals.first,
              let requestId = dict["requestId"] as? String,
              let toolName = dict["toolName"] as? String else {
            return
        }

        // 已存在则跳过
        if pendingApprovals[sessionId]?.requestId == requestId { return }

        let approval = PendingApproval(
            requestId: requestId,
            sessionId: sessionId,
            toolUseId: dict["toolUseId"] as? String ?? "",
            toolName: toolName,
            input: dict["input"] as? [String: Any] ?? [:],
            description: dict["description"] as? String ?? toolName,
            timestamp: Date()
        )

        pendingApprovals[sessionId] = approval

        // 不在 session 页面且未被 dismiss 过 → 显示 banner
        if !activeSessionPages.contains(sessionId) && !dismissedBannerIds.contains(requestId) && bannerApproval == nil {
            bannerApproval = approval
            bannerResponseState = .awaiting
        }
    }
}
