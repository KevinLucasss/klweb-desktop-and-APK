// backend/focusnfe.js
// Integração com a Focus NFe (https://focusnfe.com.br/doc) para NFS-e (nota fiscal de SERVIÇO).
//
// Como a Focus funciona (resumo):
//  - Autenticação HTTP Basic: o TOKEN vai como usuário e a senha fica em branco.
//  - Dois ambientes: homologação (testes, sem validade fiscal) e produção.
//  - A emissão é ASSÍNCRONA: o POST devolve 202 "processando_autorizacao" e depois você CONSULTA pela mesma
//    referência (ref) até virar "autorizado" ou "erro_autorizacao". A ref precisa ser única por token.
//  - Cada empresa (CNPJ) tem o seu token no painel da Focus. Aqui, cada empresa do KL Web usa o PRÓPRIO token.
//  - Os campos exigidos variam de município para município; por isso os erros da Focus são repassados ao usuário.
//
// Este módulo não conhece banco nem Express: só monta o payload, fala com a API e interpreta a resposta.
// Cobre NFS-e (serviço, /v2/nfse) e NF-e (produto, /v2/nfe). A NF-e aqui cobre vendas simples:
//  - Simples Nacional sem cálculo de ICMS (CSOSN 102, 103, 300, 400 ou 500) ou Regime Normal com CST 00, 40, 41, 50 ou 60;
//  - PIS/COFINS sem valor (CST 04 a 09). Casos com ST, IPI, crédito de ICMS etc. são recusados com mensagem clara.

const crypto = require('crypto');

const BASE_URLS = {
    producao: 'https://api.focusnfe.com.br',
    homologacao: 'https://homologacao.focusnfe.com.br'
};

const AMBIENTES = Object.keys(BASE_URLS);

function baseUrl(ambiente) {
    return BASE_URLS[ambiente] || BASE_URLS.homologacao; // na dúvida, nunca cai em produção
}

// ---------- helpers puros ----------
const onlyDigits = (v) => String(v === undefined || v === null ? '' : v).replace(/\D/g, '');
const round2 = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;

function isValidCPF(v) {
    const c = onlyDigits(v);
    if (c.length !== 11 || /^(\d)\1+$/.test(c)) return false;
    for (const len of [9, 10]) {
        let sum = 0;
        for (let i = 0; i < len; i++) sum += Number(c[i]) * (len + 1 - i);
        const d = ((sum * 10) % 11) % 10;
        if (d !== Number(c[len])) return false;
    }
    return true;
}

function isValidCNPJ(v) {
    const c = onlyDigits(v);
    if (c.length !== 14 || /^(\d)\1+$/.test(c)) return false;
    const calc = (len) => {
        const weights = len === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
        const sum = weights.reduce((s, w, i) => s + Number(c[i]) * w, 0);
        const r = sum % 11;
        return r < 2 ? 0 : 11 - r;
    };
    return calc(12) === Number(c[12]) && calc(13) === Number(c[13]);
}

/** Gera uma referência única e estável de ler: klweb-<empresa>-<aaaammddhhmmss>-<6 hex>. */
function newRef(companyId, now = new Date()) {
    const stamp = now.toISOString().replace(/\D/g, '').slice(0, 14);
    return `klweb-${companyId}-${stamp}-${crypto.randomBytes(3).toString('hex')}`;
}

/** Data/hora no fuso de Brasília (-03:00), no formato que a Focus espera. */
function dataEmissaoBrasilia(now = new Date()) {
    const br = new Date(now.getTime() - 3 * 3600 * 1000);
    return `${br.toISOString().slice(0, 19)}-03:00`;
}

/**
 * Monta o JSON de NFS-e no formato da Focus.
 *  settings: dados fiscais da empresa prestadora (cnpj, inscricao_municipal, codigo_municipio, ...)
 *  tomador:  { documento, razao_social, email, telefone, endereco: { logradouro, numero, complemento, bairro, codigo_municipio, uf, cep } }
 *  servico:  { discriminacao, valor }
 */
