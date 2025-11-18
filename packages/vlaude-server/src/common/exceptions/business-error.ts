/**
 * @description 优雅的业务异常
 * 直接包含HTTP状态码和用户友好消息，无需字符串匹配
 */
export class BusinessError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string
  ) {
    super(message);
    this.name = 'BusinessError';
  }

  // 工厂方法，提供语义化创建
  static forbidden(message: string) {
    return new BusinessError(403, message);
  }

  static badRequest(message: string) {
    return new BusinessError(400, message);
  }

  static notFound(message: string) {
    return new BusinessError(404, message);
  }

  static conflict(message: string) {
    return new BusinessError(409, message);
  }

  static unauthorized(message: string) {
    return new BusinessError(401, message);
  }

  static internalServerError(message: string) {
    return new BusinessError(500, message);
  }
}
