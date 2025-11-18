const fs = require('fs');
const path = require('path');

const filePath = path.join(
  process.env.HOME,
  '.claude/projects/-Users-higuaifan-Desktop-hi----appleTV-----bilibili-plus',
  'ffef4223-283c-41e5-9cf6-c9949d1730fc.jsonl'
);

const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(l => l.trim());

const messages = [];

for (const line of lines) {
  try {
    const entry = JSON.parse(line);

    if (entry.type === 'user' || entry.type === 'assistant') {
      let content = '';

      if (entry.message) {
        if (typeof entry.message.content === 'string') {
          content = entry.message.content;
        } else if (Array.isArray(entry.message.content)) {
          for (const block of entry.message.content) {
            if (block.type === 'text') {
              content += block.text;
            } else if (block.type === 'tool_use') {
              content += '[工具: ' + block.name + ']\n';
            }
          }
        }
      }

      messages.push({
        type: entry.type,
        content: content,
        time: new Date(entry.timestamp).toLocaleString('zh-CN')
      });
    }
  } catch (e) {}
}

console.log('\n========== 对话历史 (共 ' + messages.length + ' 条) ==========\n');

// 显示前 10 条
messages.slice(0, 10).forEach((msg, i) => {
  const icon = msg.type === 'user' ? '👤' : '🤖';
  const typeText = msg.type === 'user' ? 'USER' : 'ASSISTANT';
  console.log(icon + ' [' + typeText + '] ' + msg.time);
  console.log(msg.content.slice(0, 300));
  console.log('\n' + '─'.repeat(80) + '\n');
});

console.log('\n... 还有 ' + (messages.length - 10) + ' 条消息\n');
