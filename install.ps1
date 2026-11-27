# Installs the `turnout` command on Windows. Two ways:
#   One line, nothing else needed (downloads the tagged release into %LOCALAPPDATA%\turnout):
#     irm https://raw.githubusercontent.com/tharunkumardeveloper/turnout/main/install.ps1 | iex
#   From a checkout:
#     powershell -ExecutionPolicy Bypass -File install.ps1
# Either way it adds Turnout's bin folder to your user PATH. Run as one line, it also adds it to this window, so
# `turnout demo` works straight away. Undo: turnout uninstall.
# Everything runs in its own scope, so a one-line install (irm | iex) leaves nothing behind in your window but the
# PATH: not $ErrorActionPreference, not these variables.
$here = $PSScriptRoot
& {
  $ErrorActionPreference = 'Stop'
  $Release = 'v1.0.4' # the tagged release a one-line install downloads
  $Repo = 'tharunkumardeveloper/turnout'

  # From a checkout: use it. Piped (irm | iex): there's no script folder, so download the release.
  $fromCheckout = $here -and (Test-Path (Join-Path $here 'bin\turnout.ps1'))
  if ($fromCheckout) {
    $root = $here
  } else {
    $base = if ($env:TURNOUT_INSTALL_DIR) { $env:TURNOUT_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'turnout' }
    $root = Join-Path $base $Release
    if (-not (Test-Path (Join-Path $root 'bin\turnout.ps1'))) {
      Write-Host "Downloading Turnout $Release from github.com/$Repo ..."
      $zip = Join-Path $env:TEMP "turnout-$Release.zip"
      $tmp = Join-Path $env:TEMP "turnout-$Release-unpack"
      [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
      # The release's own archive (GitHub counts its downloads), else the tag's source archive: the same files.
      try {
        Invoke-WebRequest -UseBasicParsing "https://github.com/$Repo/releases/download/$Release/turnout-$Release.zip" -OutFile $zip
      } catch {
        Invoke-WebRequest -UseBasicParsing "https://github.com/$Repo/archive/refs/tags/$Release.zip" -OutFile $zip
      }
      if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
      Expand-Archive $zip -DestinationPath $tmp
      New-Item -ItemType Directory -Force $base | Out-Null
      if (Test-Path $root) { Remove-Item -Recurse -Force $root }
      Move-Item (Get-ChildItem $tmp -Directory | Select-Object -First 1).FullName $root
      Remove-Item -Force $zip; Remove-Item -Recurse -Force $tmp
    }
  }
  $bin = Join-Path $root 'bin'

  # Your user PATH: this bin folder, and no other Turnout's (an earlier download or checkout would shadow it).
  if (-not $env:TURNOUT_NO_USER_PATH) {
    $path = [Environment]::GetEnvironmentVariable('Path', 'User')
    $all = @($path -split ';' | Where-Object { $_ })
    $others = @($all | Where-Object { $_ -ne $bin -and (Test-Path (Join-Path $_ 'turnout.ps1')) })
    $parts = @($all | Where-Object { $others -notcontains $_ })
    if ($parts -notcontains $bin) { $parts += $bin }
    [Environment]::SetEnvironmentVariable('Path', ($parts -join ';'), 'User')
    foreach ($o in $others) { Write-Host "Replaced another Turnout on your PATH: $o" }
  }
  # This window too: works when run as one line (irm | iex), since that runs here; a script run with -File can't.
  $env:Path = "$bin;" + (($env:Path -split ';' | Where-Object { $_ -and $_ -ne $bin }) -join ';')

  Write-Host ''
  Write-Host 'Turnout is installed ' -ForegroundColor Green -NoNewline
  Write-Host "($root)."
  Write-Host 'You need Docker Desktop running, with about 4 GB of memory for it.'
  Write-Host ''
  if ($fromCheckout) {
    # A child process can't change the window that started it: give the command that works here, now.
    Write-Host 'Start it now, in this window:' -ForegroundColor White
    Write-Host "  `"$bin\turnout.cmd`" demo" -ForegroundColor Cyan
    Write-Host '  (in PowerShell, put & in front of it)'
    Write-Host 'In any new terminal, just:  turnout demo' -ForegroundColor White
  } else {
    Write-Host 'Start it now:' -ForegroundColor White
    Write-Host '  turnout demo                                    the demo shop and the guided demo' -ForegroundColor Cyan
    Write-Host '  turnout compare localhost:3001 localhost:3002   two versions of your own site' -ForegroundColor Cyan
  }
  Write-Host 'Every command: turnout help.  Remove it all: turnout uninstall.'
}
