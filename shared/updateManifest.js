const SEMVER_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function compareSemanticVersions(leftValue, rightValue) {
  const left = parseSemanticVersion(leftValue);
  const right = parseSemanticVersion(rightValue);

  if (!left || !right) {
    return 0;
  }

  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) {
      return left[key] - right[key];
    }
  }

  return comparePrereleaseVersions(left.prerelease, right.prerelease);
}

export function isSemanticVersion(value) {
  return Boolean(parseSemanticVersion(value));
}

export function normalizeUpdateManifest(value) {
  if (!value || typeof value !== 'object' || Number(value.schemaVersion) !== 1 || !isSemanticVersion(value.latestVersion)) {
    return null;
  }

  if (!Array.isArray(value.releases)) {
    return null;
  }

  const releases = [];
  const versions = new Set();

  for (const release of value.releases) {
    const version = String(release?.version || '').trim();
    const publishedAt = String(release?.publishedAt || '').trim();
    const changes = Array.isArray(release?.changes)
      ? release.changes.map((item) => String(item || '').trim()).filter(Boolean)
      : [];

    if (!isSemanticVersion(version) || !isValidPublishedAt(publishedAt) || changes.length === 0 || versions.has(version)) {
      return null;
    }

    versions.add(version);
    releases.push({ version, publishedAt, changes });
  }

  releases.sort((left, right) => compareSemanticVersions(right.version, left.version));

  if (releases.some((release) => compareSemanticVersions(release.version, value.latestVersion) > 0)) {
    return null;
  }

  return {
    schemaVersion: 1,
    latestVersion: String(value.latestVersion).trim(),
    releases,
  };
}

export function getReleasesNewerThan(manifest, sinceVersion) {
  if (!manifest || !Array.isArray(manifest.releases)) {
    return [];
  }

  if (!isSemanticVersion(sinceVersion)) {
    return [...manifest.releases];
  }

  return manifest.releases.filter((release) => compareSemanticVersions(release.version, sinceVersion) > 0);
}

export function buildUpdateResponse(manifest, currentVersion, sinceVersion) {
  const normalizedCurrentVersion = isSemanticVersion(currentVersion) ? String(currentVersion).trim() : '0.0.0';
  const normalizedManifest = normalizeUpdateManifest(manifest);

  if (!normalizedManifest) {
    throw new Error('更新日志清单格式无效');
  }

  return {
    enabled: true,
    currentVersion: normalizedCurrentVersion,
    latestVersion: normalizedManifest.latestVersion,
    updateAvailable: compareSemanticVersions(normalizedManifest.latestVersion, normalizedCurrentVersion) > 0,
    releases: getReleasesNewerThan(normalizedManifest, sinceVersion),
  };
}

function parseSemanticVersion(value) {
  const match = SEMVER_PATTERN.exec(String(value || '').trim());
  if (!match) {
    return null;
  }

  const [, major, minor, patch, prerelease = ''] = match;
  if ((major.length > 1 && major.startsWith('0')) || (minor.length > 1 && minor.startsWith('0')) || (patch.length > 1 && patch.startsWith('0'))) {
    return null;
  }

  const prereleaseIdentifiers = prerelease ? prerelease.split('.') : [];
  if (prereleaseIdentifiers.some((item) => /^\d+$/.test(item) && item.length > 1 && item.startsWith('0'))) {
    return null;
  }

  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: prereleaseIdentifiers,
  };
}

function comparePrereleaseVersions(left, right) {
  if (left.length === 0 || right.length === 0) {
    if (left.length === right.length) {
      return 0;
    }

    return left.length === 0 ? 1 : -1;
  }

  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];

    if (leftPart === undefined || rightPart === undefined) {
      return leftPart === undefined ? -1 : 1;
    }

    if (leftPart === rightPart) {
      continue;
    }

    const leftNumber = /^\d+$/.test(leftPart) ? Number(leftPart) : null;
    const rightNumber = /^\d+$/.test(rightPart) ? Number(rightPart) : null;

    if (leftNumber !== null && rightNumber !== null) {
      return leftNumber - rightNumber;
    }

    if (leftNumber !== null) {
      return -1;
    }

    if (rightNumber !== null) {
      return 1;
    }

    return leftPart.localeCompare(rightPart, 'en', { sensitivity: 'variant' });
  }

  return 0;
}

function isValidPublishedAt(value) {
  return Boolean(value) && Number.isFinite(Date.parse(value));
}
