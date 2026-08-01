[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath
)

$ErrorActionPreference = 'Stop'

$resolvedInstaller = (Resolve-Path -LiteralPath $InstallerPath).Path
$installDirectory = Join-Path $env:LOCALAPPDATA 'AI Video Workspace'
$desktopExecutable = Join-Path $installDirectory 'ai-video-desktop.exe'
$workerExecutable = Join-Path $installDirectory 'ai-video-worker.exe'
$uninstaller = Join-Path $installDirectory 'uninstall.exe'
$desktopProcess = $null
$workerProcessId = $null
$uninstalled = $false

if (Test-Path -LiteralPath $installDirectory) {
  throw "Clean-install validation requires an absent install directory: $installDirectory"
}

try {
  $install = Start-Process `
    -FilePath $resolvedInstaller `
    -ArgumentList '/S' `
    -WindowStyle Hidden `
    -Wait `
    -PassThru
  if ($install.ExitCode -ne 0) {
    throw "NSIS installer exited with code $($install.ExitCode)"
  }
  if (-not (Test-Path -LiteralPath $desktopExecutable)) {
    throw "Installed desktop executable is missing: $desktopExecutable"
  }
  if (-not (Test-Path -LiteralPath $workerExecutable)) {
    throw "Installed Worker executable is missing: $workerExecutable"
  }

  $desktopProcess = Start-Process `
    -FilePath $desktopExecutable `
    -WorkingDirectory $installDirectory `
    -PassThru

  $worker = $null
  for ($attempt = 0; $attempt -lt 60 -and $null -eq $worker; $attempt++) {
    Start-Sleep -Seconds 1
    $desktopProcess.Refresh()
    if ($desktopProcess.HasExited) {
      throw "Desktop application exited during startup with code $($desktopProcess.ExitCode)"
    }
    $worker = Get-CimInstance Win32_Process | Where-Object {
      $_.ParentProcessId -eq $desktopProcess.Id -and
      $_.ExecutablePath -ieq $workerExecutable
    } | Select-Object -First 1
  }
  if ($null -eq $worker) {
    throw 'Installed desktop application did not start ai-video-worker.exe'
  }
  $workerProcessId = $worker.ProcessId

  Start-Sleep -Seconds 3
  if ($null -eq (Get-CimInstance Win32_Process -Filter "ProcessId = $workerProcessId")) {
    throw 'Worker exited during startup health/SQLite checks'
  }

  $desktopProcess.Refresh()
  if (-not $desktopProcess.CloseMainWindow()) {
    throw 'Desktop application did not accept a graceful window-close request'
  }
  if (-not $desktopProcess.WaitForExit(20000)) {
    throw 'Desktop application did not exit within 20 seconds after window close'
  }

  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    if ($null -eq (Get-CimInstance Win32_Process -Filter "ProcessId = $workerProcessId")) {
      break
    }
    Start-Sleep -Milliseconds 500
  }
  if ($null -ne (Get-CimInstance Win32_Process -Filter "ProcessId = $workerProcessId")) {
    throw 'Worker process remained after the desktop application exited'
  }

  $uninstall = Start-Process `
    -FilePath $uninstaller `
    -ArgumentList '/S' `
    -WindowStyle Hidden `
    -Wait `
    -PassThru
  if ($uninstall.ExitCode -ne 0) {
    throw "NSIS uninstaller exited with code $($uninstall.ExitCode)"
  }
  $uninstalled = $true

  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    if (
      -not (Test-Path -LiteralPath $desktopExecutable) -and
      -not (Test-Path -LiteralPath $workerExecutable) -and
      -not (Test-Path -LiteralPath $uninstaller)
    ) {
      break
    }
    Start-Sleep -Milliseconds 500
  }
  if (
    (Test-Path -LiteralPath $desktopExecutable) -or
    (Test-Path -LiteralPath $workerExecutable) -or
    (Test-Path -LiteralPath $uninstaller)
  ) {
    throw "Installed binaries remained after uninstall: $installDirectory"
  }

  [pscustomobject]@{
    Installer = $resolvedInstaller
    InstalledWorkerName = 'ai-video-worker.exe'
    WorkerStarted = $true
    StartupChecksSurvived = $true
    GracefulClose = $true
    WorkerExitedAfterClose = $true
    InstalledBinariesRemoved = $true
  } | ConvertTo-Json
}
finally {
  if ($null -ne $desktopProcess) {
    $desktopProcess.Refresh()
    if (-not $desktopProcess.HasExited) {
      Stop-Process -Id $desktopProcess.Id -Force -ErrorAction SilentlyContinue
    }
  }
  if ($null -ne $workerProcessId) {
    $remainingWorker = Get-CimInstance Win32_Process -Filter "ProcessId = $workerProcessId" |
      Where-Object { $_.ExecutablePath -ieq $workerExecutable }
    if ($null -ne $remainingWorker) {
      Stop-Process -Id $workerProcessId -Force -ErrorAction SilentlyContinue
    }
  }
  if (-not $uninstalled -and (Test-Path -LiteralPath $uninstaller)) {
    Start-Process `
      -FilePath $uninstaller `
      -ArgumentList '/S' `
      -WindowStyle Hidden `
      -Wait `
      -ErrorAction SilentlyContinue
  }
}
