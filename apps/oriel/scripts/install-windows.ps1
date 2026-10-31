<#
.SYNOPSIS
  Builds Oriel from this clone and installs it on Windows 11 x64, replacing Electron Oriel.

.DESCRIPTION
  Usage, from the repository root in PowerShell (7 or Windows PowerShell 5.1):

    powershell -ExecutionPolicy Bypass -File apps\oriel\scripts\install-windows.ps1

  It runs these steps in order, skipping whatever is already done, so running it again is safe:

    1. Prerequisites, each installed through winget only if missing: the Visual Studio 2022 Build
       Tools with the C++ tools and a Windows 11 SDK, rustup, the .NET SDK, and Velopack's vpk.
       The Build Tools and the .NET SDK install machine-wide, so Windows asks for administrator
       rights for those two; nothing else runs elevated.
    2. The build: the pinned Rust toolchain, the vendored libraries and tools, then Setup.exe
       (cargo run -p xtask -- package windows). The first build takes a while and tens of GB.
    3. Electron Oriel, if installed, is uninstalled, and its old data folder is moved aside to
       %USERPROFILE%\.latch-works\oriel-electron-<date>. Nothing is deleted.
    4. Setup.exe installs Oriel silently to %LOCALAPPDATA%\Oriel, and Oriel starts.

  Switches:

    -SkipPrerequisites  Don't check or install the prerequisites.
    -BuildOnly          Build Setup.exe, then stop: no uninstall, no install, no launch.
    -NoLaunch           Install, but don't start Oriel.
    -Clean              Only remove the Rust build folder (apps\oriel\target) to recover disk,
                        then stop. The installed app doesn't need it; the next build starts over.

  A failed step is named, and the script exits with code 1. The installers' logs go to
  %TEMP%\oriel-install. Plan 064 (docs/plans/064-oriel-windows.md) and
  docs/runbooks/oriel-windows.md say more.
  Written on a Mac and never run; the plan lists what is unverified.
#>

[CmdletBinding()]
param(
  [switch]$SkipPrerequisites,
  [switch]$BuildOnly,
  [switch]$NoLaunch,
  [switch]$Clean
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# PowerShell 7.3 and later: a native command's exit code is checked by hand, below.
$PSNativeCommandUseErrorActionPreference = $false
$ProgressPreference = 'SilentlyContinue'

# --- Where things are ---------------------------------------------------------------------------

$Workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path   # apps\oriel
$InstallRoot = Join-Path $env:LOCALAPPDATA 'Oriel'       # Velopack's pack id is Oriel
$InstalledExe = Join-Path (Join-Path $InstallRoot 'current') 'oriel.exe'
$LatchWorks = Join-Path $env:USERPROFILE '.latch-works'
$DataFolder = Join-Path $LatchWorks 'oriel'
$LogFolder = Join-Path $env:TEMP 'oriel-install'

# winget's exit codes that still leave the package installed (winget-cli's returnCodes.md).
$WingetAlreadyInstalled = -1978335135   # 0x8A150061 APPINSTALLER_CLI_ERROR_PACKAGE_ALREADY_INSTALLED
$WingetNoUpdate = -1978335189           # 0x8A15002B APPINSTALLER_CLI_ERROR_UPDATE_NOT_APPLICABLE
$WingetRebootToFinish = -1978334967     # 0x8A150109 APPINSTALLER_CLI_ERROR_INSTALL_REBOOT_REQUIRED_TO_FINISH

$MsvcHost = 'x86_64-pc-windows-msvc'
# The MSVC compiler and the Windows 11 SDK, whose 10.0.26100.0 folder is where GPUI's build looks
# for fxc.exe by default. Component ids from Microsoft's "Visual Studio Build Tools component
# directory"; the components exist in every edition, the workload in the Build Tools only.
$VsWorkload = 'Microsoft.VisualStudio.Workload.VCTools'
$VsComponents = @(
  'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
  'Microsoft.VisualStudio.Component.Windows11SDK.26100'
)

$script:StepNumber = 0
$script:StepName = 'starting'
$script:Notes = New-Object System.Collections.Generic.List[string]

# --- Output -------------------------------------------------------------------------------------

function Start-Step([string]$Name) {
  $script:StepNumber++
  $script:StepName = $Name
  Write-Host ''
  Write-Host ("==> [{0}] {1}" -f $script:StepNumber, $Name) -ForegroundColor Cyan
}

function Write-Detail([string]$Text) { Write-Host ("    {0}" -f $Text) }

function Write-Done([string]$Text) { Write-Host ("    ok: {0}" -f $Text) -ForegroundColor Green }

function Write-Warn([string]$Text) { Write-Host ("    warning: {0}" -f $Text) -ForegroundColor Yellow }

function Add-Note([string]$Text) { $script:Notes.Add($Text) }

# --- Helpers ------------------------------------------------------------------------------------

# Runs a console program, its output going straight to the console, and throws on a non-zero exit.
# The preference is relaxed around it so that Windows PowerShell 5.1 does not turn the program's
# stderr (cargo's progress) into a terminating error when the script's output is redirected.
function Invoke-Checked {
  param([Parameter(Mandatory = $true)][string]$FilePath, [string[]]$ArgumentList = @())
  Write-Detail ("> {0} {1}" -f $FilePath, ($ArgumentList -join ' '))
  if (-not (Get-Command $FilePath -ErrorAction SilentlyContinue)) { throw ("{0} is not on PATH" -f $FilePath) }
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    # Out-Host keeps the program's stdout (xtask's progress) on the console, out of the
    # calling function's return value.
    & $FilePath @ArgumentList | Out-Host
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previous
  }
  if ($code -ne 0) {
    throw ("'{0} {1}' exited with code {2}" -f $FilePath, ($ArgumentList -join ' '), $code)
  }
}

