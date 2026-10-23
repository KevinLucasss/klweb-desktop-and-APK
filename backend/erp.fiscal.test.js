const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const registerErp = require('./erp');
const { canUseErp, canUseErpFiscal } = require('./planLimits');

const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; });

function build(handlers = {}, extraDeps = {}) {
    const calls = [];
    const routes = {};
    const app = {};
    ['get', 'post', 'put', 'delete'].forEach((m) => { app[m] = (path, ...fns) => { routes[`${m.toUpperCase()} ${path}`] = fns; }; });
    const run = async (sql, params) => {
        calls.push({ sql: String(sql), params });
        for (const [needle, fn] of Object.entries(handlers)) if (String(sql).includes(needle)) return fn(params, sql);
        return { rows: [], rowCount: 0 };
    };
    const pool = { query: run, connect: async () => ({ query: run, release() {} }) };
    const noop = (req, res, next) => next();
    const { ai } = registerErp(app, {
        pool, authenticateToken: noop, requireCompany: noop, canUseErp, canUseErpFiscal,
        encryptData: (v) => `ENC:${v}`, decryptData: (v) => String(v).replace(/^ENC:/, ''), ...extraDeps
    });
    return { ai, calls, routes };
}

const settingsRow = {
    company_id: 1, token_enc: 'ENC:TOKEN-SECRETO-123', ambiente: 'homologacao', cnpj: '11222333000181', inscricao_municipal: '123445',
    codigo_municipio: '4104303', optante_simples: true, regime_especial: '', natureza_operacao: '1', item_lista_servico: '14.01',
    codigo_tributario_municipio: '', aliquota: '2.5', iss_retido: false
};
const orderRow = { id: 9, type: 'venda', status: 'confirmado', party_id: 4, total: '150.00', number: 5 };
const partyRow = { id: 4, kind: 'cliente', name: 'Maria da Silva', doc: '529.982.247-25', phone: '', email: 'm@x.com', address: '', notes: '', active: true };
const docRow = { id: 1, kind: 'nfse', ref: 'klweb-1-x', order_id: 9, party_id: 4, amount: '150.00', description: '1 x Site', status: 'processando_autorizacao', ambiente: 'homologacao', numero: '', codigo_verificacao: '', url: '', xml_url: '', errors: '' };

const emitHandlers = (extra = {}) => ({
    'FROM erp_fiscal_settings': () => ({ rows: [settingsRow] }),
    'SELECT id FROM erp_orders': () => ({ rows: [{ id: 9 }] }),
    'SELECT * FROM erp_orders WHERE id': () => ({ rows: [orderRow] }),
    'FROM erp_fiscal_docs WHERE company_id=$1 AND order_id': () => ({ rows: [] }),
    'FROM erp_order_items': () => ({ rows: [{ description: 'Site institucional', qty: '1' }] }),
    'SELECT * FROM erp_parties WHERE id': () => ({ rows: [partyRow] }),
    'INSERT INTO erp_fiscal_docs': () => ({ rows: [{ ...docRow, status: 'enviando' }] }),
    "SET status='processando_autorizacao'": () => ({ rows: [docRow] }),
    ...extra
});

const admin = { companyId: 1, userId: 7, role: 'MANAGER', planOk: true, fiscalOk: true };

