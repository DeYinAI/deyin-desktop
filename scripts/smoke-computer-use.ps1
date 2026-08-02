# Smoke-test computer-use native host on Windows CI.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$hostProj = Join-Path $root "packages/computer-use-host/native"
if (-not (Test-Path $hostProj)) {
  Write-Host "Native host project missing; skipping."
  exit 0
}
Push-Location $hostProj
dotnet publish -c Release -r win-x64 --self-contained false
$exe = Join-Path $hostProj "bin/Release/net8.0-windows/win-x64/publish/deyin-computer-use-host.exe"
if (-not (Test-Path $exe)) { throw "Host exe not built at $exe" }
$proc = Start-Process -FilePath $exe -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 2
node -e "const net=require('net');const s=net.connect('\\\\.\\pipe\\deyin-computer-use',()=>{s.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'ping'})+'\n');});let d='';s.on('data',c=>{d+=c;if(d.includes('\n')){console.log(d.trim());process.exit(0);}});setTimeout(()=>process.exit(1),5000);"
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
Pop-Location
