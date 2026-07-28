param(
    [string]$RootDir = ''
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($RootDir)) {
    $RootDir = $PSScriptRoot
}

$resolvedRoot = [System.IO.Path]::GetFullPath($RootDir)
$runtimeDir = Join-Path $resolvedRoot 'runtime'
$nodeExecutable = Join-Path $runtimeDir 'node.exe'
$npmCli = Join-Path $runtimeDir 'npm\bin\npm-cli.js'
$expectedStampFile = Join-Path $runtimeDir 'dependency-version.txt'
$nodeModulesDir = Join-Path $resolvedRoot 'node_modules'
$installedStampFile = Join-Path $nodeModulesDir '.igp-dependency-version'
$installLockFile = Join-Path $runtimeDir 'dependency-install.lock'
$requiredDependencyFiles = @(
    (Join-Path $nodeModulesDir 'express\package.json'),
    (Join-Path $nodeModulesDir '@modelcontextprotocol\server\package.json'),
    (Join-Path $nodeModulesDir '@modelcontextprotocol\node\package.json'),
    (Join-Path $nodeModulesDir '@openai\codex\package.json'),
    (Join-Path $nodeModulesDir '@openai\codex-win32-x64\package.json'),
    (Join-Path $nodeModulesDir 'zod\package.json'),
    (Join-Path $nodeModulesDir '@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe')
)

foreach ($requiredRuntimeFile in @($nodeExecutable, $npmCli, $expectedStampFile)) {
    if (-not (Test-Path -LiteralPath $requiredRuntimeFile -PathType Leaf)) {
        throw "Bundled dependency runtime is incomplete: $requiredRuntimeFile"
    }
}

function Test-DependenciesReady {
    foreach ($requiredFile in $requiredDependencyFiles) {
        if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
            return $false
        }
    }
    if (-not (Test-Path -LiteralPath $installedStampFile -PathType Leaf)) {
        return $false
    }

    $expectedStamp = (Get-Content -LiteralPath $expectedStampFile -Raw).Trim()
    $installedStamp = (Get-Content -LiteralPath $installedStampFile -Raw).Trim()
    return [bool]($expectedStamp -and $expectedStamp -eq $installedStamp)
}

if (Test-DependenciesReady) {
    Write-Host '[1/3] Dependency check complete: existing files are current.'
    exit 0
}

Write-Host '[1/3] Checking the dependency installation state...'
$lockStream = $null
$lockDeadline = [DateTime]::UtcNow.AddMinutes(15)
$waitNoticeShown = $false
while (-not $lockStream) {
    try {
        $lockStream = [System.IO.File]::Open(
            $installLockFile,
            [System.IO.FileMode]::OpenOrCreate,
            [System.IO.FileAccess]::ReadWrite,
            [System.IO.FileShare]::None
        )
    } catch [System.IO.IOException] {
        if (-not $waitNoticeShown) {
            Write-Host 'Waiting for another dependency installation...'
            $waitNoticeShown = $true
        }
        if ([DateTime]::UtcNow -ge $lockDeadline) {
            throw 'Timed out waiting for another dependency installation.'
        }
        Start-Sleep -Seconds 1
    }
}

try {
    if (Test-DependenciesReady) {
        Write-Host '[1/3] Dependency check complete: another process finished the installation.'
        exit 0
    }

    Write-Host '[2/3] Downloading backend production dependencies...'
    Write-Host '      npm will print each network request and its download status below.'
    & $nodeExecutable $npmCli `
        'ci' `
        '--omit=dev' `
        '--ignore-scripts' `
        '--no-audit' `
        '--no-fund' `
        '--progress=true' `
        '--loglevel=http' `
        '--prefix' $resolvedRoot
    if ($LASTEXITCODE -ne 0) {
        throw "Dependency installation failed with exit code $LASTEXITCODE."
    }

    Write-Host '[3/3] Verifying downloaded dependencies...'
    foreach ($requiredFile in $requiredDependencyFiles) {
        if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
            throw "Downloaded dependencies are incomplete: $requiredFile"
        }
    }

    $expectedStamp = (Get-Content -LiteralPath $expectedStampFile -Raw).Trim()
    $utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText(
        $installedStampFile,
        "$expectedStamp`n",
        $utf8WithoutBom
    )
    Write-Host '[3/3] Backend dependencies downloaded and verified successfully.'
} finally {
    if ($lockStream) {
        $lockStream.Dispose()
    }
    Remove-Item -LiteralPath $installLockFile -Force -ErrorAction SilentlyContinue
}
