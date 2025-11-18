### 前端通用规范（Vue 3 + TypeScript）

#### 代码风格与类型
- 使用组合式 API（优先 `script setup`）；严禁随意 `any`
- 为 `props`、`emits`、`composables` 明确类型；避免隐式 `any` 与魔法字符串
- 模块化与可复用：跨组件逻辑沉淀至 `composables`；跨页面状态进入 `stores`

#### 目录与分层（尊重现状）
- 常见结构：`src/{components, views|pages, composables, stores, services|api, router, assets, styles}`
- 组件职责：
  - 展示组件（Presentational）：仅展示与交互，不含业务/数据访问
  - 容器组件或页面：协调数据源与子组件

#### API/数据访问
- 集中在 `services|api`，使用统一 HTTP 客户端（axios/fetch 包装）
- 定义类型化的请求/响应模型；前端不信任后端，做最小必要校验
- 错误处理与重试策略统一在 API 层（拦截器/中间件）

#### 路由与性能
- 路由懒加载大视图，合理分包；滚动行为、权限守卫集中管理
- 避免在顶级组件中做重计算；使用缓存与节流/防抖

#### 状态管理
- 依据项目采用 Pinia/Vuex 等；避免在多个状态源重复存储
- Store 仅存“应用级状态”，请求态与短暂 UI 态留在组件/组合函数

#### 样式与 UI
- 使用现有设计系统（UnoCSS/Tailwind/组件库）；禁止在 PR 中任意切换
- 样式作用域与变量化（CSS vars/预处理器）

#### 测试
- 组件测试（Vue Test Utils + Vitest），关键交互与渲染路径需覆盖
- E2E（可选，如 Playwright/Cypress）用于关键业务流
- 测试执行一次性（`--run`），禁止 watch/长驻
