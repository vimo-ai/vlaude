const fs = require('fs');
const path = require('path');

// 当前对话的 session
const sessionId = '3b99d1f0-476d-422e-a069-ede61fd39b75';
const filePath = path.join(
  process.env.HOME,
  '.claude/projects/-Users-higuaifan-Desktop-hi-----claude',
  sessionId + '.jsonl'
);

const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(l => l.trim());

const messages = [];

for (const line of lines) {
  try {
    const entry = JSON.parse(line);

    if (entry.type === 'user' || entry.type === 'assistant') {
      let content = '';

      let toolCalls = [];

      if (entry.message) {
        if (typeof entry.message.content === 'string') {
          content = entry.message.content;
        } else if (Array.isArray(entry.message.content)) {
          for (const block of entry.message.content) {
            if (block.type === 'text') {
              content += block.text;
            } else if (block.type === 'tool_use') {
              toolCalls.push({
                name: block.name,
                id: block.id,
                input: block.input
              });
              content += '[工具: ' + block.name + ']\n';
            }
          }
        }
      }

      if (content.trim()) {  // 只保留有内容的消息
        messages.push({
          type: entry.type,
          content: content,
          time: new Date(entry.timestamp).toLocaleString('zh-CN'),
          uuid: entry.uuid,
          toolCalls: toolCalls
        });
      }
    }
  } catch (e) {}
}

console.log('\n========== 当前对话历史 ==========');
console.log('Session ID: ' + sessionId);
console.log('消息总数: ' + messages.length + ' 条');
console.log('文件大小: ' + (fs.statSync(filePath).size / 1024).toFixed(2) + ' KB\n');

// 显示最近 15 条消息
const recent = messages.slice(-15);

recent.forEach((msg, i) => {
  const icon = msg.type === 'user' ? '👤' : '🤖';
  const num = messages.length - 15 + i + 1;

  console.log('');
  console.log(icon + ' #' + num + ' [' + msg.type + '] ' + msg.time);

  // 显示工具调用
  if (msg.toolCalls && msg.toolCalls.length > 0) {
    msg.toolCalls.forEach(tool => {
      console.log('');
      console.log('⏺ ' + tool.name + '(' + Object.keys(tool.input).map(k => tool.input[k]).join(', ').slice(0, 50) + ')');

      // 格式化显示输入参数
      const inputLines = JSON.stringify(tool.input, null, 2).split('\n');
      inputLines.forEach((line, idx) => {
        if (idx === 0) {
          console.log('  ⎿  参数:');
        }
        console.log('     ' + line);
      });
    });
  }

  // 显示消息内容
  if (msg.content.trim() && !msg.content.startsWith('[工具:')) {
    const lines = msg.content.split('\n');
    const maxLines = 10;

    console.log('');
    console.log('  ⎿  内容:');

    if (lines.length > maxLines) {
      lines.slice(0, maxLines).forEach(line => {
        console.log('     ' + line);
      });
      console.log('     … +' + (lines.length - maxLines) + ' lines');
    } else {
      lines.forEach(line => {
        console.log('     ' + line);
      });
    }
  }
});
