import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly privateKey: string;

  constructor(private configService: ConfigService) {
    const privateKeyPath = this.configService.get<string>('JWT_PRIVATE_KEY_PATH');

    if (!privateKeyPath) {
      throw new Error('JWT_PRIVATE_KEY_PATH 未配置');
    }

    try {
      const fullPath = join(process.cwd(), privateKeyPath);
      this.privateKey = readFileSync(fullPath, 'utf-8');
      this.logger.log(`✅ JWT 私钥已加载: ${privateKeyPath}`);
    } catch (error) {
      throw new Error(`无法加载 JWT 私钥: ${error.message}`);
    }
  }

  /**
   * 生成 JWT Token
   */
  generateToken(clientId: string, clientType: 'daemon' | 'ios'): string {
    const expiresIn = this.configService.get<string>('JWT_EXPIRES_IN', '7d');

    const token = jwt.sign(
      { clientId, clientType },
      this.privateKey,
      {
        algorithm: 'RS256',
        expiresIn,
      }
    );

    this.logger.log(`🔑 生成 Token: clientId=${clientId}, clientType=${clientType}, expiresIn=${expiresIn}`);
    return token;
  }
}
