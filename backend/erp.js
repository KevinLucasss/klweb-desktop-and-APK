'use strict';

/**
 * ERP KL Web (backend)
 * Módulos: Cadastros (clientes/fornecedores), Produtos e Serviços, Estoque, Vendas, Compras e Financeiro
 * (contas a pagar/receber, fluxo de caixa) + Dashboard.
 *
 * Como ligar no server.js (depois da linha `const pool = new Pool(...)` e das funções
 * authenticateToken/requireCompany existirem, antes do server.listen):
 *
 *   require('./erp')(app, { pool, authenticateToken, requireCompany, encryptData, decryptData });
 *
 * Todas as rotas ficam em /api/erp/* e são sempre filtradas por company_id (cada empresa só vê o que é seu).
 * As tabelas são criadas sozinhas na primeira subida (CREATE TABLE IF NOT EXISTS), todas com prefixo erp_.
 */

const ADMIN_ROLES = ['OWNER', 'ADMIN', 'MANAGER'];

class ErpError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

// ---------- helpers puros (testáveis sem banco) ----------
const round2 = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;

function toNum(v, { min = 0, max = 1e12, def = 0, label = 'valor' } = {}) {
    if (v === undefined || v === null || v === '') return def;
    const n = Number(String(v).replace(',', '.'));
    if (!Number.isFinite(n) || n < min || n > max) throw new ErpError(400, `O campo ${label} é inválido.`);
    return n;
}

function toStr(v, max, { required = false, label = 'campo' } = {}) {
    const s = v === undefined || v === null ? '' : String(v).trim();
    if (required && !s) throw new ErpError(400, `O campo ${label} é obrigatório.`);
    if (s.length > max) throw new ErpError(400, `O campo ${label} passou do limite de ${max} caracteres.`);
    return s;
}

function isDate(v) {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
    const [y, m, d] = v.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function todayStr() {
    return new Date().toISOString().slice(0, 10);
}

// Soma `n` meses a uma data AAAA-MM-DD sem "estourar" o fim do mês (31/01 + 1 mês = 28/02).
function addMonths(dateStr, n) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const lastDay = new Date(Date.UTC(y, m + n, 0)).getUTCDate();
    const dt = new Date(Date.UTC(y, m - 1 + n, Math.min(d, lastDay)));
    return dt.toISOString().slice(0, 10);
}

// Divide o total em parcelas em centavos; a diferença de arredondamento vai para a última.
function splitInstallments(total, count, firstDue) {
    const n = Math.min(Math.max(parseInt(count, 10) || 1, 1), 36);
    const cents = Math.round(total * 100);
    const base = Math.floor(cents / n);
    const list = [];
    for (let i = 0; i < n; i++) {
        const c = i === n - 1 ? cents - base * (n - 1) : base;
        list.push({ no: i + 1, of: n, amount: c / 100, due: addMonths(firstDue, i) });
    }
    return list;
}

