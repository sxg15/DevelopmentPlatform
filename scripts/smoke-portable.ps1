param(
    [int]$Port = 43127
)

$ErrorActionPreference = 'Stop'

$rootDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$publishDir = Join-Path $rootDir 'Publish'
$tempRoot = [System.IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\'
$smokeDir = Join-Path $env:TEMP ("IGP Portable Smoke " + [guid]::NewGuid().ToString('N'))
$resolvedSmokeDir = [System.IO.Path]::GetFullPath($smokeDir)
$serverProcessId = 0
$configEditorProcessId = 0
$configEditorPort = $Port + 1
$configEditorToken = 'portable-smoke-config-token'

if (-not $resolvedSmokeDir.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Smoke path escaped temp directory: $resolvedSmokeDir"
}
if (-not (Test-Path -LiteralPath $publishDir -PathType Container)) {
    throw 'Publish directory does not exist'
}
if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
    throw "Smoke port $Port is already in use"
}
if (Get-NetTCPConnection -LocalPort $configEditorPort -State Listen -ErrorAction SilentlyContinue) {
    throw "Config editor smoke port $configEditorPort is already in use"
}

try {
    New-Item -ItemType Directory -Path $smokeDir | Out-Null
    Get-ChildItem -LiteralPath $publishDir -Force |
        Where-Object { $_.Name -ne 'config.json' } |
        ForEach-Object {
            Copy-Item -LiteralPath $_.FullName -Destination $smokeDir -Recurse -Force
        }

    $smokeConfig = @{
        server = @{
            host = '127.0.0.1'
            port = $Port
        }
        feishu = @{
            appId = ''
            appSecret = 'portable-smoke-secret'
        }
        aiPlanning = @{
            enabled = $false
        }
    } | ConvertTo-Json -Depth 6
    $utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText(
        (Join-Path $smokeDir 'config.json'),
        $smokeConfig,
        $utf8WithoutBom
    )

    if (Test-Path -LiteralPath (Join-Path $smokeDir 'node_modules')) {
        throw 'Portable package unexpectedly contains preinstalled application dependencies'
    }
    foreach ($requiredConfigEditorFile in @(
        (Join-Path $smokeDir 'ConfigureWebBackend.bat'),
        (Join-Path $smokeDir 'StopConfigureWebBackend.bat'),
        (Join-Path $smokeDir 'config-editor\index.html'),
        (Join-Path $smokeDir 'server\config\configEditorServer.js'),
        (Join-Path $smokeDir 'server\config\stopConfigEditor.js'),
        (Join-Path $smokeDir 'server\config\selectFolder.ps1'),
        (Join-Path $smokeDir 'config.example.json')
    )) {
        if (-not (Test-Path -LiteralPath $requiredConfigEditorFile -PathType Leaf)) {
            throw "Portable config editor file is missing: $requiredConfigEditorFile"
        }
    }

    $previousEditorPort = $env:IGP_CONFIG_EDITOR_PORT
    $previousEditorToken = $env:IGP_CONFIG_EDITOR_TOKEN
    $previousEditorNoBrowser = $env:IGP_CONFIG_EDITOR_NO_BROWSER
    try {
        $env:IGP_CONFIG_EDITOR_PORT = [string]$configEditorPort
        $env:IGP_CONFIG_EDITOR_TOKEN = $configEditorToken
        $env:IGP_CONFIG_EDITOR_NO_BROWSER = '1'
        $editorScriptArgument = '"{0}"' -f (Join-Path $smokeDir 'server\config\configEditorServer.js')
        $editorRootArgument = '"{0}"' -f $smokeDir
        $configEditorProcess = Start-Process `
            -FilePath (Join-Path $smokeDir 'runtime\node.exe') `
            -ArgumentList @(
                $editorScriptArgument,
                '--root',
                $editorRootArgument
            ) `
            -WorkingDirectory $smokeDir `
            -WindowStyle Hidden `
            -PassThru
        $configEditorProcessId = $configEditorProcess.Id
    } finally {
        $env:IGP_CONFIG_EDITOR_PORT = $previousEditorPort
        $env:IGP_CONFIG_EDITOR_TOKEN = $previousEditorToken
        $env:IGP_CONFIG_EDITOR_NO_BROWSER = $previousEditorNoBrowser
    }

    $editorHeaders = @{
        'X-Config-Editor-Token' = $configEditorToken
    }
    $editorOrigin = "http://127.0.0.1:$configEditorPort"
    $editorConfig = $null
    for ($attempt = 0; $attempt -lt 40; $attempt += 1) {
        Start-Sleep -Milliseconds 250
        try {
            $editorConfig = Invoke-RestMethod `
                -Uri "$editorOrigin/api/config" `
                -Headers $editorHeaders `
                -TimeoutSec 2
            if ($editorConfig.ok -eq $true) {
                break
            }
        } catch {
            $editorConfig = $null
        }
    }
    if ($editorConfig.ok -ne $true) {
        throw 'Portable config editor did not become ready'
    }
    $unauthorizedBlocked = $false
    try {
        Invoke-RestMethod `
            -Uri "$editorOrigin/api/config" `
            -TimeoutSec 2 | Out-Null
    } catch {
        $statusCode = [int]$_.Exception.Response.StatusCode
        if ($statusCode -eq 403) {
            $unauthorizedBlocked = $true
        } else {
            throw
        }
    }
    if (-not $unauthorizedBlocked) {
        throw 'Portable config editor accepted a request without its session token'
    }
    $editorResponseText = $editorConfig | ConvertTo-Json -Depth 20
    if ($editorResponseText.Contains('portable-smoke-secret')) {
        throw 'Portable config editor exposed an existing secret'
    }
    $editorConfig.config.debug.userName = 'Portable Config Smoke'
    $savePayload = @{
        revision = $editorConfig.revision
        config = $editorConfig.config
        secretChanges = @{
            'feishu.appSecret' = @{ action = 'keep' }
            'aiPlanning.codex.apiKey' = @{ action = 'keep' }
        }
    } | ConvertTo-Json -Depth 20
    $saveHeaders = @{
        'X-Config-Editor-Token' = $configEditorToken
        Origin = $editorOrigin
    }
    $saveResult = Invoke-RestMethod `
        -Uri "$editorOrigin/api/config" `
        -Method Put `
        -Headers $saveHeaders `
        -ContentType 'application/json' `
        -Body $savePayload `
        -TimeoutSec 10
    if ($saveResult.ok -ne $true -or $saveResult.restartRequired -ne $true) {
        throw 'Portable config editor failed to save the config'
    }
    if (Test-Path -LiteralPath (Join-Path $smokeDir 'node_modules')) {
        throw 'Portable config editor unexpectedly installed application dependencies'
    }
    & (Join-Path $smokeDir 'StopConfigureWebBackend.bat')
    if ($LASTEXITCODE -ne 0) {
        throw "Portable config editor stop command failed with exit code $LASTEXITCODE"
    }
    Wait-Process -Id $configEditorProcessId -Timeout 5 -ErrorAction SilentlyContinue
    if (Get-Process -Id $configEditorProcessId -ErrorAction SilentlyContinue) {
        throw 'Portable config editor process remained active after the stop command'
    }
    $configEditorProcessId = 0

    Push-Location $smokeDir
    try {
        & (Join-Path $smokeDir 'StartWebBackend.bat')
    } finally {
        Pop-Location
    }
    if ($LASTEXITCODE -ne 0) {
        throw "Portable startup failed with exit code $LASTEXITCODE"
    }

    $health = $null
    for ($attempt = 0; $attempt -lt 40; $attempt += 1) {
        Start-Sleep -Milliseconds 250
        try {
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 2
            if ($health.ok -eq $true) {
                break
            }
        } catch {
            $health = $null
        }
    }

    if ($health.ok -ne $true) {
        $errorTail = (
            Get-Content -LiteralPath (Join-Path $smokeDir 'server.err.log') -Tail 20 -ErrorAction SilentlyContinue
        ) -join ' '
        throw "Portable server health check failed: $errorTail"
    }
    $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop |
        Select-Object -First 1
    $serverProcessId = [int]$listener.OwningProcess
    & powershell.exe `
        -NoProfile `
        -ExecutionPolicy Bypass `
        -File (Join-Path $smokeDir 'EnsureDependencies.ps1') `
        -RootDir $smokeDir
    if ($LASTEXITCODE -ne 0) {
        throw "Portable dependency recheck failed with exit code $LASTEXITCODE"
    }

    $nodeInfo = & (Join-Path $smokeDir 'runtime\node.exe') -p (
        "process.platform + '/' + process.arch + ' Node ' + process.versions.node"
    )
    Write-Host "Portable smoke passed from relocated path: $nodeInfo"
} finally {
    if ($configEditorProcessId -gt 0) {
        Stop-Process -Id $configEditorProcessId -Force -ErrorAction SilentlyContinue
    }
    if ($serverProcessId -gt 0) {
        Stop-Process -Id $serverProcessId -Force -ErrorAction SilentlyContinue
    } else {
        Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty OwningProcess -Unique |
            ForEach-Object {
                Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue
            }
    }

    if (-not $resolvedSmokeDir.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to clean smoke path outside temp directory: $resolvedSmokeDir"
    }
    if (Test-Path -LiteralPath $resolvedSmokeDir) {
        Remove-Item -LiteralPath $resolvedSmokeDir -Recurse -Force
    }
}
