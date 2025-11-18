import { io } from 'socket.io-client';
import type { VlaudeStatus } from './types';

const SERVER_URL = 'http://localhost:10005';

/**
 * 连接到 vlaude-server 获取当前状态
 */
export async function getVlaudeStatus(sessionId: string | null): Promise<VlaudeStatus> {
  return new Promise((resolve) => {
    // 如果没有 sessionId，说明不在 vlaude 会话中
    if (!sessionId) {
      resolve({ connected: false });
      return;
    }

    let resolved = false;
    let socket: ReturnType<typeof io> | null = null;

    const cleanup = () => {
      if (!resolved) {
        resolved = true;
        if (socket) {
          socket.close();
        }
      }
    };

    try {
      socket = io(SERVER_URL, {
        timeout: 100,
        reconnection: false,
        transports: ['websocket'], // 只用 WebSocket，更快
      });

      socket.on('connect', () => {
        // 连接成功
        cleanup();
        resolve({
          connected: true,
          mode: 'local',
        });
      });

      socket.on('connect_error', (error) => {
        // 连接失败
        cleanup();
        resolve({ connected: false });
      });

      socket.on('error', () => {
        cleanup();
        resolve({ connected: false });
      });
    } catch (error) {
      cleanup();
      resolve({ connected: false });
      return;
    }

    // 超时处理 - 缩短到 100ms
    setTimeout(() => {
      cleanup();
      resolve({ connected: false });
    }, 100);
  });
}
