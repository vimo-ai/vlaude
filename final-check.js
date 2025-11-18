const fs = require('fs');
const path = require('path');

const filePath = path.join(
  process.env.HOME,
  '.claude/projects/-Users-higuaifan-Desktop-hi----appleTV-----bilibili-plus',
  'ffef4223-283c-41e5-9cf6-c9949d1730fc.jsonl'
);

const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(l => l.trim());

console.log('=== 完整数据分析 ===\n');

// 解析所有消息
const messages = [];
const issues = [];

for (const line of lines) {
  try {
    const entry = JSON.parse(line);

    if (entry.type === 'user' || entry.type === 'assistant') {
      let content = '';

      // 处理各种 content 格式
      if (entry.message) {
        const msg = entry.message;

        if (typeof msg.content === 'string') {
          content = msg.content;
        } else if (Array.isArray(msg.content)) {
          // content 是数组（Claude API 格式）
          for (const block of msg.content) {
            if (block.type === 'text') {
              content += block.text;
            } else if (block.type === 'tool_use') {
              content += `[工具调用: ${block.name}]`;
            }
          }
        } else if (typeof msg.content === 'object') {
          // content 是对象
          content = JSON.stringify(msg.content);
        }
      }

      messages.push({
        type: entry.type,
        content: content,
        timestamp: entry.timestamp,
        model: entry.message?.model
      });
    }
  } catch (e) {
    issues.push(e.message);
  }
}

console.log(`总共解析出 ${messages.length} 条对话消息`);
console.log(`解析失败: ${issues.length} 条\n`);

console.log('前 5 条消息:\n');
messages.slice(0, 5).forEach((msg, i) => {
  console.log(`${i + 1}. [${msg.type}]`);
  console.log(`   ${msg.content.slice(0, 100)}...`);
  console.log('');
});

console.log('\n=== 结论 ===\n');
console.log('✅ 通过 sessionID 完全可以获取历史对话');
console.log('✅ 可以拿到完整的消息内容、时间、模型等信息');
console.log('⚠️  需要处理多种 content 格式（string/array/object）');
console.log('⚠️  工具调用需要解析 content blocks');
