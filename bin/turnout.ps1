# turnout (Windows): put Turnout in front of two versions of your app and watch Flagsmith compare them.
#
#   turnout compare <live> <new> [--goal "POST /signup"] [--split 50] [--port 3000]
#       <live>/<new>: two URLs (localhost:3001, http://localhost:3002) or two Docker images (myapp:1.0)
#       --port: the port your images listen on (default 8080); not needed for URLs
#   turnout open | status | down | reset [--yes]
#
# Same behaviour as bin/turnout (macOS, Linux). Files live in %USERPROFILE%\.turnout\projects\<this folder's name>.
$ErrorActionPreference = 'Stop'
$HomeDir = Split-Path -Parent $PSScriptRoot
$Image = if ($env:TURNOUT_IMAGE) { $env:TURNOUT_IMAGE } else { 'ghcr.io/tharunkumardeveloper/turnout:latest' }
$Name = ((Split-Path -Leaf (Get-Location)).ToLower() -replace '[^a-z0-9]+', '-').Trim('-')
if (-not $Name) { $Name = 'app' }
$StateRoot = if ($env:TURNOUT_STATE) { $env:TURNOUT_STATE } else { Join-Path $env:USERPROFILE '.turnout\projects' }
$State = Join-Path $StateRoot $Name
$Project = "turnout-$Name"

function Say([string]$m) { Write-Host $m }
function Die([string]$m) { Write-Host "turnout: $m" -ForegroundColor Red; exit 1 }
function Compose { docker compose -p $Project --project-directory $State -f (Join-Path $State 'turnout.compose.yml') @args }

function Need-Docker {
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Die "Docker isn't installed. Install Docker Desktop (https://docs.docker.com/get-docker/), start it, and run this again." }
  docker info *> $null
  if ($LASTEXITCODE -ne 0) { Die "Docker isn't running. Start Docker Desktop, wait until it says it's running, and run this again." }
}

