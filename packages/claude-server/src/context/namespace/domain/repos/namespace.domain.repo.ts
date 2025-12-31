/**
 * @description Namespace Domain Repository Interface
 * @author Claude Code
 * @date 2025-11-13
 * @version v1.0.0
 */

import { NamespaceAR } from '../ar/namespace.ar';

export const NAMESPACE_DOMAIN_REPO = Symbol('NAMESPACE_DOMAIN_REPO');

export interface NamespaceDomainRepo {
  findById(id: number): Promise<NamespaceAR | null>;
  findByChannelAndNamespace(channel: string, namespace: string): Promise<NamespaceAR | null>;
  findByChannel(channel: string): Promise<NamespaceAR[]>;
  save(namespace: NamespaceAR): Promise<NamespaceAR>;
  remove(id: number): Promise<void>;
}
