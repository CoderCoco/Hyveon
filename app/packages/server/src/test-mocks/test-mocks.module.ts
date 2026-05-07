import { Module } from '@nestjs/common';
import { TestMocksController } from './test-mocks.controller.js';

/** Nest module exposing mock-control endpoints. Only imported by TestAppModule in test-main.ts. */
@Module({
  controllers: [TestMocksController],
})
export class TestMocksModule {}
