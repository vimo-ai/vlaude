/**
 * @description number decorator
 * @author 阿怪
 * @date 2024/6/12 23:05
 * @version v1.0.0
 *
 * 江湖的业务千篇一律，复杂的代码好几百行。
 */
import { Transform } from 'class-transformer';


export function MNumber(): PropertyDecorator {
  return function (target, propertyKey): void {
    return Transform(({ value }) => Number(value))(target, propertyKey);
  };
}