# Runs a console program and returns its exit code and stdout lines; stderr is dropped.
function Get-NativeOutput {
  param([Parameter(Mandatory = $true)][string]$FilePath, [string[]]$ArgumentList = @())
  if (-not (Get-Command $FilePath -ErrorAction SilentlyContinue)) { throw ("{0} is not on PATH" -f $FilePath) }
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $output = & $FilePath @ArgumentList 2>$null
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previous
  }
  return [pscustomobject]@{
    ExitCode = $code
    Lines = @($output | ForEach-Object { "$_" })
  }
}

# Starts a program (a GUI one too, which PowerShell would not wait for), waits for it and returns
# its exit code. It waits for the process alone: Start-Process -Wait also waits for every process
# it started, which an installer can leave running.
function Invoke-AndWait {
  param([Parameter(Mandatory = $true)][string]$FilePath, [string]$Arguments, [switch]$Elevated)
  $start = @{ FilePath = $FilePath; PassThru = $true }
  if ($Arguments) { $start.ArgumentList = $Arguments }
  if ($Elevated -and -not (Test-IsAdministrator)) {
    $start.Verb = 'RunAs'
  } else {
    $start.NoNewWindow = $true
  }
  $process = Start-Process @start
  # Holding the handle keeps the exit code readable once the process has gone.
  $null = $process.Handle
  $process.WaitForExit()
  return $process.ExitCode
}

function Test-IsAdministrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Test-Command([string]$Name) {
  return $null -ne (Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue)
}

# Reloads PATH from the registry, so programs installed a moment ago are found in this session,
# keeping anything this session added.
function Update-SessionPath {
  $entries = New-Object System.Collections.Generic.List[string]
  $sources = @(
    [Environment]::GetEnvironmentVariable('Path', 'Machine'),
    [Environment]::GetEnvironmentVariable('Path', 'User'),
    $env:Path
  )
  foreach ($source in $sources) {
    if (-not $source) { continue }
    foreach ($entry in $source.Split(';')) {
      if ($entry -and -not $entries.Contains($entry)) { $entries.Add($entry) }
    }
  }
  foreach ($extra in @((Join-Path $env:USERPROFILE '.cargo\bin'), (Join-Path $env:USERPROFILE '.dotnet\tools'))) {
    if ((Test-Path -LiteralPath $extra) -and -not $entries.Contains($extra)) { $entries.Add($extra) }
  }
  $env:Path = $entries -join ';'
}

