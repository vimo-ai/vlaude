### 后端通用规范（NestJS + TypeScript + DDD 友好）

#### 架构与分层
- 推荐分层（名称可因项目有所不同，职责保持一致）：
  - `api`：Controller/DTO/校验，仅做 I/O 适配；禁止业务逻辑
  - `application`：用例编排、权限校验、事务协调（必要时）；不直接依赖具体 ORM/HTTP 客户端
  - `domain`：实体/聚合、值对象、工厂、领域服务、仓储接口；禁止引入框架/ORM
  - `infrastructure`：仓储实现、外部适配（ORM/HTTP/缓存/消息队列）
- 依赖方向：Domain →（无）; Application → Domain; Infrastructure → Domain（实现接口）; Api → Application

#### 上下文与配置
- 使用上下文对象（Request Context Provider）向应用/领域传递身份/租户/作用域等信息
- 禁止在领域/应用直接访问框架对象（`Request`/`Response`）
- 配置管理采用集中化（如 `@nestjs/config`），按环境加载 `.env`；运行时由 DI 提供配置

#### 事务、I/O 与持久化
- 事务边界由 Application 协调，具体实现由 Infrastructure/ORM 处理
- Domain 禁止出现 I/O 与事务逻辑
- ORM 可选：若未启用 ORM，不应引入相关依赖；若启用（如 Prisma/TypeORM）仅在 Infrastructure 依赖

#### 校验、序列化与映射
- DTO + `class-validator` 在 `api` 层进行入参校验
- 在 Application 完成 DTO ↔ Domain 的映射；Domain 仅接收领域类型

#### 错误处理与日志
- 统一异常过滤器（HTTPExceptionFilter）将内部错误映射到外部协议
- 统一日志拦截器，输出结构化日志，包含请求 ID/用户/耗时等上下文

#### 命名与约定
- 实体/聚合：名词；应用服务：动宾短语（`createOrder`）
- 工厂：`*.factory.ts`；仓储接口：`*.repo.ts` 或 `*.repository.ts`
- 领域事件（可选）：用于跨聚合协作与集成边界（Outbox/消息）

#### 安全
- 输入校验、白名单 CORS、限流、Helmet（如需）
- 权限在 Application 边界校验；API 层通过 Guard/Decorator 作为外围防线

#### 测试策略
- Unit：Domain 纯单元测试（无框架、无 I/O）
- Integration：Application + 内存/测试替身实现；或使用 Nest TestingModule
- E2E：HTTP 层对外接口验证，使用 supertest/模拟器
- 测试一次跑完（Vitest `--run`），禁止 watch/长驻

#### 目录建议（尊重现状）
- 常见：`src/{api,application,domain,infrastructure}` 或 `src/modules/<bounded-context>/{...}`
- 每个限界上下文（BC）自包含四层，聚焦单一业务语义
