param(
  [string]$Version,
  [string]$Repository = "cmhaoren/77code",
  [string]$OutputDir = "release\77code-win-x64",
  [string]$Notes = "",
  [switch]$Draft,
  [switch]$Prerelease,
  [switch]$SkipBuild,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repoRoot
try {
  if (-not $Version) {
    $pkg = Get-Content (Join-Path $repoRoot "apps\desktop\package.json") -Raw | ConvertFrom-Json
    $Version = "$($pkg.version)".Trim()
  }
  $Version = $Version.TrimStart("v")
  if ($Version -notmatch '^\d+\.\d+\.\d+([-.][0-9A-Za-z.]+)?$') {
    throw "Invalid version '$Version'. Expected semver like 0.1.12."
  }

  $tag = "v$Version"
  $resolvedOutDir = if ([System.IO.Path]::IsPathRooted($OutputDir)) {
    $OutputDir
  } else {
    Join-Path $repoRoot $OutputDir
  }

  if (-not $SkipBuild) {
    Write-Host "[1/3] Building 77 Code $Version for Windows x64 (feed: $Repository)..."
    $env:APP_VERSION = $Version
    $env:T3CODE_DESKTOP_VERSION = $Version
    $env:T3CODE_DESKTOP_UPDATE_REPOSITORY = $Repository
    $env:T3CODE_TELEMETRY_CHANNEL = "dev"

    node scripts/build-desktop-artifact.ts `
      --platform win `
      --target nsis `
      --arch x64 `
      --build-version $Version `
      --output-dir $resolvedOutDir
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  }

  Write-Host "[2/3] Checking release artifacts in $resolvedOutDir..."
  if (-not (Test-Path $resolvedOutDir)) {
    throw "Output directory not found: $resolvedOutDir"
  }
  $files = Get-ChildItem -Path $resolvedOutDir -File | Where-Object {
    $_.Extension -in @(".exe", ".blockmap", ".yml")
  }
  $exe = $files | Where-Object { $_.Extension -eq ".exe" }
  $yml = $files | Where-Object { $_.Extension -eq ".yml" }
  if (-not $exe) { throw "Missing .exe installer in $resolvedOutDir" }
  if (-not $yml) { throw "Missing electron-updater .yml manifest in $resolvedOutDir" }

  $files | Select-Object Name, @{ Name = "MB"; Expression = { [math]::Round($_.Length / 1MB, 2) } } | Format-Table -AutoSize

  if ($DryRun) {
    Write-Host "[DryRun] Skipping GitHub Release upload for $Repository $tag."
    exit 0
  }

  $ghCmd = Get-Command gh -ErrorAction SilentlyContinue
  $ghExe = if ($ghCmd) {
    $ghCmd.Source
  } elseif (Test-Path "$env:LOCALAPPDATA\Programs\gh-cli\bin\gh.exe") {
    "$env:LOCALAPPDATA\Programs\gh-cli\bin\gh.exe"
  } else {
    throw "GitHub CLI (gh) was not found in PATH or $env:LOCALAPPDATA\Programs\gh-cli\bin\gh.exe."
  }

  Write-Host "[3/3] Publishing $tag to https://github.com/$Repository/releases..."
  $assetPaths = $files | ForEach-Object { $_.FullName }

  & $ghExe release view $tag --repo $Repository *> $null
  $releaseExists = $LASTEXITCODE -eq 0

  if ($releaseExists) {
    & $ghExe release upload $tag @assetPaths --clobber --repo $Repository
  } else {
    $releaseArgs = @(
      "release", "create", $tag,
      "--repo", $Repository,
      "--title", "77 Code $tag"
    )
    if ($Notes) {
      $releaseArgs += @("--notes", $Notes)
    } else {
      $releaseArgs += "--generate-notes"
    }
    if ($Draft) { $releaseArgs += "--draft" }
    if ($Prerelease -or $Version -match '-nightly\.') { $releaseArgs += "--prerelease" }
    $releaseArgs += $assetPaths
    & $ghExe @releaseArgs
  }
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

  Write-Host "Published 77 Code $tag to https://github.com/$Repository/releases/tag/$tag"
} finally {
  Pop-Location
}
