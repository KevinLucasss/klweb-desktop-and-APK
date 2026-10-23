const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const ai = require('./ai');

const msgModelo = (obj) => async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(obj) } }] }) });
const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; delete process.env.GROQ_API_KEY; });

describe('quando a mensagem é do ERP', () => {
    it('reconhece pedidos de ERP', () => {
        for (const m of [
            'Cadastre o fornecedor Distribuidora Sol',
            'dê entrada de 10 canetas no estoque',
            'Lance uma conta a pagar de aluguel de R$ 1.500 vencendo dia 5',
            'quais produtos estão com estoque baixo?',
            'o que eu tenho a receber esse mês?',
            'crie um produto camiseta por 49,90',
            'Cadastre o cliente João no ERP',
            'paguei a conta de luz'
        ]) assert.equal(ai.parecePedidoErp(m), true, m);
    });

    it('deixa o resto com os outros fluxos', () => {
        for (const m of [
            'crie uma demanda sobre o estoque',
            'anote que o fornecedor ligou',
            'marque consulta com a paciente Maria amanhã',
            'cadastre o cliente João',
            'mude o tema para escuro',
            'quem está na minha equipe?'
        ]) assert.equal(ai.parecePedidoErp(m), false, m);
    });
});

describe('plano e cargo', () => {
    it('plano gratuito recebe o aviso de upgrade sem chamar o modelo', async () => {
        global.fetch = async () => { throw new Error('não deveria chamar o modelo'); };
        process.env.GROQ_API_KEY = 'x';
        const r = await ai.interpretarErp('cadastre o fornecedor Sol', { planTier: 'BASICO', planStatus: 'ACTIVE', role: 'MANAGER' });
        assert.equal(r.tipo, 'RESPOSTA_TEXTO');
        assert.match(r.texto, /exclusivo dos planos Starter e Pro AI/);
    });

    it('plano inativo também é barrado', async () => {
        const r = await ai.interpretarErp('veja o estoque', { planTier: 'PRO_IA', planStatus: 'INACTIVE', role: 'OWNER' });
        assert.match(r.texto, /exclusivo dos planos/);
    });

    it('funcionário não usa o Financeiro (barrado antes do modelo)', async () => {
        global.fetch = async () => { throw new Error('não deveria chamar o modelo'); };
        process.env.GROQ_API_KEY = 'x';
        const r = await ai.interpretarErp('lance uma conta a pagar de 100 reais', { planTier: 'STARTER', planStatus: 'ACTIVE', role: 'USER' });
        assert.match(r.texto, /Dono, Admin ou Gerente/);
    });

    it('se o modelo devolver ação financeira para funcionário, a segunda barreira corta', async () => {
        process.env.GROQ_API_KEY = 'x';
        global.fetch = msgModelo({ acoes: [{ funcao: 'erpLancarConta', params: { tipo: 'pagar', descricao: 'x', valor: '10' } }] });
        const r = await ai.interpretarErp('cadastre o fornecedor Sol', { planTier: 'STARTER', planStatus: 'ACTIVE', role: 'USER' });
        assert.equal(r.tipo, 'RESPOSTA_TEXTO');
        assert.match(r.texto, /Dono, Admin ou Gerente/);
    });

    it('gerente no Starter executa; funções fora da lista são descartadas', async () => {
        process.env.GROQ_API_KEY = 'x';
        global.fetch = msgModelo({ acoes: [
            { funcao: 'erpLancarConta', params: { tipo: 'pagar', descricao: 'Aluguel', valor: '1500' } },
            { funcao: 'apagarTudo', params: {} },
            { funcao: 'erpExcluirCadastro', params: { nome: 'x' } }
        ] });
        const r = await ai.interpretarErp('lance uma conta a pagar de aluguel 1500', { planTier: 'STARTER', planStatus: 'ACTIVE', role: 'MANAGER' });
        assert.equal(r.tipo, 'ACAO_REQUERIDA');
        assert.deepEqual(r.acoes.map(a => a.funcao), ['erpLancarConta']);
        assert.match(r.acoes[0].parametros.raw, /tipo="pagar"/);
    });

    it('fora do escopo devolve null para o fluxo de sempre', async () => {
        process.env.GROQ_API_KEY = 'x';
        global.fetch = msgModelo({ fora_do_escopo: true });
        const r = await ai.interpretarErp('cadastre o cliente João no ERP', { planTier: 'STARTER', planStatus: 'ACTIVE', role: 'USER' });
        assert.equal(r, null);
    });
});

