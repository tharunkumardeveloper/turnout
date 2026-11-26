# Installs the `turnout` command (Windows, PowerShell or CMD): adds this checkout's bin folder to your user PATH, then
# shows what this machine has and how to use it. Run it from the checkout:
#   powershell -ExecutionPolicy Bypass -File install.ps1
# Undo: remove the folder from Settings > System > About > Advanced system settings > Environment Variables > Path.
$bin = Join-Path $PSScriptRoot 'bin'
$path = [Environment]::GetEnvironmentVariable('Path', 'User')
$parts = @($path -split ';' | Where-Object { $_ })
$added = $parts -notcontains $bin
if ($added) { [Environment]::SetEnvironmentVariable('Path', (($parts + $bin) -join ';'), 'User') }

# The logo, what's needed, and every command (the same screen as `turnout help`).
& (Join-Path $bin 'turnout.ps1') help
Write-Host ''
Write-Host 'Installed: ' -ForegroundColor Green -NoNewline
Write-Host $(if ($added) { "added $bin to your user PATH" } else { "$bin is already on your PATH" })
Write-Host 'Next: ' -ForegroundColor White -NoNewline
Write-Host "open a NEW terminal, go to your project's folder and run  turnout compare localhost:3001 localhost:3002  (or try  turnout demo)"
