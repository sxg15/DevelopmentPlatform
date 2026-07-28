import os from 'node:os';

export function listLanIPv4Addresses() {
  const addresses = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal && entry.address) {
        addresses.push(entry.address);
      }
    }
  }
  return [...new Set(addresses)].sort();
}

export function listBroadcastAddresses() {
  const addresses = new Set(['255.255.255.255']);
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family !== 'IPv4' || entry.internal || !entry.address || !entry.netmask) {
        continue;
      }
      const address = ipv4ToInt(entry.address);
      const netmask = ipv4ToInt(entry.netmask);
      if (address === null || netmask === null) {
        continue;
      }
      addresses.add(intToIpv4((address & netmask) | (~netmask >>> 0)));
    }
  }
  return [...addresses];
}

export function listLocalSubnetCandidates(options = {}) {
  const interfaces = options.networkInterfaces || os.networkInterfaces();
  const maxHostsPerInterface = Math.max(1, Number(options.maxHostsPerInterface) || 1022);
  const localAddresses = new Set();
  const candidates = new Set();
  const subnetEntries = [];

  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal && entry.address) {
        localAddresses.add(entry.address);
        subnetEntries.push(entry);
      }
    }
  }

  subnetEntries.sort((left, right) => interfacePriority(left) - interfacePriority(right));
  for (const entry of subnetEntries) {
    if (!isScannableAddress(entry.address) || !entry.netmask) {
      continue;
    }
    const address = ipv4ToInt(entry.address);
    const netmask = ipv4ToInt(entry.netmask);
    if (address === null || netmask === null) {
      continue;
    }

    let network = (address & netmask) >>> 0;
    let broadcast = (network | (~netmask >>> 0)) >>> 0;
    if (broadcast - network - 1 > maxHostsPerInterface) {
      network = (address & 0xffffff00) >>> 0;
      broadcast = (network | 0xff) >>> 0;
    }

    for (let current = network + 1; current < broadcast; current += 1) {
      const candidate = intToIpv4(current >>> 0);
      if (!localAddresses.has(candidate)) {
        candidates.add(candidate);
      }
    }
  }

  return [...candidates];
}

function ipv4ToInt(value) {
  const parts = String(value || '').split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }
  return parts.reduce((result, part) => ((result << 8) | part) >>> 0, 0);
}

function intToIpv4(value) {
  return [
    (value >>> 24) & 255,
    (value >>> 16) & 255,
    (value >>> 8) & 255,
    value & 255,
  ].join('.');
}

function isScannableAddress(value) {
  const parts = String(value || '').split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) {
    return false;
  }
  return (
    parts[0] !== 0
    && parts[0] !== 127
    && parts[0] < 224
    && !(parts[0] === 169 && parts[1] === 254)
  );
}

function interfacePriority(entry) {
  const mac = String(entry.mac || '').replaceAll(':', '').replaceAll('-', '');
  return mac && !/^0+$/.test(mac) ? 0 : 1;
}
