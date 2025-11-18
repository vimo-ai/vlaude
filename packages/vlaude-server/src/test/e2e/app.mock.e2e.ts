/**
 * @description
 * @author 阿怪
 * @date 2024/12/11 11:09
 * @version v1.0.0
 *
 * 江湖的业务千篇一律，复杂的代码好几百行。
 */

import { beforeAll, describe, it } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from '../../app.module';

beforeAll(async () => {
  console.log('in before all');
  try {
    const module: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    await module.init();
    console.log('init over');
  } catch (e) {
    console.log('出异常了');
    console.error(e);
  }
});
