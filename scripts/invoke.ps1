[CmdletBinding(PositionalBinding = $false)]
param(
  [Parameter(Mandatory, Position = 0)]
  [ValidateSet("compile", "package", "package-install", "watch", "test", "check-baseline", "check", "eval-baseline", "eval-baseline-sim")]
  [string]$Task,

  [Alias("out")]
  [string]$VsixPath,

  [ValidateSet("patch", "minor", "major")]
  [string]$Bump = "patch",

  [Parameter(ValueFromRemainingArguments)]
  [string[]]$ForwardedArguments
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$packagePath = Join-Path $projectRoot "package.json"

function Get-UpdatedVersion {
  param(
    [Parameter(Mandatory)][string]$CurrentVersion,
    [Parameter(Mandatory)][ValidateSet("patch", "minor", "major")][string]$BumpType
  )

  if ($CurrentVersion -notmatch '^(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)$') {
    throw "Version '$CurrentVersion' is not in major.minor.patch format."
  }

  $major = [int]$Matches.major
  $minor = [int]$Matches.minor
  $patch = [int]$Matches.patch

  switch ($BumpType) {
    "patch" { $patch++ }
    "minor" { $minor++; $patch = 0 }
    "major" { $major++; $minor = 0; $patch = 0 }
  }

  return "$major.$minor.$patch"
}

function Set-PackageVersion {
  param(
    [Parameter(Mandatory)][string]$NewVersion,
    [Parameter(Mandatory)][string]$PackageJsonText
  )

  $replacement = '${1}' + $NewVersion + '${2}'
  $updatedText = $PackageJsonText -replace '("version"\s*:\s*")\d+\.\d+\.\d+(")', $replacement
  Set-Content -Path $packagePath -Value $updatedText -Encoding UTF8
  return $NewVersion
}

function Invoke-Package {
  param(
    [string]$ExplicitOutPath
  )

  $packageArguments = @("--no-dependencies", "--allow-missing-repository", "--skip-license", "--no-rewrite-relative-links")
  if ($ExplicitOutPath) { $packageArguments = @("--out", $ExplicitOutPath) + $packageArguments }
  & npx --no-install vsce package @packageArguments @ForwardedArguments
}

function Install-VsixIfRequested {
  param(
    [Parameter(Mandatory)][string]$VsixToInstall,
    [string]$TaskAlias
  )

  if (-not (Get-Command code -ErrorAction SilentlyContinue)) {
    throw "VS Code CLI ('code') not found on PATH. Install VS Code CLI or add it to PATH."
  }

  & code --install-extension $VsixToInstall --force
  if ($LASTEXITCODE -ne 0) { throw "VSIX installation failed for '$VsixToInstall'." }
}

function Get-NextVersionAndUpdatePackage {
  param([Parameter(Mandatory)][string]$BumpType)

  $packageText = Get-Content -Raw $packagePath
  $currentVersion = ($packageText | ConvertFrom-Json).version
  $newVersion = Get-UpdatedVersion -CurrentVersion $currentVersion -BumpType $BumpType
  if ($newVersion -ne $currentVersion) {
    Set-PackageVersion -NewVersion $newVersion -PackageJsonText $packageText | Out-Null
    Write-Host "Version updated: $currentVersion -> $newVersion"
  }
  return $newVersion
}

function Resolve-VsixPath {
  param([Parameter(Mandatory)][string]$BaseVersion)

  if ($VsixPath) {
    if (-not [System.IO.Path]::IsPathRooted($VsixPath)) {
      return Join-Path $projectRoot $VsixPath
    }
    return $VsixPath
  }

  return Join-Path $projectRoot "codex-router-$BaseVersion.vsix"
}

Write-Host "Using task: $Task"
Push-Location $projectRoot
try {
  switch ($Task) {
    "compile" { & npx --no-install tsc -p . }
    "package" {
      & npx --no-install tsc -p .
      if ($LASTEXITCODE -eq 0) { Invoke-Package -ExplicitOutPath $VsixPath }
      if ($LASTEXITCODE -eq 0) {
        if ($VsixPath) { Write-Host "Packaged to: $VsixPath" }
      }
    }
    "package-install" {
      $nextVersion = Get-NextVersionAndUpdatePackage -BumpType $Bump
      & npx --no-install tsc -p .
      if ($LASTEXITCODE -eq 0) {
        $resolvedVsixPath = Resolve-VsixPath -BaseVersion $nextVersion
        Invoke-Package -ExplicitOutPath $resolvedVsixPath
        if ($LASTEXITCODE -eq 0) { Install-VsixIfRequested -VsixToInstall $resolvedVsixPath -TaskAlias $Task }
      }
    }
    "watch" { & npx --no-install tsc -watch -p . }
    "test" { & npx --no-install tsx --test "test/**/*.test.ts" }
    "check-baseline" { & npx --no-install tsc -p tsconfig.tests.json }
    "check" {
      & npx --no-install tsc -p .
      if ($LASTEXITCODE -eq 0) { & npx --no-install tsc -p tsconfig.tests.json }
      if ($LASTEXITCODE -eq 0) { & npx --no-install tsx --test "test/**/*.test.ts" }
    }
    "eval-baseline" { & npx --no-install tsx scripts/baseline-eval.ts @ForwardedArguments }
    "eval-baseline-sim" { & npx --no-install tsx scripts/baseline-eval.ts --simulated @ForwardedArguments }
  }
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
  Pop-Location
}
