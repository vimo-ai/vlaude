/**
 * @description 文件监听服务 - 实现三层监听机制
 * @author Claude
 * @date 2025/11/16
 * @version v2.0.0
 *
 * 监听生命周期:
 * 1. 项目列表页 → 监听 ~/.claude/projects/ 所有 .jsonl 的 mtime
 * 2. 会话列表页 → 监听某个项目下所有 .jsonl 的 mtime
 * 3. 会话详情页 → 监听单个 .jsonl 文件并增量解析
 */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { ServerClientService } from '../server-client/server-client.service';

/**
 * 监听模式
 */
export enum WatchMode {
  PROJECT_LIST = 'project-list',    // 监听项目列表
  SESSION_LIST = 'session-list',    // 监听会话列表
  SESSION_DETAIL = 'session-detail', // 监听会话详情
  NONE = 'none',                     // 不监听
}

/**
 * 监听器信息
 */
interface WatcherInfo {
  watcher: fs.FSWatcher;
  mode: WatchMode;
  target?: string; // projectPath 或 sessionId
}

@Injectable()
export class FileWatcherService implements OnModuleInit {
  private readonly logger = new Logger(FileWatcherService.name);

  private readonly claudeProjectsPath = path.join(
    process.env.HOME || '~',
    '.claude',
    'projects',
  );

  // 当前监听器
  private currentWatcher: WatcherInfo | null = null;

  // 当前监听模式
  private currentMode: WatchMode = WatchMode.NONE;

  constructor(private readonly serverClient: ServerClientService) {}

  async onModuleInit() {
    this.logger.log('📁 FileWatcherService 初始化完成');
    this.logger.log(`📂 Claude Projects 路径: ${this.claudeProjectsPath}`);
  }

  /**
   * 切换监听模式
   */
  async switchWatchMode(mode: WatchMode, target?: string) {
    this.logger.log(`🔄 切换监听模式: ${this.currentMode} → ${mode}`);

    if (target) {
      this.logger.log(`   目标: ${target}`);
    }

    // 停止当前监听
    this.stopCurrentWatcher();

    // 启动新监听
    switch (mode) {
      case WatchMode.PROJECT_LIST:
        await this.watchProjectList();
        break;
      case WatchMode.SESSION_LIST:
        if (!target) {
          this.logger.error('❌ SESSION_LIST 模式需要提供 projectPath');
          return;
        }
        await this.watchSessionList(target);
        break;
      case WatchMode.SESSION_DETAIL:
        if (!target) {
          this.logger.error('❌ SESSION_DETAIL 模式需要提供 sessionId,projectPath');
          return;
        }
        const [sessionId, projectPath] = target.split('|');
        await this.watchSessionDetail(sessionId, projectPath);
        break;
      case WatchMode.NONE:
        this.logger.log('🛑 停止所有监听');
        break;
    }

    this.currentMode = mode;
  }

  /**
   * 监听 1: 项目列表 (监听 ~/.claude/projects/ 所有 .jsonl)
   */
  private async watchProjectList() {
    try {
      this.logger.log('👀 开始监听项目列表');

      const watcher = fs.watch(
        this.claudeProjectsPath,
        { recursive: true },
        async (eventType, filename) => {
          if (!filename || !filename.endsWith('.jsonl')) {
            return;
          }

          this.logger.log(`📝 [项目列表变化] ${eventType} - ${filename}`);

          const projectDirName = filename.split(path.sep)[0];
          const projectPath = this.decodeProjectPath(projectDirName);

          if (eventType === 'rename') {
            const fullPath = path.join(this.claudeProjectsPath, filename);
            if (fs.existsSync(fullPath)) {
              // 新建或恢复文件
              await this.handleSessionCreated(projectPath, filename);
            } else {
              // 删除文件
              await this.handleSessionDeleted(projectPath, filename);
            }
          } else if (eventType === 'change') {
            // 文件内容变化
            await this.handleSessionUpdated(projectPath, filename);
          }

          // 通知 Server 更新项目列表
          await this.notifyProjectListUpdate();
        },
      );

      this.currentWatcher = {
        watcher,
        mode: WatchMode.PROJECT_LIST,
      };

      this.logger.log('✅ 项目列表监听已启动');
    } catch (error) {
      this.logger.error(`❌ 启动项目列表监听失败: ${error.message}`);
    }
  }

