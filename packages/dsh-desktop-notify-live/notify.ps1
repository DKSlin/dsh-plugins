param(
  [Parameter(Mandatory = $true)][string]$Title,
  [Parameter(Mandatory = $true)][string]$Body,
  [string]$AppId = 'com.deepseek.dsh',
  [string]$Icon = '',
  [string]$SoundFile = '',
  [string]$AppExe = '',
  [switch]$SkipWhenFocused,
  [switch]$NoSound
)

$ErrorActionPreference = 'Stop'

# Optional: stay silent while the Harness window itself is in the foreground.
if ($SkipWhenFocused -and $AppExe) {
  try {
    if (-not ('DshNotify.Native' -as [type])) {
      Add-Type -Namespace DshNotify -Name Native -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern System.IntPtr GetForegroundWindow();
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern uint GetWindowThreadProcessId(System.IntPtr hWnd, out uint pid);
'@
    }
    $hwnd = [DshNotify.Native]::GetForegroundWindow()
    $fgPid = [uint32]0
    [void][DshNotify.Native]::GetWindowThreadProcessId($hwnd, [ref]$fgPid)
    if ($fgPid -ne 0) {
      $fg = Get-Process -Id $fgPid -ErrorAction SilentlyContinue
      if ($fg -and $fg.Path -and ([System.IO.Path]::GetFullPath($fg.Path) -ieq [System.IO.Path]::GetFullPath($AppExe))) {
        exit 0
      }
    }
  } catch {
    # Focus detection is best-effort; never suppress the notification on error.
  }
}

$null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
$null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]

$safeTitle = [System.Security.SecurityElement]::Escape($Title)
$safeBody = [System.Security.SecurityElement]::Escape($Body)
$logo = ''
if ($Icon -and (Test-Path -LiteralPath $Icon)) {
  try {
    $uri = ([System.Uri]$Icon).AbsoluteUri
    $logo = '<image placement="appLogoOverride" hint-crop="none" src="' + [System.Security.SecurityElement]::Escape($uri) + '"/>'
  } catch {
    $logo = ''
  }
}

$xmlText = '<toast><visual><binding template="ToastGeneric"><text>' + $safeTitle + '</text><text>' + $safeBody + '</text>' + $logo + '</binding></visual><audio silent="true" /></toast>'

$shown = $false
try {
  $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
  $xml.LoadXml($xmlText)
  $toast = New-Object Windows.UI.Notifications.ToastNotification $xml
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($AppId).Show($toast)
  $shown = $true
} catch {
  Write-Error ('toast failed: ' + $_.Exception.Message)
}

# Lightweight receipt: one line per invocation makes it easy to tell "the Host
# never called the helper" apart from "Windows suppressed the banner".
try {
  $log = Join-Path $env:TEMP 'dsh-desktop-notify.log'
  ('{0:o} | shown={1} | {2} | {3}' -f (Get-Date), $shown, $safeTitle, $safeBody) |
    Add-Content -LiteralPath $log -Encoding UTF8
} catch { }

# The toast itself is muted, so the ding is guaranteed even when notification
# audio is disabled. Played after the toast so the sound follows the banner.
$candidates = @()
if (-not $NoSound) {
  if ($SoundFile) { $candidates += $SoundFile }
  $candidates += (Join-Path $env:WINDIR 'Media\Windows Notify System Generic.wav')
  $candidates += (Join-Path $env:WINDIR 'Media\notify.wav')
  $candidates += (Join-Path $env:WINDIR 'Media\ding.wav')
  $wav = $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
  if ($wav) {
    try {
      $player = New-Object System.Media.SoundPlayer $wav
      $player.PlaySync()
    } catch {
      [System.Media.SystemSounds]::Asterisk.Play()
    }
  } else {
    [System.Media.SystemSounds]::Asterisk.Play()
  }
}

if (-not $shown) { exit 1 }
exit 0
