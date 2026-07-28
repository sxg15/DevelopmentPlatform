import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  app,
  BrowserWindow,
  Menu,
  Tray,
  dialog,
  ipcMain,
  safeStorage,
} from 'electron';
import { decorateRoleState } from './core/appState.js';
import { AutomationServer } from './core/automationServer.js';
import { DebugProxy } from './core/debugProxy.js';
import { DeveloperController } from './core/developerController.js';
import { JsonStore } from './core/jsonStore.js';
import { terminateActiveProcesses } from './core/processRunner.js';
import { normalizeToolMode, resolveStartupMode } from './core/startupMode.js';
import { TargetAgent } from './core/targetAgent.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const devServerUrl = readArgument('--dev-server');
const capturePath = readArgument('--capture');
const previewMode = readArgument('--preview');
const requestedMode = readArgument('--mode');
const captureWidth = Number(readArgument('--window-width')) || 1360;
const captureHeight = Number(readArgument('--window-height')) || 860;
let mainWindow = null;
let tray = null;
let controller = null;
let automationServer = null;
let targetAgent = null;
let debugProxy = null;
let quitting = false;
let quitPromise = null;
let appSettings = null;
let startupError = '';

app.setName('IGP LAN Deploy Tool');

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showMainWindow();
  });
}

app.whenReady().then(async () => {
  if (capturePath) {
    createMainWindow();
    return;
  }
  const userDataDir = app.getPath('userData');
  appSettings = new JsonStore(path.join(userDataDir, 'app-settings.json'), {
    schemaVersion: 1,
    mode: '',
  });
  const savedMode = appSettings.read().mode;
  const startupMode = resolveStartupMode(savedMode, requestedMode);
  if (startupMode !== savedMode) {
    appSettings.update((settings) => {
      settings.mode = startupMode;
      return settings;
    });
  }
  registerIpcHandlers();
  createMainWindow();
  void createTray().catch(() => {});
  await startConfiguredRoleSafely();
});

app.on('window-all-closed', () => {
  if (!capturePath) {
    void requestApplicationQuit();
  }
});

app.on('before-quit', (event) => {
  if (!quitting) {
    event.preventDefault();
    void requestApplicationQuit();
  }
});

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: capturePath ? captureWidth : 1380,
    height: capturePath ? captureHeight : 880,
    minWidth: capturePath ? 0 : 720,
    minHeight: 640,
    show: false,
    backgroundColor: '#f4f6f7',
    webPreferences: {
      ...(capturePath ? {} : { preload: path.join(__dirname, 'preload.cjs') }),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.removeMenu();
  mainWindow.on('close', (event) => {
    if (capturePath) {
      return;
    }
    if (!quitting) {
      event.preventDefault();
      void requestApplicationQuit();
    }
  });
  if (!capturePath) {
    mainWindow.once('ready-to-show', () => mainWindow.show());
  }
  if (devServerUrl) {
    const separator = devServerUrl.includes('?') ? '&' : '?';
    mainWindow.loadURL(
      previewMode ? `${devServerUrl}${separator}preview=${encodeURIComponent(previewMode)}` : devServerUrl,
    );
  } else {
    mainWindow.loadFile(path.join(__dirname, '../../dist-renderer/index.html'));
  }
  if (capturePath) {
    mainWindow.webContents.once('did-finish-load', async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const image = await mainWindow.webContents.capturePage();
      fs.mkdirSync(path.dirname(path.resolve(capturePath)), { recursive: true });
      fs.writeFileSync(path.resolve(capturePath), image.toPNG());
      mainWindow.destroy();
      app.exit(0);
    });
    setTimeout(() => app.exit(2), 20_000).unref();
  }
}

async function createTray() {
  const icon = await app.getFileIcon(process.execPath, { size: 'small' });
  tray = new Tray(icon);
  tray.setToolTip('IGP 局域网部署调试工具');
  tray.on('double-click', showMainWindow);
  refreshTrayMenu();
}

function refreshTrayMenu() {
  const mode = appSettings?.read().mode;
  tray?.setContextMenu(Menu.buildFromTemplate([
    {
      label: '打开控制台',
      click: showMainWindow,
    },
    {
      label: mode === 'target' ? '目标端模式' : mode === 'developer' ? '开发端模式' : '尚未选择模式',
      enabled: false,
    },
    { type: 'separator' },
    {
      label: '退出',
      click() {
        void requestApplicationQuit();
      },
    },
  ]));
}