describe('nota fiscal: plano e cargo', () => {
    it('rotas fiscais: Starter tem ERP mas leva 403; Pro AI passa; inativo é barrado', () => {
        const { routes } = build();
        const chain = routes['GET /api/erp/fiscal/settings'][0];
        const fiscalGuard = chain[3];
        let status = null; let body = null; let ok = false;
        const res = { status(c) { status = c; return { json(b) { body = b; } }; } };
        fiscalGuard({ user: { plan_tier: 'STARTER', plan_status: 'ACTIVE' } }, res, () => { ok = true; });
        assert.equal(status, 403); assert.equal(body.code, 'PLAN_FISCAL_REQUIRED'); assert.equal(ok, false);
        fiscalGuard({ user: { plan_tier: 'PRO_IA', plan_status: 'ACTIVE' } }, res, () => { ok = true; });
        assert.equal(ok, true);
        ok = false;
        fiscalGuard({ user: { plan_tier: 'PRO_IA', plan_status: 'INACTIVE' } }, res, () => { ok = true; });
        assert.equal(ok, false);
    });

    it('rotas fiscais exigem administrador', () => {
        const { routes } = build();
        const adminOnly = routes['POST /api/erp/fiscal/nfse'][0][4];
        let status = null; let ok = false;
        const res = { status(c) { status = c; return { json() {} }; } };
        adminOnly({ user: { role: 'USER' } }, res, () => { ok = true; });
        assert.equal(status, 403); assert.equal(ok, false);
    });

    it('/api/erp/access informa fiscal só para Pro AI administrador', () => {
        const { routes } = build();
        const h = routes['GET /api/erp/access'][2];
        let out; const res = { json(b) { out = b; } };
        h({ user: { plan_tier: 'PRO_IA', plan_status: 'ACTIVE', role: 'MANAGER' } }, res); assert.equal(out.fiscal, true);
        h({ user: { plan_tier: 'STARTER', plan_status: 'ACTIVE', role: 'MANAGER' } }, res); assert.equal(out.fiscal, false); assert.equal(out.finance, true);
        h({ user: { plan_tier: 'PRO_IA', plan_status: 'ACTIVE', role: 'USER' } }, res); assert.equal(out.fiscal, false);
    });

    it('Cláudia: plano sem nota fiscal e cargo comum são barrados', async () => {
        const { ai } = build();
        await assert.rejects(() => ai.run('erpEmitirNota', { ...admin, fiscalOk: false }, { pedido: '5' }), /exclusiva do plano Pro AI/);
        await assert.rejects(() => ai.run('erpConsultarNota', { ...admin, fiscalOk: false }, {}), /exclusiva do plano Pro AI/);
        await assert.rejects(() => ai.run('erpEmitirNota', { ...admin, role: 'USER' }, { pedido: '5' }), /administradores da empresa/);
        await assert.rejects(() => ai.run('erpEmitirNota', { ...admin, planOk: false }, { pedido: '5' }), /exclusivo dos planos Starter e Pro AI/);
    });
});

describe('nota fiscal: configuração', () => {
    it('não devolve o token e guarda criptografado', async () => {
        const { routes, calls } = build({ 'FROM erp_fiscal_settings': () => ({ rows: [settingsRow] }) });
        const put = routes['PUT /api/erp/fiscal/settings'][1];
        let out; let status = 200;
        const res = { status(c) { status = c; return { json(b) { out = b; } }; }, json(b) { out = b; } };
        await put({ user: { companyId: 1 }, body: { token: 'MEU-TOKEN-NOVO-999', cnpj: '11.222.333/0001-81' } }, res);
        const ins = calls.find((c) => c.sql.includes('INSERT INTO erp_fiscal_settings'));
        assert.equal(ins.params[1], 'ENC:MEU-TOKEN-NOVO-999');
        assert.equal(out.has_token, true);
        assert.equal(JSON.stringify(out).includes('TOKEN'), false);
    });

    it('produção só com tudo configurado', async () => {
        const { routes } = build({ 'FROM erp_fiscal_settings': () => ({ rows: [{ ...settingsRow, token_enc: '', cnpj: '' }] }) });
        const put = routes['PUT /api/erp/fiscal/settings'][1];
        let out; let status = 200;
        const res = { status(c) { status = c; return { json(b) { out = b; } }; }, json(b) { out = b; } };
        await put({ user: { companyId: 1 }, body: { ambiente: 'producao' } }, res);
        assert.equal(status, 400);
        assert.match(out.message, /produção, configure antes/);
    });

    it('CNPJ inválido é recusado', async () => {
        const { routes } = build();
        const put = routes['PUT /api/erp/fiscal/settings'][1];
        let out; let status = 200;
        const res = { status(c) { status = c; return { json(b) { out = b; } }; }, json(b) { out = b; } };
        await put({ user: { companyId: 1 }, body: { cnpj: '11.222.333/0001-82' } }, res);
        assert.equal(status, 400);
    });
});

