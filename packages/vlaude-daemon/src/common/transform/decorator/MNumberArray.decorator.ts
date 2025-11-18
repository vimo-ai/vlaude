/**
 * @description number array decorator
 * @author 阿怪
 * @date 2024/6/17 23:08
 * @version v1.0.0
 *
 * 江湖的业务千篇一律，复杂的代码好几百行。
 */
import { Transform } from 'class-transformer';


export function MNumberArray(): PropertyDecorator {
  return function (target, propertyKey): void {
    return Transform(({ value }) => {
      return value.split(',').map(Number);
    })(target, propertyKey);
  };
}
