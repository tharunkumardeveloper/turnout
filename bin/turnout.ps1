# turnout (Windows): put Turnout in front of two or more versions of your app and watch Flagsmith compare them.
#
#   turnout compare <live> <new> [<new2> …] [--goal "POST /signup"] [--split 50] [--port 3000] [--env-file .env]
#       Two versions make an A/B test, three an A/B/C test, and so on: <live> is A, the others are tested against it.
#       --split: % of visitors who get each new version (the rest get <live>); default: an even share each
#       versions: URLs (localhost:3001, http://localhost:3002), Docker images (myapp:1.0), or branches of the git
#       project you're in (main new-checkout: each built from its Dockerfile; your .env is passed); not a mix
#       --port: the port your app listens on in its container (default: the Dockerfile's EXPOSE, else 8080)
#   turnout demo: the demo shop and guided demo (stop: turnout demo stop)    turnout update: get the latest Turnout
#   turnout simulate [--visitors 500] [--yes]: pretend visitors, in a separate Flagsmith environment, results in minutes
#   turnout deploy [domain]: the Caddy or Nginx lines to put your web server in front of Turnout
#   turnout open | status | down | reset [--yes]
#
# Same behaviour as bin/turnout (macOS, Linux). Files live in %USERPROFILE%\.turnout\projects\<this folder's name>.
# Continue, not Stop: Windows PowerShell 5.1 turns any stderr line from git or docker into a fatal error under Stop,
# even when redirected. Every native call's exit code is checked instead.
$ErrorActionPreference = 'Continue'
$HomeDir = Split-Path -Parent $PSScriptRoot
$Image = if ($env:TURNOUT_IMAGE) { $env:TURNOUT_IMAGE } else { 'turnout:local' }
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
  # turnout:local is built from this checkout (no registry, no account); TURNOUT_IMAGE=<image> uses another one.
  if ($script:Image -ne 'turnout:local') {
    docker image inspect $script:Image *> $null; if ($LASTEXITCODE -eq 0) { return }
    docker pull -q $script:Image *> $null; if ($LASTEXITCODE -eq 0) { return }
    Die "can't pull $script:Image (TURNOUT_IMAGE). Unset it to build turnout:local from this checkout."
  }
  if (-not (Test-Path (Join-Path $HomeDir 'Dockerfile'))) { Die "there's no Turnout checkout at $HomeDir to build turnout:local from." }
  # Always rebuilt, so it matches this checkout; Docker's cache makes that seconds when nothing changed.
  docker image inspect turnout:local *> $null; if ($LASTEXITCODE -ne 0) { Say "Building turnout:local from $HomeDir (the first build takes about a minute)." }
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

# ---- the look: logo, colours, help -------------------------------------------------------------------------------
function Show-Logo {
  # Block letters need UTF-8 output (Windows Terminal and PowerShell 7 have it; this sets it for the old console too).
  try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
  Write-Host ''
  Write-Host '   ████████ ██    ██ ██████  ███    ██  ██████  ██    ██ ████████' -ForegroundColor Blue
  Write-Host '      ██    ██    ██ ██   ██ ████   ██ ██    ██ ██    ██    ██' -ForegroundColor Cyan
  Write-Host '      ██    ██    ██ ██████  ██ ██  ██ ██    ██ ██    ██    ██' -ForegroundColor DarkCyan
  Write-Host '      ██    ██    ██ ██   ██ ██  ██ ██ ██    ██ ██    ██    ██' -ForegroundColor Green
  Write-Host '      ██     ██████  ██   ██ ██   ████  ██████   ██████     ██' -ForegroundColor Yellow
  Write-Host ''
  Write-Host '   Every release becomes a Flagsmith experiment. ' -ForegroundColor White -NoNewline
  Write-Host 'No app code. One click to ship or roll back.' -ForegroundColor DarkGray
  Write-Host "   v$(Get-Version) · built by Tharun Kumar · powered by " -ForegroundColor DarkGray -NoNewline
  Write-Host 'Flagsmith' -ForegroundColor Magenta
  Write-Host ''
}
function Get-Version {
  try { return (Get-Content (Join-Path $HomeDir 'package.json') -Raw | ConvertFrom-Json).version } catch { return '?' }
}
function Step([string]$m) { Write-Host '▸ ' -ForegroundColor Cyan -NoNewline; Write-Host $m -ForegroundColor White }
function Show-Section([string]$t) { Write-Host "  $t " -ForegroundColor White -NoNewline; Write-Host ('─' * [Math]::Max(4, 60 - $t.Length)) -ForegroundColor DarkGray }
function Show-Cmd([string]$cmd, [string]$what) { Write-Host ('    ' + $cmd.PadRight(35)) -ForegroundColor Cyan -NoNewline; Write-Host $what }
function Show-Opt([string]$opt, [string]$what) { Write-Host ('      ' + $opt.PadRight(33) + $what) -ForegroundColor DarkGray }

