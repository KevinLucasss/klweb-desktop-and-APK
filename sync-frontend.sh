#!/bin/bash

# Script para sincronizar o frontend com a versão estática
# Uso: ./sync-frontend.sh

echo "🔄 Sincronizando frontend com frontend-static..."

# Criar diretório se não existir
mkdir -p frontend-static

# Copiar arquivos do frontend para frontend-static
cp -r frontend/* frontend-static/

# Verificar se o app.js tem a configuração correta para produção
if grep -q "klweb.com.br" frontend-static/app.js; then
    echo "✅ app.js configurado para klweb.com.br"
else
    echo "⚠️  ATENÇÃO: app.js pode não estar configurado para klweb.com.br"
fi

echo "✅ Sincronização concluída!"
echo "📁 Arquivos copiados para frontend-static/"
echo "🚀 Pronto para deploy em Netlify/Vercel/Cloudflare Pages"
