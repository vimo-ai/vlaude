/**
 * Claude Code 路径编码解码工具
 * 纯函数，无副作用
 */

/**
 * 编码项目路径为 Claude Code 的目录名格式
 * @example /Users/xxx/project → -Users-xxx-project
 */
export function encodeProjectPath(realPath: string): string {
  return '-' + realPath.replace(/^\//, '').replace(/\//g, '-');
}

/**
 * 解码 Claude Code 目录名为真实路径
 * @example -Users-xxx-project → /Users/xxx/project
 * @note 此方法不可靠，因为路径组件可能包含 `-`，建议从 JSONL 提取真实路径
 */
export function decodeProjectPath(encodedPath: string): string {
  return encodedPath.replace(/^-/, '/').replace(/-/g, '/');
}

/**
 * 提取路径的编码前缀（到第一个非 ASCII 字符之前）
 * 用于优化目录扫描性能
 *
 * @example
 * /Users/xxx/小工具/claude/test → -Users-xxx-
 * /Users/xxx/project → -Users-xxx-project
 */
export function getEncodedPrefix(projectPath: string): string {
  // 找到第一个非 ASCII 字符（中文等）的位置
  let prefixEnd = 0;
  for (let i = 0; i < projectPath.length; i++) {
    const char = projectPath[i];
    // 非 ASCII 字符（中文、emoji 等）
    if (char.charCodeAt(0) > 127) {
      break;
    }
    prefixEnd = i + 1;
  }

  // 如果整个路径都是 ASCII，取全路径
  const prefix = projectPath.substring(0, prefixEnd);

  // 转换：/ 替换为 -（Claude Code 的编码规则）
  const encoded = prefix.replace(/\//g, '-');

  return encoded;
}
