/**
 * @description Repository 领域仓储接口
 * @author Claude Code
 * @date 2025-11-12
 * @version v1.0.0
 */

import { RepositoryAR } from '../ar/repository.ar';

export const REPOSITORY_DOMAIN_REPO = Symbol('REPOSITORY_DOMAIN_REPO');

export interface RepositoryDomainRepo {
  /**
   * 根据ID查找仓库
   */
  findById(id: number): Promise<RepositoryAR | null>;

  /**
   * 根据 namespaceId 查找仓库列表
   */
  findByNamespaceId(namespaceId: number): Promise<RepositoryAR[]>;

  /**
   * 根据gitUrl查找仓库
   */
  findByGitUrl(gitUrl: string): Promise<RepositoryAR | null>;

  /**
   * 保存仓库
   */
  save(repository: RepositoryAR): Promise<RepositoryAR>;

  /**
   * 更新仓库
   */
  update(id: number, data: Partial<RepositoryAR>): Promise<RepositoryAR>;

  /**
   * 删除仓库 (软删除)
   */
  remove(id: number): Promise<void>;
}
