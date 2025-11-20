/**
 * @description Config Loader Service - 加载 Claude Code 配置（agents, MCP, hooks 等）
 * @author Claude
 * @date 2025/11/20
 * @version v1.0.0
 */
import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs/promises';
import * as path from 'path';
import { homedir } from 'os';
import type { AgentDefinition, McpServerConfig, SettingSource } from '@anthropic-ai/claude-agent-sdk';

/**
 * Agent 配置文件的 YAML front matter 格式
 */
interface AgentFrontMatter {
  name: string;
  description: string;
  model?: 'sonnet' | 'opus' | 'haiku' | 'inherit';
  tools?: string[];
  disallowedTools?: string[];
}

/**
 * Settings.json 配置文件格式
 */
interface ClaudeSettings {
  mcpServers?: Record<string, McpServerConfig>;
  permissions?: {
    allow?: string[];
    deny?: string[];
    mode?: string;
  };
  env?: Record<string, string>;
  hooks?: any;
}

@Injectable()
export class ConfigLoaderService {
  private readonly logger = new Logger(ConfigLoaderService.name);

  /**
   * 加载所有 agents 配置
   * 从 ~/.claude/agents/ 目录读取所有 .md 文件
   */
  async loadAgentsConfig(): Promise<Record<string, AgentDefinition>> {
    try {
      const agentsDir = path.join(homedir(), '.claude', 'agents');

      // 检查目录是否存在
      try {
        await fs.access(agentsDir);
      } catch {
        this.logger.warn(`⚠️ Agents 目录不存在: ${agentsDir}`);
        return {};
      }

      const files = await fs.readdir(agentsDir);
      const mdFiles = files.filter(f => f.endsWith('.md'));

      this.logger.log(`📂 发现 ${mdFiles.length} 个 agent 配置文件`);

      const agents: Record<string, AgentDefinition> = {};

      for (const file of mdFiles) {
        try {
          const filePath = path.join(agentsDir, file);
          const content = await fs.readFile(filePath, 'utf-8');

          const agent = this.parseAgentFile(content);
          if (agent) {
            const agentName = path.basename(file, '.md');
            agents[agentName] = agent;
            this.logger.log(`  ✅ 加载 agent: ${agentName}`);
          }
        } catch (error) {
          this.logger.warn(`  ⚠️ 解析 agent 失败: ${file} - ${error.message}`);
        }
      }

      this.logger.log(`✅ 成功加载 ${Object.keys(agents).length} 个 agents`);
      return agents;
    } catch (error) {
      this.logger.error(`❌ 加载 agents 配置失败: ${error.message}`);
      return {};
    }
  }

  /**
   * 解析 agent 配置文件（YAML front matter + markdown）
   */
  private parseAgentFile(content: string): AgentDefinition | null {
    try {
      // 提取 YAML front matter
      const frontMatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);

      if (!frontMatterMatch) {
        this.logger.warn('⚠️ 未找到 YAML front matter');
        return null;
      }

      const [, yamlContent, markdownContent] = frontMatterMatch;

      // 简单的 YAML 解析（只处理基础格式）
      const frontMatter = this.parseSimpleYaml(yamlContent);

      if (!frontMatter.name || !frontMatter.description) {
        this.logger.warn('⚠️ 缺少必需字段 (name 或 description)');
        return null;
      }

      return {
        description: frontMatter.description,
        prompt: markdownContent.trim(),
        model: frontMatter.model || 'inherit',
        tools: frontMatter.tools,
        disallowedTools: frontMatter.disallowedTools,
      };
    } catch (error) {
      this.logger.warn(`⚠️ 解析 agent 文件失败: ${error.message}`);
      return null;
    }
  }

  /**
   * 简单的 YAML 解析器（只处理基础的 key: value 格式）
   */
  private parseSimpleYaml(yaml: string): AgentFrontMatter {
    const result: any = {};
    const lines = yaml.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const colonIndex = trimmed.indexOf(':');
      if (colonIndex === -1) continue;

      const key = trimmed.substring(0, colonIndex).trim();
      let value = trimmed.substring(colonIndex + 1).trim();

      // 去除引号
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }

      // 处理数组（简单格式: [a, b, c]）
      if (value.startsWith('[') && value.endsWith(']')) {
        const arrayContent = value.slice(1, -1);
        result[key] = arrayContent.split(',').map(v => v.trim()).filter(Boolean);
      } else {
        result[key] = value;
      }
    }

    return result as AgentFrontMatter;
  }

  /**
   * 加载 MCP 服务器配置
   * 从 settings.json 和 settings.local.json 读取
   */
  async loadMcpConfig(projectPath?: string): Promise<Record<string, McpServerConfig>> {
    try {
      const configs: Record<string, McpServerConfig> = {};

      // 1. 加载用户级别配置 (~/.claude/settings.json)
      const userSettings = await this.loadSettingsFile(
        path.join(homedir(), '.claude', 'settings.json')
      );
      if (userSettings?.mcpServers) {
        Object.assign(configs, userSettings.mcpServers);
      }

      // 2. 加载项目级别配置 (projectPath/.claude/settings.json)
      if (projectPath) {
        const projectSettings = await this.loadSettingsFile(
          path.join(projectPath, '.claude', 'settings.json')
        );
        if (projectSettings?.mcpServers) {
          Object.assign(configs, projectSettings.mcpServers);
        }

        // 3. 加载本地配置 (projectPath/.claude/settings.local.json)
        const localSettings = await this.loadSettingsFile(
          path.join(projectPath, '.claude', 'settings.local.json')
        );
        if (localSettings?.mcpServers) {
          Object.assign(configs, localSettings.mcpServers);
        }
      }

      this.logger.log(`✅ 加载了 ${Object.keys(configs).length} 个 MCP 服务器配置`);
      return configs;
    } catch (error) {
      this.logger.error(`❌ 加载 MCP 配置失败: ${error.message}`);
      return {};
    }
  }

  /**
   * 读取并解析 settings 文件
   */
  private async loadSettingsFile(filePath: string): Promise<ClaudeSettings | null> {
    try {
      await fs.access(filePath);
      const content = await fs.readFile(filePath, 'utf-8');
      const settings = JSON.parse(content);
      this.logger.log(`  📄 读取配置文件: ${filePath}`);
      return settings;
    } catch (error) {
      // 文件不存在或解析失败时返回 null（不报错）
      return null;
    }
  }

  /**
   * 获取完整的 SDK 配置
   *
   * @param projectPath 项目路径
   * @returns SDK Options 的部分配置
   */
  async getFullSdkConfig(projectPath?: string) {
    const [agents, mcpServers] = await Promise.all([
      this.loadAgentsConfig(),
      this.loadMcpConfig(projectPath),
    ]);

    return {
      agents,
      mcpServers,
      // 可以根据需要添加更多配置
      env: {
        ...process.env,
        CLAUDE_AGENTS_PATH: path.join(homedir(), '.claude', 'agents'),
        CLAUDE_MCP_ENABLED: Object.keys(mcpServers).length > 0 ? 'true' : 'false',
      },
      settingSources: ['local', 'project', 'user'] as SettingSource[],
    };
  }
}
