import * as path from 'path';
import { useFS, useLogger } from '@becomes/purple-cheetah';
import type { Module } from '@becomes/purple-cheetah/types';
import { createDocker, createInstance } from '.';
import { ShimConfig } from '../config';
import { Service } from '../services';
import type {
  Instance,
  InstanceStats,
  Orchestration as OrchestrationType,
} from '../types';
import { System } from '../util';

export const Orchestration: OrchestrationType = {} as never;

export function createInstanceOrchestration(): Module {
  return {
    name: 'Orchestration',
    initialize({ next }) {
      const logger = useLogger({ name: 'Orchestration' });
      const docker = createDocker();
      const insts: {
        [id: string]: {
          data: Instance;
          alive: boolean;
          err: string;
          safe: boolean;
        };
      } = {};
      const fs = useFS();

      function execHelper(exo: {
        out: string;
        err: string;
      }): (type: 'stdout' | 'stderr', chunk: string) => void {
        exo.out = '';
        exo.err = '';
        return (type, chunk) => {
          if (type === 'stdout') {
            exo.out += chunk;
          } else {
            exo.err += chunk;
          }
        };
      }
      function nextPort() {
        const takenPorts = Object.keys(insts).map(
          (instId) => insts[instId].data.stats.port,
        );
        for (
          let port = ShimConfig.portRange.from;
          port < ShimConfig.portRange.to;
          port++
        ) {
          const sPort = '' + port;
          if (!takenPorts.find((e) => e === sPort)) {
            return sPort;
          }
        }
      }
      async function checkInstances() {
        for (const instId in insts) {
          const inst = insts[instId];
          if (inst.data.stats.status === 'active') {
            if (await inst.data.checkHealth()) {
              inst.alive = true;
            } else {
              inst.alive = false;
            }
          }
          if (!inst.alive) {
            if (inst.data.stats.status === 'active') {
              await Orchestration.restart(instId);
            } else if (inst.data.stats.status === 'unknown') {
              await Orchestration.run(instId);
            } else if (inst.data.stats.status === 'down') {
              await Orchestration.start(instId);
            } else if (inst.data.stats.status === 'down-to-error') {
              if (
                inst.data.stats.previousStatus !== 'down-to-error'
              ) {
                const date = new Date();
                const logName = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}.log`;
                await Service.cloudConnection.log({
                  instanceId: instId,
                  date: Date.now(),
                  err: inst.err,
                  shimLog: (
                    await fs.read(
                      path.join(
                        process.cwd(),
                        'storage',
                        'logs',
                        logName,
                      ),
                    )
                  ).toString(),
                  instLog: (
                    await fs.read(
                      path.join(
                        process.cwd(),
                        'storage',
                        'logs',
                        logName,
                      ),
                    )
                  ).toString(),
                });
                logger.warn(
                  'checkInstances',
                  `Starting safe mode for ${instId}`,
                );
                inst.safe = true;
                if (await Orchestration.remove(instId)) {
                  await Orchestration.start(instId);
                  inst.data.stats.previousStatus = 'down-to-error';
                } else {
                  inst.data.setStatus('down-to-error');
                }
              }
            }
          }
        }
        setTimeout(() => {
          checkInstances().catch((error) => {
            logger.error('checkInstances', error);
          });
        }, 5000);
      }

      async function init() {
        /**
         * List of available instances vie Docker CLI.
         */
        const inspects = await docker.inspectContainers();
        for (let i = 0; i < inspects.length; i++) {
          const inspect = inspects[i];
          const license = Service.license.get(inspect.id);
          if (license) {
            if (!inspect.up) {
              await Orchestration.remove(inspect.id);
            }
            insts[inspect.id] = {
              data: await createInstance({
                instanceId: inspect.id,
                fs,
                port: nextPort(),
              }),
              alive: false,
              safe: false,
              err: '',
            };
          } else {
            await Orchestration.remove(inspect.id);
          }
        }
        const instIds = Service.license.getInstanceIds();
        for (let i = 0; i < instIds.length; i++) {
          const instId = instIds[i];
          if (!insts[instId]) {
            insts[instId] = {
              data: await createInstance({
                fs,
                instanceId: instId,
                port: nextPort(),
              }),
              alive: false,
              safe: false,
              err: '',
            };
          }
        }

        if (ShimConfig.manage) {
          checkInstances().catch((error) => {
            logger.error('checkInstances', error);
          });
        } else {
          for (const instId in insts) {
            insts[instId].data.setStatus('active');
          }
          setInterval(async () => {
            for (const instId in insts) {
              const inst = insts[instId];
              if (await inst.data.checkHealth()) {
                inst.alive = true;
              } else {
                inst.alive = false;
              }
            }
          }, 5000);
        }
      }

      Orchestration.getInstance = (instId) => {
        return insts[instId] ? insts[instId].data : undefined;
      };
      Orchestration.listInstances = (query) => {
        if (!query) {
          return Object.keys(insts).map((e) => insts[e].data.stats);
        }
        const output: InstanceStats[] = [];
        const instIds = Object.keys(insts);
        for (let i = 0; i < instIds.length; i++) {
          const instId = instIds[i];
          if (query(insts[instId].data)) {
            output.push(insts[instId].data.stats);
          }
        }
        return output;
      };
      Orchestration.remove = async (instId) => {
        if (insts[instId]) {
          const inst = insts[instId];
          const containerName = inst.data.stats.name;
          const exo = {
            out: '',
            err: '',
          };
          await System.exec(
            ['docker', 'stop', containerName].join(' '),
            { onChunk: execHelper(exo), doNotThrowError: true },
          ).awaiter;
          if (exo.err) {
            logger.error('remove', {
              msg: `Failed to stop container "${containerName}"`,
              exo,
            });
          } else {
            logger.info(
              'remove',
              `Container "${containerName}" stopped.`,
            );
          }
          await System.exec(
            ['docker', 'rm', containerName].join(' '),
            { onChunk: execHelper(exo), doNotThrowError: true },
          ).awaiter;
          if (exo.err) {
            inst.err = exo.err;
            inst.data.setStatus('down-to-error');
            logger.error('remove', {
              msg: `Failed to remove container "${containerName}"`,
              exo,
            });
            return false;
          } else {
            inst.data.setStatus('unknown');
            inst.err = '';
            inst.alive = false;
            logger.info(
              'remove',
              `Container "${containerName}" removed.`,
            );
            // delete insts[instId];
          }
          return true;
        }
      };
      Orchestration.restart = async (instId) => {
        if (insts[instId]) {
          const inst = insts[instId];
          const containerName = inst.data.stats.name;
          const exo = {
            out: '',
            err: '',
          };
          await System.exec(
            ['docker', 'restart', containerName].join(' '),
            { onChunk: execHelper(exo), doNotThrowError: true },
          ).awaiter;
          if (exo.err) {
            inst.err = exo.err;
            inst.data.setStatus('down-to-error');
            logger.error('restart', {
              msg: `Failed to restart container "${containerName}"`,
              exo,
            });
            return false;
          } else {
            inst.err = '';
            inst.data.setStatus('active');
            logger.info(
              'restart',
              `Container "${containerName}" restarted.`,
            );
          }
          return true;
        }
      };
      Orchestration.start = async (instId) => {
        if (insts[instId]) {
          const inst = insts[instId];
          const containerName = inst.data.stats.name;
          const exo = {
            out: '',
            err: '',
          };
          await System.exec(
            ['docker', 'start', containerName].join(' '),
            { onChunk: execHelper(exo), doNotThrowError: true },
          ).awaiter;
          if (exo.err) {
            inst.err = exo.err;
            inst.data.setStatus('down-to-error');
            logger.error('start', {
              msg: `Failed to start container "${containerName}"`,
              exo,
            });
            return false;
          } else {
            inst.err = '';
            inst.data.setStatus('active');
            logger.info(
              'start',
              `Container "${containerName}" started.`,
            );
            return true;
          }
        }
      };
      Orchestration.stop = async (instId) => {
        if (insts[instId]) {
          const inst = insts[instId];
          const containerName = inst.data.stats.name;
          const exo = {
            out: '',
            err: '',
          };
          await System.exec(
            ['docker', 'stop', containerName].join(' '),
            { onChunk: execHelper(exo), doNotThrowError: true },
          ).awaiter;
          if (exo.err) {
            inst.err = exo.err;
            inst.data.setStatus('down-to-error');
            logger.error('stop', {
              msg: `Failed to stop container "${containerName}"`,
              exo,
            });
            return false;
          } else {
            inst.err = '';
            inst.data.setStatus('down');
            logger.info(
              'stop',
              `Container "${containerName}" stopped.`,
            );
          }
          return true;
        }
      };
      Orchestration.run = async (instId) => {
        if (insts[instId]) {
          const inst = insts[instId];
          const containerName = inst.data.stats.name;
          const exo = {
            out: '',
            err: '',
          };
          const instanceBasePath = path.join(
            process.cwd(),
            'storage',
            instId,
          );
          const bindings = inst.safe
            ? []
            : [
                '-v',
                `${instanceBasePath}/plugins:/app/plugins`,
                '-v',
                `${instanceBasePath}/functions:/app/functions`,
                '-v',
                `${instanceBasePath}/events:/app/events`,
                '-v',
                `${instanceBasePath}/jobs:/app/jobs`,
              ];
          await System.exec(
            [
              'docker',
              'run',
              '-d',
              '-p',
              `${inst.data.stats.port}:${inst.data.stats.port}`,
              '-v',
              '/var/run/docker.sock:/var/run/docker.sock',
              ...bindings,
              '--name',
              containerName,
              'becomes/cms-backend:latest',
            ].join(' '),
            { onChunk: execHelper(exo), doNotThrowError: true },
          ).awaiter;
          if (exo.err) {
            inst.err = exo.err;
            inst.data.setStatus('down-to-error');
            logger.error('run', {
              msg: `Failed to run container "${containerName}"`,
              exo,
            });
            return false;
          } else {
            inst.err = '';
            inst.data.setStatus('active');
            logger.info(
              'run',
              `Container "${containerName}" started.`,
            );
          }

          return true;
        }
      };

      init()
        .then(() => next())
        .catch((err) => next(err));
    },
  };
}
