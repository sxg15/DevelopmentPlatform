$ErrorActionPreference = 'Stop'

$rootDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$publishDir = Join-Path $rootDir 'Publish'
$stateRoot = Join-Path $rootDir 'runtime-state'
$resolvedPublishDir = [System.IO.Path]::GetFullPath($publishDir)
$workspacePrefix = [System.IO.Path]::GetFullPath($rootDir).TrimEnd('\') + '\'

if (-not $resolvedPublishDir.StartsWith($workspacePrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Publish path escaped project root: $resolvedPublishDir"
}

$publishedController = Join-Path $publishDir 'src\processController.js'
$publishedNode = Join-Path $publishDir 'runtime\node.exe'
if ((Test-Path -LiteralPath $publishedController -PathType Leaf) -and
    (Test-Path -LiteralPath $publishedNode -PathType Leaf)) {
    & $publishedNode $publishedController stop `
        --root $publishDir `
        --state-root $stateRoot `
        --node-exe $publishedNode `
        --agent-entry (Join-Path $publishDir 'src\agent.js') `
        --config-path (Join-Path $stateRoot 'config.json') | Out-Null
}

if (Test-Path -LiteralPath $publishDir) {
    Remove-Item -LiteralPath $publishDir -Recurse -Force
}

New-Item -ItemType Directory -Path $publishDir | Out-Null
New-Item -ItemType Directory -Path (Join-Path $publishDir 'runtime') | Out-Null

Copy-Item -LiteralPath (Join-Path $rootDir 'src') -Destination (Join-Path $publishDir 'src') -Recurse
Copy-Item -LiteralPath (Join-Path $rootDir 'server') -Destination (Join-Path $publishDir 'server') -Recurse
Copy-Item -LiteralPath (Join-Path $rootDir 'package.json') -Destination (Join-Path $publishDir 'package.json')
Copy-Item -LiteralPath (Join-Path $rootDir 'config.example.json') -Destination (Join-Path $publishDir 'config.example.json')

$nodeRuntime = & node -p "JSON.stringify({path:process.execPath,platform:process.platform,arch:process.arch,major:Number(process.versions.node.split('.')[0]),version:process.versions.node})" | ConvertFrom-Json
if ($nodeRuntime.platform -ne 'win32' -or $nodeRuntime.arch -ne 'x64' -or $nodeRuntime.major -ne 24) {
    throw "Public entry gateway requires Windows x64 Node 24, current runtime is $($nodeRuntime.platform)/$($nodeRuntime.arch) Node $($nodeRuntime.version)"
}
Copy-Item -LiteralPath $nodeRuntime.path -Destination (Join-Path $publishDir 'runtime\node.exe')

$startBat = @'
@echo off
setlocal
title IGP Public Entry Gateway
cd /d "%~dp0"
for %%I in ("..\runtime-state") do set "STATE_ROOT=%%~fI"
set "NODE_EXE=%CD%\runtime\node.exe"
set "CONTROLLER=%CD%\src\processController.js"
set "AGENT_ENTRY=%CD%\src\agent.js"
set "CONFIG_PATH=%STATE_ROOT%\config.json"
if not exist "%NODE_EXE%" (
  echo Bundled Node runtime is missing.
  pause
  exit /b 1
)
if not exist "%CONFIG_PATH%" (
  echo Runtime config is missing: %CONFIG_PATH%
  echo Copy config.example.json to that path and configure the relay token and SSH key.
  pause
  exit /b 1
)
"%NODE_EXE%" "%CONTROLLER%" start --root "%CD%" --state-root "%STATE_ROOT%" --node-exe "%NODE_EXE%" --agent-entry "%AGENT_ENTRY%" --config-path "%CONFIG_PATH%"
if errorlevel 1 (
  echo Public entry gateway failed to start.
  pause
  exit /b 1
)
echo Public entry gateway started.
endlocal
'@

$stopBat = @'
@echo off
setlocal
title Stop IGP Public Entry Gateway
cd /d "%~dp0"
for %%I in ("..\runtime-state") do set "STATE_ROOT=%%~fI"
set "NODE_EXE=%CD%\runtime\node.exe"
set "CONTROLLER=%CD%\src\processController.js"
set "AGENT_ENTRY=%CD%\src\agent.js"
set "CONFIG_PATH=%STATE_ROOT%\config.json"
if not exist "%NODE_EXE%" (
  echo Bundled Node runtime is missing.
  pause
  exit /b 1
)
"%NODE_EXE%" "%CONTROLLER%" stop --root "%CD%" --state-root "%STATE_ROOT%" --node-exe "%NODE_EXE%" --agent-entry "%AGENT_ENTRY%" --config-path "%CONFIG_PATH%"
if errorlevel 1 (
  echo Public entry gateway failed to stop.
  pause
  exit /b 1
)
echo Public entry gateway stopped.
endlocal
'@

Set-Content -LiteralPath (Join-Path $publishDir 'StartPublicEntryGateway.bat') -Value $startBat -Encoding ASCII
Set-Content -LiteralPath (Join-Path $publishDir 'StopPublicEntryGateway.bat') -Value $stopBat -Encoding ASCII

foreach ($requiredFile in @(
    (Join-Path $publishDir 'runtime\node.exe'),
    (Join-Path $publishDir 'src\agent.js'),
    (Join-Path $publishDir 'src\processController.js'),
    (Join-Path $publishDir 'server\install-public-relay.sh'),
    (Join-Path $publishDir 'server\nginx\igp-public-entry.conf.template'),
    (Join-Path $publishDir 'StartPublicEntryGateway.bat'),
    (Join-Path $publishDir 'StopPublicEntryGateway.bat'),
    (Join-Path $publishDir 'config.example.json')
)) {
    if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
        throw "Publish output is missing: $requiredFile"
    }
}

Write-Host "Build completed: $publishDir"
