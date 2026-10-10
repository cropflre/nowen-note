param(
  [Parameter(Mandatory = $true)]
  [string]$Root,

  [Parameter(Mandatory = $true)]
  [string]$Output
)

$ErrorActionPreference = "Stop"
$rootPath = [System.IO.Path]::GetFullPath($Root)
$outputPath = [System.IO.Path]::GetFullPath($Output)

if (-not (Test-Path -LiteralPath $rootPath -PathType Container)) {
  throw "Root directory does not exist: $rootPath"
}

$outputDirectory = Split-Path -Parent $outputPath
if ($outputDirectory -and -not (Test-Path -LiteralPath $outputDirectory)) {
  New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
}

function Convert-CertificateDate {
  param($Certificate, [string]$Property)
  if (-not $Certificate) { return $null }
  $value = $Certificate.$Property
  if (-not $value) { return $null }
  return $value.ToUniversalTime().ToString("o")
}

$records = @(
  Get-ChildItem -LiteralPath $rootPath -Recurse -File -Filter "*.exe" |
    Sort-Object FullName |
    ForEach-Object {
      $file = $_
      $signature = Get-AuthenticodeSignature -LiteralPath $file.FullName
      $signer = $signature.SignerCertificate
      $timestamp = $signature.TimeStamperCertificate
      $commonName = if ($signer) {
        $signer.GetNameInfo(
          [System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName,
          $false
        )
      } else {
        $null
      }

      [pscustomobject]@{
        fileName            = $file.Name
        relativePath        = [System.IO.Path]::GetRelativePath($rootPath, $file.FullName)
        status              = [string]$signature.Status
        signerCommonName    = $commonName
        signerSubject       = if ($signer) { $signer.Subject } else { $null }
        thumbprint          = if ($signer) { $signer.Thumbprint } else { $null }
        signerNotBefore     = Convert-CertificateDate $signer "NotBefore"
        signerNotAfter      = Convert-CertificateDate $signer "NotAfter"
        timestampPresent    = [bool]$timestamp
        timestampNotBefore  = Convert-CertificateDate $timestamp "NotBefore"
        timestampNotAfter   = Convert-CertificateDate $timestamp "NotAfter"
      }
    }
)

$json = ConvertTo-Json -InputObject $records -Depth 4
[System.IO.File]::WriteAllText(
  $outputPath,
  $json,
  [System.Text.UTF8Encoding]::new($false)
)

Write-Host "[windows-signature] exported $($records.Count) record(s) to $outputPath"
