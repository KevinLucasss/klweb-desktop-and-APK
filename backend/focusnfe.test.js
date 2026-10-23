const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const f = require('./focusnfe');

describe('Focus NFe: ambiente e autenticação', () => {
    it('produção só quando pedido; qualquer outra coisa cai em homologação', () => {
        assert.equal(f.baseUrl('producao'), 'https://api.focusnfe.com.br');
        assert.equal(f.baseUrl('homologacao'), 'https://homologacao.focusnfe.com.br');
        assert.equal(f.baseUrl('xyz'), 'https://homologacao.focusnfe.com.br');
        assert.equal(f.baseUrl(undefined), 'https://homologacao.focusnfe.com.br');
    });

    it('usa HTTP Basic com o token como usuário e senha em branco', async () => {
        let seen;
        const fetchImpl = async (url, opts) => { seen = { url, opts }; return { status: 202, json: async () => ({ status: 'processando_autorizacao' }) }; };
        const r = await f.focusRequest({ token: 'TOKEN123', ambiente: 'homologacao', method: 'POST', path: '/v2/nfse?ref=abc', body: { a: 1 }, fetchImpl });
        assert.equal(r.status, 202);
        assert.equal(seen.url, 'https://homologacao.focusnfe.com.br/v2/nfse?ref=abc');
        assert.equal(seen.opts.headers.Authorization, `Basic ${Buffer.from('TOKEN123:').toString('base64')}`);
        assert.equal(seen.opts.body, JSON.stringify({ a: 1 }));
    });

    it('erro de rede vira mensagem amigável e o token não aparece nela', async () => {
        const fetchImpl = async () => { throw new Error('socket hang up TOKEN123'); };
        await assert.rejects(
            () => f.focusRequest({ token: 'TOKEN123', ambiente: 'producao', method: 'GET', path: '/v2/nfse/x', fetchImpl }),
            (e) => e.status === 502 && !/TOKEN123/.test(e.message));
    });

    it('sem token não chama a API', async () => {
        await assert.rejects(() => f.focusRequest({ token: '', method: 'GET', path: '/x', fetchImpl: async () => { throw new Error('não deveria'); } }), /Token/);
    });
});

describe('Focus NFe: validações', () => {
    it('valida CPF e CNPJ de verdade (dígitos verificadores)', () => {
        assert.equal(f.isValidCPF('529.982.247-25'), true);
        assert.equal(f.isValidCPF('111.111.111-11'), false);
        assert.equal(f.isValidCPF('529.982.247-24'), false);
        assert.equal(f.isValidCNPJ('11.222.333/0001-81'), true);
        assert.equal(f.isValidCNPJ('11.222.333/0001-82'), false);
        assert.equal(f.isValidCNPJ('00000000000000'), false);
    });

    it('gera referências únicas', () => {
        const a = f.newRef(7); const b = f.newRef(7);
        assert.match(a, /^klweb-7-\d{14}-[a-f0-9]{6}$/);
        assert.notEqual(a, b);
    });

    it('aponta o que falta configurar', () => {
        assert.deepEqual(f.missingSettings({}), ['token da Focus NFe', 'CNPJ válido', 'inscrição municipal', 'código IBGE do município (7 dígitos)', 'item da lista de serviços']);
        assert.deepEqual(f.missingSettings({ has_token: true, cnpj: '11222333000181', inscricao_municipal: '123', codigo_municipio: '4104303', item_lista_servico: '14.01' }), []);
    });
});

