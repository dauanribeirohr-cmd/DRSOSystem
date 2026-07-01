@echo off
chcp 65001 >nul
title DRSOSystem - Central DEV

cd /d "%~dp0"

:MENU
cls
echo ==========================================
echo          DRSOSystem - CENTRAL DEV
echo ==========================================
echo.
echo Pasta atual:
echo %cd%
echo.
echo 1 - Verificar ambiente
echo 2 - Testar local
echo 3 - Publicar na VPS
echo 4 - Parar servidor local
echo 5 - Status do Git
echo 6 - Abrir GitHub Actions
echo 7 - Abrir projeto no Explorer
echo 0 - Sair
echo.
set /p opcao=Escolha uma opcao: 

if "%opcao%"=="1" goto VERIFICAR
if "%opcao%"=="2" goto TESTAR
if "%opcao%"=="3" goto PUBLICAR
if "%opcao%"=="4" goto PARAR
if "%opcao%"=="5" goto STATUS
if "%opcao%"=="6" goto ACTIONS
if "%opcao%"=="7" goto EXPLORER
if "%opcao%"=="0" exit
goto MENU

:VERIFICAR
cls
echo ==========================================
echo        VERIFICANDO AMBIENTE
echo ==========================================
echo.

where git >nul 2>nul
if errorlevel 1 (
    echo [ERRO] Git nao encontrado.
    echo Instale o Git: https://git-scm.com/download/win
) else (
    echo [OK] Git encontrado.
    git --version
)

echo.

where node >nul 2>nul
if errorlevel 1 (
    echo [ERRO] Node.js nao encontrado.
    echo Instale o Node LTS: https://nodejs.org
) else (
    echo [OK] Node encontrado.
    node -v
)

echo.

where npm >nul 2>nul
if errorlevel 1 (
    echo [ERRO] npm nao encontrado.
) else (
    echo [OK] npm encontrado.
    npm -v
)

echo.
pause
goto MENU

:TESTAR
cls
echo ==========================================
echo          TESTAR LOCAL
echo ==========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo [ERRO] Node.js nao esta instalado neste PC.
    echo Instale o Node LTS em: https://nodejs.org
    echo.
    pause
    goto MENU
)

echo Iniciando servidor local...
start "DRSOSystem Local" cmd /k "cd /d "%~dp0" && node --no-warnings server/index.mjs"

echo.
echo Aguardando servidor iniciar...
timeout /t 5 /nobreak >nul

echo Abrindo navegador...
start "" http://localhost:3333

echo.
echo Servidor local iniciado.
echo Para encerrar, use a opcao 4 do menu.
pause
goto MENU

:PUBLICAR
cls
echo ==========================================
echo          PUBLICAR NA VPS
echo ==========================================
echo.

where git >nul 2>nul
if errorlevel 1 (
    echo [ERRO] Git nao encontrado neste PC.
    echo Instale o Git: https://git-scm.com/download/win
    echo.
    pause
    goto MENU
)

echo Status atual:
git status
echo.

set /p msg=Digite a mensagem da atualizacao: 

if "%msg%"=="" (
    echo.
    echo Mensagem vazia. Publicacao cancelada.
    pause
    goto MENU
)

echo.
echo Adicionando arquivos...
git add .

echo.
echo Criando commit...
git commit -m "%msg%"

echo.
echo Enviando para GitHub/VPS...
git push

echo.
echo Abrindo GitHub Actions...
start "" https://github.com/dauanribeirohr-cmd/DRSOSystem/actions

echo.
echo Publicacao enviada. Aguarde o workflow ficar verde.
pause
goto MENU

:PARAR
cls
echo ==========================================
echo        PARAR SERVIDOR LOCAL
echo ==========================================
echo.

taskkill /F /IM node.exe

echo.
echo Node encerrado.
pause
goto MENU

:STATUS
cls
echo ==========================================
echo            STATUS DO GIT
echo ==========================================
echo.

git status

echo.
pause
goto MENU

:ACTIONS
start "" https://github.com/dauanribeirohr-cmd/DRSOSystem/actions
goto MENU

:EXPLORER
start "" "%~dp0"
goto MENU