# 🛠️ Script de Configuração Rápida

## Como configurar o .env manualmente:

1. **Crie o arquivo .env** na pasta raiz do projeto
2. **Copie e cole** o conteúdo abaixo:

```env
PORT=3000
GEMINI_API_KEY=sua_chave_gemini_aqui
MERCADOPAGO_ACCESS_TOKEN=seu_token_mercado_pago_aqui
MASTER_PASSWORD=master@admin2026
JWT_SECRET=klweb_secret_key_master_owner_2026
RESEND_API_KEY=sua_chave_resend_aqui
RESEND_FROM=KL Web <onboarding@resend.dev>
DATABASE_URL=postgresql://postgres:SUA_SENHA@db.SEU_PROJETO.supabase.co:5432/postgres
```

## 🔑 Onde conseguir as chaves:

### Supabase (Banco de Dados)
1. Acesse: https://supabase.com
2. Crie projeto gratuito
3. Settings → Database → Connection String
4. Copie a URL completa

### Resend (Emails)
1. Acesse: https://resend.com
2. Criar conta gratuita
3. API Keys → Create API Key
4. Copie a chave gerada

### Gemini API (Opcional - para IA)
1. Acesse: https://makersuite.google.com/app/apikey
2. Criar nova chave API
3. Copie a chave

### Mercado Pago (Opcional - para pagamentos)
1. Acesse: https://mercadopago.com.br
2. Criar conta
3. Configurações → Credenciais
4. Copie o Access Token

## 🚀 Após configurar:

```bash
# Instalar dependências
npm install

# Iniciar servidor
node backend/server.js
```

O sistema estará disponível em: http://localhost:3000