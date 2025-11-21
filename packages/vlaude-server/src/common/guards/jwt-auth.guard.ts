import { Injectable, CanActivate, ExecutionContext, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Socket } from 'socket.io';
import * as jwt from 'jsonwebtoken';
import { readFileSync } from 'fs';
import { join } from 'path';

export interface JwtPayload {
  clientId: string;
  clientType: 'daemon' | 'ios';
  iat?: number;
  exp?: number;
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly logger = new Logger(JwtAuthGuard.name);
  private readonly publicKey: string;
  private readonly ipWhitelist: string[];

  constructor(private configService: ConfigService) {
    // 加载 JWT 公钥
    const publicKeyPath = this.configService.get<string>('JWT_PUBLIC_KEY_PATH');
    if (!publicKeyPath) {
      throw new Error('JWT_PUBLIC_KEY_PATH 未配置');
    }

    try {
      const fullPath = join(process.cwd(), publicKeyPath);
      this.publicKey = readFileSync(fullPath, 'utf-8');
      this.logger.log(`✅ JWT 公钥已加载: ${publicKeyPath}`);
    } catch (error) {
      throw new Error(`无法加载 JWT 公钥: ${error.message}`);
    }

    // 解析 IP 白名单
    const ipWhitelistConfig = this.configService.get<string>('IP_WHITELIST', '');
    this.ipWhitelist = ipWhitelistConfig
      .split(',')
      .map((ip) => ip.trim())
      .filter(Boolean);

    this.logger.log(`✅ IP 白名单: ${this.ipWhitelist.join(', ')}`);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const contextType = context.getType();

    if (contextType === 'ws') {
      return this.validateWebSocket(context);
    }

    // HTTP 场景
    return this.validateHttp(context);
  }

  /**
   * 验证 WebSocket 连接
   */
  private validateWebSocket(context: ExecutionContext): boolean {
    const client: Socket = context.switchToWs().getClient();
    const clientIp = this.getClientIp(client);

    // IP 白名单豁免
    if (this.isWhitelistedIp(clientIp)) {
      this.logger.log(`🔓 [JWT] 内网 IP ${clientIp} 豁免认证`);
      client.data.user = { clientId: 'internal', clientType: 'daemon' };
      return true;
    }

    // 外网必须验证 Token
    const token = this.extractTokenFromSocket(client);

    if (!token) {
      this.logger.warn(`❌ [JWT] 连接缺少 Token: ${client.id} (IP: ${clientIp})`);
      return false;
    }

    try {
      const payload = jwt.verify(token, this.publicKey, {
        algorithms: ['RS256'],
      }) as JwtPayload;

      client.data.user = payload;
      this.logger.log(`✅ [JWT] WebSocket 认证成功: ${client.id} (${payload.clientId})`);
      return true;
    } catch (error) {
      this.logger.error(`❌ [JWT] WebSocket 认证失败: ${client.id} - ${error.message}`);
      return false;
    }
  }

  /**
   * 验证 HTTP 请求
   */
  private validateHttp(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const clientIp = this.getClientIpFromRequest(request);

    // IP 白名单豁免
    if (this.isWhitelistedIp(clientIp)) {
      this.logger.log(`🔓 [JWT] 内网 IP ${clientIp} 豁免认证`);
      request.user = { clientId: 'internal', clientType: 'daemon' };
      return true;
    }

    // 外网必须验证 Token
    const token = this.extractTokenFromRequest(request);

    if (!token) {
      this.logger.warn(`❌ [JWT] 请求缺少 Token: ${request.url} (IP: ${clientIp})`);
      return false;
    }

    try {
      const payload = jwt.verify(token, this.publicKey, {
        algorithms: ['RS256'],
      }) as JwtPayload;

      request.user = payload;
      this.logger.log(`✅ [JWT] HTTP 认证成功: ${request.url} (${payload.clientId})`);
      return true;
    } catch (error) {
      this.logger.error(`❌ [JWT] HTTP 认证失败: ${request.url} - ${error.message}`);
      return false;
    }
  }

  /**
   * 从 Socket 提取客户端 IP
   */
  private getClientIp(socket: Socket): string {
    const handshake = socket.handshake;

    // 优先从 X-Forwarded-For 获取（反向代理场景）
    const forwardedFor = handshake.headers['x-forwarded-for'];
    if (forwardedFor) {
      const ip = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
      return ip.split(',')[0].trim();
    }

    // X-Real-IP
    const realIp = handshake.headers['x-real-ip'];
    if (realIp) {
      return Array.isArray(realIp) ? realIp[0] : realIp;
    }

    // 直连场景
    return handshake.address || 'unknown';
  }

  /**
   * 从 HTTP Request 提取客户端 IP
   */
  private getClientIpFromRequest(request: any): string {
    const forwardedFor = request.headers['x-forwarded-for'];
    if (forwardedFor) {
      return forwardedFor.split(',')[0].trim();
    }

    const realIp = request.headers['x-real-ip'];
    if (realIp) {
      return realIp;
    }

    return request.ip || request.connection?.remoteAddress || 'unknown';
  }

  /**
   * 从 Socket 提取 Token
   */
  private extractTokenFromSocket(socket: Socket): string | null {
    // 方式 1: socket.handshake.auth.token
    const authToken = socket.handshake.auth?.token;
    if (authToken) return authToken;

    // 方式 2: socket.handshake.query.token
    const queryToken = socket.handshake.query?.token;
    if (queryToken) {
      return Array.isArray(queryToken) ? queryToken[0] : queryToken;
    }

    return null;
  }

  /**
   * 从 HTTP Request 提取 Token
   */
  private extractTokenFromRequest(request: any): string | null {
    // 方式 1: Authorization: Bearer <token>
    const authHeader = request.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
      return authHeader.substring(7);
    }

    // 方式 2: Query 参数 ?token=xxx
    const queryToken = request.query?.token;
    if (queryToken) return queryToken;

    return null;
  }

  /**
   * 检查 IP 是否在白名单中
   */
  private isWhitelistedIp(ip: string): boolean {
    if (!ip || ip === 'unknown') return false;

    // 精确匹配
    if (this.ipWhitelist.includes(ip)) return true;

    // CIDR 匹配
    return this.ipWhitelist.some((cidr) => this.ipInCidr(ip, cidr));
  }

  /**
   * 检查 IP 是否在 CIDR 范围内
   */
  private ipInCidr(ip: string, cidr: string): boolean {
    // 如果不是 CIDR 格式，直接比较
    if (!cidr.includes('/')) return ip === cidr;

    const [subnet, bits] = cidr.split('/');
    const mask = ~(2 ** (32 - parseInt(bits, 10)) - 1);
    const ipNum = this.ipToNumber(ip);
    const subnetNum = this.ipToNumber(subnet);

    return (ipNum & mask) === (subnetNum & mask);
  }

  /**
   * 将 IP 地址转换为数字
   */
  private ipToNumber(ip: string): number {
    return (
      ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0
    );
  }
}
