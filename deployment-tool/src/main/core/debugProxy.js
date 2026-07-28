import crypto from 'node:crypto';
import http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { verifyPeerFingerprint } from './targetClient.js';

export class DebugProxy {
  constructor() {
    this.server = null;
    this.sessions = new Map();
    this.webSocketServer = new WebSocketServer({ noServer: true });
  }

  async start() {
    if (this.server) {
      return this.server.address().port;
    }
    this.server = http.createServer((_request, response) => {
      response.statusCode = 404;
      response.end('Not found');
    });
    this.server.on('upgrade', (request, socket, head) => {
      this.handleUpgrade(request, socket, head);
    });
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', resolve);
    });
    return this.server.address().port;
  }

  async createSession(connection) {
    const port = await this.start();
    const sessionId = crypto.randomBytes(24).toString('base64url');
    this.sessions.set(sessionId, {
      target: connection.target,
      createdAt: Date.now(),
    });
    setTimeout(() => this.sessions.delete(sessionId), 8 * 60 * 60 * 1000).unref();
    return {
      sessionId,
      localWebSocketUrl: `ws://127.0.0.1:${port}/debug/${sessionId}`,
      devToolsWebSocketPath: `127.0.0.1:${port}/debug/${sessionId}`,
    };
  }

  async stop() {
    this.sessions.clear();
    if (this.server) {
      await new Promise((resolve) => this.server.close(resolve));
      this.server = null;
    }
  }

  handleUpgrade(request, socket, head) {
    const match = String(request.url || '').match(/^\/debug\/([^/?]+)$/);
    const session = match ? this.sessions.get(match[1]) : null;
    if (!session) {
      socket.destroy();
      return;
    }
    this.webSocketServer.handleUpgrade(request, socket, head, (downstream) => {
      const target = session.target;
      const upstream = new WebSocket(
        `wss://${target.address}:${target.port}/api/v1/debug/socket`,
        {
          rejectUnauthorized: false,
          agent: false,
          headers: {
            Authorization: `Bearer ${target.token}`,
          },
        },
      );
      upstream.on('open', () => {
        try {
          verifyPeerFingerprint(upstream._socket, target.fingerprint);
        } catch {
          upstream.close();
          downstream.close();
          return;
        }
        downstream.on('message', (data, binary) => upstream.send(data, { binary }));
        upstream.on('message', (data, binary) => downstream.send(data, { binary }));
      });
      const closeBoth = () => {
        if (downstream.readyState < WebSocket.CLOSING) {
          downstream.close();
        }
        if (upstream.readyState < WebSocket.CLOSING) {
          upstream.close();
        }
      };
      downstream.on('close', closeBoth);
      downstream.on('error', closeBoth);
      upstream.on('close', closeBoth);
      upstream.on('error', closeBoth);
    });
  }
}
