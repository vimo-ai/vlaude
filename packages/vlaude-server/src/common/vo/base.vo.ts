/**
 * @description base vo
 * @author 阿怪
 * @date 2024/6/13 00:09
 * @version v1.0.0
 *
 * 江湖的业务千篇一律，复杂的代码好几百行。
 */
import { MBoolean, MDate } from '../transform/decorator';

export const BASE_APPLY_KEYS = ['delete', 'createTime', 'modifyTime'];

export class BaseVO {
  @MBoolean()
  delete?: boolean;

  @MDate()
  createTime?: Date;

  @MDate()
  modifyTime?: Date;

}
