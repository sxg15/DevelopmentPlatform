import fs from 'node:fs';
import path from 'node:path';
import {
  applyConfigUpdate,
  collectConfigWarnings,
  createConfigRevision,
  createEditableConfig,
  validateConfigDocument,
} from './configEditorUtils.js';

export function createConfigEditorStore(rootDir) {
  const resolvedRoot = path.resolve(rootDir);
  const configPath = path.join(resolvedRoot, 'config.json');
  const backupPath = path.join(resolvedRoot, 'config.json.bak');
  const examplePath = path.join(resolvedRoot, 'config.example.json');

  return {
    read() {
      const state = readConfigState(configPath, backupPath, examplePath);
      if (!state.ok) {
        return state;
      }

      const editable = createEditableConfig(state.config);
      const validationCandidate = applyConfigUpdate(state.config, editable.config);
      return {
        ok: true,
        revision: state.revision,
        config: editable.config,
        secretState: editable.secretState,
        warnings: editable.warnings,
        errors: validateConfigDocument(validationCandidate, {
          checkDirectory: isExistingDirectory,
        }),
        backupAvailable: fs.existsSync(backupPath),
        exampleAvailable: fs.existsSync(examplePath),
      };
    },

    save(payload) {
      const state = readConfigState(configPath, backupPath, examplePath);
      if (!state.ok) {
        return state;
      }
      if (String(payload?.revision || '') !== state.revision) {
        return {
          ok: false,
          statusCode: 409,
          code: 'CONFIG_CHANGED',
          message: '配置文件已被其他程序修改，请重新载入后再保存',
        };
      }

      let candidate;
      try {
        candidate = applyConfigUpdate(state.config, payload?.config, payload?.secretChanges);
      } catch (error) {
        return {
          ok: false,
          statusCode: 400,
          code: 'CONFIG_UPDATE_INVALID',
          message: error instanceof Error ? error.message : '配置更新无效',
        };
      }

      const errors = validateConfigDocument(candidate, {
        checkDirectory: isExistingDirectory,
      });
      if (errors.length > 0) {
        return {
          ok: false,
          statusCode: 400,
          code: 'CONFIG_VALIDATION_FAILED',
          message: '配置校验失败',
          errors,
        };
      }

      const content = `${JSON.stringify(candidate, null, 2)}\n`;
      try {
        writeConfigTransaction({
          configPath,
          backupPath,
          content,
        });
      } catch {
        return {
          ok: false,
          statusCode: 500,
          code: 'CONFIG_WRITE_FAILED',
          message: '配置写入失败，原配置已保留',
        };
      }

      return {
        ok: true,
        revision: createConfigRevision(content),
        warnings: collectConfigWarnings(candidate),
        backupCreated: true,
        restartRequired: true,
      };
    },

    recover(source) {
      const sourcePath = source === 'backup'
        ? backupPath
        : source === 'example'
          ? examplePath
          : '';
      if (!sourcePath || !fs.existsSync(sourcePath)) {
        return {
          ok: false,
          statusCode: 404,
          code: 'RECOVERY_SOURCE_MISSING',
          message: '恢复来源不存在',
        };
      }

      let recoveryContent;
      try {
        recoveryContent = fs.readFileSync(sourcePath, 'utf8');
        JSON.parse(recoveryContent);
      } catch {
        return {
          ok: false,
          statusCode: 400,
          code: 'RECOVERY_SOURCE_INVALID',
          message: '恢复来源不是有效的 JSON 配置',
        };
      }

      try {
        if (fs.existsSync(configPath)) {
          const invalidBackupPath = path.join(
            resolvedRoot,
            `config.invalid-${formatTimestamp(new Date())}.json`,
          );
          fs.copyFileSync(configPath, invalidBackupPath);
        }
        writeConfigTransaction({
          configPath,
          backupPath,
          content: recoveryContent.endsWith('\n') ? recoveryContent : `${recoveryContent}\n`,
          preserveBackup: source === 'backup',
        });
      } catch {
        return {
          ok: false,
          statusCode: 500,
          code: 'CONFIG_RECOVERY_FAILED',
          message: '恢复配置失败，原文件已保留',
        };
      }

      return {
        ok: true,
        restartRequired: true,
      };
    },

    paths: {
      rootDir: resolvedRoot,
      configPath,
      backupPath,
      examplePath,
    },
  };
}

export function readConfigState(configPath, backupPath, examplePath) {
  if (!fs.existsSync(configPath)) {
    return {
      ok: false,
      statusCode: 404,
      code: 'CONFIG_MISSING',
      message: '找不到 config.json',
      backupAvailable: fs.existsSync(backupPath),
      exampleAvailable: fs.existsSync(examplePath),
    };
  }

  let content;
  try {
    content = fs.readFileSync(configPath, 'utf8');
  } catch {
    return {
      ok: false,
      statusCode: 500,
      code: 'CONFIG_READ_FAILED',
      message: '无法读取 config.json',
      backupAvailable: fs.existsSync(backupPath),
      exampleAvailable: fs.existsSync(examplePath),
    };
  }

  try {
    const config = JSON.parse(content);
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      return {
        ok: false,
        statusCode: 422,
        code: 'CONFIG_DOCUMENT_INVALID',
        message: 'config.json 的根节点必须是 JSON 对象',
        backupAvailable: fs.existsSync(backupPath),
        exampleAvailable: fs.existsSync(examplePath),
      };
    }
    return {
      ok: true,
      config,
      revision: createConfigRevision(content),
    };
  } catch (error) {
    return {
      ok: false,
      statusCode: 422,
      code: 'CONFIG_JSON_INVALID',
      message: `config.json 不是有效的 JSON：${error instanceof Error ? error.message : '解析失败'}`,
      backupAvailable: fs.existsSync(backupPath),
      exampleAvailable: fs.existsSync(examplePath),
    };
  }
}

export function writeConfigTransaction({
  configPath,
  backupPath,
  content,
  preserveBackup = false,
}) {
  const directory = path.dirname(configPath);
  const tempPath = path.join(directory, `.config-${process.pid}-${Date.now()}.tmp`);
  const rollbackPath = path.join(directory, `.config-${process.pid}-${Date.now()}.rollback`);
  let movedCurrent = false;

  try {
    fs.writeFileSync(tempPath, content, { encoding: 'utf8', flag: 'wx' });
    const descriptor = fs.openSync(tempPath, 'r+');
    try {
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    JSON.parse(fs.readFileSync(tempPath, 'utf8'));

    if (fs.existsSync(configPath)) {
      fs.renameSync(configPath, rollbackPath);
      movedCurrent = true;
    }
    fs.renameSync(tempPath, configPath);

    if (movedCurrent && !preserveBackup) {
      fs.copyFileSync(rollbackPath, backupPath);
    }
    if (movedCurrent) {
      fs.rmSync(rollbackPath, { force: true });
    }
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    if (movedCurrent && !fs.existsSync(configPath) && fs.existsSync(rollbackPath)) {
      fs.renameSync(rollbackPath, configPath);
    }
    throw error;
  } finally {
    fs.rmSync(tempPath, { force: true });
    if (fs.existsSync(rollbackPath) && fs.existsSync(configPath)) {
      fs.rmSync(rollbackPath, { force: true });
    }
  }
}

function isExistingDirectory(directoryPath) {
  try {
    return fs.statSync(directoryPath).isDirectory();
  } catch {
    return false;
  }
}

function formatTimestamp(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
    '-',
    String(date.getHours()).padStart(2, '0'),
    String(date.getMinutes()).padStart(2, '0'),
    String(date.getSeconds()).padStart(2, '0'),
  ].join('');
}
