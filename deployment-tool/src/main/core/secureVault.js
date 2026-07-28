import fs from 'node:fs';
import path from 'node:path';
import { JsonStore } from './jsonStore.js';

export class SecureVault {
  constructor(filePath, safeStorage) {
    this.store = new JsonStore(filePath, { schemaVersion: 1, values: {} });
    this.safeStorage = safeStorage;
  }

  isAvailable() {
    return Boolean(this.safeStorage?.isEncryptionAvailable?.());
  }

  get(key) {
    const encoded = this.store.read().values?.[key];
    if (!encoded) {
      return '';
    }
    if (!this.isAvailable()) {
      throw new Error('Windows 安全存储当前不可用');
    }
    return this.safeStorage.decryptString(Buffer.from(encoded, 'base64'));
  }

  set(key, value) {
    if (!this.isAvailable()) {
      throw new Error('Windows 安全存储当前不可用');
    }
    const encrypted = this.safeStorage.encryptString(String(value || '')).toString('base64');
    this.store.update((current) => {
      current.values[key] = encrypted;
      return current;
    });
  }

  delete(key) {
    this.store.update((current) => {
      delete current.values[key];
      return current;
    });
  }

  listKeys() {
    return Object.keys(this.store.read().values || {});
  }
}

export function restrictFileToCurrentUser(filePath) {
  try {
    fs.chmodSync(path.resolve(filePath), 0o600);
  } catch {
    // Windows ACLs remain authoritative when POSIX mode changes are unavailable.
  }
}
