---
name: igp-lan-deploy
description: Maintain and use the IGP LAN deployment and remote debugging tool. Use for changes under deployment-tool/, target discovery and pairing, TLS control APIs, offline artifact packaging, release activation and rollback, service/log management, Node Inspector tunneling, Codex deployment automation, or the required post-change remote debug workflow.
---

# IGP LAN Deploy

## Ownership

- Electron lifecycle, tray, IPC, and role startup: `deployment-tool/src/main/main.js`.
- React operator UI: `deployment-tool/src/renderer/`.
- Discovery, identity, pairing, HTTPS APIs, uploads, releases, service control,
  logs, and Inspector proxy: `deployment-tool/src/main/core/`.
- Protocol constants and deployment manifests: `deployment-tool/src/shared/`.
- Codex automation bridge: `scripts/deploy-debug.js` and the tool's
  `AutomationServer`.

Keep the deployment tool in its own package. Do not add Electron-only dependencies
to the application package copied into `Publish`.

## Safety Rules

- Run the target agent outside the managed release directories.
- Never upload `config.json`, runtime logs, pairing tokens, or automation tokens.
- Pin the target TLS certificate fingerprint after pairing. Keep target access
  tokens in Electron `safeStorage`; store only token hashes on the target.
- Bind Node Inspector to target loopback and expose it only through the authenticated
  WebSocket tunnel. Do not bind Inspector or a command shell directly to the LAN.
- Validate archive paths, total and chunk hashes, the deployment manifest, and all
  extracted file hashes before registering a release.
- Keep UDP discovery fast, then fall back to bounded concurrent TLS probes of local
  subnets on the default control port when broadcasts return no targets.
- Keep fallback discovery deterministic when multiple interfaces reach the same
  target. Prefer the earlier physical-interface candidate, and update a paired
  target's saved address only when the newly discovered certificate matches.
- Honor a valid `--mode=developer|target` startup argument before persisted mode so
  login-started target agents do not return to the role chooser.
- Decorate controller and target-agent state events with `appMode` and login-startup
  state before sending them to the renderer. Ignore stale events from the previous
  role after a mode switch.
- Register renderer IPC before loading the main window. Initial role state must not
  wait for tray icon lookup or a remote target refresh, and startup failures must
  replace the loading view with an actionable error.
- Prepare dependencies before stopping the running service. On failed activation,
  restore and restart the previous release.
- Launch managed backend releases with the target-owned stable executable at
  `managed-runtime/runtime/node.exe`, never the version-specific
  `releases/<releaseId>/runtime/node.exe`. Synchronize the fixed executable from
  the active release by SHA-256 while the service is stopped, use transactional
  pending/rollback files, and recover interrupted replacements at target startup.
  The release copy remains required as the verified source for upgrades and
  rollback.
- Before spawning a service, reject an application port occupied by an unmanaged
  process. A successful health response must report the active release version.
- Service status reads must remain available when the managed process is alive but
  its health endpoint is unavailable; report an unhealthy state instead of failing
  target-agent startup.
- Bound Windows process inspection time. If WMI times out, preserve the recorded
  PID, return an actionable inspection error, and refuse duplicate start or unsafe
  stop operations.
- Reserve one release-retention slot before accepting an upload. Keep current and
  rollback releases protected, remove failed partial uploads through the control
  API, and clean interrupted upload/staging artifacts when the target starts.
- Stop only the recorded managed process after verifying its command line. Never
  scan a port and kill an arbitrary process.
- Closing the main window is a full application exit, not a minimize-to-tray action.
  Shutdown must stop the target's recorded managed service and terminate process
  trees started by developer-side build tasks before Electron exits.
- Automation job polling may retry transient local timeouts while Electron performs
  synchronous artifact work, but action requests must not be repeated automatically.

## Development

Install once, then test and build:

```powershell
npm run deploy-tool:install
npm run deploy-tool:test
npm run deploy-tool:build
npm --prefix deployment-tool run smoke:e2e
```

Use `npm run deploy-tool:package` for the Windows x64 unpacked app and portable ZIP.
Both outputs must be written under `deployment-tool/Publish/`, never the main
application's root `Publish/`.
Use `npm --prefix deployment-tool run package:installer` only when the local
NSIS/7-Zip toolchain is available.
For visible changes, run `npm --prefix deployment-tool run dev` and inspect desktop
and narrow layouts.

The end-to-end smoke test builds the real repository, prepares an offline artifact,
pairs with a temporary loopback target over pinned TLS, uploads and activates the
release, starts the service with a generated non-secret config, verifies the version,
health endpoint, homepage, and process state, then stops and removes the temporary
target.

## Required Remote Debug

After any IGP task that changes runtime code, UI, backend behavior, shared contracts,
configuration behavior, or packaging:

1. Complete the owning module tests and normal repository validation.
2. Ensure the desktop tool is running in developer mode with a paired default target.
3. Run `npm run deploy:debug`.
4. Treat a nonzero result as an unfinished task. Diagnose with:

```powershell
npm run deploy:debug -- --status
npm run deploy:debug -- --logs stderr
npm run deploy:debug -- --logs client
npm run deploy:debug -- --action restart
```

The default deploy command builds the repository, creates an offline artifact,
uploads it, activates it, starts the service, and verifies the version, process,
health endpoint, homepage, and startup errors. Do not run `log-change` merely for a
debug deployment; keep version/log mutation in the release workflow.
