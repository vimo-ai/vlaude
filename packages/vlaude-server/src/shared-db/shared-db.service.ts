/**
 * @description SharedDb 服务 - 直接读取 Claude 的 SQLite 数据库
 * @author Claude Code
 * @date 2025-12-30
 * @version v1.0.0
 *
 * 路径: ~/.vimo/db/claude-session.db
 *
 * 表结构:
 * - projects: 项目列表 (id, path, name, source, created_at, updated_at)
 * - sessions: 会话列表 (id, session_id, project_id, message_count, last_message_at, created_at, updated_at)
 * - messages: 消息列表 (id, session_id, uuid, role, content, timestamp, sequence)
 */

import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import Database from 'better-sqlite3';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

// SharedDb 数据类型
export interface SharedProject {
  id: number;
  path: string;
  name: string;
  source: string;
  created_at: number;
  updated_at: number;
}

export interface SharedSession {
  id: number;
  session_id: string;
  project_id: number;
  message_count: number;
  last_message_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface SharedMessage {
  id: number;
  session_id: string;
  uuid: string;
  type: string;  // 'user' | 'assistant' | 'system' 等
  content_text: string;    // 纯文本内容（用于向量化）
  content_full: string;    // 完整内容（包含 tool_use 等）
  timestamp: number;
  sequence: number;
  raw?: string;  // 原始 JSON 数据
}

// 带项目信息的会话
export interface SessionWithProject extends SharedSession {
  project_path: string;
  project_name: string;
}

@Injectable()
export class SharedDbService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SharedDbService.name);
  private db: Database.Database | null = null;
  private dbPath: string;
  private available = false;

  constructor() {
    this.dbPath = path.join(os.homedir(), '.vimo', 'db', 'ai-cli-session.db');
  }

  onModuleInit() {
    this.tryConnect();
  }

  onModuleDestroy() {
    this.close();
  }

  /**
   * 尝试连接数据库
   */
  private tryConnect(): boolean {
    if (this.db) {
      return true;
    }

    if (!fs.existsSync(this.dbPath)) {
      this.logger.warn(`SharedDb 不存在: ${this.dbPath}`);
      this.available = false;
      return false;
    }

    try {
      this.db = new Database(this.dbPath, { readonly: true });
      this.available = true;
      this.logger.log(`SharedDb 连接成功: ${this.dbPath}`);
      return true;
    } catch (error) {
      this.logger.error(`SharedDb 连接失败: ${error}`);
      this.available = false;
      return false;
    }
  }

  /**
   * 关闭数据库连接
   */
  private close() {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.available = false;
      this.logger.log('SharedDb 连接已关闭');
    }
  }

  /**
   * 检查 SharedDb 是否可用
   */
  isAvailable(): boolean {
    if (this.available && this.db) {
      return true;
    }
    // 尝试重新连接
    return this.tryConnect();
  }

  /**
   * 确保数据库连接可用
   */
  private ensureConnection(): Database.Database {
    if (!this.isAvailable() || !this.db) {
      throw new Error('SharedDb 不可用');
    }
    return this.db;
  }

  // ===================== Projects =====================

  /**
   * 获取所有项目（分页）
   */
  getAllProjects(limit = 10, offset = 0): { projects: SharedProject[]; total: number } {
    const db = this.ensureConnection();

    const countStmt = db.prepare('SELECT COUNT(*) as total FROM projects');
    const { total } = countStmt.get() as { total: number };

    const stmt = db.prepare('SELECT * FROM projects ORDER BY updated_at DESC LIMIT ? OFFSET ?');
    const projects = stmt.all(limit, offset) as SharedProject[];

    return { projects, total };
  }

  /**
   * 根据路径获取项目
   */
  getProjectByPath(projectPath: string): SharedProject | null {
    const db = this.ensureConnection();
    const stmt = db.prepare('SELECT * FROM projects WHERE path = ?');
    return (stmt.get(projectPath) as SharedProject) || null;
  }

  /**
   * 根据 ID 获取项目
   */
  getProjectById(id: number): SharedProject | null {
    const db = this.ensureConnection();
    const stmt = db.prepare('SELECT * FROM projects WHERE id = ?');
    return (stmt.get(id) as SharedProject) || null;
  }

  // ===================== Sessions =====================

  /**
   * 获取项目的所有会话
   */
  getSessionsByProjectId(projectId: number): SharedSession[] {
    const db = this.ensureConnection();
    const stmt = db.prepare('SELECT * FROM sessions WHERE project_id = ? ORDER BY updated_at DESC');
    return stmt.all(projectId) as SharedSession[];
  }

  /**
   * 获取项目的所有会话（通过项目路径）
   */
  getSessionsByProjectPath(projectPath: string): SessionWithProject[] {
    const db = this.ensureConnection();
    const stmt = db.prepare(`
      SELECT s.*, p.path as project_path, p.name as project_name
      FROM sessions s
      JOIN projects p ON s.project_id = p.id
      WHERE p.path = ?
      ORDER BY s.updated_at DESC
    `);
    return stmt.all(projectPath) as SessionWithProject[];
  }

  /**
   * 根据 session_id 获取会话
   */
  getSessionBySessionId(sessionId: string): SharedSession | null {
    const db = this.ensureConnection();
    const stmt = db.prepare('SELECT * FROM sessions WHERE session_id = ?');
    return (stmt.get(sessionId) as SharedSession) || null;
  }

  /**
   * 获取最近更新的会话列表
   */
  getRecentSessions(limit = 50): SessionWithProject[] {
    const db = this.ensureConnection();
    const stmt = db.prepare(`
      SELECT s.*, p.path as project_path, p.name as project_name
      FROM sessions s
      JOIN projects p ON s.project_id = p.id
      ORDER BY s.updated_at DESC
      LIMIT ?
    `);
    return stmt.all(limit) as SessionWithProject[];
  }

  // ===================== Messages =====================

  /**
   * 获取会话的所有消息
   */
  getMessagesBySessionId(sessionId: string): SharedMessage[] {
    const db = this.ensureConnection();
    const stmt = db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY sequence ASC');
    return stmt.all(sessionId) as SharedMessage[];
  }

  /**
   * 获取会话的消息数量
   */
  getMessageCount(sessionId: string): number {
    const db = this.ensureConnection();
    const stmt = db.prepare('SELECT COUNT(*) as count FROM messages WHERE session_id = ?');
    const result = stmt.get(sessionId) as { count: number };
    return result.count;
  }

  /**
   * 获取会话的最后一条消息
   */
  getLastMessage(sessionId: string): SharedMessage | null {
    const db = this.ensureConnection();
    const stmt = db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY sequence DESC LIMIT 1');
    return (stmt.get(sessionId) as SharedMessage) || null;
  }

  /**
   * 搜索消息内容 (使用 FTS5)
   */
  searchMessages(query: string, limit = 100): SharedMessage[] {
    const db = this.ensureConnection();
    const stmt = db.prepare(`
      SELECT m.*
      FROM messages m
      JOIN messages_fts fts ON m.id = fts.rowid
      WHERE messages_fts MATCH ?
      ORDER BY m.timestamp DESC
      LIMIT ?
    `);
    return stmt.all(query, limit) as SharedMessage[];
  }

  // ===================== 聚合查询 =====================

  /**
   * 获取项目统计信息
   */
  getProjectStats(projectId: number): {
    sessionCount: number;
    messageCount: number;
    lastActivity: number | null;
  } {
    const db = this.ensureConnection();

    const sessionStmt = db.prepare('SELECT COUNT(*) as count FROM sessions WHERE project_id = ?');
    const sessionResult = sessionStmt.get(projectId) as { count: number };

    const messageStmt = db.prepare(`
      SELECT COUNT(*) as count
      FROM messages m
      JOIN sessions s ON m.session_id = s.session_id
      WHERE s.project_id = ?
    `);
    const messageResult = messageStmt.get(projectId) as { count: number };

    const lastActivityStmt = db.prepare('SELECT MAX(updated_at) as last FROM sessions WHERE project_id = ?');
    const lastActivityResult = lastActivityStmt.get(projectId) as { last: number | null };

    return {
      sessionCount: sessionResult.count,
      messageCount: messageResult.count,
      lastActivity: lastActivityResult.last,
    };
  }

  /**
   * 获取全局统计信息
   */
  getGlobalStats(): {
    projectCount: number;
    sessionCount: number;
    messageCount: number;
  } {
    const db = this.ensureConnection();

    const projectStmt = db.prepare('SELECT COUNT(*) as count FROM projects');
    const sessionStmt = db.prepare('SELECT COUNT(*) as count FROM sessions');
    const messageStmt = db.prepare('SELECT COUNT(*) as count FROM messages');

    return {
      projectCount: (projectStmt.get() as { count: number }).count,
      sessionCount: (sessionStmt.get() as { count: number }).count,
      messageCount: (messageStmt.get() as { count: number }).count,
    };
  }
}
