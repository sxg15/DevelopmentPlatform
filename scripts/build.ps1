$ErrorActionPreference = 'Stop'

$rootDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$publishDir = Join-Path $rootDir 'Publish'
$configFile = Join-Path $rootDir 'config\config.json'
$publishConfigFile = Join-Path $publishDir 'config.json'
$publishServerDir = Join-Path $publishDir 'server'
$publishRuntimeDir = Join-Path $publishDir 'runtime'
$dependencyInstallerFile = Join-Path $rootDir 'scripts\ensure-publish-dependencies.ps1'
$exampleConfigFile = Join-Path $rootDir 'config\config.example.json'
$resolvedPublishDir = [System.IO.Path]::GetFullPath($publishDir)
$workspacePrefix = [System.IO.Path]::GetFullPath($rootDir).TrimEnd('\') + '\'

Set-Location $rootDir

if (-not $resolvedPublishDir.StartsWith($workspacePrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Publish path escaped workspace: $resolvedPublishDir"
}

if (-not (Test-Path -LiteralPath $configFile)) {
    throw '缺少 config/config.json'
}
if (-not (Test-Path -LiteralPath $dependencyInstallerFile -PathType Leaf)) {
    throw '缺少便携依赖安装脚本'
}
if (-not (Test-Path -LiteralPath $exampleConfigFile -PathType Leaf)) {
    throw '缺少 config/config.example.json'
}

if (Test-Path -LiteralPath (Join-Path $publishDir 'StopWebBackend.bat')) {
    cmd /c (Join-Path $publishDir 'StopWebBackend.bat') | Out-Null
    Start-Sleep -Seconds 1
}
if (Test-Path -LiteralPath (Join-Path $publishDir 'StopConfigureWebBackend.bat')) {
    cmd /c (Join-Path $publishDir 'StopConfigureWebBackend.bat') | Out-Null
    Start-Sleep -Milliseconds 500
}

if (Test-Path -LiteralPath $publishDir) {
    Remove-Item -LiteralPath $publishDir -Recurse -Force
}

New-Item -ItemType Directory -Path $publishDir | Out-Null

npx vite build
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

npx vite build --config vite.config.config-editor.js
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

node scripts/copy-config.js
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}
Copy-Item -LiteralPath $exampleConfigFile -Destination (Join-Path $publishDir 'config.example.json') -Force

New-Item -ItemType Directory -Path $publishServerDir | Out-Null
Copy-Item -Path (Join-Path $rootDir 'server\*') -Destination $publishServerDir -Recurse -Force
Copy-Item -LiteralPath (Join-Path $rootDir 'shared') -Destination (Join-Path $publishDir 'shared') -Recurse -Force
Copy-Item -LiteralPath (Join-Path $rootDir 'package.json') -Destination (Join-Path $publishDir 'package.json') -Force
Copy-Item -LiteralPath (Join-Path $rootDir 'package-lock.json') -Destination (Join-Path $publishDir 'package-lock.json') -Force

$nodeRuntime = & node -p "JSON.stringify({path:process.execPath,platform:process.platform,arch:process.arch,major:Number(process.versions.node.split('.')[0]),version:process.versions.node})" | ConvertFrom-Json
if ($nodeRuntime.platform -ne 'win32' -or $nodeRuntime.arch -ne 'x64' -or $nodeRuntime.major -ne 24) {
    throw "便携发布要求 Windows x64 Node 24，当前为 $($nodeRuntime.platform)/$($nodeRuntime.arch) Node $($nodeRuntime.version)"
}

$npmCommand = (Get-Command npm.cmd -ErrorAction Stop).Source
$npmGlobalRoot = (& npm.cmd root -g).Trim()
$npmPackageCandidates = @(
    (Join-Path $npmGlobalRoot 'npm'),
    (Join-Path (Split-Path -Parent $npmCommand) 'node_modules\npm')
)
$npmPackageDir = $npmPackageCandidates |
    Where-Object { Test-Path -LiteralPath $_ -PathType Container } |
    Select-Object -First 1
if (-not $npmPackageDir) {
    throw '找不到可打包的 npm 运行环境'
}

New-Item -ItemType Directory -Path $publishRuntimeDir | Out-Null
Copy-Item -LiteralPath $nodeRuntime.path -Destination (Join-Path $publishRuntimeDir 'node.exe') -Force
Copy-Item -LiteralPath $npmPackageDir -Destination (Join-Path $publishRuntimeDir 'npm') -Recurse -Force
Copy-Item -LiteralPath $dependencyInstallerFile -Destination (Join-Path $publishDir 'EnsureDependencies.ps1') -Force
$packageLockStream = [System.IO.File]::OpenRead((Join-Path $rootDir 'package-lock.json'))
$sha256 = [System.Security.Cryptography.SHA256]::Create()
try {
    $dependencyStamp = [System.BitConverter]::ToString(
        $sha256.ComputeHash($packageLockStream)
    ).Replace('-', '').ToLowerInvariant()
} finally {
    $sha256.Dispose()
    $packageLockStream.Dispose()
}
Set-Content -LiteralPath (Join-Path $publishRuntimeDir 'dependency-version.txt') -Value $dependencyStamp -Encoding ASCII
foreach ($requiredFile in @(
    (Join-Path $publishRuntimeDir 'node.exe'),
    (Join-Path $publishRuntimeDir 'npm\bin\npm-cli.js'),
    (Join-Path $publishRuntimeDir 'dependency-version.txt'),
    (Join-Path $publishDir 'EnsureDependencies.ps1'),
    (Join-Path $publishServerDir 'ai\skills\work-item-plan\SKILL.md'),
    (Join-Path $publishServerDir 'config\configEditorServer.js'),
    (Join-Path $publishServerDir 'config\stopConfigEditor.js'),
    (Join-Path $publishServerDir 'config\selectFolder.ps1'),
    (Join-Path $publishDir 'config-editor\index.html'),
    (Join-Path $publishDir 'config.example.json')
)) {
    if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
        throw "便携发布缺少运行文件：$requiredFile"
    }
}
if (Test-Path -LiteralPath (Join-Path $publishDir 'node_modules')) {
    throw '轻量便携发布不应预装应用 node_modules'
}

