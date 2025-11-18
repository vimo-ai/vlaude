const { query } = require('@anthropic-ai/claude-agent-sdk');

async function testResume() {
  console.log('开始 resume session: 4b5c9323-d240-4375-b240-508bf4831dd5');

  const sessionId = '4b5c9323-d240-4375-b240-508bf4831dd5';

  try {
    const result = query({
      prompt: 'hello',
      options: {
        resume: sessionId,
        cwd: '/Users/higuaifan/Desktop/hi/小工具/claude/test'
      }
    });

    console.log('等待响应...\n');

    for await (const message of result) {
      if (message.type === 'assistant') {
        console.log('收到 assistant 消息:');

        // 解析 content
        if (message.message.content) {
          for (const block of message.message.content) {
            if (block.type === 'text') {
              console.log(block.text);
            } else if (block.type === 'tool_use') {
              console.log(`[工具调用: ${block.name}]`);
            }
          }
        }
        console.log('');
      } else if (message.type === 'result') {
        console.log('对话结束');
        console.log('结果:', message.subtype);
        break;
      }
    }

  } catch (error) {
    console.error('错误:', error.message);
  }
}

testResume();
