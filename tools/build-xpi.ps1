<#
.SYNOPSIS
    Packages the Merlin Firefox extension into a signed-ready .xpi file.

.DESCRIPTION
    An .xpi is just a zip archive with manifest.json at its root. This script
    copies the runtime files (no docs, no tools, no VCS metadata) into a temp
    staging directory, zips it, and names the result after the version in
    manifest.json, e.g. merlin-firefox-1.1.0.xpi.

.PARAMETER OutDir
    Directory to write the .xpi into. Defaults to <repo>\merlin-firefox\build.

.EXAMPLE
    .\build-xpi.ps1
    .\build-xpi.ps1 -OutDir C:\Users\jvb\Desktop\dist
#>

[CmdletBinding()]
param(
    [string]$OutDir
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot   # merlin-firefox/
if (-not $OutDir) { $OutDir = Join-Path $root 'build' }

$manifestPath = Join-Path $root 'manifest.json'
if (-not (Test-Path $manifestPath)) {
    throw "manifest.json not found at $manifestPath"
}
$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
$version = $manifest.version
if (-not $version) { throw "manifest.json has no 'version' field" }

# Files/directories to include in the .xpi. Everything else (README, CHANGELOG,
# LICENCE, tools/, build/, .git*) is excluded.
$includeFiles = @(
    'manifest.json',
    'background.js',
    'i18n.js',
    'options.html',
    'options.js',
    'save-dialog.html',
    'save-dialog.js'
)
$includeDirs = @(
    'icons',
    '_locales'
)

foreach ($f in $includeFiles) {
    if (-not (Test-Path (Join-Path $root $f))) {
        throw "Expected file missing: $f"
    }
}
foreach ($d in $includeDirs) {
    if (-not (Test-Path (Join-Path $root $d))) {
        throw "Expected directory missing: $d"
    }
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$xpiName = "merlin-firefox-$version.xpi"
$xpiPath = Join-Path $OutDir $xpiName

if (Test-Path $xpiPath) { Remove-Item $xpiPath -Force }

# Stage into a temp dir so the zip contains no extraneous parent folder and no
# excluded files, regardless of what else happens to be sitting in $root.
$staging = Join-Path ([System.IO.Path]::GetTempPath()) "merlin-firefox-xpi-$([guid]::NewGuid())"
New-Item -ItemType Directory -Force -Path $staging | Out-Null

try {
    foreach ($f in $includeFiles) {
        Copy-Item -Path (Join-Path $root $f) -Destination (Join-Path $staging $f)
    }
    foreach ($d in $includeDirs) {
        Copy-Item -Path (Join-Path $root $d) -Destination (Join-Path $staging $d) -Recurse
    }

    # Compress-Archive writes backslash path separators for subdirectories on
    # Windows, which violates the zip spec and can break loaders (icons/locales
    # live in subfolders here) — build the archive via ZipFile directly instead,
    # forcing forward slashes for every entry.
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem

    $zip = [System.IO.Compression.ZipFile]::Open($xpiPath, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        Get-ChildItem -Path $staging -Recurse -File | ForEach-Object {
            $relativePath = $_.FullName.Substring($staging.Length + 1) -replace '\\', '/'
            [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                $zip, $_.FullName, $relativePath,
                [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
        }
    }
    finally {
        $zip.Dispose()
    }
}
finally {
    Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "Built $xpiPath ($([math]::Round((Get-Item $xpiPath).Length / 1KB, 1)) KB)"