function Get-FolderBytes([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return [double]0 }
  $sum = (Get-ChildItem -LiteralPath $Path -Recurse -File -Force -ErrorAction SilentlyContinue |
      Measure-Object -Property Length -Sum).Sum
  return [double]$sum
}

function Format-Size([double]$Bytes) {
  if ($Bytes -ge 1GB) { return ('{0:N1} GB' -f ($Bytes / 1GB)) }
  return ('{0:N0} MB' -f ($Bytes / 1MB))
}

# The value of `<name> = "<value>"` in a file, as the Rust sources and TOML files write it.
function Read-Pin([string]$File, [string]$Pattern) {
  $text = [IO.File]::ReadAllText($File)
  $match = [regex]::Match($text, $Pattern)
  if (-not $match.Success) { throw ("{0} has no match for {1}" -f $File, $Pattern) }
  return $match.Groups[1].Value
}

# Cargo's target folder, as xtask's bundle::target_folder finds it.
function Get-TargetFolder {
  if ($env:CARGO_TARGET_DIR) {
    if ([IO.Path]::IsPathRooted($env:CARGO_TARGET_DIR)) { return $env:CARGO_TARGET_DIR }
    return (Join-Path $Workspace $env:CARGO_TARGET_DIR)
  }
  return (Join-Path $Workspace 'target')
}

# --- Prerequisites ------------------------------------------------------------------------------

function Install-WingetPackage {
  param([string]$Id, [string]$Override, [switch]$Elevated, [string]$Why)
  if (-not (Test-Command 'winget')) {
    throw 'winget is missing. Install or update "App Installer" from the Microsoft Store, then run this again.'
  }
  New-Item -ItemType Directory -Force -Path $LogFolder | Out-Null
  $log = Join-Path $LogFolder ("winget-{0}.log" -f $Id)
  $arguments = "install --id $Id --exact --source winget --accept-package-agreements " +
    "--accept-source-agreements --disable-interactivity --log `"$log`""
  if ($Override) {
    $arguments += " --override `"$Override`""
  } else {
    $arguments += ' --silent'
  }
  if ($Elevated) {
    Write-Detail ("Administrator rights needed: {0}. Windows will ask for permission." -f $Why)
  }
  Write-Detail ("> winget {0}" -f $arguments)
  $winget = (Get-Command 'winget' -CommandType Application | Select-Object -First 1).Source
  $code = Invoke-AndWait -FilePath $winget -Arguments $arguments -Elevated:$Elevated
  if ($code -eq $WingetRebootToFinish) {
    Add-Note ("{0} asks for a restart of Windows to finish; restart before the next run if the build fails." -f $Id)
  } elseif ($code -ne 0 -and $code -ne $WingetAlreadyInstalled -and $code -ne $WingetNoUpdate) {
    throw ("winget could not install {0} (exit code {1}); its log is {2}" -f $Id, $code, $log)
  }
  Update-SessionPath
}

# The newest Windows SDK tool, by version folder, or $null.
function Find-SdkTool([string]$Name) {
  $bin = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
  if (-not (Test-Path -LiteralPath $bin)) { return $null }
  $versions = @(Get-ChildItem -LiteralPath $bin -Directory |
      Where-Object { $_.Name -match '^\d+(\.\d+){1,3}$' } |
      Sort-Object -Descending -Property @{ Expression = { [version]$_.Name } })
  foreach ($version in $versions) {
    $tool = Join-Path $version.FullName (Join-Path 'x64' $Name)
    if (Test-Path -LiteralPath $tool) { return $tool }
  }
  return $null
}

function Test-WindowsSdk {
  $include = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\Include'
  $headers = @(Get-ChildItem -Path (Join-Path $include '10.*\um\Windows.h') -ErrorAction SilentlyContinue)
  return ($null -ne (Find-SdkTool 'fxc.exe')) -and ($null -ne (Find-SdkTool 'rc.exe')) -and ($headers.Count -gt 0)
}

function Get-VsWhere {
  $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
  if (Test-Path -LiteralPath $vswhere) { return $vswhere }
  return $null
}

