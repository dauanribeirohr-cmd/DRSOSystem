@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ======================================
echo      PUBLICAR DRSOSYSTEM NA VPS
echo ======================================
echo.

echo Pasta atual:
cd
echo.

git status
echo.

set /p msg=Digite o que foi alterado: 

if "%msg%"=="" (
    echo Mensagem vazia. Cancelado.
    pause
    exit /b
)

git add .
git commit -m "%msg%"
git push

start https://github.com/dauanribeirohr-cmd/DRSOSystem/actions

echo.
echo Publicacao enviada. Aguarde o workflow ficar verde.
pause