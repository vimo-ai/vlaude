# Redis 服务注册中心

## 概述

通过 Redis 实现服务发现，解决 Server 重启后各组件自动重连的问题。

## 架构设计

### 组件角色

1. **vlaude-server**: 服务提供者
   - 启动时注册到 Redis
   - 定期续期（每 30 秒）
   - 关闭时注销

2. **vlaude-daemon**: 服务消费者
   - 启动时从 Redis 获取 Server 列表
   - 订阅服务事件
   - 根据优先级自动选择和切换 Server

3. **shared-core/ServiceRegistry**: 服务注册模块
   - 提供服务注册、注销、续期功能
   - 实现 Pub/Sub 事件通知
   - 管理服务列表和优先级排序

## 连接优先级

Daemon 会按以下优先级自动选择 Server：

1. **localhost:*** - 最高优先级（开发环境）
2. **192.168.*:*** - 次优先级（内网环境）
3. **域名** - 最低优先级（如 homenas.higuaifan.com:10005）

## 配置说明

### Redis 配置

在 `.env` 文件中配置 Redis 连接信息：

```bash
# Redis 配置
REDIS_HOST=192.168.50.9
REDIS_PORT=6379
REDIS_PASSWORD=  # 可选，无密码则留空
```

### Server 地址配置

在 vlaude-server 的 `.env` 文件中配置自己的地址：

```bash
# Server 地址（用于注册到 Redis）
SERVER_ADDRESS=localhost:10005
# 或者
SERVER_ADDRESS=192.168.50.9:10005
# 或者
SERVER_ADDRESS=homenas.higuaifan.com:10005
```

## Redis Key 格式

### 服务注册 Key

```
vlaude:services:server:{address}
```

示例：
- `vlaude:services:server:localhost:10005`
- `vlaude:services:server:192.168.50.9:10005`
- `vlaude:services:server:homenas.higuaifan.com:10005`

Key 的值是一个 JSON 对象：

```json
{
  "address": "localhost:10005",
  "ttl": 60,
  "registeredAt": 1733993472000
}
```

### Pub/Sub Channel

```
vlaude:channel:service-registry
```

事件格式：

```json
{
  "type": "online",  // 或 "offline"
  "service": "server",
  "address": "localhost:10005",
  "timestamp": 1733993472000
}
```

## 工作流程

### Server 启动流程

1. Server 启动时创建 `RegistryService`
2. 调用 `registry.register('server', address, 60)` 注册服务
3. 启动自动续期定时器（每 30 秒调用 `keepAlive`）
4. 发布 `online` 事件到 Redis Pub/Sub

### Daemon 启动流程

1. Daemon 启动时创建 `ServiceRegistry` 实例
2. 调用 `registry.subscribe()` 订阅服务事件
3. 调用 `registry.getServers()` 获取可用 Server 列表
4. 按优先级排序，选择最高优先级的 Server
5. 连接到选中的 Server

### Server 下线流程

1. Server 关闭时调用 `registry.unregister()` 注销服务
2. 删除 Redis 中的 Key
3. 发布 `offline` 事件
4. Daemon 收到 `offline` 事件后切换到下一个可用 Server

### Server 重启流程

1. Server 重启时重新注册（触发 `online` 事件）
2. Daemon 收到 `online` 事件
3. 检查新 Server 的优先级
4. 如果优先级更高，自动切换连接

## 故障处理

### Redis 连接失败

- **Server**: 优雅降级，继续运行但无法被自动发现（依赖手动配置）
- **Daemon**: 回退到环境变量配置的 `SERVER_URL`

### Server 全部下线

- Daemon 会等待 Server 上线
- 收到 `online` 事件后自动连接

### Server TTL 过期

- Server 会自动续期（每 30 秒）
- 如果 Server 异常退出未注销，Redis Key 会在 60 秒后自动过期
- Daemon 收到过期通知后切换到其他 Server

## 调试命令

### 查看 Redis 中的所有 Server

```bash
redis-cli -h 192.168.50.9 -p 6379 keys "vlaude:services:server:*"
```

### 查看某个 Server 的详细信息

```bash
redis-cli -h 192.168.50.9 -p 6379 get "vlaude:services:server:localhost:10005"
```

### 订阅服务事件

```bash
redis-cli -h 192.168.50.9 -p 6379 subscribe "vlaude:channel:service-registry"
```

### 手动清理所有注册信息

```bash
redis-cli -h 192.168.50.9 -p 6379 del $(redis-cli -h 192.168.50.9 -p 6379 keys "vlaude:services:server:*")
```

## 注意事项

1. **Redis 可用性**: 确保 Redis 服务可用，否则服务发现功能将失效
2. **网络隔离**: 如果 Daemon 和 Server 不在同一网络，需要确保能访问 Redis
3. **多 Server 场景**: 支持多个 Server 同时注册，Daemon 会自动选择最优的
4. **环境切换**: iOS 仍需通过 `switch-env.sh` 手动切换，Daemon 会自动发现

## 环境切换（仅 iOS）

Daemon 现在通过 Redis 服务发现自动连接，无需手动切换环境。

但 iOS 应用仍需使用脚本切换：

```bash
# 切换到 NAS 环境
./scripts/switch-env.sh nas

# 切换到本地环境
./scripts/switch-env.sh local

# 查看当前环境
./scripts/switch-env.sh status
```

## 未来计划

- [ ] ETerm 也接入服务发现
- [ ] iOS 也使用服务发现（需要在 Swift 中实现 Redis 客户端）
- [ ] 增加健康检查机制
- [ ] 增加负载均衡策略