# The installation path of the newest Visual Studio (any edition, Build Tools included) that
# has the component, or of the newest at all with no component given; $null when there is none.
function Find-VisualStudio([string]$Component) {
  $vswhere = Get-VsWhere
  if (-not $vswhere) { return $null }
  $arguments = @('-latest', '-products', '*', '-property', 'installationPath')
  if ($Component) { $arguments += @('-requires', $Component) }
  $result = Get-NativeOutput -FilePath $vswhere -ArgumentList $arguments
  $paths = @($result.Lines | Where-Object { $_ })
  if ($result.ExitCode -ne 0 -or $paths.Count -eq 0) { return $null }
  return $paths[0]
}

function Install-BuildTools {
  $why = 'the Visual Studio Build Tools install machine-wide, under Program Files'
  $cpp = Find-VisualStudio 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64'
  if ($cpp -and (Test-WindowsSdk)) {
    Write-Done ("MSVC in {0}, and a Windows SDK with fxc.exe and rc.exe" -f $cpp)
    return
  }
  $adds = ($VsComponents | ForEach-Object { "--add $_" }) -join ' '
  $existing = Find-VisualStudio ''
  if ($existing) {
    # winget installs, but does not add components to an existing Visual Studio: its own
    # installer's modify verb does (Microsoft's "Use command-line parameters" page).
    Write-Detail ("Visual Studio at {0} lacks the C++ tools or the Windows SDK; adding them." -f $existing)
    $installer = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\setup.exe'
    $arguments = "modify --installPath `"$existing`" $adds --passive --norestart"
    Write-Detail ("Administrator rights needed: {0}. Windows will ask for permission." -f $why)
    Write-Detail ("> {0} {1}" -f $installer, $arguments)
    # The installer must not be started from its own folder.
    Push-Location $env:TEMP
    try {
      $code = Invoke-AndWait -FilePath $installer -Arguments $arguments -Elevated
    } finally {
      Pop-Location
    }
    if ($code -eq 3010) {
      Add-Note 'Visual Studio asks for a restart of Windows to finish.'
    } elseif ($code -ne 0) {
      throw ("the Visual Studio Installer's modify exited with code {0}" -f $code)
    }
  } else {
    # --override replaces the manifest's switches, so it carries --wait for winget to wait on.
    Install-WingetPackage -Id 'Microsoft.VisualStudio.2022.BuildTools' -Elevated -Why $why `
      -Override "--wait --passive --norestart --add $VsWorkload $adds"
  }
  $cpp = Find-VisualStudio 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64'
  if (-not $cpp -or -not (Test-WindowsSdk)) {
    throw ('the C++ build tools or the Windows SDK are still missing. If the Visual Studio ' +
      'Installer is still running, let it finish and run this again; otherwise open it, Modify, ' +
      'and tick "Desktop development with C++" with a Windows 11 SDK.')
  }
  Write-Done ("MSVC in {0}" -f $cpp)
}

function Install-Rustup {
  Update-SessionPath
  if (Test-Command 'rustup') {
    Write-Done 'rustup is installed'
    return
  }
  Install-WingetPackage -Id 'Rustlang.Rustup'
  if (-not (Test-Command 'rustup')) {
    throw 'rustup was installed but is not on PATH; open a new PowerShell window and run this again.'
  }
  Write-Done 'rustup installed'
}

function Test-DotnetSdk {
  if (-not (Test-Command 'dotnet')) { return $false }
  $result = Get-NativeOutput -FilePath 'dotnet' -ArgumentList @('--list-sdks')
  foreach ($line in $result.Lines) {
    if ($line -match '^(\d+)\.' -and [int]$Matches[1] -ge 8) { return $true }
  }
  return $false
}