describe('nota fiscal: emissão', () => {
    it('emite a nota de um pedido confirmado e chama a Focus com o token da empresa', async () => {
        let call;
        global.fetch = async (url, opts) => { call = { url, opts }; return { status: 202, json: async () => ({ status: 'processando_autorizacao' }) }; };
        const { ai } = build(emitHandlers());
        const msg = await ai.run('erpEmitirNota', admin, { pedido: '5' });
        assert.match(msg, /enviada à Focus NFe/);
        assert.match(msg, /HOMOLOGAÇÃO/);
        assert.match(call.url, /^https:\/\/homologacao\.focusnfe\.com\.br\/v2\/nfse\?ref=klweb-1-/);
        assert.equal(call.opts.headers.Authorization, `Basic ${Buffer.from('TOKEN-SECRETO-123:').toString('base64')}`);
        const body = JSON.parse(call.opts.body);
        assert.equal(body.tomador.cpf, '52998224725');
        assert.equal(body.servico.valor_servicos, 150);
        assert.equal(body.servico.discriminacao, '1 x Site institucional');
        assert.equal(body.prestador.cnpj, '11222333000181');
    });

    it('recusa pedido que já tem nota', async () => {
        global.fetch = async () => { throw new Error('não deveria chamar a Focus'); };
        const { ai } = build(emitHandlers({ 'FROM erp_fiscal_docs WHERE company_id=$1 AND order_id': () => ({ rows: [{ id: 1 }] }) }));
        await assert.rejects(() => ai.run('erpEmitirNota', admin, { pedido: '5' }), /já tem uma nota/);
    });

    it('recusa pedido em rascunho', async () => {
        const { ai } = build(emitHandlers({ 'SELECT * FROM erp_orders WHERE id': () => ({ rows: [{ ...orderRow, status: 'rascunho' }] }) }));
        await assert.rejects(() => ai.run('erpEmitirNota', admin, { pedido: '5' }), /Confirme o pedido/);
    });

    it('sem dados fiscais configurados, diz o que falta', async () => {
        const { ai } = build(emitHandlers({ 'FROM erp_fiscal_settings': () => ({ rows: [] }) }));
        await assert.rejects(() => ai.run('erpEmitirNota', admin, { pedido: '5' }), /configure os dados fiscais: token da Focus NFe, CNPJ válido/);
    });

    it('CPF inválido do cliente é barrado antes de chamar a Focus', async () => {
        global.fetch = async () => { throw new Error('não deveria chamar a Focus'); };
        const { ai } = build(emitHandlers({ 'SELECT * FROM erp_parties WHERE id': () => ({ rows: [{ ...partyRow, doc: '111.111.111-11' }] }) }));
        await assert.rejects(() => ai.run('erpEmitirNota', admin, { pedido: '5' }), /CPF ou CNPJ válido/);
    });

    it('quando a Focus recusa, grava o motivo e avisa', async () => {
        global.fetch = async () => ({ status: 422, json: async () => ({ codigo: 'requisicao_invalida', mensagem: 'Parâmetro "tomador.endereco.cep" não informado' }) });
        const { ai, calls } = build(emitHandlers());
        await assert.rejects(() => ai.run('erpEmitirNota', admin, { pedido: '5' }), /recusou o envio: Parâmetro "tomador.endereco.cep"/);
        const upd = calls.find((c) => c.sql.includes('SET status=$1, errors=$2'));
        assert.equal(upd.params[0], 'erro_envio');
    });

    it('consulta atualiza o status e mostra o link', async () => {
        global.fetch = async () => ({ status: 200, json: async () => ({ status: 'autorizado', numero: 77, codigo_verificacao: 'XYZ', url: 'https://pref.gov/nota/77' }) });
        const { ai } = build({
            'FROM erp_fiscal_docs f JOIN erp_orders': () => ({ rows: [docRow] }),
            'SELECT * FROM erp_fiscal_docs WHERE id': () => ({ rows: [docRow] }),
            'FROM erp_fiscal_settings': () => ({ rows: [settingsRow] }),
            'UPDATE erp_fiscal_docs SET status=$1, numero': (p) => ({ rows: [{ ...docRow, status: p[0], numero: p[1], codigo_verificacao: p[2], url: p[3] }] })
        });
        const msg = await ai.run('erpConsultarNota', admin, { pedido: '5' });
        assert.match(msg, /AUTORIZADA/);
        assert.match(msg, /Número 77/);
        assert.match(msg, /https:\/\/pref\.gov\/nota\/77/);
    });
});


