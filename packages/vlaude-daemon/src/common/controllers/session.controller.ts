/**
 * @description Session Controller - 处理会话相关操作
 * @author Claude
 * @date 2025/11/16
 * @version v3.0.0
 *
 * V2 新增: 获取会话列表 API（从文件系统读取）
 * V3 新增: 使用 claude-agent-sdk 处理消息（Remote 模式）
 */
import { Controller, Post, Body, Logger, Get, Query, DefaultValuePipe, ParseIntPipe, Inject, forwardRef } from '@nestjs/common';
import { homedir } from 'os';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import { spawn } from 'child_process';
import { DataCollectorService } from '../../module/data-collector/data-collector.service';
import { ServerClientService } from '../../module/server-client/server-client.service';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConfigLoaderService } from '../../module/config-loader/config-loader.service';
import { EtermGateway } from '../../module/eterm-gateway/eterm.gateway';

@Controller('sessions')
export class SessionController {
  private readonly logger = new Logger(SessionController.name);

  constructor(
    private readonly dataCollector: DataCollectorService,
    private readonly serverClient: ServerClientService,
    private readonly eventEmitter: EventEmitter2,
    private readonly configLoader: ConfigLoaderService,
    @Inject(forwardRef(() => EtermGateway))
    private readonly etermGateway: EtermGateway,
  ) {}

  /**
   * 标记当前正在 Remote 模式处理的 session
   * 用于避免 FileWatcher 重复推送
   */
  private remoteModeProcessing = new Set<string>();

  /**
   * 获取会话列表 (从文件系统实时读取)
   * GET /sessions?projectPath=xxx&limit=20
   *
   * @param projectPath 项目路径
   * @param limit 返回的会话数量，默认 20
   * @returns 按最新 mtime 排序的会话列表（只包含轻量级元数据）
   */
  @Get()
  async getSessions(
    @Query('projectPath') projectPath: string,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    try {
      if (!projectPath) {
        return {
          success: false,
          message: '缺少 projectPath 参数',
          data: [],
        };
      }

      this.logger.log(`📋 收到会话列表请求，projectPath=${projectPath}, limit=${limit}`);

      // V2: 从文件系统读取会话（只返回元数据，不读取消息内容）
      const sessions = await this.dataCollector.collectSessions(projectPath, limit);

      // 获取 ETerm 中的 session 列表
      const etermSessions = new Set(this.etermGateway.getEtermSessions());
      const isEtermOnline = this.etermGateway.isEtermOnline();

      // 只返回元数据，不读取消息（交给 Server 端根据 mtime 变化按需读取）
      // V4: 添加 inEterm 字段，标识该 session 是否在 ETerm 中可用
      const sessionsMetadata = sessions.map((s) => ({
        sessionId: s.id,
        projectPath: s.projectPath,
        lastMtime: s.lastUpdated,
        createdAt: s.createdAt,
        lineCount: s.messageCount,
        inEterm: etermSessions.has(s.id),
      }));

      this.logger.log(`✅ 返回 ${sessionsMetadata.length} 个会话，ETerm ${isEtermOnline ? '在线' : '离线'}`);

      return {
        success: true,
        data: sessionsMetadata,
        total: sessionsMetadata.length,
        source: 'filesystem',
        etermOnline: isEtermOnline,
      };
    } catch (error) {
      this.logger.error(`❌ 获取会话列表失败: ${error.message}`);
      return {
        success: false,
        message: error.message,
        data: [],
      };
    }
  }

