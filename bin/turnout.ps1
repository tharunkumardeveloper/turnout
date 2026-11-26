# turnout (Windows): put Turnout in front of two versions of your app and watch Flagsmith compare them.
#
#   turnout compare <live> <new> [--goal "POST /signup"] [--split 50] [--port 3000]
#       --split: % of visitors who get <new>, up to 50 (the rest get <live>); default 50
#       <live>/<new>: two URLs (localhost:3001, http://localhost:3002), two Docker images (myapp:1.0), or two
#       branches of the git project you're in (main new-checkout: each built from its Dockerfile; your .env is passed)
#       --port: the port your app listens on in its container (default: the Dockerfile's EXPOSE, else 8080)
#   turnout demo: the demo shop and judge mode (stop: turnout demo stop)    turnout update: get the latest Turnout
#   turnout simulate [--visitors 500] [--yes]: pretend visitors, in a separate Flagsmith environment, results in minutes
#   turnout deploy [domain]: the Caddy or Nginx lines to put your web server in front of Turnout
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

function Test-Branch([string]$r) {
  if ($r -match '^https?://|[:=]' -or -not (Get-Command git -ErrorAction SilentlyContinue)) { return $false }
  git rev-parse --verify --quiet "refs/heads/$r" *> $null
  return $LASTEXITCODE -eq 0
}
function Get-Label([string]$b) { return ($b.ToLower() -replace '[^a-z0-9._-]+', '-') }
function Get-ExposedPort([string]$b) {
  $line = git show "refs/heads/${b}:Dockerfile" 2>$null | Where-Object { $_ -match '^\s*EXPOSE\s+(\d{1,5})' } | Select-Object -First 1
  if ($line -and $line -match '(\d{1,5})') { return $Matches[1] }
  return ''
}
# Builds a branch's last commit (git archive: committed files only) from its Dockerfile; returns the image tag.
function Build-Branch([string]$b) {
  git cat-file -e "refs/heads/${b}:Dockerfile" *> $null
  if ($LASTEXITCODE -ne 0) { Die "branch $b has no Dockerfile at its root. Build it yourself and give the image name, or run it and give its URL." }
  $sha = (git rev-parse --short "refs/heads/$b").Trim()
  $tag = "turnout-$Name-$(Get-Label $b):$sha"
  $logs = Join-Path $StateRoot '.builds'; New-Item -ItemType Directory -Force $logs | Out-Null
  $log = Join-Path $logs "$Name-$(Get-Label $b).log"
  docker image inspect $tag *> $null
  if ($LASTEXITCODE -ne 0) {
    Say "Building branch $b ($sha) from its Dockerfile..."
    # Through cmd: a PowerShell pipeline would re-encode git archive's binary tar.
    cmd /c "git archive --format=tar refs/heads/$b | docker build -t $tag - > `"$log`" 2>&1"
    if ($LASTEXITCODE -ne 0) { Get-Content $log -Tail 20; Die "building branch $b failed (full log: $log)." }
  }
  return $tag
}
function Get-AppServices { return @(Compose config --services 2>$null | Where-Object { $_ -like 'turnout-*' }) }
# Crashed: restarted, or not running. Seconds after start, long before doctor could tell.
function Get-CrashedApps {
  foreach ($svc in Get-AppServices) {
    $id = Compose ps -a -q $svc 2>$null | Select-Object -First 1
    if (-not $id) { continue }
    $st = docker inspect -f '{{.State.Status}} {{.RestartCount}}' $id 2>$null
    if ($st -ne 'running 0') { $svc }
  }
}
# Release containers doctor says don't answer (its "expected: container <name> answers" lines).
function Get-FailingApps {
  $doc = Join-Path $State 'doctor.log'
  if (-not (Test-Path $doc)) { return @() }
  $lines = @(Get-Content $doc)
  $out = @()
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -notmatch '\[FAIL\]') { continue }
    foreach ($j in ($i + 1)..([Math]::Min($i + 2, $lines.Count - 1))) { if ($lines[$j] -match 'expected: container (\S+) answers') { $out += $Matches[1] } }
  }
  return @($out | Sort-Object -Unique)
}
function Show-AppLogs([string[]]$svcs) {
  foreach ($svc in $svcs) { Write-Host "--- last log lines of ${svc}:"; Compose logs --no-log-prefix --tail 20 $svc 2>&1 | ForEach-Object { "$_" } }
}
$NotAnswering = "a version doesn't answer: its last log lines are above. If it needs a database or other services, start both versions yourself and run: turnout compare http://localhost:<port-a> http://localhost:<port-b>"

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
  Need-Docker
  # Branches of the git project here: each is built from its own Dockerfile into an image, labelled with the branch.
  $script:Branches = $false
  if ((Test-Branch $Live) -or (Test-Branch $New)) {
    if (-not ((Test-Branch $Live) -and (Test-Branch $New))) { Die "give two branches, or two URLs, or two images (not a mix): `"$($a[0])`" and `"$($a[1])`"" }
    if (-not $AppPort) { $AppPort = Get-ExposedPort $Live }
    if (-not $AppPort) { Die "branch $Live's Dockerfile has no EXPOSE line, so the port your app listens on isn't known: add --port <port>." }
    if (git status --porcelain 2>$null) { Say "Note: uncommitted changes aren't included; each branch is built from its last commit." }
    $script:Branches = $true
    $Live = "$(Get-Label $Live)=$(Build-Branch $Live)"
    $New = "$(Get-Label $New)=$(Build-Branch $New)"
  }
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
    $appEnv = Join-Path (Get-Location) '.env'
    if ($script:Branches -and (Test-Path $appEnv)) { $newArgs += @('--app-env-file', $appEnv) }
    docker @newArgs *> (Join-Path $State 'new.log')
    if ($LASTEXITCODE -ne 0) { Get-Content (Join-Path $State 'new.log'); Die "couldn't write the setup for $Live and $New." }
    Set-Content -Encoding ascii $argsFile ($want + @("proxy_port=$ProxyPort", "console_port=$ConsolePort"))
  }
  if ($script:Branches) {
    # Start the branch builds first and give them a few seconds: a crash shows now, before Flagsmith's set-up.
    Say 'Starting both branches...'
    $apps = Get-AppServices
    Compose up -d @apps *> (Join-Path $State 'apps.log')
    if ($LASTEXITCODE -ne 0) { Get-Content (Join-Path $State 'apps.log') -Tail 20; Die "couldn't start the branches." }
    Start-Sleep 8
    $crashed = @(Get-CrashedApps)
    if ($crashed.Count) { Show-AppLogs $crashed; Compose down *> $null; Die $NotAnswering }
  }
  Say 'Starting Flagsmith and Turnout (the first time takes a few minutes)...'
  foreach ($step in @(@{ n = 'init'; a = @('run', '--rm', 'cli', 'init'); m = 'setting up Flagsmith failed' }, @{ n = 'up'; a = @('up', '-d', '--wait'); m = 'starting failed' })) {
    $log = Join-Path $State "$($step.n).log"
    Compose @($step.a) *> $log
    if ($LASTEXITCODE -ne 0) { Get-Content $log -Tail 20; Die "$($step.m) (full log: $log)." }
  }
  $doc = Join-Path $State 'doctor.log'
  # An app can take a few seconds to listen: check up to three times before calling a version broken.
  foreach ($try in 1..3) {
    Compose run --rm cli doctor *> $doc
    if (-not (Get-FailingApps).Count) { break }
    if ($try -lt 3) { Start-Sleep 10 }
  }
  $failing = @(Get-FailingApps)
  if ($failing.Count) { Show-AppLogs $failing; Die $NotAnswering }
  Say "Check: $(Get-Content $doc | Where-Object { $_.Trim() } | Select-Object -Last 1)"
  Show-Banner
  Start-Process "http://127.0.0.1:$ConsolePort"
}

