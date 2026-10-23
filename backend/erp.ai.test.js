const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const registerErp = require('./erp');
const { canUseErp } = require('./planLimits');

function build(handlers = {}, extraDeps = {}) {
    const calls = [];
    const routes = {};
    const app = {};
    ['get', 'post', 'put', 'delete'].forEach((m) => { app[m] = (path, ...fns) => { routes[`${m.toUpperCase()} ${path}`] = fns; }; });
    const run = async (sql, params) => {
        calls.push({ sql: String(sql), params });
        for (const [needle, fn] of Object.entries(handlers)) if (String(sql).includes(needle)) return fn(params);
        return { rows: [], rowCount: 0 };
    };
    const pool = { query: run, connect: async () => ({ query: run, release() {} }) };
    const noop = (req, res, next) => next();
    const { ai } = registerErp(app, { pool, authenticateToken: noop, requireCompany: noop, canUseErp, ...extraDeps });
    return { ai, calls, routes };
}

const ctxOk = { companyId: 1, userId: 7, role: 'USER', planOk: true };
const admin = { ...ctxOk, role: 'MANAGER' };

describe('plano e cargo nas ações da Cláudia (ERP)', () => {
    it('plano sem ERP é barrado em qualquer ação', async () => {
        const { ai } = build();
        for (const fn of [...ai.AI_BASE, ...ai.AI_FINANCE]) {
            await assert.rejects(() => ai.run(fn, { ...admin, planOk: false }, {}), /exclusivo dos planos Starter e Pro AI/);
        }
    });

    it('Financeiro exige cargo de administrador', async () => {
        const { ai } = build();
        for (const fn of ai.AI_FINANCE) {
            await assert.rejects(() => ai.run(fn, ctxOk, {}), /administradores da empresa/);
        }
    });

    it('ação desconhecida é recusada', async () => {
        const { ai } = build();
        assert.throws(() => ai.run('apagarTudo', admin, {}), /desconhecida/);
        assert.equal(ai.isAiFunction('erpCriarCadastro'), true);
        assert.equal(ai.isAiFunction('excluirTudo'), false);
    });
});

describe('rotas /api/erp respeitam o plano', () => {
    it('planGuard devolve 403 PLAN_ERP_REQUIRED no plano gratuito e libera no Starter', () => {
        const { routes } = build();
        const chain = routes['GET /api/erp/parties'];
        const planGuard = chain[0][2]; // guard é um array: [auth, empresa, plano]
        let status = null; let body = null; let nextCalled = false;
        const res = { status(c) { status = c; return { json(b) { body = b; } }; } };
        planGuard({ user: { plan_tier: 'BASICO', plan_status: 'ACTIVE' } }, res, () => { nextCalled = true; });
        assert.equal(status, 403);
        assert.equal(body.code, 'PLAN_ERP_REQUIRED');
        assert.equal(nextCalled, false);
        planGuard({ user: { plan_tier: 'STARTER', plan_status: 'ACTIVE' } }, res, () => { nextCalled = true; });
        assert.equal(nextCalled, true);
        nextCalled = false;
        planGuard({ user: { plan_tier: 'STARTER', plan_status: 'INACTIVE' } }, res, () => { nextCalled = true; });
        assert.equal(nextCalled, false);
    });

    it('/api/erp/access informa enabled/finance', () => {
        const { routes } = build();
        const handler = routes['GET /api/erp/access'][2];
        let out;
        const res = { json(b) { out = b; } };
        handler({ user: { plan_tier: 'STARTER', plan_status: 'ACTIVE', role: 'MANAGER' } }, res);
        assert.deepEqual([out.enabled, out.finance], [true, true]);
        handler({ user: { plan_tier: 'STARTER', plan_status: 'ACTIVE', role: 'USER' } }, res);
        assert.deepEqual([out.enabled, out.finance], [true, false]);
        handler({ user: { plan_tier: 'BASICO', plan_status: 'ACTIVE', role: 'MANAGER' } }, res);
        assert.deepEqual([out.enabled, out.finance], [false, false]);
    });
});

