# 测试基础设施说明

本目录包含项目的测试基础设施和测试用例。

## 目录结构

```
src/test/
├── mock/               # Mock 服务
│   └── test-prisma.service.ts  # 测试专用 Prisma 服务（使用 SQLite）
├── utils/              # 测试工具
│   ├── test-app.ts     # 测试应用初始化工具
│   ├── test-helpers.ts # 测试辅助函数（JWT/HTTP/Database）
│   ├── test-config.ts  # 测试配置管理
│   ├── mock-factory.ts # Mock 工厂
│   └── mock-manager.ts # Mock 管理器
├── setup/              # 全局设置
│   └── bootstrap.ts    # 全局 beforeAll/afterAll
├── unit/               # 单元测试
├── integration/        # 集成测试
└── e2e/               # E2E 测试
```

## 核心组件

### TestPrismaService
测试专用的 Prisma 服务，使用 SQLite 数据库，避免影响开发/生产数据库。

**特性**:
- 使用 SQLite 文件数据库（`prisma/test-db/sqlite/test.db`）
- 自动处理 JSON 字段序列化/反序列化
- 提供 `clearAllData()` 方法清理测试数据

### Test App
提供统一的测试应用创建和管理工具。

**功能**:
- 创建测试应用实例
- 配置驱动的 Mock 策略
- 自动应用全局管道、守卫、过滤器

### Test Helpers
提供常用的测试辅助函数。

**包含**:
- `JWTTestUtils`: 生成测试 JWT Token
- `HTTPTestUtils`: HTTP 请求头工具
- `DatabaseTestUtils`: 数据库测试数据创建

## 使用方式

### E2E 测试示例

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import '../setup/bootstrap';
import { testApp, testPrisma } from '../setup/bootstrap';
import { clearDatabase } from '../utils/test-app';
import { JWTTestUtils, HTTPTestUtils } from '../utils/test-helpers';

describe('Example E2E Tests', () => {
  beforeEach(async () => {
    // 清理数据库
    await clearDatabase(testPrisma);
  });

  it('应该成功访问受保护的端点', async () => {
    const token = JWTTestUtils.generateTestToken({ userId: 1 });

    const response = await testApp.inject({
      method: 'GET',
      url: '/api/protected',
      headers: HTTPTestUtils.authHeader(token),
    });

    expect(response.statusCode).toBe(200);
  });
});
```

## 注意事项

1. **测试数据库**: 使用独立的 SQLite 数据库，通过 `prisma/test-db/prisma/schema.prisma` 生成
2. **数据隔离**: 每个测试前使用 `clearDatabase()` 清理数据
3. **Mock 服务**: 使用 Mock 服务避免调用外部依赖（如第三方 API）
4. **串行执行**: E2E 测试使用 `fileParallelism: false` 避免数据库冲突

## 开发指南

### 添加新的 Mock 服务

1. 在 `mock/` 目录创建 Mock 服务类
2. 在 `utils/mock-manager.ts` 中注册
3. 在测试配置中启用

### 添加新的测试工具

在 `utils/test-helpers.ts` 中添加新的工具函数，保持代码复用。
