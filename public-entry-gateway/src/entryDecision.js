import crypto from 'node:crypto';
import { isClientIpAllowed, normalizeIpAddress } from './ipUtils.js';

export const ENTRY_STATUS = Object.freeze({
  REDIRECT: 'redirect',
  FORBIDDEN: 'forbidden',
  MAINTENANCE: 'maintenance',
  UNAVAILABLE: 'unavailable',
});

export function decideEntry({
  relayToken,
  expectedRelayToken,
  clientIp,
  agentPublicIp,
  additionalAllowedCidrs,
  maintenance,
  ready,
  localBaseUrl,
  publicBaseUrl,
  requestTarget,
}) {
  if (expectedRelayToken && !timingSafeTextMatch(relayToken, expectedRelayToken)) {
    return {
      status: ENTRY_STATUS.FORBIDDEN,
      statusCode: 403,
      message: '入口请求验证失败',
    };
  }
  if (!isClientIpAllowed(clientIp, agentPublicIp, additionalAllowedCidrs)) {
    return {
      status: ENTRY_STATUS.FORBIDDEN,
      statusCode: 403,
      message: '开发平台仅允许在公司局域网或指定 VPN 环境中使用',
    };
  }
  if (maintenance?.active) {
    return {
      status: ENTRY_STATUS.MAINTENANCE,
      statusCode: 503,
      message: getMaintenanceMessage(maintenance.phase),
    };
  }
  if (!ready) {
    return {
      status: ENTRY_STATUS.UNAVAILABLE,
      statusCode: 503,
      message: '开发平台正在启动、升级或暂时不可用',
    };
  }
  return {
    status: ENTRY_STATUS.REDIRECT,
    statusCode: 302,
    location: buildLocalRedirectUrl({
      localBaseUrl,
      publicBaseUrl,
      requestTarget,
    }),
  };
}

export function buildLocalRedirectUrl({ localBaseUrl, publicBaseUrl, requestTarget }) {
  const inbound = new URL(String(requestTarget || '/'), publicBaseUrl);
  const target = new URL(localBaseUrl);
  const basePath = target.pathname.endsWith('/') ? target.pathname.slice(0, -1) : target.pathname;
  const inboundPath = inbound.pathname.startsWith('/') ? inbound.pathname : `/${inbound.pathname}`;
  target.pathname = `${basePath}${inboundPath}` || '/';
  target.search = inbound.search;
  target.hash = '';
  return target.toString();
}

export function timingSafeTextMatch(left, right) {
  const leftDigest = crypto.createHash('sha256').update(String(left || '')).digest();
  const rightDigest = crypto.createHash('sha256').update(String(right || '')).digest();
  return crypto.timingSafeEqual(leftDigest, rightDigest)
    && String(left || '').length === String(right || '').length;
}

function getMaintenanceMessage(phase) {
  switch (String(phase || '')) {
    case 'rollback':
      return '开发平台正在回滚到上一版本';
    case 'starting':
      return '开发平台新版本正在启动';
    case 'stopping':
      return '开发平台服务正在停止';
    default:
      return '开发平台正在升级';
  }
}

export function normalizeClientIpHeader(value) {
  return normalizeIpAddress(Array.isArray(value) ? value[0] : value);
}
