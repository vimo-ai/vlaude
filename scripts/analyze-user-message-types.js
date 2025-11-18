#!/usr/bin/env node

/**
 * 分析 user 类型消息的所有真实场景
 * 目标：
 * 1. 找出所有 user 消息的特征组合
 * 2. 采样每种场景的真实数据
 * 3. 判断哪些应该显示为"用户消息"，哪些不应该
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE_PROJECTS_PATH = path.join(os.homedir(), '.claude', 'projects');

// 统计不同场景的 user 消息
const scenarios = new Map();

function scanDirectory(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      scanDirectory(fullPath);
    } else if (entry.isFile() && entry.name.endsWith('.jsonl') && !entry.name.startsWith('agent-')) {
      analyzeFile(fullPath);
    }
  }
}

function analyzeFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter(line => line.trim());

    for (const line of lines) {
      try {
        const msg = JSON.parse(line);

        if (msg.type === 'user') {
          analyzeUserMessage(msg);
        }
      } catch (e) {
        // skip
      }
    }
  } catch (e) {
    // skip
  }
}

function analyzeUserMessage(msg) {
  // 构建场景特征
  const features = {
    hasToolUseResult: msg.toolUseResult !== undefined,
    hasThinkingMetadata: msg.thinkingMetadata !== undefined,
    isVisibleInTranscriptOnly: msg.isVisibleInTranscriptOnly === true,
    isCompactSummary: msg.isCompactSummary === true,
    isMeta: msg.isMeta === true,
    hasAgentId: msg.agentId !== undefined,

    // 检查 message.content 的类型
    messageContentType: getMessageContentType(msg.message),

    // 检查是否包含 tool_result
    hasToolResultInContent: hasToolResultInContent(msg.message),
  };

  // 生成场景 key
  const scenarioKey = generateScenarioKey(features);

  if (!scenarios.has(scenarioKey)) {
    scenarios.set(scenarioKey, {
      features,
      count: 0,
      samples: [],
    });
  }

  const scenario = scenarios.get(scenarioKey);
  scenario.count++;

  // 采样（每种场景最多保存 3 个样本）
  if (scenario.samples.length < 3) {
    scenario.samples.push({
      uuid: msg.uuid,
      timestamp: msg.timestamp,
      message: msg.message,
      toolUseResult: msg.toolUseResult ? '(exists)' : undefined,
      thinkingMetadata: msg.thinkingMetadata ? '(exists)' : undefined,
      agentId: msg.agentId,
      isVisibleInTranscriptOnly: msg.isVisibleInTranscriptOnly,
      isCompactSummary: msg.isCompactSummary,
      isMeta: msg.isMeta,
    });
  }
}

function getMessageContentType(message) {
  if (!message || !message.content) return 'none';

  if (typeof message.content === 'string') {
    return 'string';
  }

  if (Array.isArray(message.content)) {
    const types = message.content.map(item => item.type).filter(Boolean);
    return `array[${types.join(', ')}]`;
  }

  return 'unknown';
}

function hasToolResultInContent(message) {
  if (!message || !message.content) return false;

  if (Array.isArray(message.content)) {
    return message.content.some(item => item.type === 'tool_result');
  }

  return false;
}

function generateScenarioKey(features) {
  const parts = [];

  if (features.hasToolUseResult) parts.push('toolUseResult');
  if (features.hasThinkingMetadata) parts.push('thinkingMetadata');
  if (features.isVisibleInTranscriptOnly) parts.push('visibleInTranscriptOnly');
  if (features.isCompactSummary) parts.push('compactSummary');
  if (features.isMeta) parts.push('isMeta');
  if (features.hasAgentId) parts.push('agentId');
  if (features.hasToolResultInContent) parts.push('hasToolResult');

  parts.push(`content:${features.messageContentType}`);

  return parts.length > 1 ? parts.join('+') : parts[0] || 'plain-user';
}

function generateReport() {
  console.log('\n=================================================');
  console.log('📊 User 消息场景分析报告');
  console.log('=================================================\n');

  // 按出现次数排序
  const sortedScenarios = Array.from(scenarios.entries())
    .sort((a, b) => b[1].count - a[1].count);

  let totalUserMessages = 0;
  for (const [, scenario] of sortedScenarios) {
    totalUserMessages += scenario.count;
  }

  console.log(`📈 总 User 消息数: ${totalUserMessages}\n`);
  console.log(`🔍 发现 ${sortedScenarios.length} 种不同场景\n`);

  for (const [scenarioKey, scenario] of sortedScenarios) {
    const percentage = ((scenario.count / totalUserMessages) * 100).toFixed(2);

    console.log(`\n${'='.repeat(70)}`);
    console.log(`场景: ${scenarioKey}`);
    console.log(`数量: ${scenario.count} (${percentage}%)`);
    console.log(`${'='.repeat(70)}\n`);

    console.log('特征:');
    console.log(`  - 有 toolUseResult: ${scenario.features.hasToolUseResult}`);
    console.log(`  - 有 thinkingMetadata: ${scenario.features.hasThinkingMetadata}`);
    console.log(`  - isVisibleInTranscriptOnly: ${scenario.features.isVisibleInTranscriptOnly}`);
    console.log(`  - isCompactSummary: ${scenario.features.isCompactSummary}`);
    console.log(`  - isMeta: ${scenario.features.isMeta}`);
    console.log(`  - 有 agentId: ${scenario.features.hasAgentId}`);
    console.log(`  - message.content 类型: ${scenario.features.messageContentType}`);
    console.log(`  - content 包含 tool_result: ${scenario.features.hasToolResultInContent}`);

    console.log('\n样本数据:');
    for (let i = 0; i < scenario.samples.length; i++) {
      const sample = scenario.samples[i];
      console.log(`\n  样本 ${i + 1}:`);
      console.log('  ' + JSON.stringify(sample, null, 2).split('\n').join('\n  '));
    }

    // 建议
    console.log('\n💡 显示建议:');
    const shouldDisplay = analyzeScenarioShouldDisplay(scenario.features);
    if (shouldDisplay.show) {
      console.log(`  ✅ 应该显示 - ${shouldDisplay.reason}`);
    } else {
      console.log(`  ❌ 不应该显示 - ${shouldDisplay.reason}`);
    }
  }

  console.log('\n\n=================================================');
  console.log('📋 汇总建议');
  console.log('=================================================\n');

  let shouldShow = 0;
  let shouldHide = 0;

  for (const [scenarioKey, scenario] of sortedScenarios) {
    const shouldDisplay = analyzeScenarioShouldDisplay(scenario.features);
    const percentage = ((scenario.count / totalUserMessages) * 100).toFixed(2);

    if (shouldDisplay.show) {
      shouldShow += scenario.count;
      console.log(`✅ [${percentage.padStart(5)}%] ${scenarioKey}`);
      console.log(`   → ${shouldDisplay.reason}\n`);
    } else {
      shouldHide += scenario.count;
      console.log(`❌ [${percentage.padStart(5)}%] ${scenarioKey}`);
      console.log(`   → ${shouldDisplay.reason}\n`);
    }
  }

  console.log(`\n总结:`);
  console.log(`  应该显示: ${shouldShow} (${((shouldShow / totalUserMessages) * 100).toFixed(2)}%)`);
  console.log(`  应该隐藏: ${shouldHide} (${((shouldHide / totalUserMessages) * 100).toFixed(2)}%)`);

  // 保存 JSON 报告
  const reportPath = path.join(__dirname, 'user-message-scenarios.json');
  const reportData = {
    totalUserMessages,
    totalScenarios: sortedScenarios.length,
    scenarios: Object.fromEntries(
      sortedScenarios.map(([key, data]) => [
        key,
        {
          count: data.count,
          percentage: ((data.count / totalUserMessages) * 100).toFixed(2),
          features: data.features,
          samples: data.samples,
          shouldDisplay: analyzeScenarioShouldDisplay(data.features),
        },
      ])
    ),
  };

  fs.writeFileSync(reportPath, JSON.stringify(reportData, null, 2));
  console.log(`\n📄 详细报告已保存: ${reportPath}\n`);
}

function analyzeScenarioShouldDisplay(features) {
  // 1. 工具执行结果 - 不显示
  if (features.hasToolUseResult || features.hasToolResultInContent) {
    return { show: false, reason: '工具执行结果，应合并到 Assistant 消息' };
  }

  // 2. 仅 Transcript 可见 - 不显示
  if (features.isVisibleInTranscriptOnly) {
    return { show: false, reason: '仅调试可见，不应在前端显示' };
  }

  // 3. 压缩摘要 - 不显示
  if (features.isCompactSummary) {
    return { show: false, reason: '会话压缩产物，不应显示' };
  }

  // 4. 元数据消息 - 不显示
  if (features.isMeta) {
    return { show: false, reason: '系统元数据，不应显示' };
  }

  // 5. 思考元数据 - 可能需要特殊处理
  if (features.hasThinkingMetadata) {
    return { show: true, reason: '用户消息（可选展示思考过程）' };
  }

  // 6. Agent 消息 - 显示但加标识
  if (features.hasAgentId) {
    return { show: true, reason: 'Agent 任务输入，显示并加 Agent 标识' };
  }

  // 7. 普通用户消息 - 显示
  return { show: true, reason: '真正的用户消息' };
}

console.log('🔍 开始扫描...\n');
scanDirectory(CLAUDE_PROJECTS_PATH);
generateReport();
