[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath,

  [string]$InstallDirectory = (Join-Path `
    $(if ([string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)) { $env:TEMP } else { $env:RUNNER_TEMP }) `
    ('ai-video-nsis-install-' + [guid]::NewGuid().ToString('N')))
)

$ErrorActionPreference = 'Stop'

$resolvedInstaller = (Resolve-Path -LiteralPath $InstallerPath).Path
$installDirectory = [IO.Path]::GetFullPath($InstallDirectory)
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
  Write-Host "Installing NSIS bundle into $installDirectory"
  $install = Start-Process `
    -FilePath $resolvedInstaller `
    -ArgumentList @('/S', "/D=$installDirectory") `
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

  # Do not start NSIS cleanup while another installed binary still owns a file.
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    $installedProcesses = @(Get-CimInstance Win32_Process | Where-Object {
      $_.ExecutablePath -and $_.ExecutablePath.StartsWith($installDirectory, [StringComparison]::OrdinalIgnoreCase)
    })
    if ($installedProcesses.Count -eq 0) { break }
    Start-Sleep -Milliseconds 500
  }
  if ($installedProcesses.Count -gt 0) {
    throw "Installed process remained before uninstall: $($installedProcesses.ExecutablePath -join ', ')"
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

  # NSIS schedules self-deletion of uninstall.exe after its child process exits;
  # wait for the whole isolated directory instead of racing that cleanup.
  for ($attempt = 0; $attempt -lt 120; $attempt++) {
    if (-not (Test-Path -LiteralPath $installDirectory)) { break }
    Start-Sleep -Milliseconds 500
  }
  if (Test-Path -LiteralPath $installDirectory) {
    throw "Installed files remained after uninstall: $installDirectory"
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
  if (
    $installDirectory -and
    $installDirectory.StartsWith(
      (Join-Path $(if ([string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)) { $env:TEMP } else { $env:RUNNER_TEMP }) 'ai-video-nsis-install-'),
      [StringComparison]::OrdinalIgnoreCase
    ) -and
    (Test-Path -LiteralPath $installDirectory)
  ) {
    Remove-Item -LiteralPath $installDirectory -Recurse -Force -ErrorAction SilentlyContinue
  }
}
