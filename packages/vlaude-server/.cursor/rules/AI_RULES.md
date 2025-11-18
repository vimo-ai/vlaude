### 目的与范围
- 目标：面向“通用 NestJS + Vue”项目的 AI 编码规则，保障改动安全、可控、可复现、可维护。
- 适用：单仓或多包仓库（monorepo/ polyrepo），不假设具体业务模块（如用户、权限等），ORM 为可选能力。

### 仓库自发现（必须遵循）
- 包管理器：根据仓库既有选择来执行。
  - 优先读取根 `package.json` 的 `packageManager` 字段；否则以锁文件判定：存在 `pnpm-lock.yaml` 用 pnpm，存在 `yarn.lock` 用 yarn，存在 `package-lock.json` 用 npm。
  - 禁止新增不同的锁文件或切换包管理器。
- 后端根 `<backend_root>`：通过以下线索自动识别其路径（常见为 `backend/`、`server/`、`api/`、`apps/server/`）：
  - 存在 Nest 入口（如 `src/main.ts` 中使用 `NestFactory`）且同级有 `src/app.module.ts`。
- 前端根 `<frontend_root>`：通过以下线索自动识别其路径（常见为 `frontend/`、`web/`、`client/`、`apps/web/`）：
  - 存在 Vue3 入口（如 `src/main.ts` 中 `createApp`）或根 `index.html` 包含 `id="app"`。

### 强制性约束（MUST）
- 类型安全：禁止随意使用 `any`；如必须使用，需范围最小化并说明理由。
- 命令执行：测试需一次性运行（如 Vitest 使用 `--run`）；禁止 watch/长驻/交互式命令。
- 提交质量：英文为主，简洁说明“为什么”；遵循仓库既有提交风格；不得私自修改提交规范。
- 先读后写：改动前列出将读取/修改的文件与理由；不得猜测未阅读的接口/类型。
- 绿色闸门：类型检查 + Lint + 测试均通过后方可提交/合并。

### 后端（NestJS）规则
- 分层（鼓励 DDD）：
  - `api` 层：Controller/DTO/校验，仅做 I/O 适配，不写业务逻辑。
  - `application` 层：用例编排与权限边界校验，不直接依赖具体 ORM/HTTP 客户端。
  - `domain` 层：实体/聚合、工厂、领域服务、仓储接口；禁止引入框架/ORM。
  - `infrastructure` 层：仓储实现与外部系统适配（ORM/HTTP/缓存/消息等）。
- 依赖方向：领域仅依赖抽象（接口）；应用依赖领域抽象；基础设施实现并通过 DI 注入。
- 上下文与身份：通过上下文对象（如自定义 Request Context 提供者）向应用/领域传递；禁止在领域/应用直接访问框架对象。
- 事务与 I/O：仅在基础设施或（必要时）应用层协调；严禁位于领域层。
- DTO 与映射：在 `api` 层进行校验和序列化；在应用层完成 DTO ↔ 领域模型映射。
- 日志与错误：使用统一拦截器/过滤器；控制器不抛出原始错误。
- ORM 可选：若仓库已选定 Prisma/TypeORM 等则延续；若未使用 ORM，不得自行引入，除非任务明确要求。

### 前端（Vue 3）规则
- 组合式 API + TypeScript：优先使用 `script setup`；为 props、emits、composables 提供明确类型。
- 目录建议（尊重现状，不强行改名）：`src/{components, views|pages, composables, stores, services|api, router, assets, styles}`。
- 状态管理：沿用仓库已选方案（Pinia/Vuex 等），禁止擅自引入新方案。
- API 调用：集中于 `services|api`，定义类型化的请求/响应模型；组件内禁止直接发起 HTTP。
- 路由与性能：路由级按需加载；大视图使用懒加载。
- 设计系统：延续既有 UI/样式系统（如 UnoCSS/Tailwind 等），禁止随意切换。

### 可选特性与开关（SHOULD）
- ORM/Prisma 可选：
  - 未启用 ORM：必要时提供内存实现以支持开发/测试。
  - 启用 Prisma：新增 `prisma/**`、配置 `DATABASE_URL`、在基础设施实现仓储、在 `package.json` 增加相关脚本；领域与应用保持不变。
- 认证/权限/对象存储/Outbox 等：均作为可选模块处理；仅在仓库已有或任务明确要求时引用；避免产生死引用。

### AI 执行契约
- 改动前：
  - 基于“自发现”规则确定 `<backend_root>` 与 `<frontend_root>`。
  - 列出将读取/修改的文件清单与理由。
- 改动中：
  - 严守分层；业务逻辑不写在 Controller 或 Vue 组件。
  - 先定义接口（仓储等），再写实现；通过依赖注入装配。
  - 聚合通过工厂创建；不变式在领域方法中维护。
- 改动后：
  - 一次性运行类型检查、Lint、测试；修复失败后再继续下一步。
  - 编写聚焦“意图与影响”的提交信息。

### 禁止事项（DON'T）
- 在领域/应用层引入 ORM/框架对象或直接进行 I/O。
- 在 Controller/拦截器/守卫或 Vue 组件中堆砌业务逻辑。
- 更换包管理器或新增不同的锁文件。
- 引入 watch/长驻/交互式命令。
- 为未启用/不存在的可选模块生成代码或依赖。

### 检查清单（Chekclists）
- 后端
  - ORM/外部依赖是否仅出现在 `infrastructure`？
  - 上下文/身份是否通过上下文对象而非全局/静态访问？
  - 仓储是否“领域接口 + 基础设施实现”的模式？
  - 聚合是否使用工厂并在领域中维护不变式？
- 前端
  - API 是否集中管理并拥有清晰类型？
  - 组件是否保持表现层性质，通用逻辑沉淀到 composables/stores/services？
  - 路由是否合理拆分并懒加载大视图？
- 工程
  - 是否使用既有包管理器？测试是否一次性运行？类型检查/Lint/测试是否全绿？
  - 提交信息是否包含“为什么”且遵循仓库风格？

### 工具专用规则的关系
- 针对 Claude / Cursor / Gemini 的专用规则文件仅做“格式与行为适配”，不得弱化本文件中的任何 MUST 约束。