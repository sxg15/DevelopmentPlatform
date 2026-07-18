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
