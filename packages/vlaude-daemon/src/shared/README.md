# Shared 模块说明

本目录包含项目中跨 Context 共享的通用代码。

## 目录结构

```
src/shared/
├── enums/          # 枚举定义
├── types/          # 类型定义
├── schemas/        # Zod Schema 定义
└── services/       # 共享服务（如 Outbox、Event Relayer）
```

## 设计原则

### 什么应该放在 shared？

✅ **应该放在这里**:
- 跨多个 Context 使用的枚举（如状态枚举、类型枚举）
- 通用的类型定义
- 基础设施相关的共享服务（如事件中继、Outbox 模式）
- 跨 Context 的 Schema 定义

❌ **不应该放在这里**:
- 特定于某个 Context 的业务逻辑
- 单一 Context 使用的类型/枚举
- 业务领域的实体和聚合根

## 使用示例

### 共享枚举

```typescript
// shared/enums/common.enum.ts
export enum StatusEnum {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  DELETED = 'deleted',
}
```

### 共享类型

```typescript
// shared/types/common.type.ts
export interface PaginationParams {
  page: number;
  pageSize: number;
}

export interface PaginationResult<T> {
  list: T[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
}
```

### 共享 Schema

```typescript
// shared/schemas/common.schema.ts
import { z } from 'zod';

export const PaginationSchema = z.object({
  page: z.number().int().positive().default(1),
  pageSize: z.number().int().positive().max(100).default(10),
});
```

## 注意事项

1. **避免循环依赖**: shared 模块不应该依赖任何 context
2. **保持简洁**: 只放真正需要共享的代码
3. **文档化**: 添加清晰的注释说明用途和使用场景
4. **版本控制**: 修改共享代码时需要考虑对所有使用方的影响