function Invoke-Deploy([string[]]$a) {
  Read-Args | Out-Null
  $h = if ($a.Count) { $a[0] } else { 'your-domain.example' }
  $lines = @(
    'Going live: run turnout compare on the server that will take the traffic (it already did, on this machine),',
    'then put the web server you already have in front of Turnout. Pick one:', '',
    '  Caddy (Caddyfile; it fetches the HTTPS certificate itself):', "    $h {", "        reverse_proxy 127.0.0.1:$ProxyPort", '    }', '',
    "  Nginx (in the server { } block for ${h}):", '    location / {', "        proxy_pass http://127.0.0.1:$ProxyPort;",
    '        proxy_set_header Host $host;', '        proxy_set_header X-Forwarded-Proto $scheme;   # Turnout marks its cookie Secure over https',
    '        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;', '    }', '',
    "  Visitors keep your address; Turnout picks their version. Turnout's port stays on 127.0.0.1.",
    "  The console stays private too. From your laptop: ssh -L ${ConsolePort}:127.0.0.1:${ConsolePort} you@$h",
    "  then open http://127.0.0.1:$ConsolePort")
  $lines | ForEach-Object { Say $_ }
}

function Invoke-Simulate([string[]]$a) {
  $lines = Read-Args; Need-Docker
  $visitors = '500'; $yes = $false
  for ($i = 0; $i -lt $a.Count; $i++) {
    switch ($a[$i]) {
      '--visitors' { $visitors = $a[$i + 1]; $i++ }
      '--yes' { $yes = $true }
      default { Die "unknown option $($a[$i])" }
    }
  }
  $goal = (($lines | Where-Object { $_ -like 'goal=*' }) -replace '^goal=', '')
  if ($goal -ne 'none' -and -not $yes) {
    Say "Pretend visitors send real requests to your app, including the goal ($goal): it may create real records."
    if ((Read-Host 'Go ahead? [y/N]') -ne 'y') { exit 1 }
  }
  $envFile = Join-Path $State '.env'
  $real = (Get-Content $envFile | Where-Object { $_ -like 'TURNOUT_EXPERIMENT=*' }) -replace '^TURNOUT_EXPERIMENT=([^/]*)/.*$', '$1'
  if (-not $real) { Die "run turnout compare first: there's no experiment yet." }
  New-Item -ItemType Directory -Force (Join-Path $State '.turnout\sim') | Out-Null
  $simEnv = Join-Path $State '.turnout\sim.env'
  if (-not (Test-Path $simEnv)) { Get-Content $envFile | Where-Object { $_ -match '^(TURNOUT_ADMIN_KEY|TURNOUT_PREVIEW_TOKEN)=' } | Set-Content -Encoding ascii $simEnv }
  Say 'Setting up the separate Demo environment in Flagsmith (once)...'
  $log = Join-Path $State 'sim-setup.log'
  Compose run --rm -e TURNOUT_ENV_FILE=.turnout/sim.env -e "TURNOUT_REAL_ENV_KEY=$real" cli sim-setup *> $log
  if ($LASTEXITCODE -ne 0) { Get-Content $log -Tail 20; Die "setting up the Demo environment failed (full log: $log)." }
  $argsFile = Join-Path $State 'compare.args'
  $simPort = (Get-Content $argsFile | Where-Object { $_ -like 'sim_console_port=*' }) -replace '^sim_console_port=', ''
  if (-not $simPort) { $simPort = Get-FreePort 8099 @([int]$ProxyPort, [int]$ConsolePort); Add-Content -Encoding ascii $argsFile "sim_console_port=$simPort" }
  $env:TURNOUT_SIM_CONSOLE_PORT = $simPort
  $log = Join-Path $State 'sim-up.log'
  Compose --profile sim up -d --wait turnout-sim console-sim *> $log
  if ($LASTEXITCODE -ne 0) { Get-Content $log -Tail 20; Die "starting the simulation failed (full log: $log)." }
  Compose run --rm -e TURNOUT_ENV_FILE=.turnout/sim.env cli simulate --visitors $visitors 2>&1 | ForEach-Object { "$_" }
  if ($LASTEXITCODE -ne 0) { Die 'the simulation stopped (see above).' }
  Say ''
  Say "  Simulated results (Demo environment, never your real experiment):  http://127.0.0.1:$simPort"
  Say '  Flagsmith recomputes results at most every 5 minutes. Run turnout simulate again for more visitors.'
  Start-Process "http://127.0.0.1:$simPort"
}

