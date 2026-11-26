# Puts the `turnout` command on your PATH (Windows, PowerShell or CMD): adds this checkout's bin folder to your user PATH.
# Run it from the checkout: powershell -ExecutionPolicy Bypass -File install.ps1
# Undo: remove the folder from Settings > System > About > Advanced system settings > Environment Variables > Path.
$bin = Join-Path $PSScriptRoot 'bin'
$path = [Environment]::GetEnvironmentVariable('Path', 'User')
$parts = @($path -split ';' | Where-Object { $_ })
if ($parts -contains $bin) {
  Write-Host "Already on your PATH: $bin"
} else {
  [Environment]::SetEnvironmentVariable('Path', (($parts + $bin) -join ';'), 'User')
  Write-Host "Added to your user PATH: $bin"
}
Write-Host 'Open a new terminal, then: cd your-project; turnout compare localhost:3001 localhost:3002'
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Write-Host "Docker isn't installed yet: https://docs.docker.com/desktop/setup/install/windows-install/ (Turnout runs in it)." }
