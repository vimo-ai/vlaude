/**
 * @description
 * @author 阿怪
 * @date 2024/7/3 11:35
 * @version v1.0.0
 *
 * 江湖的业务千篇一律，复杂的代码好几百行。
 */


import { Body, Injectable, PipeTransform, Type } from '@nestjs/common';

@Injectable()
export class BodyTransPipe implements PipeTransform {

  constructor(private clazz?: Type<any>) {}

  transform(value: any) {
    value.clearParams?.();
    return value;
  }
}


export function MBody(clazz?: Type<any>) {
  return Body(new BodyTransPipe(clazz));
}
