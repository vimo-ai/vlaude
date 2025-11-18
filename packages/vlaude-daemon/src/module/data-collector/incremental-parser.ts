/**
 * @description 增量解析工具类
 * @author Claude
 * @date 2025/11/16
 * @version v2.0.0
 */
import * as fs from 'fs';
import * as readline from 'readline';

/**
 * 读取指定行数的内容(从 offset 开始)
 */
export async function readLinesFromOffset(
  filePath: string,
  startLine: number,
): Promise<string[]> {
  const lines: string[] = [];
  const fileStream = fs.createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: fileStream });

  let currentLine = 0;

  return new Promise((resolve, reject) => {
    rl.on('line', (line) => {
      currentLine++;
      if (currentLine > startLine) {
        lines.push(line);
      }
    });

    rl.on('close', () => {
      resolve(lines);
    });

    rl.on('error', (error) => {
      reject(error);
    });
  });
}

/**
 * 统计文件总行数
 */
export async function countLines(filePath: string): Promise<number> {
  const fileStream = fs.createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: fileStream });

  let lineCount = 0;

  return new Promise((resolve, reject) => {
    rl.on('line', () => {
      lineCount++;
    });

    rl.on('close', () => {
      resolve(lineCount);
    });

    rl.on('error', (error) => {
      reject(error);
    });
  });
}

/**
 * 读取所有行
 */
export async function readAllLines(filePath: string): Promise<string[]> {
  const fileStream = fs.createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: fileStream });

  const lines: string[] = [];

  return new Promise((resolve, reject) => {
    rl.on('line', (line) => {
      lines.push(line);
    });

    rl.on('close', () => {
      resolve(lines);
    });

    rl.on('error', (error) => {
      reject(error);
    });
  });
}

/**
 * 解析 JSONL 行为 JSON 对象
 */
export function parseJSONL(lines: string[]): any[] {
  return lines
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((obj) => obj !== null);
}