function Install-DotnetSdk {
  Update-SessionPath
  if (Test-DotnetSdk) {
    Write-Done '.NET SDK 8 or later is installed'
    return
  }
  # vpk's package carries net8.0, net9.0 and net10.0 builds; 10 is the current LTS.
  Install-WingetPackage -Id 'Microsoft.DotNet.SDK.10' -Elevated `
    -Why 'the .NET SDK installs machine-wide, under Program Files'
  if (-not (Test-DotnetSdk)) {
    throw 'the .NET SDK was installed but dotnet is not on PATH; open a new PowerShell window and run this again.'
  }
  Write-Done '.NET SDK installed'
}

function Install-Vpk([string]$Version) {
  $env:DOTNET_NOLOGO = '1'
  $env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
  $listed = Get-NativeOutput -FilePath 'dotnet' -ArgumentList @('tool', 'list', '--global')
  $installed = $null
  foreach ($line in $listed.Lines) {
    if ($line -match '^\s*vpk\s+(\S+)') { $installed = $Matches[1] }
  }
  if ($installed -eq $Version) {
    Write-Done ("vpk {0} is installed" -f $Version)
  } else {
    if ($installed) {
      Write-Detail ("vpk {0} is installed; package.rs pins {1}." -f $installed, $Version)
      Invoke-Checked -FilePath 'dotnet' -ArgumentList @('tool', 'uninstall', '--global', 'vpk')
    }
    Invoke-Checked -FilePath 'dotnet' -ArgumentList @('tool', 'install', '--global', 'vpk', '--version', $Version)
    Update-SessionPath
    Write-Done ("vpk {0} installed" -f $Version)
  }
  if (-not (Test-Command 'vpk')) {
    throw ("vpk is installed but not on PATH; add {0} to PATH" -f (Join-Path $env:USERPROFILE '.dotnet\tools'))
  }
}

# --- Electron Oriel -----------------------------------------------------------------------------

# What %LOCALAPPDATA%\Oriel holds: none, rust (this app), electron, or unknown.
function Get-InstalledKind {
  $current = Join-Path $InstallRoot 'current'
  if (-not (Test-Path -LiteralPath (Join-Path $InstallRoot 'Update.exe'))) { return 'none' }
  if (Test-Path -LiteralPath (Join-Path $current 'libmpv-2.dll')) { return 'rust' }
  foreach ($marker in @('resources.pak', 'icudtl.dat', 'resources\app.asar')) {
    if (Test-Path -LiteralPath (Join-Path $current $marker)) { return 'electron' }
  }
  return 'unknown'
}

function Remove-ElectronOriel {
  $kind = Get-InstalledKind
  if ($kind -eq 'none') {
    Write-Done 'no Velopack install of Oriel in %LOCALAPPDATA%\Oriel'
    return
  }
  if ($kind -ne 'electron') {
    Write-Done ("{0} holds an Oriel install that isn't Electron's ({1}); Setup.exe replaces it" -f $InstallRoot, $kind)
    return
  }
  # Velopack's Update.exe: the "uninstall" subcommand (also --uninstall), with the global
  # --silent and --log (velopack/velopack src/bins/src/update.rs). It stops the app, runs its
  # uninstall hook, removes the shortcuts, the folder and the Apps entry.
  New-Item -ItemType Directory -Force -Path $LogFolder | Out-Null
  $log = Join-Path $LogFolder 'electron-uninstall.log'
  $update = Join-Path $InstallRoot 'Update.exe'
  $arguments = "uninstall --silent --log `"$log`""
  Write-Detail 'Electron Oriel is installed; uninstalling it through its own Update.exe.'
  Write-Detail ("> {0} {1}" -f $update, $arguments)
  $code = Invoke-AndWait -FilePath $update -Arguments $arguments
  if ($code -ne 0) {
    throw ("Electron Oriel's uninstall exited with code {0}; its log is {1}" -f $code, $log)
  }
  # Update.exe deletes itself a few seconds after it exits.
  $current = Join-Path $InstallRoot 'current'
  for ($i = 0; $i -lt 30 -and (Test-Path -LiteralPath $current); $i++) { Start-Sleep -Seconds 1 }
  if (Test-Path -LiteralPath $current) {
    Write-Warn ("{0} is still there; Setup.exe replaces it" -f $current)
  }
  Write-Done 'Electron Oriel uninstalled'
}

