### 用途
- Cursor 专用规则（可复制为 `.cursorrules`），适配“通用 NestJS + Vue”项目。

### MUST
- 使用仓库既定包管理器；禁止新增不同锁文件。
- 测试一次性运行（如 Vitest `--run`）；禁止 watch/长驻。
- 分层：`api`/`application`/`domain`/`infrastructure`；业务逻辑不进 Controller。
- 上下文通过上下文对象传递；领域/应用层不得直接依赖框架对象。
- ORM 可选：未启用时不得生成/引用 ORM 文件与依赖。
- 变更合入前必须通过 typecheck、lint、tests。

### 修改前置
- 识别 `<backend_root>` 和 `<frontend_root>` 并列出将读/改文件与理由。
- 声明可选模块是否存在；未存在则不得引用。

### 放置与命名（示例，需遵循现状）
- 后端常见结构：`src/{api,application,domain,infrastructure}`；或 `modules/*` + 约定层次。
- 前端常见结构：`src/{components,views|pages,composables,stores,services|api,router}`。

### 禁止
- 在 Controller/拦截器/守卫或 Vue 组件里堆砌业务逻辑。
- 在 `domain`/`application` 引入 ORM/HTTP/框架对象。
- 更换包管理器或新增锁文件；watch/长驻/交互命令。

### 检查清单
- 依赖是否按层流动？ORM 是否仅在 Infrastructure？
- 上下文/身份是否通过上下文对象传递？
- API 调用是否集中管理并具备类型？
- typecheck、lint、tests 是否通过？

### 参考
- 统一规则：`/rules/AI_RULES.md`
