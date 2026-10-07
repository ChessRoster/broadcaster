param(
 [string]$Python='python',
 [string]$Java='java',
 [string]$Output=(Join-Path $PSScriptRoot '..\src-tauri\resources\livechess-agent.jar'),
 [switch]$VerifyTracked
)
$ErrorActionPreference='Stop'
$buildArguments=@((Join-Path $PSScriptRoot 'build.py'),'--java',$Java,'--output',$Output)
if($VerifyTracked){$buildArguments+='--verify-tracked'}
& $Python @buildArguments
if($LASTEXITCODE -ne 0){throw 'Java agent build or integrity verification failed'}
