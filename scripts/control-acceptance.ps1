param([Parameter(Mandatory=$true)][string]$Profile,
      [Parameter(Mandatory=$true)][ValidateSet('sourceModel','prepare','status','send','attach','stop')][string]$Command,
      [string]$InputFile)
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
$profilePath = [IO.Path]::GetFullPath($Profile).ToLowerInvariant()
$sha = [Security.Cryptography.SHA256]::Create()
$hash = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($profilePath)))).Replace('-','').ToLowerInvariant()
$name = 'nex-acceptance-' + $hash.Substring(0,24)
$request = @{command=$Command}
if ($Command -ne 'sourceModel') {
  if (-not $InputFile) { throw 'InputFile is required' }
  $request.args = ConvertFrom-Json -InputObject ([IO.File]::ReadAllText([IO.Path]::GetFullPath($InputFile), [Text.Encoding]::UTF8))
}
$pipe = [IO.Pipes.NamedPipeClientStream]::new('.', $name, [IO.Pipes.PipeDirection]::InOut)
try {
  $pipe.Connect(10000)
  $writer = [IO.StreamWriter]::new($pipe, [Text.UTF8Encoding]::new($false),65536,$true)
  $writer.AutoFlush=$true
  $reader = [IO.StreamReader]::new($pipe, [Text.UTF8Encoding]::new($false),$false,65536,$true)
  $writer.WriteLine(($request | ConvertTo-Json -Depth 30 -Compress))
  $task = $reader.ReadLineAsync()
  if (-not $task.Wait(35000)) { throw 'Acceptance command timed out; inspect scope before retrying' }
  [Console]::WriteLine($task.Result)
} finally { $pipe.Dispose(); $sha.Dispose() }
