$ErrorActionPreference = 'Stop'

function Write-JsonUtf8([object] $Value) {
  $json = $Value | ConvertTo-Json -Compress -Depth 100
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
  $stream = [Console]::OpenStandardOutput()
  $stream.Write($bytes, 0, $bytes.Length)
  $stream.Flush()
}

try {
  $reader = [System.IO.StreamReader]::new(
    [Console]::OpenStandardInput(),
    [System.Text.UTF8Encoding]::new($false)
  )
  $rawInput = $reader.ReadToEnd()
  $payload = $rawInput | ConvertFrom-Json
  $method = [string]$payload.method
  if ($method -ne 'GET' -and $method -ne 'POST') {
    throw 'method must be GET or POST'
  }

  $pipeName = [string]$payload.socketPath
  $pipePrefix = '\\.\pipe\'
  if ($pipeName.StartsWith($pipePrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    $pipeName = $pipeName.Substring($pipePrefix.Length)
  }
  if ([string]::IsNullOrWhiteSpace($pipeName)) {
    throw 'Tailscale named pipe path is empty'
  }

  $timeoutMs = if ($null -ne $payload.timeoutMs) {
    [Math]::Max(1, [int]$payload.timeoutMs)
  } else {
    10000
  }
  $body = if ($method -eq 'POST') { [string]$payload.body } else { '' }
  $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($body)
  $headerLines = [System.Collections.Generic.List[string]]::new()
  [void]$headerLines.Add("$method /localapi/v0/serve-config HTTP/1.1")
  [void]$headerLines.Add('Host: local-tailscaled.sock')
  [void]$headerLines.Add('Accept: application/json')
  [void]$headerLines.Add('Connection: close')
  if ($method -eq 'POST') {
    [void]$headerLines.Add('Content-Type: application/json')
    [void]$headerLines.Add("Content-Length: $($bodyBytes.Length)")
  }
  $etag = [string]$payload.etag
  if ($etag -match '[\r\n]') {
    throw 'invalid ETag header'
  }
  if (-not [string]::IsNullOrEmpty($etag)) {
    [void]$headerLines.Add("If-Match: $etag")
  }
  $requestHead = (($headerLines -join "`r`n") + "`r`n`r`n")
  $headBytes = [System.Text.Encoding]::ASCII.GetBytes($requestHead)
  $requestBytes = New-Object byte[] ($headBytes.Length + $bodyBytes.Length)
  [System.Buffer]::BlockCopy($headBytes, 0, $requestBytes, 0, $headBytes.Length)
  if ($bodyBytes.Length -gt 0) {
    [System.Buffer]::BlockCopy($bodyBytes, 0, $requestBytes, $headBytes.Length, $bodyBytes.Length)
  }

  $pipe = [System.IO.Pipes.NamedPipeClientStream]::new(
    '.',
    $pipeName,
    [System.IO.Pipes.PipeDirection]::InOut,
    [System.IO.Pipes.PipeOptions]::None,
    [System.Security.Principal.TokenImpersonationLevel]::Identification,
    [System.IO.HandleInheritability]::None
  )
  try {
    $pipe.Connect($timeoutMs)
    $pipe.Write($requestBytes, 0, $requestBytes.Length)
    $pipe.Flush()
    $buffer = New-Object byte[] 8192
    $response = [System.IO.MemoryStream]::new()
    $deadline = [DateTime]::UtcNow.AddMilliseconds($timeoutMs)
    try {
      while ($true) {
        $remainingMs = ($deadline - [DateTime]::UtcNow).TotalMilliseconds
        if ($remainingMs -le 0) {
          throw 'Tailscale LocalAPI response timed out'
        }
        $remaining = [int][Math]::Max(1, $remainingMs)
        $readTask = $pipe.ReadAsync($buffer, 0, $buffer.Length)
        if (-not $readTask.Wait($remaining)) {
          throw 'Tailscale LocalAPI response timed out'
        }
        $count = $readTask.Result
        if ($count -le 0) { break }
        $response.Write($buffer, 0, $count)
      }
      $responseBytes = $response.ToArray()
    } finally {
      $response.Dispose()
    }
  } finally {
    $pipe.Dispose()
  }

  Write-JsonUtf8 ([pscustomobject]@{
    ok = $true
    responseBase64 = [Convert]::ToBase64String($responseBytes)
  })
} catch {
  $exception = $_.Exception
  $code = $null
  if ($exception.HResult -ne 0) {
    $code = [string]$exception.HResult
  }
  Write-JsonUtf8 ([pscustomobject]@{
    ok = $false
    status = $null
    error = $exception.Message
    code = $code
  })
  exit 1
}
