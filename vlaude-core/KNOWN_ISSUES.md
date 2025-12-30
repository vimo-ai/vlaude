# Known Issues

## emit_with_ack Callback Not Triggering

**Status**: Workaround Applied
**Severity**: Low
**Component**: `socket-client`

### Description

`rust_socketio 0.6` 的 `emit_with_ack` 方法在某些情况下回调不会被触发。表现为：

- 调用 `emit_with_ack` 发送事件后，服务器的 ack 响应无法触发回调
- oneshot channel 永远收不到数据，导致等待超时

### Root Cause

rust_socketio 库存在已知的 ack 相关问题：

- [Issue #422](https://github.com/1c3t3a/rust-socketio/issues/422): binary data 导致回调不执行（已修复）
- [Issue #461](https://github.com/1c3t3a/rust-socketio/issues/461): 服务器发送需要 ack 的消息时客户端无法响应（仍开放）

具体触发条件尚不明确，可能与 NestJS socket.io 服务器的响应格式有关。

### Current Workaround

在 `socket-client/src/client.rs` 中，`register()` 等方法改用普通 `emit` 代替 `emit_with_ack`：

```rust
pub async fn register(&self, data: RegisterData) -> Result<Value, SocketError> {
    // 暂时用普通 emit，避免 ack 阻塞问题
    self.emit("daemon:register", serde_json::to_value(data).unwrap()).await?;
    Ok(json!({"success": true}))  // 假设成功
}
```

### Impact

- 无法确认服务器是否收到事件
- 对于非关键性操作（如注册、状态上报），可以接受
- 服务器会通过后续通信验证状态，不会造成数据丢失

### Potential Solutions

1. **升级 rust_socketio**: 等待库更新，跟踪相关 issue
2. **改用事件模式**: 不依赖 ack，用双向事件实现请求-响应
   ```
   Client: emit("daemon:register", data)
   Server: emit("server:registerResult", result)
   ```
3. **接受限制**: 对于非关键操作，忽略 ack 是可接受的

### References

- [rust-socketio GitHub](https://github.com/1c3t3a/rust-socketio)
- TypeScript daemon 使用 socket.io-client，ack 正常工作
- VlaudeKit (Swift) 使用 socket.io-client-swift，ack 正常工作