describe('Focus NFe: payload da NFS-e', () => {
    const settings = { cnpj: '11.222.333/0001-81', inscricao_municipal: '123445', codigo_municipio: '4104303', optante_simples: true, natureza_operacao: '1', item_lista_servico: '14.01', aliquota: 2.5, iss_retido: false, regime_especial: '6', codigo_tributario_municipio: '620910000' };

    it('monta o formato que a Focus espera', () => {
        const p = f.buildNfsePayload({
            settings,
            tomador: { documento: '529.982.247-25', razao_social: 'Maria da Silva', email: 'm@x.com', endereco: { logradouro: 'Rua A', numero: '10', bairro: 'Centro', codigo_municipio: '4104303', uf: 'pr', cep: '87.300-000' } },
            servico: { discriminacao: 'Manutenção de site', valor: 150.456 },
            now: new Date('2026-10-22T15:00:00Z')
        });
        assert.equal(p.data_emissao, '2026-10-22T12:00:00-03:00');
        assert.deepEqual(p.prestador, { cnpj: '11222333000181', inscricao_municipal: '123445', codigo_municipio: '4104303' });
        assert.equal(p.tomador.cpf, '52998224725');
        assert.equal(p.tomador.cnpj, undefined);
        assert.deepEqual(p.tomador.endereco, { logradouro: 'Rua A', numero: '10', bairro: 'Centro', codigo_municipio: '4104303', uf: 'PR', cep: '87300000' });
        assert.deepEqual(p.servico, { aliquota: 2.5, discriminacao: 'Manutenção de site', iss_retido: false, item_lista_servico: '14.01', valor_servicos: 150.46, codigo_tributario_municipio: '620910000' });
        assert.equal(p.optante_simples_nacional, true);
        assert.equal(p.regime_especial_tributacao, '6');
        assert.equal(p.natureza_operacao, '1');
    });

    it('usa cnpj para tomador de 14 dígitos e omite endereço vazio', () => {
        const p = f.buildNfsePayload({ settings, tomador: { documento: '11222333000181', razao_social: 'Empresa X' }, servico: { discriminacao: 'x', valor: 10 } });
        assert.equal(p.tomador.cnpj, '11222333000181');
        assert.equal(p.tomador.endereco, undefined);
    });
});

describe('Focus NFe: respostas', () => {
    it('interpreta nota autorizada', () => {
        const r = f.parseStatus({ status: 'autorizado', numero: 14, codigo_verificacao: 'ABC', url: 'https://pref/nota', caminho_xml_nota_fiscal: '/arquivos/x.xml' }, 'homologacao');
        assert.equal(r.status, 'autorizado');
        assert.equal(r.numero, '14');
        assert.equal(r.url, 'https://pref/nota');
        assert.equal(r.xml_url, 'https://homologacao.focusnfe.com.br/arquivos/x.xml');
    });

    it('junta os erros da prefeitura em um texto', () => {
        assert.equal(f.errosToText({ erros: [{ codigo: 'E1', mensagem: 'Inscrição inválida' }, { mensagem: 'Inscrição inválida' }, { mensagem: 'CEP faltando' }] }), 'Inscrição inválida | CEP faltando');
        assert.equal(f.errosToText({ codigo: 'requisicao_invalida', mensagem: 'Parâmetro "prestador.codigo_municipio" não informado' }), 'Parâmetro "prestador.codigo_municipio" não informado');
    });
});