// ---------- módulo ----------
module.exports = function registerErp(app, deps) {
    const { pool, authenticateToken, requireCompany, encryptData, decryptData, canUseErp, canUseErpFiscal } = deps;
    const focus = deps.focus || require('./focusnfe');

    // ---------- plano ----------
    // O ERP é dos planos Starter e Pro IA (ver canUseErp em planLimits.js). Sem a função, o acesso é NEGADO (falha segura).
    // authenticateToken já revalida plan_tier/plan_status no banco a cada requisição (o dono do site vira PRO_IA/ACTIVE).
    const ERP_PLAN_MESSAGE = 'O ERP é exclusivo dos planos Starter e Pro AI. Faça upgrade na aba Planos & Assinatura para liberar esse recurso.';
    const hasErpPlan = (req) => typeof canUseErp === 'function' && !!req.user
        && (!!req.user.isSiteOwner || canUseErp(req.user.plan_tier || req.user.planTier, req.user.plan_status || 'ACTIVE'));
    const planGuard = (req, res, next) => (hasErpPlan(req)
        ? next()
        : res.status(403).json({ code: 'PLAN_ERP_REQUIRED', message: ERP_PLAN_MESSAGE }));
    const guard = [authenticateToken, requireCompany, planGuard];

    const enc = (v) => (v ? (encryptData ? encryptData(String(v)) : String(v)) : '');
    const dec = (v) => {
        if (!v) return '';
        try { return decryptData ? decryptData(v) : v; } catch (e) { return ''; }
    };
    const isAdmin = (req) => ADMIN_ROLES.includes(req.user && req.user.role);
    const adminOnly = (req, res, next) => (isAdmin(req)
        ? next()
        : res.status(403).json({ message: 'Apenas administradores da empresa podem acessar o Financeiro.' }));

    // ---------- criação das tabelas ----------
    const DDL = `
        CREATE TABLE IF NOT EXISTS erp_parties (
            id SERIAL PRIMARY KEY,
            company_id INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
            kind VARCHAR(12) NOT NULL DEFAULT 'cliente',
            name VARCHAR(255) NOT NULL,
            doc TEXT DEFAULT '',
            phone TEXT DEFAULT '',
            email TEXT DEFAULT '',
            address TEXT DEFAULT '',
            notes TEXT DEFAULT '',
            active BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_erp_parties_company ON erp_parties(company_id);

        CREATE TABLE IF NOT EXISTS erp_products (
            id SERIAL PRIMARY KEY,
            company_id INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
            sku VARCHAR(60) DEFAULT '',
            name VARCHAR(255) NOT NULL,
            category VARCHAR(100) DEFAULT '',
            unit VARCHAR(12) DEFAULT 'un',
            is_service BOOLEAN NOT NULL DEFAULT FALSE,
            cost_price NUMERIC(14,2) NOT NULL DEFAULT 0,
            sale_price NUMERIC(14,2) NOT NULL DEFAULT 0,
            stock NUMERIC(14,3) NOT NULL DEFAULT 0,
            min_stock NUMERIC(14,3) NOT NULL DEFAULT 0,
            active BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_erp_products_company ON erp_products(company_id);
        CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_products_sku ON erp_products(company_id, sku) WHERE sku <> '';

        CREATE TABLE IF NOT EXISTS erp_stock_moves (
            id SERIAL PRIMARY KEY,
            company_id INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
            product_id INT NOT NULL REFERENCES erp_products(id) ON DELETE CASCADE,
            type VARCHAR(10) NOT NULL,
            qty NUMERIC(14,3) NOT NULL,
            balance_after NUMERIC(14,3) NOT NULL,
            reason VARCHAR(255) DEFAULT '',
            order_id INT,
            user_id INT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_erp_moves_product ON erp_stock_moves(company_id, product_id, created_at DESC);

        CREATE TABLE IF NOT EXISTS erp_orders (
            id SERIAL PRIMARY KEY,
            company_id INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
            type VARCHAR(10) NOT NULL,
            number INT NOT NULL,
            party_id INT REFERENCES erp_parties(id) ON DELETE SET NULL,
            status VARCHAR(12) NOT NULL DEFAULT 'rascunho',
            discount NUMERIC(14,2) NOT NULL DEFAULT 0,
            total NUMERIC(14,2) NOT NULL DEFAULT 0,
            payment_method VARCHAR(30) DEFAULT '',
            installments INT NOT NULL DEFAULT 1,
            first_due DATE,
            notes TEXT DEFAULT '',
            created_by INT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            confirmed_at TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_erp_orders_company ON erp_orders(company_id, type, created_at DESC);
        CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_orders_number ON erp_orders(company_id, type, number);

        CREATE TABLE IF NOT EXISTS erp_order_items (
            id SERIAL PRIMARY KEY,
            order_id INT NOT NULL REFERENCES erp_orders(id) ON DELETE CASCADE,
            product_id INT REFERENCES erp_products(id) ON DELETE SET NULL,
            description VARCHAR(255) NOT NULL,
            qty NUMERIC(14,3) NOT NULL,
            unit_price NUMERIC(14,2) NOT NULL,
            total NUMERIC(14,2) NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_erp_items_order ON erp_order_items(order_id);

        CREATE TABLE IF NOT EXISTS erp_transactions (
            id SERIAL PRIMARY KEY,
            company_id INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
            type VARCHAR(10) NOT NULL,
            description VARCHAR(255) NOT NULL,
            amount NUMERIC(14,2) NOT NULL,
            due_date DATE NOT NULL,
            status VARCHAR(12) NOT NULL DEFAULT 'aberto',
            paid_at TIMESTAMP,
            paid_amount NUMERIC(14,2),
            category VARCHAR(100) DEFAULT '',
            party_id INT REFERENCES erp_parties(id) ON DELETE SET NULL,
            order_id INT REFERENCES erp_orders(id) ON DELETE SET NULL,
            installment_no INT NOT NULL DEFAULT 1,
            installments_total INT NOT NULL DEFAULT 1,
            method VARCHAR(30) DEFAULT '',
            notes TEXT DEFAULT '',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_erp_tx_company ON erp_transactions(company_id, type, status, due_date);
        CREATE TABLE IF NOT EXISTS erp_fiscal_settings (
            company_id INT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
            token_enc TEXT DEFAULT '',
            ambiente VARCHAR(12) NOT NULL DEFAULT 'homologacao',
            cnpj VARCHAR(14) DEFAULT '',
            inscricao_municipal VARCHAR(30) DEFAULT '',
            codigo_municipio VARCHAR(7) DEFAULT '',
            optante_simples BOOLEAN NOT NULL DEFAULT TRUE,
            regime_especial VARCHAR(2) DEFAULT '',
            natureza_operacao VARCHAR(2) DEFAULT '1',
            item_lista_servico VARCHAR(10) DEFAULT '',
            codigo_tributario_municipio VARCHAR(20) DEFAULT '',
            aliquota NUMERIC(7,4) NOT NULL DEFAULT 0,
            iss_retido BOOLEAN NOT NULL DEFAULT FALSE,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS erp_fiscal_docs (
            id SERIAL PRIMARY KEY,
            company_id INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
            kind VARCHAR(8) NOT NULL DEFAULT 'nfse',
            ref VARCHAR(80) NOT NULL UNIQUE,
            order_id INT REFERENCES erp_orders(id) ON DELETE SET NULL,
            party_id INT REFERENCES erp_parties(id) ON DELETE SET NULL,
            amount NUMERIC(14,2) NOT NULL,
            description TEXT DEFAULT '',
            status VARCHAR(30) NOT NULL DEFAULT 'enviando',
            ambiente VARCHAR(12) NOT NULL DEFAULT 'homologacao',
            numero VARCHAR(30) DEFAULT '',
            codigo_verificacao VARCHAR(60) DEFAULT '',
            url TEXT DEFAULT '',
            xml_url TEXT DEFAULT '',
            errors TEXT DEFAULT '',
            created_by INT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_erp_fiscal_company ON erp_fiscal_docs(company_id, id DESC);

        -- Endereço estruturado do cliente (exigido por muitas prefeituras na NFS-e e sempre na NF-e)
        ALTER TABLE erp_parties ADD COLUMN IF NOT EXISTS addr_logradouro VARCHAR(150) DEFAULT '';
        ALTER TABLE erp_parties ADD COLUMN IF NOT EXISTS addr_numero VARCHAR(20) DEFAULT '';
        ALTER TABLE erp_parties ADD COLUMN IF NOT EXISTS addr_complemento VARCHAR(80) DEFAULT '';
        ALTER TABLE erp_parties ADD COLUMN IF NOT EXISTS addr_bairro VARCHAR(80) DEFAULT '';
        ALTER TABLE erp_parties ADD COLUMN IF NOT EXISTS addr_cidade VARCHAR(80) DEFAULT '';
        ALTER TABLE erp_parties ADD COLUMN IF NOT EXISTS addr_codigo_municipio VARCHAR(7) DEFAULT '';
        ALTER TABLE erp_parties ADD COLUMN IF NOT EXISTS addr_uf VARCHAR(2) DEFAULT '';
        ALTER TABLE erp_parties ADD COLUMN IF NOT EXISTS addr_cep VARCHAR(8) DEFAULT '';

        -- Dados fiscais do produto (NF-e)
        ALTER TABLE erp_products ADD COLUMN IF NOT EXISTS ncm VARCHAR(8) DEFAULT '';
        ALTER TABLE erp_products ADD COLUMN IF NOT EXISTS cest VARCHAR(7) DEFAULT '';
        ALTER TABLE erp_products ADD COLUMN IF NOT EXISTS cfop VARCHAR(4) DEFAULT '';
        ALTER TABLE erp_products ADD COLUMN IF NOT EXISTS origem VARCHAR(1) DEFAULT '0';
        ALTER TABLE erp_products ADD COLUMN IF NOT EXISTS icms_situacao VARCHAR(3) DEFAULT '';
        ALTER TABLE erp_products ADD COLUMN IF NOT EXISTS icms_aliquota NUMERIC(7,4) NOT NULL DEFAULT 0;

        -- Dados fiscais da empresa para NF-e
        ALTER TABLE erp_fiscal_settings ADD COLUMN IF NOT EXISTS inscricao_estadual VARCHAR(30) DEFAULT '';
        ALTER TABLE erp_fiscal_settings ADD COLUMN IF NOT EXISTS regime_tributario VARCHAR(1) DEFAULT '';
        ALTER TABLE erp_fiscal_settings ADD COLUMN IF NOT EXISTS uf VARCHAR(2) DEFAULT '';
        ALTER TABLE erp_fiscal_settings ADD COLUMN IF NOT EXISTS pis_cofins_situacao VARCHAR(2) DEFAULT '07';

        -- Campos que só a NF-e devolve
        ALTER TABLE erp_fiscal_docs ADD COLUMN IF NOT EXISTS chave VARCHAR(60) DEFAULT '';
        ALTER TABLE erp_fiscal_docs ADD COLUMN IF NOT EXISTS serie VARCHAR(10) DEFAULT '';
        ALTER TABLE erp_fiscal_docs ADD COLUMN IF NOT EXISTS danfe_url TEXT DEFAULT '';
    `;

    // Tenta criar as tabelas; se o banco ainda estiver subindo (ou a tabela companies ainda não existir), tenta de novo.
    let readyPromise = null;
    function ensureReady() {
        if (readyPromise) return readyPromise;
        readyPromise = (async () => {
            let lastErr;
            for (let i = 0; i < 6; i++) {
                try {
                    await pool.query(DDL);
                    console.log('📦 [ERP] Tabelas verificadas.');
                    return true;
                } catch (err) {
                    lastErr = err;
                    await new Promise((r) => setTimeout(r, 4000));
                }
            }
            console.error('❌ [ERP] Não foi possível criar as tabelas:', lastErr && lastErr.message);
            readyPromise = null; // permite nova tentativa na próxima requisição
            throw lastErr;
        })();
        return readyPromise;
    }
    ensureReady().catch(() => { /* o erro já foi logado; as rotas tentam de novo */ });

    async function withTx(fn) {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const out = await fn(client);
            await client.query('COMMIT');
            return out;
        } catch (err) {
            try { await client.query('ROLLBACK'); } catch (e) { /* ignora */ }
            throw err;
        } finally {
            client.release();
        }
    }

    const wrap = (fn) => async (req, res) => {
        try {
            await ensureReady();
            await fn(req, res);
        } catch (err) {
            if (err instanceof ErpError) return res.status(err.status).json({ message: err.message });
            if (err && err.code === '23505') return res.status(409).json({ message: 'Já existe um registro com esse código (SKU).' });
            console.error('[ERP] Erro:', err && err.message);
            res.status(500).json({ message: 'Erro interno no módulo ERP.' });
        }
    };

    const id = (req) => {
        const n = parseInt(req.params.id, 10);
        if (!Number.isInteger(n) || n <= 0) throw new ErpError(400, 'Identificador inválido.');
        return n;
    };

    // ---------- permissões ----------
    // Sem planGuard de propósito: o front usa essa rota para saber se mostra a aba ou o aviso de upgrade.
    app.get('/api/erp/access', authenticateToken, requireCompany, (req, res) => res.json({
        enabled: hasErpPlan(req),
        finance: hasErpPlan(req) && isAdmin(req),
        fiscal: hasErpPlan(req) && isAdmin(req) && hasFiscalPlan(req),
        message: hasErpPlan(req) ? null : ERP_PLAN_MESSAGE
    }));

    // ---------- clientes e fornecedores ----------
    const addressOut = (r) => ({
        logradouro: r.addr_logradouro || '', numero: r.addr_numero || '', complemento: r.addr_complemento || '',
        bairro: r.addr_bairro || '', cidade: r.addr_cidade || '', codigo_municipio: r.addr_codigo_municipio || '',
        uf: r.addr_uf || '', cep: r.addr_cep || ''
    });

    const partyOut = (r) => ({
        id: r.id, kind: r.kind, name: r.name, doc: dec(r.doc), phone: dec(r.phone), email: dec(r.email),
        address: r.address || '', endereco: addressOut(r), notes: r.notes || '', active: r.active, created_at: r.created_at
    });

    // Endereço estruturado. `undefined` = não mexer (null); objeto = valida e normaliza.
    function addressIn(e) {
        if (e === undefined || e === null) return null;
        if (typeof e !== 'object' || Array.isArray(e)) throw new ErpError(400, 'O endereço do cliente é inválido.');
        const cep = focus.onlyDigits(e.cep);
        if (cep && cep.length !== 8) throw new ErpError(400, 'O CEP tem 8 dígitos.');
        const ibge = focus.onlyDigits(e.codigo_municipio);
        if (ibge && ibge.length !== 7) throw new ErpError(400, 'O código IBGE do município tem 7 dígitos.');
        const uf = String(e.uf || '').trim().toUpperCase();
        if (uf && !focus.isUF(uf)) throw new ErpError(400, 'A UF do endereço é inválida.');
        return {
            logradouro: toStr(e.logradouro, 150, { label: 'logradouro' }),
            numero: toStr(e.numero, 20, { label: 'número do endereço' }),
            complemento: toStr(e.complemento, 80, { label: 'complemento' }),
            bairro: toStr(e.bairro, 80, { label: 'bairro' }),
            cidade: toStr(e.cidade, 80, { label: 'cidade' }),
            codigo_municipio: ibge, uf, cep
        };
    }
    // Valores na ordem das 8 colunas addr_*. Em UPDATE, null mantém o que já está salvo (COALESCE).
    const addrParams = (a, forInsert) => (a
        ? [a.logradouro, a.numero, a.complemento, a.bairro, a.cidade, a.codigo_municipio, a.uf, a.cep]
        : Array(8).fill(forInsert ? '' : null));

    // Consulta de CEP (ViaCEP). Falha de rede nunca derruba o cadastro: devolve null.
    async function defaultCepLookup(cep) {
        const c = focus.onlyDigits(cep);
        if (c.length !== 8 || typeof global.fetch !== 'function') return null;
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 5000);
        try {
            const resp = await global.fetch(`https://viacep.com.br/ws/${c}/json/`, { signal: ctrl.signal });
            if (!resp.ok) return null;
            const j = await resp.json();
            if (!j || j.erro) return null;
            return { logradouro: j.logradouro || '', bairro: j.bairro || '', cidade: j.localidade || '', uf: j.uf || '', codigo_municipio: j.ibge || '', cep: c };
        } catch (e) { return null; } finally { clearTimeout(timer); }
    }
    const cepLookup = deps.cepLookup || defaultCepLookup;

    app.get('/api/erp/cep/:cep', guard, wrap(async (req, res) => {
        const found = await cepLookup(req.params.cep);
        if (!found) throw new ErpError(404, 'Não encontrei esse CEP. Preencha o endereço manualmente.');
        res.json(found);
    }));

    function partyIn(b) {
        const kind = ['cliente', 'fornecedor', 'ambos'].includes(b.kind) ? b.kind : 'cliente';
        return {
            kind,
            name: toStr(b.name, 255, { required: true, label: 'nome' }),
            doc: enc(toStr(b.doc, 30, { label: 'CPF/CNPJ' })),
            phone: enc(toStr(b.phone, 30, { label: 'telefone' })),
            email: enc(toStr(b.email, 255, { label: 'e-mail' })),
            address: toStr(b.address, 400, { label: 'endereço' }),
            endereco: addressIn(b.endereco),
            notes: toStr(b.notes, 2000, { label: 'observações' }),
            active: b.active === undefined ? true : !!b.active
        };
    }

    app.get('/api/erp/parties', guard, wrap(async (req, res) => {
        const r = await pool.query('SELECT * FROM erp_parties WHERE company_id = $1 ORDER BY name ASC LIMIT 5000', [req.user.companyId]);
        res.json(r.rows.map(partyOut));
    }));

    app.post('/api/erp/parties', guard, wrap(async (req, res) => {
        const p = partyIn(req.body || {});
        const r = await pool.query(
            `INSERT INTO erp_parties (company_id, kind, name, doc, phone, email, address, notes, active,
                addr_logradouro, addr_numero, addr_complemento, addr_bairro, addr_cidade, addr_codigo_municipio, addr_uf, addr_cep)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
            [req.user.companyId, p.kind, p.name, p.doc, p.phone, p.email, p.address, p.notes, p.active, ...addrParams(p.endereco, true)]
        );
        res.status(201).json(partyOut(r.rows[0]));
    }));

    app.put('/api/erp/parties/:id', guard, wrap(async (req, res) => {
        const p = partyIn(req.body || {});
        const r = await pool.query(
            `UPDATE erp_parties SET kind=$1, name=$2, doc=$3, phone=$4, email=$5, address=$6, notes=$7, active=$8,
                addr_logradouro=COALESCE($11, addr_logradouro), addr_numero=COALESCE($12, addr_numero),
                addr_complemento=COALESCE($13, addr_complemento), addr_bairro=COALESCE($14, addr_bairro),
                addr_cidade=COALESCE($15, addr_cidade), addr_codigo_municipio=COALESCE($16, addr_codigo_municipio),
                addr_uf=COALESCE($17, addr_uf), addr_cep=COALESCE($18, addr_cep)
             WHERE id=$9 AND company_id=$10 RETURNING *`,
            [p.kind, p.name, p.doc, p.phone, p.email, p.address, p.notes, p.active, id(req), req.user.companyId, ...addrParams(p.endereco, false)]
        );
        if (!r.rows.length) throw new ErpError(404, 'Cadastro não encontrado.');
        res.json(partyOut(r.rows[0]));
    }));

    app.delete('/api/erp/parties/:id', guard, wrap(async (req, res) => {
        const pid = id(req);
        const used = await pool.query(
            `SELECT (SELECT COUNT(*) FROM erp_orders WHERE party_id=$1) + (SELECT COUNT(*) FROM erp_transactions WHERE party_id=$1) AS n`, [pid]);
        if (Number(used.rows[0].n) > 0) {
            // Tem histórico: não apaga, só inativa (mantém pedidos e títulos consistentes).
            await pool.query('UPDATE erp_parties SET active=FALSE WHERE id=$1 AND company_id=$2', [pid, req.user.companyId]);
            return res.json({ success: true, deactivated: true, message: 'Cadastro com histórico foi inativado em vez de excluído.' });
        }
        const r = await pool.query('DELETE FROM erp_parties WHERE id=$1 AND company_id=$2', [pid, req.user.companyId]);
        if (!r.rowCount) throw new ErpError(404, 'Cadastro não encontrado.');
        res.json({ success: true });
    }));

    // ---------- produtos e serviços ----------
    const productOut = (r) => ({
        id: r.id, sku: r.sku || '', name: r.name, category: r.category || '', unit: r.unit || 'un',
        is_service: r.is_service, cost_price: Number(r.cost_price), sale_price: Number(r.sale_price),
        stock: Number(r.stock), min_stock: Number(r.min_stock), active: r.active, created_at: r.created_at,
        ncm: r.ncm || '', cest: r.cest || '', cfop: r.cfop || '', origem: r.origem === undefined || r.origem === null || r.origem === '' ? '0' : String(r.origem),
        icms_situacao: r.icms_situacao || '', icms_aliquota: Number(r.icms_aliquota) || 0
    });

    // Dados fiscais (NF-e). Campo ausente = null = "não mexer" (o UPDATE usa COALESCE), para a tela antiga não apagar nada.
    function productFiscalIn(b) {
        const has = (k) => b[k] !== undefined && b[k] !== null;
        const digits = (k, len, label) => {
            if (!has(k)) return null;
            const d = focus.onlyDigits(b[k]);
            if (d && d.length !== len) throw new ErpError(400, `O ${label} tem ${len} dígitos.`);
            return d;
        };
        let origem = null;
        if (has('origem')) {
            origem = String(b.origem).trim() === '' ? '0' : String(b.origem).trim();
            if (!/^[0-8]$/.test(origem)) throw new ErpError(400, 'A origem da mercadoria deve ser de 0 a 8.');
        }
        let icmsSit = null;
        if (has('icms_situacao')) {
            icmsSit = String(b.icms_situacao).trim();
            if (icmsSit && !/^\d{2,3}$/.test(icmsSit)) throw new ErpError(400, 'A situação tributária do ICMS (CST/CSOSN) é inválida.');
        }
        return {
            ncm: digits('ncm', 8, 'NCM'), cest: digits('cest', 7, 'CEST'), cfop: digits('cfop', 4, 'CFOP'),
            origem, icms_situacao: icmsSit,
            icms_aliquota: has('icms_aliquota') ? toNum(b.icms_aliquota, { min: 0, max: 100, label: 'alíquota de ICMS' }) : null
        };
    }
    const fiscalCols = (f, forInsert) => (forInsert
        ? [f.ncm ?? '', f.cest ?? '', f.cfop ?? '', f.origem ?? '0', f.icms_situacao ?? '', f.icms_aliquota ?? 0]
        : [f.ncm, f.cest, f.cfop, f.origem, f.icms_situacao, f.icms_aliquota]);

    function productIn(b) {
        return {
            sku: toStr(b.sku, 60, { label: 'SKU' }),
            name: toStr(b.name, 255, { required: true, label: 'nome' }),
            category: toStr(b.category, 100, { label: 'categoria' }),
            unit: toStr(b.unit, 12, { label: 'unidade' }) || 'un',
            is_service: !!b.is_service,
            cost_price: round2(toNum(b.cost_price, { label: 'preço de custo' })),
            sale_price: round2(toNum(b.sale_price, { label: 'preço de venda' })),
            min_stock: toNum(b.min_stock, { label: 'estoque mínimo' }),
            active: b.active === undefined ? true : !!b.active,
            fiscal: productFiscalIn(b)
        };
    }

    app.get('/api/erp/products', guard, wrap(async (req, res) => {
        const r = await pool.query('SELECT * FROM erp_products WHERE company_id = $1 ORDER BY name ASC LIMIT 5000', [req.user.companyId]);
        res.json(r.rows.map(productOut));
    }));

    app.post('/api/erp/products', guard, wrap(async (req, res) => {
        const b = req.body || {};
        const p = productIn(b);
        const initial = p.is_service ? 0 : toNum(b.stock, { label: 'estoque inicial' });
        const out = await withTx(async (c) => {
            const r = await c.query(
                `INSERT INTO erp_products (company_id, sku, name, category, unit, is_service, cost_price, sale_price, stock, min_stock, active,
                    ncm, cest, cfop, origem, icms_situacao, icms_aliquota)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
                [req.user.companyId, p.sku, p.name, p.category, p.unit, p.is_service, p.cost_price, p.sale_price, initial, p.min_stock, p.active, ...fiscalCols(p.fiscal, true)]
            );
            if (initial > 0) {
                await c.query(
                    `INSERT INTO erp_stock_moves (company_id, product_id, type, qty, balance_after, reason, user_id)
                     VALUES ($1,$2,'entrada',$3,$3,'Estoque inicial',$4)`,
                    [req.user.companyId, r.rows[0].id, initial, req.user.id]
                );
            }
            return r.rows[0];
        });
        res.status(201).json(productOut(out));
    }));

    // O saldo de estoque NÃO é editado aqui: só por movimentações (entrada/saída/ajuste) ou por pedidos.
    app.put('/api/erp/products/:id', guard, wrap(async (req, res) => {
        const p = productIn(req.body || {});
        const r = await pool.query(
            `UPDATE erp_products SET sku=$1, name=$2, category=$3, unit=$4, is_service=$5, cost_price=$6, sale_price=$7, min_stock=$8, active=$9,
                ncm=COALESCE($12, ncm), cest=COALESCE($13, cest), cfop=COALESCE($14, cfop), origem=COALESCE($15, origem),
                icms_situacao=COALESCE($16, icms_situacao), icms_aliquota=COALESCE($17, icms_aliquota)
             WHERE id=$10 AND company_id=$11 RETURNING *`,
            [p.sku, p.name, p.category, p.unit, p.is_service, p.cost_price, p.sale_price, p.min_stock, p.active, id(req), req.user.companyId, ...fiscalCols(p.fiscal, false)]
        );
        if (!r.rows.length) throw new ErpError(404, 'Produto não encontrado.');
        res.json(productOut(r.rows[0]));
    }));

    app.delete('/api/erp/products/:id', guard, wrap(async (req, res) => {
        const pid = id(req);
        const used = await pool.query(
            `SELECT (SELECT COUNT(*) FROM erp_order_items WHERE product_id=$1) + (SELECT COUNT(*) FROM erp_stock_moves WHERE product_id=$1) AS n`, [pid]);
        if (Number(used.rows[0].n) > 0) {
            await pool.query('UPDATE erp_products SET active=FALSE WHERE id=$1 AND company_id=$2', [pid, req.user.companyId]);
            return res.json({ success: true, deactivated: true, message: 'Produto com histórico foi inativado em vez de excluído.' });
        }
        const r = await pool.query('DELETE FROM erp_products WHERE id=$1 AND company_id=$2', [pid, req.user.companyId]);
        if (!r.rowCount) throw new ErpError(404, 'Produto não encontrado.');
        res.json({ success: true });
    }));

    // ---------- estoque ----------
    // Aplica uma movimentação dentro de uma transação. delta > 0 entra, delta < 0 sai.
    async function applyMove(c, companyId, productId, type, delta, reason, orderId, userId, { allowNegative = false } = {}) {
        if (delta === 0) return null;
        const guardSql = delta < 0 && !allowNegative ? 'AND stock + $1 >= 0' : '';
        const r = await c.query(
            `UPDATE erp_products SET stock = stock + $1 WHERE id = $2 AND company_id = $3 ${guardSql} RETURNING name, stock, is_service`,
            [delta, productId, companyId]
        );
        if (!r.rows.length) {
            const p = await c.query('SELECT name FROM erp_products WHERE id=$1 AND company_id=$2', [productId, companyId]);
            if (!p.rows.length) throw new ErpError(404, 'Produto não encontrado.');
            throw new ErpError(409, `Estoque insuficiente de "${p.rows[0].name}".`);
        }
        await c.query(
            `INSERT INTO erp_stock_moves (company_id, product_id, type, qty, balance_after, reason, order_id, user_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [companyId, productId, type, delta, r.rows[0].stock, String(reason || '').slice(0, 255), orderId || null, userId || null]
        );
        return r.rows[0];
    }

    app.post('/api/erp/products/:id/move', guard, wrap(async (req, res) => {
        const pid = id(req);
        const b = req.body || {};
        const type = ['entrada', 'saida', 'ajuste'].includes(b.type) ? b.type : null;
        if (!type) throw new ErpError(400, 'Tipo de movimentação inválido.');
        if (b.qty === undefined || b.qty === null || String(b.qty).trim() === '') throw new ErpError(400, 'Informe a quantidade.');
        const qty = toNum(b.qty, { min: type === 'ajuste' ? 0 : 0.001, label: 'quantidade' });
        const reason = toStr(b.reason, 255, { label: 'motivo' }) || (type === 'entrada' ? 'Entrada manual' : type === 'saida' ? 'Saída manual' : 'Ajuste de inventário');

        await withTx(async (c) => {
            const cur = await c.query('SELECT stock, is_service FROM erp_products WHERE id=$1 AND company_id=$2 FOR UPDATE', [pid, req.user.companyId]);
            if (!cur.rows.length) throw new ErpError(404, 'Produto não encontrado.');
            if (cur.rows[0].is_service) throw new ErpError(400, 'Serviços não possuem estoque.');
            // "ajuste" = contagem de inventário: define o saldo para a quantidade informada.
            const delta = type === 'ajuste' ? qty - Number(cur.rows[0].stock) : type === 'entrada' ? qty : -qty;
            await applyMove(c, req.user.companyId, pid, type, delta, reason, null, req.user.id);
        });
        const r = await pool.query('SELECT * FROM erp_products WHERE id=$1 AND company_id=$2', [pid, req.user.companyId]);
        res.json(productOut(r.rows[0]));
    }));

    app.get('/api/erp/stock/moves', guard, wrap(async (req, res) => {
        const params = [req.user.companyId];
        let where = 'm.company_id = $1';
        if (req.query.product_id) {
            params.push(parseInt(req.query.product_id, 10) || 0);
            where += ` AND m.product_id = $${params.length}`;
        }
        const r = await pool.query(
            `SELECT m.*, p.name AS product_name, p.unit FROM erp_stock_moves m
             JOIN erp_products p ON p.id = m.product_id
             WHERE ${where} ORDER BY m.created_at DESC, m.id DESC LIMIT 300`, params);
        res.json(r.rows.map((m) => ({
            id: m.id, product_id: m.product_id, product_name: m.product_name, unit: m.unit, type: m.type,
            qty: Number(m.qty), balance_after: Number(m.balance_after), reason: m.reason, order_id: m.order_id, created_at: m.created_at
        })));
    }));

    // ---------- pedidos de venda e de compra ----------
    const orderOut = (o, extra = {}) => ({
        id: o.id, type: o.type, number: o.number, party_id: o.party_id, party_name: o.party_name || '',
        status: o.status, discount: Number(o.discount), total: Number(o.total), payment_method: o.payment_method || '',
        installments: o.installments, first_due: o.first_due ? new Date(o.first_due).toISOString().slice(0, 10) : null,
        notes: o.notes || '', created_at: o.created_at, confirmed_at: o.confirmed_at, ...extra
    });

    async function buildItems(c, companyId, type, rawItems) {
        if (!Array.isArray(rawItems) || !rawItems.length) throw new ErpError(400, 'Adicione pelo menos um item ao pedido.');
        if (rawItems.length > 200) throw new ErpError(400, 'Um pedido pode ter no máximo 200 itens.');
        const ids = [...new Set(rawItems.map((i) => parseInt(i.product_id, 10)).filter((n) => n > 0))];
        const prods = new Map();
        if (ids.length) {
            const r = await c.query('SELECT * FROM erp_products WHERE company_id=$1 AND id = ANY($2::int[])', [companyId, ids]);
            r.rows.forEach((p) => prods.set(p.id, p));
        }
        return rawItems.map((i, idx) => {
            const pid = parseInt(i.product_id, 10) > 0 ? parseInt(i.product_id, 10) : null;
            const prod = pid ? prods.get(pid) : null;
            if (pid && !prod) throw new ErpError(400, `O item ${idx + 1} usa um produto que não existe mais.`);
            const description = toStr(i.description, 255) || (prod ? prod.name : '');
            if (!description) throw new ErpError(400, `Informe a descrição do item ${idx + 1}.`);
            const qty = toNum(i.qty, { min: 0.001, max: 1e9, def: 1, label: `quantidade do item ${idx + 1}` });
            const defPrice = prod ? Number(type === 'venda' ? prod.sale_price : prod.cost_price) : 0;
            const unit = round2(toNum(i.unit_price, { max: 1e9, def: defPrice, label: `preço do item ${idx + 1}` }));
            return { product_id: pid, description, qty, unit_price: unit, total: round2(qty * unit), is_service: prod ? prod.is_service : true };
        });
    }

    function orderHeaderIn(b, type, items) {
        const subtotal = round2(items.reduce((s, i) => s + i.total, 0));
        const discount = round2(toNum(b.discount, { max: 1e12, label: 'desconto' }));
        if (discount > subtotal) throw new ErpError(400, 'O desconto não pode ser maior que o total dos itens.');
        const installments = Math.min(Math.max(parseInt(b.installments, 10) || 1, 1), 36);
        let firstDue = b.first_due ? String(b.first_due).slice(0, 10) : null;
        if (firstDue && !isDate(firstDue)) throw new ErpError(400, 'A data do primeiro vencimento é inválida.');
        return {
            party_id: parseInt(b.party_id, 10) > 0 ? parseInt(b.party_id, 10) : null,
            discount, total: round2(subtotal - discount), installments, first_due: firstDue,
            payment_method: toStr(b.payment_method, 30, { label: 'forma de pagamento' }),
            notes: toStr(b.notes, 2000, { label: 'observações' })
        };
    }

    async function assertParty(c, companyId, partyId) {
        if (!partyId) return;
        const r = await c.query('SELECT 1 FROM erp_parties WHERE id=$1 AND company_id=$2', [partyId, companyId]);
        if (!r.rows.length) throw new ErpError(400, 'Cliente/fornecedor não encontrado.');
    }

    async function writeItems(c, orderId, items) {
        await c.query('DELETE FROM erp_order_items WHERE order_id=$1', [orderId]);
        for (const i of items) {
            await c.query(
                `INSERT INTO erp_order_items (order_id, product_id, description, qty, unit_price, total) VALUES ($1,$2,$3,$4,$5,$6)`,
                [orderId, i.product_id, i.description, i.qty, i.unit_price, i.total]);
        }
    }

    async function loadOrder(companyId, oid) {
        const o = await pool.query(
            `SELECT o.*, p.name AS party_name FROM erp_orders o LEFT JOIN erp_parties p ON p.id = o.party_id
             WHERE o.id=$1 AND o.company_id=$2`, [oid, companyId]);
        if (!o.rows.length) throw new ErpError(404, 'Pedido não encontrado.');
        const items = await pool.query('SELECT * FROM erp_order_items WHERE order_id=$1 ORDER BY id', [oid]);
        const tx = await pool.query('SELECT id, amount, due_date, status, installment_no, installments_total FROM erp_transactions WHERE order_id=$1 ORDER BY installment_no', [oid]);
        return orderOut(o.rows[0], {
            items: items.rows.map((i) => ({ id: i.id, product_id: i.product_id, description: i.description, qty: Number(i.qty), unit_price: Number(i.unit_price), total: Number(i.total) })),
            transactions: tx.rows.map((t) => ({ id: t.id, amount: Number(t.amount), due_date: new Date(t.due_date).toISOString().slice(0, 10), status: t.status, installment_no: t.installment_no, installments_total: t.installments_total }))
        });
    }

    app.get('/api/erp/orders', guard, wrap(async (req, res) => {
        const params = [req.user.companyId];
        let where = 'o.company_id = $1';
        if (['venda', 'compra'].includes(req.query.type)) { params.push(req.query.type); where += ` AND o.type = $${params.length}`; }
        if (['rascunho', 'confirmado', 'cancelado'].includes(req.query.status)) { params.push(req.query.status); where += ` AND o.status = $${params.length}`; }
        const r = await pool.query(
            `SELECT o.*, p.name AS party_name FROM erp_orders o LEFT JOIN erp_parties p ON p.id = o.party_id
             WHERE ${where} ORDER BY o.created_at DESC, o.id DESC LIMIT 1000`, params);
        res.json(r.rows.map((o) => orderOut(o)));
    }));

    app.get('/api/erp/orders/:id', guard, wrap(async (req, res) => {
        res.json(await loadOrder(req.user.companyId, id(req)));
    }));

    app.post('/api/erp/orders', guard, wrap(async (req, res) => {
        const b = req.body || {};
        const type = b.type === 'compra' ? 'compra' : 'venda';
        const created = await withTx(async (c) => {
            const items = await buildItems(c, req.user.companyId, type, b.items);
            const h = orderHeaderIn(b, type, items);
            await assertParty(c, req.user.companyId, h.party_id);
            await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`erp:order:${req.user.companyId}:${type}`]);
            const n = await c.query('SELECT COALESCE(MAX(number),0)+1 AS n FROM erp_orders WHERE company_id=$1 AND type=$2', [req.user.companyId, type]);
            const o = await c.query(
                `INSERT INTO erp_orders (company_id, type, number, party_id, discount, total, payment_method, installments, first_due, notes, created_by)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
                [req.user.companyId, type, n.rows[0].n, h.party_id, h.discount, h.total, h.payment_method, h.installments, h.first_due, h.notes, req.user.id]);
            await writeItems(c, o.rows[0].id, items);
            return o.rows[0].id;
        });
        res.status(201).json(await loadOrder(req.user.companyId, created));
    }));

    app.put('/api/erp/orders/:id', guard, wrap(async (req, res) => {
        const oid = id(req);
        const b = req.body || {};
        await withTx(async (c) => {
            const cur = await c.query('SELECT * FROM erp_orders WHERE id=$1 AND company_id=$2 FOR UPDATE', [oid, req.user.companyId]);
            if (!cur.rows.length) throw new ErpError(404, 'Pedido não encontrado.');
            if (cur.rows[0].status !== 'rascunho') throw new ErpError(409, 'Só é possível editar pedidos em rascunho.');
            const type = cur.rows[0].type;
            const items = await buildItems(c, req.user.companyId, type, b.items);
            const h = orderHeaderIn(b, type, items);
            await assertParty(c, req.user.companyId, h.party_id);
            await c.query(
                `UPDATE erp_orders SET party_id=$1, discount=$2, total=$3, payment_method=$4, installments=$5, first_due=$6, notes=$7 WHERE id=$8`,
                [h.party_id, h.discount, h.total, h.payment_method, h.installments, h.first_due, h.notes, oid]);
            await writeItems(c, oid, items);
        });
        res.json(await loadOrder(req.user.companyId, oid));
    }));

    app.delete('/api/erp/orders/:id', guard, wrap(async (req, res) => {
        const r = await pool.query(`DELETE FROM erp_orders WHERE id=$1 AND company_id=$2 AND status='rascunho'`, [id(req), req.user.companyId]);
        if (!r.rowCount) throw new ErpError(409, 'Só é possível excluir pedidos em rascunho. Para os demais, use "Cancelar".');
        res.json({ success: true });
    }));

    // Confirmar: venda dá baixa no estoque e gera contas a RECEBER; compra dá entrada no estoque e gera contas a PAGAR.
    app.post('/api/erp/orders/:id/confirm', guard, wrap(async (req, res) => {
        const oid = id(req);
        const paidNow = !!(req.body && req.body.paid_now);
        await withTx(async (c) => {
            const q = await c.query('SELECT * FROM erp_orders WHERE id=$1 AND company_id=$2 FOR UPDATE', [oid, req.user.companyId]);
            if (!q.rows.length) throw new ErpError(404, 'Pedido não encontrado.');
            const o = q.rows[0];
            if (o.status !== 'rascunho') throw new ErpError(409, 'Este pedido já foi confirmado ou cancelado.');
            const label = o.type === 'venda' ? `Venda #${o.number}` : `Compra #${o.number}`;

            const items = await c.query(
                `SELECT i.*, p.is_service FROM erp_order_items i LEFT JOIN erp_products p ON p.id = i.product_id WHERE i.order_id=$1`, [oid]);
            if (!items.rows.length) throw new ErpError(409, 'O pedido não tem itens.');

            for (const it of items.rows) {
                if (!it.product_id || it.is_service) continue;
                const qty = Number(it.qty);
                if (o.type === 'venda') await applyMove(c, req.user.companyId, it.product_id, 'saida', -qty, label, oid, req.user.id);
                else await applyMove(c, req.user.companyId, it.product_id, 'entrada', qty, label, oid, req.user.id);
            }

            const total = Number(o.total);
            if (total > 0) {
                const first = o.first_due ? new Date(o.first_due).toISOString().slice(0, 10) : todayStr();
                const txType = o.type === 'venda' ? 'receber' : 'pagar';
                for (const p of splitInstallments(total, o.installments, first)) {
                    await c.query(
                        `INSERT INTO erp_transactions (company_id, type, description, amount, due_date, status, paid_at, paid_amount,
                            party_id, order_id, installment_no, installments_total, method, category)
                         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
                        [req.user.companyId, txType, `${label} - parcela ${p.no}/${p.of}`, p.amount, p.due,
                            paidNow ? 'pago' : 'aberto', paidNow ? new Date() : null, paidNow ? p.amount : null,
                            o.party_id, oid, p.no, p.of, o.payment_method || '', o.type === 'venda' ? 'Vendas' : 'Compras']);
                }
            }
            await c.query(`UPDATE erp_orders SET status='confirmado', confirmed_at=NOW() WHERE id=$1`, [oid]);
        });
        res.json(await loadOrder(req.user.companyId, oid));
    }));

    app.post('/api/erp/orders/:id/cancel', guard, wrap(async (req, res) => {
        const oid = id(req);
        await withTx(async (c) => {
            const q = await c.query('SELECT * FROM erp_orders WHERE id=$1 AND company_id=$2 FOR UPDATE', [oid, req.user.companyId]);
            if (!q.rows.length) throw new ErpError(404, 'Pedido não encontrado.');
            const o = q.rows[0];
            if (o.status === 'cancelado') throw new ErpError(409, 'Este pedido já está cancelado.');
            if (o.status === 'confirmado') {
                const paid = await c.query(`SELECT COUNT(*) AS n FROM erp_transactions WHERE order_id=$1 AND status='pago'`, [oid]);
                if (Number(paid.rows[0].n) > 0) {
                    throw new ErpError(409, 'Há parcelas já pagas/recebidas neste pedido. Estorne-as no Financeiro antes de cancelar.');
                }
                const label = `Cancelamento ${o.type === 'venda' ? 'da venda' : 'da compra'} #${o.number}`;
                const items = await c.query(
                    `SELECT i.*, p.is_service FROM erp_order_items i LEFT JOIN erp_products p ON p.id = i.product_id WHERE i.order_id=$1`, [oid]);
                for (const it of items.rows) {
                    if (!it.product_id || it.is_service) continue;
                    const qty = Number(it.qty);
                    // venda cancelada devolve ao estoque; compra cancelada tira do estoque
                    if (o.type === 'venda') await applyMove(c, req.user.companyId, it.product_id, 'entrada', qty, label, oid, req.user.id);
                    else await applyMove(c, req.user.companyId, it.product_id, 'saida', -qty, label, oid, req.user.id);
                }
                await c.query(`UPDATE erp_transactions SET status='cancelado' WHERE order_id=$1 AND status='aberto'`, [oid]);
            }
            await c.query(`UPDATE erp_orders SET status='cancelado' WHERE id=$1`, [oid]);
        });
        res.json(await loadOrder(req.user.companyId, oid));
    }));

    // ---------- financeiro (somente administradores) ----------
    const txOut = (t) => ({
        id: t.id, type: t.type, description: t.description, amount: Number(t.amount),
        due_date: new Date(t.due_date).toISOString().slice(0, 10), status: t.status,
        overdue: t.status === 'aberto' && new Date(t.due_date).toISOString().slice(0, 10) < todayStr(),
        paid_at: t.paid_at, paid_amount: t.paid_amount === null ? null : Number(t.paid_amount),
        category: t.category || '', party_id: t.party_id, party_name: t.party_name || '', order_id: t.order_id,
        installment_no: t.installment_no, installments_total: t.installments_total, method: t.method || '', notes: t.notes || ''
    });

    app.get('/api/erp/transactions', guard, adminOnly, wrap(async (req, res) => {
        const params = [req.user.companyId];
        let where = 't.company_id = $1';
        if (['receber', 'pagar'].includes(req.query.type)) { params.push(req.query.type); where += ` AND t.type = $${params.length}`; }
        if (['aberto', 'pago', 'cancelado'].includes(req.query.status)) { params.push(req.query.status); where += ` AND t.status = $${params.length}`; }
        if (isDate(req.query.from)) { params.push(req.query.from); where += ` AND t.due_date >= $${params.length}`; }
        if (isDate(req.query.to)) { params.push(req.query.to); where += ` AND t.due_date <= $${params.length}`; }
        const r = await pool.query(
            `SELECT t.*, p.name AS party_name FROM erp_transactions t LEFT JOIN erp_parties p ON p.id = t.party_id
             WHERE ${where} ORDER BY t.due_date ASC, t.id ASC LIMIT 2000`, params);
        res.json(r.rows.map(txOut));
    }));

    function txIn(b) {
        const type = b.type === 'pagar' ? 'pagar' : 'receber';
        const due = String(b.due_date || '').slice(0, 10);
        if (!isDate(due)) throw new ErpError(400, 'A data de vencimento é inválida.');
        return {
            type,
            description: toStr(b.description, 255, { required: true, label: 'descrição' }),
            amount: round2(toNum(b.amount, { min: 0.01, max: 1e12, label: 'valor' })),
            due, category: toStr(b.category, 100, { label: 'categoria' }),
            party_id: parseInt(b.party_id, 10) > 0 ? parseInt(b.party_id, 10) : null,
            method: toStr(b.method, 30, { label: 'forma de pagamento' }),
            notes: toStr(b.notes, 2000, { label: 'observações' })
        };
    }

    app.post('/api/erp/transactions', guard, adminOnly, wrap(async (req, res) => {
        const b = req.body || {};
        const t = txIn(b);
        const parts = splitInstallments(t.amount, b.installments, t.due);
        const paidNow = !!b.paid_now;
        await withTx(async (c) => {
            await assertParty(c, req.user.companyId, t.party_id);
            for (const p of parts) {
                const desc = parts.length > 1 ? `${t.description} (${p.no}/${p.of})` : t.description;
                await c.query(
                    `INSERT INTO erp_transactions (company_id, type, description, amount, due_date, status, paid_at, paid_amount,
                        category, party_id, installment_no, installments_total, method, notes)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
                    [req.user.companyId, t.type, desc.slice(0, 255), p.amount, p.due, paidNow ? 'pago' : 'aberto',
                        paidNow ? new Date() : null, paidNow ? p.amount : null, t.category, t.party_id, p.no, p.of, t.method, t.notes]);
            }
        });
        res.status(201).json({ success: true, created: parts.length });
    }));

    app.put('/api/erp/transactions/:id', guard, adminOnly, wrap(async (req, res) => {
        const t = txIn(req.body || {});
        const cur = await pool.query('SELECT * FROM erp_transactions WHERE id=$1 AND company_id=$2', [id(req), req.user.companyId]);
        if (!cur.rows.length) throw new ErpError(404, 'Lançamento não encontrado.');
        if (cur.rows[0].status !== 'aberto') throw new ErpError(409, 'Só é possível editar lançamentos em aberto.');
        if (cur.rows[0].order_id && Number(cur.rows[0].amount) !== t.amount) {
            throw new ErpError(409, 'O valor de parcelas geradas por pedido não pode ser alterado aqui.');
        }
        await assertParty(pool, req.user.companyId, t.party_id);
        const r = await pool.query(
            `UPDATE erp_transactions SET description=$1, amount=$2, due_date=$3, category=$4, party_id=$5, method=$6, notes=$7
             WHERE id=$8 AND company_id=$9 RETURNING *`,
            [t.description, t.amount, t.due, t.category, t.party_id, t.method, t.notes, cur.rows[0].id, req.user.companyId]);
        res.json(txOut(r.rows[0]));
    }));

    // Baixa (marcar como pago/recebido)
    app.post('/api/erp/transactions/:id/pay', guard, adminOnly, wrap(async (req, res) => {
        const b = req.body || {};
        const paidAmount = b.paid_amount === undefined || b.paid_amount === '' ? null : round2(toNum(b.paid_amount, { min: 0.01, label: 'valor pago' }));
        let paidAt = new Date();
        if (b.paid_date) {
            if (!isDate(String(b.paid_date).slice(0, 10))) throw new ErpError(400, 'A data do pagamento é inválida.');
            paidAt = new Date(`${String(b.paid_date).slice(0, 10)}T12:00:00Z`);
        }
        const r = await pool.query(
            `UPDATE erp_transactions SET status='pago', paid_at=$1, paid_amount=COALESCE($2, amount), method=COALESCE(NULLIF($3,''), method)
             WHERE id=$4 AND company_id=$5 AND status='aberto' RETURNING *`,
            [paidAt, paidAmount, toStr(b.method, 30), id(req), req.user.companyId]);
        if (!r.rows.length) throw new ErpError(409, 'Lançamento não encontrado ou já baixado.');
        res.json(txOut(r.rows[0]));
    }));

    // Estorno: volta de pago para aberto
    app.post('/api/erp/transactions/:id/reopen', guard, adminOnly, wrap(async (req, res) => {
        const r = await pool.query(
            `UPDATE erp_transactions SET status='aberto', paid_at=NULL, paid_amount=NULL
             WHERE id=$1 AND company_id=$2 AND status='pago' RETURNING *`, [id(req), req.user.companyId]);
        if (!r.rows.length) throw new ErpError(409, 'Só é possível estornar lançamentos pagos.');
        res.json(txOut(r.rows[0]));
    }));

    app.post('/api/erp/transactions/:id/cancel', guard, adminOnly, wrap(async (req, res) => {
        const r = await pool.query(
            `UPDATE erp_transactions SET status='cancelado' WHERE id=$1 AND company_id=$2 AND status='aberto' RETURNING *`,
            [id(req), req.user.companyId]);
        if (!r.rows.length) throw new ErpError(409, 'Só é possível cancelar lançamentos em aberto.');
        res.json(txOut(r.rows[0]));
    }));

    app.delete('/api/erp/transactions/:id', guard, adminOnly, wrap(async (req, res) => {
        const r = await pool.query(
            `DELETE FROM erp_transactions WHERE id=$1 AND company_id=$2 AND order_id IS NULL AND status <> 'pago'`,
            [id(req), req.user.companyId]);
        if (!r.rowCount) throw new ErpError(409, 'Só é possível excluir lançamentos manuais que não estejam pagos. Para os demais, use "Cancelar".');
        res.json({ success: true });
    }));

    // ---------- dashboard ----------
    app.get('/api/erp/dashboard', guard, adminOnly, wrap(async (req, res) => {
        const cid = req.user.companyId;
        const one = async (sql, params = [cid]) => (await pool.query(sql, params)).rows;

        const [mes] = await one(`
            SELECT
              COALESCE(SUM(paid_amount) FILTER (WHERE type='receber' AND status='pago' AND paid_at >= date_trunc('month', CURRENT_DATE)), 0) AS recebido_mes,
              COALESCE(SUM(paid_amount) FILTER (WHERE type='pagar' AND status='pago' AND paid_at >= date_trunc('month', CURRENT_DATE)), 0) AS pago_mes,
              COALESCE(SUM(amount) FILTER (WHERE type='receber' AND status='aberto'), 0) AS a_receber,
              COALESCE(SUM(amount) FILTER (WHERE type='pagar' AND status='aberto'), 0) AS a_pagar,
              COALESCE(SUM(amount) FILTER (WHERE type='receber' AND status='aberto' AND due_date < CURRENT_DATE), 0) AS receber_vencido,
              COALESCE(SUM(amount) FILTER (WHERE type='pagar' AND status='aberto' AND due_date < CURRENT_DATE), 0) AS pagar_vencido,
              COUNT(*) FILTER (WHERE type='receber' AND status='aberto' AND due_date < CURRENT_DATE) AS receber_vencido_qtd,
              COUNT(*) FILTER (WHERE type='pagar' AND status='aberto' AND due_date < CURRENT_DATE) AS pagar_vencido_qtd
            FROM erp_transactions WHERE company_id = $1`);

        const [vendas] = await one(`
            SELECT COALESCE(SUM(total),0) AS total, COUNT(*) AS qtd FROM erp_orders
            WHERE company_id=$1 AND type='venda' AND status='confirmado' AND confirmed_at >= date_trunc('month', CURRENT_DATE)`);

        const [estoque] = await one(`
            SELECT COALESCE(SUM(stock * cost_price) FILTER (WHERE is_service = FALSE AND stock > 0), 0) AS valor,
                   COUNT(*) FILTER (WHERE is_service = FALSE AND active AND min_stock > 0 AND stock <= min_stock) AS baixo
            FROM erp_products WHERE company_id=$1`);

        const lowStock = await one(`
            SELECT id, name, unit, stock, min_stock FROM erp_products
            WHERE company_id=$1 AND is_service = FALSE AND active AND min_stock > 0 AND stock <= min_stock
            ORDER BY (stock - min_stock) ASC LIMIT 8`);

        const upcoming = await one(`
            SELECT t.*, p.name AS party_name FROM erp_transactions t LEFT JOIN erp_parties p ON p.id = t.party_id
            WHERE t.company_id=$1 AND t.status='aberto' AND t.due_date <= CURRENT_DATE + 7
            ORDER BY t.due_date ASC LIMIT 8`);

        const top = await one(`
            SELECT i.description, SUM(i.qty) AS qty, SUM(i.total) AS total
            FROM erp_order_items i JOIN erp_orders o ON o.id = i.order_id
            WHERE o.company_id=$1 AND o.type='venda' AND o.status='confirmado' AND o.confirmed_at >= date_trunc('month', CURRENT_DATE)
            GROUP BY i.description ORDER BY total DESC LIMIT 5`);

        const realizado = await one(`
            SELECT to_char(date_trunc('month', paid_at),'YYYY-MM') AS m, type, SUM(paid_amount) AS v
            FROM erp_transactions
            WHERE company_id=$1 AND status='pago' AND paid_at >= date_trunc('month', CURRENT_DATE) - interval '5 months'
            GROUP BY 1,2`);
        const previsto = await one(`
            SELECT to_char(date_trunc('month', GREATEST(due_date, CURRENT_DATE)),'YYYY-MM') AS m, type, SUM(amount) AS v
            FROM erp_transactions
            WHERE company_id=$1 AND status='aberto' AND due_date < date_trunc('month', CURRENT_DATE) + interval '4 months'
            GROUP BY 1,2`);

        // série mensal: 5 meses para trás + mês atual + 3 à frente
        const months = [];
        const now = new Date();
        for (let k = -5; k <= 3; k++) {
            const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + k, 1));
            months.push(d.toISOString().slice(0, 7));
        }
        const cur = now.toISOString().slice(0, 7);
        const cashflow = months.map((m) => {
            const g = (rows, t) => Number((rows.find((r) => r.m === m && r.type === t) || {}).v || 0);
            return {
                month: m, current: m === cur,
                recebido: g(realizado, 'receber'), pago: g(realizado, 'pagar'),
                a_receber: g(previsto, 'receber'), a_pagar: g(previsto, 'pagar')
            };
        });

        res.json({
            recebido_mes: Number(mes.recebido_mes), pago_mes: Number(mes.pago_mes),
            resultado_mes: round2(Number(mes.recebido_mes) - Number(mes.pago_mes)),
            a_receber: Number(mes.a_receber), a_pagar: Number(mes.a_pagar),
            receber_vencido: Number(mes.receber_vencido), pagar_vencido: Number(mes.pagar_vencido),
            receber_vencido_qtd: Number(mes.receber_vencido_qtd), pagar_vencido_qtd: Number(mes.pagar_vencido_qtd),
            vendas_mes: Number(vendas.total), vendas_mes_qtd: Number(vendas.qtd),
            estoque_valor: Number(estoque.valor), estoque_baixo: Number(estoque.baixo),
            low_stock: lowStock.map((p) => ({ id: p.id, name: p.name, unit: p.unit, stock: Number(p.stock), min_stock: Number(p.min_stock) })),
            upcoming: upcoming.map(txOut),
            top_products: top.map((t) => ({ description: t.description, qty: Number(t.qty), total: Number(t.total) })),
            cashflow
        });
    }));

    // =====================================================================
    // NOTA FISCAL DE SERVIÇO (NFS-e) via Focus NFe
    // Plano Pro AI (canUseErpFiscal) + cargo de administrador. Cada empresa usa o PRÓPRIO token da Focus
    // (guardado criptografado). O ambiente padrão é HOMOLOGAÇÃO (sem validade fiscal): produção só com tudo configurado.
    // =====================================================================
    const FISCAL_PLAN_MESSAGE = 'A emissão de notas fiscais (Focus NFe) é exclusiva do plano Pro AI. Faça upgrade na aba Planos & Assinatura para liberar esse recurso.';
    const hasFiscalPlan = (req) => hasErpPlan(req) && typeof canUseErpFiscal === 'function'
        && (!!req.user.isSiteOwner || canUseErpFiscal(req.user.plan_tier || req.user.planTier, req.user.plan_status || 'ACTIVE'));
    const fiscalGuard = (req, res, next) => (hasFiscalPlan(req)
        ? next()
        : res.status(403).json({ code: 'PLAN_FISCAL_REQUIRED', message: FISCAL_PLAN_MESSAGE }));
    const fiscalChain = [...guard, fiscalGuard, adminOnly];

    const FISCAL_DEFAULTS = {
        has_token: false, ambiente: 'homologacao', cnpj: '', inscricao_municipal: '', codigo_municipio: '',
        optante_simples: true, regime_especial: '', natureza_operacao: '1', item_lista_servico: '',
        codigo_tributario_municipio: '', aliquota: 0, iss_retido: false,
        inscricao_estadual: '', regime_tributario: '', uf: '', pis_cofins_situacao: '07'
    };

    const settingsOut = (r) => (r ? {
        has_token: !!r.token_enc, ambiente: r.ambiente, cnpj: r.cnpj || '', inscricao_municipal: r.inscricao_municipal || '',
        codigo_municipio: r.codigo_municipio || '', optante_simples: !!r.optante_simples, regime_especial: r.regime_especial || '',
        natureza_operacao: r.natureza_operacao || '1', item_lista_servico: r.item_lista_servico || '',
        codigo_tributario_municipio: r.codigo_tributario_municipio || '', aliquota: Number(r.aliquota) || 0, iss_retido: !!r.iss_retido,
        inscricao_estadual: r.inscricao_estadual || '', regime_tributario: r.regime_tributario || '', uf: r.uf || '',
        pis_cofins_situacao: r.pis_cofins_situacao || '07'
    } : { ...FISCAL_DEFAULTS });

    const docOut = (r) => ({
        id: r.id, kind: r.kind, ref: r.ref, order_id: r.order_id, order_number: r.order_number === undefined ? null : r.order_number,
        party_id: r.party_id, party_name: r.party_name || '', amount: Number(r.amount),
        chave: r.chave || '', serie: r.serie || '', danfe_url: r.danfe_url || '',
        description: r.description || '', status: r.status, ambiente: r.ambiente, numero: r.numero || '',
        codigo_verificacao: r.codigo_verificacao || '', url: r.url || '', xml_url: r.xml_url || '', errors: r.errors || '',
        created_at: r.created_at, updated_at: r.updated_at
    });

    async function loadFiscalSettings(companyId) {
        const r = await pool.query('SELECT * FROM erp_fiscal_settings WHERE company_id = $1', [companyId]);
        return r.rows[0] || null;
    }

    const flag = (v, def) => (v === undefined || v === null || v === '' ? def : ['true', '1', 'sim', 's', 'on'].includes(String(v).toLowerCase()));

    function fiscalSettingsIn(b, current) {
        const cur = settingsOut(current);
        const ambiente = b.ambiente === undefined ? cur.ambiente : String(b.ambiente);
        if (!focus.AMBIENTES.includes(ambiente)) throw new ErpError(400, 'O ambiente deve ser homologação ou produção.');
        const cnpj = b.cnpj === undefined ? cur.cnpj : focus.onlyDigits(b.cnpj);
        if (cnpj && !focus.isValidCNPJ(cnpj)) throw new ErpError(400, 'O CNPJ informado é inválido.');
        const codMun = b.codigo_municipio === undefined ? cur.codigo_municipio : focus.onlyDigits(b.codigo_municipio);
        if (codMun && codMun.length !== 7) throw new ErpError(400, 'O código IBGE do município tem 7 dígitos.');
        const natureza = b.natureza_operacao === undefined ? cur.natureza_operacao : toStr(b.natureza_operacao, 2, { label: 'natureza da operação' });
        if (natureza && !/^[1-6]$/.test(natureza)) throw new ErpError(400, 'A natureza da operação deve ser de 1 a 6.');
        const regime = b.regime_especial === undefined ? cur.regime_especial : toStr(b.regime_especial, 2, { label: 'regime especial' });
        if (regime && !/^[0-9]{1,2}$/.test(regime)) throw new ErpError(400, 'O regime especial de tributação é inválido.');
        const regimeTrib = b.regime_tributario === undefined ? cur.regime_tributario : String(b.regime_tributario).trim();
        if (regimeTrib && !['1', '2', '3'].includes(regimeTrib)) throw new ErpError(400, 'O regime tributário deve ser 1 (Simples Nacional), 2 (Simples, excesso de sublimite) ou 3 (Normal).');
        const uf = b.uf === undefined ? cur.uf : String(b.uf).trim().toUpperCase();
        if (uf && !focus.isUF(uf)) throw new ErpError(400, 'A UF da empresa é inválida.');
        const pisCofins = b.pis_cofins_situacao === undefined ? cur.pis_cofins_situacao : String(b.pis_cofins_situacao).trim();
        if (!focus.PIS_COFINS_SEM_VALOR.includes(pisCofins)) throw new ErpError(400, `A situação tributária de PIS/COFINS deve ser uma destas: ${focus.PIS_COFINS_SEM_VALOR.join(', ')}.`);
        return {
            inscricao_estadual: b.inscricao_estadual === undefined ? cur.inscricao_estadual : toStr(b.inscricao_estadual, 30, { label: 'inscrição estadual' }),
            regime_tributario: regimeTrib, uf, pis_cofins_situacao: pisCofins,
            ambiente, cnpj,
            inscricao_municipal: b.inscricao_municipal === undefined ? cur.inscricao_municipal : toStr(b.inscricao_municipal, 30, { label: 'inscrição municipal' }),
            codigo_municipio: codMun,
            optante_simples: flag(b.optante_simples, cur.optante_simples),
            regime_especial: regime,
            natureza_operacao: natureza || '1',
            item_lista_servico: b.item_lista_servico === undefined ? cur.item_lista_servico : toStr(b.item_lista_servico, 10, { label: 'item da lista de serviços' }),
            codigo_tributario_municipio: b.codigo_tributario_municipio === undefined ? cur.codigo_tributario_municipio : toStr(b.codigo_tributario_municipio, 20, { label: 'código tributário do município' }),
            aliquota: b.aliquota === undefined ? cur.aliquota : toNum(b.aliquota, { min: 0, max: 100, label: 'alíquota' }),
            iss_retido: flag(b.iss_retido, cur.iss_retido)
        };
    }

    async function saveFiscalSettings(companyId, b) {
        const current = await loadFiscalSettings(companyId);
        const s = fiscalSettingsIn(b, current);
        let tokenEnc = current ? current.token_enc || '' : '';
        if (b.remove_token) tokenEnc = '';
        else if (typeof b.token === 'string' && b.token.trim()) {
            if (b.token.trim().length < 10 || b.token.trim().length > 200) throw new ErpError(400, 'O token da Focus NFe parece inválido.');
            tokenEnc = enc(b.token.trim());
        }
        if (s.ambiente === 'producao') {
            const faltam = focus.missingSettings({ ...s, has_token: !!tokenEnc });
            if (faltam.length) throw new ErpError(400, `Para usar o ambiente de produção, configure antes: ${faltam.join(', ')}.`);
        }
        await pool.query(
            `INSERT INTO erp_fiscal_settings (company_id, token_enc, ambiente, cnpj, inscricao_municipal, codigo_municipio, optante_simples,
                regime_especial, natureza_operacao, item_lista_servico, codigo_tributario_municipio, aliquota, iss_retido,
                inscricao_estadual, regime_tributario, uf, pis_cofins_situacao, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW())
             ON CONFLICT (company_id) DO UPDATE SET token_enc=$2, ambiente=$3, cnpj=$4, inscricao_municipal=$5, codigo_municipio=$6,
                optante_simples=$7, regime_especial=$8, natureza_operacao=$9, item_lista_servico=$10, codigo_tributario_municipio=$11,
                aliquota=$12, iss_retido=$13, inscricao_estadual=$14, regime_tributario=$15, uf=$16, pis_cofins_situacao=$17, updated_at=NOW()`,
            [companyId, tokenEnc, s.ambiente, s.cnpj, s.inscricao_municipal, s.codigo_municipio, s.optante_simples, s.regime_especial,
                s.natureza_operacao, s.item_lista_servico, s.codigo_tributario_municipio, s.aliquota, s.iss_retido,
                s.inscricao_estadual, s.regime_tributario, s.uf, s.pis_cofins_situacao]);
        return settingsOut(await loadFiscalSettings(companyId));
    }

    const compactAddress = (e) => Object.fromEntries(Object.entries(e || {}).filter(([, v]) => String(v === undefined || v === null ? '' : v).trim() !== ''));

    // Grava o registro da nota, envia à Focus e devolve o registro atualizado. Serve para NFS-e e NF-e.
    async function dispatchDoc({ companyId, userId, kind, payload, orderId, partyId, valor, descricao, s, token }) {
        const ref = focus.newRef(companyId);
        const ins = await pool.query(
            `INSERT INTO erp_fiscal_docs (company_id, kind, ref, order_id, party_id, amount, description, status, ambiente, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,'enviando',$8,$9) RETURNING *`,
            [companyId, kind, ref, orderId, partyId, valor, descricao, s.ambiente, userId]);
        const docId = ins.rows[0].id;
        const fail = async (status, text) => {
            await pool.query(`UPDATE erp_fiscal_docs SET status=$1, errors=$2, updated_at=NOW() WHERE id=$3`, [status, String(text).slice(0, 1500), docId]);
        };
        let resp;
        try {
            resp = await focus.focusRequest({ token, ambiente: s.ambiente, method: 'POST', path: `${focus.docPath(kind)}?ref=${encodeURIComponent(ref)}`, body: payload });
        } catch (err) {
            await fail('erro_envio', err.message);
            throw new ErpError(502, `${err.message} A nota foi registrada como "erro de envio": use Atualizar para conferir se a Focus chegou a receber.`);
        }
        if (resp.status !== 200 && resp.status !== 201 && resp.status !== 202) {
            const txt = focus.errosToText(resp.data) || `HTTP ${resp.status}`;
            await fail('erro_envio', txt);
            throw new ErpError(422, `A Focus NFe recusou o envio: ${txt}`);
        }
        const up = await pool.query(
            `UPDATE erp_fiscal_docs SET status='processando_autorizacao', updated_at=NOW() WHERE id=$1 RETURNING *`, [docId]);
        return docOut(up.rows[0]);
    }

    async function emitNfse(companyId, userId, input) {
        const row = await loadFiscalSettings(companyId);
        const s = settingsOut(row);
        const faltam = focus.missingSettings(s);
        if (faltam.length) throw new ErpError(400, `Antes de emitir, configure os dados fiscais: ${faltam.join(', ')}.`);
        const token = dec(row.token_enc);

        let valor = input.valor;
        let descricao = input.descricao;
        let partyId = input.partyId || null;
        let orderId = null;

        if (input.orderId) {
            const o = await pool.query('SELECT * FROM erp_orders WHERE id=$1 AND company_id=$2', [input.orderId, companyId]);
            if (!o.rows.length) throw new ErpError(404, 'Pedido não encontrado.');
            const ord = o.rows[0];
            if (ord.type !== 'venda') throw new ErpError(400, 'Só é possível emitir nota de pedidos de venda.');
            if (ord.status !== 'confirmado') throw new ErpError(409, 'Confirme o pedido antes de emitir a nota.');
            const dup = await pool.query(
                `SELECT id FROM erp_fiscal_docs WHERE company_id=$1 AND order_id=$2 AND kind=$3 AND status IN ('processando_autorizacao','autorizado') LIMIT 1`,
                [companyId, ord.id, 'nfse']);
            if (dup.rows.length) throw new ErpError(409, 'Este pedido já tem uma nota emitida ou em processamento.');
            orderId = ord.id;
            partyId = partyId || ord.party_id;
            valor = Number(ord.total);
            if (!descricao) {
                const it = await pool.query('SELECT description, qty FROM erp_order_items WHERE order_id=$1 ORDER BY id', [ord.id]);
                descricao = it.rows.map((x) => `${Number(x.qty)} x ${x.description}`).join('; ');
            }
        }

        let party = null;
        if (partyId) {
            const p = await pool.query('SELECT * FROM erp_parties WHERE id=$1 AND company_id=$2', [partyId, companyId]);
            if (!p.rows.length) throw new ErpError(404, 'Cliente não encontrado.');
            party = partyOut(p.rows[0]);
        }

        const t = input.tomador || {};
        const tomador = {
            documento: focus.onlyDigits(t.documento || (party && party.doc) || ''),
            razao_social: toStr(t.razao_social || (party && party.name) || '', 150, { label: 'nome do cliente' }),
            email: toStr(t.email || (party && party.email) || '', 120, { label: 'e-mail' }),
            telefone: toStr(t.telefone || (party && party.phone) || '', 30, { label: 'telefone' }),
            // O endereço salvo no cadastro do cliente vai na nota; o que vier na chamada tem prioridade campo a campo.
            endereco: { ...compactAddress(party && party.endereco), ...compactAddress(t.endereco) }
        };
        if (!(focus.isValidCNPJ(tomador.documento) || focus.isValidCPF(tomador.documento))) {
            throw new ErpError(400, 'Informe um CPF ou CNPJ válido do cliente para emitir a nota.');
        }
        if (!tomador.razao_social) throw new ErpError(400, 'Informe o nome do cliente para emitir a nota.');
        valor = round2(toNum(valor, { min: 0.01, max: 1e9, label: 'valor da nota' }));
        descricao = toStr(descricao, 2000, { required: true, label: 'descrição do serviço' });

        const payload = focus.buildNfsePayload({ settings: { ...s }, tomador, servico: { discriminacao: descricao, valor } });
        return dispatchDoc({ companyId, userId, kind: 'nfse', payload, orderId, partyId, valor, descricao, s, token });
    }

    // NF-e (nota fiscal de PRODUTO) de um pedido de venda confirmado. Só os itens que são produtos entram na nota.
    async function emitNfe(companyId, userId, input) {
        const row = await loadFiscalSettings(companyId);
        const s = settingsOut(row);
        const faltam = focus.missingNfeSettings(s);
        if (faltam.length) throw new ErpError(400, `Antes de emitir a NF-e, configure os dados fiscais: ${faltam.join(', ')}.`);
        const token = dec(row.token_enc);

        const o = await pool.query('SELECT * FROM erp_orders WHERE id=$1 AND company_id=$2', [input.orderId, companyId]);
        if (!o.rows.length) throw new ErpError(404, 'Pedido não encontrado.');
        const ord = o.rows[0];
        if (ord.type !== 'venda') throw new ErpError(400, 'Só é possível emitir nota de pedidos de venda.');
        if (ord.status !== 'confirmado') throw new ErpError(409, 'Confirme o pedido antes de emitir a nota.');
        const dup = await pool.query(
            `SELECT id FROM erp_fiscal_docs WHERE company_id=$1 AND order_id=$2 AND kind=$3 AND status IN ('processando_autorizacao','autorizado') LIMIT 1`,
            [companyId, ord.id, 'nfe']);
        if (dup.rows.length) throw new ErpError(409, 'Este pedido já tem uma NF-e emitida ou em processamento.');
        if (!ord.party_id) throw new ErpError(400, 'O pedido precisa ter um cliente para emitir a NF-e.');

        const p = await pool.query('SELECT * FROM erp_parties WHERE id=$1 AND company_id=$2', [ord.party_id, companyId]);
        if (!p.rows.length) throw new ErpError(404, 'Cliente não encontrado.');
        const party = partyOut(p.rows[0]);
        const documento = focus.onlyDigits(party.doc);
        if (!(focus.isValidCNPJ(documento) || focus.isValidCPF(documento))) {
            throw new ErpError(400, `Informe um CPF ou CNPJ válido no cadastro de "${party.name}" para emitir a NF-e.`);
        }
        const endFalta = focus.missingAddress(party.endereco);
        if (endFalta.length) throw new ErpError(400, `A NF-e exige o endereço completo do cliente. No cadastro de "${party.name}" falta: ${endFalta.join(', ')}.`);

        const it = await pool.query(
            `SELECT i.*, p.sku, p.unit AS p_unit, p.is_service, p.ncm, p.cest, p.cfop, p.origem, p.icms_situacao, p.icms_aliquota
             FROM erp_order_items i LEFT JOIN erp_products p ON p.id = i.product_id WHERE i.order_id=$1 ORDER BY i.id`, [ord.id]);
        const todos = it.rows;
        const semCadastro = todos.filter((x) => !x.product_id);
        if (semCadastro.length) {
            throw new ErpError(400, `Estes itens do pedido não são produtos cadastrados e não têm dados fiscais: ${semCadastro.map((x) => `"${x.description}"`).join(', ')}.`);
        }
        const produtos = todos.filter((x) => !x.is_service);
        if (!produtos.length) throw new ErpError(400, 'Este pedido só tem serviços. Para serviço, emita a NFS-e (nota de serviço).');

        const valorItem = (x) => round2(round2(x.unit_price) * Number(x.qty));
        const subProdutos = round2(produtos.reduce((acc, x) => acc + valorItem(x), 0));
        const subTodos = round2(todos.reduce((acc, x) => acc + round2(round2(x.unit_price) * Number(x.qty)), 0));
        const descontoProdutos = subTodos > 0 ? round2(Number(ord.discount || 0) * subProdutos / subTodos) : 0;
        const descontos = focus.allocateDiscount(produtos.map(valorItem), descontoProdutos);

        const itens = produtos.map((x, i) => ({
            codigo: x.sku || String(x.product_id), nome: x.description, unidade: x.p_unit || 'un', qtd: Number(x.qty),
            valor_unitario: Number(x.unit_price), desconto: descontos[i],
            ncm: x.ncm, cest: x.cest, cfop: x.cfop, origem: x.origem, icms_situacao: x.icms_situacao, icms_aliquota: Number(x.icms_aliquota) || 0
        }));
        const problemas = focus.productFiscalProblems(itens, { regime: s.regime_tributario, ufEmitente: s.uf, ufDestino: party.endereco.uf });
        if (problemas.length) throw new ErpError(400, `Corrija os dados fiscais dos produtos antes de emitir a NF-e: ${problemas.join('; ')}.`);

        const payload = focus.buildNfePayload({
            settings: s,
            destinatario: { documento, nome: party.name, email: party.email, telefone: party.phone, endereco: party.endereco },
            itens,
            pagamento: { forma: focus.formaPagamentoNfe(ord.payment_method) },
            presenca: ['0', '1', '2', '3', '4', '9'].includes(String(input.presenca)) ? String(input.presenca) : '1'
        });
        const descricao = toStr(itens.map((x) => `${x.qtd} x ${x.nome}`).join('; '), 2000, { label: 'descrição' });
        return dispatchDoc({ companyId, userId, kind: 'nfe', payload, orderId: ord.id, partyId: ord.party_id, valor: payload.valor_total, descricao, s, token });
    }

    async function refreshNfse(companyId, docId) {
        const d = await pool.query('SELECT * FROM erp_fiscal_docs WHERE id=$1 AND company_id=$2', [docId, companyId]);
        if (!d.rows.length) throw new ErpError(404, 'Nota não encontrada.');
        const doc = d.rows[0];
        const row = await loadFiscalSettings(companyId);
        if (!row || !row.token_enc) throw new ErpError(400, 'O token da Focus NFe não está configurado.');
        const resp = await focus.focusRequest({ token: dec(row.token_enc), ambiente: doc.ambiente, method: 'GET', path: focus.docPath(doc.kind, doc.ref) });
        if (resp.status === 404) return docOut(doc); // a Focus ainda não conhece essa ref
        if (resp.status >= 400) throw new ErpError(502, `A Focus NFe respondeu com erro ao consultar a nota: ${focus.errosToText(resp.data) || 'HTTP ' + resp.status}`);
        const p = focus.parseStatus(resp.data, doc.ambiente);
        let status = p.status;
        if (doc.status === 'cancelando' && status === 'autorizado') status = 'cancelando'; // cancelamento ainda em andamento
        const up = await pool.query(
            `UPDATE erp_fiscal_docs SET status=$1, numero=COALESCE(NULLIF($2,''), numero), codigo_verificacao=COALESCE(NULLIF($3,''), codigo_verificacao),
                url=COALESCE(NULLIF($4,''), url), xml_url=COALESCE(NULLIF($5,''), xml_url), errors=$6, updated_at=NOW(),
                chave=COALESCE(NULLIF($9,''), chave), serie=COALESCE(NULLIF($10,''), serie), danfe_url=COALESCE(NULLIF($11,''), danfe_url)
             WHERE id=$7 AND company_id=$8 RETURNING *`,
            [status, p.numero, p.codigo_verificacao, p.url, p.xml_url, p.errors, doc.id, companyId, p.chave, p.serie, p.danfe_url]);
        return docOut(up.rows[0]);
    }

    async function cancelNfse(companyId, docId, justificativa) {
        const j = toStr(justificativa, 255, { required: true, label: 'justificativa' });
        if (j.length < 15) throw new ErpError(400, 'A justificativa do cancelamento precisa ter pelo menos 15 caracteres.');
        const d = await pool.query('SELECT * FROM erp_fiscal_docs WHERE id=$1 AND company_id=$2', [docId, companyId]);
        if (!d.rows.length) throw new ErpError(404, 'Nota não encontrada.');
        const doc = d.rows[0];
        if (doc.status !== 'autorizado') throw new ErpError(409, 'Só é possível cancelar uma nota já autorizada.');
        const row = await loadFiscalSettings(companyId);
        if (!row || !row.token_enc) throw new ErpError(400, 'O token da Focus NFe não está configurado.');
        const resp = await focus.focusRequest({ token: dec(row.token_enc), ambiente: doc.ambiente, method: 'DELETE', path: focus.docPath(doc.kind, doc.ref), body: { justificativa: j } });
        if (resp.status >= 400) {
            throw new ErpError(422, `O cancelamento foi recusado: ${focus.errosToText(resp.data) || 'HTTP ' + resp.status}`);
        }
        const up = await pool.query(`UPDATE erp_fiscal_docs SET status='cancelando', updated_at=NOW() WHERE id=$1 AND company_id=$2 RETURNING *`, [doc.id, companyId]);
        return docOut(up.rows[0]);
    }

    app.get('/api/erp/fiscal/settings', fiscalChain, wrap(async (req, res) => {
        res.json(settingsOut(await loadFiscalSettings(req.user.companyId)));
    }));

    app.put('/api/erp/fiscal/settings', fiscalChain, wrap(async (req, res) => {
        res.json(await saveFiscalSettings(req.user.companyId, req.body || {}));
    }));

    app.get('/api/erp/fiscal/docs', fiscalChain, wrap(async (req, res) => {
        const r = await pool.query(
            `SELECT f.*, o.number AS order_number, pa.name AS party_name FROM erp_fiscal_docs f
             LEFT JOIN erp_orders o ON o.id = f.order_id LEFT JOIN erp_parties pa ON pa.id = f.party_id
             WHERE f.company_id=$1 ORDER BY f.id DESC LIMIT 200`, [req.user.companyId]);
        res.json(r.rows.map(docOut));
    }));

    app.post('/api/erp/fiscal/nfe', fiscalChain, wrap(async (req, res) => {
        const b = req.body || {};
        const orderId = parseInt(b.order_id, 10);
        if (!(orderId > 0)) throw new ErpError(400, 'Informe o pedido de venda para emitir a NF-e.');
        res.status(201).json(await emitNfe(req.user.companyId, req.user.id, { orderId, presenca: b.presenca }));
    }));

    app.post('/api/erp/fiscal/nfse', fiscalChain, wrap(async (req, res) => {
        const b = req.body || {};
        const orderId = b.order_id === undefined || b.order_id === null || b.order_id === '' ? null : parseInt(b.order_id, 10);
        if (orderId !== null && !(orderId > 0)) throw new ErpError(400, 'Pedido inválido.');
        const doc = await emitNfse(req.user.companyId, req.user.id, {
            orderId, partyId: parseInt(b.party_id, 10) || null, descricao: b.descricao, valor: b.valor, tomador: b.tomador
        });
        res.status(201).json(doc);
    }));

    app.post('/api/erp/fiscal/docs/:id/refresh', fiscalChain, wrap(async (req, res) => {
        res.json(await refreshNfse(req.user.companyId, id(req)));
    }));

    // Baixa o PDF (DANFE) ou o XML da nota pelo servidor. O navegador não busca direto na Focus (CSP e CORS),
    // e assim o mesmo caminho serve para imprimir e para baixar. Só aceita endereços da própria Focus NFe.
    app.get('/api/erp/fiscal/docs/:id/file', fiscalChain, wrap(async (req, res) => {
        const tipo = String(req.query.tipo || '').toLowerCase();
        if (!['danfe', 'xml'].includes(tipo)) throw new ErpError(400, 'Escolha o arquivo: danfe (PDF) ou xml.');
        const r = await pool.query('SELECT * FROM erp_fiscal_docs WHERE id=$1 AND company_id=$2', [id(req), req.user.companyId]);
        if (!r.rows.length) throw new ErpError(404, 'Nota não encontrada.');
        const doc = r.rows[0];
        const url = tipo === 'danfe' ? doc.danfe_url : doc.xml_url;
        if (!url) throw new ErpError(404, tipo === 'danfe' ? 'Esta nota não tem DANFE em PDF (use o comprovante).' : 'O XML ainda não está disponível. Atualize a situação da nota.');
        let host = '';
        try { host = new URL(url).hostname.toLowerCase(); } catch (e) { /* url inválida */ }
        if (!(host === 'focusnfe.com.br' || host.endsWith('.focusnfe.com.br'))) throw new ErpError(400, 'Endereço do arquivo não permitido.');
        let resp;
        try {
            resp = await (deps.fetchImpl || global.fetch)(url, { redirect: 'follow' });
        } catch (e) {
            throw new ErpError(502, 'Não foi possível buscar o arquivo na Focus NFe agora. Tente de novo.');
        }
        if (!resp.ok) throw new ErpError(502, 'A Focus NFe não devolveu o arquivo (HTTP ' + resp.status + ').');
        const buf = Buffer.from(await resp.arrayBuffer());
        const base = `${doc.kind === 'nfe' ? 'NFe' : 'NFSe'}-${String(doc.numero || doc.id).replace(/[^A-Za-z0-9_-]/g, '')}`;
        res.set({
            'Content-Type': tipo === 'danfe' ? 'application/pdf' : 'application/xml; charset=utf-8',
            'Content-Disposition': `attachment; filename="${base}.${tipo === 'danfe' ? 'pdf' : 'xml'}"`,
            'Cache-Control': 'private, no-store',
            'X-Content-Type-Options': 'nosniff'
        });
        res.send(buf);
    }));

    app.post('/api/erp/fiscal/docs/:id/cancel', fiscalChain, wrap(async (req, res) => {
        res.json(await cancelNfse(req.user.companyId, id(req), (req.body || {}).justificativa));
    }));

    // =====================================================================
    // AÇÕES DA CLÁUDIA (IA) NO ERP
    // Mesmas regras das rotas acima: tudo filtrado por empresa, plano checado, cargo checado no Financeiro.
    // A IA só CRIA e CONSULTA (e dá baixa em contas). Excluir, cancelar e estornar ficam na aba ERP.
    // Cada ação devolve um texto pronto para a Cláudia mostrar no chat; erros viram ErpError (mensagem clara).
    // =====================================================================
    const AI_BASE = ['erpCriarCadastro', 'erpBuscarCadastro', 'erpCriarProduto', 'erpMovimentarEstoque', 'erpConsultarEstoque'];
    const AI_FINANCE = ['erpLancarConta', 'erpBaixarConta', 'erpListarContas', 'erpResumoFinanceiro'];
    const AI_FISCAL = ['erpEmitirNota', 'erpConsultarNota', 'erpEmitirNfe'];

    const brl = (v) => Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    const brDate = (s) => String(s).slice(0, 10).split('-').reverse().join('/');
    const qtyTxt = (n) => Number(n).toLocaleString('pt-BR', { maximumFractionDigits: 3 });
    const normTxt = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
    const yes = (v) => ['sim', 's', 'true', '1', 'yes'].includes(normTxt(v));

    // Aceita "1500", "1.500,50", "R$ 1.500,50" e "12,5"
    function numBR(v) {
        if (v === undefined || v === null) return v;
        let s = String(v).replace(/R\$/gi, '').replace(/\s+/g, '');
        if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
        return s;
    }

    function aiAllow(ctx, { finance = false, fiscal = false } = {}) {
        if (!ctx || !ctx.companyId) throw new ErpError(403, 'Você não está vinculado a nenhuma empresa.');
        if (!ctx.planOk) throw new ErpError(403, ERP_PLAN_MESSAGE);
        if (fiscal && !ctx.fiscalOk) throw new ErpError(403, FISCAL_PLAN_MESSAGE);
        if (finance && !ADMIN_ROLES.includes(ctx.role)) {
            throw new ErpError(403, 'Apenas administradores da empresa (Dono, Admin ou Gerente) podem usar o Financeiro.');
        }
    }

    function pickOne(list, term, what, labelOf) {
        if (!String(term || '').trim()) throw new ErpError(400, `Diga o nome do ${what}.`);
        if (!list.length) throw new ErpError(404, `Não encontrei ${what} com "${term}".`);
        if (list.length > 1) {
            throw new ErpError(409, `Encontrei ${list.length} resultados parecidos (${list.slice(0, 5).map(labelOf).join('; ')}). Informe o nome completo.`);
        }
        return list[0];
    }

    async function findParties(companyId, term) {
        const r = await pool.query('SELECT * FROM erp_parties WHERE company_id = $1 AND active = TRUE ORDER BY name ASC LIMIT 5000', [companyId]);
        const all = r.rows.map(partyOut);
        const q = normTxt(term);
        if (!q) return all;
        const digits = q.replace(/\D/g, '');
        const exact = all.filter((p) => normTxt(p.name) === q || (digits.length >= 6 && String(p.doc || '').replace(/\D/g, '') === digits));
        if (exact.length) return exact;
        return all.filter((p) => normTxt(p.name).includes(q));
    }

    async function findProducts(companyId, term) {
        const r = await pool.query('SELECT * FROM erp_products WHERE company_id = $1 AND active = TRUE ORDER BY name ASC LIMIT 5000', [companyId]);
        const all = r.rows.map(productOut);
        const q = normTxt(term);
        if (!q) return all;
        const exact = all.filter((p) => normTxt(p.name) === q || (p.sku && normTxt(p.sku) === q));
        if (exact.length) return exact;
        return all.filter((p) => normTxt(p.name).includes(q));
    }

    const aiActions = {
        async erpCriarCadastro(ctx, p) {
            aiAllow(ctx);
            const kindRaw = normTxt(p.tipo);
            // Endereço estruturado: o que o usuário disse + o que o CEP completa (logradouro, bairro, cidade, UF e código IBGE).
            let endereco;
            const temEndereco = ['cep', 'logradouro', 'numero', 'complemento', 'bairro', 'cidade', 'uf', 'codigoMunicipio'].some((k) => String(p[k] || '').trim());
            if (temEndereco) {
                endereco = {
                    cep: p.cep, logradouro: p.logradouro, numero: p.numero, complemento: p.complemento, bairro: p.bairro,
                    cidade: p.cidade, uf: p.uf, codigo_municipio: p.codigoMunicipio
                };
                if (focus.onlyDigits(p.cep).length === 8 && (!String(p.logradouro || '').trim() || !focus.onlyDigits(p.codigoMunicipio))) {
                    const achou = await cepLookup(p.cep);
                    if (achou) {
                        for (const k of ['logradouro', 'bairro', 'cidade', 'uf', 'codigo_municipio']) {
                            if (!String(endereco[k] || '').trim()) endereco[k] = achou[k];
                        }
                    }
                }
            }
            const party = partyIn({
                kind: ['cliente', 'fornecedor', 'ambos'].includes(kindRaw) ? kindRaw : 'cliente',
                name: p.nome, doc: p.documento, phone: p.telefone, email: p.email, address: p.endereco, notes: p.observacoes,
                endereco
            });
            const same = (await findParties(ctx.companyId, party.name)).filter((x) => normTxt(x.name) === normTxt(party.name));
            if (same.length) throw new ErpError(409, `Já existe um cadastro chamado "${party.name}" no ERP.`);
            await pool.query(
                `INSERT INTO erp_parties (company_id, kind, name, doc, phone, email, address, notes, active,
                    addr_logradouro, addr_numero, addr_complemento, addr_bairro, addr_cidade, addr_codigo_municipio, addr_uf, addr_cep)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,TRUE,$9,$10,$11,$12,$13,$14,$15,$16)`,
                [ctx.companyId, party.kind, party.name, party.doc, party.phone, party.email, party.address, party.notes, ...addrParams(party.endereco, true)]
            );
            const falta = party.endereco ? focus.missingAddress(party.endereco) : [];
            const aviso = party.endereco && falta.length ? ` Atenção: ao endereço ainda falta ${falta.join(', ')} (necessário para emitir nota fiscal).` : '';
            return `Cadastro "${party.name}" criado no ERP como ${party.kind}.${aviso}`;
        },

        async erpBuscarCadastro(ctx, p) {
            aiAllow(ctx);
            const found = await findParties(ctx.companyId, p.busca);
            if (!String(p.busca || '').trim()) throw new ErpError(400, 'Diga o nome (ou CPF/CNPJ) que quer procurar.');
            if (!found.length) return `Não encontrei nenhum cadastro com "${p.busca}" no ERP.`;
            const lines = found.slice(0, 5).map((x) => `• ${x.name} (${x.kind})${x.phone ? ' · ' + x.phone : ''}${x.email ? ' · ' + x.email : ''}`);
            return `Encontrei ${found.length} cadastro(s):\n${lines.join('\n')}${found.length > 5 ? '\n…e mais ' + (found.length - 5) + '.' : ''}`;
        },

        async erpCriarProduto(ctx, p) {
            aiAllow(ctx);
            const isService = yes(p.servico);
            const prod = productIn({
                name: p.nome, sku: p.sku, category: p.categoria, unit: p.unidade, is_service: isService,
                cost_price: numBR(p.precoCusto), sale_price: numBR(p.precoVenda), min_stock: numBR(p.estoqueMinimo),
                ncm: p.ncm, cest: p.cest, cfop: p.cfop, origem: p.origem, icms_situacao: p.icmsSituacao, icms_aliquota: numBR(p.icmsAliquota)
            });
            const initial = isService ? 0 : toNum(numBR(p.estoqueInicial), { label: 'estoque inicial' });
            await withTx(async (c) => {
                const r = await c.query(
                    `INSERT INTO erp_products (company_id, sku, name, category, unit, is_service, cost_price, sale_price, stock, min_stock, active,
                        ncm, cest, cfop, origem, icms_situacao, icms_aliquota)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,TRUE,$11,$12,$13,$14,$15,$16) RETURNING id`,
                    [ctx.companyId, prod.sku, prod.name, prod.category, prod.unit, prod.is_service, prod.cost_price, prod.sale_price, initial, prod.min_stock, ...fiscalCols(prod.fiscal, true)]
                );
                if (initial > 0) {
                    await c.query(
                        `INSERT INTO erp_stock_moves (company_id, product_id, type, qty, balance_after, reason, user_id)
                         VALUES ($1,$2,'entrada',$3,$3,'Estoque inicial',$4)`,
                        [ctx.companyId, r.rows[0].id, initial, ctx.userId]
                    );
                }
            });
            return `${isService ? 'Serviço' : 'Produto'} "${prod.name}" cadastrado (venda ${brl(prod.sale_price)}${isService ? '' : ', estoque inicial ' + qtyTxt(initial) + ' ' + prod.unit}).`;
        },

        async erpMovimentarEstoque(ctx, p) {
            aiAllow(ctx);
            const tipoRaw = normTxt(p.tipo);
            const type = ['entrada', 'saida', 'ajuste'].includes(tipoRaw) ? tipoRaw : null;
            if (!type) throw new ErpError(400, 'Diga se é entrada, saída ou ajuste de estoque.');
            if (p.quantidade === undefined || String(p.quantidade).trim() === '') throw new ErpError(400, 'Informe a quantidade.');
            const qty = toNum(numBR(p.quantidade), { min: type === 'ajuste' ? 0 : 0.001, label: 'quantidade' });
            const prod = pickOne(await findProducts(ctx.companyId, p.produto), p.produto, 'produto', (x) => x.name);
            const reason = toStr(p.motivo, 255, { label: 'motivo' }) || (type === 'entrada' ? 'Entrada via Cláudia' : type === 'saida' ? 'Saída via Cláudia' : 'Ajuste de inventário via Cláudia');
            let balance;
            await withTx(async (c) => {
                const cur = await c.query('SELECT stock, is_service FROM erp_products WHERE id=$1 AND company_id=$2 FOR UPDATE', [prod.id, ctx.companyId]);
                if (!cur.rows.length) throw new ErpError(404, 'Produto não encontrado.');
                if (cur.rows[0].is_service) throw new ErpError(400, 'Serviços não possuem estoque.');
                const delta = type === 'ajuste' ? qty - Number(cur.rows[0].stock) : type === 'entrada' ? qty : -qty;
                const row = await applyMove(c, ctx.companyId, prod.id, type, delta, reason, null, ctx.userId);
                balance = row ? Number(row.stock) : Number(cur.rows[0].stock);
            });
            const verbo = type === 'entrada' ? `Entrada de ${qtyTxt(qty)}` : type === 'saida' ? `Saída de ${qtyTxt(qty)}` : `Ajuste para ${qtyTxt(qty)}`;
            return `${verbo} ${prod.unit} em "${prod.name}". Saldo atual: ${qtyTxt(balance)} ${prod.unit}.`;
        },

        async erpConsultarEstoque(ctx, p) {
            aiAllow(ctx);
            const term = String(p.busca || '').trim();
            if (term && normTxt(term) !== 'baixo') {
                const found = (await findProducts(ctx.companyId, term)).filter((x) => !x.is_service);
                if (!found.length) return `Não encontrei produto com "${term}" no ERP.`;
                const lines = found.slice(0, 8).map((x) => `• ${x.name}${x.sku ? ' [' + x.sku + ']' : ''}: ${qtyTxt(x.stock)} ${x.unit}${x.min_stock > 0 && x.stock <= x.min_stock ? ' ⚠️ abaixo do mínimo' : ''}`);
                return `Estoque:\n${lines.join('\n')}${found.length > 8 ? '\n…e mais ' + (found.length - 8) + '.' : ''}`;
            }
            const r = await pool.query(
                `SELECT name, unit, stock, min_stock FROM erp_products
                 WHERE company_id=$1 AND is_service = FALSE AND active AND min_stock > 0 AND stock <= min_stock
                 ORDER BY (stock - min_stock) ASC LIMIT 10`, [ctx.companyId]);
            if (!r.rows.length) return 'Nenhum produto está abaixo do estoque mínimo. 👍';
            return `Produtos abaixo do estoque mínimo:\n${r.rows.map((x) => `• ${x.name}: ${qtyTxt(x.stock)} ${x.unit} (mínimo ${qtyTxt(x.min_stock)})`).join('\n')}`;
        },

        async erpLancarConta(ctx, p) {
            aiAllow(ctx, { finance: true });
            const tipoRaw = normTxt(p.tipo);
            if (!['pagar', 'receber'].includes(tipoRaw)) throw new ErpError(400, 'Diga se é uma conta a pagar ou a receber.');
            let partyId = null;
            let partyName = '';
            if (String(p.parceiro || '').trim()) {
                const party = pickOne(await findParties(ctx.companyId, p.parceiro), p.parceiro, 'cadastro (cliente/fornecedor)', (x) => x.name);
                partyId = party.id;
                partyName = party.name;
            }
            const t = txIn({
                type: tipoRaw, description: p.descricao, amount: numBR(p.valor),
                due_date: String(p.vencimento || '').trim() || todayStr(),
                category: p.categoria, party_id: partyId, method: p.forma
            });
            const parts = splitInstallments(t.amount, parseInt(p.parcelas, 10) || 1, t.due);
            const paidNow = yes(p.pago);
            await withTx(async (c) => {
                for (const part of parts) {
                    const desc = parts.length > 1 ? `${t.description} (${part.no}/${part.of})` : t.description;
                    await c.query(
                        `INSERT INTO erp_transactions (company_id, type, description, amount, due_date, status, paid_at, paid_amount,
                            category, party_id, installment_no, installments_total, method, notes)
                         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
                        [ctx.companyId, t.type, desc.slice(0, 255), part.amount, part.due, paidNow ? 'pago' : 'aberto',
                            paidNow ? new Date() : null, paidNow ? part.amount : null, t.category, t.party_id, part.no, part.of, t.method, t.notes]
                    );
                }
            });
            const quem = partyName ? ` (${partyName})` : '';
            if (parts.length > 1) return `Conta a ${t.type}${quem} lançada: ${t.description}, ${parts.length}x de ${brl(parts[0].amount)}, primeira em ${brDate(parts[0].due)}.`;
            return `Conta a ${t.type}${quem} lançada: ${t.description}, ${brl(t.amount)}, vencimento ${brDate(t.due)}${paidNow ? ' (já baixada)' : ''}.`;
        },

        async erpBaixarConta(ctx, p) {
            aiAllow(ctx, { finance: true });
            const q = normTxt(p.busca);
            if (!q) throw new ErpError(400, 'Diga qual conta quer baixar (parte da descrição).');
            const r = await pool.query(
                `SELECT t.*, pa.name AS party_name FROM erp_transactions t LEFT JOIN erp_parties pa ON pa.id = t.party_id
                 WHERE t.company_id=$1 AND t.status='aberto' ORDER BY t.due_date ASC LIMIT 1000`, [ctx.companyId]);
            let list = r.rows.map(txOut).filter((t) => normTxt(t.description).includes(q) || normTxt(t.party_name).includes(q));
            const due = String(p.vencimento || '').trim();
            if (isDate(due)) list = list.filter((t) => t.due_date === due);
            const t = pickOne(list, p.busca, 'lançamento em aberto', (x) => `${x.description} ${brDate(x.due_date)} ${brl(x.amount)}`);
            const paidAmount = p.valorPago === undefined || String(p.valorPago).trim() === '' ? null : round2(toNum(numBR(p.valorPago), { min: 0.01, label: 'valor pago' }));
            let paidAt = new Date();
            if (String(p.dataPagamento || '').trim()) {
                if (!isDate(String(p.dataPagamento).trim())) throw new ErpError(400, 'A data do pagamento é inválida.');
                paidAt = new Date(`${String(p.dataPagamento).trim()}T12:00:00Z`);
            }
            const up = await pool.query(
                `UPDATE erp_transactions SET status='pago', paid_at=$1, paid_amount=COALESCE($2, amount), method=COALESCE(NULLIF($3,''), method)
                 WHERE id=$4 AND company_id=$5 AND status='aberto' RETURNING *`,
                [paidAt, paidAmount, toStr(p.forma, 30), t.id, ctx.companyId]);
            if (!up.rows.length) throw new ErpError(409, 'Lançamento não encontrado ou já baixado.');
            return `${t.type === 'pagar' ? 'Pagamento' : 'Recebimento'} registrado: ${t.description} (${brl(paidAmount === null ? t.amount : paidAmount)}).`;
        },

        async erpListarContas(ctx, p) {
            aiAllow(ctx, { finance: true });
            const params = [ctx.companyId];
            let where = 't.company_id = $1';
            const tipo = normTxt(p.tipo);
            if (['pagar', 'receber'].includes(tipo)) { params.push(tipo); where += ` AND t.type = $${params.length}`; }
            const sit = normTxt(p.situacao);
            if (sit === 'vencido' || sit === 'vencidas' || sit === 'vencida') where += " AND t.status = 'aberto' AND t.due_date < CURRENT_DATE";
            else if (['pago', 'cancelado'].includes(sit)) { params.push(sit); where += ` AND t.status = $${params.length}`; }
            else { where += " AND t.status = 'aberto'"; }
            if (isDate(String(p.de || ''))) { params.push(p.de); where += ` AND t.due_date >= $${params.length}`; }
            if (isDate(String(p.ate || ''))) { params.push(p.ate); where += ` AND t.due_date <= $${params.length}`; }
            const r = await pool.query(
                `SELECT t.*, pa.name AS party_name FROM erp_transactions t LEFT JOIN erp_parties pa ON pa.id = t.party_id
                 WHERE ${where} ORDER BY t.due_date ASC, t.id ASC LIMIT 200`, params);
            if (!r.rows.length) return 'Não há lançamentos com esse filtro.';
            const list = r.rows.map(txOut);
            const total = list.reduce((s, t) => s + t.amount, 0);
            const lines = list.slice(0, 10).map((t) => `• ${brDate(t.due_date)} · ${t.type === 'pagar' ? 'Pagar' : 'Receber'} · ${t.description}${t.party_name ? ' (' + t.party_name + ')' : ''} · ${brl(t.amount)}${t.overdue ? ' ⚠️ vencida' : ''}`);
            return `${list.length} lançamento(s), total ${brl(total)}:\n${lines.join('\n')}${list.length > 10 ? '\n…e mais ' + (list.length - 10) + '. Veja todos na aba ERP.' : ''}`;
        },

        async erpResumoFinanceiro(ctx) {
            aiAllow(ctx, { finance: true });
            const r = await pool.query(
                `SELECT type,
                        COALESCE(SUM(amount) FILTER (WHERE status='aberto'), 0) AS aberto,
                        COALESCE(SUM(amount) FILTER (WHERE status='aberto' AND due_date < CURRENT_DATE), 0) AS vencido,
                        COALESCE(SUM(COALESCE(paid_amount, amount)) FILTER (WHERE status='pago' AND paid_at >= date_trunc('month', CURRENT_DATE)), 0) AS pago_mes
                 FROM erp_transactions WHERE company_id=$1 GROUP BY type`, [ctx.companyId]);
            const by = (t) => r.rows.find((x) => x.type === t) || { aberto: 0, vencido: 0, pago_mes: 0 };
            const rec = by('receber');
            const pag = by('pagar');
            const saldo = Number(rec.aberto) - Number(pag.aberto);
            return [
                'Resumo financeiro:',
                `• A receber em aberto: ${brl(rec.aberto)} (vencido: ${brl(rec.vencido)})`,
                `• A pagar em aberto: ${brl(pag.aberto)} (vencido: ${brl(pag.vencido)})`,
                `• Recebido neste mês: ${brl(rec.pago_mes)} · Pago neste mês: ${brl(pag.pago_mes)}`,
                `• Saldo previsto (a receber − a pagar): ${brl(saldo)}`
            ].join('\n');
        }
    };

    // ----- Notas fiscais (Pro AI + administradores) -----
    aiActions.erpEmitirNota = async function (ctx, p) {
        aiAllow(ctx, { finance: true, fiscal: true });
        let orderId = null;
        let partyId = null;
        if (String(p.pedido || '').trim()) {
            const n = parseInt(String(p.pedido).replace(/\D/g, ''), 10);
            if (!(n > 0)) throw new ErpError(400, 'Informe o número do pedido de venda.');
            const o = await pool.query(`SELECT id FROM erp_orders WHERE company_id=$1 AND type='venda' AND number=$2`, [ctx.companyId, n]);
            if (!o.rows.length) throw new ErpError(404, `Não encontrei o pedido de venda número ${n}.`);
            orderId = o.rows[0].id;
        } else if (String(p.cliente || '').trim()) {
            partyId = pickOne(await findParties(ctx.companyId, p.cliente), p.cliente, 'cliente', (x) => x.name).id;
        } else {
            throw new ErpError(400, 'Diga o número do pedido de venda ou o nome do cliente para emitir a nota.');
        }
        const doc = await emitNfse(ctx.companyId, ctx.userId, {
            orderId, partyId, descricao: p.descricao, valor: numBR(p.valor), tomador: { documento: p.documento }
        });
        const aviso = doc.ambiente === 'homologacao' ? ' Ambiente de HOMOLOGAÇÃO: essa nota é só um teste e não tem validade fiscal.' : '';
        return `Nota de serviço de ${brl(doc.amount)} enviada à Focus NFe (referência ${doc.ref}). Ela é processada em instantes: peça "consultar a nota" para ver o resultado.${aviso}`;
    };

    aiActions.erpEmitirNfe = async function (ctx, p) {
        aiAllow(ctx, { finance: true, fiscal: true });
        const n = parseInt(String(p.pedido || '').replace(/\D/g, ''), 10);
        if (!(n > 0)) throw new ErpError(400, 'Diga o número do pedido de venda para emitir a NF-e (nota de produto).');
        const o = await pool.query(`SELECT id FROM erp_orders WHERE company_id=$1 AND type='venda' AND number=$2`, [ctx.companyId, n]);
        if (!o.rows.length) throw new ErpError(404, `Não encontrei o pedido de venda número ${n}.`);
        const doc = await emitNfe(ctx.companyId, ctx.userId, { orderId: o.rows[0].id });
        const aviso = doc.ambiente === 'homologacao' ? ' Ambiente de HOMOLOGAÇÃO: essa nota é só um teste e não tem validade fiscal.' : '';
        return `NF-e de ${brl(doc.amount)} enviada à Focus NFe (referência ${doc.ref}). Ela é processada em instantes: peça "consultar a nota" para ver o resultado.${aviso}`;
    };

    aiActions.erpConsultarNota = async function (ctx, p) {
        aiAllow(ctx, { finance: true, fiscal: true });
        let docs;
        if (String(p.pedido || '').trim()) {
            const n = parseInt(String(p.pedido).replace(/\D/g, ''), 10);
            const r = await pool.query(
                `SELECT f.* FROM erp_fiscal_docs f JOIN erp_orders o ON o.id = f.order_id
                 WHERE f.company_id=$1 AND o.number=$2 AND o.type='venda' ORDER BY f.id DESC LIMIT 2`, [ctx.companyId, n]);
            docs = r.rows;
        } else {
            const r = await pool.query('SELECT * FROM erp_fiscal_docs WHERE company_id=$1 ORDER BY id DESC LIMIT 1', [ctx.companyId]);
            docs = r.rows;
        }
        if (!docs.length) return 'Não encontrei nenhuma nota fiscal emitida por aqui.';
        const linhas = [];
        for (const doc of docs) {
            const fresh = await refreshNfse(ctx.companyId, doc.id);
            const status = {
                processando_autorizacao: 'ainda em processamento', autorizado: 'AUTORIZADA ✅', erro_autorizacao: 'RECUSADA ❌',
                erro_envio: 'não foi enviada (erro de envio)', cancelando: 'com cancelamento em andamento', cancelado: 'CANCELADA',
                enviando: 'sendo enviada', denegado: 'DENEGADA ❌'
            }[fresh.status] || fresh.status;
            const tipo = fresh.kind === 'nfe' ? 'NF-e' : 'NFS-e';
            const partes = [`${tipo} de ${brl(fresh.amount)}: ${status}.`];
            if (fresh.numero) partes.push(`Número ${fresh.numero}${fresh.codigo_verificacao ? ' (verificação ' + fresh.codigo_verificacao + ')' : ''}.`);
            if (fresh.chave) partes.push(`Chave de acesso: ${fresh.chave}.`);
            if (fresh.url) partes.push(`Link: ${fresh.url}`);
            if (fresh.danfe_url) partes.push(`DANFE: ${fresh.danfe_url}`);
            if (fresh.errors) partes.push(`Motivo: ${fresh.errors}`);
            if (fresh.ambiente === 'homologacao') partes.push('(Ambiente de homologação: sem validade fiscal.)');
            linhas.push(partes.join(' '));
        }
        return linhas.join('\n');
    };

    // Ponto único de entrada para o server.js: confere a ação, o plano e o cargo e executa.
    const ai = {
        isAiFunction: (name) => AI_BASE.includes(name) || AI_FINANCE.includes(name) || AI_FISCAL.includes(name),
        contextFrom: (req) => ({
            companyId: req.user.companyId,
            userId: req.user.id,
            role: req.user.role,
            planOk: hasErpPlan(req),
            fiscalOk: hasFiscalPlan(req)
        }),
        run: (name, ctx, params) => {
            if (!ai.isAiFunction(name)) throw new ErpError(400, `Ação do ERP desconhecida: ${name}.`);
            return aiActions[name](ctx, params || {});
        },
        AI_BASE, AI_FINANCE, AI_FISCAL, ERP_PLAN_MESSAGE, FISCAL_PLAN_MESSAGE
    };

    return { ai };
};

// exporta os helpers para testes
module.exports._helpers = { round2, toNum, toStr, isDate, addMonths, splitInstallments, ErpError };