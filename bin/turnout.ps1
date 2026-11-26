# turnout (Windows): put Turnout in front of two versions of your app and watch Flagsmith compare them.
#
#   turnout compare <live> <new> [--goal "POST /signup"] [--split 50] [--port 3000]
#       --split: % of visitors who get <new>, up to 50 (the rest get <live>); default 50
#       <live>/<new>: two URLs (localhost:3001, http://localhost:3002) or two Docker images (myapp:1.0)
#       --port: the port your images listen on (default 8080); not needed for URLs
#   turnout open | status | down | reset [--yes]
#
# Same behaviour as bin/turnout (macOS, Linux). Files live in %USERPROFILE%\.turnout\projects\<this folder's name>.
# Continue, not Stop: Windows PowerShell 5.1 turns any stderr line from git or docker into a fatal error under Stop,
# even when redirected. Every native call's exit code is checked instead.
$ErrorActionPreference = 'Continue'
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
  if (-not (Test-Path (Join-Path $HomeDir 'Dockerfile'))) { Die "can't pull the image and there's no Turnout checkout at $HomeDir to build from." }
  # Always rebuilt, so it matches this checkout; Docker's cache makes that seconds when nothing changed.
  Say "The published image can't be pulled, so using turnout:local, built from $HomeDir (the first build takes about a minute)."
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
  $Live = Normalise $a[0]; $New = Normalise $a[1]
  $Goal = 'none'; $Split = '50'; $AppPort = ''
  for ($i = 2; $i -lt $a.Count; $i += 2) {
    switch ($a[$i]) {
      '--goal' { $Goal = $a[$i + 1] }
      '--split' { $Split = $a[$i + 1] }
      '--port' { $AppPort = $a[$i + 1] }
      default { Die "unknown option $($a[$i])" }
    }
  }
  $n = 0
  if (-not [int]::TryParse($Split, [ref]$n) -or $n -lt 1 -or $n -gt 50) { Die '--split is a whole percentage from 1 to 50 (Flagsmith splits the experiment''s visitors evenly)' }
  $Traffic = [string]($n * 2)   # visitors in the experiment, split evenly between <live> and <new>
  foreach ($r in @($Live, $New)) {
    if ($r -notmatch '^https?://' -and (Get-Command git -ErrorAction SilentlyContinue)) {
      git rev-parse --verify --quiet "refs/heads/$r" *> $null
      if ($LASTEXITCODE -eq 0) { Die "`"$r`" is a git branch. Comparing branches isn't built yet: run both versions (e.g. on ports 3001 and 3002) and give their URLs." }
    }
  }
  Need-Docker
  Need-Image
  New-Item -ItemType Directory -Force $State | Out-Null
  $want = @("releases=$Live $New", "goal=$Goal", "split=$Split", "app_port=$AppPort")
  $argsFile = Join-Path $State 'compare.args'
  $old = if (Test-Path $argsFile) { @(Get-Content $argsFile | Where-Object { $_ -notlike '*_port=*' -or $_ -like 'app_port=*' }) } else { $null }
  if ($old -and (($old -join "`n") -eq ($want -join "`n"))) {
    Read-Args | Out-Null
    Say "Resuming ${Name}: $Live vs $New."
  } else {
    if ($old) {
      # A running experiment keeps its split and its main metric (Flagsmith fixes it at creation), so different
      # versions or settings need a new experiment, from scratch.
      Say "Different versions or settings start a new experiment: the previous one's data is discarded."
      Compose down -v *> $null
      Get-ChildItem -Force $State | Remove-Item -Recurse -Force
    }
    $script:ProxyPort = Get-FreePort 8080
    $script:ConsolePort = Get-FreePort 8090 @($ProxyPort)
    $fsPort = Get-FreePort 8000 @($ProxyPort, $ConsolePort)
    if ($ProxyPort -ne 8080) { Say "Port 8080 is busy: your app will be on $ProxyPort." }
    $newArgs = @('run', '--rm', '-v', "${State}:/work", $Image, 'new', '--dir', '/work', '--yes', '--force',
      '--release', $Live, '--release', $New, '--success', $Goal, '--traffic', $Traffic,
      '--proxy-port', $ProxyPort, '--console-port', $ConsolePort, '--flagsmith-port', $fsPort, '--image', $Image)
    if ($AppPort) { $newArgs += @('--port', $AppPort) }
    docker @newArgs *> (Join-Path $State 'new.log')
    if ($LASTEXITCODE -ne 0) { Get-Content (Join-Path $State 'new.log'); Die "couldn't write the setup for $Live and $New." }
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
  Say "Check: $(Get-Content $doc | Where-Object { $_.Trim() } | Select-Object -Last 1)"
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
