# Vlaude V2 架构重构进度

> 基于 `VLAUDE_ARCHITECTURE_V2.md` 进行的重构

## ✅ 已完成

### 1. 数据库 Schema
- ✅ `vlaude-server/prisma/schema.prisma` 已包含所有必需字段:
  - Project 表: `isDeleted`, `deletedAt`, `lastModified`, `sessionCount`
  - Session 表: `isDeleted`, `deletedAt`, `lastParsedLine`, `lastFileSize`, `lastMtime`
  - Message 表: 保持不变

### 2. Daemon 端核心服务

#### 文件监听服务
- ✅ 创建 `file-watcher.service.ts` - 三层监听机制
  - 监听 1: 项目列表 (`~/.claude/projects/` 所有 .jsonl)
  - 监听 2: 会话列表 (某个项目下所有 .jsonl)
  - 监听 3: 会话详情 (单个 .jsonl 文件)
- ✅ 监听模式切换逻辑
- ✅ 软删除检测逻辑
- ✅ 创建 `file-watcher.module.ts` 模块封装

#### 增量解析工具
- ✅ 创建 `incremental-parser.ts` - 增量解析辅助函数
  - `readLinesFromOffset()` - 从指定行开始读取
  - `countLines()` - 统计文件总行数
  - `readAllLines()` - 读取所有行
  - `parseJSONL()` - 解析 JSONL 格式

#### 监听模式控制器
- ✅ 创建 `watch-mode.controller.ts` - 监听模式切换 API
  - `POST /watch-mode` - 切换监听模式
  - `GET /watch-mode/status` - 获取当前监听状态

#### Server Client 服务
- ✅ 添加 V2 架构新通知方法到 `server-client.service.ts`:
  - `notifyProjectListUpdate()` - 通知项目列表更新
  - `notifySessionListUpdate(projectPath)` - 通知会话列表更新
  - `notifySessionDetailUpdate(sessionId, projectPath)` - 通知会话详情更新
  - `notifySessionRestored(sessionId, projectPath)` - 通知会话已恢复
  - `notifySessionDeleted(sessionId, projectPath)` - 通知会话已删除

#### 模块注册
- ✅ 在 `app.module.ts` 中注册 `FileWatcherModule`
- ✅ 在 `app.module.ts` 中注册 `WatchModeController`

---

## 📋 待完成

### Daemon 端

1. **修改 data-collector.service.ts**
   - [ ] 集成 `incremental-parser.ts` 工具类
   - [ ] 实现完整的增量解析逻辑 (参考架构文档 getSessionMessages 函数)
   - [ ] 删除旧的全量读取逻辑
   - [ ] 添加项目最后修改时间计算 (使用所有 session 文件中最新的 mtime)

2. **修改 server-client.service.ts**
   - [ ] 添加新的通知方法:
     - `notifyProjectListUpdate()`
     - `notifySessionListUpdate(projectPath)`
     - `notifySessionDetailUpdate(sessionId, projectPath)`
     - `notifySessionRestored(sessionId, projectPath)`
     - `notifySessionDeleted(sessionId, projectPath)`

3. **注册模块**
   - [ ] 在 `app.module.ts` 中导入 `FileWatcherModule`
   - [ ] 在 `app.module.ts` 中注册 `WatchModeController`

### Server 端

1. **清理旧代码**
   - [ ] 删除 `app.gateway.ts` 中的订阅管理逻辑:
     - `sessionSubscriptions` Map
     - `handleSessionSubscribe()` 方法
     - `handleSessionUnsubscribe()` 方法
   - [ ] 删除 `daemon.gateway.ts` 中的监听转发逻辑:
     - `daemon.startWatching` 事件处理
     - `daemon.stopWatching` 事件处理