  /**
   * 接收来自 Server 的消息并使用 SDK 处理（Remote 模式）
   *
   * V3: 使用 claude-agent-sdk 的 query() 方法来处理消息
   * - 自动 resume session
   * - 自动调用 Claude API
   * - 自动写入 transcript
   */
  @Post('send-message')
  async sendMessage(
    @Body() data: { sessionId: string; text: string; projectPath: string; clientId?: string },
  ) {
    const { sessionId, text, projectPath, clientId } = data;

    this.logger.log(`📥 [Remote 模式] 收到消息请求`);
    this.logger.log(`   Session: ${sessionId}`);
    this.logger.log(`   Project: ${projectPath}`);
    this.logger.log(`   Text length: ${text.length}`);

    // 通知 Server：Swift 正在操作，检查是否需要重新进入 remote mode
    try {
      await this.serverClient.notifySwiftActivity(sessionId, projectPath);
    } catch (err) {
      this.logger.warn(`⚠️ 通知 Server Swift 活动失败: ${err.message}`);
    }

    try {
      // V2: 从缓存查找编码目录名
      const encodedDirName = this.dataCollector['getEncodedDirName'](projectPath);

      if (!encodedDirName) {
        this.logger.error(`❌ [发送消息] 未找到项目映射: ${projectPath}`);
        return {
          success: false,
          message: `未找到项目映射: ${projectPath}`,
        };
      }

      const transcriptPath = path.join(
        homedir(),
        '.claude',
        'projects',
        encodedDirName,
        `${sessionId}.jsonl`,
      );

      this.logger.log(`   Transcript path: ${transcriptPath}`);

      // 检查文件是否存在
      try {
        await fsPromises.access(transcriptPath);
      } catch (error) {
        this.logger.error(`❌ [发送消息] Session 文件不存在: ${transcriptPath}`);
        return {
          success: false,
          message: `Session 文件不存在: ${sessionId}`,
        };
      }

      // V3: 使用 SDK 的 query() 方法处理消息
      this.logger.log(`🤖 [SDK] 开始使用 query() 处理消息...`);
      this.logger.log(`   Resume session: ${sessionId}`);
      this.logger.log(`   CWD: ${projectPath}`);

      // 标记进入 Remote 模式处理，临时禁用推送
      this.remoteModeProcessing.add(sessionId);
      this.eventEmitter.emit('session.pausePush', { sessionId });
      this.logger.log(`⏸️  [Remote] 暂停 FileWatcher 推送: ${sessionId}`);

      // 加载完整的 SDK 配置（agents, MCP, hooks 等）
      this.logger.log(`📦 [SDK] 加载配置...`);
      const sdkConfig = await this.configLoader.getFullSdkConfig(projectPath);
      this.logger.log(`   Agents: ${Object.keys(sdkConfig.agents || {}).length} 个`);
      this.logger.log(`   MCP Servers: ${Object.keys(sdkConfig.mcpServers || {}).length} 个`);

      const result = query({
        prompt: text,
        options: {
          resume: sessionId,
          cwd: projectPath,
          // 完整的 SDK 配置
          ...sdkConfig,
          // 权限请求回调
          canUseTool: async (toolName, input, options) => {
            const { toolUseID, signal } = options;

            // 如果没有 clientId，自动拒绝（无法请求权限）
            if (!clientId) {
              this.logger.warn(`⚠️ [权限] 没有 clientId，自动拒绝: ${toolName}`);
              return {
                behavior: 'deny',
                message: '无法请求权限：客户端未连接',
              };
            }

            try {
              // 通过 ServerClient 请求用户权限
              const result = await this.serverClient.requestApproval(
                sessionId,
                clientId,
                toolName,
                input,
                toolUseID,
              );

              if (result.approved) {
                return {
                  behavior: 'allow',
                  updatedInput: input,
                };
              } else {
                return {
                  behavior: 'deny',
                  message: result.reason || '用户拒绝',
                  interrupt: true,
                };
              }
            } catch (error) {
              this.logger.error(`❌ [权限] 请求失败: ${error.message}`);
              return {
                behavior: 'deny',
                message: `权限请求失败: ${error.message}`,
                interrupt: false,
              };
            }
          },
        },
      });

      // 流式处理响应
      let assistantResponse = '';
      let hasResponse = false;
      let lastAssistantMessage: any = null;

      for await (const message of result) {
        if (message.type === 'assistant') {
          hasResponse = true;
          lastAssistantMessage = message;
          this.logger.log(`📨 [SDK] 收到 assistant 消息`);

          // 解析 content
          if (message.message.content) {
            for (const block of message.message.content) {
              if (block.type === 'text') {
                assistantResponse += block.text;
                this.logger.log(`   文本内容: ${block.text.substring(0, 100)}...`);
              } else if (block.type === 'tool_use') {
                this.logger.log(`   工具调用: ${block.name}`);
              }
            }
          }
        } else if (message.type === 'result') {
          this.logger.log(`✅ [SDK] 对话完成，结果: ${message.subtype}`);
          break;
        }
      }

      if (!hasResponse) {
        this.logger.warn(`⚠️ [SDK] 未收到 assistant 响应`);
      }

      // V3: SDK 处理完成后，主动推送 assistant 消息给 iOS
      if (lastAssistantMessage) {
        this.logger.log(`📤 [SDK] 推送 assistant 消息给客户端`);

        // 从 transcript 重新读取最后一条 assistant 消息（确保格式完整）
        const result = await this.dataCollector.getSessionMessages(
          sessionId,
          projectPath,
          1,    // limit: 只要1条
          0,    // offset: 0
          'desc', // order: 倒序，获取最后一条
        );

        if (result?.messages?.[0]) {
          const lastMessage = result.messages[0];
          this.logger.log(`📤 [SDK] 推送完整消息: uuid=${lastMessage.uuid}, type=${lastMessage.type}`);
          await this.serverClient.notifyNewMessage(sessionId, lastMessage);
        } else {
          this.logger.warn(`⚠️ [SDK] 无法从 transcript 读取最后一条消息`);
        }
      }

      // 注意：不在这里恢复 FileWatcher 推送
      // Remote 模式会一直保持暂停状态，直到 CLI 切回 Local 模式
      this.logger.log(`✅ [Remote] 消息处理完成，保持暂停状态`);

      return {
        success: true,
        message: '消息已处理',
        response: assistantResponse,
      };
    } catch (error) {
      this.logger.error(`❌ [发送消息] SDK 处理失败: ${error.message}`, error.stack);

      // 错误时保持暂停状态，等待 CLI 切回 Local 或用户重试
      this.logger.log(`⚠️  [Remote] 处理失败，保持暂停状态`);

      // 通知前端停止 loading
      if (clientId) {
        await this.serverClient.notifySDKError(sessionId, clientId, {
          type: 'sdk_error',
          message: error.message || 'SDK 处理失败',
        });
      }

      return {
        success: false,
        message: `SDK 处理失败: ${error.message}`,
      };
    }
  }

