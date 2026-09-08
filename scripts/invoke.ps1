[CmdletBinding(PositionalBinding = $false)]
param(
  [Parameter(Mandatory, Position = 0)]
  [ValidateSet("compile", "package", "watch", "test", "check-baseline", "check", "eval-baseline", "eval-baseline-sim")]
  [string]$Task,

  [Alias("out")]
  [string]$VsixPath,

  [Parameter(ValueFromRemainingArguments)]
  [string[]]$ForwardedArguments
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
Push-Location $projectRoot
try {
  switch ($Task) {
    "compile" { & npx --no-install tsc -p . }
    "package" {
      & npx --no-install tsc -p .
      if ($LASTEXITCODE -eq 0) {
        $packageArguments = @()
        if ($VsixPath) { $packageArguments += @("--out", $VsixPath) }
        # Allow incomplete release metadata when building a local installer.
        & npx --no-install vsce package --no-dependencies --allow-missing-repository --skip-license --no-rewrite-relative-links @packageArguments @ForwardedArguments
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
