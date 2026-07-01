@echo off
title DRSOSystem - Teste Local
chcp 65001 >nul

cd /d "%~dp0"

echo ==========================================
echo      DRSOSystem - TESTE LOCAL
echo ==========================================
echo.

echo Iniciando servidor...
start "DRSOSystem" cmd /k node --no-warnings server/index.mjs

echo.
echo Aguardando servidor iniciar...
timeout /t 5 /nobreak >nul

echo Abrindo navegador...
start "" http://localhost:3333

echo.
echo ==========================================
echo Servidor iniciado.
echo Feche a janela do Node quando terminar.
echo ==========================================
pause