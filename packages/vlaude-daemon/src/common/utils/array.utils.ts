/**
 * @description array utils
 * @author 阿怪
 * @date 2024/6/17 17:46
 * @version v1.0.0
 *
 * 江湖的业务千篇一律，复杂的代码好几百行。
 */


export const diffArr = <T>(oldArr: Array<T>, newArr: Array<T>) => {
  const oldSet = new Set(oldArr);
  const newSet = new Set(newArr);

  const removed = oldArr.filter(item => !newSet.has(item));
  const added = newArr.filter(item => !oldSet.has(item));
  return [added, removed];
};
