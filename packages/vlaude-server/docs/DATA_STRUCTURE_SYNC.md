# ETerm 在线状态 - 数据结构同步文档

> 本文档记录 vlaude-server (NestJS) 与 Vlaude iOS App 之间的数据结构定义，
> 用于追踪格式不匹配问题。

## 问题背景

ETerm 显示在线，但 iOS 项目列表和 session 列表不显示"在线"状态。
原因是 API 返回数据时没有包含 ETerm 在线状态，完全依赖 WebSocket 事件广播，存在时序问题。

---

## 1. ProjectListResponse

### NestJS 端

**文件**: `src/module/project/project.controller.ts`
**行号**: 65-73

```typescript
return {
  success: true,
  data: this.serializeProjects(result.projects),
  total: result.total,
  hasMore: result.hasMore,
  // ETerm 在线状态（解决时序问题）
  etermOnline: this.daemonGateway.isEtermOnline(),       // boolean
  etermSessions: this.daemonGateway.getEtermSessions(),  // string[]
};
```

### iOS 端

**文件**: `Vlaude/Models/Project.swift`
**行号**: 22-27

```swift
struct ProjectListResponse: Codable {
    let success: Bool
    let data: [Project]
    let total: Int
    let hasMore: Bool
    // ❌ 缺少字段:
    // let etermOnline: Bool?
    // let etermSessions: [String]?
}
```

### 状态: ❌ 不匹配

iOS 端需要添加 `etermOnline` 和 `etermSessions` 字段。

---

## 2. SessionListResponse

### NestJS 端

**文件**: `src/module/session/session.controller.ts`
**行号**: 91-98

```typescript
return {
  success: true,
  data: this.serializeSessions(result.sessions),
  total: result.total,
  hasMore: result.hasMore,
  // ETerm 在线状态（解决时序问题）
  etermOnline: this.daemonGateway.isEtermOnline(),  // boolean
};
```

### iOS 端

**文件**: `Vlaude/Models/Session.swift`
**行号**: 38-44

```swift
struct SessionListResponse: Codable {
    let success: Bool
    let data: [Session]
    let total: Int
    let hasMore: Bool
    let etermOnline: Bool?  // ✅ 已有
}
```

### 状态: ✅ 匹配

---

## 3. Session 模型 (inEterm 字段)

### NestJS 端

**文件**: `src/module/session/session.controller.ts`
**行号**: 36-43

```typescript
private serializeSession(session: any) {
  if (!session) return session;
  return {
    ...session,
    lastFileSize: session.lastFileSize?.toString(),
    // 标记该 session 是否在 ETerm 中打开
    inEterm: this.daemonGateway.isSessionInEterm(session.sessionId),  // boolean
  };
}
```

### iOS 端

**文件**: `Vlaude/Models/Session.swift`
**行号**: 10-26

```swift
struct Session: Identifiable, Codable {
    let id: Int
    let sessionId: String
    let projectId: Int
    let messageCount: Int
    let lastMessageAt: Date?
    let createdAt: Date
    let updatedAt: Date
    var project: Project?
    var lastMessage: Message?
    // ETerm 状态：该 session 是否在 ETerm 中可用
    var inEterm: Bool?  // ✅ 已有
}
```

### 状态: ✅ 匹配

---

## 4. WebSocket: app:queryEtermStatus

### NestJS 端

**文件**: `src/gateway/app.gateway.ts`
**行号**: 975-989

```typescript
@SubscribeMessage('app:queryEtermStatus')
handleQueryEtermStatus(@ConnectedSocket() client: Socket) {
  const online = this.daemonGateway.isEtermOnline();
  const sessions = this.daemonGateway.getEtermSessions();

  // 直接返回对象，NestJS 会作为 ACK 响应发送
  // 客户端 emitWithAck 收到的响应格式: [{ online, sessions, timestamp }]
  return {
    online,       // boolean
    sessions,     // string[]
    timestamp: new Date().toISOString(),  // string (ISO8601)
  };
}
```

### iOS 端

**文件**: `Vlaude/Services/WebSocketManager.swift`
**状态**: 需要确认客户端代码（可能是本地未提交的修改）

**期望的调用方式**:
```swift
socket.emitWithAck("app:queryEtermStatus", [:]).timingOut(after: 5) { response in
    // response 是一个数组，第一个元素是服务端返回的对象
    guard let data = response.first as? [String: Any],
          let online = data["online"] as? Bool,
          let sessions = data["sessions"] as? [String] else {
        print("⚠️ [Socket.IO] ETerm 状态查询响应格式错误")
        return
    }
    // 使用 online 和 sessions
}
```

### 注意事项

NestJS `@SubscribeMessage` 的 `return` 会被包装为 Socket.IO ACK 响应：
- 客户端使用 `emitWithAck` 接收
- 响应是一个数组，返回的对象在第一个元素 `response[0]`
- 如果直接解析 `response.first as? { online, sessions }` 会成功
- 但如果期望的是嵌套格式 `response.first?.data` 则会失败

---

## 5. eterm:statusChanged 事件 (广播)

### NestJS 端

**文件**: `src/gateway/app.gateway.ts`
**行号**: 917-922

```typescript
@OnEvent('app.etermStatusChanged')
handleEtermStatusChangedEvent(data: { online: boolean; timestamp: string }) {
  this.server.emit('eterm:statusChanged', {
    online: data.online,
    timestamp: data.timestamp,
  });
}
```

### iOS 端

**文件**: `Vlaude/Services/WebSocketManager.swift`
**行号**: 257-269

```swift
private func handleEtermStatusChanged(data: [Any]) {
    guard let payload = data.first as? [String: Any],
          let online = payload["online"] as? Bool else {
        print("⚠️ [Socket.IO] eterm:statusChanged 数据格式错误")
        return
    }
    // ...
}
```

### 状态: ✅ 匹配

---

## 修复清单

| 问题 | 文件 | 状态 |
|------|------|------|
| ProjectListResponse 缺少 etermOnline | `Vlaude/Models/Project.swift:22-33` | ✅ 已修复 |
| ProjectListResponse 缺少 etermSessions | `Vlaude/Models/Project.swift:22-33` | ✅ 已修复 |
| app:queryEtermStatus 响应解析 | `Vlaude/Services/WebSocketManager.swift` | ⚠️ 需确认本地代码 |

---

## 更新历史

- **2026-01-01**: 修复 ProjectListResponse 缺少的字段，添加 @see 注释
- **2026-01-01**: 初始文档，记录 ETerm 在线状态同步问题