$startBat = @'
@echo off
setlocal
title IGP Web Backend Setup
cd /d "%~dp0"
echo Preparing IGP Web Backend...
if not exist runtime\node.exe (
  echo Bundled Node runtime is missing.
  pause
  exit /b 1
)
if not exist runtime\npm\bin\npm-cli.js (
  echo Bundled npm runtime is missing.
  pause
  exit /b 1
)
if not exist EnsureDependencies.ps1 (
  echo Dependency installer is missing.
  pause
  exit /b 1
)
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0EnsureDependencies.ps1" -RootDir "%CD%"
if errorlevel 1 (
  echo Failed to prepare backend dependencies.
  pause
  exit /b 1
)
echo.
echo Starting IGP Web Backend...
set NODE_ENV=production
start "IGP Web Backend" /min cmd /c "runtime\node.exe --disable-warning=ExperimentalWarning server\index.js > server.log 2> server.err.log"
echo Web backend service started.
echo Please open http://172.16.20.205:3000/
endlocal
'@

$stopBat = @'
@echo off
setlocal
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3000" ^| findstr "LISTENING"') do (
  echo Stopping process %%a...
  taskkill /PID %%a /F >nul 2>nul
)
echo Web backend service stopped.
endlocal
'@

$configureBat = @'
@echo off
setlocal
title IGP Runtime Configuration
cd /d "%~dp0"
set "CONFIG_ROOT=%CD%"
set "ASSETS_ROOT=%CD%"
set "NODE_EXE=%CD%\runtime\node.exe"
if exist "..\..\state\deployment.json" (
  for %%I in ("..\..\state") do set "CONFIG_ROOT=%%~fI"
  for %%I in ("..\..\runtime\node.exe") do set "NODE_EXE=%%~fI"
)
if not exist "%NODE_EXE%" (
  echo Bundled Node runtime is missing.
  pause
  exit /b 1
)
if not exist "%ASSETS_ROOT%\server\config\configEditorServer.js" (
  echo Runtime configuration tool is missing.
  pause
  exit /b 1
)
if not exist "%ASSETS_ROOT%\config-editor\index.html" (
  echo Runtime configuration page is missing.
  pause
  exit /b 1
)
echo Starting IGP Runtime Configuration...
echo.
"%NODE_EXE%" "%ASSETS_ROOT%\server\config\configEditorServer.js" --root "%CONFIG_ROOT%" --assets-root "%ASSETS_ROOT%"
if errorlevel 1 (
  echo.
  echo Runtime configuration tool exited with an error.
  pause
  exit /b 1
)
echo.
echo Runtime configuration tool stopped.
powershell -NoProfile -Command "Start-Sleep -Milliseconds 1500" >nul 2>nul
endlocal
'@

$stopConfigureBat = @'
@echo off
setlocal
title Stop IGP Runtime Configuration
cd /d "%~dp0"
set "CONFIG_ROOT=%CD%"
set "ASSETS_ROOT=%CD%"
set "NODE_EXE=%CD%\runtime\node.exe"
if exist "..\..\state\deployment.json" (
  for %%I in ("..\..\state") do set "CONFIG_ROOT=%%~fI"
  for %%I in ("..\..\runtime\node.exe") do set "NODE_EXE=%%~fI"
)
if not exist "%NODE_EXE%" (
  echo Bundled Node runtime is missing.
  pause
  exit /b 1
)
if not exist "%ASSETS_ROOT%\server\config\stopConfigEditor.js" (
  echo Runtime configuration stop tool is missing.
  pause
  exit /b 1
)
"%NODE_EXE%" "%ASSETS_ROOT%\server\config\stopConfigEditor.js" --root "%CONFIG_ROOT%"
if errorlevel 1 (
  echo.
  pause
  exit /b 1
)
powershell -NoProfile -Command "Start-Sleep -Milliseconds 1500" >nul 2>nul
endlocal
'@

Set-Content -LiteralPath (Join-Path $publishDir 'StartWebBackend.bat') -Value $startBat -Encoding ASCII
Set-Content -LiteralPath (Join-Path $publishDir 'StopWebBackend.bat') -Value $stopBat -Encoding ASCII
Set-Content -LiteralPath (Join-Path $publishDir 'ConfigureWebBackend.bat') -Value $configureBat -Encoding ASCII
Set-Content -LiteralPath (Join-Path $publishDir 'StopConfigureWebBackend.bat') -Value $stopConfigureBat -Encoding ASCII

Write-Host "Build completed: $publishDir"
