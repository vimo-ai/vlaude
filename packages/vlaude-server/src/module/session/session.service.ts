/**
 * @description Session Service - 会话数据管理
 * @author Claude
 * @date 2025/12/31
 * @version v3.0.0
 *
 * V3 架构改进:
 * - 唯一数据源: SharedDbService (ai-cli-session.db)
 * - 移除 Prisma 和 Daemon 依赖
 * - 支持 ContentBlock 结构化解析（用于富文本 UI 渲染）
 */
import { Injectable, Logger } from '@nestjs/common';
import { SharedDbService, SharedSession, SharedMessage } from '../../shared-db/shared-db.service';

// ContentBlock 类型定义（与 Swift ContentBlockParser 对应）
interface TextBlock {
  type: 'text';
  text: string;
}

interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, any>;
  displayText: string;  // 人类可读描述
  iconName: string;     // SF Symbol 名称
}

interface ToolResultBlock {
  type: 'tool_result';
  toolUseId: string;
  isError: boolean;
  content: string;
  preview: string;      // 前 200 字符
  hasMore: boolean;
  sizeDescription: string;
}

interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
}

interface UnknownBlock {
  type: 'unknown';
  raw: string;
}

type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | ThinkingBlock | UnknownBlock;

@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);

  constructor(private readonly sharedDb: SharedDbService) {}

  /**
   * 根据项目路径获取会话列表（分页）
   */
  async getSessionsByProjectPath(projectPath: string, limit = 20, offset = 0) {
    if (!this.sharedDb.isAvailable()) {
      return { sessions: [], total: 0, hasMore: false };
    }

    const project = this.sharedDb.getProjectByPath(projectPath);
    if (!project) {
      return { sessions: [], total: 0, hasMore: false };
    }

    const allSessions = this.sharedDb.getSessionsByProjectId(project.id);
    const total = allSessions.length;
    const sessions = allSessions.slice(offset, offset + limit).map(s => this.mapSession(s));
    const hasMore = offset + sessions.length < total;

    return { sessions, total, hasMore };
  }

  /**
   * 根据项目 ID 获取会话列表
   */
  async getSessionsByProject(projectId: number) {
    if (!this.sharedDb.isAvailable()) {
      return [];
    }

    const sessions = this.sharedDb.getSessionsByProjectId(projectId);
    return sessions.map(s => this.mapSession(s));
  }

  /**
   * 根据 session_id 获取会话
   */
  async getSessionBySessionId(sessionId: string) {
    if (!this.sharedDb.isAvailable()) {
      return null;
    }

    const session = this.sharedDb.getSessionBySessionId(sessionId);
    if (!session) {
      return null;
    }

    return this.mapSession(session);
  }

  /**
   * 根据 ID 获取会话
   */
  async getSessionById(id: number) {
    if (!this.sharedDb.isAvailable()) {
      return null;
    }

    // SharedDb 没有直接通过 id 查询的方法，需要遍历
    // 这里简化处理，实际应该加一个方法
    this.logger.warn(`getSessionById(${id}) 暂不支持，请使用 getSessionBySessionId`);
    return null;
  }

  /**
   * 获取会话消息（分页）
   */
  async getSessionMessages(sessionId: string, limit = 50, offset = 0, order: 'asc' | 'desc' = 'asc') {
    if (!this.sharedDb.isAvailable()) {
      return null;
    }

    const session = this.sharedDb.getSessionBySessionId(sessionId);
    if (!session) {
      return null;
    }

    let messages = this.sharedDb.getMessagesBySessionId(sessionId);
    const total = messages.length;

    if (order === 'desc') {
      messages = messages.reverse();
    }

    messages = messages.slice(offset, offset + limit);
    const hasMore = offset + messages.length < total;

    return {
      messages: messages.map(m => this.mapMessage(m)),
      total,
      hasMore,
    };
  }

  /**
   * 创建会话（不支持，只读数据源）
   */
  async createSession(projectPath: string, prompt?: string, requestId?: string) {
    throw new Error('SharedDb 是只读数据源，不支持创建会话');
  }

  /**
   * 删除会话（不支持，只读数据源）
   */
  async deleteSession(id: number) {
    throw new Error('SharedDb 是只读数据源，不支持删除操作');
  }

  /**
   * 转换会话数据格式
   */
  private mapSession(s: SharedSession) {
    return {
      id: s.id,
      sessionId: s.session_id,
      projectId: s.project_id,
      messageCount: s.message_count,
      // lastMessageAt 可能是 null，需要判断后转换为 ISO8601
      lastMessageAt: s.last_message_at ? new Date(s.last_message_at).toISOString() : null,
      createdAt: new Date(s.created_at).toISOString(),
      updatedAt: new Date(s.updated_at).toISOString(),
    };
  }

  /**
   * 转换消息数据格式
   * 格式兼容 iOS Vlaude Message 模型
   */
  private mapMessage(m: SharedMessage) {
    // 将 Unix 毫秒时间戳转换为 ISO8601 格式
    const timestampISO = new Date(m.timestamp).toISOString();

    // 解析 content_full，可能是 JSON 数组或纯文本
    let parsedContent: any;
    try {
      parsedContent = JSON.parse(m.content_full);
    } catch {
      // 不是 JSON，当作纯文本处理
      parsedContent = m.content_full;
    }

    // 基础消息结构
    const result: any = {
      uuid: m.uuid,
      type: m.type,
      timestamp: timestampISO,
      sessionId: m.session_id,
      sequence: m.sequence,
    };

    // 根据消息类型设置内容
    if (m.type === 'user' || m.type === 'assistant') {
      // user/assistant 消息使用 message 对象
      result.message = {
        role: m.type,
        content: parsedContent,
      };
    } else {
      // system 等其他类型直接使用 content
      result.content = typeof parsedContent === 'string' ? parsedContent : m.content_text;
    }

    // 解析 contentBlocks
    // 优先从 raw 字段解析（完整原始 JSONL）
    // fallback 到 content_full（可能是格式化后的内容）
    const contentBlocks = m.raw
      ? this.parseContentBlocks(m.raw)
      : this.parseContentFromFull(parsedContent);

    if (contentBlocks.length > 0) {
      result.contentBlocks = contentBlocks;
    }

    return result;
  }

  /**
   * 从 content_full 解析 ContentBlocks (fallback)
   * 当 raw 字段为空时使用
   */
  private parseContentFromFull(content: any): ContentBlock[] {
    if (!content) {
      return [];
    }

    // 纯文本
    if (typeof content === 'string') {
      return [{ type: 'text', text: content }];
    }

    // 数组（可能包含 tool_use 等块）
    if (Array.isArray(content)) {
      return content
        .map((block: any) => this.parseBlock(block))
        .filter((b): b is ContentBlock => b !== null);
    }

    return [];
  }

  /**
   * 从 raw JSONL 行解析 ContentBlocks
   */
  private parseContentBlocks(raw: string): ContentBlock[] {
    try {
      const json = JSON.parse(raw);
      const message = json.message;
      if (!message || !message.content) {
        return [];
      }

      const content = message.content;

      // content 可能是字符串或数组
      if (typeof content === 'string') {
        return [{ type: 'text', text: content }];
      }

      if (!Array.isArray(content)) {
        return [];
      }

      return content
        .map((block: any) => this.parseBlock(block))
        .filter((b): b is ContentBlock => b !== null);
    } catch {
      return [];
    }
  }

  /**
   * 解析单个内容块
   */
  private parseBlock(block: any): ContentBlock | null {
    if (!block || typeof block.type !== 'string') {
      return null;
    }

    switch (block.type) {
      case 'text':
        if (typeof block.text === 'string') {
          return { type: 'text', text: block.text };
        }
        break;

      case 'tool_use':
        if (block.id && block.name) {
          const input = block.input || {};
          return {
            type: 'tool_use',
            id: block.id,
            name: block.name,
            input,
            displayText: this.generateToolDisplayText(block.name, input),
            iconName: this.getToolIconName(block.name),
          };
        }
        break;

      case 'tool_result':
        if (block.tool_use_id) {
          const content = this.extractToolResultContent(block.content);
          return {
            type: 'tool_result',
            toolUseId: block.tool_use_id,
            isError: block.is_error ?? false,
            content,
            preview: content.length <= 200 ? content : content.substring(0, 200) + '...',
            hasMore: content.length > 200,
            sizeDescription: this.formatSize(content.length),
          };
        }
        break;

      case 'thinking':
        if (typeof block.thinking === 'string') {
          return { type: 'thinking', thinking: block.thinking };
        }
        break;

      default:
        return { type: 'unknown', raw: JSON.stringify(block) };
    }

    return null;
  }

  /**
   * 生成工具调用的人类可读描述
   */
  private generateToolDisplayText(name: string, input: Record<string, any>): string {
    switch (name) {
      case 'Read':
        if (input.file_path) {
          const fileName = input.file_path.split('/').pop() || input.file_path;
          if (input.limit) {
            return `读取文件: ${fileName} (前 ${input.limit} 行)`;
          }
          return `读取文件: ${fileName}`;
        }
        return '读取文件';

      case 'Write':
        if (input.file_path) {
          const fileName = input.file_path.split('/').pop() || input.file_path;
          return `写入文件: ${fileName}`;
        }
        return '写入文件';

      case 'Edit':
        if (input.file_path) {
          const fileName = input.file_path.split('/').pop() || input.file_path;
          return `编辑文件: ${fileName}`;
        }
        return '编辑文件';

      case 'Bash':
        if (input.command) {
          const preview = input.command.substring(0, 50);
          return `执行命令: ${preview}${input.command.length > 50 ? '...' : ''}`;
        }
        return '执行命令';

      case 'Glob':
        if (input.pattern) {
          return `搜索文件: ${input.pattern}`;
        }
        return '搜索文件';

      case 'Grep':
        if (input.pattern) {
          return `搜索内容: ${input.pattern}`;
        }
        return '搜索内容';

      case 'Task':
        if (input.description) {
          return `子任务: ${input.description}`;
        }
        return '子任务';

      case 'WebFetch':
        if (input.url) {
          return `获取网页: ${input.url}`;
        }
        return '获取网页';

      case 'WebSearch':
        if (input.query) {
          return `搜索: ${input.query}`;
        }
        return '网络搜索';

      default:
        return `工具: ${name}`;
    }
  }

  /**
   * 获取工具图标名称 (SF Symbol)
   */
  private getToolIconName(name: string): string {
    const icons: Record<string, string> = {
      Read: 'doc.text',
      Write: 'square.and.pencil',
      Edit: 'pencil',
      Bash: 'terminal',
      Glob: 'folder.badge.questionmark',
      Grep: 'magnifyingglass',
      Task: 'list.bullet',
      WebFetch: 'globe',
      WebSearch: 'magnifyingglass.circle',
      TodoWrite: 'checklist',
    };
    return icons[name] || 'wrench';
  }

  /**
   * 提取 tool_result 的内容
   */
  private extractToolResultContent(content: any): string {
    if (content === null || content === undefined) {
      return '';
    }
    if (typeof content === 'string') {
      return content;
    }
    try {
      return JSON.stringify(content, null, 2);
    } catch {
      return String(content);
    }
  }

  /**
   * 格式化文件大小
   */
  private formatSize(bytes: number): string {
    if (bytes < 1024) {
      return `${bytes} B`;
    } else if (bytes < 1024 * 1024) {
      return `${(bytes / 1024).toFixed(1)} KB`;
    } else {
      return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    }
  }
}
