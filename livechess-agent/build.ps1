param(
 [Parameter(Mandatory=$true)][string]$ApplicationJar,
 [Parameter(Mandatory=$true)][string]$EcjJar,
 [string]$InstallDirectory='C:\Program Files\Digital Game Technology\DGT LiveChess'
)
$ErrorActionPreference='Stop'
$java=Join-Path $InstallDirectory 'runtime\bin\java.exe'
$jfx=Join-Path $InstallDirectory 'runtime\lib\ext\jfxrt.jar'
$classes=Join-Path $PSScriptRoot 'build\classes'
New-Item -ItemType Directory -Force $classes | Out-Null
& $java -jar $EcjJar -1.8 -encoding UTF-8 -cp "$ApplicationJar;$jfx" -d $classes (Join-Path $PSScriptRoot 'src\BridgeAgent.java') (Join-Path $PSScriptRoot 'src\PairingBridge.java')
if($LASTEXITCODE -ne 0){throw 'Java agent compilation failed'}
Add-Type -AssemblyName System.IO.Compression
$output=Join-Path $PSScriptRoot '..\src-tauri\resources\livechess-agent.jar'
New-Item -ItemType Directory -Force (Split-Path $output) | Out-Null
$stream=[IO.File]::Open($output,[IO.FileMode]::Create)
$zip=[IO.Compression.ZipArchive]::new($stream,[IO.Compression.ZipArchiveMode]::Create)
try {
 $entry=$zip.CreateEntry('META-INF/MANIFEST.MF')
 $writer=[IO.StreamWriter]::new($entry.Open(),[Text.UTF8Encoding]::new($false))
 $writer.Write("Manifest-Version: 1.0`r`nPremain-Class: BridgeAgent`r`n`r`n")
 $writer.Dispose()
 foreach($file in Get-ChildItem -LiteralPath $classes -Filter '*.class' -File){
  $entry=$zip.CreateEntry($file.Name)
  $source=$file.OpenRead();$destination=$entry.Open()
  try{$source.CopyTo($destination)}finally{$source.Dispose();$destination.Dispose()}
 }
} finally {$zip.Dispose();$stream.Dispose()}
Write-Output $output