// ---------------------------------------------------------------------------------------------
// Endereço estruturado, dados fiscais do produto e NF-e (produto)
// ---------------------------------------------------------------------------------------------
const mkRes = () => {
    const r = { status: 200, body: null };
    r.res = { status(c) { r.status = c; return { json(b) { r.body = b; } }; }, json(b) { r.body = b; } };
    return r;
};
const addr = { addr_logradouro: 'Rua A', addr_numero: '10', addr_complemento: '', addr_bairro: 'Centro', addr_cidade: 'Maringá', addr_codigo_municipio: '4115200', addr_uf: 'PR', addr_cep: '87000000' };
const nfeSettings = { ...settingsRow, inscricao_estadual: '9012345678', regime_tributario: '1', uf: 'PR', pis_cofins_situacao: '07' };
const nfeOrder = { ...orderRow, discount: '15.00', payment_method: 'Pix' };
const itemProduto = { product_id: 1, description: 'Caneta azul', qty: '10', unit_price: '5.00', total: '50.00', sku: 'C1', p_unit: 'un', is_service: false, ncm: '96081000', cest: '', cfop: '5102', origem: '0', icms_situacao: '102', icms_aliquota: '0' };
const itemServico = { product_id: 2, description: 'Instalação', qty: '1', unit_price: '100.00', total: '100.00', is_service: true };
const nfeHandlers = (extra = {}) => ({
    'FROM erp_fiscal_settings': () => ({ rows: [nfeSettings] }),
    'SELECT id FROM erp_orders': () => ({ rows: [{ id: 9 }] }),
    'SELECT * FROM erp_orders WHERE id': () => ({ rows: [nfeOrder] }),
    'FROM erp_fiscal_docs WHERE company_id=$1 AND order_id': () => ({ rows: [] }),
    'FROM erp_order_items i': () => ({ rows: [itemProduto, itemServico] }),
    'SELECT * FROM erp_parties WHERE id': () => ({ rows: [{ ...partyRow, ...addr }] }),
    'INSERT INTO erp_fiscal_docs': () => ({ rows: [{ ...docRow, kind: 'nfe', amount: '45.00', status: 'enviando' }] }),
    "SET status='processando_autorizacao'": () => ({ rows: [{ ...docRow, kind: 'nfe', amount: '45.00' }] }),
    ...extra
});

