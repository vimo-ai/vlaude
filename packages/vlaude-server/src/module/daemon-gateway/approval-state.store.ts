/**
 * 审批状态存储
 *
 * 管理 PermissionRequest 的生命周期状态，支持：
 * - iOS 进入 session 时查询当前 pending approvals
 * - Session 结束时清理
 * - Cancel 事件时更新状态
 *
 * 类似 ToolUseCorrelator，是纯内存存储类，非 NestJS Injectable
 */

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'timeout' | 'expired' | 'cancelled';

export interface ApprovalState {
  requestId: string;
  sessionId: string;
  toolName: string;
  toolUseId: string;
  input: any;
  description: string;
  status: ApprovalStatus;
  createdAt: number;
  resolvedAt?: number;
}

export class ApprovalStateStore {
  // sessionId → Map<toolUseId|requestId, ApprovalState>
  // 用 requestId 作为 fallback key（toolUseId 可能为空）
  private approvals = new Map<string, Map<string, ApprovalState>>();

  /**
   * 收到 PermissionRequest 时存储
   */
  onApprovalRequest(data: {
    requestId: string;
    sessionId: string;
    toolName: string;
    toolUseId: string;
    input: any;
    description: string;
  }): void {
    const { sessionId, requestId, toolUseId } = data;

    if (!this.approvals.has(sessionId)) {
      this.approvals.set(sessionId, new Map());
    }

    const sessionApprovals = this.approvals.get(sessionId)!;
    const key = toolUseId?.trim() || requestId;

    sessionApprovals.set(key, {
      requestId,
      sessionId,
      toolName: data.toolName,
      toolUseId: toolUseId || '',
      input: data.input,
      description: data.description,
      status: 'pending',
      createdAt: Date.now(),
    });
  }

  /**
   * 审批被解决（approved/rejected/timeout/expired）
   */
  onApprovalResolved(sessionId: string, identifier: { toolUseId?: string; requestId?: string }, status: ApprovalStatus): void {
    const sessionApprovals = this.approvals.get(sessionId);
    if (!sessionApprovals) return;

    // 先尝试 toolUseId，再尝试 requestId
    const key = this.findKey(sessionApprovals, identifier);
    if (!key) return;

    const approval = sessionApprovals.get(key);
    if (approval) {
      approval.status = status;
      approval.resolvedAt = Date.now();
    }
  }

  /**
   * 获取指定 session 的所有 pending approvals
   */
  getPendingApprovals(sessionId: string): ApprovalState[] {
    const sessionApprovals = this.approvals.get(sessionId);
    if (!sessionApprovals) return [];

    return Array.from(sessionApprovals.values()).filter(a => a.status === 'pending');
  }

  /**
   * 取消指定 session 的所有 pending approvals
   * @returns 被取消的审批列表
   */
  cancelSession(sessionId: string): ApprovalState[] {
    const sessionApprovals = this.approvals.get(sessionId);
    if (!sessionApprovals) return [];

    const cancelled: ApprovalState[] = [];
    for (const approval of sessionApprovals.values()) {
      if (approval.status === 'pending') {
        approval.status = 'cancelled';
        approval.resolvedAt = Date.now();
        cancelled.push({ ...approval });
      }
    }

    return cancelled;
  }

  /**
   * Session 结束时清理
   */
  cleanup(sessionId: string): void {
    this.approvals.delete(sessionId);
  }

  /**
   * 查找 Map 中的 key（先 toolUseId，再 requestId）
   */
  private findKey(map: Map<string, ApprovalState>, identifier: { toolUseId?: string; requestId?: string }): string | null {
    if (identifier.toolUseId?.trim() && map.has(identifier.toolUseId)) {
      return identifier.toolUseId;
    }
    if (identifier.requestId && map.has(identifier.requestId)) {
      return identifier.requestId;
    }
    // 遍历查找 requestId 匹配
    if (identifier.requestId) {
      for (const [key, approval] of map) {
        if (approval.requestId === identifier.requestId) {
          return key;
        }
      }
    }
    return null;
  }
}
