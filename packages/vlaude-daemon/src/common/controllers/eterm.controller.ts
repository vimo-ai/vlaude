/**
 * @description ETerm Controller - ETerm 状态查询
 * @author Claude
 * @date 2025/12/08
 * @version v1.0.0
 */
import { Controller, Get, Query, Logger, Inject, forwardRef } from '@nestjs/common';
import { EtermGateway } from '../../module/eterm-gateway/eterm.gateway';

@Controller('eterm')
export class EtermController {
  private readonly logger = new Logger(EtermController.name);

  constructor(
    @Inject(forwardRef(() => EtermGateway))
    private readonly etermGateway: EtermGateway,
  ) {}

  /**
   * 获取 ETerm 状态
   * GET /eterm/status
   *
   * @returns { online: boolean, sessions: string[] }
   */
  @Get('status')
  getStatus() {
    const online = this.etermGateway.isEtermOnline();
    const sessions = this.etermGateway.getEtermSessions();

    this.logger.log(`📊 ETerm 状态查询: ${online ? '在线' : '离线'}, ${sessions.length} 个 session`);

    return {
      success: true,
      data: {
        online,
        sessions,
        sessionCount: sessions.length,
      },
    };
  }

  /**
   * 检查指定 session 是否在 ETerm 中
   * GET /eterm/check?sessionId=xxx
   *
   * @param sessionId 会话 ID
   * @returns { inEterm: boolean, terminalId?: number }
   */
  @Get('check')
  checkSession(@Query('sessionId') sessionId: string) {
    if (!sessionId) {
      return {
        success: false,
        message: '缺少 sessionId 参数',
      };
    }

    const inEterm = this.etermGateway.isSessionInEterm(sessionId);
    const terminalId = this.etermGateway.getTerminalId(sessionId);

    this.logger.log(`🔍 检查 session ${sessionId}: ${inEterm ? `在 ETerm (Terminal ${terminalId})` : '不在 ETerm'}`);

    return {
      success: true,
      data: {
        sessionId,
        inEterm,
        terminalId: inEterm ? terminalId : undefined,
      },
    };
  }
}
