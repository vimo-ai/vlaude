# Claude Code 项目路径编码冲突问题

## 问题发现时间
2025-11-19

## 问题背景

Vlaude 系统通过扫描 `~/.claude/projects/` 目录来获取 Claude Code 的项目列表。每个子目录代表一个项目，目录名是 Claude Code 对真实路径进行编码后的结果。

## 问题现象

**案例**：
- 文件系统目录：`-Users-higuaifan-Desktop-hi-----claude-test`
- 该目录按修改时间排序：第 3 个
- 但 API 返回的第 3 个项目路径是：`/Users/higuaifan/Desktop/hi/小工具/claude/test`（错误）
- 应该是：`/Users/higuaifan/Desktop/hi/小工具/claude-test`

**数据验证**：
```bash
$ grep -h '"cwd":"[^"]*"' ~/.claude/projects/-Users-higuaifan-Desktop-hi-----claude-test/*.jsonl | \
  grep -o '"cwd":"[^"]*"' | sort | uniq -c | sort -rn

190 "cwd":"/Users/higuaifan/Desktop/hi/小工具/claude/test"
100 "cwd":"/Users/higuaifan/Desktop/hi/小工具/claude-test"
```

**结论**：一个编码目录下存在两个不同的真实路径！

## 根本原因

### 1. Claude Code 的编码机制缺陷（首要问题）

Claude Code 将路径中的中文字符编码为固定数量的短横线，导致不同路径可能编码成相同的目录名。

**示例**：
- `/Users/higuaifan/Desktop/hi/小工具/claude/test` → `-Users-higuaifan-Desktop-hi-----claude-test`
- `/Users/higuaifan/Desktop/hi/小工具/claude-test` → `-Users-higuaifan-Desktop-hi-----claude-test`

中文"小工具"被编码成 5 个短横线 `-----`，导致：
- `小工具/claude/test` 和 `小工具/claude-test` 产生了相同的编码

**本质**：这是 Claude Code 自身的设计缺陷，Vlaude 无法改变。

### 2. Vlaude 业务逻辑未处理此场景（次要问题）

当前逻辑假设：**一个编码目录 = 一个项目**

但实际情况是：**一个编码目录可能包含多个项目的 session 文件**

## 影响范围

### 1. 数据采集层（daemon）

#### `collectProjects()` - 获取项目列表
**位置**：`packages/vlaude-daemon/src/module/data-collector/data-collector.service.ts:249-344`

**问题代码**（第 297-306 行）：
```typescript
// 遍历所有 .jsonl 文件，找到第一个包含 cwd 的文件
for (const jsonlFile of sessionFiles) {
  realProjectPath = await this.extractProjectPathFromJsonl(
    path.join(encodedProjectDir, jsonlFile)
  );
  if (realProjectPath) {
    // 找到了包含 cwd 的文件，停止查找
    break;  // ❌ 问题：找到第一个就停止
  }
}

// 如果无法从 JSONL 提取，跳过该项目
if (!realProjectPath) {
  this.logger.warn(`⚠️ 无法从 JSONL 提取项目路径，跳过: ${entry.name}`);
  continue;
}
```

**问题**：
- `readdir()` 返回的文件顺序不确定
- 找到第一个能提取 cwd 的文件就停止
- 可能提取到错误的项目路径
- 导致某些项目在列表中"丢失"（被其他项目覆盖）

#### `refreshProjectMapping()` - 建立路径映射
**位置**：`packages/vlaude-daemon/src/module/data-collector/data-collector.service.ts:112-190`

**当前结构**：
```typescript
private pathToEncodedDirCache = new Map<string, string>();
// Map<projectPath, encodedDirName>
// 一对一映射
```

**问题**：
- 无法处理多个 `projectPath` 映射到同一个 `encodedDirName` 的情况
- 缓存结构需要重新设计

#### `handleFindNewSession()` - 查找新 session
**位置**：`packages/vlaude-daemon/src/module/data-collector/data-collector.service.ts:726-822`

**问题**：
- 当目录下有多个项目的 session 时，可能找到错误项目的 session
- 需要通过 cwd 匹配来确认是正确的项目

### 2. 数据存储层（server）

#### Project 表设计
**位置**：`packages/vlaude-server/prisma/schema.prisma:12-31`

```prisma
model Project {
  id             Int       @id @default(autoincrement())
  name           String    @db.VarChar(255)
  path           String    @unique @db.VarChar(500)  // ⚠️ 唯一键
  encodedDirName String?   @db.VarChar(500)
  // ...
}
```

**问题**：
- 以 `path` 为唯一键
- 但一个 `encodedDirName` 可能对应多个 `path`
- 当前设计无法表达这种一对多关系

### 3. API 层

#### `GET /projects` - 获取项目列表
**影响**：返回的项目路径可能错误，导致 iOS 看不到正确的项目

## 需要处理的业务节点

### 节点 1：`collectProjects()` - 项目列表采集
**当前逻辑**：取第一个找到的 cwd
**需要改进**：
- 选项 A：统计所有 cwd，按最新 mtime 选择
- 选项 B：统计所有 cwd，按出现次数最多选择
- 选项 C：拆分成多个项目返回（需配合其他节点改造）

### 节点 2：`refreshProjectMapping()` - 路径映射
**当前逻辑**：一对一映射
**需要改进**：
- 重新设计缓存结构，支持多对一或一对多
- 可能需要：`Map<encodedDirName, Set<projectPath>>`

### 节点 3：`handleFindNewSession()` - 新 session 查找
**当前逻辑**：只匹配目录名
**需要改进**：
- 在查找时验证 cwd 是否匹配
- 确保找到的 session 属于正确的项目

### 节点 4：数据库设计
**当前逻辑**：Project 表以 path 为唯一键
**需要改进**：
- 考虑如何存储和关联同一编码目录下的多个项目
- 可能需要引入中间表或调整表结构

### 节点 5：iOS 项目列表显示
**需要考虑**：
- 如何向用户展示同一编码目录下的多个项目
- 是否需要合并显示或分别显示

## 临时规避方案

在彻底解决前，可以考虑：
1. **避免创建路径相似的项目**（如 `claude/test` 和 `claude-test`）
2. **优先使用英文路径**，避免中文导致的编码冲突
3. **清理冲突项目**：手动合并或删除不需要的项目

## 后续行动

1. **设计整体解决方案**：需要考虑所有业务节点的协调改造
2. **评估改造成本**：包括代码修改、数据库迁移、iOS 端适配
3. **制定实施计划**：分阶段实施，确保系统稳定性
4. **补充测试用例**：覆盖路径冲突场景

## 相关文件

- `packages/vlaude-daemon/src/module/data-collector/data-collector.service.ts`
- `packages/vlaude-server/src/module/project/project.service.ts`
- `packages/vlaude-server/prisma/schema.prisma`

## 附录：问题排查过程

1. 发现现象：iOS 列表看不到新项目 `claude-test`
2. 验证文件系统：目录存在且排第 3 个
3. 检查 API 返回：第 3 个项目 path 错误
4. 分析文件内容：发现一个目录有两个不同的 cwd
5. 定位代码逻辑：`collectProjects()` 取第一个 cwd 导致错误
6. 追溯根本原因：Claude Code 编码机制导致路径冲突
