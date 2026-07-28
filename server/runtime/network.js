import os from 'node:os';

export function getLocalUrls(currentPort) {
  const urls = [`http://127.0.0.1:${currentPort}/`];
  const interfaces = os.networkInterfaces();

  for (const entries of Object.values(interfaces)) {
    for (const item of entries || []) {
      if (item.family === 'IPv4' && !item.internal) {
        urls.push(`http://${item.address}:${currentPort}/`);
      }
    }
  }

  return urls;
}

export function getMcpServerUrls(
  currentPort,
  currentOrigin = '',
  localUrls = getLocalUrls(currentPort),
) {
  const currentUrl = normalizeMcpUrl(currentOrigin);
  const normalizedLocalUrls = localUrls.map(normalizeMcpUrl).filter(Boolean);
  const lanUrls = normalizedLocalUrls.filter((url) => !isLoopbackUrl(url));
  const loopbackUrls = normalizedLocalUrls.filter(isLoopbackUrl);
  const preferred = currentUrl && !isLoopbackUrl(currentUrl)
    ? currentUrl
    : lanUrls[0] || currentUrl || loopbackUrls[0] || '';

  return [...new Set([
    preferred,
    ...lanUrls,
    currentUrl && currentUrl !== preferred ? currentUrl : '',
    ...loopbackUrls,
  ].filter(Boolean))];
}

function normalizeMcpUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (!['http:', 'https:'].includes(url.protocol)) {
      return '';
    }
    url.pathname = '/mcp';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

function isLoopbackUrl(value) {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  } catch {
    return false;
  }
}
