# Department of Code v2 — Operator Console Desktop Shortcut Generator
# Shipped path: Windows (win32) PowerShell .lnk creation via WScript.Shell
#
# Linux (.desktop equivalent):
#   [Desktop Entry]
#   Name=Department Console
#   Exec=node --experimental-strip-types /path/to/repo/scripts/console.ts
#   Terminal=true
#   Type=Application
#
# macOS (.command equivalent):
#   #!/bin/bash
#   cd /path/to/repo && node --experimental-strip-types scripts/console.ts

[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$RepoDir = "",
  [string]$IconPath = ""
)

$ErrorActionPreference = 'Stop'

if (-not $RepoDir) {
  if ($PSScriptRoot) {
    $RepoDir = Split-Path -Parent $PSScriptRoot
  } else {
    $RepoDir = (Get-Location).Path
  }
}

Write-Host "Creating Operator Console Desktop & Start-Menu Shortcuts..." -ForegroundColor Cyan
Write-Host "Repo Directory: $RepoDir"

# Verify repository script exists
$ConsoleScript = Join-Path -Path $RepoDir -ChildPath "scripts\console.ts"
if (-not (Test-Path -Path $ConsoleScript)) {
    throw "Console launcher script not found at $ConsoleScript"
}

# Resolve target shortcut paths
$DesktopPath = [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::Desktop)
$StartMenuPath = [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::StartMenu)

$DesktopLnk = Join-Path -Path $DesktopPath -ChildPath "Department Console.lnk"
$StartMenuLnk = Join-Path -Path $StartMenuPath -ChildPath "Programs\Department Console.lnk"

# WScript Shell for .lnk creation
$WshShell = New-Object -ComObject WScript.Shell

function Create-ConsoleShortcut {
    param(
        [string]$LnkPath,
        [string]$TargetExe,
        [string]$Arguments,
        [string]$WorkingDir
    )

    if ($PSCmdlet.ShouldProcess($LnkPath, "Create/Overwrite Shortcut")) {
        $Shortcut = $WshShell.CreateShortcut($LnkPath)
        $Shortcut.TargetPath = $TargetExe
        $Shortcut.Arguments = $Arguments
        $Shortcut.WorkingDirectory = $WorkingDir
        $Shortcut.Description = "Launch Department of Code Operator Console"
        if ($IconPath -and (Test-Path -Path $IconPath)) {
            $Shortcut.IconLocation = $IconPath
        }
        $Shortcut.Save()
        Write-Host "Created shortcut: $LnkPath" -ForegroundColor Green
    } else {
        Write-Host "[WhatIf] Target Shortcut: $LnkPath -> $TargetExe $Arguments (CWD: $WorkingDir)" -ForegroundColor Yellow
    }
}

$NodeExe = (Get-Command node).Source
$ShortcutArgs = "--experimental-strip-types `"$ConsoleScript`""

Create-ConsoleShortcut -LnkPath $DesktopLnk -TargetExe $NodeExe -Arguments $ShortcutArgs -WorkingDir $RepoDir
Create-ConsoleShortcut -LnkPath $StartMenuLnk -TargetExe $NodeExe -Arguments $ShortcutArgs -WorkingDir $RepoDir

Write-Host "Shortcut generation complete." -ForegroundColor Green
