/**
 * @description string decorator
 * @author 阿怪
 * @date 2024/6/12 23:52
 * @version v1.0.0
 *
 * 江湖的业务千篇一律，复杂的代码好几百行。
 */
import { Transform } from 'class-transformer';


export function MString(): PropertyDecorator {
  return function (target, propertyKey): void {
    return Transform(({ value }) => String(value))(target, propertyKey);
  };
}
