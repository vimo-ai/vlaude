const fs = require('fs');
const path = require('path');

const sessionId = 'ffef4223-283c-41e5-9cf6-c9949d1730fc';
const filePath = path.join(
  process.env.HOME,
  '.claude/projects/-Users-higuaifan-Desktop-hi----appleTV-----bilibili-plus',
  sessionId + '.jsonl'
);

const content = fs.readFileSync(filePath, 'utf8');
const lines = content.split('\n').filter(l => l.trim());

let userCount = 0;
let assistantCount = 0;

console.log('=== 实际对话内容示例 ===\n');

for (const line of lines) {
  try {
    const entry = JSON.parse(line);
    
    if (entry.type === 'user' && userCount < 2) {
      userCount++;
      console.log(`👤 USER #${userCount}:`);
      console.log(`   内容: ${entry.message.content.slice(0, 100)}...`);
      console.log(`   时间: ${entry.timestamp}`);
      console.log('');
    }
    
    if (entry.type === 'assistant' && assistantCount < 2) {
      assistantCount++;
      let text = '';
      if (Array.isArray(entry.message.content)) {
        const textBlock = entry.message.content.find(b => b.type === 'text');
        text = textBlock ? textBlock.text : '';
      }
      console.log(`🤖 ASSISTANT #${assistantCount}:`);
      console.log(`   模型: ${entry.message.model}`);
      console.log(`   内容: ${text.slice(0, 100)}...`);
      console.log(`   Token: input=${entry.message.usage.input_tokens}, output=${entry.message.usage.output_tokens}`);
      console.log('');
    }
    
    if (userCount >= 2 && assistantCount >= 2) break;
  } catch (e) {}
}

console.log('\n=== 局限性分析 ===\n');

// 检查是否有工具调用
let hasToolUse = false;
for (const line of lines.slice(0, 100)) {
  try {
    const entry = JSON.parse(line);
    if (entry.type === 'assistant' && entry.message.content) {
      const toolBlock = entry.message.content.find(b => b.type === 'tool_use');
      if (toolBlock) {
        hasToolUse = true;
        console.log('⚠️  发现工具调用，但工具调用的详细信息在 content block 中');
        console.log('   工具名:', toolBlock.name);
        console.log('   工具 ID:', toolBlock.id);
        break;
      }
    }
  } catch (e) {}
}

console.log('\n✅ 能拿到的数据:');
console.log('  - 完整的用户消息内容');
console.log('  - 完整的助手回复内容');
console.log('  - 消息时间戳');
console.log('  - 使用的模型');
console.log('  - Token 使用统计');
console.log('  - 对话树结构 (parentUuid)');
console.log('  - Git 分支、工作目录等上下文');

console.log('\n❌ 拿不到或有限制的:');
console.log('  - 工具调用的结果（需要解析 content blocks）');
console.log('  - 文件编辑的 diff（在 file-history-snapshot 中）');
console.log('  - 实时流式输出（只有最终结果）');