function showMainWindow() {
  if (!mainWindow) {
    return;
  }
  mainWindow.show();
  mainWindow.focus();
}

async function startConfiguredRole() {
  startupError = '';
  await shutdownRole();
  const mode = appSettings.read().mode;
  let roleState = null;
  if (mode === 'target') {
    targetAgent = new TargetAgent({
      userDataDir: app.getPath('userData'),
      appVersion: app.getVersion(),
    });
    targetAgent.on('state', sendRoleState);
    roleState = await targetAgent.start();
    app.setLoginItemSettings({
      openAtLogin: true,
      args: ['--mode=target'],
    });
  } else if (mode === 'developer') {
    controller = new DeveloperController({
      userDataDir: app.getPath('userData'),
      safeStorage,
    });
    controller.on('state', sendRoleState);
    controller.on('job', (job) => mainWindow?.webContents.send('job-updated', job));
    automationServer = new AutomationServer({
      controller,
      metadataPath: path.join(app.getPath('userData'), 'automation.json'),
    });
    await automationServer.start();
    debugProxy = new DebugProxy();
    roleState = await controller.getState();
    if (app.getLoginItemSettings().openAtLogin) {
      app.setLoginItemSettings({
        openAtLogin: true,
        args: ['--mode=developer'],
      });
    }
  }
  refreshTrayMenu();
  const state = roleState
    ? decorateRoleState(
      roleState,
      mode,
      app.getLoginItemSettings().openAtLogin,
    )
    : await buildState();
  sendState(state);
  if (mode === 'developer' && controller) {
    const activeController = controller;
    activeController.getState({ refreshStatus: true })
      .then((refreshedState) => {
        if (controller === activeController) {
          sendRoleState(refreshedState);
        }
      })
      .catch(() => {});
  }
  return state;
}

async function startConfiguredRoleSafely() {
  try {
    return await startConfiguredRole();
  } catch (error) {
    startupError = error instanceof Error ? error.message : String(error);
    const state = buildStartupFailureState(startupError);
    sendState(state);
    return state;
  }
}

async function shutdownRole() {
  await automationServer?.stop().catch(() => {});
  automationServer = null;
  await debugProxy?.stop().catch(() => {});
  debugProxy = null;
  await targetAgent?.stop().catch(() => {});
  targetAgent = null;
  controller = null;
  await terminateActiveProcesses();
}

function requestApplicationQuit() {
  if (quitPromise) {
    return quitPromise;
  }
  quitting = true;
  quitPromise = shutdownRole()
    .finally(() => {
      tray?.destroy();
      tray = null;
      app.exit(0);
    });
  return quitPromise;
}

async function buildState(options = {}) {
  const settings = appSettings.read();
  const loginSettings = app.getLoginItemSettings();
  if (startupError) {
    return buildStartupFailureState(startupError);
  }
  if (settings.mode === 'target' && targetAgent) {
    return {
      appMode: settings.mode,
      openAtLogin: loginSettings.openAtLogin,
      ...(await targetAgent.getLocalState({
        includeHealth: options.refreshStatus === true,
      })),
    };
  }
  if (settings.mode === 'developer' && controller) {
    return {
      appMode: settings.mode,
      openAtLogin: loginSettings.openAtLogin,
      ...(await controller.getState({
        refreshStatus: options.refreshStatus === true,
      })),
    };
  }
  return {
    appMode: settings.mode,
    mode: settings.mode,
    initializing: Boolean(settings.mode),
    openAtLogin: loginSettings.openAtLogin,
  };
}

function buildStartupFailureState(error) {
  const settings = appSettings.read();
  return {
    appMode: settings.mode,
    mode: settings.mode,
    initializing: false,
    startupError: error instanceof Error ? error.message : String(error),
    openAtLogin: app.getLoginItemSettings().openAtLogin,
  };
}

function sendState(state) {
  mainWindow?.webContents.send('state-updated', state);
}

function sendRoleState(roleState) {
  const mode = appSettings?.read().mode || '';
  const state = decorateRoleState(
    roleState,
    mode,
    app.getLoginItemSettings().openAtLogin,
  );
  if (state) {
    sendState(state);
  }
}

