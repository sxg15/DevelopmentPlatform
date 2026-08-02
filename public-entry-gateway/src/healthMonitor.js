import fs from 'node:fs';

export class GatewayHealthMonitor {
  constructor(config, options = {}) {
    this.config = config;
    this.fetchImpl = options.fetchImpl || fetch;
    this.now = options.now || Date.now;
    this.setIntervalImpl = options.setIntervalImpl || setInterval;
    this.clearIntervalImpl = options.clearIntervalImpl || clearInterval;
    this.healthTimer = null;
    this.publicIpTimer = null;
    this.state = {
      healthyChecks: 0,
      ready: false,
      health: null,
      healthError: '',
      healthCheckedAt: 0,
      publicIp: '',
      publicIpError: '',
      publicIpAttemptedAt: 0,
      publicIpCheckedAt: 0,
    };
  }

  async start() {
    await Promise.allSettled([
      this.refreshHealth(),
      this.refreshPublicIp(),
    ]);
    this.healthTimer = this.setIntervalImpl(
      () => void this.refreshHealth(),
      this.config.monitoring.healthIntervalMs,
    );
    this.publicIpTimer = this.setIntervalImpl(
      () => void this.refreshPublicIp(),
      this.config.monitoring.publicIpIntervalMs,
    );
    this.healthTimer.unref?.();
    this.publicIpTimer.unref?.();
  }

  stop() {
    if (this.healthTimer) {
      this.clearIntervalImpl(this.healthTimer);
      this.healthTimer = null;
    }
    if (this.publicIpTimer) {
      this.clearIntervalImpl(this.publicIpTimer);
      this.publicIpTimer = null;
    }
  }

  async refreshHealth() {
    try {
      const response = await this.fetchImpl(this.config.localPlatform.healthUrl, {
        signal: AbortSignal.timeout(this.config.monitoring.healthTimeoutMs),
        cache: 'no-store',
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const payload = await response.json();
      if (payload?.ok !== true) {
        throw new Error('健康检查没有返回 ok=true');
      }
      this.state.healthyChecks += 1;
      this.state.ready = this.state.healthyChecks
        >= this.config.monitoring.requiredHealthyChecks;
      this.state.health = {
        ok: true,
        version: String(payload.version || ''),
      };
      this.state.healthError = '';
    } catch (error) {
      this.state.healthyChecks = 0;
      this.state.ready = false;
      this.state.health = null;
      this.state.healthError = error instanceof Error ? error.message : String(error);
    } finally {
      this.state.healthCheckedAt = this.now();
    }
  }

  async refreshPublicIp() {
    try {
      const response = await this.fetchImpl(this.config.publicEntry.clientIpProbeUrl, {
        signal: AbortSignal.timeout(this.config.monitoring.publicIpTimeoutMs),
        cache: 'no-store',
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const publicIp = String(await response.text()).trim();
      if (!publicIp) {
        throw new Error('公网入口没有返回出口 IP');
      }
      this.state.publicIp = publicIp;
      this.state.publicIpError = '';
      this.state.publicIpCheckedAt = this.now();
    } catch (error) {
      this.state.publicIpError = error instanceof Error ? error.message : String(error);
    } finally {
      this.state.publicIpAttemptedAt = this.now();
    }
  }

  getStatus() {
    const now = this.now();
    const publicIpFresh = Boolean(
      this.state.publicIp
      && now - this.state.publicIpCheckedAt <= this.config.monitoring.publicIpMaxAgeMs,
    );
    const maintenance = readMaintenanceState(
      this.config.deployment.maintenanceFile,
      now,
      this.config.monitoring.maintenanceMaxAgeMs,
      this.state.ready,
    );
    return {
      ...this.state,
      publicIp: publicIpFresh ? this.state.publicIp : '',
      publicIpFresh,
      ready: this.state.ready && !maintenance.active,
      maintenance,
    };
  }
}

export function readMaintenanceState(filePath, now = Date.now(), maxAgeMs = 30 * 60 * 1000, ready = false) {
  if (!filePath) {
    return { active: false, phase: '', updatedAt: '', stale: false };
  }
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (value?.active !== true) {
      return { active: false, phase: '', updatedAt: '', stale: false };
    }
    const updatedAt = String(value.updatedAt || '');
    const updatedTime = Date.parse(updatedAt);
    const stale = !Number.isFinite(updatedTime) || now - updatedTime > maxAgeMs;
    if (stale && ready) {
      return { active: false, phase: String(value.phase || ''), updatedAt, stale: true };
    }
    return {
      active: true,
      phase: String(value.phase || 'upgrading'),
      updatedAt,
      stale,
    };
  } catch {
    return { active: false, phase: '', updatedAt: '', stale: false };
  }
}
