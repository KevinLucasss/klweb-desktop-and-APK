# Integração — NF-e de produto, endereço do cliente e tela fiscal

## 1. Backend (substituir os arquivos)
`erp.js`, `ai.js` e `focusnfe.js`. O `server.js` **não muda**: ele já chama `erpService.ai.isAiFunction(...)`, então a nova ação `erpEmitirNfe` da Cláudia passa a valer sozinha.
As colunas novas são criadas sozinhas na primeira subida (`ALTER TABLE ... ADD COLUMN IF NOT EXISTS` dentro do DDL do `erp.js`). Não precisa rodar migração à mão.

Testes (Node 18+): `node --test` na pasta do backend com `erp.ai.test.js`, `erp.fiscal.test.js`, `ai.erp.test.js` e `focusnfe.test.js` atualizados.

## 2. Front: tela fiscal (`erp-fiscal.js`)
Copie `erp-fiscal.js` para a pasta publicada (a mesma do `index.html`) e, no `index.html`:

```html
<!-- onde ficará o conteúdo da aba -->
<section id="erpFiscalTab" hidden>
  <div id="erpFiscalRoot"></div>
</section>

<script src="erp-fiscal.js"></script>
<script>
  // chame quando o usuário abrir a aba (pode chamar de novo: ela recarrega os dados)
  function abrirAbaFiscal() {
    document.getElementById('erpFiscalTab').hidden = false;
    KLErpFiscal.mount('#erpFiscalRoot');
  }
</script>
```
Ligue `abrirAbaFiscal()` ao botão/menu da aba, do mesmo jeito que as outras abas do app abrem.

Se o JWT não estiver em `localStorage` com a chave `token`, `authToken`, `jwt` ou `accessToken`, passe `KLErpFiscal.mount('#erpFiscalRoot', { getToken: () => SUA_FUNCAO_QUE_DEVOLVE_O_TOKEN })`.
O CSP do `server.js` já permite esse arquivo (mesma origem) e os estilos que ele injeta.

## 3. Ordem recomendada para testar
1. Aba **Configuração fiscal**: ambiente *Homologação*, token da Focus, CNPJ, dados de NFS-e e de NF-e.
2. **Clientes**: endereço completo (CEP + Buscar CEP).
3. **Produtos**: NCM, CFOP e ICMS.
4. Confirmar um pedido de venda e emitir a nota pela aba **Notas fiscais** (ou pela Cláudia: “emita a NF-e do pedido 5”).
5. Só depois de aprovado em homologação, mudar para Produção.
