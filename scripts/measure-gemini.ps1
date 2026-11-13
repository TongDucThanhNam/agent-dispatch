param(
  [Parameter(Mandatory=$true)][int]$OwnerPid,
  [Parameter(Mandatory=$true)][string]$Executable,
  [Parameter(Mandatory=$true)][string]$PhaseFile,
  [Parameter(Mandatory=$true)][string]$StopFile,
  [ValidateRange(500,5000)][int]$IntervalMs = 1000,
  [ValidateRange(60,7200)][int]$MaxSeconds = 1800
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$owner = Get-Process -Id $OwnerPid
if (-not [string]::Equals($owner.Path, $Executable, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected Gemini owner executable.' }
$null = $owner.Handle # Retain a process handle so an exit code remains observable.
$watch = [Diagnostics.Stopwatch]::StartNew()
$previous = @{}
$initial = $true
while ($watch.Elapsed.TotalSeconds -lt $MaxSeconds -and -not (Test-Path -LiteralPath $StopFile)) {
  if ($owner.HasExited) {
    [pscustomobject]@{event='owner-exit';at=[DateTimeOffset]::UtcNow.ToString('o');pid=$OwnerPid;exitCode=$owner.ExitCode;elapsedMs=$watch.ElapsedMilliseconds} | ConvertTo-Json -Compress
    exit 1
  }
  $phase = Get-Content -LiteralPath $PhaseFile -Raw | ConvertFrom-Json
  $rows = @()
  $delta = 0.0
  $skipped = 0
  foreach ($process in (Get-Process -Name Gemini)) {
    try {
      if (-not [string]::Equals($process.Path, $Executable, [StringComparison]::OrdinalIgnoreCase)) { continue }
      $key = "$($process.Id):$($process.StartTime.ToUniversalTime().Ticks)"
      $cpu = [double]$process.CPU
      if ($previous.ContainsKey($key)) { $delta += [Math]::Max(0, $cpu - $previous[$key]) }
      elseif (-not $initial) { $delta += $cpu }
      $previous[$key] = $cpu
      $rows += [pscustomobject]@{pid=$process.Id;privateMB=$process.PrivateMemorySize64 / 1MB;workingMB=$process.WorkingSet64 / 1MB;handles=$process.HandleCount;cpuSeconds=$cpu}
    } catch {
      if ($process.HasExited) { $skipped++; continue }
      throw
    }
  }
  $root = $rows | Where-Object pid -eq $OwnerPid
  if (-not $root) { throw 'Gemini owner disappeared during sampling.' }
  [pscustomobject]@{
    event='sample';at=[DateTimeOffset]::UtcNow.ToString('o');elapsedMs=$watch.ElapsedMilliseconds
    phase=$phase.phase;case=$phase.case;ownerPid=$OwnerPid;processCount=$rows.Count;skippedExited=$skipped
    privateMB=($rows | Measure-Object privateMB -Sum).Sum;workingMB=($rows | Measure-Object workingMB -Sum).Sum
    handles=($rows | Measure-Object handles -Sum).Sum;rootPrivateMB=$root.privateMB;rootHandles=$root.handles
    cpuDeltaSeconds=$delta;processes=$rows
  } | ConvertTo-Json -Compress -Depth 4
  $initial = $false
  Start-Sleep -Milliseconds $IntervalMs
}
if ($watch.Elapsed.TotalSeconds -ge $MaxSeconds) { throw 'Gemini sampler reached its time limit.' }
