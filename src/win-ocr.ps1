param([string]$ImagePath, [string]$Language = 'auto')

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Storage.FileAccessMode, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Media.Ocr, ContentType = WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]

function Await-Operation($AsyncOperation, [type]$ResultType) {
  $method = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -like 'IAsyncOperation*'
  } | Select-Object -First 1).MakeGenericMethod($ResultType)
  $task = $method.Invoke($null, @($AsyncOperation))
  $task.Wait()
  return $task.Result
}

$file = Await-Operation ([Windows.Storage.StorageFile]::GetFileFromPathAsync($ImagePath)) ([Windows.Storage.StorageFile])
$stream = Await-Operation ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
try {
  $decoder = Await-Operation ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await-Operation ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  try {
    function New-OcrEngine([string]$Tag) {
      if (!$Tag -or $Tag -eq 'auto') {
        return [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
      }
      try {
        $lang = [Windows.Globalization.Language]::new($Tag)
        return [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
      } catch {
        return $null
      }
    }

    $candidates = New-Object System.Collections.Generic.List[string]
    if ($Language -and $Language -ne 'auto') {
      $candidates.Add($Language)
      $candidates.Add('auto')
    } else {
      # Auto mode on non-Chinese Windows profiles often returns empty for CJK text.
      # Try common CJK + English engines if the language packs are installed.
      foreach ($tag in @('auto', 'zh-Hans-CN', 'zh-Hant-TW', 'en-US', 'ja-JP', 'ko-KR')) {
        $candidates.Add($tag)
      }
    }

    $bestText = ''
    foreach ($tag in $candidates) {
      $engine = New-OcrEngine $tag
      if ($null -eq $engine) { continue }
      $result = Await-Operation ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
      $text = [string]$result.Text
      if ($text.Trim().Length -gt $bestText.Trim().Length) {
        $bestText = $text
      }
      if ($Language -and $Language -ne 'auto' -and $bestText.Trim().Length -gt 0) {
        break
      }
    }

    if ($bestText.Trim().Length -eq 0) {
      # Last chance: user profile engine, so callers can distinguish "no text"
      # from a missing OCR runtime.
      $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
      if ($null -eq $engine) { throw 'No Windows OCR language is available.' }
    }
    Write-Output $bestText
  } finally {
    if ($bitmap) { $bitmap.Dispose() }
  }
} finally {
  if ($stream) { $stream.Dispose() }
}