function Move-ElectronData {
  if (-not (Test-Path -LiteralPath $DataFolder)) {
    Write-Done ("no {0} yet; Oriel makes it on first start" -f $DataFolder)
  } else {
    $electron = (Test-Path -LiteralPath (Join-Path $DataFolder 'Local State')) -or
      (Test-Path -LiteralPath (Join-Path $DataFolder 'Cache'))
    $rust = Test-Path -LiteralPath (Join-Path $DataFolder 'shell')
    if ($electron -and -not $rust) {
      $stamp = Get-Date -Format 'yyyy-MM-dd'
      $aside = Join-Path $LatchWorks ("oriel-electron-{0}" -f $stamp)
      if (Test-Path -LiteralPath $aside) {
        $aside = Join-Path $LatchWorks ("oriel-electron-{0}" -f (Get-Date -Format 'yyyy-MM-dd-HHmmss'))
      }
      if (Get-Process -Name 'oriel' -ErrorAction SilentlyContinue) {
        throw 'Oriel is running; quit it, then run this again.'
      }
      Move-Item -LiteralPath $DataFolder -Destination $aside
      Write-Done ("Electron Oriel's data moved aside to {0}" -f $aside)
      Add-Note ("Electron Oriel's old data is in {0}. Oriel doesn't read it; delete it by hand when you're sure." -f $aside)
    } elseif ($electron) {
      Write-Warn ("{0} holds both Electron's files and Oriel's; left as it is" -f $DataFolder)
    } else {
      Write-Done ("{0} is Oriel's own data; kept" -f $DataFolder)
    }
  }
  foreach ($name in @('frame-view', 'glazier', 'lockstep')) {
    $folder = Join-Path $LatchWorks $name
    if (Test-Path -LiteralPath $folder) {
      Add-Note ("{0} is the Electron apps' data; Oriel doesn't use it, and it can be deleted by hand." -f $folder)
    }
  }
  $holding = Join-Path $LatchWorks 'glazier\holding'
  if (Test-Path -LiteralPath $holding) {
    Add-Note (("Look in {0} before deleting it: Electron Oriel's Tidy held files there " -f $holding) +
      '(and in .latch-works\glazier\holding at the top of other drives) until Holding was emptied.')
  }
}

# --- The steps ----------------------------------------------------------------------------------

function Invoke-Clean {
  Start-Step 'Remove the Rust build folder'
  $target = Get-TargetFolder
  if (-not (Test-Path -LiteralPath $target)) {
    Write-Done ("{0} is already gone" -f $target)
    return
  }
  Write-Detail ("Measuring {0} ..." -f $target)
  $bytes = Get-FolderBytes $target
  Update-SessionPath
  Push-Location $Workspace
  try {
    # cargo clean removes paths past 260 characters, which Remove-Item in 5.1 may not.
    if (Test-Command 'cargo') {
      Invoke-Checked -FilePath 'cargo' -ArgumentList @('clean')
    }
  } catch {
    Write-Warn ("cargo clean failed ({0}); removing the folder directly" -f $_.Exception.Message)
  } finally {
    Pop-Location
  }
  if (Test-Path -LiteralPath $target) {
    Remove-Item -LiteralPath $target -Recurse -Force
  }
  Write-Done ("removed {0}, {1}; Setup.exe went with it, the installed Oriel did not" -f $target, (Format-Size $bytes))
}

function Invoke-Checks {
  Start-Step 'Check this machine'
  if ($env:OS -ne 'Windows_NT') { throw 'this script runs on Windows' }
  # PROCESSOR_ARCHITEW6432 is set in a 32-bit PowerShell on 64-bit Windows.
  $architecture = $env:PROCESSOR_ARCHITEW6432
  if (-not $architecture) { $architecture = $env:PROCESSOR_ARCHITECTURE }
  if ($architecture -ne 'AMD64') { throw ("Oriel builds for x64 Windows; this is {0}" -f $architecture) }
  $build = [Environment]::OSVersion.Version.Build
  if ($build -lt 22000) { Write-Warn ("Windows build {0} is older than Windows 11; it may still work" -f $build) }
  Write-Detail ("PowerShell {0}, Windows build {1}" -f $PSVersionTable.PSVersion, $build)
  foreach ($tool in @('curl.exe', 'tar.exe')) {
    $path = Join-Path $env:SystemRoot (Join-Path 'System32' $tool)
    if (-not (Test-Path -LiteralPath $path)) { throw ("{0} is missing; the build fetches with Windows' own" -f $path) }
  }
  $drive = (Get-Item -LiteralPath $Workspace).PSDrive
  if ($drive -and $drive.Free -and $drive.Free -lt 60GB) {
    Write-Warn ("{0} free on {1}:; the first build needs tens of GB" -f (Format-Size $drive.Free), $drive.Name)
  }
  try {
    $long = Get-ItemPropertyValue -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' -Name 'LongPathsEnabled'
  } catch {
    $long = 0
  }
  if ($long -ne 1) {
    Add-Note 'Windows long paths are off (LongPathsEnabled). If the build fails on a path that is too long, see plan 064.'
  }
  if ($env:ORIEL_DATA_DIR) {
    Write-Warn ("ORIEL_DATA_DIR is set to {0}; Oriel started from here uses that folder" -f $env:ORIEL_DATA_DIR)
  }
  Write-Done ("building from {0}" -f $Workspace)
}