2. **适配新数据结构**
   - [ ] 更新 `ProjectController`:
     - 查询时过滤 `isDeleted = true` 的项目
     - 按 `lastModified` 倒序排序
     - 支持 `limit` 参数 (默认 10)
   - [ ] 更新 `SessionController`:
     - 查询时过滤 `isDeleted = true` 的会话
     - 按 `lastMtime` 倒序排序
     - 支持分页 (`offset`, `limit`)
   - [ ] 更新 `MessageController`:
     - 支持增量获取消息
     - 支持分页 (`offset`, `limit`)

3. **新增 API**
   - [ ] `POST /daemon/watch-mode` - 转发监听模式切换到 Daemon
   - [ ] `GET /projects?limit=10` - 获取最近项目
   - [ ] `GET /sessions/:sessionId/messages?offset=0&limit=20` - 分页获取消息

4. **事件处理**
   - [ ] 处理 Daemon 发来的项目列表更新事件
   - [ ] 处理 Daemon 发来的会话列表更新事件
   - [ ] 处理 Daemon 发来的会话详情更新事件

### Swift 端 (iOS App)

1. **修复 API 响应解码错误**
   - [ ] 检查所有 API 响应格式
   - [ ] 确保所有响应都包含 `data` 字段或调整 Swift 模型

2. **适配软删除**
   - [ ] 过滤掉 `isDeleted = true` 的 session
   - [ ] 显示恢复提示 (如果检测到文件恢复)

3. **监听模式切换**
   - [ ] 页面进入时通知 Server 切换监听模式
   - [ ] 页面退出时恢复上一级监听

---

## 🎯 重构目标对比

### 旧架构的问题 ❌
1. **订阅管理混乱** - `sessionSubscriptions` 复杂管理
2. **依赖链过长** - Swift → Server → Daemon (多层转发)
3. **被动响应** - Daemon 等待 Server 指令
4. **缺少核心机制** - 无增量解析、软删除、mtime 对比

### 新架构的优势 ✅
1. **主动监听** - Daemon 根据页面状态自动切换监听目标
2. **数据闭环** - 文件系统 → mtime → 增量解析 → 数据库缓存 → 推送
3. **职责清晰** - Daemon 负责监听和解析, Server 负责 API 和转发
4. **性能优化** - 增量解析、mtime 快速对比、软删除支持恢复

---

## 📝 实现建议

### 第一阶段 (核心功能)
1. 完成 `data-collector.service.ts` 增量解析逻辑
2. 完成 `server-client.service.ts` 新增通知方法
3. 注册模块和控制器

### 第二阶段 (Server 端适配)
1. 清理旧的订阅管理代码
2. 更新 Controller 查询逻辑 (过滤软删除, 支持分页)
3. 新增监听模式切换 API

### 第三阶段 (测试和优化)
1. 测试完整数据流
2. 测试监听模式切换
3. 测试增量解析逻辑
4. 测试软删除和恢复

---

## 🚀 下一步行动

1. **立即完成**:
   - 修改 `data-collector.service.ts`
   - 修改 `server-client.service.ts`
   - 注册模块

2. **随后完成**:
   - 清理 Server 端旧代码
   - 适配新数据结构
   - 测试完整流程

3. **最后完成**:
   - Swift 端适配
   - 性能优化
   - 错误处理

---

**更新时间**: 2025-11-16
**状态**: Daemon 端核心完成 (约 60% 完成)

## 🎉 Daemon 端已可独立运行

Daemon 端的核心 V2 架构已经完成,包括:
- ✅ 三层监听机制完整实现
- ✅ 增量解析工具类
- ✅ 监听模式切换 API
- ✅ 新增通知方法
- ✅ 模块注册完成

**可以启动测试 Daemon 端的监听功能**:
```bash
cd packages/vlaude-daemon
pnpm run start:dev
```

测试 API:
```bash
# 切换到项目列表监听模式
curl -X POST http://localhost:10006/watch-mode \
  -H "Content-Type: application/json" \
  -d '{"mode": "project-list"}'

# 获取当前监听状态
curl http://localhost:10006/watch-mode/status
```