function buildNfsePayload({ settings, tomador, servico, now = new Date() }) {
    const doc = onlyDigits(tomador.documento);
    const tom = { razao_social: tomador.razao_social };
    if (doc.length === 14) tom.cnpj = doc; else if (doc.length === 11) tom.cpf = doc;
    if (tomador.email) tom.email = tomador.email;
    if (tomador.telefone) tom.telefone = onlyDigits(tomador.telefone);

    const e = tomador.endereco || {};
    const end = {};
    if (e.logradouro) end.logradouro = e.logradouro;
    if (e.numero) end.numero = e.numero;
    if (e.complemento) end.complemento = e.complemento;
    if (e.bairro) end.bairro = e.bairro;
    if (e.codigo_municipio) end.codigo_municipio = onlyDigits(e.codigo_municipio);
    if (e.uf) end.uf = String(e.uf).toUpperCase().slice(0, 2);
    if (e.cep) end.cep = onlyDigits(e.cep);
    if (Object.keys(end).length) tom.endereco = end;

    const valor = Math.round((Number(servico.valor) + Number.EPSILON) * 100) / 100;
    const payload = {
        data_emissao: dataEmissaoBrasilia(now),
        natureza_operacao: String(settings.natureza_operacao || '1'),
        optante_simples_nacional: !!settings.optante_simples,
        prestador: {
            cnpj: onlyDigits(settings.cnpj),
            inscricao_municipal: String(settings.inscricao_municipal || '').trim(),
            codigo_municipio: onlyDigits(settings.codigo_municipio)
        },
        tomador: tom,
        servico: {
            aliquota: Number(settings.aliquota) || 0,
            discriminacao: String(servico.discriminacao || '').slice(0, 2000),
            iss_retido: !!settings.iss_retido,
            item_lista_servico: String(settings.item_lista_servico || '').trim(),
            valor_servicos: valor
        }
    };
    if (settings.codigo_tributario_municipio) payload.servico.codigo_tributario_municipio = String(settings.codigo_tributario_municipio).trim();
    if (settings.regime_especial) payload.regime_especial_tributacao = String(settings.regime_especial);
    return payload;
}

/** Lista o que falta configurar para a empresa poder emitir (vazia = pronta). */
function missingSettings(s) {
    const faltam = [];
    if (!s || !s.has_token) faltam.push('token da Focus NFe');
    if (!isValidCNPJ(s && s.cnpj)) faltam.push('CNPJ válido');
    if (!String((s && s.inscricao_municipal) || '').trim()) faltam.push('inscrição municipal');
    if (onlyDigits(s && s.codigo_municipio).length !== 7) faltam.push('código IBGE do município (7 dígitos)');
    if (!String((s && s.item_lista_servico) || '').trim()) faltam.push('item da lista de serviços');
    return faltam;
}


// ---------- NF-e (nota fiscal de PRODUTO) ----------
const UFS = ['AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO'];
const isUF = (v) => UFS.includes(String(v || '').toUpperCase());

// Situações tributárias de ICMS que este módulo sabe montar sem cálculo extra.
const CSOSN_SUPORTADOS = ['102', '103', '300', '400', '500'];   // Simples Nacional
const CST_ICMS_SUPORTADOS = ['00', '40', '41', '50', '60'];     // Regime Normal
const PIS_COFINS_SEM_VALOR = ['04', '05', '06', '07', '08', '09'];

// Regime tributário do emitente (CRT): 1 = Simples Nacional, 2 = Simples (excesso de sublimite), 3 = Regime Normal.
const isSimples = (regime) => ['1', '2'].includes(String(regime));