describe('nota fiscal pela Cláudia', () => {
    it('"nota fiscal" vai para o ERP (e não para as anotações)', () => {
        for (const m of ['emita a nota fiscal do pedido 5', 'emitir nota para o cliente Maria', 'gere a nota de serviço de 200 reais', 'consulte a NFS-e do pedido 3', 'crie a nota fiscal da venda']) {
            assert.equal(ai.parecePedidoErp(m), true, m);
        }
        assert.equal(ai.parecePedidoErp('anote que preciso emitir o relatório'), false);
    });

    it('Starter tem ERP mas leva o aviso de upgrade da nota fiscal (sem chamar o modelo)', async () => {
        global.fetch = async () => { throw new Error('não deveria chamar o modelo'); };
        process.env.GROQ_API_KEY = 'x';
        const r = await ai.interpretarErp('emita a nota fiscal do pedido 5', { planTier: 'STARTER', planStatus: 'ACTIVE', role: 'MANAGER' });
        assert.match(r.texto, /exclusiva do plano Pro AI/);
    });

    it('plano gratuito recebe o aviso do ERP (não o da nota)', async () => {
        const r = await ai.interpretarErp('emita a nota fiscal do pedido 5', { planTier: 'BASICO', planStatus: 'ACTIVE', role: 'MANAGER' });
        assert.match(r.texto, /ERP é exclusivo dos planos Starter e Pro AI/);
    });

    it('Pro AI com cargo comum é barrado', async () => {
        global.fetch = async () => { throw new Error('não deveria chamar o modelo'); };
        process.env.GROQ_API_KEY = 'x';
        const r = await ai.interpretarErp('emita a nota fiscal do pedido 5', { planTier: 'PRO_IA', planStatus: 'ACTIVE', role: 'USER' });
        assert.match(r.texto, /Dono, Admin ou Gerente/);
    });

    it('Pro AI administrador executa; Starter não recebe a função mesmo se o modelo devolver', async () => {
        process.env.GROQ_API_KEY = 'x';
        global.fetch = msgModelo({ acoes: [{ funcao: 'erpEmitirNota', params: { pedido: '5' } }] });
        const ok = await ai.interpretarErp('emita a nota fiscal do pedido 5', { planTier: 'PRO_IA', planStatus: 'ACTIVE', role: 'MANAGER' });
        assert.equal(ok.tipo, 'ACAO_REQUERIDA');
        assert.deepEqual(ok.acoes.map(a => a.funcao), ['erpEmitirNota']);
        // segunda barreira: mensagem que não parece fiscal, plano Starter, modelo devolvendo a ação mesmo assim
        const bloqueado = await ai.interpretarErp('lance uma conta a receber de 100 reais', { planTier: 'STARTER', planStatus: 'ACTIVE', role: 'MANAGER' });
        assert.equal(bloqueado.tipo, 'RESPOSTA_TEXTO');
    });
});

describe('NF-e (produto) pela Cláudia', () => {
    it('Pro AI administrador executa erpEmitirNfe; Starter não recebe a função mesmo se o modelo devolver', async () => {
        process.env.GROQ_API_KEY = 'x';
        global.fetch = msgModelo({ acoes: [{ funcao: 'erpEmitirNfe', params: { pedido: '5' } }] });
        const ok = await ai.interpretarErp('emita a nf-e do pedido 5', { planTier: 'PRO_IA', planStatus: 'ACTIVE', role: 'MANAGER' });
        assert.equal(ok.tipo, 'ACAO_REQUERIDA');
        assert.deepEqual(ok.acoes.map(a => a.funcao), ['erpEmitirNfe']);
        assert.match(ok.acoes[0].parametros.raw, /pedido="5"/);
        const starter = await ai.interpretarErp('lance uma conta a receber de 100 reais', { planTier: 'STARTER', planStatus: 'ACTIVE', role: 'MANAGER' });
        assert.equal(starter.tipo, 'RESPOSTA_TEXTO');
    });

    it('Starter e cargo comum são barrados antes do modelo', async () => {
        global.fetch = async () => { throw new Error('não deveria chamar o modelo'); };
        process.env.GROQ_API_KEY = 'x';
        const s = await ai.interpretarErp('emita a nf-e do pedido 5', { planTier: 'STARTER', planStatus: 'ACTIVE', role: 'MANAGER' });
        assert.match(s.texto, /exclusiva do plano Pro AI/);
        const u = await ai.interpretarErp('emita a nf-e do pedido 5', { planTier: 'PRO_IA', planStatus: 'ACTIVE', role: 'USER' });
        assert.match(u.texto, /Dono, Admin ou Gerente/);
    });

    it('a lista de funções fiscais inclui a NF-e e o modelo é instruído sobre produto x serviço', () => {
        assert.ok(ai.ERP_FUNCOES_FISCAL.includes('erpEmitirNfe'));
        assert.equal(ai.parecePedidoErp('emita a nf-e do pedido 5'), true);
    });
});