  /**
   * 创建新对话
   * POST /sessions
   *
   * @param projectPath 项目路径
   * @param prompt 可选的初始提示词（默认使用 "Hi"）
   * @returns { sessionId, transcriptPath }
   */
  @Post()
  async createSession(@Body() data: { projectPath: string; prompt?: string }) {
    const { projectPath, prompt } = data;

    this.logger.log(`📝 [创建对话] 收到创建请求`);
    this.logger.log(`   Project: ${projectPath}`);
    this.logger.log(`   Prompt: ${prompt ? `"${prompt.substring(0, 50)}..."` : 'Hi (默认)'}`);

    try {
      // 1. 验证项目路径
      if (!projectPath) {
        return {
          success: false,
          message: '缺少 projectPath 参数',
        };
      }

      // 2. 检查项目是否存在
      try {
        await fsPromises.access(projectPath);
      } catch (error) {
        this.logger.error(`❌ [创建对话] 项目路径不存在: ${projectPath}`);
        return {
          success: false,
          message: `项目路径不存在: ${projectPath}`,
        };
      }

      // 3. 使用 SDK query() 创建新 session
      const result = await this.createSessionWithSDK(projectPath, prompt);

      this.logger.log(`✅ [创建对话] Session 已创建: ${result.sessionId}`);

      return {
        success: true,
        data: result,
      };
    } catch (error) {
      this.logger.error(`❌ [创建对话] 失败: ${error.message}`, error.stack);
      return {
        success: false,
        message: `创建对话失败: ${error.message}`,
      };
    }
  }

