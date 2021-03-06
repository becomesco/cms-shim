import * as os from 'os';
import { SecurityObject, SecurityService } from './security';
import { General, Http } from '../util';
import type { InstanceServerStats } from '../types';
import {
  HttpError,
  HttpStatus,
  Logger,
} from '@becomes/purple-cheetah';
import { ShimInstanceService } from './instances';

export interface ConnectionServicePrototype {
  send<T>(
    instanceId: string,
    uri: string,
    payload: unknown,
    error?: HttpError,
  ): Promise<T>;
  // isConnected(instanceId: string): boolean;
  // getBCMSConfig(instanceId: string): Promise<BCMSConfig>;
  // log(instanceId: string, message: string): Promise<void>;
  // canAccessPlugin(
  //   instanceId: string,
  //   pluginHash: string,
  // ): Promise<boolean>;
  // loginUser(
  //   instanceId: string,
  //   cred: {
  //     email: string;
  //     password: string;
  //   },
  // ): Promise<UserProtected>;
}
export interface Connection {
  connected: boolean;
  registerAfter: number;
  channel: string;
}

function connectionService() {
  const logger = new Logger('ShimConnectionService');
  const http =
    process.env.PROD === 'true'
      ? new Http('cloud.thebcms.com', '443', '/api/v1/shim')
      : new Http('localhost', '8080', '/api/v1/shim');
  const instanceHttp = new Http();
  const connections: { [instanceId: string]: Connection } = {};

  setInterval(async () => {
    const licenseService = SecurityService.license();
    if (licenseService && process.env.BCMS_LOCAL !== 'true') {
      const instanceIds = licenseService.getInstanceIds();
      for (let i = 0; i < instanceIds.length; i++) {
        const instanceId = instanceIds[i];
        if (!connections[instanceId]) {
          connections[instanceId] = {
            connected: false,
            channel: '',
            registerAfter: Date.now() - 1000,
          };
        }
        if (!connections[instanceId].connected) {
          if (connections[instanceId].registerAfter < Date.now()) {
            if (await register(instanceId)) {
              connections[instanceId].connected = true;
              logger.info(
                'register',
                `Instance "${instanceId}" successfully registered to the cloud.`,
              );
            } else {
              logger.warn(
                'register',
                `Instance "${instanceId}" failed to register to the cloud.`,
              );
              connections[instanceId].registerAfter =
                Date.now() + 10000;
            }
          }
        } else {
          if (
            !(await sendStats(
              instanceId,
              connections[instanceId].channel,
            ))
          ) {
            logger.warn(
              'connection',
              `Connection failed for "${instanceId}".`,
            );
            connections[instanceId].connected = false;
          }
        }
        const result = await ShimInstanceService.checkHealth(
          instanceId,
        );
        if (!result.ok) {
          console.log('Instance not available');
          // TODO: implement a mechanism for starting new instance
        } else {
          // TODO: do something with data
        }
      }
    }
  }, 1000);

  async function getStats(): Promise<InstanceServerStats> {
    const mem = process.memoryUsage();
    return {
      cpu: {
        cores: os.cpus().length,
        usage: await General.cpu.usage(),
      },
      ramAvailable: os.totalmem(),
      ramUsed: os.totalmem() - os.freemem(),
      diskAvailable: 0,
      diskUsed: 0,
      heepAvailable: mem.heapTotal,
      heepUsed: mem.heapUsed,
      lastUpdate: Date.now(),
    };
  }
  async function register(instanceId: string): Promise<boolean> {
    try {
      const stats = await getStats();
      const regObj = SecurityService.enc(instanceId, stats);
      const response = await http.send<SecurityObject>({
        path: '/register',
        method: 'POST',
        data: regObj,
        headers: {
          iid: instanceId,
        },
      });
      if (response.status !== 200) {
        logger.warn(
          'register',
          `${response.status} - ${(response.data as any).message}`,
        );
        return false;
      }
      const resObj: {
        channel: string;
      } = SecurityService.dec(instanceId, response.data);
      connections[instanceId].channel = resObj.channel;
      return true;
    } catch (e) {
      console.error(e);
      logger.error('register', 'Failed');
    }
    return false;
  }
  async function sendStats(
    instanceId: string,
    channel: string,
  ): Promise<boolean> {
    try {
      const stats = await getStats();
      const response = await http.send<SecurityObject>({
        path: `/conn/${channel}`,
        method: 'POST',
        data: SecurityService.enc(instanceId, stats),
        headers: {
          iid: instanceId,
        },
      });
      if (response.status !== 200) {
        logger.warn(
          'register',
          `${response.status} - ${(response.data as any).message}`,
        );
        return false;
      }
      const resObj: {
        ok: string;
      } = SecurityService.dec(instanceId, response.data);
      return !!resObj.ok;
    } catch (e) {
      console.error(e);
      logger.error('sendStats', 'Failed');
    }
    return false;
  }

  const self: ConnectionServicePrototype = {
    async send(instanceId, uri, payload, error) {
      const connection = connections[instanceId];
      if (!connection) {
        if (error) {
          throw error.occurred(
            HttpStatus.FORBIDDEN,
            'Instance in not connected.',
          );
        }
        throw Error('Instance is not connected.');
      }
      try {
        const response = await http.send<SecurityObject>({
          path: `/conn/${connection.channel}${uri}`,
          method: 'POST',
          data: SecurityService.enc(instanceId, payload),
          headers: {
            iid: instanceId,
          },
        });
        return SecurityService.dec(instanceId, response.data);
      } catch (e) {
        logger.error('send', e);
        if (error) {
          throw error.occurred(
            HttpStatus.INTERNAL_SERVER_ERROR,
            'Failed to send a request.',
          );
        }
        throw Error('Failed to send a request.');
      }
    },
  };
  return self;
}

export const ConnectionService = connectionService();
