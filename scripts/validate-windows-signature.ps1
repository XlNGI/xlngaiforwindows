[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$FilePath,

  [string]$ExpectedPublisher
)

$ErrorActionPreference = 'Stop'

$resolvedPath = (Resolve-Path -LiteralPath $FilePath).Path
$signature = Get-AuthenticodeSignature -FilePath $resolvedPath
if ($signature.Status.ToString() -ne 'Valid') {
  throw "Authenticode signature is not valid: $($signature.Status) $($signature.StatusMessage)"
}
if (
  -not [string]::IsNullOrWhiteSpace($ExpectedPublisher) -and
  $signature.SignerCertificate.Subject.IndexOf(
    $ExpectedPublisher,
    [StringComparison]::OrdinalIgnoreCase
  ) -lt 0
) {
  throw "Signer subject does not contain the expected publisher: $ExpectedPublisher"
}

[pscustomobject]@{
  File = $resolvedPath
  Status = $signature.Status.ToString()
  Publisher = $signature.SignerCertificate.Subject
  Thumbprint = $signature.SignerCertificate.Thumbprint
  Timestamped = $null -ne $signature.TimeStamperCertificate
} | ConvertTo-Json
