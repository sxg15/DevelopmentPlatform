param(
    [int]$Port = 43127
)

$ErrorActionPreference = 'Stop'

$rootDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$publishDir = Join-Path $rootDir 'Publish'
$tempRoot = [System.IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\'
$smokeDir = Join-Path $env:TEMP ("IGP Portable Smoke " + [guid]::NewGuid().ToString('N'))
$resolvedSmokeDir = [System.IO.Path]::GetFullPath($smokeDir)
$process = $null
$previousNodeEnv = $env:NODE_ENV

if (-not $resolvedSmokeDir.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Smoke path escaped temp directory: $resolvedSmokeDir"
}
if (-not (Test-Path -LiteralPath $publishDir -PathType Container)) {
    throw 'Publish directory does not exist'
}
if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
    throw "Smoke port $Port is already in use"
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
            appSecret = ''
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

    $stdout = Join-Path $smokeDir 'smoke.stdout.log'
    $stderr = Join-Path $smokeDir 'smoke.stderr.log'
    $env:NODE_ENV = 'production'
    $process = Start-Process `
        -FilePath (Join-Path $smokeDir 'runtime\node.exe') `
        -ArgumentList @('--disable-warning=ExperimentalWarning', 'server\index.js') `
        -WorkingDirectory $smokeDir `
        -WindowStyle Hidden `
        -RedirectStandardOutput $stdout `
        -RedirectStandardError $stderr `
        -PassThru

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
        $errorTail = (Get-Content -LiteralPath $stderr -Tail 20 -ErrorAction SilentlyContinue) -join ' '
        throw "Portable server health check failed: $errorTail"
    }

    $nodeInfo = & (Join-Path $smokeDir 'runtime\node.exe') -p (
        "process.platform + '/' + process.arch + ' Node ' + process.versions.node"
    )
    Write-Host "Portable smoke passed from relocated path: $nodeInfo"
} finally {
    if ($process -and -not $process.HasExited) {
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        $process.WaitForExit(5000) | Out-Null
    }
    $env:NODE_ENV = $previousNodeEnv

    if (-not $resolvedSmokeDir.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to clean smoke path outside temp directory: $resolvedSmokeDir"
    }
    if (Test-Path -LiteralPath $resolvedSmokeDir) {
        Remove-Item -LiteralPath $resolvedSmokeDir -Recurse -Force
    }
}
