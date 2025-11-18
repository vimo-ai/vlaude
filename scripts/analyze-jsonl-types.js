#!/usr/bin/env node

/**
 * JSONL 消息类型分析脚本
 *
 * 功能：
 * 1. 扫描 ~/.claude/projects 下所有 .jsonl 文件
 * 2. 统计所有 message.type 的出现次数
 * 3. 区分 agent 文件和普通会话文件
 * 4. 生成分析报告
 *
 * 使用方式：
 *   node scripts/analyze-jsonl-types.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// 配置
const CLAUDE_PROJECTS_PATH = path.join(os.homedir(), '.claude', 'projects');

// 统计数据
const stats = {
  totalFiles: 0,
  agentFiles: 0,
  sessionFiles: 0,
  totalMessages: 0,
  messageTypes: new Map(), // type -> count
  filesWithType: new Map(), // type -> Set<filename>
  agentFileTypes: new Map(), // agent 文件中的类型统计
  errors: [],
};

/**
 * 递归扫描目录下所有 .jsonl 文件
 */
function scanDirectory(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      // 递归扫描子目录
      scanDirectory(fullPath);
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      // 分析 JSONL 文件
      analyzeJsonlFile(fullPath, entry.name);
    }
  }
}

/**
 * 分析单个 JSONL 文件
 */
function analyzeJsonlFile(filePath, filename) {
  stats.totalFiles++;

  const isAgentFile = filename.startsWith('agent-');
  if (isAgentFile) {
    stats.agentFiles++;
  } else {
    stats.sessionFiles++;
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter(line => line.trim());

    for (const line of lines) {
      try {
        const message = JSON.parse(line);
        stats.totalMessages++;

        // 统计 type 字段
        if (message.type) {
          const type = message.type;

          // 全局统计
          stats.messageTypes.set(type, (stats.messageTypes.get(type) || 0) + 1);

          // 记录文件名
          if (!stats.filesWithType.has(type)) {
            stats.filesWithType.set(type, new Set());
          }
          stats.filesWithType.get(type).add(filename);

          // Agent 文件专项统计
          if (isAgentFile) {
            stats.agentFileTypes.set(type, (stats.agentFileTypes.get(type) || 0) + 1);
          }
        } else {
          // 没有 type 字段的消息
          stats.messageTypes.set('<no-type>', (stats.messageTypes.get('<no-type>') || 0) + 1);
        }
      } catch (parseError) {
        // 跳过无法解析的行
      }
    }
  } catch (error) {
    stats.errors.push({ file: filename, error: error.message });
  }
}

/**
 * 生成分析报告
 */
function generateReport() {
  console.log('\n=================================================');
  console.log('📊 JSONL 消息类型分析报告');
  console.log('=================================================\n');

  console.log('📁 文件统计:');
  console.log(`   总文件数: ${stats.totalFiles}`);
  console.log(`   Agent 文件: ${stats.agentFiles}`);
  console.log(`   会话文件: ${stats.sessionFiles}`);
  console.log(`   总消息数: ${stats.totalMessages}\n`);

  console.log('📋 消息类型分布 (按出现次数排序):');
  console.log('┌────────────────────────────────┬──────────┬────────────┐');
  console.log('│ Type                           │ Count    │ Percentage │');
  console.log('├────────────────────────────────┼──────────┼────────────┤');

  // 按出现次数排序
  const sortedTypes = Array.from(stats.messageTypes.entries())
    .sort((a, b) => b[1] - a[1]);

  for (const [type, count] of sortedTypes) {
    const percentage = ((count / stats.totalMessages) * 100).toFixed(2);
    const typeName = type.padEnd(30);
    const countStr = count.toString().padStart(8);
    const percentStr = `${percentage}%`.padStart(10);
    console.log(`│ ${typeName} │ ${countStr} │ ${percentStr} │`);
  }
  console.log('└────────────────────────────────┴──────────┴────────────┘\n');

  // 当前过滤列表
  const currentFilters = ['queue-operation', 'checkpoint', 'file-history-snapshot', 'summary'];
  const userMessageTypes = ['user', 'assistant', 'system'];

  console.log('🔍 类型分类建议:\n');

  console.log('✅ 用户消息类型 (应该显示):');
  for (const type of sortedTypes) {
    if (userMessageTypes.includes(type[0])) {
      console.log(`   - ${type[0]} (${type[1]} 条)`);
    }
  }

  console.log('\n❌ 当前已过滤的类型:');
  for (const type of currentFilters) {
    const count = stats.messageTypes.get(type) || 0;
    console.log(`   - ${type} (${count} 条)`);
  }

  console.log('\n⚠️  未分类的类型 (需要决策):');
  for (const [type, count] of sortedTypes) {
    if (!currentFilters.includes(type) && !userMessageTypes.includes(type) && type !== '<no-type>') {
      const fileCount = stats.filesWithType.get(type).size;
      console.log(`   - ${type} (${count} 条, 出现在 ${fileCount} 个文件中)`);
    }
  }

  // Agent 文件统计
  if (stats.agentFileTypes.size > 0) {
    console.log('\n🤖 Agent 文件中的消息类型:');
    const sortedAgentTypes = Array.from(stats.agentFileTypes.entries())
      .sort((a, b) => b[1] - a[1]);

    for (const [type, count] of sortedAgentTypes) {
      console.log(`   - ${type}: ${count} 条`);
    }
  }

  // 错误统计
  if (stats.errors.length > 0) {
    console.log('\n❗ 文件读取错误:');
    for (const error of stats.errors.slice(0, 10)) {
      console.log(`   - ${error.file}: ${error.error}`);
    }
    if (stats.errors.length > 10) {
      console.log(`   ... 还有 ${stats.errors.length - 10} 个错误`);
    }
  }

  console.log('\n=================================================\n');

  // 生成 JSON 报告
  const reportPath = path.join(__dirname, 'jsonl-type-report.json');
  const reportData = {
    timestamp: new Date().toISOString(),
    summary: {
      totalFiles: stats.totalFiles,
      agentFiles: stats.agentFiles,
      sessionFiles: stats.sessionFiles,
      totalMessages: stats.totalMessages,
    },
    messageTypes: Object.fromEntries(stats.messageTypes),
    agentFileTypes: Object.fromEntries(stats.agentFileTypes),
    filesWithType: Object.fromEntries(
      Array.from(stats.filesWithType.entries()).map(([type, files]) => [
        type,
        Array.from(files),
      ])
    ),
  };

  fs.writeFileSync(reportPath, JSON.stringify(reportData, null, 2));
  console.log(`📄 详细报告已保存到: ${reportPath}\n`);
}

/**
 * 主函数
 */
function main() {
  console.log('🔍 开始扫描 JSONL 文件...');
  console.log(`📂 扫描目录: ${CLAUDE_PROJECTS_PATH}\n`);

  if (!fs.existsSync(CLAUDE_PROJECTS_PATH)) {
    console.error(`❌ 目录不存在: ${CLAUDE_PROJECTS_PATH}`);
    process.exit(1);
  }

  scanDirectory(CLAUDE_PROJECTS_PATH);
  generateReport();
}

// 执行
main();
