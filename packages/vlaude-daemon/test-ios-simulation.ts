/**
 * iOS 客户端模拟脚本
 *
 * 模拟流程：
 * 1. 连接 WebSocket 到 Server
 * 2. 订阅会话（不触发 remote 模式）
 * 3. Join 会话 + 发送消息（触发 CLI 进入 remote 模式）
 * 4. 等待 assistant 回复
 * 5. 断开连接（触发 CLI 恢复 local 模式）
 */

import { io, Socket } from 'socket.io-client';

const SERVER_URL = 'http://localhost:10005';
const PROJECT_PATH = '/Users/higuaifan/Desktop/hi/小工具/claude/packages/vlaude-cli';
const SESSION_ID = '9ada9db9-5acc-41a0-8774-53164fe76f77';

interface Message {
  sessionId: string;
  message: any;
}

async function simulateIOSClient() {
  console.log('📱 iOS 客户端模拟开始');
  console.log('━'.repeat(60));
  console.log(`Server: ${SERVER_URL}`);
  console.log(`Project: ${PROJECT_PATH}`);
  console.log(`Session: ${SESSION_ID}`);
  console.log('━'.repeat(60));

  const socket: Socket = io(SERVER_URL, {
    transports: ['websocket'],
  });

  // 1. 连接成功
  socket.on('connect', () => {
    console.log('\n✅ [WebSocket] 连接成功');
    console.log(`   Socket ID: ${socket.id}\n`);

    // 2. 订阅会话（用于接收消息推送，不触发 remote 模式）
    console.log('📋 [订阅会话] 发送 session:subscribe...');
    socket.emit('session:subscribe', {
      sessionId: SESSION_ID,
      projectPath: PROJECT_PATH,
    }, (response: any) => {
      console.log('   订阅响应:', response);
    });

    // 3. 等待 2 秒后发送消息（给订阅时间）
    setTimeout(() => {
      sendMessage(socket);
    }, 2000);
  });

  // 监听新消息
  socket.on('message:new', (data: Message) => {
    console.log('\n📨 [收到消息]');
    console.log(`   Session: ${data.sessionId}`);
    console.log(`   Message type: ${data.message.type}`);

    if (data.message.type === 'assistant') {
      console.log('   ✅ 收到 assistant 回复！');

      // 显示消息内容
      if (data.message.message?.content) {
        const content = data.message.message.content;
        if (Array.isArray(content)) {
          content.forEach((block: any) => {
            if (block.type === 'text') {
              console.log(`   内容: ${block.text}`);
            }
          });
        }
      }

      // 等待 2 秒后断开连接
      console.log('\n⏳ 2 秒后断开连接...');
      setTimeout(() => {
        exitRemoteMode(socket);
      }, 2000);
    }
  });

  socket.on('disconnect', () => {
    console.log('\n❌ [WebSocket] 已断开连接');
    console.log('━'.repeat(60));
    console.log('📱 iOS 客户端模拟结束');
    process.exit(0);
  });

  socket.on('connect_error', (error) => {
    console.error('❌ [连接错误]', error.message);
    process.exit(1);
  });
}

/**
 * 发送消息（触发 remote 模式）
 */
function sendMessage(socket: Socket) {
  console.log('\n📤 [发送消息] 准备发送...');

  // 先 join 会话（触发 CLI 进入 remote 模式）
  console.log('   1. 发送 join 事件（触发 CLI remote 模式）');
  socket.emit('join', {
    sessionId: SESSION_ID,
    clientType: 'swift',
    projectPath: PROJECT_PATH,
  }, (response: any) => {
    console.log('   Join 响应:', response);
  });

  // 稍后发送消息
  setTimeout(() => {
    console.log('   2. 发送消息: "ping"');
    socket.emit('message:send', {
      sessionId: SESSION_ID,
      text: 'ping',
    }, (response: any) => {
      console.log('   发送响应:', response);
    });

    console.log('\n⏳ 等待 assistant 回复...');
  }, 500);
}

/**
 * 退出 remote 模式（断开连接）
 */
function exitRemoteMode(socket: Socket) {
  console.log('\n👋 [退出 Remote] 断开连接...');

  // 1. 取消订阅
  socket.emit('session:unsubscribe', {
    sessionId: SESSION_ID,
  }, (response: any) => {
    console.log('   取消订阅响应:', response);
  });

  // 2. 断开连接
  setTimeout(() => {
    socket.close();
  }, 500);
}

// 启动模拟
simulateIOSClient().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
