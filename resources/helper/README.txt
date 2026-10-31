InsomniaZ Power Helper
======================

InsomniaZHelper.exe is a small, fixed-command helper compiled from
InsomniaZHelper.cs in this folder. It is not installed as a service and it is
not started at boot.

Responsibilities:
- Hold a Windows execution state while InsomniaZ is active.
- Temporarily change the current power plan's lid-close action to
  "Do nothing" for both AC and battery, then restore the original values.
- Send an F15 key event when activity simulation is enabled.
- Restore the original lid policy if the InsomniaZ process exits unexpectedly.

The helper communicates only over a random local named pipe. It accepts a
fixed command set and exits when its parent process disappears.

Source is provided for audit. Build with scripts/build-helper.ps1.