function registerIpcHandlers() {
  ipcMain.handle('app:get-state', buildState);
  ipcMain.handle('app:set-mode', async (_event, payload) => {
    const mode = normalizeToolMode(payload?.mode);
    if (!mode) {
      throw new Error('工具模式无效');
    }
    appSettings.update((settings) => {
      settings.mode = mode;
      return settings;
    });
    return startConfiguredRoleSafely();
  });
  ipcMain.handle('app:set-login-startup', async (_event, payload) => {
    app.setLoginItemSettings({
      openAtLogin: Boolean(payload?.enabled),
      args: [`--mode=${appSettings.read().mode || 'developer'}`],
    });
    return buildState();
  });
  ipcMain.handle('app:choose-directory', async (_event, payload) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: payload?.title || '选择目录',
      defaultPath: payload?.defaultPath || undefined,
      properties: ['openDirectory'],
    });
    return {
      cancelled: result.canceled,
      path: result.filePaths[0] || '',
    };
  });

  ipcMain.handle('developer:scan', requireDeveloper(() => controller.scan()));
  ipcMain.handle('developer:probe', requireDeveloper((_event, payload) => (
    controller.probeTarget(payload.address, payload.port)
  )));
  ipcMain.handle('developer:pair', requireDeveloper((_event, payload) => (
    controller.pairTarget(payload.target, payload.code)
  )));
  ipcMain.handle('developer:set-default', requireDeveloper((_event, payload) => (
    controller.setDefaultTarget(payload.targetId)
  )));
  ipcMain.handle('developer:set-repository', requireDeveloper((_event, payload) => (
    controller.setRepositoryPath(payload.path)
  )));
  ipcMain.handle('developer:refresh', requireDeveloper((_event, payload) => (
    controller.refreshTarget(payload.targetId)
  )));
  ipcMain.handle('developer:action', requireDeveloper((_event, payload) => (
    controller.runTargetAction(payload.targetId, payload.action)
  )));
  ipcMain.handle('developer:read-log', requireDeveloper((_event, payload) => (
    controller.readLog(payload.targetId, payload.name, payload.options)
  )));
  ipcMain.handle('developer:deploy', requireDeveloper((_event, payload) => (
    controller.createDeployJob(payload)
  )));
  ipcMain.handle('developer:get-job', requireDeveloper((_event, payload) => (
    controller.getJob(payload.jobId)
  )));
  ipcMain.handle('developer:forget', requireDeveloper((_event, payload) => (
    controller.forgetTarget(payload.targetId)
  )));
  ipcMain.handle('developer:debug', requireDeveloper(async (_event, payload) => {
    const connection = await controller.getDebugConnection(payload.targetId);
    const session = await debugProxy.createSession(connection);
    const devToolsWindow = new BrowserWindow({
      width: 1280,
      height: 820,
      title: 'IGP Node 调试器',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    await devToolsWindow.loadURL(
      `devtools://devtools/bundled/js_app.html?ws=${encodeURIComponent(session.devToolsWebSocketPath)}`,
    );
    return session;
  }));

  ipcMain.handle('target:pairing', requireTarget((_event, payload) => {
    targetAgent.setPairingEnabled(payload.enabled);
    return targetAgent.getLocalState();
  }));
  ipcMain.handle('target:refresh-code', requireTarget(() => {
    targetAgent.refreshPairingCode();
    return targetAgent.getLocalState();
  }));
  ipcMain.handle('target:import-config', requireTarget((_event, payload) => {
    targetAgent.importExistingConfig(payload.path);
    return targetAgent.getLocalState();
  }));
  ipcMain.handle('target:action', requireTarget((_event, payload) => (
    targetAgent.runLocalAction(payload.action)
  )));
  ipcMain.handle('target:read-log', requireTarget((_event, payload) => (
    targetAgent.readLocalLog(payload.name, payload.options)
  )));
  ipcMain.handle('target:revoke', requireTarget((_event, payload) => {
    targetAgent.revokeClient(payload.clientId);
    return targetAgent.getLocalState();
  }));
}

function requireDeveloper(handler) {
  return async (event, payload) => {
    if (!controller) {
      throw new Error('当前不是开发端模式');
    }
    const result = await handler(event, payload);
    sendState(await buildState({ refreshStatus: true }));
    return result;
  };
}

function requireTarget(handler) {
  return async (event, payload) => {
    if (!targetAgent) {
      throw new Error('当前不是目标端模式');
    }
    const result = await handler(event, payload);
    sendState(await buildState({ refreshStatus: true }));
    return result;
  };
}

function readArgument(name) {
  const inline = process.argv.find((item) => item.startsWith(`${name}=`));
  if (inline) {
    return inline.slice(name.length + 1);
  }
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || '' : '';
}
