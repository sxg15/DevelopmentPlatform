param(
    [string]$InitialPath = ''
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Windows.Forms

$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = '选择后端只读访问的项目代码目录'
$dialog.ShowNewFolderButton = $false

if (
    -not [string]::IsNullOrWhiteSpace($InitialPath) -and
    (Test-Path -LiteralPath $InitialPath -PathType Container)
) {
    $dialog.SelectedPath = [System.IO.Path]::GetFullPath($InitialPath)
}

try {
    if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
        Write-Output $dialog.SelectedPath
    }
} finally {
    $dialog.Dispose()
}