function Invoke-Prerequisites([string]$VpkVersion) {
  Start-Step 'Visual Studio Build Tools (MSVC and the Windows SDK)'
  Install-BuildTools
  # After the Build Tools: rustup's installer looks for MSVC and would otherwise ask about it.
  Start-Step 'rustup'
  Install-Rustup
  Start-Step '.NET SDK, for vpk'
  Install-DotnetSdk
  Start-Step ("vpk {0}" -f $VpkVersion)
  Install-Vpk $VpkVersion
}

function Invoke-Build([string]$Version) {
  Update-SessionPath
  if (-not (Test-Command 'cargo')) { throw 'cargo is not on PATH; run without -SkipPrerequisites' }
  if (-not $env:GPUI_FXC_PATH) {
    $fxc = Find-SdkTool 'fxc.exe'
    if ($fxc) { $env:GPUI_FXC_PATH = $fxc }
  }

  Start-Step 'The pinned Rust toolchain'
  $channel = Read-Pin (Join-Path $Workspace 'rust-toolchain.toml') 'channel\s*=\s*"([^"]+)"'
  $shown = Get-NativeOutput -FilePath 'rustup' -ArgumentList @('show')
  $defaultHost = $null
  foreach ($line in $shown.Lines) {
    if ($line -match '^Default host:\s*(\S+)') { $defaultHost = $Matches[1] }
  }
  if ($defaultHost -and $defaultHost -ne $MsvcHost) {
    throw ("rustup's default host is {0}; Oriel builds with MSVC. Run: rustup set default-host {1}" -f $defaultHost, $MsvcHost)
  }
  $toolchain = "$channel-$MsvcHost"
  Invoke-Checked -FilePath 'rustup' -ArgumentList @('toolchain', 'install', $toolchain, '--profile', 'minimal')
  Invoke-Checked -FilePath 'rustup' -ArgumentList @('component', 'add', 'rustfmt', 'clippy', '--toolchain', $toolchain)

  Push-Location $Workspace
  try {
    Start-Step "libavif and its DLLs (xtask vendor libavif-windows)"
    Invoke-Checked -FilePath 'cargo' -ArgumentList @('run', '-p', 'xtask', '--', 'vendor', 'libavif-windows')

    Start-Step 'ffmpeg and ffprobe (oriel-tools fetch-media-tools)'
    Invoke-Checked -FilePath 'cargo' -ArgumentList @('run', '-p', 'oriel-tools', '--bin', 'fetch-media-tools')

    Start-Step 'The release build and Setup.exe (xtask package windows)'
    Write-Detail 'The first build compiles everything with fat LTO; expect a long wait.'
    Invoke-Checked -FilePath 'cargo' -ArgumentList @('run', '-p', 'xtask', '--', 'package', 'windows')
  } finally {
    Pop-Location
  }

  $folder = Join-Path (Get-TargetFolder) 'release\package\windows'
  $setup = Join-Path $folder ("velopack\Oriel-{0}-win-x64-Setup.exe" -f $Version)
  if (-not (Test-Path -LiteralPath $setup)) { throw ("package windows did not leave {0}" -f $setup) }
  Write-Done $setup
  return [pscustomobject]@{
    Setup = $setup
    StagedExe = Join-Path $folder 'Oriel\oriel.exe'
  }
}

