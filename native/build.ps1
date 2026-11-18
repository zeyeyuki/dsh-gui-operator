# Builds native\gui-operator.exe with the C# compiler that ships with .NET
# Framework 4.x. No SDK, no NuGet, no build tool installation needed.
#
#   powershell -ExecutionPolicy Bypass -File native\build.ps1
#
# The output is a single self-contained console executable; the plugin invokes it
# directly and never loads it in-process.

$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$source = Join-Path $here 'gui-operator.cs'
$target = Join-Path $here 'gui-operator.exe'

$cscCandidates = @(
    'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe',
    'C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe'
)
$csc = $cscCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $csc) { throw 'csc.exe not found: .NET Framework 4.x is required to build the helper.' }

# UI Automation lives in the GAC; csc cannot find it by simple name without the
# reference assemblies that only a Visual Studio install provides.
$gac = 'C:\Windows\Microsoft.NET\assembly\GAC_MSIL'
function Get-GacAssembly {
    param([string]$Name)
    $directory = Join-Path $gac $Name
    if (-not (Test-Path $directory)) { throw "GAC assembly $Name not found under $gac" }
    $file = Get-ChildItem $directory -Recurse -Filter "$Name.dll" -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if (-not $file) { throw "GAC assembly file for $Name not found" }
    return $file.FullName
}

$references = @(
    (Get-GacAssembly 'UIAutomationClient'),
    (Get-GacAssembly 'UIAutomationTypes'),
    (Get-GacAssembly 'WindowsBase')
)

$framework = Split-Path -Parent $csc
$references += @(
    (Join-Path $framework 'System.dll'),
    (Join-Path $framework 'System.Core.dll'),
    (Join-Path $framework 'System.Drawing.dll'),
    (Join-Path $framework 'System.Windows.Forms.dll')
)

$arguments = @('/nologo', '/target:exe', '/optimize+', "/out:$target")
foreach ($reference in $references) { $arguments += "/r:$reference" }
$arguments += $source

& $csc @arguments
if ($LASTEXITCODE -ne 0) { throw "csc failed with exit code $LASTEXITCODE" }

Write-Host "built $target ($((Get-Item $target).Length) bytes)"