// Forma de pagamento do pedido (texto livre do ERP) -> código da NF-e.
function formaPagamentoNfe(texto) {
    const t = String(texto || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    if (/pix/.test(t)) return '17';
    if (/boleto/.test(t)) return '15';
    if (/(cartao|card).*(credito|credit)|credito/.test(t)) return '03';
    if (/(cartao|card).*(debito|debit)|debito/.test(t)) return '04';
    if (/dinheiro|especie/.test(t)) return '01';
    if (/cheque/.test(t)) return '02';
    if (/transfer|ted|doc/.test(t)) return '18';
    if (/deposito/.test(t)) return '16';
    return '99'; // outros
}

/** Endereço do destinatário completo? Devolve o que falta (vazio = ok). */
function missingAddress(e) {
    const a = e || {};
    const faltam = [];
    if (!String(a.logradouro || '').trim()) faltam.push('logradouro');
    if (!String(a.numero || '').trim()) faltam.push('número');
    if (!String(a.bairro || '').trim()) faltam.push('bairro');
    if (onlyDigits(a.codigo_municipio).length !== 7) faltam.push('código IBGE do município');
    if (!isUF(a.uf)) faltam.push('UF');
    if (onlyDigits(a.cep).length !== 8) faltam.push('CEP');
    return faltam;
}

/** O que falta nos dados fiscais da empresa para emitir NF-e (vazia = pronta). */
function missingNfeSettings(s) {
    const faltam = [];
    if (!s || !s.has_token) faltam.push('token da Focus NFe');
    if (!isValidCNPJ(s && s.cnpj)) faltam.push('CNPJ válido');
    if (!String((s && s.inscricao_estadual) || '').trim()) faltam.push('inscrição estadual');
    if (!['1', '2', '3'].includes(String((s && s.regime_tributario) || ''))) faltam.push('regime tributário (Simples Nacional ou Normal)');
    if (!isUF(s && s.uf)) faltam.push('UF da empresa');
    if (!PIS_COFINS_SEM_VALOR.includes(String((s && s.pis_cofins_situacao) || ''))) faltam.push('situação tributária de PIS/COFINS (04 a 09)');
    return faltam;
}

/**
 * Confere os dados fiscais de cada produto. Devolve a lista de problemas já escrita para o usuário
 * (vazia = tudo certo). `itens[i]`: { nome, ncm, cfop, origem, icms_situacao, icms_aliquota }.
 */
function productFiscalProblems(itens, { regime, ufEmitente, ufDestino }) {
    const problemas = [];
    const interestadual = ufEmitente && ufDestino && String(ufEmitente).toUpperCase() !== String(ufDestino).toUpperCase();
    for (const it of itens) {
        const quem = `"${it.nome}"`;
        const falta = [];
        if (onlyDigits(it.ncm).length !== 8) falta.push('NCM (8 dígitos)');
        if (onlyDigits(it.cfop).length !== 4) falta.push('CFOP (4 dígitos)');
        if (!/^[0-8]$/.test(String(it.origem === undefined || it.origem === null ? '' : it.origem))) falta.push('origem (0 a 8)');
        if (!String(it.icms_situacao || '').trim()) falta.push('situação tributária do ICMS');
        if (falta.length) { problemas.push(`${quem}: falta ${falta.join(', ')}`); continue; }

        const cfop = onlyDigits(it.cfop);
        if (!['5', '6'].includes(cfop[0])) problemas.push(`${quem}: o CFOP ${cfop} não é de venda dentro do país (deve começar com 5 ou 6)`);
        else if (interestadual && cfop[0] === '5') problemas.push(`${quem}: o CFOP ${cfop} é de operação dentro do estado, mas o cliente é de outra UF (${String(ufDestino).toUpperCase()}). Use um CFOP começando com 6`);
        else if (!interestadual && ufEmitente && ufDestino && cfop[0] === '6') problemas.push(`${quem}: o CFOP ${cfop} é de operação interestadual, mas o cliente é da mesma UF. Use um CFOP começando com 5`);

        const sit = String(it.icms_situacao).trim();
        if (isSimples(regime)) {
            if (!CSOSN_SUPORTADOS.includes(sit)) problemas.push(`${quem}: o CSOSN ${sit} ainda não é suportado aqui (use ${CSOSN_SUPORTADOS.join(', ')})`);
        } else if (!CST_ICMS_SUPORTADOS.includes(sit)) {
            problemas.push(`${quem}: o CST ${sit} ainda não é suportado aqui (use ${CST_ICMS_SUPORTADOS.join(', ')})`);
        } else if (sit === '00' && !(Number(it.icms_aliquota) > 0)) {
            problemas.push(`${quem}: o CST 00 exige a alíquota de ICMS`);
        }
    }
    return problemas;
}

/**
 * Distribui o desconto do pedido entre os itens, proporcional ao valor de cada um, em centavos.
 * A diferença de arredondamento fica no último item. Devolve a lista de descontos (mesma ordem de `valores`).
 */
function allocateDiscount(valores, desconto) {
    const cents = valores.map((v) => Math.round(Number(v) * 100));
    const total = cents.reduce((s, c) => s + c, 0);
    let restante = Math.min(Math.round(Number(desconto || 0) * 100), total);
    if (restante <= 0 || total <= 0) return valores.map(() => 0);
    const parte = cents.map((c) => Math.floor((restante * c) / total));
    const somado = parte.reduce((s, c) => s + c, 0);
    parte[parte.length - 1] += restante - somado;
    return parte.map((c) => c / 100);
}

/**
 * Monta o JSON de NF-e no formato da Focus.
 *  settings: dados fiscais da empresa (cnpj, inscricao_estadual, regime_tributario, uf, pis_cofins_situacao)
 *  destinatario: { documento, nome, email, telefone, endereco: {...} }  (endereço completo; veja missingAddress)
 *  itens: [{ codigo, nome, unidade, qtd, valor_unitario, desconto, ncm, cest, cfop, origem, icms_situacao, icms_aliquota }]
 *  pagamento: { forma, valor }
 */
function buildNfePayload({ settings, destinatario, itens, pagamento, presenca = '1', now = new Date() }) {
    const doc = onlyDigits(destinatario.documento);
    const e = destinatario.endereco || {};
    const ufEmit = String(settings.uf || '').toUpperCase();
    const ufDest = String(e.uf || '').toUpperCase();
    const simples = isSimples(settings.regime_tributario);

    const items = itens.map((it, i) => {
        const qtd = Number(it.qtd);
        const unit = round2(it.valor_unitario);
        const bruto = round2(unit * qtd);
        const sit = String(it.icms_situacao).trim();
        const item = {
            numero_item: i + 1,
            codigo_produto: String(it.codigo || i + 1).slice(0, 60),
            descricao: String(it.nome).slice(0, 120),
            codigo_ncm: onlyDigits(it.ncm),
            cfop: onlyDigits(it.cfop),
            unidade_comercial: String(it.unidade || 'un').slice(0, 6),
            quantidade_comercial: qtd,
            valor_unitario_comercial: unit,
            valor_bruto: bruto,
            unidade_tributavel: String(it.unidade || 'un').slice(0, 6),
            quantidade_tributavel: qtd,
            valor_unitario_tributavel: unit,
            inclui_no_total: 1,
            icms_origem: Number(it.origem),
            icms_situacao_tributaria: sit,
            pis_situacao_tributaria: String(settings.pis_cofins_situacao),
            cofins_situacao_tributaria: String(settings.pis_cofins_situacao)
        };
        if (onlyDigits(it.cest).length === 7) item.cest = onlyDigits(it.cest);
        const desc = round2(it.desconto || 0);
        if (desc > 0) item.valor_desconto = desc;
        if (!simples && sit === '00') {
            const base = round2(bruto - desc);
            item.icms_modalidade_base_calculo = 3;
            item.icms_base_calculo = base;
            item.icms_aliquota = Number(it.icms_aliquota);
            item.icms_valor = round2((base * Number(it.icms_aliquota)) / 100);
        }
        return item;
    });

    const produtos = round2(items.reduce((s, i) => s + i.valor_bruto, 0));
    const descontos = round2(items.reduce((s, i) => s + (i.valor_desconto || 0), 0));
    const total = round2(produtos - descontos);

    const payload = {
        natureza_operacao: 'Venda de mercadoria',
        data_emissao: dataEmissaoBrasilia(now),
        data_entrada_saida: dataEmissaoBrasilia(now),
        tipo_documento: 1,
        finalidade_emissao: 1,
        local_destino: ufEmit && ufDest && ufEmit !== ufDest ? 2 : 1,
        consumidor_final: 1,
        presenca_comprador: Number(presenca),
        cnpj_emitente: onlyDigits(settings.cnpj),
        inscricao_estadual_emitente: onlyDigits(settings.inscricao_estadual),
        regime_tributario_emitente: Number(settings.regime_tributario),
        uf_emitente: ufEmit,
        nome_destinatario: String(destinatario.nome).slice(0, 60),
        indicador_inscricao_estadual_destinatario: 9, // não contribuinte
        logradouro_destinatario: e.logradouro,
        numero_destinatario: String(e.numero),
        bairro_destinatario: e.bairro,
        codigo_municipio_destinatario: onlyDigits(e.codigo_municipio),
        uf_destinatario: ufDest,
        cep_destinatario: onlyDigits(e.cep),
        modalidade_frete: 9,
        valor_produtos: produtos,
        valor_desconto: descontos,
        valor_total: total,
        items,
        formas_pagamento: [{ forma_pagamento: String(pagamento.forma), valor_pagamento: total }]
    };
    if (doc.length === 14) payload.cnpj_destinatario = doc; else payload.cpf_destinatario = doc;
    if (e.cidade) payload.municipio_destinatario = String(e.cidade).slice(0, 60);
    if (e.complemento) payload.complemento_destinatario = e.complemento;
    if (destinatario.email) payload.email_destinatario = destinatario.email;
    if (destinatario.telefone) payload.telefone_destinatario = onlyDigits(destinatario.telefone);
    return payload;
}

/** Caminho da API de cada tipo de nota (kind: 'nfse' | 'nfe'). */
function docPath(kind, ref) {
    const base = kind === 'nfe' ? '/v2/nfe' : '/v2/nfse';
    return ref ? `${base}/${encodeURIComponent(ref)}` : base;
}

// ---------- chamadas HTTP ----------
class FocusError extends Error {
    constructor(status, message, codigo) {
        super(message);
        this.status = status;
        this.codigo = codigo || '';
    }
}

/**
 * Faz uma chamada à API. `fetchImpl` existe para os testes. Nunca joga o token em log.
 * Retorna { status, data }. Erros de rede viram FocusError(502).
 */
async function focusRequest({ token, ambiente, method, path, body, fetchImpl }) {
    const doFetch = fetchImpl || global.fetch;
    if (typeof doFetch !== 'function') throw new FocusError(500, 'Este servidor não tem suporte a chamadas HTTP (use Node 18 ou mais novo).');
    if (!token) throw new FocusError(400, 'Token da Focus NFe não configurado.');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25000);
    try {
        const resp = await doFetch(`${baseUrl(ambiente)}${path}`, {
            method,
            signal: ctrl.signal,
            headers: {
                Authorization: `Basic ${Buffer.from(`${token}:`).toString('base64')}`,
                'Content-Type': 'application/json'
            },
            body: body === undefined ? undefined : JSON.stringify(body)
        });
        let data = null;
        try { data = await resp.json(); } catch (e) { data = null; }
        return { status: resp.status, data };
    } catch (err) {
        throw new FocusError(502, err && err.name === 'AbortError'
            ? 'A Focus NFe demorou demais para responder. Tente consultar a nota em instantes.'
            : 'Não foi possível falar com a Focus NFe. Tente de novo em instantes.');
    } finally {
        clearTimeout(timer);
    }
}