function Invoke-Install($Built) {
  if ((Test-Path -LiteralPath $InstalledExe) -and (Test-Path -LiteralPath $Built.StagedExe)) {
    $installed = (Get-FileHash -LiteralPath $InstalledExe -Algorithm SHA256).Hash
    $staged = (Get-FileHash -LiteralPath $Built.StagedExe -Algorithm SHA256).Hash
    if ($installed -eq $staged) {
      Write-Done ("{0} is this build already" -f $InstalledExe)
      return
    }
  }
  # Setup.exe's --silent hides every dialog and answers yes, replacing an install in the same
  # folder; --log names its log (velopack/velopack src/bins/src/setup.rs). A silent install does
  # not start the app (commands/install.rs), so the next step does.
  New-Item -ItemType Directory -Force -Path $LogFolder | Out-Null
  $log = Join-Path $LogFolder 'setup.log'
  $arguments = "--silent --log `"$log`""
  Write-Detail ("> {0} {1}" -f $Built.Setup, $arguments)
  $code = Invoke-AndWait -FilePath $Built.Setup -Arguments $arguments
  if ($code -ne 0) { throw ("Setup.exe exited with code {0}; its log is {1}" -f $code, $log) }
  if (-not (Test-Path -LiteralPath $InstalledExe)) {
    throw ("Setup.exe finished but {0} is missing; its log is {1}" -f $InstalledExe, $log)
  }
  Write-Done ("installed to {0}" -f (Split-Path -Parent $InstalledExe))
}

function Write-Summary {
  Write-Host ''
  Write-Host '==> Done' -ForegroundColor Cyan
  foreach ($note in $script:Notes) { Write-Detail $note }
  $target = Get-TargetFolder
  if (Test-Path -LiteralPath $target) {
    Write-Detail ("Measuring the build folder ...")
    Write-Detail ("The build folder is {0}, {1}. Run again with -Clean to remove it." -f $target, (Format-Size (Get-FolderBytes $target)))
  }
}

# --- Main ---------------------------------------------------------------------------------------

try {
  if ($Clean) {
    Invoke-Clean
    exit 0
  }
  Invoke-Checks
  $version = Read-Pin (Join-Path $Workspace 'Cargo.toml') '(?ms)^\[workspace\.package\].*?^version\s*=\s*"([^"]+)"'
  $vpkVersion = Read-Pin (Join-Path $Workspace 'crates\xtask\src\package.rs') 'const VPK_VERSION: &str = "([^"]+)"'
  Write-Detail ("Oriel {0}, vpk {1}" -f $version, $vpkVersion)

  if ($SkipPrerequisites) {
    Write-Detail 'Skipping the prerequisites (-SkipPrerequisites).'
  } else {
    Invoke-Prerequisites $vpkVersion
  }

  $built = Invoke-Build $version

  if ($BuildOnly) {
    Write-Detail 'Built only (-BuildOnly): nothing uninstalled, installed or started.'
  } else {
    Start-Step 'Electron Oriel'
    Remove-ElectronOriel
    Start-Step "Electron Oriel's data folder"
    Move-ElectronData
    Start-Step 'Install Oriel'
    Invoke-Install $built
    if ($NoLaunch) {
      Write-Detail 'Not starting Oriel (-NoLaunch).'
    } else {
      Start-Step 'Start Oriel'
      Start-Process -FilePath $InstalledExe -WorkingDirectory (Split-Path -Parent $InstalledExe)
      Write-Done 'Oriel started'
    }
  }
  Write-Summary
  exit 0
} catch {
  Write-Host ''
  Write-Host ("FAILED at step {0}, {1}:" -f $script:StepNumber, $script:StepName) -ForegroundColor Red
  Write-Host ("    {0}" -f $_.Exception.Message) -ForegroundColor Red
  if ($_.InvocationInfo -and $_.InvocationInfo.PositionMessage) {
    Write-Host $_.InvocationInfo.PositionMessage
  }
  exit 1
}
