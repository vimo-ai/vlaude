/**
 * @description Namespace Prisma 仓储实现
 * @author Claude Code
 * @date 2025-11-13
 * @version v1.0.0
 */

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/database/service/prisma.service';
import { NamespaceDomainRepo } from '../../domain/repos/namespace.domain.repo';
import { NamespaceAR } from '../../domain/ar/namespace.ar';

@Injectable()
export class NamespacePrismaRepo implements NamespaceDomainRepo {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: number): Promise<NamespaceAR | null> {
    const doEntity = await this.prisma.namespace.findFirst({
      where: { id, delete: false },
    });

    if (!doEntity) {
      return null;
    }

    return NamespaceAR.fromDO(doEntity);
  }

  async findByChannelAndNamespace(channel: string, namespace: string): Promise<NamespaceAR | null> {
    const doEntity = await this.prisma.namespace.findFirst({
      where: {
        channel,
        namespace,
        delete: false,
      },
    });

    if (!doEntity) {
      return null;
    }

    return NamespaceAR.fromDO(doEntity);
  }

  async findByChannel(channel: string): Promise<NamespaceAR[]> {
    const doEntities = await this.prisma.namespace.findMany({
      where: {
        channel,
        delete: false,
      },
      orderBy: { createdAt: 'desc' },
    });

    return doEntities.map((doEntity) => NamespaceAR.fromDO(doEntity));
  }

  async save(namespace: NamespaceAR): Promise<NamespaceAR> {
    const doEntity = await this.prisma.namespace.create({
      data: namespace.toDO() as any,
    });

    return NamespaceAR.fromDO(doEntity);
  }

  async remove(id: number): Promise<void> {
    await this.prisma.namespace.update({
      where: { id },
      data: { delete: true },
    });
  }
}
