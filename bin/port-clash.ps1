# After a failed start (turnout.bat): is another Docker project holding Turnout's ports (another Turnout, Flagsmith or
# anything else)? Prints who and the fix, and exits 1; exits 0 and prints nothing when the ports are free or held by
# this folder's own containers.
param([string]$Here = (Get-Location).Path)
$Here = [IO.Path]::GetFullPath($Here).TrimEnd('\')
$held = @()
foreach ($p in 8000, 8080, 8090, 8091) {
  # {{json .}}: no quotes inside the template (Windows PowerShell 5.1 strips them from a native command's arguments).
  $rows = docker ps --filter "publish=$p" --format '{{json .}}' 2>$null
  foreach ($row in @($rows)) {
    if (-not $row) { continue }
    $c = $row | ConvertFrom-Json
    $labels = @{}
    foreach ($kv in ($c.Labels -split ',')) { $k, $v = $kv -split '=', 2; if ($k) { $labels[$k] = $v } }
    $proj = $labels['com.docker.compose.project']; $dir = $labels['com.docker.compose.project.working_dir']; $name = $c.Names
    if ($dir -and ($dir.TrimEnd('\') -ieq $Here)) { continue }
    $held += [pscustomobject]@{ Port = $p; Project = $proj; Dir = $dir; Name = $name }
  }
}
if (-not $held) { exit 0 }
foreach ($h in $held) {
  $from = if ($h.Project) { " (Compose project `"$($h.Project)`"$(if ($h.Dir) { ", from $($h.Dir)" }))" } else { '' }
  Write-Host " Port $($h.Port) is already used by the Docker container $($h.Name)$from."
}
foreach ($proj in ($held | Where-Object { $_.Project } | ForEach-Object { $_.Project } | Sort-Object -Unique)) {
  Write-Host " Stop it first (its data is kept):  docker compose -p $proj down"
}
exit 1
