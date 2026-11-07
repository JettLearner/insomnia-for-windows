$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$fwDir = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
$source = Join-Path $root 'resources\helper\InsomniaZAuto.cs'
$manifest = Join-Path $root 'resources\helper\InsomniaZAuto.manifest'
$output = Join-Path $root 'resources\helper\InsomniaZAuto.exe'

if (-not (Test-Path $csc)) {
    throw "C# compiler not found at $csc. Windows .NET Framework 4.x is required."
}
if (-not (Test-Path $source)) {
    throw "Automation helper source not found at $source."
}
if (-not (Test-Path $manifest)) {
    throw "Automation helper manifest not found at $manifest."
}

$winmdCandidates = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\UnionMetadata' -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^\d+\.' } |
    Sort-Object { [version]$_.Name } -Descending |
    ForEach-Object { Join-Path $_.FullName 'Windows.winmd' } |
    Where-Object { Test-Path $_ }
$winmd = $winmdCandidates | Select-Object -First 1
if (-not $winmd) {
    throw "Windows.winmd was not found. Install a Windows 10/11 SDK (UnionMetadata)."
}

$winrtRuntime = Join-Path $fwDir 'System.Runtime.WindowsRuntime.dll'
if (-not (Test-Path $winrtRuntime)) {
    throw "System.Runtime.WindowsRuntime.dll was not found in $fwDir."
}
$sysRuntime = Join-Path $fwDir 'System.Runtime.dll'

Write-Host "Compiling automation helper with $csc"
$refs = @(
    '-r:System.Web.Extensions.dll',
    '-r:System.Drawing.dll',
    '-r:System.Windows.Forms.dll',
    '-r:System.Core.dll',
    ('-r:"{0}"' -f (Join-Path $fwDir 'Accessibility.dll')),
    ('-r:"{0}"' -f $winrtRuntime),
    ('-r:"{0}"' -f $winmd)
)
if (Test-Path $sysRuntime) { $refs += ('-r:"{0}"' -f $sysRuntime) }

& $csc -nologo -optimize+ -target:winexe -platform:x64 -langversion:5 `
    @refs `
    ('-win32manifest:"{0}"' -f $manifest) `
    ('-out:"{0}"' -f $output) `
    ('"{0}"' -f $source)

if ($LASTEXITCODE -ne 0) {
    throw "Automation helper compilation failed with exit code $LASTEXITCODE."
}

$info = Get-Item $output
Write-Host ("Automation helper compiled: {0} ({1:N0} bytes)" -f $info.FullName, $info.Length)
