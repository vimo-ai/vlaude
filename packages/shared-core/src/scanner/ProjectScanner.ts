/**
 * Claude Code 项目扫描器
 * 纯函数，不依赖 NestJS
 */
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import { extractProjectPath } from '../parser/JsonlParser';
import { getEncodedPrefix } from '../codec/PathCodec';
import {
  isValidSessionFile,
  extractSessionId,
  countFileLines,
  isSummaryFile,
} from './SessionReader';

/**
 * Claude 项目信息
 */
export interface ClaudeProjectInfo {
  name: string;
  path: string;
  encodedDirName: string;
  lastAccessed: Date;
  sessions: string[];
}

/**
 * Claude 会话元信息
 */
export interface ClaudeSessionMeta {
  id: string;
  projectPath: string;
  createdAt: Date;
  lastUpdated: Date;
  messageCount: number;
}

/**
 * 扫描 Claude Code 项目目录
 * @param claudeProjectsPath Claude projects 目录路径（如 ~/.claude/projects）
 * @param limit 返回项目数量，不传则返回全部
 * @returns 按最新 session mtime 排序的项目列表
 */
export async function scanProjects(
  claudeProjectsPath: string,
  limit?: number,
): Promise<ClaudeProjectInfo[]> {
  // 检查目录是否存在
  try {
    await fsPromises.access(claudeProjectsPath);
  } catch {
    return [];
  }

  const entries = await fsPromises.readdir(claudeProjectsPath, {
    withFileTypes: true,
  });
  const projects: ClaudeProjectInfo[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const encodedProjectDir = path.join(claudeProjectsPath, entry.name);

    try {
      const stats = await fsPromises.stat(encodedProjectDir);

      // 查找会话文件
      const sessionEntries = await fsPromises.readdir(encodedProjectDir);
      const sessionFiles = sessionEntries.filter(isValidSessionFile);

      // 找出所有会话文件中最新的修改时间
      let latestMtime = stats.mtime;
      for (const sessionFile of sessionFiles) {
        try {
          const sessionPath = path.join(encodedProjectDir, sessionFile);
          const sessionStats = await fsPromises.stat(sessionPath);
          if (sessionStats.mtime > latestMtime) {
            latestMtime = sessionStats.mtime;
          }
        } catch {
          // 忽略单个文件的错误
        }
      }

      // 从 JSONL 文件提取真实项目路径
      let realProjectPath: string | null = null;
      for (const jsonlFile of sessionFiles) {
        realProjectPath = extractProjectPath(
          path.join(encodedProjectDir, jsonlFile),
        );
        if (realProjectPath) break;
      }

      // 如果无法从 JSONL 提取，跳过该项目
      if (!realProjectPath) continue;

      const projectName = path.basename(realProjectPath);

      projects.push({
        name: projectName,
        path: realProjectPath,
        encodedDirName: entry.name,
        lastAccessed: latestMtime,
        sessions: sessionFiles,
      });
    } catch {
      // 忽略单个项目的错误
    }
  }

  // 按最新 session 的 mtime 排序（降序）
  projects.sort((a, b) => b.lastAccessed.getTime() - a.lastAccessed.getTime());

  // 如果指定了 limit，只返回前 N 个
  if (limit && limit > 0) {
    return projects.slice(0, limit);
  }

  return projects;
}

/**
 * 扫描项目的会话元数据
 * @param claudeProjectsPath Claude projects 目录路径
 * @param encodedDirName 编码的目录名
 * @param projectPath 真实项目路径
 * @param limit 返回会话数量，不传则返回全部
 * @returns 按 mtime 排序的会话元数据列表
 */
export async function scanSessions(
  claudeProjectsPath: string,
  encodedDirName: string,
  projectPath: string,
  limit?: number,
): Promise<ClaudeSessionMeta[]> {
  const encodedProjectDir = path.join(claudeProjectsPath, encodedDirName);

  try {
    await fsPromises.access(encodedProjectDir);
  } catch {
    return [];
  }

  const sessionFiles = await fsPromises.readdir(encodedProjectDir);
  const sessionMetadata: ClaudeSessionMeta[] = [];

  for (const file of sessionFiles) {
    if (!isValidSessionFile(file)) continue;

    const sessionPath = path.join(encodedProjectDir, file);
    const sessionId = extractSessionId(file);

    try {
      const stats = await fsPromises.stat(sessionPath);
      const lineCount = await countFileLines(sessionPath);

      // 检查是否为 summary 文件
      if (await isSummaryFile(sessionPath)) {
        continue;
      }

      sessionMetadata.push({
        id: sessionId,
        projectPath,
        createdAt: stats.birthtime,
        lastUpdated: stats.mtime,
        messageCount: lineCount,
      });
    } catch {
      // 忽略单个会话的错误
    }
  }

  // 按最后更新时间倒序排序
  sessionMetadata.sort(
    (a, b) => b.lastUpdated.getTime() - a.lastUpdated.getTime(),
  );

  // 如果指定了 limit，只返回前 N 个
  if (limit && limit > 0) {
    return sessionMetadata.slice(0, limit);
  }

  return sessionMetadata;
}

