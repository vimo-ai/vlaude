### 适用对象
- Claude Code（claude.ai/code）在“通用 NestJS + Vue”项目中的改动。

### 行为约束
- **先读后写**：改动前列出将读取/修改的文件与理由；禁止猜测未读 API/类型。
- **自发现根目录**：按规则识别 `<backend_root>`（Nest）与 `<frontend_root>`（Vue）。
- **分层坚守**：Controller/DTO 仅 I/O；用例在 Application；领域建模在 Domain；ORM/HTTP 等仅在 Infrastructure。
- **上下文传递**：通过上下文对象；禁止在领域/应用层直接访问框架请求对象。
- **质量门禁**：使用仓库既定包管理器；测试用一趟执行（如 Vitest `--run`）；typecheck/lint/tests 全通过后再提交。

### 具体要求
- **依赖方向**：领域只依赖接口；实现细节在 Infrastructure 通过 DI 注入。
- **聚合创建**：通过工厂创建；在领域方法中维护不变式。
- **权限检查**：在 Application 边界处理；前端通过路由守卫/权限指令统一处理。
- **ORM 可选**：未启用 ORM 不得生成 `prisma/**` 或引入 ORM 依赖；启用后仅在 Infrastructure 实现仓储。
- **前端 API 层**：HTTP 调用集中到 `services|api`；组件中不得直接请求后端。

### 禁止项
- 业务逻辑写入 Controller/拦截器/守卫或 Vue 组件。
- 在 Domain/Application 中引用 ORM/HTTP/框架对象。
- 绕过工厂直接构造聚合/实体。
- watch/长驻/交互式命令；更换包管理器或新增锁文件。

### 提交流程
- 分组提交；英文 + 解释“为什么”；遵循仓库既有风格。
- 仅在类型检查、Lint、测试通过后提交。

### 检查清单
- 是否正确识别 `<backend_root>` 和 `<frontend_root>`？
- 是否仅在 Infrastructure 依赖 ORM/外部系统？
- 是否通过上下文对象传递身份/租户/会话信息？
- 聚合是否通过工厂创建并维护不变式？
- 前端 API 是否集中管理并具备类型？
- 类型检查、Lint、测试是否全绿？

### 参考
- 统一规则：`/rules/AI_RULES.md`