/** Texto curto e legível com os erros devolvidos pela Focus (ou pela prefeitura). */
function errosToText(data) {
    if (!data) return '';
    const lista = [];
    if (Array.isArray(data.erros)) data.erros.forEach((e) => lista.push(e && (e.mensagem || e.message || JSON.stringify(e))));
    if (data.mensagem) lista.push(data.mensagem);
    if (data.mensagem_sefaz) lista.push(data.mensagem_sefaz);
    return [...new Set(lista.filter(Boolean))].join(' | ').slice(0, 1500);
}

/** Converte a resposta da consulta para os campos que guardamos. */
function parseStatus(data, ambiente) {
    const d = data || {};
    const status = String(d.status || '').toLowerCase();
    const path = d.caminho_xml_nota_fiscal || '';
    return {
        status: status || 'processando_autorizacao',
        numero: d.numero ? String(d.numero) : '',
        codigo_verificacao: d.codigo_verificacao ? String(d.codigo_verificacao) : '',
        url: d.url || d.uri || d.url_danfse || '',
        xml_url: path ? (/^https?:/i.test(path) ? path : `${baseUrl(ambiente)}${path}`) : '',
        errors: errosToText(d),
        // só existem na NF-e (produto)
        chave: d.chave_nfe ? String(d.chave_nfe) : '',
        serie: d.serie ? String(d.serie) : '',
        danfe_url: d.caminho_danfe ? (/^https?:/i.test(d.caminho_danfe) ? d.caminho_danfe : `${baseUrl(ambiente)}${d.caminho_danfe}`) : ''
    };
}

const STATUS_FINAIS = ['autorizado', 'erro_autorizacao', 'cancelado', 'erro_envio', 'denegado'];
const STATUS_EM_ABERTO = ['processando_autorizacao'];

module.exports = {
    BASE_URLS, AMBIENTES, baseUrl,
    onlyDigits, isValidCPF, isValidCNPJ, newRef, dataEmissaoBrasilia,
    buildNfsePayload, missingSettings,
    UFS, isUF, CSOSN_SUPORTADOS, CST_ICMS_SUPORTADOS, PIS_COFINS_SEM_VALOR, formaPagamentoNfe,
    missingAddress, missingNfeSettings, productFiscalProblems, allocateDiscount, buildNfePayload, docPath,
    FocusError, focusRequest, errosToText, parseStatus,
    STATUS_FINAIS, STATUS_EM_ABERTO
};