  /**
   * 使用 SDK query() 创建新 session
   */
  private async createSessionWithSDK(
    projectPath: string,
    prompt?: string,
  ): Promise<{ sessionId: string; projectPath: string; encodedDirName: string; transcriptPath: string }> {
    // 1. 从 dataCollector 获取编码目录名
    const encodedDirName = this.dataCollector['getEncodedDirName'](projectPath);

    if (!encodedDirName) {
      throw new Error(`未找到项目映射: ${projectPath}`);
    }

    const projectDir = path.join(homedir(), '.claude', 'projects', encodedDirName);

    // 2. 确保项目目录存在
    await fsPromises.mkdir(projectDir, { recursive: true });

    // 3. 记录创建前的 session 文件
    const existingFiles = new Set(
      (await fsPromises.readdir(projectDir))
        .filter(f => f.endsWith('.jsonl'))
    );

    this.logger.log(`   现有 session 数量: ${existingFiles.size}`);
    this.logger.log(`🤖 [创建对话] 使用 SDK query() 创建 session...`);

    // 4. 加载完整的 SDK 配置
    const sdkConfig = await this.configLoader.getFullSdkConfig(projectPath);
    this.logger.log(`   Agents: ${Object.keys(sdkConfig.agents || {}).length} 个`);
    this.logger.log(`   MCP Servers: ${Object.keys(sdkConfig.mcpServers || {}).length} 个`);

    // 5. 使用 SDK query() 发送初始消息创建 session
    const actualPrompt = prompt || 'Hi';
    const result = query({
      prompt: actualPrompt,
      options: {
        cwd: projectPath,
        ...sdkConfig,
      },
    });

    // 5. 等待 SDK 完成（消费所有消息）
    for await (const message of result) {
      if (message.type === 'assistant') {
        this.logger.log(`   收到 assistant 响应`);
      } else if (message.type === 'result') {
        this.logger.log(`   对话完成: ${message.subtype}`);
        break;
      }
    }

    // 6. 检测新创建的 session 文件
    await new Promise(r => setTimeout(r, 500)); // 等待文件写入
    const newFiles = (await fsPromises.readdir(projectDir))
      .filter(f => f.endsWith('.jsonl') && !existingFiles.has(f));

    if (newFiles.length === 0) {
      throw new Error('未检测到新 session 文件');
    }

    const sessionId = path.basename(newFiles[0], '.jsonl');
    const transcriptPath = path.join(projectDir, newFiles[0]);

    this.logger.log(`   检测到新 session: ${sessionId}`);

    return {
      sessionId,
      projectPath,
      encodedDirName,
      transcriptPath,
    };
  }