$cmd = if ($args.Count) { $args[0] } else { 'help' }
$rest = if ($args.Count -gt 1) { [string[]]$args[1..($args.Count - 1)] } else { [string[]]@() }
switch ($cmd) {
  'compare' { Invoke-Compare $rest }
  'deploy' { Invoke-Deploy $rest }
  'simulate' { Invoke-Simulate $rest }
  'demo' {
    Need-Docker
    $what = if ($rest.Count) { $rest[0] } else { 'start' }   # start (opens judge mode), or: stop, status, reset
    Push-Location $HomeDir; try { & cmd /c "turnout.bat $what" } finally { Pop-Location }
  }
  'update' { Push-Location $HomeDir; try { git pull --ff-only; if ($LASTEXITCODE -eq 0) { Say 'Up to date. The next turnout compare or turnout demo uses it.' } } finally { Pop-Location } }
  'open' { Read-Args | Out-Null; Start-Process "http://127.0.0.1:$ConsolePort"; Show-Banner }
  'status' { Read-Args | Out-Null; Need-Docker; Compose ps; Compose run --rm cli doctor | Select-Object -Last 1 }
  'down' { Read-Args | Out-Null; Need-Docker; Compose --profile sim down; Say 'Stopped. turnout compare with the same arguments starts it again, with its data.' }
  'reset' {
    Read-Args | Out-Null; Need-Docker
    if ($rest -notcontains '--yes') { $ok = Read-Host "Delete $Name's Turnout and Flagsmith data? [y/N]"; if ($ok -ne 'y') { exit 1 } }
    Compose --profile sim down -v; Remove-Item -Recurse -Force $State; Say 'Wiped. turnout compare starts fresh.'
  }
  default { Get-Content $PSCommandPath -TotalCount 12 | ForEach-Object { $_ -replace '^# ?', '' } }
}
