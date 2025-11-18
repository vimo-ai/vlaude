const fs = require('fs');
const path = require('path');

const sessionId = 'ffef4223-283c-41e5-9cf6-c9949d1730fc';
const projectSlug = '-Users-higuaifan-Desktop-hi----appleTV-----bilibili-plus';
const filePath = path.join(
  process.env.HOME,
  '.claude/projects',
  projectSlug,
  sessionId + '.jsonl'
);

const content = fs.readFileSync(filePath, 'utf8');
const lines = content.split('\n').filter(l => l.trim());

// 统计各种类型的记录
const types = {};
const samples = {};

for (const line of lines) {
  try {
    const entry = JSON.parse(line);
    const type = entry.type;
    
    types[type] = (types[type] || 0) + 1;
    
    if (!samples[type]) {
      samples[type] = entry;
    }
  } catch (e) {}
}

console.log('=== 记录类型统计 ===');
for (const [type, count] of Object.entries(types).sort((a, b) => b[1] - a[1])) {
  console.log(`${type}: ${count} 条`);
}

console.log('\n=== user 消息示例 ===');
if (samples.user) {
  console.log('可用字段:', Object.keys(samples.user).join(', '));
  console.log('message 结构:', samples.user.message ? Object.keys(samples.user.message).join(', ') : '无');
}

console.log('\n=== assistant 消息示例 ===');
if (samples.assistant) {
  console.log('可用字段:', Object.keys(samples.assistant).join(', '));
  console.log('message 结构:', samples.assistant.message ? Object.keys(samples.assistant.message).join(', ') : '无');
  if (samples.assistant.message?.usage) {
    console.log('usage 信息:', JSON.stringify(samples.assistant.message.usage, null, 2));
  }
}
