[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$UpgradeInstallerPath,

  [string]$PreviousInstallerPath = $UpgradeInstallerPath,

  [string]$ValidationRoot = (Join-Path `
    $(if ([string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)) { $env:TEMP } else { $env:RUNNER_TEMP }) `
    ('ai-video-nsis-upgrade-' + [guid]::NewGuid().ToString('N')))
)

$ErrorActionPreference = 'Stop'

$resolvedPreviousInstaller = (Resolve-Path -LiteralPath $PreviousInstallerPath).Path
$resolvedUpgradeInstaller = (Resolve-Path -LiteralPath $UpgradeInstallerPath).Path
$validationRoot = [IO.Path]::GetFullPath($ValidationRoot)
$expectedRootPrefix = Join-Path `
  $(if ([string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)) { $env:TEMP } else { $env:RUNNER_TEMP }) `
  'ai-video-nsis-upgrade-'
if (-not $validationRoot.StartsWith($expectedRootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Validation root must use the isolated upgrade-test prefix: $expectedRootPrefix"
}

$installDirectory = Join-Path $validationRoot 'application'
$projectRoot = Join-Path $validationRoot 'external-project'
$workerExecutable = Join-Path $installDirectory 'ai-video-worker.exe'
$uninstaller = Join-Path $installDirectory 'uninstall.exe'
$workerProcess = $null
$uninstalled = $false
$rpcIndex = 0

function Install-Bundle([string]$Installer) {
  $install = Start-Process `
    -FilePath $Installer `
    -ArgumentList @('/S', "/D=$installDirectory") `
    -WindowStyle Hidden `
    -Wait `
    -PassThru
  if ($install.ExitCode -ne 0) {
    throw "NSIS installer exited with code $($install.ExitCode): $Installer"
  }
  if (-not (Test-Path -LiteralPath $workerExecutable)) {
    throw "Installed Worker executable is missing: $workerExecutable"
  }
}

function Get-FreeTcpPort {
  $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
  $listener.Start()
  try {
    return ([Net.IPEndPoint]$listener.LocalEndpoint).Port
  }
  finally {
    $listener.Stop()
  }
}

function Invoke-WorkerRpc([int]$Port, [string]$Method, [hashtable]$Params = @{}) {
  $script:rpcIndex += 1
  $body = @{
    id = "upgrade-$script:rpcIndex"
    protocolVersion = 1
    method = $Method
    params = $Params
  } | ConvertTo-Json -Depth 12 -Compress
  $response = Invoke-RestMethod `
    -Uri "http://127.0.0.1:$Port/rpc" `
    -Method Post `
    -ContentType 'application/json' `
    -Body $body `
    -TimeoutSec 10
  if (-not $response.ok) {
    throw "Worker RPC $Method failed: $($response.error.code) $($response.error.message)"
  }
  return $response.result
}

function Start-TestWorker([string]$Phase) {
  $port = Get-FreeTcpPort
  $stdoutPath = Join-Path $validationRoot "$Phase-worker.stdout.log"
  $stderrPath = Join-Path $validationRoot "$Phase-worker.stderr.log"
  $script:workerProcess = Start-Process `
    -FilePath $workerExecutable `
    -ArgumentList @('--http', $port) `
    -WorkingDirectory $installDirectory `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath `
    -PassThru
  for ($attempt = 0; $attempt -lt 40; $attempt++) {
    Start-Sleep -Milliseconds 250
    $script:workerProcess.Refresh()
    if ($script:workerProcess.HasExited) {
      throw "Worker exited during $Phase startup with code $($script:workerProcess.ExitCode)"
    }
    try {
      [void](Invoke-WorkerRpc -Port $port -Method 'health')
      return $port
    }
    catch {
      if ($attempt -eq 39) { throw }
    }
  }
}

function Stop-TestWorker {
  if ($null -eq $script:workerProcess) { return }
  $script:workerProcess.Refresh()
  if (-not $script:workerProcess.HasExited) {
    Stop-Process -Id $script:workerProcess.Id -Force
    [void]$script:workerProcess.WaitForExit(10000)
  }
  $script:workerProcess = $null
}

function Get-DocumentDigest($Documents) {
  $summary = @($Documents | ForEach-Object {
    [ordered]@{
      id = $_.id
      kind = $_.kind
      title = $_.title
      currentVersionId = $_.currentVersionId
    }
  }) | ConvertTo-Json -Depth 5 -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($summary)
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try {
    $hash = $algorithm.ComputeHash($bytes)
    return ([BitConverter]::ToString($hash)).Replace('-', '')
  }
  finally {
    $algorithm.Dispose()
  }
}

try {
  New-Item -ItemType Directory -Path $validationRoot | Out-Null
  Install-Bundle $resolvedPreviousInstaller

  $beforePort = Start-TestWorker 'before'
  $created = Invoke-WorkerRpc -Port $beforePort -Method 'project.create' -Params @{
    name = 'Upgrade Preservation Project'
    rootPath = $projectRoot
  }
  [void](Invoke-WorkerRpc -Port $beforePort -Method 'document.save' -Params @{
    kind = 'outline'
    title = 'Upgrade sentinel'
    contentMarkdown = '# Upgrade sentinel'
  })
  $beforeDocuments = Invoke-WorkerRpc -Port $beforePort -Method 'document.list'
  $beforeDigest = Get-DocumentDigest $beforeDocuments
  $beforeIntegrity = Invoke-WorkerRpc -Port $beforePort -Method 'project.integrity'
  if (-not $beforeIntegrity.ok) {
    throw "Pre-upgrade project integrity failed: $($beforeIntegrity.messages -join '; ')"
  }
  [void](Invoke-WorkerRpc -Port $beforePort -Method 'project.close')
  Stop-TestWorker

  $markerPath = Join-Path $projectRoot 'external-owner.marker'
  [IO.File]::WriteAllText($markerPath, 'must survive application upgrade', [Text.Encoding]::UTF8)
  $markerHash = (Get-FileHash -LiteralPath $markerPath -Algorithm SHA256).Hash

  Install-Bundle $resolvedUpgradeInstaller

  $afterPort = Start-TestWorker 'after'
  $opened = Invoke-WorkerRpc -Port $afterPort -Method 'project.open' -Params @{ rootPath = $projectRoot }
  $afterDocuments = Invoke-WorkerRpc -Port $afterPort -Method 'document.list'
  $afterDigest = Get-DocumentDigest $afterDocuments
  $afterIntegrity = Invoke-WorkerRpc -Port $afterPort -Method 'project.integrity'
  if ($opened.id -ne $created.id) { throw 'Project identity changed during upgrade' }
  if ($afterDigest -ne $beforeDigest) { throw 'Project document summary changed during upgrade' }
  if (-not $afterIntegrity.ok) {
    throw "Post-upgrade project integrity failed: $($afterIntegrity.messages -join '; ')"
  }
  if ((Get-FileHash -LiteralPath $markerPath -Algorithm SHA256).Hash -ne $markerHash) {
    throw 'External project marker changed during upgrade'
  }
  [void](Invoke-WorkerRpc -Port $afterPort -Method 'project.close')
  Stop-TestWorker

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
  if (-not (Test-Path -LiteralPath $projectRoot)) {
    throw 'Uninstall removed the external project directory'
  }
  if ((Get-FileHash -LiteralPath $markerPath -Algorithm SHA256).Hash -ne $markerHash) {
    throw 'Uninstall changed the external project marker'
  }

  [pscustomobject]@{
    PreviousInstaller = $resolvedPreviousInstaller
    UpgradeInstaller = $resolvedUpgradeInstaller
    SameInstallerBaseline = $resolvedPreviousInstaller -eq $resolvedUpgradeInstaller
    ProjectIdentityPreserved = $true
    DocumentDigestPreserved = $true
    IntegrityBeforeAndAfter = $true
    ExternalProjectPreservedAfterUninstall = $true
  } | ConvertTo-Json
}
finally {
  Stop-TestWorker
  if (-not $uninstalled -and (Test-Path -LiteralPath $uninstaller)) {
    Start-Process `
      -FilePath $uninstaller `
      -ArgumentList '/S' `
      -WindowStyle Hidden `
      -Wait `
      -ErrorAction SilentlyContinue
  }
  if (
    $validationRoot.StartsWith($expectedRootPrefix, [StringComparison]::OrdinalIgnoreCase) -and
    (Test-Path -LiteralPath $validationRoot)
  ) {
    Remove-Item -LiteralPath $validationRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
