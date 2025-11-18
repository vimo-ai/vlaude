/**
 * @Description: 日期的几个tools
 * @Author: 阿怪
 * @Date: 2022/2/1 2:38 PM
 * @Version v1.0.0
 *
 * 江湖的业务千篇一律，复杂的代码好几百行。
 */

import dayjs, { ConfigType } from 'dayjs';

const DATE_FORMAT = 'YYYY-MM-DD HH:mm:ss';

/**
 * 通用的日期格式化
 * @param value 日期
 */
export const dayFormat = (value: ConfigType) => dayjs(value).format(DATE_FORMAT);

/**
 * 用于@Column配置的日期转换方法
 */
export const transformer = {
  to: value => value,
  from: (value: Date) => {
    if (value === null || value === undefined) {
      return '';
    }
    return dayFormat(value);
  },
};


export const toDate = (value: string | Date) => dayjs(value).toDate();