describe('ações com dados', () => {
    it('cria cadastro e recusa duplicado', async () => {
        const { ai, calls } = build();
        const msg = await ai.run('erpCriarCadastro', ctxOk, { tipo: 'fornecedor', nome: 'Distribuidora Sol' });
        assert.match(msg, /Distribuidora Sol.*fornecedor/);
        assert.ok(calls.some((c) => c.sql.includes('INSERT INTO erp_parties')));
        const dup = build({ 'FROM erp_parties': () => ({ rows: [{ id: 1, kind: 'cliente', name: 'Maria', doc: '', phone: '', email: '', address: '', notes: '', active: true }] }) });
        await assert.rejects(() => dup.ai.run('erpCriarCadastro', ctxOk, { nome: 'maria' }), /Já existe/);
    });

    it('entende valores no formato brasileiro ao lançar conta', async () => {
        const { ai, calls } = build();
        const msg = await ai.run('erpLancarConta', admin, { tipo: 'pagar', descricao: 'Aluguel', valor: 'R$ 1.500,50', vencimento: '2026-11-05' });
        assert.match(msg, /Aluguel/);
        const ins = calls.find((c) => c.sql.includes('INSERT INTO erp_transactions'));
        assert.equal(ins.params[3], 1500.5);
        assert.equal(ins.params[1], 'pagar');
    });

    it('divide em parcelas', async () => {
        const { ai, calls } = build();
        await ai.run('erpLancarConta', admin, { tipo: 'receber', descricao: 'Venda X', valor: '300', vencimento: '2026-11-30', parcelas: '3' });
        assert.equal(calls.filter((c) => c.sql.includes('INSERT INTO erp_transactions')).length, 3);
    });

    it('lançar conta sem tipo pede o tipo', async () => {
        const { ai } = build();
        await assert.rejects(() => ai.run('erpLancarConta', admin, { descricao: 'X', valor: '10' }), /a pagar ou a receber/);
    });

    it('saída acima do estoque é recusada com mensagem clara', async () => {
        const prod = { id: 5, sku: '', name: 'Caneta', category: '', unit: 'un', is_service: false, cost_price: 1, sale_price: 2, stock: 3, min_stock: 0, active: true, created_at: null };
        const { ai } = build({
            'FROM erp_products WHERE company_id = $1 AND active': () => ({ rows: [prod] }),
            'FOR UPDATE': () => ({ rows: [{ stock: 3, is_service: false }] }),
            'UPDATE erp_products SET stock': () => ({ rows: [] }),
            'SELECT name FROM erp_products': () => ({ rows: [{ name: 'Caneta' }] })
        });
        await assert.rejects(() => ai.run('erpMovimentarEstoque', ctxOk, { produto: 'caneta', tipo: 'saida', quantidade: '10' }), /Estoque insuficiente/);
    });
});


describe('Cláudia: endereço do cliente e dados fiscais do produto', () => {
    it('completa o endereço pelo CEP e avisa o que ainda falta', async () => {
        const { ai, calls } = build({}, { cepLookup: async () => ({ logradouro: 'Rua das Flores', bairro: 'Centro', cidade: 'Maringá', uf: 'PR', codigo_municipio: '4115200', cep: '87000000' }) });
        const msg = await ai.run('erpCriarCadastro', ctxOk, { nome: 'Maria', cep: '87000-000', numero: '120' });
        const ins = calls.find((c) => c.sql.includes('INSERT INTO erp_parties'));
        assert.deepEqual(ins.params.slice(8), ['Rua das Flores', '120', '', 'Centro', 'Maringá', '4115200', 'PR', '87000000']);
        assert.match(msg, /criado no ERP/);
        assert.doesNotMatch(msg, /Atenção/);
    });

    it('o que o usuário disse tem prioridade sobre o CEP e a falta de dados vira aviso', async () => {
        const { ai, calls } = build({}, { cepLookup: async () => ({ logradouro: 'Rua do CEP', bairro: 'Bairro do CEP', cidade: 'X', uf: 'SP', codigo_municipio: '3550308', cep: '01001000' }) });
        const msg = await ai.run('erpCriarCadastro', ctxOk, { nome: 'João', cep: '01001000', logradouro: 'Rua Que Eu Disse', uf: 'PR' });
        const ins = calls.find((c) => c.sql.includes('INSERT INTO erp_parties'));
        assert.equal(ins.params[8], 'Rua Que Eu Disse');
        assert.equal(ins.params[14], 'PR');
        assert.match(msg, /Atenção: ao endereço ainda falta número/);
    });

    it('se a consulta de CEP falhar, o cadastro é criado mesmo assim', async () => {
        const { ai, calls } = build({}, { cepLookup: async () => null });
        await ai.run('erpCriarCadastro', ctxOk, { nome: 'Ana', cep: '87000000' });
        assert.ok(calls.some((c) => c.sql.includes('INSERT INTO erp_parties')));
    });

    it('sem endereço nenhum, cria como antes (sem aviso)', async () => {
        const { ai, calls } = build();
        const msg = await ai.run('erpCriarCadastro', ctxOk, { nome: 'Pedro' });
        const ins = calls.find((c) => c.sql.includes('INSERT INTO erp_parties'));
        assert.deepEqual(ins.params.slice(8), Array(8).fill(''));
        assert.doesNotMatch(msg, /Atenção/);
    });

    it('cria produto com NCM, CFOP, origem e ICMS', async () => {
        const { ai, calls } = build({ 'INSERT INTO erp_products': () => ({ rows: [{ id: 3 }] }) });
        await ai.run('erpCriarProduto', ctxOk, { nome: 'Caneta', precoVenda: '2,50', ncm: '9608.10.00', cfop: '5102', origem: '0', icmsSituacao: '102' });
        const ins = calls.find((c) => c.sql.includes('INSERT INTO erp_products'));
        assert.deepEqual(ins.params.slice(10), ['96081000', '', '5102', '0', '102', 0]);
    });

    it('NCM com tamanho errado é recusado com mensagem clara', async () => {
        const { ai } = build();
        await assert.rejects(() => ai.run('erpCriarProduto', ctxOk, { nome: 'Caneta', ncm: '123' }), /NCM tem 8 dígitos/);
    });

    it('erpEmitirNfe está na lista de ações fiscais', () => {
        const { ai } = build();
        assert.equal(ai.isAiFunction('erpEmitirNfe'), true);
        assert.ok(ai.AI_FISCAL.includes('erpEmitirNfe'));
    });
});