import Redis from 'ioredis';

/**
 * 服务注册事件类型
 */
export type ServiceEventType = 'online' | 'offline';

/**
 * 服务注册事件
 */
export interface ServiceEvent {
  /** 事件类型 */
  type: ServiceEventType;
  /** 服务名称 */
  service: string;
  /** 服务地址 */
  address: string;
  /** 时间戳 */
  timestamp: number;
}

/**
 * 服务信息
 */
export interface ServiceInfo {
  /** 服务地址 */
  address: string;
  /** TTL（秒） */
  ttl: number;
  /** 注册时间戳 */
  registeredAt: number;
}

/**
 * Redis 服务注册中心配置
 */
export interface ServiceRegistryConfig {
  /** Redis 连接地址 */
  host: string;
  /** Redis 端口 */
  port: number;
  /** Redis 密码（可选） */
  password?: string;
  /** Key 前缀 */
  keyPrefix?: string;
}

/**
 * Redis 服务注册中心
 * 用于服务发现和管理，解决 Server 重启后各组件自动重连的问题
 */
export class ServiceRegistry {
  private redis: Redis;
  private subscriber: Redis;
  private readonly keyPrefix: string;
  private readonly channel: string;
  private eventCallbacks: Set<(event: ServiceEvent) => void> = new Set();
  private keepAliveTimers: Map<string, NodeJS.Timeout> = new Map();

  constructor(config: ServiceRegistryConfig) {
    const { host, port, password, keyPrefix = 'vlaude:' } = config;

    this.keyPrefix = keyPrefix;
    this.channel = `${keyPrefix}channel:service-registry`;

    // 创建 Redis 客户端
    this.redis = new Redis({
      host,
      port,
      password,
      retryStrategy: (times: number) => {
        const delay = Math.min(times * 1000, 5000);
        return delay;
      },
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: false,
    });

    // 创建订阅客户端（独立连接）
    this.subscriber = this.redis.duplicate();

    // 监听 Redis 连接事件
    this.redis.on('error', (err: Error) => {
      console.error('[ServiceRegistry] Redis 连接错误:', err.message);
    });

    this.redis.on('connect', () => {
      console.log('[ServiceRegistry] Redis 连接成功');
    });

    this.subscriber.on('error', (err: Error) => {
      console.error('[ServiceRegistry] Redis 订阅客户端错误:', err.message);
    });
  }

  /**
   * 注册服务
   * @param service 服务名称（例如: "server"）
   * @param address 服务地址（例如: "localhost:10005"）
   * @param ttl 过期时间（秒）
   */
  async register(service: string, address: string, ttl: number): Promise<void> {
    const key = this.buildServiceKey(service, address);
    const value = JSON.stringify({
      address,
      ttl,
      registeredAt: Date.now(),
    } as ServiceInfo);

    try {
      await this.redis.setex(key, ttl, value);
      console.log(`[ServiceRegistry] 注册服务: ${service}@${address} (TTL: ${ttl}s)`);

      // 发布 online 事件
      await this.publishEvent({
        type: 'online',
        service,
        address,
        timestamp: Date.now(),
      });
    } catch (error) {
      const err = error as Error;
      console.error(`[ServiceRegistry] 注册失败: ${err.message}`);
      throw error;
    }
  }

  /**
   * 注销服务
   * @param service 服务名称
   * @param address 服务地址
   */
  async unregister(service: string, address: string): Promise<void> {
    const key = this.buildServiceKey(service, address);

    try {
      await this.redis.del(key);
      console.log(`[ServiceRegistry] 注销服务: ${service}@${address}`);

      // 发布 offline 事件
      await this.publishEvent({
        type: 'offline',
        service,
        address,
        timestamp: Date.now(),
      });
    } catch (error) {
      const err = error as Error;
      console.error(`[ServiceRegistry] 注销失败: ${err.message}`);
      throw error;
    }
  }

  /**
   * 续期服务（保持心跳）
   * @param service 服务名称
   * @param address 服务地址
   * @param ttl 过期时间（秒）
   */
  async keepAlive(service: string, address: string, ttl: number): Promise<void> {
    const key = this.buildServiceKey(service, address);

    try {
      const exists = await this.redis.exists(key);
      if (exists) {
        await this.redis.expire(key, ttl);
      } else {
        // 如果 Key 不存在（可能是过期了），重新注册
        await this.register(service, address, ttl);
      }
    } catch (error) {
      const err = error as Error;
      console.error(`[ServiceRegistry] 续期失败: ${err.message}`);
      throw error;
    }
  }

  /**
   * 启动自动续期定时器
   * @param service 服务名称
   * @param address 服务地址
   * @param ttl 过期时间（秒）
   * @param interval 续期间隔（毫秒，默认 TTL 的一半）
   */
  startKeepAlive(service: string, address: string, ttl: number, interval?: number): void {
    const timerKey = `${service}@${address}`;

    // 如果已经存在定时器，先清除
    this.stopKeepAlive(service, address);

    // 计算续期间隔（默认为 TTL 的一半）
    const keepAliveInterval = interval || (ttl * 1000) / 2;

    const timer = setInterval(async () => {
      try {
        await this.keepAlive(service, address, ttl);
      } catch (error) {
        const err = error as Error;
        console.error(`[ServiceRegistry] 自动续期失败: ${err.message}`);
      }
    }, keepAliveInterval);

    this.keepAliveTimers.set(timerKey, timer);
    console.log(`[ServiceRegistry] 启动自动续期: ${service}@${address} (间隔: ${keepAliveInterval}ms)`);
  }

