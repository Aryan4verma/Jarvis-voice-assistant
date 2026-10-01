param([ValidateSet('Protect', 'Unprotect')][string]$Action,
      [ValidateSet('openrouter', 'elevenlabs', 'picovoice')][string]$Purpose = 'openrouter')
$ErrorActionPreference = 'Stop'
$protectedBytes = $null
$plainBytes = $null
try {
  Add-Type -AssemblyName System.Security
  $inputBytes = [Convert]::FromBase64String([Console]::In.ReadToEnd())
  # Preserve the original OpenRouter entropy so existing keys remain readable.
  $label = @{openrouter='OpenRouter'; elevenlabs='ElevenLabs'; picovoice='Picovoice'}[$Purpose]
  $entropy = [Text.Encoding]::UTF8.GetBytes("JarvisAI.$label.v1")
  if ($Action -eq 'Protect') {
    $plainBytes = $inputBytes
    $protectedBytes = [Security.Cryptography.ProtectedData]::Protect($plainBytes, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    [Console]::Out.Write([Convert]::ToBase64String($protectedBytes))
  } else {
    $protectedBytes = $inputBytes
    $plainBytes = [Security.Cryptography.ProtectedData]::Unprotect($protectedBytes, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    [Console]::Out.Write([Convert]::ToBase64String($plainBytes))
  }
} catch {
  # Never print exception objects, input, or decrypted bytes.
  exit 1
} finally {
  if ($null -ne $plainBytes) { [Array]::Clear($plainBytes, 0, $plainBytes.Length) }
}