  /**
   * 监听 2: 会话列表 (监听某个项目下所有 .jsonl)
   */
  private async watchSessionList(projectPath: string) {
    try {
      const encodedProjectName = this.encodeProjectPath(projectPath);
      const projectDir = path.join(this.claudeProjectsPath, encodedProjectName);

      if (!fs.existsSync(projectDir)) {
        this.logger.warn(`⚠️ 项目目录不存在: ${projectDir}`);
        return;
      }

      this.logger.log(`👀 开始监听会话列表: ${projectPath}`);

      const watcher = fs.watch(projectDir, async (eventType, filename) => {
        if (!filename || !filename.endsWith('.jsonl')) {
          return;
        }

        this.logger.log(`📝 [会话列表变化] ${eventType} - ${filename}`);

        if (eventType === 'rename') {
          const fullPath = path.join(projectDir, filename);
          if (fs.existsSync(fullPath)) {
            await this.handleSessionCreated(projectPath, filename);
          } else {
            await this.handleSessionDeleted(projectPath, filename);
          }
        } else if (eventType === 'change') {
          await this.handleSessionUpdated(projectPath, filename);
        }

        // 通知 Server 更新会话列表
        await this.notifySessionListUpdate(projectPath);
      });

      this.currentWatcher = {
        watcher,
        mode: WatchMode.SESSION_LIST,
        target: projectPath,
      };

      this.logger.log('✅ 会话列表监听已启动');
    } catch (error) {
      this.logger.error(`❌ 启动会话列表监听失败: ${error.message}`);
    }
  }

  /**
   * 监听 3: 会话详情 (监听单个 .jsonl 文件)
   */
  private async watchSessionDetail(sessionId: string, projectPath: string) {
    try {
      const encodedProjectName = this.encodeProjectPath(projectPath);
      const sessionFilePath = path.join(
        this.claudeProjectsPath,
        encodedProjectName,
        `${sessionId}.jsonl`,
      );

      if (!fs.existsSync(sessionFilePath)) {
        this.logger.warn(`⚠️ 会话文件不存在: ${sessionFilePath}`);
        return;
      }

      this.logger.log(`👀 开始监听会话详情: ${sessionId}`);

      const watcher = fs.watch(sessionFilePath, async (eventType) => {
        if (eventType === 'change') {
          this.logger.log(`📝 [会话详情变化] ${sessionId}`);

          // 通知 Server 增量解析并推送新消息
          await this.notifySessionDetailUpdate(sessionId, projectPath);
        }
      });

      this.currentWatcher = {
        watcher,
        mode: WatchMode.SESSION_DETAIL,
        target: `${sessionId}|${projectPath}`,
      };

      this.logger.log('✅ 会话详情监听已启动');
    } catch (error) {
      this.logger.error(`❌ 启动会话详情监听失败: ${error.message}`);
    }
  }

  /**
   * 停止当前监听器
   */
  private stopCurrentWatcher() {
    if (this.currentWatcher) {
      this.logger.log(`🛑 停止监听: ${this.currentWatcher.mode}`);
      this.currentWatcher.watcher.close();
      this.currentWatcher = null;
    }
  }

  /**
   * 处理会话文件创建/恢复
   */
  private async handleSessionCreated(projectPath: string, filename: string) {
    const sessionId = path.basename(filename, '.jsonl');
    this.logger.log(`🆕 会话文件创建/恢复: ${sessionId}`);

    // 检查是否是恢复已删除的会话
    await this.serverClient.notifySessionRestored(sessionId, projectPath);
  }

  /**
   * 处理会话文件删除
   */
  private async handleSessionDeleted(projectPath: string, filename: string) {
    const sessionId = path.basename(filename, '.jsonl');
    this.logger.log(`🗑️ 会话文件删除: ${sessionId}`);

    // 软删除标记
    await this.serverClient.notifySessionDeleted(sessionId, projectPath);
  }

  /**
   * 处理会话文件更新
   */
  private async handleSessionUpdated(projectPath: string, filename: string) {
    const sessionId = path.basename(filename, '.jsonl');
    this.logger.log(`🔄 会话文件更新: ${sessionId}`);

    // 增量解析会在 notifySessionDetailUpdate 中处理
  }

  /**
   * 通知 Server 项目列表更新
   */
  private async notifyProjectListUpdate() {
    try {
      await this.serverClient.notifyProjectListUpdate();
    } catch (error) {
      this.logger.error(`❌ 通知项目列表更新失败: ${error.message}`);
    }
  }

  /**
   * 通知 Server 会话列表更新
   */
  private async notifySessionListUpdate(projectPath: string) {
    try {
      await this.serverClient.notifySessionListUpdate(projectPath);
    } catch (error) {
      this.logger.error(`❌ 通知会话列表更新失败: ${error.message}`);
    }
  }

  /**
   * 通知 Server 会话详情更新 (增量解析)
   */
  private async notifySessionDetailUpdate(sessionId: string, projectPath: string) {
    try {
      await this.serverClient.notifySessionDetailUpdate(sessionId, projectPath);
    } catch (error) {
      this.logger.error(`❌ 通知会话详情更新失败: ${error.message}`);
    }
  }

  /**
   * 编码项目路径
   */
  private encodeProjectPath(realPath: string): string {
    return '-' + realPath.replace(/^\//, '').replace(/\//g, '-');
  }

  /**
   * 解码项目路径
   */
  private decodeProjectPath(encodedName: string): string {
    return '/' + encodedName.replace(/^-/, '').replace(/-/g, '/');
  }

  /**
   * 获取当前监听状态
   */
  getCurrentWatchStatus() {
    return {
      mode: this.currentMode,
      target: this.currentWatcher?.target,
    };
  }
}