  /**
   * 停止自动续期定时器
   * @param service 服务名称
   * @param address 服务地址
   */
  stopKeepAlive(service: string, address: string): void {
    const timerKey = `${service}@${address}`;
    const timer = this.keepAliveTimers.get(timerKey);

    if (timer) {
      clearInterval(timer);
      this.keepAliveTimers.delete(timerKey);
      console.log(`[ServiceRegistry] 停止自动续期: ${service}@${address}`);
    }
  }

  /**
   * 订阅服务注册事件
   * @param callback 事件回调函数
   */
  async subscribe(callback: (event: ServiceEvent) => void): Promise<void> {
    // 添加回调到集合
    this.eventCallbacks.add(callback);

    // 如果是第一次订阅，启动 Redis 订阅
    if (this.eventCallbacks.size === 1) {
      await this.subscriber.subscribe(this.channel);

      this.subscriber.on('message', (channel: string, message: string) => {
        if (channel === this.channel) {
          try {
            const event = JSON.parse(message) as ServiceEvent;
            // 通知所有回调
            this.eventCallbacks.forEach((cb) => cb(event));
          } catch (error) {
            const err = error as Error;
            console.error('[ServiceRegistry] 解析事件失败:', err.message);
          }
        }
      });

      console.log(`[ServiceRegistry] 已订阅事件: ${this.channel}`);
    }
  }

  /**
   * 取消订阅
   * @param callback 事件回调函数
   */
  async unsubscribe(callback: (event: ServiceEvent) => void): Promise<void> {
    this.eventCallbacks.delete(callback);

    // 如果没有回调了，取消 Redis 订阅
    if (this.eventCallbacks.size === 0) {
      await this.subscriber.unsubscribe(this.channel);
      console.log(`[ServiceRegistry] 已取消订阅: ${this.channel}`);
    }
  }

  /**
   * 获取所有 Server，按优先级排序
   * 优先级规则：
   * 1. localhost:* 最高
   * 2. 192.168.*:* 次之
   * 3. 域名（如 homenas.higuaifan.com:*）最低
   */
  async getServers(): Promise<string[]> {
    try {
      const pattern = this.buildServiceKey('server', '*');
      const keys = await this.redis.keys(pattern);

      if (keys.length === 0) {
        return [];
      }

      // 提取所有地址
      const addresses: string[] = [];
      for (const key of keys) {
        const value = await this.redis.get(key);
        if (value) {
          const info = JSON.parse(value) as ServiceInfo;
          addresses.push(info.address);
        }
      }

      // 按优先级排序
      return this.sortByPriority(addresses);
    } catch (error) {
      const err = error as Error;
      console.error('[ServiceRegistry] 获取 Server 列表失败:', err.message);
      return [];
    }
  }

  /**
   * 断开连接
   */
  async disconnect(): Promise<void> {
    // 停止所有自动续期定时器
    for (const [key] of this.keepAliveTimers) {
      const [service, address] = key.split('@');
      this.stopKeepAlive(service, address);
    }

    // 断开 Redis 连接
    await this.redis.quit();
    await this.subscriber.quit();

    console.log('[ServiceRegistry] 已断开连接');
  }

  /**
   * 构建服务 Key
   * 格式: vlaude:services:server:{address}
   */
  private buildServiceKey(service: string, address: string): string {
    return `${this.keyPrefix}services:${service}:${address}`;
  }

  /**
   * 发布服务事件
   */
  private async publishEvent(event: ServiceEvent): Promise<void> {
    try {
      await this.redis.publish(this.channel, JSON.stringify(event));
    } catch (error) {
      const err = error as Error;
      console.error('[ServiceRegistry] 发布事件失败:', err.message);
    }
  }

  /**
   * 按优先级排序地址列表
   * 优先级规则：
   * 1. localhost:* 最高
   * 2. 192.168.*:* 次之
   * 3. 域名最低
   */
  private sortByPriority(addresses: string[]): string[] {
    return addresses.sort((a, b) => {
      const priorityA = this.getPriority(a);
      const priorityB = this.getPriority(b);
      return priorityB - priorityA; // 降序排序（高优先级在前）
    });
  }

  /**
   * 获取地址的优先级
   * @returns 优先级数字（越大越优先）
   */
  private getPriority(address: string): number {
    const host = address.split(':')[0];

    // localhost 最高
    if (host === 'localhost' || host === '127.0.0.1') {
      return 3;
    }

    // 内网 IP 次之
    if (host.startsWith('192.168.') || host.startsWith('10.') || host.startsWith('172.')) {
      return 2;
    }

    // 域名最低
    return 1;
  }
}
