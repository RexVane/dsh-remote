$ErrorActionPreference = 'Stop'
$pipeName = 'ProtectedPrefix\Administrators\Tailscale\tailscaled'
$pipe = [System.IO.Pipes.NamedPipeClientStream]::new(
  '.',
  $pipeName,
  [System.IO.Pipes.PipeDirection]::InOut,
  [System.IO.Pipes.PipeOptions]::None,
  [System.Security.Principal.TokenImpersonationLevel]::Identification,
  [System.IO.HandleInheritability]::None
)
$pipe.Connect(10000)
$request = "GET /localapi/v0/serve-config HTTP/1.1`r`nHost: local-tailscaled.sock`r`nAccept: application/json`r`nConnection: close`r`n`r`n"
$bytes = [System.Text.Encoding]::ASCII.GetBytes($request)
$pipe.Write($bytes, 0, $bytes.Length)
$pipe.Flush()
$buffer = New-Object byte[] 4096
$out = New-Object System.IO.MemoryStream
while (($n = $pipe.Read($buffer, 0, $buffer.Length)) -gt 0) { $out.Write($buffer, 0, $n) }
[System.Text.Encoding]::UTF8.GetString($out.ToArray())
$pipe.Dispose()
