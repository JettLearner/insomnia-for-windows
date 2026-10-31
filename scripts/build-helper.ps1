$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$source = Join-Path $root 'resources\helper\InsomniaZHelper.cs'
$output = Join-Path $root 'resources\helper\InsomniaZHelper.exe'

if (-not (Test-Path $csc)) {
    throw "C# compiler not found at $csc. Windows .NET Framework 4.x is required."
}
if (-not (Test-Path $source)) {
    throw "Helper source not found at $source."
}

Write-Host "Compiling power helper with $csc"
& $csc -nologo -optimize+ -target:winexe -platform:x64 `
    -r:System.Web.Extensions.dll `
    -out:$output `
    $source

if ($LASTEXITCODE -ne 0) {
    throw "C# helper compilation failed with exit code $LASTEXITCODE."
}

$info = Get-Item $output
Write-Host ("Helper compiled: {0} ({1:N0} bytes)" -f $info.FullName, $info.Length)
