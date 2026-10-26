param([Parameter(Mandatory = $true)][string]$Path)
$ErrorActionPreference = 'Stop'
$base = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
$target = [IO.Path]::GetFullPath($Path).TrimEnd('\')
if (-not $target.StartsWith($base + '\', [StringComparison]::OrdinalIgnoreCase) -or
    (Split-Path $target -Parent) -ne $base -or
    (Split-Path $target -Leaf) -notmatch '^quality-magpie-[a-zA-Z0-9]+$') {
    throw 'Refusing cleanup outside the isolated integration directory'
}
if (Test-Path -LiteralPath $target) {
    if ((Get-Item -LiteralPath $target -Force).LinkType) { throw 'Unexpected linked root' }
    if (Test-Path -LiteralPath (Join-Path $target 'package\node_modules')) { throw 'Remove the test junction first' }
    # Windows browser helpers can create hidden/system WinINet directories.
    Remove-Item -LiteralPath $target -Recurse -Force
}