describe('Focus NFe: NF-e de produto', () => {
    const settings = { cnpj: '11222333000181', inscricao_estadual: '9012345678', regime_tributario: '1', uf: 'PR', pis_cofins_situacao: '07' };
    const dest = { documento: '529.982.247-25', nome: 'Maria da Silva', email: 'm@x.com', endereco: { logradouro: 'Rua A', numero: '10', bairro: 'Centro', cidade: 'Maringá', codigo_municipio: '4115200', uf: 'pr', cep: '87.000-000' } };
    const item = { codigo: 'CAN-1', nome: 'Caneta azul', unidade: 'un', qtd: 3, valor_unitario: 2.5, desconto: 0.5, ncm: '9608.10.00', cfop: '5102', origem: '0', icms_situacao: '102' };

    it('monta o payload do Simples Nacional', () => {
        const p = f.buildNfePayload({ settings, destinatario: dest, itens: [item], pagamento: { forma: '17' }, now: new Date('2026-10-22T15:00:00Z') });
        assert.equal(p.cnpj_emitente, '11222333000181');
        assert.equal(p.regime_tributario_emitente, 1);
        assert.equal(p.cpf_destinatario, '52998224725');
        assert.equal(p.cnpj_destinatario, undefined);
        assert.equal(p.local_destino, 1);
        assert.equal(p.uf_destinatario, 'PR');
        assert.equal(p.cep_destinatario, '87000000');
        assert.equal(p.municipio_destinatario, 'Maringá');
        const it = p.items[0];
        assert.equal(it.codigo_ncm, '96081000');
        assert.equal(it.valor_bruto, 7.5);
        assert.equal(it.valor_desconto, 0.5);
        assert.equal(it.icms_situacao_tributaria, '102');
        assert.equal(it.icms_base_calculo, undefined);
        assert.equal(it.pis_situacao_tributaria, '07');
        assert.deepEqual([p.valor_produtos, p.valor_desconto, p.valor_total], [7.5, 0.5, 7]);
        assert.deepEqual(p.formas_pagamento, [{ forma_pagamento: '17', valor_pagamento: 7 }]);
    });

    it('marca operação interestadual e calcula ICMS no CST 00 do Regime Normal', () => {
        const normal = { ...settings, regime_tributario: '3' };
        const d = { ...dest, endereco: { ...dest.endereco, uf: 'SP' } };
        const p = f.buildNfePayload({ settings: normal, destinatario: d, itens: [{ ...item, cfop: '6102', desconto: 0, icms_situacao: '00', icms_aliquota: 12 }], pagamento: { forma: '01' } });
        assert.equal(p.local_destino, 2);
        assert.deepEqual([p.items[0].icms_base_calculo, p.items[0].icms_aliquota, p.items[0].icms_valor], [7.5, 12, 0.9]);
    });

    it('usa cnpj para destinatário pessoa jurídica', () => {
        const p = f.buildNfePayload({ settings, destinatario: { ...dest, documento: '11222333000181' }, itens: [item], pagamento: { forma: '99' } });
        assert.equal(p.cnpj_destinatario, '11222333000181');
        assert.equal(p.cpf_destinatario, undefined);
    });

    it('aponta o que falta na configuração da NF-e', () => {
        assert.deepEqual(f.missingNfeSettings({}), ['token da Focus NFe', 'CNPJ válido', 'inscrição estadual', 'regime tributário (Simples Nacional ou Normal)', 'UF da empresa', 'situação tributária de PIS/COFINS (04 a 09)']);
        assert.deepEqual(f.missingNfeSettings({ ...settings, has_token: true }), []);
    });

    it('aponta endereço incompleto', () => {
        assert.deepEqual(f.missingAddress({}), ['logradouro', 'número', 'bairro', 'código IBGE do município', 'UF', 'CEP']);
        assert.deepEqual(f.missingAddress(dest.endereco), []);
    });

    it('confere NCM, CFOP e situação tributária de cada produto', () => {
        const ok = { regime: '1', ufEmitente: 'PR', ufDestino: 'PR' };
        assert.deepEqual(f.productFiscalProblems([item], ok), []);
        assert.match(f.productFiscalProblems([{ ...item, ncm: '' }], ok)[0], /falta NCM/);
        assert.match(f.productFiscalProblems([{ ...item, cfop: '6102' }], ok)[0], /mesma UF/);
        assert.match(f.productFiscalProblems([item], { ...ok, ufDestino: 'SP' })[0], /outra UF \(SP\)/);
        assert.match(f.productFiscalProblems([{ ...item, cfop: '1102' }], ok)[0], /começar com 5 ou 6/);
        assert.match(f.productFiscalProblems([{ ...item, icms_situacao: '101' }], ok)[0], /CSOSN 101 ainda não é suportado/);
        assert.match(f.productFiscalProblems([{ ...item, icms_situacao: '102' }], { ...ok, regime: '3' })[0], /CST 102 ainda não é suportado/);
        assert.match(f.productFiscalProblems([{ ...item, icms_situacao: '00', icms_aliquota: 0 }], { ...ok, regime: '3' })[0], /exige a alíquota/);
    });

    it('distribui o desconto em centavos sem perder nem sobrar', () => {
        const parts = f.allocateDiscount([100, 50, 50], 10);
        assert.deepEqual(parts, [5, 2.5, 2.5]);
        const odd = f.allocateDiscount([10, 10, 10], 0.1);
        assert.equal(Math.round(odd.reduce((a, b) => a + b, 0) * 100), 10);
        assert.deepEqual(f.allocateDiscount([10, 20], 0), [0, 0]);
    });

    it('traduz a forma de pagamento e escolhe o endereço da API', () => {
        assert.equal(f.formaPagamentoNfe('PIX'), '17');
        assert.equal(f.formaPagamentoNfe('Cartão de crédito'), '03');
        assert.equal(f.formaPagamentoNfe('cartao de debito'), '04');
        assert.equal(f.formaPagamentoNfe('Boleto'), '15');
        assert.equal(f.formaPagamentoNfe(''), '99');
        assert.equal(f.docPath('nfe', 'abc'), '/v2/nfe/abc');
        assert.equal(f.docPath('nfse'), '/v2/nfse');
    });

    it('lê chave, série e DANFE da resposta', () => {
        const r = f.parseStatus({ status: 'autorizado', numero: 12, serie: 1, chave_nfe: 'NFe4126', caminho_danfe: '/arquivos/d.pdf' }, 'producao');
        assert.equal(r.chave, 'NFe4126');
        assert.equal(r.serie, '1');
        assert.equal(r.danfe_url, 'https://api.focusnfe.com.br/arquivos/d.pdf');
    });
});