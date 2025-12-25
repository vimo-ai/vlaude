/**
 * @description Vitest 配置文件
 * @author 阿怪
 * @date 2024/11/11 17:04
 * @version v1.0.0
 *
 * 江湖的业务千篇一律，复杂的代码好几百行。
 */
import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

export default defineConfig({
  test: {
    globals: true,
    root: './',
    testTimeout: 30000, // 30秒超时
    hookTimeout: 60000, // 60秒超时（用于beforeAll/afterAll）
    // E2E测试串行执行,避免数据库冲突
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      exclude: ['**/node_modules/**', '**/src/test/**', '**/e2e/**'],
    },
    // 测试文件匹配模式
    include: ['src/test/**/*.spec.ts', 'src/test/**/*.test.ts'],
    // 排除不需要测试的文件
    exclude: ['**/node_modules/**', '**/dist/**', '**/build/**'],
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  plugins: [swc.vite({ module: { type: 'es6' } }) as any],
});
