import net from 'node:net';

export function normalizeIpAddress(value) {
  let text = String(value || '').split(',')[0].trim().toLowerCase();
  if (!text) {
    return '';
  }
  const zoneIndex = text.indexOf('%');
  if (zoneIndex >= 0) {
    text = text.slice(0, zoneIndex);
  }
  if (text.startsWith('::ffff:') && net.isIP(text.slice(7)) === 4) {
    text = text.slice(7);
  }
  const parsed = parseIpAddress(text);
  return parsed ? formatParsedIp(parsed) : '';
}

export function isClientIpAllowed(clientIp, agentPublicIp, additionalAllowedCidrs = []) {
  const normalizedClient = normalizeIpAddress(clientIp);
  const normalizedAgent = normalizeIpAddress(agentPublicIp);
  if (!normalizedClient || !normalizedAgent) {
    return false;
  }
  if (normalizedClient === normalizedAgent) {
    return true;
  }
  return additionalAllowedCidrs.some((cidr) => isIpInCidr(normalizedClient, cidr));
}

export function isIpInCidr(ipAddress, cidrValue) {
  const [rawNetwork, rawPrefix] = String(cidrValue || '').trim().split('/');
  const address = parseIpAddress(normalizeIpAddress(ipAddress));
  const network = parseIpAddress(normalizeIpAddress(rawNetwork));
  if (!address || !network || address.version !== network.version) {
    return false;
  }
  const totalBits = address.version === 4 ? 32 : 128;
  const prefix = rawPrefix === undefined ? totalBits : Number(rawPrefix);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > totalBits) {
    return false;
  }
  if (prefix === 0) {
    return true;
  }
  const shift = BigInt(totalBits - prefix);
  return (address.value >> shift) === (network.value >> shift);
}

function parseIpAddress(value) {
  const version = net.isIP(value);
  if (version === 4) {
    const parts = value.split('.').map(Number);
    return {
      version,
      value: parts.reduce((result, part) => (result << 8n) | BigInt(part), 0n),
    };
  }
  if (version !== 6) {
    return null;
  }

  const normalized = expandIpv6(value);
  if (!normalized) {
    return null;
  }
  return {
    version,
    value: normalized.reduce(
      (result, part) => (result << 16n) | BigInt(Number.parseInt(part, 16)),
      0n,
    ),
  };
}

function expandIpv6(value) {
  let text = value;
  const ipv4Match = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (ipv4Match) {
    const ipv4 = ipv4Match[1].split('.').map(Number);
    const high = ((ipv4[0] << 8) | ipv4[1]).toString(16);
    const low = ((ipv4[2] << 8) | ipv4[3]).toString(16);
    text = `${text.slice(0, -ipv4Match[1].length)}${high}:${low}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) {
    return null;
  }
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) {
    return null;
  }
  return [
    ...left,
    ...Array(halves.length === 2 ? missing : 0).fill('0'),
    ...right,
  ].map((part) => part || '0');
}

function formatParsedIp(parsed) {
  if (parsed.version === 4) {
    return [24n, 16n, 8n, 0n]
      .map((shift) => Number((parsed.value >> shift) & 255n))
      .join('.');
  }
  return Array.from({ length: 8 }, (_, index) => {
    const shift = BigInt((7 - index) * 16);
    return ((parsed.value >> shift) & 65535n).toString(16);
  }).join(':');
}
