# {{name}}

{{description}}

> 开发请先阅读 `rules/AI_RULES.md`（通用规则）与 `rules/includes/*`（Git/后端/前端/测试/工作流）。所有 AI/CLI/人工改动均需遵循这些规范。

## 快速开始

### 1. 安装依赖

```bash
pnpm install
```

### 2. 配置环境变量

复制环境变量模板：

```bash
cp env/.env.template env/.env.dev
```

然后修改 `env/.env.dev` 中的配置：

- `DATABASE_URL`: 数据库连接字符串
- `USER_PLATFORM_BASE_URL`: 用户平台服务地址（默认：http://localhost:3508）
- MinIO 相关配置（如果需要文件存储）

### 3. 用户服务配置

本项目使用独立的用户服务，请确保用户服务正在运行：

```bash
# 在另一个终端中启动用户服务
cd ../user/server
pnpm start:dev
```

### 4. 数据库设置

```bash
# 生成 Prisma 客户端
pnpm prisma:generate

# 运行数据库迁移（如果有）
pnpm prisma db push
```

### 5. 启动开发服务器

```bash
pnpm start:dev
```

## 用户认证

项目集成了用户SDK，提供以下功能：

- 用户认证守卫：`@UseGuards(UserAuthGuard)`
- 用户信息装饰器：`@MUser()` 和 `@MUserId()`
- 自动从用户服务获取用户信息

### 使用示例

```typescript
import { Controller, Get, UseGuards } from '@nestjs/common';
import { UserAuthGuard, MUser, MUserId, UserLoginVO } from '@vimo/user-sdk';

@Controller('example')
@UseGuards(UserAuthGuard)
export class ExampleController {
  
  @Get('protected')
  protectedRoute(@MUser() user: UserLoginVO, @MUserId() userId: number) {
    return {
      message: `Hello, ${user.nickname}!`,
      userId: userId
    };
  }
}
```

## API 文档

### 用户相关接口

- `GET /user/me` - 获取当前用户信息
- `GET /user/profile` - 获取用户资料
- `GET /user/email` - 获取用户邮箱

## 开发说明

- 本项目基于 NestJS 框架
- 使用 Prisma 作为 ORM
- 集成用户SDK进行认证
- 支持 MinIO 文件存储

