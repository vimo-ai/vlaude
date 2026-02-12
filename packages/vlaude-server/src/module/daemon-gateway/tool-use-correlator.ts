import { Logger } from '@nestjs/common';

/**
 * ToolUseCorrelator
 *
 * 关联 PreToolUse 和 PermissionRequest 事件，补全 toolUseId。
 *
 * Claude Code 工具调用生命周期：
 *   PreToolUse       ← tool_name ✅  tool_use_id ✅
 *     ↓ (紧邻, <1ms)
 *   PermissionRequest ← tool_name ✅  tool_use_id ❌  (API by design 不提供)
 *     ↓ (用户审批后)
 *   PostToolUse      ← tool_name ✅  tool_use_id ✅
 *
 * 严谨性保证：
 * - tool_name 必须匹配（防止误关联）
 * - 5s 时间窗口（防止过期关联）
 * - 一次性消费（resolve 后删除，防止重复关联）
 * - sessionEnd 兜底清理（防止内存泄漏）
 */
export class ToolUseCorrelator {
  private readonly logger = new Logger(ToolUseCorrelator.name);

  // sessionId → 最近一次 PreToolUse 上下文
  private pending = new Map<string, {
    toolUseId: string;
    toolName: string;
    timestamp: number;
  }>();

  private static readonly TIMEOUT_MS = 5000;

  /** PreToolUse 到达时缓存 */
  onPreToolUse(sessionId: string, toolUseId: string, toolName: string): void {
    this.pending.set(sessionId, {
      toolUseId,
      toolName,
      timestamp: Date.now(),
    });
  }

  /** PermissionRequest 到达时关联 toolUseId */
  resolveToolUseId(sessionId: string, toolName: string): string | null {
    const ctx = this.pending.get(sessionId);
    if (!ctx) {
      this.logger.warn(`[Correlator] 无缓存: session=${sessionId.substring(0, 8)} tool=${toolName}`);
      return null;
    }

    // 校验 tool_name 匹配 + 5s 时间窗口
    if (ctx.toolName !== toolName || Date.now() - ctx.timestamp > ToolUseCorrelator.TIMEOUT_MS) {
      this.logger.warn(`[Correlator] 关联失败: session=${sessionId.substring(0, 8)} ` +
        `expected=${ctx.toolName} got=${toolName} age=${Date.now() - ctx.timestamp}ms`);
      this.pending.delete(sessionId);
      return null;
    }

    // 一次性消费
    this.pending.delete(sessionId);
    this.logger.log(`[Correlator] 关联成功: session=${sessionId.substring(0, 8)} ` +
      `tool=${toolName} toolUseId=${ctx.toolUseId.substring(0, 8)}`);
    return ctx.toolUseId;
  }

  /** 清理指定 session 的缓存 */
  cleanup(sessionId: string): void {
    this.pending.delete(sessionId);
  }
}
