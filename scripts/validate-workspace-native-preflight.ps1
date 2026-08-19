[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$DesktopExecutablePath,

  [string]$EvidencePath,

  [switch]$KeepOpen
)

$ErrorActionPreference = 'Stop'

$resolvedDesktop = (Resolve-Path -LiteralPath $DesktopExecutablePath).Path
$desktopDirectory = Split-Path -Parent $resolvedDesktop
$workerExecutable = Join-Path $desktopDirectory 'ai-video-worker.exe'
$isDebugBuild = $desktopDirectory -match '[\\/]target[\\/]debug(?:[\\/]|$)'
$desktopProcess = $null
$workerProcessId = $null
$workerCommandLine = $null
$gracefulClose = $false
$workerExitedAfterClose = $false
$leaveOpen = $false

try {
  if (-not $isDebugBuild -and -not (Test-Path -LiteralPath $workerExecutable -PathType Leaf)) {
    throw "Native workspace preflight requires the bundled Worker beside the desktop executable: $workerExecutable"
  }

  $desktopProcess = Start-Process `
    -FilePath $resolvedDesktop `
    -WorkingDirectory $desktopDirectory `
    -WindowStyle Normal `
    -PassThru

  $worker = $null
  $windowReady = $false
  for ($attempt = 0; $attempt -lt 80; $attempt++) {
    Start-Sleep -Milliseconds 250
    $desktopProcess.Refresh()
    if ($desktopProcess.HasExited) {
      throw "Desktop application exited during Native preflight with code $($desktopProcess.ExitCode)"
    }
    if ($desktopProcess.MainWindowHandle -ne 0) {
      $windowReady = $true
    }
    $worker = Get-CimInstance Win32_Process | Where-Object {
      $_.ParentProcessId -eq $desktopProcess.Id -and (
        $_.ExecutablePath -ieq $workerExecutable -or
        ($isDebugBuild -and $_.Name -ieq 'node.exe' -and $_.CommandLine -match 'dist[\\/]index\.js')
      )
    } | Select-Object -First 1
    if ($windowReady -and $null -ne $worker) {
      break
    }
  }

  if (-not $windowReady) {
    throw 'Desktop application did not expose a native top-level window within 20 seconds'
  }
  if ($null -eq $worker) {
    throw 'Desktop application did not start its bundled Worker within 20 seconds'
  }
  $workerProcessId = [int]$worker.ProcessId
  $workerCommandLine = $worker.CommandLine

  $result = [ordered]@{
    DesktopExecutable = $resolvedDesktop
    DesktopProcessId = $desktopProcess.Id
    DesktopWindowHandle = [Int64]$desktopProcess.MainWindowHandle
    WorkerExecutable = if ($worker.ExecutablePath) { $worker.ExecutablePath } else { $worker.Name }
    WorkerCommandLine = $workerCommandLine
    WorkerProcessId = $workerProcessId
    NativeWindowReady = $true
    WorkerStarted = $true
    KeepOpen = [bool]$KeepOpen
    ManualChecksRequired = @(
      'Move the main window and both detached panels using the operating system window manager.'
      'Resize, minimize, maximize, close, and re-attach document and conversation windows.'
      'Switch projects while a detached window and a generation are active; verify no stale actions apply.'
      'Open the same document in two windows and verify CAS conflict handling and no lost edits.'
      'Repeat the checks at 1280x720 and 390x844; record screenshots and observed window bounds.'
    )
  }

  if ($KeepOpen) {
    $leaveOpen = $true
    $result | ConvertTo-Json -Depth 5
    if ($EvidencePath) {
      [IO.File]::WriteAllText((Join-Path (Get-Location) $EvidencePath), ($result | ConvertTo-Json -Depth 5), [Text.Encoding]::UTF8)
    }
    return
  }

  $desktopProcess.Refresh()
  if (-not $desktopProcess.CloseMainWindow()) {
    throw 'Desktop application did not accept a graceful close request during Native preflight'
  }
  $gracefulClose = $desktopProcess.WaitForExit(20000)
  if (-not $gracefulClose) {
    throw 'Desktop application did not exit within 20 seconds during Native preflight'
  }

  for ($attempt = 0; $attempt -lt 40; $attempt++) {
    if ($null -eq (Get-CimInstance Win32_Process -Filter "ProcessId = $workerProcessId")) {
      $workerExitedAfterClose = $true
      break
    }
    Start-Sleep -Milliseconds 250
  }
  if (-not $workerExitedAfterClose) {
    throw 'Worker process remained after the desktop application exited during Native preflight'
  }

  $result.GracefulClose = $true
  $result.WorkerExitedAfterClose = $true
  $json = $result | ConvertTo-Json -Depth 5
  if ($EvidencePath) {
    $resolvedEvidence = [IO.Path]::GetFullPath((Join-Path (Get-Location) $EvidencePath))
    $evidenceDirectory = Split-Path -Parent $resolvedEvidence
    New-Item -ItemType Directory -Path $evidenceDirectory -Force | Out-Null
    [IO.File]::WriteAllText($resolvedEvidence, $json, [Text.Encoding]::UTF8)
  }
  $json
}
finally {
  if (-not $leaveOpen -and $null -ne $desktopProcess) {
    $desktopProcess.Refresh()
    if (-not $desktopProcess.HasExited) {
      Stop-Process -Id $desktopProcess.Id -Force -ErrorAction SilentlyContinue
    }
  }
  if (-not $leaveOpen -and $null -ne $workerProcessId) {
    $remainingWorker = Get-CimInstance Win32_Process -Filter "ProcessId = $workerProcessId"
    if ($null -ne $remainingWorker) {
      Stop-Process -Id $workerProcessId -Force -ErrorAction SilentlyContinue
    }
  }
}
