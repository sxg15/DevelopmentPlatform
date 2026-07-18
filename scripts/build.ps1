$ErrorActionPreference = 'Stop'

$rootDir = Resolve-Path (Join-Path $PSScriptRoot '..')
$publishDir = Join-Path $rootDir 'Publish'
$configFile = Join-Path $rootDir 'config\config.json'
$publishConfigFile = Join-Path $publishDir 'config.json'
$publishServerDir = Join-Path $publishDir 'server'

Set-Location $rootDir

if (-not (Test-Path -LiteralPath $configFile)) {
    throw '缺少 config/config.json'
}

if (Test-Path -LiteralPath (Join-Path $publishDir 'StopWebBackend.bat')) {
    cmd /c (Join-Path $publishDir 'StopWebBackend.bat') | Out-Null
    Start-Sleep -Seconds 1
}

if (Test-Path -LiteralPath $publishDir) {
    Remove-Item -LiteralPath $publishDir -Recurse -Force
}

New-Item -ItemType Directory -Path $publishDir | Out-Null

npx vite build
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

node scripts/copy-config.js
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

New-Item -ItemType Directory -Path $publishServerDir | Out-Null
Copy-Item -Path (Join-Path $rootDir 'server\*') -Destination $publishServerDir -Recurse -Force
Copy-Item -LiteralPath (Join-Path $rootDir 'shared') -Destination (Join-Path $publishDir 'shared') -Recurse -Force
Copy-Item -LiteralPath (Join-Path $rootDir 'package.json') -Destination (Join-Path $publishDir 'package.json') -Force
Copy-Item -LiteralPath (Join-Path $rootDir 'package-lock.json') -Destination (Join-Path $publishDir 'package-lock.json') -Force

$startBat = @'
@echo off
setlocal
cd /d "%~dp0"
if not exist node_modules\express\package.json (
  echo Installing backend dependencies...
  call npm install --omit=dev
  if errorlevel 1 (
    echo Failed to install dependencies.
    pause
    exit /b 1
  )
)
set NODE_ENV=production
start "IGP Web Backend" /min cmd /c "node server\index.js > server.log 2> server.err.log"
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

Set-Content -LiteralPath (Join-Path $publishDir 'StartWebBackend.bat') -Value $startBat -Encoding ASCII
Set-Content -LiteralPath (Join-Path $publishDir 'StopWebBackend.bat') -Value $stopBat -Encoding ASCII

Write-Host "Build completed: $publishDir"
