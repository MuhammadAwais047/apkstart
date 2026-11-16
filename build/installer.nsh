; ApkStart custom NSIS script
; Purpose: before uninstall starts, stop runtime processes that may still linger in the background,
; otherwise they lock files in the install dir, so uninstall leaves residue and even third-party shredders cannot delete it.
;
; After ApkStart exits a detached qemu may still remain (so the next start is instant),
; so the uninstall step must clean up after itself.

; Install finish: add one more layer for the desktop icon.
; electron-builder's createDesktopShortcut uses its own CreateShortcuts flow,
; which fails in some environments (desktop redirected by OneDrive, shortcut rolled back by security software)
; and the user ends up with nothing on the desktop. Here NSIS's native CreateShortcut writes it again:
; $DESKTOP goes through SHGetFolderPath, so it follows a redirected desktop path; written as an idempotent operation,
; repeated execution alongside electron-builder just overwrites the same .lnk.
!macro customInstall
  DetailPrint "Creating desktop shortcut…"
  CreateShortcut "$DESKTOP\ApkStart.lnk" "$INSTDIR\ApkStart.exe" "" "$INSTDIR\ApkStart.exe" 0 \
    SW_SHOWNORMAL "" "ApkStart — run Android apps right on your PC"
  CreateDirectory "$SMPROGRAMS\ApkStart"
  CreateShortcut "$SMPROGRAMS\ApkStart\ApkStart.lnk" "$INSTDIR\ApkStart.exe" "" "$INSTDIR\ApkStart.exe" 0 \
    SW_SHOWNORMAL "" "ApkStart — run Android apps right on your PC"
!macroend

!macro customUnInstall
  ; Remove the shortcut entries we wrote first (nothing should remain even when ApkStart is not installed)
  Delete "$DESKTOP\ApkStart.lnk"
  Delete "$SMPROGRAMS\ApkStart\ApkStart.lnk"
  RMDir "$SMPROGRAMS\ApkStart"

  DetailPrint "Stopping leftover ApkStart processes…"
  ; /F force kill /T includes child processes. taskkill returns 128 when the process is gone; ignore it.
  nsExec::Exec 'taskkill.exe /F /T /IM ApkStart.exe'
  nsExec::Exec 'taskkill.exe /F /T /IM qemu-system-x86_64.exe'
  nsExec::Exec 'taskkill.exe /F /T /IM qemu-system-i386.exe'
  nsExec::Exec 'taskkill.exe /F /T /IM emulator.exe'
  nsExec::Exec 'taskkill.exe /F /T /IM emulator-check.exe'
  nsExec::Exec 'taskkill.exe /F /T /IM adb.exe'
  nsExec::Exec 'taskkill.exe /F /T /IM netsimd.exe'
  ; give the processes a moment to really exit and release file handles
  Sleep 1500
!macroend
