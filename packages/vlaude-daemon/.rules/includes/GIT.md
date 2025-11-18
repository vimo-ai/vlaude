### Git 通用规范（自包含）

#### 提交信息（Commit Message）
- 格式（推荐，兼容 Conventional Commits）：
  - `:emoji: type(scope): short summary`
  - 正文（可选）：说明“为什么”，描述背景、权衡与影响
  - 脚注（可选）：`Refs #123`, `BREAKING CHANGE: ...`
- 常用 type：`feat` | `fix` | `docs` | `refactor` | `perf` | `test` | `chore` | `build` | `ci` | `style` | `revert`
- 约束：
  - 标题不超过 72 字符，英文为主；避免含糊词（optimize、update）
  - 一次提交只做一件事；与无关改动（格式化、重命名）分离
  - 必须解释“为何”，不仅是“做了什么”
  - 如有 Issue/任务号，在脚注中引用（`Refs #ID`）

#### 分支策略
- 命名：`feature/<issue-id>-<slug>`、`fix/<issue-id>-<slug>`、`chore/<slug>`、`release/<version>`
- 规则：
  - 不在 `main/master` 开发；通过 PR 合并
  - 提交前尽量 `rebase` 到最新主干，保持线性历史
  - 获得评审后避免 `force-push`；如需整理历史，先与评审者同步

#### Pull Request 规范
- 标题：与 commit 一致的“意图导向”摘要
- 内容：
  - 变更摘要（1-3 条）
  - 设计/权衡（必要时）
  - 测试计划（如何验证，覆盖哪些用例）
  - 风险与回滚方案（若有）
  - 截图/接口变更（前端/后端如适用）
- 粒度：
  - 小而完整；尽量 < 500 行 diff（含新增/删除）
  - 拆分前置重构与功能改动，先提重构 PR，再提功能 PR

#### 版本与标签（可选）
- 采用 SemVer：`MAJOR.MINOR.PATCH`
- 变更日志建议根据 `type` 自动生成或半自动维护

#### 与 Janghood Workflow 的集成（仅在采用该流程时适用）
- 若仓库采用 Janghood 需求/任务工作流，则每个 Commit 与 PR 必须携带 Issue 标识。
- 推荐写法：
  - 在提交标题或脚注包含 `#IssueId`（将 `IssueId` 替换为实际编号）。
    - 例：`:sparkles: feat(auth): add login flow (#1234)` 或在脚注写 `Refs #1234`。
  - PR 标题/描述同样包含 `#IssueId`。
- 未采用 Janghood 工作流的仓库：仅在存在追踪系统时使用 Issue 引用，保持团队既有规范一致。

#### 其他约束
- 不提交大文件、密钥、环境配置（使用 .env.example）
- 保持代码风格与 lint 一致；不在 PR 中随意改动无关格式
- 评审清单：
  - 是否最小必要变更？是否包含“为何”？
  - 是否有足够测试覆盖关键路径？
  - 是否影响安全/性能/兼容性？是否有回滚方案？