/**
 * 在项目目录中查找匹配的编码目录名
 * @param claudeProjectsPath Claude projects 目录路径
 * @param projectPath 真实项目路径
 * @returns 编码目录名，未找到返回 null
 */
export async function findEncodedDirName(
  claudeProjectsPath: string,
  projectPath: string,
): Promise<string | null> {
  try {
    const dirs = await fsPromises.readdir(claudeProjectsPath);
    const projectName = path.basename(projectPath);
    const prefix = getEncodedPrefix(projectPath);

    // 候选目录
    const candidateDirs: string[] = [];

    for (const encodedDirName of dirs) {
      const projectDir = path.join(claudeProjectsPath, encodedDirName);

      try {
        const stat = await fsPromises.stat(projectDir);
        if (!stat.isDirectory()) continue;
      } catch {
        continue;
      }

      // 前缀匹配优化
      if (prefix && !encodedDirName.startsWith(prefix)) {
        continue;
      }

      candidateDirs.push(encodedDirName);
    }

    let candidateDir: { encodedDirName: string; mtime: Date } | null = null;

    // 扫描候选目录
    for (const encodedDirName of candidateDirs) {
      const projectDir = path.join(claudeProjectsPath, encodedDirName);

      try {
        const files = await fsPromises.readdir(projectDir);
        const jsonlFiles = files.filter(isValidSessionFile);

        // 遍历所有文件，找到包含 cwd 的文件
        for (const jsonlFile of jsonlFiles) {
          const realPath = extractProjectPath(path.join(projectDir, jsonlFile));

          if (realPath === projectPath) {
            return encodedDirName;
          }
        }

        // 如果无法从文件中提取 cwd，尝试通过目录名和最近修改时间匹配
        if (
          jsonlFiles.length > 0 &&
          encodedDirName.endsWith(`-${projectName}`)
        ) {
          const latestFile = jsonlFiles[0];
          const filePath = path.join(projectDir, latestFile);
          const fileStat = await fsPromises.stat(filePath);
          const now = new Date();
          const ageInSeconds =
            (now.getTime() - fileStat.mtime.getTime()) / 1000;

          // 如果文件是最近 60 秒内创建的
          if (ageInSeconds < 60) {
            if (!candidateDir || fileStat.mtime > candidateDir.mtime) {
              candidateDir = { encodedDirName, mtime: fileStat.mtime };
            }
          }
        }
      } catch {
        // 忽略单个目录的错误
      }
    }

    // 如果找到候选目录，使用它
    if (candidateDir) {
      return candidateDir.encodedDirName;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * 查找最近创建的会话文件
 * @param claudeProjectsPath Claude projects 目录路径
 * @param encodedDirName 编码的目录名
 * @param maxAgeSeconds 最大文件年龄（秒），默认 60
 * @returns 最新会话信息，未找到返回 null
 */
export async function findLatestSession(
  claudeProjectsPath: string,
  encodedDirName: string,
  maxAgeSeconds: number = 60,
): Promise<{ sessionId: string; mtime: number } | null> {
  const projectDir = path.join(claudeProjectsPath, encodedDirName);

  try {
    const files = await fsPromises.readdir(projectDir);
    const sessionFiles = files.filter(isValidSessionFile);
    const now = Date.now();

    let latestSession: { sessionId: string; mtime: number } | null = null;

    for (const file of sessionFiles) {
      const filePath = path.join(projectDir, file);
      const fileStat = await fsPromises.stat(filePath);
      const ageInSeconds = (now - fileStat.mtimeMs) / 1000;

      // 只考虑指定时间内创建的文件
      if (ageInSeconds < maxAgeSeconds) {
        const sessionId = extractSessionId(file);
        if (!latestSession || fileStat.mtimeMs > latestSession.mtime) {
          latestSession = {
            sessionId,
            mtime: fileStat.mtimeMs,
          };
        }
      }
    }

    return latestSession;
  } catch {
    return null;
  }
}
