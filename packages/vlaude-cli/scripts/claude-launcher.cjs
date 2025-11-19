#!/usr/bin/env node

/**
 * Vlaude Claude Launcher
 *
 * 这个启动器的作用：
 * 1. Monkey Patch crypto.randomUUID，拦截 Claude Code 生成的 sessionId
 * 2. 通过 fd 3 将 UUID 发送给父进程（vlaude CLI）
 * 3. 启动真正的 Claude Code CLI
 *
 * 工作原理：
 * - Claude Code 内部使用 crypto.randomUUID() 生成 sessionId
 * - 我们拦截这个调用，在生成 UUID 后通过 fd 3 发送给父进程
 * - 父进程同时监听文件系统，当两者匹配时确认 sessionId
 */

const crypto = require('crypto');
const fs = require('fs');
const { homedir } = require('os');
const { join } = require('path');

// 禁用自动更新（避免干扰）
process.env.DISABLE_AUTOUPDATER = '1';

/**
 * 通过 fd 3 向父进程发送 JSON 消息
 */
function writeMessage(message) {
    try {
        fs.writeSync(3, JSON.stringify(message) + '\n');
    } catch (err) {
        // fd 3 不可用时忽略（兼容直接运行 Claude 的情况）
    }
}

/**
 * Monkey Patch crypto.randomUUID
 * 拦截 UUID 生成，将其发送给父进程
 */
const originalRandomUUID = crypto.randomUUID;

// 替换 global.crypto.randomUUID
Object.defineProperty(global, 'crypto', {
    configurable: true,
    enumerable: true,
    get() {
        return {
            randomUUID: () => {
                const uuid = originalRandomUUID();
                writeMessage({ type: 'uuid', value: uuid });
                return uuid;
            }
        };
    }
});

// 替换 crypto.randomUUID（兼容性）
Object.defineProperty(crypto, 'randomUUID', {
    configurable: true,
    enumerable: true,
    get() {
        return () => {
            const uuid = originalRandomUUID();
            writeMessage({ type: 'uuid', value: uuid });
            return uuid;
        }
    }
});

/**
 * 查找 Claude Code CLI 路径
 * 优先级：
 * 1. CLAUDE_CLI_PATH 环境变量
 * 2. ~/.claude/local/claude（自动更新版本）
 * 3. 全局安装的 claude 命令
 */
function getClaudePath() {
    if (process.env.CLAUDE_CLI_PATH) {
        return process.env.CLAUDE_CLI_PATH;
    }

    const localPath = join(homedir(), '.claude', 'local', 'claude');
    if (fs.existsSync(localPath)) {
        return localPath;
    }

    // 使用 @anthropic-ai/claude-code 包（如果可用）
    return '@anthropic-ai/claude-code/cli.js';
}

/**
 * 启动 Claude Code
 */
const claudePath = getClaudePath();

// 动态导入 Claude Code CLI
// 注意：这里使用动态 import 是因为 Claude Code 可能使用 ES 模块
if (claudePath.endsWith('.js')) {
    // ES 模块路径
    import(claudePath).catch(err => {
        console.error('Failed to load Claude Code CLI:', err);
        process.exit(1);
    });
} else {
    // 可执行文件路径
    const { spawn } = require('child_process');
    const child = spawn(claudePath, process.argv.slice(2), {
        stdio: 'inherit',
        cwd: process.cwd()
    });

    child.on('exit', (code) => {
        process.exit(code || 0);
    });
}