  /**
   * 测试：使用 SDK query() 创建新 session
   * POST /sessions/test-sdk-create
   */
  @Post('test-sdk-create')
  async testSdkCreateSession(@Body() data: { projectPath: string }) {
    const { projectPath } = data;

    this.logger.log(`🧪 [测试] 使用 SDK 创建 session`);
    this.logger.log(`   Project: ${projectPath}`);

    try {
      // 1. 验证项目路径
      if (!projectPath) {
        return {
          success: false,
          message: '缺少 projectPath 参数',
        };
      }

      // 2. 检查项目是否存在
      try {
        await fsPromises.access(projectPath);
      } catch (error) {
        this.logger.error(`❌ [测试] 项目路径不存在: ${projectPath}`);
        return {
          success: false,
          message: `项目路径不存在: ${projectPath}`,
        };
      }

      // 3. 从 dataCollector 获取编码目录名
      const encodedDirName = this.dataCollector['getEncodedDirName'](projectPath);

      if (!encodedDirName) {
        this.logger.error(`❌ [测试] 未找到项目映射: ${projectPath}`);
        return {
          success: false,
          message: `未找到项目映射，请先访问该项目的 session 列表以建立映射`,
        };
      }

      const projectDir = path.join(homedir(), '.claude', 'projects', encodedDirName);

      // 4. 确保项目目录存在
      await fsPromises.mkdir(projectDir, { recursive: true });

      // 5. 记录创建前的 session 文件
      const existingFiles = new Set(
        (await fsPromises.readdir(projectDir))
          .filter(f => f.endsWith('.jsonl'))
      );

      this.logger.log(`   现有 session 数量: ${existingFiles.size}`);
      this.logger.log(`🤖 [测试] 调用 SDK query() 创建 session...`);

      // 6. 加载完整的 SDK 配置
      const sdkConfig = await this.configLoader.getFullSdkConfig(projectPath);
      this.logger.log(`   Agents: ${Object.keys(sdkConfig.agents || {}).length} 个`);
      this.logger.log(`   MCP Servers: ${Object.keys(sdkConfig.mcpServers || {}).length} 个`);

      // 7. 使用 SDK query() 发送一个初始消息来创建 session
      const result = query({
        prompt: 'Hi',
        options: {
          cwd: projectPath,
          ...sdkConfig,
        },
      });

      // 7. 监听 SDK 响应，获取 session 信息
      let sessionId: string | null = null;
      let hasResponse = false;

      for await (const message of result) {
        this.logger.log(`   SDK 消息类型: ${message.type}`);

        if (message.type === 'assistant') {
          hasResponse = true;
          this.logger.log(`   收到 assistant 响应`);
        } else if (message.type === 'result') {
          this.logger.log(`   对话完成: ${message.subtype}`);
          break;
        }
      }

      // 8. 检测新创建的 session 文件
      await new Promise(r => setTimeout(r, 500)); // 等待文件写入
      const newFiles = (await fsPromises.readdir(projectDir))
        .filter(f => f.endsWith('.jsonl') && !existingFiles.has(f));

      if (newFiles.length > 0) {
        sessionId = path.basename(newFiles[0], '.jsonl');
        this.logger.log(`✅ [测试] 检测到新 session: ${sessionId}`);
      } else {
        this.logger.warn(`⚠️ [测试] 未检测到新 session 文件`);
      }

      const transcriptPath = sessionId
        ? path.join(projectDir, `${sessionId}.jsonl`)
        : null;

      return {
        success: true,
        data: {
          sessionId,
          projectPath,
          encodedDirName,
          transcriptPath,
          hasResponse,
        },
      };
    } catch (error) {
      this.logger.error(`❌ [测试] 失败: ${error.message}`, error.stack);
      return {
        success: false,
        message: `测试失败: ${error.message}`,
      };
    }
  }

  /**
   * 检查 session 是否在 loading 状态
   * POST /sessions/check-loading
   *
   * @param sessionId 会话 ID
   * @param projectPath 项目路径
   * @returns { loading: boolean }
   */
  @Post('check-loading')
  async checkLoading(@Body() data: { sessionId: string; projectPath: string }) {
    try {
      const { sessionId, projectPath } = data;
      this.logger.log(`[检查Loading] sessionId=${sessionId}, projectPath=${projectPath}`);

      const loading = await this.dataCollector.isSessionLoading(sessionId, projectPath);

      this.logger.log(`[检查Loading] 结果: ${loading ? '正在 loading' : '空闲'}`);

      return {
        success: true,
        loading,
      };
    } catch (error) {
      this.logger.error(`[检查Loading] 失败: ${error.message}`);
      return {
        success: false,
        loading: false, // 出错时默认认为不在 loading
        message: error.message,
      };
    }
  }

}
