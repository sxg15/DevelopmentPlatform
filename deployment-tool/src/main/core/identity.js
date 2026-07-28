import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import selfsigned from 'selfsigned';
import { normalizeName, normalizeTargetId } from '../../shared/validation.js';

export async function ensureTargetIdentity(identityDir, existing = {}) {
  const resolvedDir = path.resolve(identityDir);
  const keyPath = path.join(resolvedDir, 'target-key.pem');
  const certPath = path.join(resolvedDir, 'target-cert.pem');
  fs.mkdirSync(resolvedDir, { recursive: true });

  if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
    const now = new Date();
    const expiresAt = new Date(now);
    expiresAt.setFullYear(expiresAt.getFullYear() + 10);
    const generated = await selfsigned.generate(
      [{ name: 'commonName', value: os.hostname() || 'IGP Target' }],
      {
        keyType: 'ec',
        curve: 'P-256',
        algorithm: 'sha256',
        notBeforeDate: new Date(now.getTime() - 60 * 1000),
        notAfterDate: expiresAt,
        extensions: [
          { name: 'basicConstraints', cA: false, critical: true },
          { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
          { name: 'extKeyUsage', serverAuth: true },
          {
            name: 'subjectAltName',
            altNames: [
              { type: 2, value: 'localhost' },
              { type: 7, ip: '127.0.0.1' },
            ],
          },
        ],
      },
    );
    fs.writeFileSync(keyPath, generated.private, { encoding: 'utf8', mode: 0o600 });
    fs.writeFileSync(certPath, generated.cert, { encoding: 'utf8', mode: 0o600 });
  }

  const key = fs.readFileSync(keyPath, 'utf8');
  const cert = fs.readFileSync(certPath, 'utf8');
  const certificate = new crypto.X509Certificate(cert);
  const fingerprint = certificate.fingerprint256.replaceAll(':', '').toLowerCase();
  const targetId = normalizeTargetId(existing.targetId)
    || `target-${crypto.createHash('sha256').update(certificate.raw).digest('hex').slice(0, 16)}`;

  return {
    targetId,
    displayName: normalizeName(existing.displayName, os.hostname() || 'IGP 目标端'),
    fingerprint,
    key,
    cert,
  };
}

export function createPairingCode(now = Date.now()) {
  return {
    code: String(crypto.randomInt(0, 1_000_000)).padStart(6, '0'),
    createdAt: Number(now),
  };
}

export function createAccessToken() {
  return crypto.randomBytes(32).toString('base64url');
}

export function hashAccessToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

export function timingSafeTokenMatch(token, expectedHash) {
  const actual = Buffer.from(hashAccessToken(token), 'hex');
  const expected = Buffer.from(String(expectedHash || ''), 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