function Test-Machine {
  $ok = $true
  if (Get-Command docker -ErrorAction SilentlyContinue) {
    docker info *> $null
    if ($LASTEXITCODE -eq 0) { Write-Host '    ✓ ' -ForegroundColor Green -NoNewline; Write-Host 'Docker is installed and running' }
    else { Write-Host '    ! ' -ForegroundColor Yellow -NoNewline; Write-Host 'Docker is installed but not running: start Docker Desktop'; $ok = $false }
  } else { Write-Host '    ✕ ' -ForegroundColor Red -NoNewline; Write-Host "Docker isn't installed: https://docs.docker.com/desktop/setup/install/windows-install/"; $ok = $false }
  if (Get-Command git -ErrorAction SilentlyContinue) { Write-Host '    ✓ ' -ForegroundColor Green -NoNewline; Write-Host 'Git is installed' }
  else { Write-Host '    – ' -ForegroundColor Yellow -NoNewline; Write-Host "Git isn't installed (needed for turnout update and comparing branches): https://git-scm.com/downloads" }
  return $ok
}

function Show-Help {
  Show-Logo
  Show-Section 'WHAT YOU NEED'
  Test-Machine | Out-Null
  Write-Host '    About 4 GB of memory for Docker. Flagsmith comes with Turnout: nothing else to install.' -ForegroundColor DarkGray
  Write-Host ''
  Show-Section 'START HERE'
  Show-Cmd 'turnout demo' 'the demo shop: console, Guided demo, Try it, the tours'
  Show-Cmd 'turnout demo stop' 'stop it (data kept)'
  Write-Host ''
  Show-Section 'TEST YOUR APP   (in your project folder)'
  Show-Cmd 'turnout compare <A> <B> [<C>]' 'put Turnout in front of your versions: A/B, A/B/C'
  Show-Opt 'A, B: localhost:3001, myapp:1.1' 'URLs, Docker images or git branches'
  Show-Opt '--goal "POST /signup"' 'what counts as a win (none: page speed)'
  Show-Opt '--split 10' '% of visitors on each new version'
  Show-Opt '--browser-speed' 'also measure page speed in browsers (lcp_ms, cls)'
  Show-Opt '--port 3000' 'the port your images listen on'
  Show-Opt '--env-file .env.turnout' "your app's settings (default .env)"
  Show-Cmd 'turnout simulate [--visitors 500]' 'pretend visitors, so results show in minutes'
  Show-Cmd 'turnout browsers [--visits 100]' 'real headless-Chrome visits: page speed before real traffic'
  Show-Cmd 'turnout open' 'the console: traffic, results, Ship or Revert'
  Write-Host ''
  Show-Section 'DECIDE   (Flagsmith decides; you confirm)'
  Show-Cmd 'turnout results' "Flagsmith's results, in the terminal"
  Show-Cmd 'turnout ship [v2]' 'move everyone to the winner (asks first)'
  Show-Cmd 'turnout revert' 'move everyone back to A (asks first)'
  Write-Host ''
  Show-Section 'GO LIVE'
  Show-Cmd 'turnout deploy yourdomain.com' 'the Nginx or Caddy lines to put Turnout in front'
  Write-Host ''
  Show-Section 'LOOK AFTER IT'
  Show-Cmd 'turnout status' "what's running, and a full check"
  Show-Cmd 'turnout logs [proxy|console]' "follow Turnout's logs"
  Show-Cmd 'turnout down | reset' 'stop (data kept) | wipe and start fresh'
  Show-Cmd 'turnout uninstall [--dry-run]' 'remove Turnout: its containers, data and PATH entry (asks first)'
  Show-Cmd 'turnout update | version' 'get the latest | which one you have'
  Write-Host ''
  Write-Host '  How it works: visitors reach Turnout, Flagsmith picks each one''s version, Turnout sends them there and' -ForegroundColor DarkGray
  Write-Host '  reports what they did; Flagsmith scores every version; one click moves everyone to the winner.' -ForegroundColor DarkGray
  Write-Host "  More: turnout help · README.md in $HomeDir" -ForegroundColor DarkGray
}

