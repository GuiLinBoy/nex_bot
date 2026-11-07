param([Parameter(Mandatory=$true)][ValidatePattern('^nex-acceptance-[a-f0-9]{24}$')][string]$PipeName)
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$security = [IO.Pipes.PipeSecurity]::new()
$security.SetAccessRuleProtection($true, $false)
$security.SetOwner($sid)
$security.AddAccessRule([IO.Pipes.PipeAccessRule]::new($sid, [IO.Pipes.PipeAccessRights]::FullControl, [Security.AccessControl.AccessControlType]::Allow))
$announced = $false
while ($true) {
  $pipe = $null
  try {
    $pipe = [IO.Pipes.NamedPipeServerStream]::new($PipeName, [IO.Pipes.PipeDirection]::InOut, 1, [IO.Pipes.PipeTransmissionMode]::Byte, [IO.Pipes.PipeOptions]::Asynchronous, 65536, 65536, $security)
    if (-not $announced) { [Console]::WriteLine('{"type":"ready","currentUserOnly":true}'); $announced=$true }
    $pipe.WaitForConnection()
    $reader = [IO.StreamReader]::new($pipe, [Text.UTF8Encoding]::new($false), $false, 65536, $true)
    $writer = [IO.StreamWriter]::new($pipe, [Text.UTF8Encoding]::new($false), 65536, $true)
    $writer.AutoFlush = $true
    $read = $reader.ReadLineAsync()
    if (-not $read.Wait(15000)) { throw 'Read timeout' }
    $line = $read.Result
    if (-not $line -or $line.Length -gt 8000000) { throw 'Invalid request size' }
    # Data only. Node validates the fixed command enum; this helper never evals.
    $null = ConvertFrom-Json -InputObject $line
    [Console]::WriteLine($line)
    $reply = [Console]::ReadLine()
    if (-not $reply) { break }
    $writer.WriteLine($reply)
  } catch {
    if (-not $announced) { [Console]::Error.WriteLine('Pipe initialization failed'); exit 1 }
    if ($writer -and $pipe -and $pipe.IsConnected) { try { $writer.WriteLine('{"ok":false,"error":"Invalid local request"}') } catch {} }
  } finally {
    if ($pipe) { $pipe.Dispose() }
  }
}
