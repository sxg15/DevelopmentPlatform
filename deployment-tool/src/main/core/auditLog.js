import fs from 'node:fs';
import path from 'node:path';

export function appendAuditEntry(filePath, entry) {
  const normalized = {
    timestamp: new Date().toISOString(),
    action: String(entry?.action || '').slice(0, 80),
    outcome: String(entry?.outcome || '').slice(0, 40),
    clientId: String(entry?.clientId || '').slice(0, 100),
    clientName: String(entry?.clientName || '').slice(0, 100),
    releaseId: String(entry?.releaseId || '').slice(0, 120),
    message: String(entry?.message || '').replace(/\r?\n/g, ' ').slice(0, 500),
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(normalized)}\n`, 'utf8');
  return normalized;
}
