# 🔐 Atualização de Segurança - JWT_SECRET e MASTER_PASSWORD

## ⚠️ Avisos Atuais:

1. **JWT_SECRET não definido** - O sistema está gerando uma chave aleatória que será invalidada ao reiniciar o servidor
2. **MASTER_PASSWORD usando valor padrão** - Senha master está usando valor de exemplo que é público

## 📝 Como Atualizar:

### 1. Abra o arquivo `.env` na raiz do projeto

### 2. Substitua ou adicione estas linhas:

```env
JWT_SECRET=sua_chave_jwt_aleatoria_e_segura_aqui
MASTER_PASSWORD=sua_senha_master_forte_e_unico_aqui
```

### 3. Gerar chaves seguras:

#### Para JWT_SECRET (execute no terminal):
```bash
openssl rand -hex 32
```
Copie o resultado e cole no JWT_SECRET

#### Para MASTER_PASSWORD:
Crie uma senha forte com:
- Mínimo 12 caracteres
- Letras maiúsculas e minúsculas
- Números
- Caracteres especiais (@#$%^&*)

### 4. Exemplo de configuração segura:

```env
JWT_SECRET=a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6
MASTER_PASSWORD=MinhaSenhaMuitoSegura2026!@#
```

### 5. Salve o arquivo e reinicie o servidor:

```bash
node backend/server.js
```

## 🔒 Por que isso é importante:

- **JWT_SECRET**: Protege seus tokens de autenticação. Sem uma chave fixa, todos os usuários precisam fazer login novamente a cada reinício do servidor.

- **MASTER_PASSWORD**: Protege o acesso ao painel administrativo. Usar a senha padrão é um risco de segurança grave.

## ✅ Após atualizar:

- Os avisos no console desaparecerão
- As sessões dos usuários permanecerão estáveis
- O painel master estará protegido com senha personalizada
- O sistema estará pronto para produção

---

**Rote este arquivo após fazer as alterações no .env**