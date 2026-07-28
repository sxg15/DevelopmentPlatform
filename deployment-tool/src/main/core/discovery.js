import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import {
  DISCOVERY_PORT,
  DISCOVERY_QUERY,
  PROTOCOL_VERSION,
  TARGET_CONTROL_PORT,
} from '../../shared/constants.js';
import {
  listBroadcastAddresses,
  listLocalSubnetCandidates,
} from './network.js';
import { probeTarget } from './targetClient.js';

export class TargetDiscoveryResponder {
  constructor(getAnnouncement, options = {}) {
    this.getAnnouncement = getAnnouncement;
    this.port = options.port || DISCOVERY_PORT;
    this.socket = null;
  }

  start() {
    if (this.socket) {
      return;
    }
    this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket.on('message', (message, remote) => {
      try {
        const payload = JSON.parse(message.toString('utf8'));
        if (
          payload?.type !== DISCOVERY_QUERY.type
          || payload?.protocolVersion !== PROTOCOL_VERSION
        ) {
          return;
        }
        const response = Buffer.from(JSON.stringify({
          ...this.getAnnouncement(),
          type: 'igp-lan-deploy-target',
          protocolVersion: PROTOCOL_VERSION,
        }));
        this.socket.send(response, remote.port, remote.address);
      } catch {
        // Ignore malformed UDP traffic.
      }
    });
    this.socket.bind(this.port);
  }

  stop() {
    this.socket?.close();
    this.socket = null;
  }
}

export class TargetDiscoveryScanner extends EventEmitter {
  constructor(options = {}) {
    super();
    this.port = options.port || DISCOVERY_PORT;
    this.timeoutMs = options.timeoutMs || 1800;
    this.controlPort = options.controlPort || TARGET_CONTROL_PORT;
    this.fallbackProbeTimeoutMs = options.fallbackProbeTimeoutMs || 600;
    this.fallbackConcurrency = options.fallbackConcurrency || 96;
    this.getBroadcastAddresses = options.getBroadcastAddresses || listBroadcastAddresses;
    this.getFallbackAddresses = options.getFallbackAddresses || listLocalSubnetCandidates;
    this.probe = options.probe || probeTarget;
  }

  async scan() {
    let found;
    try {
      found = await this.scanBroadcast();
    } catch {
      found = new Map();
    }
    if (found.size === 0) {
      await this.scanFallback(found);
    }
    return [...found.values()]
      .sort((left, right) => left.displayName.localeCompare(right.displayName));
  }

  scanBroadcast() {
    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket('udp4');
      const found = new Map();
      const finish = () => {
        socket.close();
        resolve(found);
      };

      socket.on('error', (error) => {
        socket.close();
        reject(error);
      });
      socket.on('message', (message, remote) => {
        try {
          const payload = JSON.parse(message.toString('utf8'));
          if (
            payload?.type !== 'igp-lan-deploy-target'
            || payload?.protocolVersion !== PROTOCOL_VERSION
            || !payload?.targetId
          ) {
            return;
          }
          const target = {
            ...payload,
            address: remote.address,
            discoveredAt: Date.now(),
          };
          found.set(payload.targetId, target);
          this.emit('target', target);
        } catch {
          // Ignore malformed responses.
        }
      });
      socket.bind(0, () => {
        socket.setBroadcast(true);
        const message = Buffer.from(JSON.stringify(DISCOVERY_QUERY));
        for (const address of this.getBroadcastAddresses()) {
          socket.send(message, this.port, address);
        }
        setTimeout(finish, this.timeoutMs).unref();
      });
    });
  }

  async scanFallback(found) {
    const addresses = this.getFallbackAddresses();
    const priorities = new Map();
    let cursor = 0;
    const workerCount = Math.min(this.fallbackConcurrency, addresses.length);
    const workers = Array.from({ length: workerCount }, async () => {
      while (cursor < addresses.length) {
        const index = cursor;
        cursor += 1;
        const address = addresses[index];
        try {
          const target = await this.probe(address, this.controlPort, {
            timeoutMs: this.fallbackProbeTimeoutMs,
          });
          const currentPriority = priorities.get(target.targetId);
          if (currentPriority === undefined || index < currentPriority) {
            priorities.set(target.targetId, index);
            found.set(target.targetId, target);
            this.emit('target', target);
          }
        } catch {
          // Most subnet addresses will not host a target agent.
        }
      }
    });
    await Promise.all(workers);
  }
}
