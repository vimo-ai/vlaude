/**
 * @description Repository Prisma 仓储实现
 * @author Claude Code
 * @date 2025-11-12
 * @version v1.0.0
 */

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/database/service/prisma.service';
import { RepositoryDomainRepo } from '../../domain/repos/repository.domain.repo';
import { RepositoryAR } from '../../domain/ar/repository.ar';

@Injectable()
export class RepositoryPrismaRepo implements RepositoryDomainRepo {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: number): Promise<RepositoryAR | null> {
    const doEntity = await this.prisma.repository.findFirst({
      where: { id, delete: false },
    });

    if (!doEntity) {
      return null;
    }

    return RepositoryAR.fromDO(doEntity);
  }

  async findByNamespaceId(namespaceId: number): Promise<RepositoryAR[]> {
    const doEntities = await this.prisma.repository.findMany({
      where: {
        namespaceId,
        delete: false,
      },
      orderBy: { createdAt: 'desc' },
    });

    return doEntities.map((doEntity) => RepositoryAR.fromDO(doEntity));
  }

  async findByGitUrl(gitUrl: string): Promise<RepositoryAR | null> {
    const doEntity = await this.prisma.repository.findFirst({
      where: { gitUrl, delete: false },
    });

    if (!doEntity) {
      return null;
    }

    return RepositoryAR.fromDO(doEntity);
  }

  async save(repository: RepositoryAR): Promise<RepositoryAR> {
    const doEntity = await this.prisma.repository.create({
      data: repository.toDO() as any,
    });

    return RepositoryAR.fromDO(doEntity);
  }

  async update(id: number, data: Partial<RepositoryAR>): Promise<RepositoryAR> {
    const doEntity = await this.prisma.repository.update({
      where: { id },
      data: data as any,
    });

    return RepositoryAR.fromDO(doEntity);
  }

  async remove(id: number): Promise<void> {
    await this.prisma.repository.update({
      where: { id },
      data: { delete: true },
    });
  }
}
