@echo off
REM Script para sincronizar o frontend com a versão estática (Windows)
REM Uso: sync-frontend.bat

echo 🔄 Sincronizando frontend com frontend-static...

REM Criar diretórios se não existirem
if not exist "frontend-static" mkdir "frontend-static"
if not exist "desktop-app\www" mkdir "desktop-app\www"

REM Copiar arquivos do frontend para frontend-static
xcopy /E /I /Y frontend\* frontend-static\

REM Copiar arquivos do frontend para o app de desktop (native feel)
xcopy /E /I /Y frontend\* desktop-app\www\

REM Verificar se o app.js tem a configuração correta para produção
findstr /C:"klweb.com.br" frontend-static\app.js >nul
if %errorlevel% equ 0 (
    echo ✅ app.js configurado para klweb.com.br
) else (
    echo ⚠️  ATENÇÃO: app.js pode não estar configurado para klweb.com.br
)

echo ✅ Sincronização concluída!
echo 📁 Arquivos copiados para frontend-static\
echo 🚀 Pronto para deploy em Netlify/Vercel/Cloudflare Pages
pause
