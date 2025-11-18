/**
 * @description context decorator
 * @author 阿怪
 * @date 2024/7/15 00:22
 * @version v1.0.0
 *
 * 江湖的业务千篇一律，复杂的代码好几百行。
 */
import { Module } from '@nestjs/common';
import { ModuleMetadata } from '@nestjs/common/interfaces/modules/module-metadata.interface';
import { PrismaModule } from '../../shared/database/prisma.module';
// import { MLogModule } from '../../module/log/mLog.module';

type P = ModuleMetadata['providers'];
export function MContext(meta: {
  imports?: ModuleMetadata['imports'],
  mapping?: ModuleMetadata['imports'],
  controller?: ModuleMetadata['controllers'],
  api?: {
    strategies?: P,
    guards?: P,
    interceptors?: P,
    filters?: P,
  },
  application?: {
    command?: P,
    event?: P,
    machine?: P,
    services?: P,
    strategies?: P
  },
  domain?: {
    factories?: P,
    aggregateRoots?: P,
    services?: P
  },
  providers?: P,
}) {


  const exports = [
    ...meta.application?.command ?? [],
    ...meta.application?.event ?? [],
    ...meta.application?.machine ?? [],
    ...meta.application?.services ?? [],
    ...meta.application?.strategies ?? [],
    ...meta.api?.strategies ?? [],
    ...meta.api?.guards ?? [],
    ...meta.api?.interceptors ?? [],
    ...meta.api?.filters ?? [],
    ...meta.domain?.factories ?? [],
  ];

  const providers = [
    ...meta.domain?.services ?? [],
    ...meta.domain?.aggregateRoots ?? [],
    ...exports,
  ];


  return Module({
    imports: [
      PrismaModule,
      // MLogModule,
      ...meta.imports??[],
      ...meta.mapping??[],
    ],
    controllers: meta.controller,
    providers,
    exports,
  });
}
