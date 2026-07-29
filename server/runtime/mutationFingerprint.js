import crypto from 'node:crypto';

export function createMutationFingerprint(value) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(value ?? null))
    .digest('hex');
}
