; Deyin installer chrome.
;
; electron-builder includes this file automatically (apps/desktop/build/installer.nsh)
; for the NSIS target. It re-skins the one-click installer window that users see on
; install and, above all, on every auto-update ("Restart to update" runs this installer
; non-silently so there is visible feedback while the app is replaced).
;
; Stock behaviour: electron-builder opens a SpiderBanner window ("Installing, please
; wait..." on a grey dialog). SpiderBanner just resizes the installer's own main window and
; overlays a child dialog. We let it appear, destroy it (which restores the plain MUI
; install page), then restyle that page in place: a borderless dark window (no title bar),
; flat logo, title, subtitle and a thick accent progress bar driven by the installer's real
; progress. Flat colours throughout, no gradients.
; The window is kept fully transparent from the moment it is created until the new layout
; is painted, then faded in, so neither the stock white page nor the grey banner flashes.
;
; Why `customCheckAppRunning`: it is the only documented electron-builder hook that runs
; inside the install section right after the banner is shown. Defining it replaces the
; stock "is the app running?" check, so we re-run that check ourselves at the end of the
; macro (see allowOnlyOneInstallerInstance.nsh in app-builder-lib). When upgrading
; electron-builder, rebuild the Windows installer and eyeball an update run;
; apps/desktop/test/installer-nsis.test.ts guards the template contract we rely on.
;
; Everything here is cosmetic: every Win32 call is best-effort and a missing control or an
; old Windows build just leaves a plainer window. Silent installs (/S) are untouched.
;
; NOTE: electron-builder treats NSIS warnings as errors. Anything only used by the
; installer pass is wrapped in `!ifndef BUILD_UNINSTALLER` so the uninstaller pass (which
; shares this include) does not trip "function/variable not referenced".

!include "LogicLib.nsh"
!include "WinMessages.nsh"

; Needed by the stock app-running check we re-run below. electron-builder only includes
; these when no customCheckAppRunning macro exists.
!include "getProcessInfo.nsh"
Var pid

!ifndef BUILD_UNINSTALLER

; Palette: flat, solid colours only (no gradients). Near-black neutral surface, one blue
; accent taken from the brand mark (packages/branding/assets/logo-mark-flat.svg) so the logo
; and progress bar match. NSIS colour commands take RRGGBB; Win32/DWM COLORREFs are
; BBGGRR, hence the second spelling.
!define DEYIN_BG_RGB      "0E0E10"
!define DEYIN_TEXT_RGB    "F4F4F5"
!define DEYIN_MUTED_RGB   "8E8E96"
!define DEYIN_TRACK_REF   0x00272323
!define DEYIN_ACCENT_REF  0x00FF7C4F
!define DEYIN_BORDER_REF  0x002F2A2A

; Layout in client-area pixels (the window has no title bar, so client = window). The
; installer is not DPI-aware, so Windows scales the whole window uniformly and these stay
; in 96-dpi units.
!define DEYIN_CLIENT_W    420
!define DEYIN_CLIENT_H    300
!define DEYIN_LOGO_SIZE   72
!define DEYIN_LOGO_Y      52
!define DEYIN_TITLE_Y     146
!define DEYIN_SUBTITLE_Y  182
!define DEYIN_BAR_H       10
!define DEYIN_BAR_BOTTOM  52

; MUI runs this from .onGUIInit, i.e. before the first page is shown. It must be defined
; before installer.nsi inserts the languages (MUI generates .onGUIInit there), which is
; why this lives at the top level of the include.
!define MUI_CUSTOMFUNCTION_GUIINIT DeyinHideUntilStyled

Var dyL
Var dyT
Var dyR
Var dyB
Var dyCW
Var dyCH
Var dyFW
Var dyFH
Var dyX
Var dyY
Var dyW
Var dyH
Var dyRect
Var dyCtl
Var dyPage
Var dyBar
Var dyFont

; Hide one control of the main installer window by its dialog id.
;   1/2/3        Next (Close) / Cancel / Back buttons
;   1028, 1256   branding text ("Deyin 1.0.x")
;   1034-1039    header strip: background, title, subtitle, header image
;   1035/1036/1045/1044   separator lines / frame
!macro DeyinHideMain ID
  GetDlgItem $dyCtl $HWNDPARENT ${ID}
  ShowWindow $dyCtl ${SW_HIDE}
!macroend

; Create a static text control on the main window, centred, in the given font. The text
; may contain $\r$\n for deliberate line breaks (it is set via WM_SETTEXT, not in the
; CreateWindowEx call string). The new control's handle is left in $dyCtl.
!macro DeyinLabel TEXT COLOR Y H FONT
  IntOp $dyX $dyCW - 72
  System::Call 'user32::CreateWindowEx(i 0, t "STATIC", t "", i 0x50000081, i 36, i ${Y}, i $dyX, i ${H}, p $HWNDPARENT, p 0, p 0, p 0)p.s'
  Pop $dyCtl
  SendMessage $dyCtl ${WM_SETTEXT} 0 "STR:${TEXT}"
  SendMessage $dyCtl ${WM_SETFONT} ${FONT} 1
  SetCtlColors $dyCtl "${COLOR}" "${DEYIN_BG_RGB}"
!macroend

; Expanded by installer.nsi after electron-builder has registered its plugin directories.
; Defining these functions directly in this include would run before that, and the
; SpiderBanner:: call below would fail with "Plugin not found".
!macro customHeader
  ; Make the main window fully transparent (layered, alpha 0) before it is first shown.
  ; DeyinStyleInstallWindow reveals it. Silent installs have no window, so skip them.
  Function DeyinHideUntilStyled
    ${IfNot} ${Silent}
      System::Call 'user32::GetWindowLong(p $HWNDPARENT, i -20)i.s'
      Pop $dyX
      IntOp $dyX $dyX | 0x80000
      System::Call 'user32::SetWindowLong(p $HWNDPARENT, i -20, i $dyX)'
      System::Call 'user32::SetLayeredWindowAttributes(p $HWNDPARENT, i 0, i 0, i 2)'
    ${EndIf}
  FunctionEnd

  Function DeyinStyleInstallWindow
    SpiderBanner::Destroy

    ; ---- Frame: no title bar. Drop WS_CAPTION (title + border) and the dialog's modal-frame/edge
    ; styles, then let DWM round the corners and draw a 1px hairline border (Windows 11; older
    ; Windows just gets a clean square window). The one-pixel bottom margin below is what makes DWM
    ; keep its drop shadow on a window that has no frame of its own. ----
    System::Call 'user32::GetWindowLong(p $HWNDPARENT, i -16)i.s'
    Pop $dyX
    IntOp $dyY 0xC00000 ~
    IntOp $dyX $dyX & $dyY
    System::Call 'user32::SetWindowLong(p $HWNDPARENT, i -16, i $dyX)'
    System::Call 'user32::GetWindowLong(p $HWNDPARENT, i -20)i.s'
    Pop $dyX
    IntOp $dyY 0x301 ~
    IntOp $dyX $dyX & $dyY
    System::Call 'user32::SetWindowLong(p $HWNDPARENT, i -20, i $dyX)'
    ; SWP_NOSIZE|NOMOVE|NOZORDER|NOACTIVATE|FRAMECHANGED: re-evaluate the frame, nothing else.
    System::Call 'user32::SetWindowPos(p $HWNDPARENT, p 0, i 0, i 0, i 0, i 0, i 0x37)'
    System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 33, *i 2, i 4)'
    System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 34, *i ${DEYIN_BORDER_REF}, i 4)'
    System::Call '*(i 0, i 0, i 0, i 1)p.s'
    Pop $dyRect
    System::Call 'dwmapi::DwmExtendFrameIntoClientArea(p $HWNDPARENT, p $dyRect)'
    System::Free $dyRect

    ; ---- Resize to a fixed client area, keeping the window centred where Windows put it. ----
    System::Call '*(i,i,i,i)p.s'
    Pop $dyRect
    System::Call 'user32::GetWindowRect(p $HWNDPARENT, p $dyRect)'
    ; `.s` outputs are pushed so that they pop back in field order.
    System::Call '*$dyRect(i.s, i.s, i.s, i.s)'
    Pop $dyL
    Pop $dyT
    Pop $dyR
    Pop $dyB
    System::Call 'user32::GetClientRect(p $HWNDPARENT, p $dyRect)'
    System::Call '*$dyRect(i, i, i.s, i.s)'
    Pop $dyCW
    Pop $dyCH
    System::Free $dyRect

    ; Frame (caption + borders) = outer size - client size; new outer = target client + frame.
    IntOp $dyFW $dyR - $dyL
    IntOp $dyFW $dyFW - $dyCW
    IntOp $dyFH $dyB - $dyT
    IntOp $dyFH $dyFH - $dyCH
    IntOp $dyW ${DEYIN_CLIENT_W} + $dyFW
    IntOp $dyH ${DEYIN_CLIENT_H} + $dyFH
    ; New top-left = old centre - half the new size.
    IntOp $dyX $dyL + $dyR
    IntOp $dyX $dyX / 2
    IntOp $dyL $dyW / 2
    IntOp $dyX $dyX - $dyL
    IntOp $dyY $dyT + $dyB
    IntOp $dyY $dyY / 2
    IntOp $dyT $dyH / 2
    IntOp $dyY $dyY - $dyT
    System::Call 'user32::SetWindowPos(p $HWNDPARENT, p 0, i $dyX, i $dyY, i $dyW, i $dyH, i 0x14)'
    StrCpy $dyCW ${DEYIN_CLIENT_W}
    StrCpy $dyCH ${DEYIN_CLIENT_H}

    ; ---- Surface: dark window, stock header/footer chrome hidden. ----
    SetCtlColors $HWNDPARENT "" "${DEYIN_BG_RGB}"
    !insertmacro DeyinHideMain 1
    !insertmacro DeyinHideMain 2
    !insertmacro DeyinHideMain 3
    !insertmacro DeyinHideMain 1028
    !insertmacro DeyinHideMain 1034
    !insertmacro DeyinHideMain 1035
    !insertmacro DeyinHideMain 1036
    !insertmacro DeyinHideMain 1037
    !insertmacro DeyinHideMain 1038
    !insertmacro DeyinHideMain 1039
    !insertmacro DeyinHideMain 1044
    !insertmacro DeyinHideMain 1045
    !insertmacro DeyinHideMain 1256

    ; ---- Logo: the flat brand mark (build/installer-mark.ico, generated by @deyin/branding
    ; make-icons). Falls back to the app icon, which has a gradient, if it is missing. ----
    !if /FileExists "${BUILD_RESOURCES_DIR}\installer-mark.ico"
      !define DEYIN_LOGO_FILE "${BUILD_RESOURCES_DIR}\installer-mark.ico"
    !else
      !define DEYIN_LOGO_FILE "${MUI_ICON}"
    !endif
    File /oname=$PLUGINSDIR\deyin-logo.ico "${DEYIN_LOGO_FILE}"
    IntOp $dyX $dyCW - ${DEYIN_LOGO_SIZE}
    IntOp $dyX $dyX / 2
    System::Call 'user32::CreateWindowEx(i 0, t "STATIC", t "", i 0x50000803, i $dyX, i ${DEYIN_LOGO_Y}, i ${DEYIN_LOGO_SIZE}, i ${DEYIN_LOGO_SIZE}, p $HWNDPARENT, p 0, p 0, p 0)p.s'
    Pop $dyCtl
    System::Call 'user32::LoadImage(p 0, t "$PLUGINSDIR\deyin-logo.ico", i 1, i ${DEYIN_LOGO_SIZE}, i ${DEYIN_LOGO_SIZE}, i 0x10)p.s'
    Pop $dyX
    SendMessage $dyCtl 0x170 $dyX 0
    SetCtlColors $dyCtl "" "${DEYIN_BG_RGB}"

    ; ---- Title + subtitle ----
    System::Call 'gdi32::CreateFont(i -23, i 0, i 0, i 0, i 600, i 0, i 0, i 0, i 1, i 0, i 0, i 5, i 0, t "Segoe UI Semibold")p.s'
    Pop $dyFont
    ${If} ${isUpdated}
      !insertmacro DeyinLabel "Updating ${PRODUCT_NAME}" "${DEYIN_TEXT_RGB}" ${DEYIN_TITLE_Y} 32 $dyFont
    ${Else}
      !insertmacro DeyinLabel "Installing ${PRODUCT_NAME}" "${DEYIN_TEXT_RGB}" ${DEYIN_TITLE_Y} 32 $dyFont
    ${EndIf}

    System::Call 'gdi32::CreateFont(i -14, i 0, i 0, i 0, i 400, i 0, i 0, i 0, i 1, i 0, i 0, i 5, i 0, t "Segoe UI")p.s'
    Pop $dyFont
    ${If} ${isUpdated}
      !insertmacro DeyinLabel "Installing version ${VERSION}$\r$\n${PRODUCT_NAME} will reopen automatically." "${DEYIN_MUTED_RGB}" ${DEYIN_SUBTITLE_Y} 40 $dyFont
    ${Else}
      !insertmacro DeyinLabel "Setting up version ${VERSION}$\r$\n${PRODUCT_NAME} will open when it is ready." "${DEYIN_MUTED_RGB}" ${DEYIN_SUBTITLE_Y} 40 $dyFont
    ${EndIf}

    ; ---- Progress: reuse the installer's own bar (it already tracks extraction) as a thick accent pill. ----
    ; The bar lives in the install-page dialog, the only #32770 child of the main window.
    FindWindow $dyPage "#32770" "" $HWNDPARENT
    GetDlgItem $dyBar $dyPage 1004
    GetDlgItem $dyCtl $dyPage 1006
    ShowWindow $dyCtl ${SW_HIDE}
    GetDlgItem $dyCtl $dyPage 1016
    ShowWindow $dyCtl ${SW_HIDE}
    GetDlgItem $dyCtl $dyPage 1027
    ShowWindow $dyCtl ${SW_HIDE}

    IntOp $dyW $dyCW - 96
    IntOp $dyY $dyCH - ${DEYIN_BAR_BOTTOM}
    System::Call 'user32::SetWindowPos(p $dyPage, p 0, i 48, i $dyY, i $dyW, i ${DEYIN_BAR_H}, i 0x14)'
    System::Call 'user32::SetWindowPos(p $dyBar, p 0, i 0, i 0, i $dyW, i ${DEYIN_BAR_H}, i 0x14)'
    SetCtlColors $dyPage "" "${DEYIN_BG_RGB}"
    ; Classic (unthemed) progress bars honour custom colours; smooth fill, no segments,
    ; and no border or sunken edge (WS_BORDER, WS_EX_CLIENTEDGE/STATICEDGE/WINDOWEDGE).
    System::Call 'uxtheme::SetWindowTheme(p $dyBar, w "", w "")'
    System::Call 'user32::GetWindowLong(p $dyBar, i -16)i.s'
    Pop $dyX
    IntOp $dyX $dyX | 1
    IntOp $dyY 0x800000 ~
    IntOp $dyX $dyX & $dyY
    System::Call 'user32::SetWindowLong(p $dyBar, i -16, i $dyX)'
    System::Call 'user32::GetWindowLong(p $dyBar, i -20)i.s'
    Pop $dyX
    IntOp $dyY 0x20300 ~
    IntOp $dyX $dyX & $dyY
    System::Call 'user32::SetWindowLong(p $dyBar, i -20, i $dyX)'
    System::Call 'user32::SetWindowPos(p $dyBar, p 0, i 0, i 0, i $dyW, i ${DEYIN_BAR_H}, i 0x34)'
    SendMessage $dyBar 0x409 0 ${DEYIN_ACCENT_REF}
    SendMessage $dyBar 0x2001 0 ${DEYIN_TRACK_REF}
    ; Fully rounded ends: clip the bar (track and fill) to a pill.
    IntOp $dyX $dyW + 1
    IntOp $dyY ${DEYIN_BAR_H} + 1
    System::Call 'gdi32::CreateRoundRectRgn(i 0, i 0, i $dyX, i $dyY, i ${DEYIN_BAR_H}, i ${DEYIN_BAR_H})p.s'
    Pop $dyX
    System::Call 'user32::SetWindowRgn(p $dyBar, p $dyX, i 1)'
    ShowWindow $dyPage ${SW_SHOW}
    ShowWindow $dyBar ${SW_SHOW}

    ; ---- Reveal: paint the final layout while still transparent, fade in, drop the layered style. ----
    ; (RDW_INVALIDATE|ERASE|ALLCHILDREN|UPDATENOW so no stock chrome lingers.)
    System::Call 'user32::RedrawWindow(p $HWNDPARENT, p 0, p 0, i 0x185)'
    StrCpy $dyX 0
    ${Do}
      IntOp $dyX $dyX + 36
      ${If} $dyX > 255
        StrCpy $dyX 255
      ${EndIf}
      System::Call 'user32::SetLayeredWindowAttributes(p $HWNDPARENT, i 0, i $dyX, i 2)'
      Sleep 14
    ${LoopUntil} $dyX == 255
    System::Call 'user32::GetWindowLong(p $HWNDPARENT, i -20)i.s'
    Pop $dyX
    IntOp $dyY 0x80000 ~
    IntOp $dyX $dyX & $dyY
    System::Call 'user32::SetWindowLong(p $HWNDPARENT, i -20, i $dyX)'
    System::Call 'user32::RedrawWindow(p $HWNDPARENT, p 0, p 0, i 0x185)'
  FunctionEnd
!macroend

!endif

!macro customCheckAppRunning
  !ifndef BUILD_UNINSTALLER
    ${IfNot} ${Silent}
      Call DeyinStyleInstallWindow
    ${EndIf}
  !endif
  !insertmacro IS_POWERSHELL_AVAILABLE
  !insertmacro _CHECK_APP_RUNNING
!macroend