describe('endereço estruturado do cliente', () => {
    it('salva o endereço no cadastro e devolve como objeto', async () => {
        const { routes, calls } = build({ 'INSERT INTO erp_parties': (p) => ({ rows: [{ id: 1, kind: 'cliente', name: p[2], doc: p[3], phone: '', email: '', address: '', notes: '', active: true, addr_logradouro: p[9], addr_cep: p[16], addr_uf: p[15] }] }) });
        const post = routes['POST /api/erp/parties'][1];
        const r = mkRes();
        await post({ user: { companyId: 1 }, body: { name: 'Maria', endereco: { logradouro: 'Rua A', numero: '10', uf: 'pr', cep: '87.000-000', codigo_municipio: '4115200' } } }, r.res);
        const ins = calls.find((c) => c.sql.includes('INSERT INTO erp_parties'));
        assert.equal(ins.params[9], 'Rua A');
        assert.equal(ins.params[15], 'PR');
        assert.equal(ins.params[16], '87000000');
        assert.equal(r.body.endereco.cep, '87000000');
        assert.equal(r.body.endereco.logradouro, 'Rua A');
    });

    it('recusa CEP, UF e código IBGE inválidos', async () => {
        const { routes } = build();
        const post = routes['POST /api/erp/parties'][1];
        for (const endereco of [{ cep: '123' }, { uf: 'XX' }, { codigo_municipio: '12' }]) {
            const r = mkRes();
            await post({ user: { companyId: 1 }, body: { name: 'Maria', endereco } }, r.res);
            assert.equal(r.status, 400, JSON.stringify(endereco));
        }
    });

    it('editar sem mandar endereço não apaga o que já está salvo', async () => {
        const { routes, calls } = build({ 'UPDATE erp_parties': () => ({ rows: [{ ...partyRow, ...addr }] }) });
        const put = routes['PUT /api/erp/parties/:id'][1];
        const r = mkRes();
        await put({ user: { companyId: 1 }, params: { id: '4' }, body: { name: 'Maria da Silva' } }, r.res);
        const upd = calls.find((c) => c.sql.includes('UPDATE erp_parties'));
        assert.deepEqual(upd.params.slice(10), Array(8).fill(null));
        assert.match(upd.sql, /COALESCE\(\$11, addr_logradouro\)/);
        assert.equal(r.body.endereco.bairro, 'Centro');
    });

    it('rota de CEP usa a consulta e devolve 404 quando não acha', async () => {
        const { routes } = build({}, { cepLookup: async (c) => (c === '87000000' ? { logradouro: 'Rua A', bairro: 'Centro', cidade: 'Maringá', uf: 'PR', codigo_municipio: '4115200', cep: c } : null) });
        const h = routes['GET /api/erp/cep/:cep'][1];
        const ok = mkRes(); await h({ params: { cep: '87000000' } }, ok.res);
        assert.equal(ok.body.codigo_municipio, '4115200');
        const no = mkRes(); await h({ params: { cep: '00000000' } }, no.res);
        assert.equal(no.status, 404);
    });

    it('a NFS-e leva o endereço salvo no cadastro do cliente', async () => {
        let call;
        global.fetch = async (url, opts) => { call = { url, opts }; return { status: 202, json: async () => ({}) }; };
        const { ai } = build(emitHandlers({ 'SELECT * FROM erp_parties WHERE id': () => ({ rows: [{ ...partyRow, ...addr }] }) }));
        await ai.run('erpEmitirNota', admin, { pedido: '5' });
        const body = JSON.parse(call.opts.body);
        assert.deepEqual(body.tomador.endereco, { logradouro: 'Rua A', numero: '10', bairro: 'Centro', codigo_municipio: '4115200', uf: 'PR', cep: '87000000' });
    });
});