function Show-Result([string]$proxy, [string]$console) {
  Write-Host ''
  Write-Host '  +----------------------------------------------------------+' -ForegroundColor Green
  Write-Host '  |  Your app, through Turnout:   ' -ForegroundColor Green -NoNewline; Write-Host "http://127.0.0.1:$proxy" -ForegroundColor White
  Write-Host '  |  Results, Ship and Revert:    ' -ForegroundColor Green -NoNewline; Write-Host "http://127.0.0.1:$console" -ForegroundColor White
  Write-Host '  +----------------------------------------------------------+' -ForegroundColor Green
}

function Show-Banner {
  Show-Result $ProxyPort $ConsolePort
  Say ''
  Say '  Each new browser (or private window) is a new visitor: it gets one version and keeps it.'
  Say '  Stop: turnout down    Start again: turnout compare (same arguments)    Wipe: turnout reset'
  Say '  Tried it on your site? Two minutes, it helps: https://github.com/tharunkumardeveloper/turnout/issues/new?template=tried-turnout.yml'
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
    Step "Building branch $b ($sha) from its Dockerfile"
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
$NotAnswering = "a version doesn't answer: its last log lines are above. If it needs a database or other services, start the versions yourself and run: turnout compare http://localhost:<port-a> http://localhost:<port-b> …"

function Invoke-Compare([string[]]$a) {
  Show-Logo
  # The versions come first: A (live), then every new one. Two make an A/B test, three an A/B/C test, and so on.
  $first = 0
  while ($first -lt $a.Count -and -not $a[$first].StartsWith('--')) { $first++ }
  if ($first -lt 2) { Die 'usage: turnout compare <live> <new> [<new2> …] [--goal "POST /signup"] [--split 50] [--port 3000] [--env-file .env]' }
  if ($first -gt 26) { Die 'at most 26 versions (A to Z)' }
  $Given = @($a[0..($first - 1)])
  $Versions = @($Given | ForEach-Object { Normalise $_ })
  $N = $Versions.Count
  $Goal = 'none'; $Split = ''; $AppPort = ''; $EnvFile = ''; $BrowserSpeed = $false
  for ($i = $first; $i -lt $a.Count; $i += 2) {
    switch ($a[$i]) {
      '--browser-speed' { $BrowserSpeed = $true; $i-- } # takes no value
      '--goal' { $Goal = $a[$i + 1] }
      '--split' { $Split = $a[$i + 1] }
      '--port' { $AppPort = $a[$i + 1] }
      '--env-file' { $EnvFile = $a[$i + 1] }
      default { Die "unknown option $($a[$i])" }
    }
  }
  # Visitors in the experiment: everyone by default, split evenly between all the versions (50/50, 34/33/33…).
  # --split S gives each new version S% of visitors: the experiment then takes S% times the number of versions.
  $maxSplit = [math]::Floor(100 / $N)
  if ($Split) {
    $s = 0
    if (-not [int]::TryParse($Split, [ref]$s) -or $s -lt 1 -or $s -gt $maxSplit) { Die "--split is a whole percentage from 1 to $maxSplit with $N versions (Flagsmith splits the experiment's visitors evenly)" }
    $Traffic = [string]($s * $N)
  } else {
    $Split = [string]$maxSplit; $Traffic = '100'
  }
  Need-Docker
  # Branches of the git project here: each is built from its own Dockerfile into an image, labelled with the branch.
  $script:Branches = $false
  $branchCount = @($Versions | Where-Object { Test-Branch $_ }).Count
  if ($branchCount) {
    if ($branchCount -ne $N) { Die "give all branches, or all URLs, or all images (not a mix): $($Given -join ' ')" }
    if (-not $AppPort) { $AppPort = Get-ExposedPort $Versions[0] }
    if (-not $AppPort) { Die "branch $($Versions[0])'s Dockerfile has no EXPOSE line, so the port your app listens on isn't known: add --port <port>." }
    if (git status --porcelain 2>$null) { Say "Note: uncommitted changes aren't included; each branch is built from its last commit." }
    $script:Branches = $true
    $Versions = @($Versions | ForEach-Object { "$(Get-Label $_)=$(Build-Branch $_)" })
  }
  $Title = $Versions -join ' vs '
  $Kind = ([char[]]'ABCDEFGHIJKLMNOPQRSTUVWXYZ')[0..($N - 1)] -join '/'
  Need-Image
  New-Item -ItemType Directory -Force $State | Out-Null
  # Your app's settings: --env-file, else the .env in this folder. Passed to every version Turnout starts itself (an
  # image or a branch); versions you run yourself (URLs) already have theirs.
  $appEnv = if ($EnvFile) { (Resolve-Path $EnvFile -ErrorAction SilentlyContinue).Path } else { Join-Path (Get-Location) '.env' }
  if ($EnvFile -and -not $appEnv) { Die "--env-file: no such file: $EnvFile" }
  $isUrl = $Versions[0] -match '^https?://'
  if ($isUrl -or -not (Test-Path $appEnv)) { $appEnv = '' }
  $want = @("releases=$($Versions -join ' ')", "goal=$Goal", "split=$Split", "app_port=$AppPort", "env_file=$appEnv")
  if ($BrowserSpeed) { $want += 'browser_speed=1' }
  $argsFile = Join-Path $State 'compare.args'
  $old = if (Test-Path $argsFile) { @(Get-Content $argsFile | Where-Object { $_ -notlike '*_port=*' -or $_ -like 'app_port=*' }) } else { $null }
  if ($old -and (($old -join "`n") -eq ($want -join "`n"))) {
    Read-Args | Out-Null
    Say "Resuming ${Name}: $Title ($Kind test)."
  } else {
    if ($old) {
      # A running experiment keeps its split and its main metric (Flagsmith fixes it at creation), so different
      # versions or settings need a new experiment, from scratch.
      Say "Different versions or settings start a new experiment: the previous one's data is discarded."
      Compose --profile sim down -v *> $null
      Get-ChildItem -Force $State | Remove-Item -Recurse -Force
    }
    $script:ProxyPort = Get-FreePort 8080
    $script:ConsolePort = Get-FreePort 8090 @($ProxyPort)
    $fsPort = Get-FreePort 8000 @($ProxyPort, $ConsolePort)
    if ($ProxyPort -ne 8080) { Say "Port 8080 is busy: your app will be on $ProxyPort." }
    $newArgs = @('run', '--rm', '-v', "${State}:/work", $Image, 'new', '--dir', '/work', '--yes', '--force',
      '--success', $Goal, '--traffic', $Traffic,
      '--proxy-port', $ProxyPort, '--console-port', $ConsolePort, '--flagsmith-port', $fsPort, '--image', $Image)
    foreach ($v in $Versions) { $newArgs += @('--release', $v) }
    if ($AppPort) { $newArgs += @('--port', $AppPort) }
    if ($BrowserSpeed) { $newArgs += '--browser-speed' }
    if ($appEnv) { $newArgs += @('--app-env-file', $appEnv); Say "Your app's settings: $appEnv (passed to every version)." }
    docker @newArgs *> (Join-Path $State 'new.log')
    if ($LASTEXITCODE -ne 0) { Get-Content (Join-Path $State 'new.log'); Die "couldn't write the setup for $Title." }
    Say "$Kind test: A is $($Versions[0]), what everyone gets now; $(if ($Traffic -eq '100') { 'every visitor is split evenly between the versions' } else { "each new version gets $Split% of visitors" })."
    Set-Content -Encoding ascii $argsFile ($want + @("proxy_port=$ProxyPort", "console_port=$ConsolePort"))
  }
  if ($script:Branches) {
    # Start the branch builds first and give them a few seconds: a crash shows now, before Flagsmith's set-up.
    Step 'Starting the branches'
    $apps = Get-AppServices
    Compose up -d @apps *> (Join-Path $State 'apps.log')
    if ($LASTEXITCODE -ne 0) { Get-Content (Join-Path $State 'apps.log') -Tail 20; Die "couldn't start the branches." }
    Start-Sleep 8
    $crashed = @(Get-CrashedApps)
    if ($crashed.Count) { Show-AppLogs $crashed; Compose down *> $null; Die $NotAnswering }
  }
  Step 'Starting Flagsmith and Turnout (the first time takes a few minutes)'
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

# The separate Demo (simulated) environment in Flagsmith, set up once, and the given services. Returns its console port.
function Start-Sim([string[]]$services) {
  $envFile = Join-Path $State '.env'
  $real = (Get-Content $envFile | Where-Object { $_ -like 'TURNOUT_EXPERIMENT=*' }) -replace '^TURNOUT_EXPERIMENT=([^/]*)/.*$', '$1'
  if (-not $real) { Die "run turnout compare first: there's no experiment yet." }
  New-Item -ItemType Directory -Force (Join-Path $State '.turnout\sim') | Out-Null
  $simEnv = Join-Path $State '.turnout\sim.env'
  if (-not (Test-Path $simEnv)) { Get-Content $envFile | Where-Object { $_ -match '^(TURNOUT_ADMIN_KEY|TURNOUT_PREVIEW_TOKEN)=' } | Set-Content -Encoding ascii $simEnv }
  Step 'Setting up the separate Demo environment in Flagsmith (once)'
  $log = Join-Path $State 'sim-setup.log'
  Compose run --rm -e TURNOUT_ENV_FILE=.turnout/sim.env -e "TURNOUT_REAL_ENV_KEY=$real" cli sim-setup *> $log
  if ($LASTEXITCODE -ne 0) { Get-Content $log -Tail 20; Die "setting up the Demo environment failed (full log: $log)." }
  $argsFile = Join-Path $State 'compare.args'
  $simPort = (Get-Content $argsFile | Where-Object { $_ -like 'sim_console_port=*' }) -replace '^sim_console_port=', ''
  if (-not $simPort) { $simPort = Get-FreePort 8099 @([int]$ProxyPort, [int]$ConsolePort); Add-Content -Encoding ascii $argsFile "sim_console_port=$simPort" }
  $env:TURNOUT_SIM_CONSOLE_PORT = $simPort
  $log = Join-Path $State 'sim-up.log'
  Compose --profile sim up -d --wait @services *> $log
  if ($LASTEXITCODE -ne 0) { Get-Content $log -Tail 20; Die "starting the simulation failed (full log: $log)." }
  return $simPort
}

# Real-browser visits: page speed measured in headless Chrome, scored by Flagsmith in the Demo environment.
function Invoke-Browsers([string[]]$a) {
  Show-Logo
  $lines = Read-Args; Need-Docker
  $visits = '100'; $extra = @()
  for ($i = 0; $i -lt $a.Count; $i++) {
    switch ($a[$i]) {
      '--visits' { $visits = $a[$i + 1]; $i++ }
      { $_ -in '--path', '--latency', '--lanes' } { $extra += @($a[$i], $a[$i + 1]); $i++ }
      default { Die "unknown option $($a[$i])" }
    }
  }
  if (-not (Select-String -Quiet -Pattern '^  chrome:' (Join-Path $State 'turnout.compose.yml'))) {
    Die 'this setup was made before turnout browsers: run turnout compare again with --browser-speed (a new experiment).'
  }
  if (-not (Select-String -Quiet -Pattern 'lcp_ms|cls' (Join-Path $State 'turnout.config.yml'))) {
    Say "Note: page speed in the browser isn't measured without --browser-speed (turnout compare ... --browser-speed); the visits still count."
  }
  $simPort = Start-Sim @('turnout-sim', 'console-sim', 'chrome')
  Compose --progress quiet run --rm -e TURNOUT_ENV_FILE=.turnout/sim.env cli browsers --visits $visits @extra 2>&1 | ForEach-Object { "$_" }
  if ($LASTEXITCODE -ne 0) { Die 'the browser visits stopped (see above).' }
  Say ''
  Say "  Results (Demo environment, never your real experiment):  http://127.0.0.1:$simPort"
  Say '  Flagsmith recomputes results at most every 5 minutes. Run turnout browsers again for more visits.'
  Start-Process "http://127.0.0.1:$simPort"
}

# turnout uninstall: every Turnout project's containers and data (this checkout's demo and each turnout compare
# project), Try it's containers, the turnout:local image, Turnout's state folder, the PATH entry, and a downloaded
# release. Lists it all first and asks; --dry-run only lists; --yes doesn't ask. Flagsmith's and Postgres' images stay.
function Invoke-Uninstall([string[]]$a) {
  $dry = $a -contains '--dry-run'; $yes = $a -contains '--yes'
  # Works without Docker too: then only Turnout's own files, its PATH entry and a downloaded release are removed.
  $docker = if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { 'missing' } else { docker info *> $null; if ($LASTEXITCODE -eq 0) { 'up' } else { 'down' } }
  $projects = @(); $demoHere = $false
  # Containers of this checkout's demo (its folder) or of a compare project (under the state folder), by Compose's labels.
  $rows = if ($docker -eq 'up') { docker ps -a --format '{{json .}}' 2>$null } else { @() }
  foreach ($row in @($rows)) {
    if (-not $row) { continue }
    $labels = @{}
    foreach ($kv in (($row | ConvertFrom-Json).Labels -split ',')) { $k, $v = $kv -split '=', 2; if ($k) { $labels[$k] = $v } }
    $proj = $labels['com.docker.compose.project']; $dir = $labels['com.docker.compose.project.working_dir']
    if (-not $proj -or -not $dir) { continue }
    $d = $dir.TrimEnd('\')
    if ($d -ieq $HomeDir.TrimEnd('\')) { $projects += $proj; $demoHere = $true }
    elseif ($d -like "$($StateRoot.TrimEnd('\'))\*") { $projects += $proj }
  }
  if ($docker -eq 'up') { foreach ($s in (Get-ChildItem $StateRoot -Directory -ErrorAction SilentlyContinue)) { $projects += "turnout-$($s.Name)" } }
  $projects = @($projects | Sort-Object -Unique)
  # Try it's containers aren't labelled with the checkout that made them: only with this checkout's own demo stack.
  $tryit = if ($demoHere) { @(docker ps -aq --filter label=turnout.tryit=1 2>$null | Where-Object { $_ }) } else { @() }
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $bin = Join-Path $HomeDir 'bin'
  $onPath = @($userPath -split ';') -contains $bin
  $downloads = if ($env:TURNOUT_INSTALL_DIR) { $env:TURNOUT_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'turnout' }
  $downloaded = $HomeDir -like "$($downloads.TrimEnd('\'))\*"
  $stateHome = Split-Path -Parent $StateRoot

  Say 'turnout uninstall removes:'
  if ($docker -eq 'missing') { Say "  - nothing in Docker: it isn't installed" }
  elseif ($docker -eq 'down') { Say "  ! Docker isn't running, so Turnout's containers and data in it can't be removed now. To remove them as well, answer no, start Docker and run turnout uninstall again; otherwise they stay (Docker Desktop's Containers page can delete them later)." }
  elseif ($projects) { foreach ($p in $projects) { Say "  - Docker project ${p}: its containers, networks and data (Flagsmith's database, results, the release history)" } }
  else { Say '  - no Turnout containers' }
  if ($tryit) { Say "  - $($tryit.Count) Try it container(s) and their network" }
  if ($docker -eq 'up') { Say '  - the turnout:local image (unless another container still uses it)' }
  if (Test-Path $stateHome) { Say "  - Turnout's files: $stateHome" }
  if ($onPath) { Say "  - $bin from your user PATH" }
  if ($downloaded) { Say "  - the downloaded release: $HomeDir" } else { Say "  (This checkout, $HomeDir, stays: delete the folder yourself if you want it gone.)" }
  if ($dry) { Say ''; Say '--dry-run: nothing removed.'; return }
  if (-not $yes -and (Read-Host 'Remove all of this? It cannot be undone. [y/N]') -ne 'y') { Say 'Nothing removed.'; return }

  foreach ($p in $projects) {
    docker compose -p $p down -v --remove-orphans *> $null
    foreach ($v in @(docker volume ls -q --filter "label=com.docker.compose.project=$p" 2>$null)) { if ($v) { docker volume rm $v *> $null } }
    Say "  removed $p"
  }
  if ($tryit) { docker rm -f @tryit *> $null; docker network prune -f --filter label=turnout.tryit=1 *> $null; Say '  removed Try it containers' }
  if ($docker -eq 'up') { docker image rm turnout:local *> $null }
  if (Test-Path $stateHome) { Remove-Item -Recurse -Force $stateHome; Say "  removed $stateHome" }
  if ($onPath) {
    [Environment]::SetEnvironmentVariable('Path', ((@($userPath -split ';') | Where-Object { $_ -and $_ -ne $bin }) -join ';'), 'User')
    Say "  removed $bin from your user PATH (new terminals)"
  }
  if ($downloaded) { Remove-Item -Recurse -Force $HomeDir; Say "  removed $HomeDir" }
  Say 'Turnout is uninstalled.'
}

function Invoke-Simulate([string[]]$a) {
  Show-Logo
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
  $simPort = Start-Sim @('turnout-sim', 'console-sim')
  Compose --progress quiet run --rm -e TURNOUT_ENV_FILE=.turnout/sim.env cli simulate --visitors $visitors 2>&1 | ForEach-Object { "$_" }
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
  'browsers' { Invoke-Browsers $rest }
  'uninstall' { Invoke-Uninstall $rest }
  'demo' {
    Need-Docker
    $what = if ($rest.Count) { $rest[0] } else { 'start' }   # start (opens guided demo), or: stop, status, reset
    Push-Location $HomeDir; try { & cmd /c "turnout.bat $what" } finally { Pop-Location }
  }
  'update' { Push-Location $HomeDir; try { git pull --ff-only; if ($LASTEXITCODE -eq 0) { Say 'Up to date. The next turnout compare or turnout demo uses it.' } } finally { Pop-Location } }
  'results' { Read-Args | Out-Null; Need-Docker; Compose --progress quiet run --rm cli status }
  'ship' { Read-Args | Out-Null; Need-Docker; if ($rest.Count) { Compose --progress quiet run --rm -it cli ship --winner $rest[0] } else { Compose --progress quiet run --rm -it cli ship } }
  'revert' { Read-Args | Out-Null; Need-Docker; Compose --progress quiet run --rm -it cli revert }
  'logs' { Read-Args | Out-Null; Need-Docker; $svc = if ($rest.Count) { $rest[0] } else { '' }; if ($svc -eq 'proxy') { $svc = 'turnout' }; if ($svc) { Compose logs -f --tail 50 $svc } else { Compose logs -f --tail 50 } }
  { $_ -in 'version', '--version', '-v' } { Say "turnout $(Get-Version)" }
  'open' { Read-Args | Out-Null; Start-Process "http://127.0.0.1:$ConsolePort"; Show-Banner }
  'status' { Read-Args | Out-Null; Need-Docker; Compose ps; Compose --progress quiet run --rm cli doctor | Select-Object -Last 1 }
  'down' { Read-Args | Out-Null; Need-Docker; Step "Stopping $Name"; Compose --profile sim down *> $null; Say 'Stopped. turnout compare with the same arguments starts it again, with its data.' }
  'reset' {
    Read-Args | Out-Null; Need-Docker
    if ($rest -notcontains '--yes') { $ok = Read-Host "Delete $Name's Turnout and Flagsmith data? [y/N]"; if ($ok -ne 'y') { exit 1 } }
    Step "Removing $Name's containers and data"; Compose --profile sim down -v *> $null; Remove-Item -Recurse -Force $State; Say 'Wiped. turnout compare starts fresh.'
  }
  { $_ -in 'help', '-h', '--help' } { Show-Help }
  default { Show-Help; [Console]::Error.WriteLine("`nturnout: unknown command `"$cmd`" (the commands are above)."); exit 2 }
}
