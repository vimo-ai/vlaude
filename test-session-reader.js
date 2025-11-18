const fs = require('fs');
const path = require('path');

// 核心函数：通过 sessionID 读取历史对话
function loadHistory(sessionId) {
  const projectSlug = '-Users-higuaifan-Desktop-hi----appleTV-----bilibili-plus';
  const filePath = path.join(
    process.env.HOME,
    '.claude/projects',
    projectSlug,
    `${sessionId}.jsonl`
  );

  console.log('📁 读取文件:', filePath);

  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n').filter(l => l.trim());

  const messages = [];

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);

      // 只保留用户和助手的消息
      if (entry.type === 'user' || entry.type === 'assistant') {
        let content = '';

        if (entry.message) {
          if (typeof entry.message.content === 'string') {
            content = entry.message.content;
          } else if (Array.isArray(entry.message.content)) {
            content = entry.message.content
              .filter(b => b.type === 'text')
              .map(b => b.text)
              .join('\n');
          }
        }

        messages.push({
          type: entry.type,
          role: entry.message?.role || entry.type,
          content: content.slice(0, 200), // 只取前 200 字符
          timestamp: entry.timestamp
        });
      }
    } catch (e) {
      // 跳过解析失败的行
    }
  }

  return messages;
}

// 测试
const sessionId = 'ffef4223-283c-41e5-9cf6-c9949d1730fc';
const history = loadHistory(sessionId);

console.log(`\n✅ 成功读取 ${history.length} 条消息\n`);

// 显示前 3 条
history.slice(0, 3).forEach((msg, i) => {
  console.log(`${i + 1}. [${msg.type}]`);
  console.log(`   ${msg.content}`);
  console.log('');
});