describe('dados fiscais do produto', () => {
    it('salva NCM, CFOP, origem e ICMS junto com o produto', async () => {
        const { routes, calls } = build({ 'INSERT INTO erp_products': () => ({ rows: [{ id: 1, name: 'Caneta', cost_price: 1, sale_price: 2, stock: 0, min_stock: 0, active: true, ncm: '96081000', cfop: '5102', origem: '0', icms_situacao: '102', icms_aliquota: 0 }] }) });
        const post = routes['POST /api/erp/products'][1];
        const r = mkRes();
        await post({ user: { companyId: 1, id: 7 }, body: { name: 'Caneta', sale_price: 2, ncm: '9608.10.00', cfop: '5102', origem: '0', icms_situacao: '102' } }, r.res);
        const ins = calls.find((c) => c.sql.includes('INSERT INTO erp_products'));
        assert.deepEqual(ins.params.slice(11), ['96081000', '', '5102', '0', '102', 0]);
        assert.equal(r.body.ncm, '96081000');
        assert.equal(r.body.icms_situacao, '102');
    });

    it('editar sem mandar os campos fiscais não apaga nada', async () => {
        const { routes, calls } = build({ 'UPDATE erp_products': () => ({ rows: [{ id: 1, name: 'Caneta', cost_price: 1, sale_price: 2, stock: 0, min_stock: 0, active: true }] }) });
        const put = routes['PUT /api/erp/products/:id'][1];
        const r = mkRes();
        await put({ user: { companyId: 1 }, params: { id: '1' }, body: { name: 'Caneta', sale_price: 3 } }, r.res);
        const upd = calls.find((c) => c.sql.includes('UPDATE erp_products SET'));
        assert.deepEqual(upd.params.slice(11), Array(6).fill(null));
    });

    it('recusa NCM, CFOP, origem e CST/CSOSN inválidos', async () => {
        const { routes } = build();
        const post = routes['POST /api/erp/products'][1];
        for (const extra of [{ ncm: '123' }, { cfop: '51' }, { origem: '9' }, { icms_situacao: 'ab' }, { icms_aliquota: '120' }]) {
            const r = mkRes();
            await post({ user: { companyId: 1, id: 7 }, body: { name: 'X', ...extra } }, r.res);
            assert.equal(r.status, 400, JSON.stringify(extra));
        }
    });
});

describe('NF-e: configuração fiscal da empresa', () => {
    it('guarda inscrição estadual, regime, UF e PIS/COFINS', async () => {
        const { routes, calls } = build({ 'FROM erp_fiscal_settings': () => ({ rows: [nfeSettings] }) });
        const put = routes['PUT /api/erp/fiscal/settings'][1];
        const r = mkRes();
        await put({ user: { companyId: 1 }, body: { inscricao_estadual: '9012345678', regime_tributario: '1', uf: 'pr', pis_cofins_situacao: '07' } }, r.res);
        const ins = calls.find((c) => c.sql.includes('INSERT INTO erp_fiscal_settings'));
        assert.deepEqual(ins.params.slice(13), ['9012345678', '1', 'PR', '07']);
        assert.equal(r.body.uf, 'PR');
    });

    it('recusa regime, UF e PIS/COFINS inválidos', async () => {
        const { routes } = build();
        const put = routes['PUT /api/erp/fiscal/settings'][1];
        for (const body of [{ regime_tributario: '7' }, { uf: 'ZZ' }, { pis_cofins_situacao: '01' }]) {
            const r = mkRes();
            await put({ user: { companyId: 1 }, body }, r.res);
            assert.equal(r.status, 400, JSON.stringify(body));
        }
    });
});

