# 🚀 Guia de Configuração - KL Web

## 📋 Pré-requisitos

1. **Conta no Supabase** (gratuito) para banco de dados PostgreSQL
2. **Conta no Resend** (gratuito) para envio de emails
3. **Node.js** instalado no seu computador

## 🔧 Passo a Passo de Configuração

### 1. Configurar Banco de Dados (Supabase)

1. Acesse [supabase.com](https://supabase.com) e crie uma conta gratuita
2. Crie um novo projeto
3. Vá em Settings → Database
4. Copie a **Connection String** no formato:
   ```
   postgresql://postgres:SUA_SENHA@db.SEU_PROJETO.supabase.co:5432/postgres
   ```

### 2. Configurar Envio de Emails (Resend)

1. Acesse [resend.com](https://resend.com) e crie uma conta gratuita
2. Vá em API Keys → Create API Key
3. Copie a chave gerada
4. Configure um domínio de envio (ou use o domínio padrão do Resend)

### 3. Criar Arquivo .env

Crie um arquivo chamado `.env` na raiz do projeto com o seguinte conteúdo:

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

**Substitua:**
- `SUA_SENHA` pela senha do seu banco Supabase
- `db.SEU_PROJETO.supabase.co` pelo host do seu projeto Supabase
- `sua_chave_resend_aqui` pela sua chave API do Resend
- `sua_chave_gemini_aqui` pela sua chave da Google Gemini (opcional)
- `seu_token_mercado_pago_aqui` pelo token do Mercado Pago (opcional)

### 4. Instalar Dependências

No terminal, execute:

```bash
npm install
```

### 5. Iniciar o Servidor

```bash
node backend/server.js
```

O servidor iniciará em `http://localhost:3000`

## ✅ Testar o Sistema

### Testar Recuperação de Senha

1. Acesse `http://localhost:3000`
2. Clique em "Esqueci a senha"
3. Digite um email cadastrado
4. Verifique seu email (caixa de entrada ou spam)
5. Clique no link de redefinição
6. Defina nova senha
7. Faça login com a nova senha

### Testar Cadastro com Código de Empresa

1. Crie uma conta como dono/gerente
2. Vá na aba "Empresa" para ver o código da empresa
3. Abra uma nova aba/incógnito
4. Cadastre-se usando o código da empresa
5. Faça login como dono/gerente
6. Aprove a solicitação na aba "Empresa"
7. O funcionário poderá fazer login

## 🔍 Solução de Problemas

### Erro de conexão com banco
- Verifique se a `DATABASE_URL` está correta
- Confirme que o projeto Supabase está ativo
- Verifique se a senha do PostgreSQL está correta

### Emails não chegam
- Verifique se a `RESEND_API_KEY` está correta
- Confirme que o domínio de envio está verificado no Resend
- Verifique a caixa de spam do email

### Erro "Token ausente"
- Limpe o cache do navegador
- Faça logout e login novamente
- Verifique se o servidor está rodando

## 🎯 Próximos Passos

Após configurar:
1. Teste o fluxo completo de cadastro
2. Teste a recuperação de senha
3. Teste a aprovação de funcionários
4. Teste a criação de demandas
5. Configure seu domínio personalizado (opcional)

## 📞 Suporte

Se tiver problemas:
- Verifique os logs do servidor no terminal
- Confirme que todas as variáveis de ambiente estão setadas
- Teste a conexão com o banco diretamente

---

**Sistema pronto para uso após configuração!** 🚀