function Need-Image {
  docker image inspect $script:Image *> $null; if ($LASTEXITCODE -eq 0) { return }
  docker pull -q $script:Image *> $null; if ($LASTEXITCODE -eq 0) { return }
  $script:Image = 'turnout:local'
  docker image inspect $script:Image *> $null
  if ($LASTEXITCODE -eq 0) { Say "Using turnout:local (the published image can't be pulled)."; return }
  if (-not (Test-Path (Join-Path $HomeDir 'Dockerfile'))) { Die "can't pull the image and there's no Turnout checkout at $HomeDir to build from." }
  Say "The published image can't be pulled, so building turnout:local from $HomeDir (once, about a minute)."
  docker build -q -t turnout:local $HomeDir *> $null
  if ($LASTEXITCODE -ne 0) { Die "building turnout:local failed: run docker build -t turnout:local `"$HomeDir`" to see why." }
}

function Test-PortFree([int]$p) {
  try { $l = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $p); $l.Start(); $l.Stop(); return $true } catch { return $false }
}
function Get-FreePort([int]$from, [int[]]$taken = @()) {
  for ($p = $from; $p -lt $from + 50; $p++) { if (($taken -notcontains $p) -and (Test-PortFree $p)) { return $p } }
  Die "no free port from $from to $($from + 49)"
}

function Normalise([string]$r) {
  if ($r -match '^https?://') { return $r }
  if ($r -match '^(localhost|127\.0\.0\.1):\d+' -or $r -match '^[\w.-]+\.[\w.-]+:\d+$') { return "http://$r" }
  return $r
}

function Read-Args {
  $f = Join-Path $State 'compare.args'
  if (-not (Test-Path $f)) { Die "nothing set up for $Name here yet: run turnout compare <live> <new> first." }
  $lines = Get-Content $f
  $script:ProxyPort = ($lines | Where-Object { $_ -like 'proxy_port=*' }) -replace '^proxy_port=', ''
  $script:ConsolePort = ($lines | Where-Object { $_ -like 'console_port=*' }) -replace '^console_port=', ''
  return $lines
}

function Show-Banner {
  Say ''
  Say "  Your app is live through Turnout:  http://127.0.0.1:$ProxyPort"
  Say "  Results, Ship and Revert:          http://127.0.0.1:$ConsolePort"
  Say ''
  Say '  Each new browser (or private window) is a new visitor: it gets one version and keeps it.'
  Say '  Stop: turnout down    Start again: turnout compare (same arguments)    Wipe: turnout reset'
  Say ''
}

function Invoke-Compare([string[]]$a) {
  if ($a.Count -lt 2) { Die 'usage: turnout compare <live> <new> [--goal "POST /signup"] [--split 50] [--port 3000]' }
  $A = Normalise $a[0]; $B = Normalise $a[1]
  $Goal = 'none'; $Split = '50'; $AppPort = ''
  for ($i = 2; $i -lt $a.Count; $i += 2) {
    switch ($a[$i]) {
      '--goal' { $Goal = $a[$i + 1] }
      '--split' { $Split = $a[$i + 1] }
      '--port' { $AppPort = $a[$i + 1] }
      default { Die "unknown option $($a[$i])" }
    }
  }
  foreach ($r in @($A, $B)) {
    if ($r -notmatch '^https?://' -and (Get-Command git -ErrorAction SilentlyContinue)) {
      git rev-parse --verify --quiet "refs/heads/$r" *> $null
      if ($LASTEXITCODE -eq 0) { Die "`"$r`" is a git branch. Comparing branches isn't built yet: run both versions (e.g. on ports 3001 and 3002) and give their URLs." }
    }
  }
  Need-Docker
  Need-Image
  New-Item -ItemType Directory -Force $State | Out-Null
  $want = @("releases=$A $B", "goal=$Goal", "split=$Split", "app_port=$AppPort")
  $argsFile = Join-Path $State 'compare.args'
  $old = if (Test-Path $argsFile) { @(Get-Content $argsFile | Where-Object { $_ -notlike '*_port=*' -or $_ -like 'app_port=*' }) } else { $null }
  if ($old -and (($old -join "`n") -eq ($want -join "`n"))) {
    Read-Args | Out-Null
    Say "Resuming ${Name}: $A vs $B."
  } else {
    if ($old) { Say "New versions or settings: setting $Name up again."; Compose down *> $null }
    $script:ProxyPort = Get-FreePort 8080
    $script:ConsolePort = Get-FreePort 8090 @($ProxyPort)
    $fsPort = Get-FreePort 8000 @($ProxyPort, $ConsolePort)
    if ($ProxyPort -ne 8080) { Say "Port 8080 is busy: your app will be on $ProxyPort." }
    $newArgs = @('run', '--rm', '-v', "${State}:/work", '-w', '/work', $Image, 'new', '--yes', '--force',
      '--release', $A, '--release', $B, '--success', $Goal, '--traffic', $Split,
      '--proxy-port', $ProxyPort, '--console-port', $ConsolePort, '--flagsmith-port', $fsPort, '--image', $Image)
    if ($AppPort) { $newArgs += @('--port', $AppPort) }
    docker @newArgs *> (Join-Path $State 'new.log')
    if ($LASTEXITCODE -ne 0) { Get-Content (Join-Path $State 'new.log'); Die "couldn't write the setup for $A and $B." }
    Set-Content -Encoding ascii $argsFile ($want + @("proxy_port=$ProxyPort", "console_port=$ConsolePort"))
  }
  Say 'Starting Flagsmith and Turnout (the first time takes a few minutes)...'
  foreach ($step in @(@{ n = 'init'; a = @('run', '--rm', 'cli', 'init'); m = 'setting up Flagsmith failed' }, @{ n = 'up'; a = @('up', '-d', '--wait'); m = 'starting failed' })) {
    $log = Join-Path $State "$($step.n).log"
    Compose @($step.a) *> $log
    if ($LASTEXITCODE -ne 0) { Get-Content $log -Tail 20; Die "$($step.m) (full log: $log)." }
  }
  $doc = Join-Path $State 'doctor.log'
  Compose run --rm cli doctor *> $doc
  Say "Check: $(Get-Content $doc -Tail 1)"
  Show-Banner
  Start-Process "http://127.0.0.1:$ConsolePort"
}

$cmd = if ($args.Count) { $args[0] } else { 'help' }
$rest = if ($args.Count -gt 1) { [string[]]$args[1..($args.Count - 1)] } else { [string[]]@() }
switch ($cmd) {
  'compare' { Invoke-Compare $rest }
  'open' { Read-Args | Out-Null; Start-Process "http://127.0.0.1:$ConsolePort"; Show-Banner }
  'status' { Read-Args | Out-Null; Need-Docker; Compose ps; Compose run --rm cli doctor | Select-Object -Last 1 }
  'down' { Read-Args | Out-Null; Need-Docker; Compose down; Say 'Stopped. turnout compare with the same arguments starts it again, with its data.' }
  'reset' {
    Read-Args | Out-Null; Need-Docker
    if ($rest -notcontains '--yes') { $ok = Read-Host "Delete $Name's Turnout and Flagsmith data? [y/N]"; if ($ok -ne 'y') { exit 1 } }
    Compose down -v; Remove-Item -Recurse -Force $State; Say 'Wiped. turnout compare starts fresh.'
  }
  default { Get-Content $PSCommandPath -TotalCount 7 | ForEach-Object { $_ -replace '^# ?', '' } }
}