describe('NF-e: emissão', () => {
    it('rota exige Pro AI e administrador', () => {
        const { routes } = build();
        const chain = routes['POST /api/erp/fiscal/nfe'][0];
        const r = mkRes(); let ok = false;
        chain[3]({ user: { plan_tier: 'STARTER', plan_status: 'ACTIVE' } }, r.res, () => { ok = true; });
        assert.equal(r.status, 403); assert.equal(r.body.code, 'PLAN_FISCAL_REQUIRED'); assert.equal(ok, false);
        const r2 = mkRes();
        chain[4]({ user: { role: 'USER' } }, r2.res, () => { ok = true; });
        assert.equal(r2.status, 403); assert.equal(ok, false);
    });

    it('emite só os produtos do pedido, rateia o desconto e chama /v2/nfe', async () => {
        let call;
        global.fetch = async (url, opts) => { call = { url, opts }; return { status: 202, json: async () => ({ status: 'processando_autorizacao' }) }; };
        const { ai, calls } = build(nfeHandlers());
        const msg = await ai.run('erpEmitirNfe', admin, { pedido: '5' });
        assert.match(msg, /NF-e de R\$\s?45,00 enviada à Focus NFe/);
        assert.match(msg, /HOMOLOGAÇÃO/);
        assert.match(call.url, /^https:\/\/homologacao\.focusnfe\.com\.br\/v2\/nfe\?ref=klweb-1-/);
        const body = JSON.parse(call.opts.body);
        assert.equal(body.items.length, 1);
        assert.equal(body.items[0].descricao, 'Caneta azul');
        assert.equal(body.items[0].valor_bruto, 50);
        assert.equal(body.items[0].valor_desconto, 5);
        assert.equal(body.valor_total, 45);
        assert.deepEqual(body.formas_pagamento, [{ forma_pagamento: '17', valor_pagamento: 45 }]);
        assert.equal(body.cpf_destinatario, '52998224725');
        assert.equal(body.local_destino, 1);
        assert.equal(body.regime_tributario_emitente, 1);
        const ins = calls.find((c) => c.sql.includes('INSERT INTO erp_fiscal_docs'));
        assert.equal(ins.params[1], 'nfe');
        assert.equal(ins.params[5], 45);
    });

    it('sem os dados fiscais da empresa, diz o que falta', async () => {
        global.fetch = async () => { throw new Error('não deveria chamar a Focus'); };
        const { ai } = build(nfeHandlers({ 'FROM erp_fiscal_settings': () => ({ rows: [{ ...nfeSettings, inscricao_estadual: '', uf: '' }] }) }));
        await assert.rejects(() => ai.run('erpEmitirNfe', admin, { pedido: '5' }), /configure os dados fiscais: inscrição estadual, UF da empresa/);
    });

    it('endereço incompleto do cliente é barrado antes de chamar a Focus', async () => {
        global.fetch = async () => { throw new Error('não deveria chamar a Focus'); };
        const { ai } = build(nfeHandlers({ 'SELECT * FROM erp_parties WHERE id': () => ({ rows: [{ ...partyRow, addr_uf: 'PR' }] }) }));
        await assert.rejects(() => ai.run('erpEmitirNfe', admin, { pedido: '5' }), /endereço completo do cliente.*"Maria da Silva" falta: logradouro, número, bairro, código IBGE do município, CEP/);
    });

    it('produto sem NCM e CFOP incompatível com a UF são barrados', async () => {
        global.fetch = async () => { throw new Error('não deveria chamar a Focus'); };
        const semNcm = build(nfeHandlers({ 'FROM erp_order_items i': () => ({ rows: [{ ...itemProduto, ncm: '' }] }) }));
        await assert.rejects(() => semNcm.ai.run('erpEmitirNfe', admin, { pedido: '5' }), /"Caneta azul": falta NCM/);
        const outraUf = build(nfeHandlers({ 'SELECT * FROM erp_parties WHERE id': () => ({ rows: [{ ...partyRow, ...addr, addr_uf: 'SP' }] }) }));
        await assert.rejects(() => outraUf.ai.run('erpEmitirNfe', admin, { pedido: '5' }), /CFOP 5102 é de operação dentro do estado/);
    });

    it('pedido só de serviços e item sem produto cadastrado são recusados', async () => {
        const soServico = build(nfeHandlers({ 'FROM erp_order_items i': () => ({ rows: [itemServico] }) }));
        await assert.rejects(() => soServico.ai.run('erpEmitirNfe', admin, { pedido: '5' }), /só tem serviços/);
        const avulso = build(nfeHandlers({ 'FROM erp_order_items i': () => ({ rows: [{ ...itemProduto, product_id: null }] }) }));
        await assert.rejects(() => avulso.ai.run('erpEmitirNfe', admin, { pedido: '5' }), /não são produtos cadastrados/);
    });

    it('recusa rascunho, pedido de compra e NF-e duplicada (mas a NFS-e não conta como duplicada)', async () => {
        const rascunho = build(nfeHandlers({ 'SELECT * FROM erp_orders WHERE id': () => ({ rows: [{ ...nfeOrder, status: 'rascunho' }] }) }));
        await assert.rejects(() => rascunho.ai.run('erpEmitirNfe', admin, { pedido: '5' }), /Confirme o pedido/);
        const compra = build(nfeHandlers({ 'SELECT * FROM erp_orders WHERE id': () => ({ rows: [{ ...nfeOrder, type: 'compra' }] }) }));
        await assert.rejects(() => compra.ai.run('erpEmitirNfe', admin, { pedido: '5' }), /pedidos de venda/);
        const dup = build(nfeHandlers({ 'FROM erp_fiscal_docs WHERE company_id=$1 AND order_id': () => ({ rows: [{ id: 1 }] }) }));
        await assert.rejects(() => dup.ai.run('erpEmitirNfe', admin, { pedido: '5' }), /já tem uma NF-e/);
        global.fetch = async () => ({ status: 202, json: async () => ({}) });
        const b = build(nfeHandlers());
        await b.ai.run('erpEmitirNfe', admin, { pedido: '5' });
        const q = b.calls.find((c) => c.sql.includes('FROM erp_fiscal_docs WHERE company_id=$1 AND order_id'));
        assert.match(q.sql, /kind=\$3/);
        assert.deepEqual(q.params, [1, 9, 'nfe']);
    });

    it('quando a Focus recusa a NF-e, grava o motivo', async () => {
        global.fetch = async () => ({ status: 422, json: async () => ({ codigo: 'requisicao_invalida', mensagem: 'NCM inexistente' }) });
        const { ai, calls } = build(nfeHandlers());
        await assert.rejects(() => ai.run('erpEmitirNfe', admin, { pedido: '5' }), /recusou o envio: NCM inexistente/);
        assert.equal(calls.find((c) => c.sql.includes('SET status=$1, errors=$2')).params[0], 'erro_envio');
    });

    it('Cláudia: plano sem nota fiscal e cargo comum são barrados na NF-e', async () => {
        const { ai } = build();
        await assert.rejects(() => ai.run('erpEmitirNfe', { ...admin, fiscalOk: false }, { pedido: '5' }), /exclusiva do plano Pro AI/);
        await assert.rejects(() => ai.run('erpEmitirNfe', { ...admin, role: 'USER' }, { pedido: '5' }), /administradores da empresa/);
        await assert.rejects(() => ai.run('erpEmitirNfe', admin, {}), /número do pedido/);
    });

    it('consulta da NF-e usa /v2/nfe, grava chave e DANFE e mostra tudo', async () => {
        let url;
        global.fetch = async (u) => { url = u; return { status: 200, json: async () => ({ status: 'autorizado', numero: 12, serie: 1, chave_nfe: 'NFe4126', caminho_danfe: '/arquivos/d.pdf' }) }; };
        const nfeDoc = { ...docRow, kind: 'nfe', ref: 'klweb-1-nfe' };
        const { ai, calls } = build({
            'FROM erp_fiscal_docs f JOIN erp_orders': () => ({ rows: [nfeDoc] }),
            'SELECT * FROM erp_fiscal_docs WHERE id': () => ({ rows: [nfeDoc] }),
            'FROM erp_fiscal_settings': () => ({ rows: [nfeSettings] }),
            'UPDATE erp_fiscal_docs SET status=$1, numero': (p) => ({ rows: [{ ...nfeDoc, status: p[0], numero: p[1], chave: p[8], serie: p[9], danfe_url: p[10] }] })
        });
        const msg = await ai.run('erpConsultarNota', admin, { pedido: '5' });
        assert.match(url, /\/v2\/nfe\/klweb-1-nfe$/);
        assert.match(msg, /NF-e de .*AUTORIZADA/);
        assert.match(msg, /Chave de acesso: NFe4126/);
        assert.match(msg, /DANFE: https:\/\/homologacao\.focusnfe\.com\.br\/arquivos\/d\.pdf/);
        const upd = calls.find((c) => c.sql.includes('UPDATE erp_fiscal_docs SET status=$1, numero'));
        assert.deepEqual(upd.params.slice(8), ['NFe4126', '1', 'https://homologacao.focusnfe.com.br/arquivos/d.pdf']);
    });
});