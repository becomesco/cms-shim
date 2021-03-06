import type { Request, Router } from 'express';
import type {
  ControllerPrototype,
  Logger,
} from '@becomes/purple-cheetah';
import {
  Controller,
  HttpErrorFactory,
  Post,
} from '@becomes/purple-cheetah';
import { ConnectionService } from '../services';
import type { ShimInstanceUser } from '../types';
import { Const } from '../util';

@Controller('/shim/instance/user')
export class ShimInstanceUserController
  implements ControllerPrototype
{
  router: Router;
  logger: Logger;
  name: string;
  baseUri: string;
  initRouter: () => void;

  @Post('/verify/otp')
  async verifyWithOTP(request: Request): Promise<{
    ok: boolean;
    user?: ShimInstanceUser;
  }> {
    const error = HttpErrorFactory.instance(
      'verifyWithOTP',
      this.logger,
    );
    const instanceId = request.headers['bcms-iid'] as string;
    if (process.env.BCMS_LOCAL === 'true') {
      return {
        ok: true,
        user: Const.dev.user,
      };
    }
    return await ConnectionService.send(
      instanceId,
      '/user/verify/otp',
      {
        otp: request.body.otp,
      },
      error,
    );
  }

  @Post('/all')
  async getAll(
    request: Request,
  ): Promise<{ user: ShimInstanceUser[] }> {
    const error = HttpErrorFactory.instance('getAll', this.logger);
    const instanceId = request.headers['bcms-iid'] as string;
    if (process.env.BCMS_LOCAL === 'true') {
      return {
        user: [Const.dev.user],
      };
    }
    return await ConnectionService.send(
      instanceId,
      '/user/all',
      {},
      error,
    );
  }
}
