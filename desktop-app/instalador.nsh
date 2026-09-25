; Atalhos extras do instalador: "MyControl" abre o mesmo app ja em /mycontrol (argumento --mycontrol).
; O atalho "MyEstoque" continua sendo criado pelo electron-builder (createDesktopShortcut/createStartMenuShortcut).

!macro customInstall
  ; Area de trabalho e menu Iniciar, com o icone do proprio executavel
  CreateShortCut "$DESKTOP\MyControl.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "--mycontrol" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0
  CreateShortCut "$SMPROGRAMS\MyControl.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "--mycontrol" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0
!macroend

!macro customUnInstall
  ; Remove os atalhos do MyControl junto com o app
  Delete "$DESKTOP\MyControl.lnk"
  Delete "$SMPROGRAMS\MyControl.lnk"
!macroend
