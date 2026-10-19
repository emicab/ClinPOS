; Hooks del instalador NSIS de ClinPOS.
;
; El servidor local corre como node.exe dentro de $INSTDIR\_up_\app_standalone.
; Si queda vivo (huérfano de una versión vieja, o el updater no alcanzó a
; cerrarlo), Windows tiene node.exe/DLL de Prisma bloqueados y el instalador no
; puede reemplazarlos. Antes de copiar archivos se cierran los node.exe que
; viven dentro de la carpeta de instalación (nunca otros node.exe del equipo).
!macro NSIS_HOOK_PREINSTALL
  DetailPrint "Cerrando el servidor local de ClinPOS..."
  nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith('$INSTDIR', [System.StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"`
  Pop $0
  Sleep 1500
!macroend
