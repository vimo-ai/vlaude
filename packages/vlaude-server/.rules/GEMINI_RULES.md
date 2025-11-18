### 目标
- Gemini CLI/Agents 在“通用 NestJS + Vue”项目中的安全改动规则。

### 必须遵循（MUST）
- 使用仓库既定包管理器（依据 `packageManager` 或锁文件）；测试一次性运行；禁止 watch/长驻。
- 分层与依赖倒置：领域不依赖框架/ORM；ORM/外部系统仅在 Infrastructure。
- 通过上下文对象传递身份/租户/作用域；禁止在领域/应用直接访问请求对象。
- ORM 可选：未启用不得生成/引用相关文件/脚本/依赖。
- 合入前必须通过 typecheck、lint、tests。

### 执行步骤（建议固化为 Agent 流程）
- 自发现 `<backend_root>` 与 `<frontend_root>`；列出将读/改文件与理由。
- 读取后再改动；仅在正确层修改；新聚合经工厂创建并在领域维护不变式。
- 如涉及可选模块，先确认是否存在；不存在则不生成任何相关物料。
- 运行类型检查、Lint、测试；失败先修复。
- 编写聚焦“意图与影响”的提交信息。

### 禁止
- 在 Controller/拦截器/守卫或 Vue 组件中编写业务逻辑。
- 在 Domain/Application 中引入 ORM/HTTP/框架对象。
- 引入 watch/长驻/交互式命令；切换包管理器。

### 检查清单
- ORM/外部依赖是否仅在 Infrastructure？
- 上下文是否正确通过上下文对象传递？
- 是否存在未启用模块的死引用？
- typecheck、lint、tests 是否全绿？

### 参考
- 统一规则：`/rules/AI_RULES.md`
