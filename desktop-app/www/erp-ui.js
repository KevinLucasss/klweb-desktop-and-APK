/* ERP KL Web (tela). Carrega depois do login junto com o resto; só trabalha dentro da aba #tab-erp.
   Usa as rotas /api/erp/* (backend/erp.js). Sem dependências externas. */
(function () {
    'use strict';

    const API = '/api/erp';
    const S = {
        tab: 'dashboard',
        access: { enabled: true, finance: false, fiscal: false, message: null },
        parties: [], products: [], orders: [], tx: [], moves: [], dash: null, docs: [], fiscalCfg: null,
        filters: { orderStatus: '', txStatus: 'aberto', q: '' },
        booted: false
    };

    // ---------- utilidades ----------
    const $ = (sel, root) => (root || document).querySelector(sel);
    const esc = (v) => String(v === undefined || v === null ? '' : v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    const money = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    const qtyFmt = (v) => Number(v || 0).toLocaleString('pt-BR', { maximumFractionDigits: 3 });
    const dateBR = (d) => (d ? String(d).slice(0, 10).split('-').reverse().join('/') : '');
    const today = () => new Date().toISOString().slice(0, 10);
    const num = (v) => { const n = parseFloat(String(v).replace(',', '.')); return Number.isFinite(n) ? n : 0; };
    const token = () => (typeof state !== 'undefined' && state && state.token) || localStorage.getItem('klweb_token');
    const toast = (m, t) => (typeof window.showToast === 'function' ? window.showToast(m, t || 'info') : alert(m));
    const METHODS = ['Dinheiro', 'PIX', 'Cartão de crédito', 'Cartão de débito', 'Boleto', 'Transferência', 'Outro'];

    async function api(path, opts = {}) {
        const res = await fetch(API + path, {
            method: opts.method || 'GET',
            headers: { 'Authorization': 'Bearer ' + token(), ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
            body: opts.body ? JSON.stringify(opts.body) : undefined
        });
        let data = null;
        try { data = await res.json(); } catch (e) { /* sem corpo */ }
        if (!res.ok) throw new Error((data && data.message) || 'Erro ao falar com o servidor.');
        return data;
    }
    const safe = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, 'error'); } };

    // ---------- modal ----------
    let modalEl = null;
    function openModal(title, bodyHtml, footerHtml, wide) {
        closeModal();
        modalEl = document.createElement('div');
        modalEl.className = 'modal-backdrop erp-modal';
        modalEl.style.zIndex = 2500;
        modalEl.innerHTML = `<div class="modal-card" style="max-width:${wide ? 860 : 520}px;max-height:92vh;display:flex;flex-direction:column">
            <div class="modal-header"><h3>${title}</h3><button class="btn-modal-close" data-erp="close-modal" type="button">&times;</button></div>
            <div class="modal-body" style="overflow:auto">${bodyHtml}</div>
            ${footerHtml ? `<div class="modal-footer">${footerHtml}</div>` : ''}</div>`;
        document.body.appendChild(modalEl);
        modalEl.addEventListener('mousedown', (e) => { if (e.target === modalEl) closeModal(); });
        return modalEl;
    }
    function closeModal() { if (modalEl) { modalEl.remove(); modalEl = null; } }
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

    // ---------- carga de dados ----------
    const loaders = {
        parties: async () => { S.parties = await api('/parties'); },
        products: async () => { S.products = await api('/products'); },
        orders: async (type) => { S.orders = await api('/orders?type=' + type); },
        tx: async (type) => {
            const q = new URLSearchParams({ type });
            if (S.filters.txStatus) q.set('status', S.filters.txStatus);
            S.tx = await api('/transactions?' + q.toString());
        },
        moves: async () => { S.moves = await api('/stock/moves'); },
        dash: async () => { S.dash = S.access.finance ? await api('/dashboard') : null; },
        docs: async () => { S.docs = await api('/fiscal/docs'); },
        fiscalCfg: async () => { S.fiscalCfg = await api('/fiscal/settings'); }
    };

    // ---------- estrutura ----------
    const TABS = [
        { id: 'dashboard', icon: 'fa-chart-pie', label: 'Painel' },
        { id: 'venda', icon: 'fa-cart-shopping', label: 'Vendas' },
        { id: 'compra', icon: 'fa-truck-ramp-box', label: 'Compras' },
        { id: 'produtos', icon: 'fa-boxes-stacked', label: 'Produtos' },
        { id: 'estoque', icon: 'fa-warehouse', label: 'Estoque' },
        { id: 'cadastros', icon: 'fa-address-card', label: 'Clientes e Fornecedores' },
        { id: 'receber', icon: 'fa-hand-holding-dollar', label: 'Contas a Receber', finance: true },
        { id: 'pagar', icon: 'fa-file-invoice-dollar', label: 'Contas a Pagar', finance: true },
        { id: 'notas', icon: 'fa-file-invoice', label: 'Notas Fiscais', fiscal: true }
    ];
    // Financeiro: administradores. Notas fiscais: administradores no plano Pro AI (o servidor confere de novo).
    const tabAllowed = (t) => (!t.finance || S.access.finance) && (!t.fiscal || S.access.fiscal);

    function shell() {
        const pane = $('#tab-erp');
        if (!pane) return null;
        if (!pane.dataset.erpReady) {
            pane.dataset.erpReady = '1';
            pane.innerHTML = `<div class="pane-header"><div><h2><i class="fa-solid fa-industry"></i> ERP</h2>
                <p>Vendas, compras, estoque e financeiro da sua empresa em um só lugar.</p></div></div>
                <nav class="erp-tabs" id="erp-tabs"></nav><div id="erp-content" class="erp-content"></div>`;
            pane.addEventListener('click', onClick);
            pane.addEventListener('input', onInput);
        }
        $('#erp-tabs').innerHTML = TABS.filter(tabAllowed).map((t) =>
            `<button type="button" class="erp-tab ${S.tab === t.id ? 'active' : ''}" data-erp="tab" data-tab="${t.id}">
                <i class="fa-solid ${t.icon}"></i> ${t.label}</button>`).join('');
        return $('#erp-content');
    }

    const safeRender = safe(async function render() {
        const box = shell();
        if (!box) return;
        // Plano sem ERP: mostra o aviso de upgrade em vez das telas (o servidor também bloqueia as rotas).
        if (S.access.enabled === false) {
            $('#erp-tabs').innerHTML = '';
            box.innerHTML = `<div class="erp-empty"><i class="fa-solid fa-lock"></i><br>${esc(S.access.message || 'O ERP é exclusivo dos planos Starter e Pro AI.')}</div>`;
            return;
        }
        box.innerHTML = '<div class="erp-empty"><i class="fa-solid fa-spinner fa-spin"></i> Carregando…</div>';
        if (!TABS.find((t) => t.id === S.tab && tabAllowed(t))) S.tab = 'dashboard';
        switch (S.tab) {
            case 'dashboard': await Promise.all([loaders.dash(), loaders.products()]); box.innerHTML = viewDashboard(); break;
            case 'venda': case 'compra': await Promise.all([loaders.orders(S.tab), loaders.parties(), loaders.products()]); box.innerHTML = viewOrders(); break;
            case 'produtos': await loaders.products(); box.innerHTML = viewProducts(); break;
            case 'estoque': await Promise.all([loaders.products(), loaders.moves()]); box.innerHTML = viewStock(); break;
            case 'cadastros': await loaders.parties(); box.innerHTML = viewParties(); break;
            case 'receber': case 'pagar': await Promise.all([loaders.tx(S.tab), loaders.parties()]); box.innerHTML = viewTx(); break;
            case 'notas': await Promise.all([loaders.docs(), loaders.fiscalCfg(), loaders.parties()]); box.innerHTML = viewNotas(); break;
        }
    });
    const render = () => safeRender();

    async function boot() {
        if (!token()) return;
        try { S.access = await api('/access'); } catch (e) { S.access = { enabled: true, finance: false, fiscal: false, message: null }; }
        S.booted = true;
        render();
    }

    // ---------- componentes ----------
    const badge = (text, kind) => `<span class="erp-badge erp-${kind}">${esc(text)}</span>`;
    const empty = (msg) => `<div class="erp-empty">${msg}</div>`;
    const card = (label, value, kind, icon) => `<div class="erp-card ${kind || ''}"><i class="fa-solid ${icon}"></i><span>${label}</span><strong>${value}</strong></div>`;
    const toolbar = (left, right) => `<div class="erp-toolbar"><div class="erp-toolbar-left">${left}</div><div>${right || ''}</div></div>`;
    const searchBox = (ph) => `<input class="erp-search" data-erp="search" placeholder="${ph}" value="${esc(S.filters.q)}">`;
    const matches = (obj, keys) => { const q = S.filters.q.trim().toLowerCase(); return !q || keys.some((k) => String(obj[k] || '').toLowerCase().includes(q)); };

    const orderStatusLabel = (o) => ({
        rascunho: o.type === 'venda' ? 'Orçamento' : 'Rascunho',
        confirmado: o.type === 'venda' ? 'Confirmada' : 'Recebida',
        cancelado: 'Cancelada'
    }[o.status]);
    const orderStatusKind = (s) => ({ rascunho: 'warn', confirmado: 'ok', cancelado: 'off' }[s]);

    // ---------- painel ----------
    function viewDashboard() {
        const low = S.products.filter((p) => !p.is_service && p.active && p.min_stock > 0 && p.stock <= p.min_stock);
        if (!S.dash) {
            return `<div class="erp-note"><i class="fa-solid fa-lock"></i> Os números financeiros do painel aparecem apenas para administradores da empresa.</div>
                <h3 class="erp-h3">Estoque baixo</h3>${lowTable(low)}`;
        }
        const d = S.dash;
        const max = Math.max(1, ...d.cashflow.map((m) => Math.max(m.recebido + m.a_receber, m.pago + m.a_pagar)));
        const bars = d.cashflow.map((m) => {
            const h = (v) => Math.round((v / max) * 100);
            return `<div class="erp-bar-col ${m.current ? 'current' : ''}">
                <div class="erp-bars">
                    <div class="erp-bar in" title="Entradas: ${money(m.recebido + m.a_receber)}"><i class="plan" style="height:${h(m.a_receber)}%"></i><i class="real" style="height:${h(m.recebido)}%"></i></div>
                    <div class="erp-bar out" title="Saídas: ${money(m.pago + m.a_pagar)}"><i class="plan" style="height:${h(m.a_pagar)}%"></i><i class="real" style="height:${h(m.pago)}%"></i></div>
                </div><small>${m.month.slice(5)}/${m.month.slice(2, 4)}</small></div>`;
        }).join('');
        return `<div class="erp-cards">
            ${card('Recebido no mês', money(d.recebido_mes), 'good', 'fa-arrow-trend-up')}
            ${card('Pago no mês', money(d.pago_mes), 'bad', 'fa-arrow-trend-down')}
            ${card('Resultado do mês', money(d.resultado_mes), d.resultado_mes >= 0 ? 'good' : 'bad', 'fa-scale-balanced')}
            ${card('Vendas no mês (' + d.vendas_mes_qtd + ')', money(d.vendas_mes), '', 'fa-cart-shopping')}
            ${card('A receber', money(d.a_receber), '', 'fa-hand-holding-dollar')}
            ${card('A pagar', money(d.a_pagar), '', 'fa-file-invoice-dollar')}
            ${card('Recebimentos vencidos (' + d.receber_vencido_qtd + ')', money(d.receber_vencido), d.receber_vencido > 0 ? 'bad' : '', 'fa-triangle-exclamation')}
            ${card('Pagamentos vencidos (' + d.pagar_vencido_qtd + ')', money(d.pagar_vencido), d.pagar_vencido > 0 ? 'bad' : '', 'fa-triangle-exclamation')}
            ${card('Valor em estoque (custo)', money(d.estoque_valor), '', 'fa-warehouse')}
            ${card('Itens com estoque baixo', d.estoque_baixo, d.estoque_baixo > 0 ? 'bad' : '', 'fa-box-open')}
        </div>
        <div class="erp-grid-2">
            <section class="erp-panel"><h3 class="erp-h3">Fluxo de caixa</h3>
                <div class="erp-chart">${bars}</div>
                <div class="erp-legend"><span class="in"></span>Entradas <span class="out"></span>Saídas <em>(cor forte = realizado; clara = previsto)</em></div></section>
            <section class="erp-panel"><h3 class="erp-h3">Vencem em até 7 dias (ou atrasados)</h3>
                ${d.upcoming.length ? `<ul class="erp-list">${d.upcoming.map((t) => `<li><span>${badge(t.type === 'receber' ? 'Receber' : 'Pagar', t.type === 'receber' ? 'ok' : 'bad')}
                    ${esc(t.description)}</span><span class="${t.overdue ? 'erp-red' : ''}">${dateBR(t.due_date)} · ${money(t.amount)}</span></li>`).join('')}</ul>` : empty('Nada vencendo nos próximos dias.')}</section>
            <section class="erp-panel"><h3 class="erp-h3">Estoque baixo</h3>${lowTable(d.low_stock)}</section>
            <section class="erp-panel"><h3 class="erp-h3">Mais vendidos no mês</h3>
                ${d.top_products.length ? `<ul class="erp-list">${d.top_products.map((p) => `<li><span>${esc(p.description)}</span><span>${qtyFmt(p.qty)} un · ${money(p.total)}</span></li>`).join('')}</ul>` : empty('Sem vendas confirmadas neste mês.')}</section>
        </div>`;
    }
    const lowTable = (list) => (list.length
        ? `<ul class="erp-list">${list.map((p) => `<li><span>${esc(p.name)}</span><span class="erp-red">${qtyFmt(p.stock)} / mín. ${qtyFmt(p.min_stock)} ${esc(p.unit || '')}</span></li>`).join('')}</ul>`
        : empty('Nenhum produto abaixo do estoque mínimo.'));

    // ---------- pedidos ----------
    function viewOrders() {
        const isSale = S.tab === 'venda';
        const rows = S.orders.filter((o) => (!S.filters.orderStatus || o.status === S.filters.orderStatus) && matches(o, ['number', 'party_name']));
        const filter = `<select data-erp="order-status"><option value="">Todos os status</option>
            ${['rascunho', 'confirmado', 'cancelado'].map((s) => `<option value="${s}" ${S.filters.orderStatus === s ? 'selected' : ''}>${orderStatusLabel({ type: S.tab, status: s })}</option>`).join('')}</select>`;
        return toolbar(searchBox('Buscar por número ou nome…') + filter,
            `<button class="btn-primary" type="button" data-erp="new-order"><i class="fa-solid fa-plus"></i> ${isSale ? 'Nova venda' : 'Nova compra'}</button>`) +
            (rows.length ? `<div class="erp-table-wrap"><table class="crm-table"><thead><tr><th>Nº</th><th>Data</th><th>${isSale ? 'Cliente' : 'Fornecedor'}</th><th>Total</th><th>Status</th><th></th></tr></thead><tbody>
            ${rows.map((o) => `<tr><td>#${o.number}</td><td>${dateBR(o.created_at)}</td><td>${esc(o.party_name) || '<em>—</em>'}</td><td>${money(o.total)}</td>
                <td>${badge(orderStatusLabel(o), orderStatusKind(o.status))}</td>
                <td class="erp-actions">
                  <button type="button" data-erp="open-order" data-id="${o.id}" title="Abrir"><i class="fa-solid fa-eye"></i></button>
                  ${o.status === 'rascunho' ? `<button type="button" data-erp="confirm-order" data-id="${o.id}" title="${isSale ? 'Confirmar venda' : 'Confirmar recebimento'}"><i class="fa-solid fa-circle-check"></i></button>
                  <button type="button" data-erp="delete-order" data-id="${o.id}" title="Excluir"><i class="fa-solid fa-trash"></i></button>` : ''}
                  ${o.status === 'confirmado' && isSale && S.access.fiscal ? `<button type="button" data-erp="order-nfe" data-id="${o.id}" title="Emitir NF-e (produtos)"><i class="fa-solid fa-file-invoice"></i></button>
                  <button type="button" data-erp="order-nfse" data-id="${o.id}" title="Emitir NFS-e (serviços)"><i class="fa-solid fa-file-lines"></i></button>` : ''}
                  ${o.status === 'confirmado' ? `<button type="button" data-erp="cancel-order" data-id="${o.id}" title="Cancelar"><i class="fa-solid fa-ban"></i></button>` : ''}
                </td></tr>`).join('')}</tbody></table></div>` : empty(`Nenhum pedido ${isSale ? 'de venda' : 'de compra'} ainda.`));
    }

    function itemRow(it) {
        const prods = S.products.filter((p) => p.active || p.id === it.product_id);
        return `<tr class="erp-item">
            <td><select data-erp="item-product"><option value="">Item avulso</option>${prods.map((p) =>
                `<option value="${p.id}" ${Number(it.product_id) === p.id ? 'selected' : ''}>${esc(p.sku ? p.sku + ' · ' : '')}${esc(p.name)}</option>`).join('')}</select></td>
            <td><input class="it-desc" value="${esc(it.description || '')}" placeholder="Descrição"></td>
            <td><input class="it-qty" type="number" step="0.001" min="0.001" value="${it.qty || 1}"></td>
            <td><input class="it-price" type="number" step="0.01" min="0" value="${it.unit_price || 0}"></td>
            <td class="it-total">${money((it.qty || 1) * (it.unit_price || 0))}</td>
            <td><button type="button" class="erp-x" data-erp="remove-item" title="Remover">&times;</button></td></tr>`;
    }

    const openOrder = safe(async function (idOrType) {
        const isNew = typeof idOrType === 'string' && isNaN(Number(idOrType));
        const order = isNew
            ? { type: idOrType, status: 'rascunho', items: [{}], installments: 1, discount: 0, payment_method: '', notes: '', first_due: '' }
            : await api('/orders/' + idOrType);
        await Promise.all([loaders.parties(), loaders.products()]);
        const isSale = order.type === 'venda';
        const editable = order.status === 'rascunho';
        const parties = S.parties.filter((p) => p.active && (p.kind === 'ambos' || p.kind === (isSale ? 'cliente' : 'fornecedor')) || p.id === order.party_id);
        const title = `<i class="fa-solid ${isSale ? 'fa-cart-shopping' : 'fa-truck-ramp-box'}"></i> ${isNew ? (isSale ? 'Nova venda' : 'Nova compra') : (isSale ? 'Venda' : 'Compra') + ' #' + order.number}`;

        if (!editable) {
            const body = `<p>${badge(orderStatusLabel(order), orderStatusKind(order.status))} ${esc(order.party_name || '')}</p>
                <div class="erp-table-wrap"><table class="crm-table"><thead><tr><th>Item</th><th>Qtd</th><th>Preço</th><th>Total</th></tr></thead><tbody>
                ${order.items.map((i) => `<tr><td>${esc(i.description)}</td><td>${qtyFmt(i.qty)}</td><td>${money(i.unit_price)}</td><td>${money(i.total)}</td></tr>`).join('')}</tbody></table></div>
                <p class="erp-total">${order.discount ? `Desconto: ${money(order.discount)} · ` : ''}Total: <strong>${money(order.total)}</strong></p>
                ${order.transactions.length ? `<h4 class="erp-h3">Parcelas</h4><ul class="erp-list">${order.transactions.map((t) =>
                    `<li><span>${t.installment_no}/${t.installments_total} · ${dateBR(t.due_date)}</span><span>${money(t.amount)} ${badge(t.status, t.status === 'pago' ? 'ok' : t.status === 'aberto' ? 'warn' : 'off')}</span></li>`).join('')}</ul>` : ''}
                ${order.notes ? `<p class="erp-muted">${esc(order.notes)}</p>` : ''}`;
            openModal(title, body, '<button class="btn-secondary" type="button" data-erp="close-modal">Fechar</button>', true);
            return;
        }

        const body = `<div class="modal-grid-2">
            <div class="form-group"><label>${isSale ? 'Cliente' : 'Fornecedor'}</label><select id="o-party"><option value="">— Sem cadastro —</option>
                ${parties.map((p) => `<option value="${p.id}" ${order.party_id === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>
            <div class="form-group"><label>Forma de pagamento</label><select id="o-method"><option value="">—</option>
                ${METHODS.map((m) => `<option ${order.payment_method === m ? 'selected' : ''}>${m}</option>`).join('')}</select></div>
            <div class="form-group"><label>Parcelas</label><input id="o-inst" type="number" min="1" max="36" value="${order.installments || 1}"></div>
            <div class="form-group"><label>1º vencimento</label><input id="o-due" type="date" value="${order.first_due || ''}"></div></div>
            <div class="erp-table-wrap"><table class="crm-table erp-items"><thead><tr><th>Produto</th><th>Descrição</th><th>Qtd</th><th>Preço</th><th>Total</th><th></th></tr></thead>
            <tbody id="o-items">${order.items.map(itemRow).join('')}</tbody></table></div>
            <button class="btn-secondary" type="button" data-erp="add-item" style="margin:.6rem 0"><i class="fa-solid fa-plus"></i> Adicionar item</button>
            <div class="modal-grid-2">
              <div class="form-group"><label>Desconto (R$)</label><input id="o-discount" type="number" step="0.01" min="0" value="${order.discount || 0}"></div>
              <div class="form-group"><label>Total</label><div class="erp-total" id="o-total">${money(order.total || 0)}</div></div></div>
            <div class="form-group"><label>Observações</label><textarea id="o-notes" rows="2">${esc(order.notes || '')}</textarea></div>
            ${S.access.finance ? `<label class="erp-check"><input type="checkbox" id="o-paidnow"> ${isSale ? 'Já recebido (à vista)' : 'Já pago (à vista)'} — ao confirmar, as parcelas entram como baixadas</label>` : ''}`;
        const footer = `<button class="btn-secondary" type="button" data-erp="close-modal">Cancelar</button>
            <button class="btn-secondary" type="button" data-erp="save-order" data-confirm="0" data-id="${isNew ? '' : order.id}" data-type="${order.type}">Salvar rascunho</button>
            <button class="btn-primary" type="button" data-erp="save-order" data-confirm="1" data-id="${isNew ? '' : order.id}" data-type="${order.type}"><i class="fa-solid fa-circle-check"></i> ${isSale ? 'Salvar e confirmar venda' : 'Salvar e confirmar recebimento'}</button>`;
        openModal(title, body, footer, true);
        recalcOrder();
    });

    function recalcOrder() {
        if (!modalEl) return;
        let sum = 0;
        modalEl.querySelectorAll('.erp-item').forEach((tr) => {
            const t = num($('.it-qty', tr).value) * num($('.it-price', tr).value);
            $('.it-total', tr).textContent = money(t);
            sum += t;
        });
        const total = Math.max(0, sum - num(($('#o-discount') || {}).value));
        const el = $('#o-total', modalEl);
        if (el) el.textContent = money(total);
    }

    const saveOrder = safe(async function (btn) {
        const id = btn.dataset.id, type = btn.dataset.type, confirmNow = btn.dataset.confirm === '1';
        const items = [...modalEl.querySelectorAll('.erp-item')].map((tr) => ({
            product_id: $('[data-erp="item-product"]', tr).value || null,
            description: $('.it-desc', tr).value.trim(),
            qty: num($('.it-qty', tr).value), unit_price: num($('.it-price', tr).value)
        }));
        const body = {
            type, items, party_id: $('#o-party').value || null, payment_method: $('#o-method').value,
            installments: parseInt($('#o-inst').value, 10) || 1, first_due: $('#o-due').value || null,
            discount: num($('#o-discount').value), notes: $('#o-notes').value
        };
        const saved = id ? await api('/orders/' + id, { method: 'PUT', body }) : await api('/orders', { method: 'POST', body });
        if (confirmNow) {
            const paidNow = !!($('#o-paidnow') && $('#o-paidnow').checked);
            await api(`/orders/${saved.id}/confirm`, { method: 'POST', body: { paid_now: paidNow } });
            toast(type === 'venda' ? 'Venda confirmada. Estoque atualizado e contas a receber geradas.' : 'Compra recebida. Estoque atualizado e contas a pagar geradas.', 'success');
        } else {
            toast('Rascunho salvo.', 'success');
        }
        closeModal();
        render();
    });

    // ---------- produtos ----------
    function viewProducts() {
        const rows = S.products.filter((p) => matches(p, ['name', 'sku', 'category']));
        return toolbar(searchBox('Buscar por nome, SKU ou categoria…'),
            '<button class="btn-primary" type="button" data-erp="new-product"><i class="fa-solid fa-plus"></i> Novo produto/serviço</button>') +
            (rows.length ? `<div class="erp-table-wrap"><table class="crm-table"><thead><tr><th>SKU</th><th>Nome</th><th>Categoria</th><th>Custo</th><th>Venda</th><th>Estoque</th><th></th></tr></thead><tbody>
            ${rows.map((p) => `<tr class="${p.active ? '' : 'erp-inactive'}"><td>${esc(p.sku)}</td><td>${esc(p.name)} ${p.is_service ? badge('Serviço', 'off') : ''}${p.active ? '' : badge('Inativo', 'off')}</td>
                <td>${esc(p.category)}</td><td>${money(p.cost_price)}</td><td>${money(p.sale_price)}</td>
                <td>${p.is_service ? '—' : `<span class="${p.min_stock > 0 && p.stock <= p.min_stock ? 'erp-red' : ''}">${qtyFmt(p.stock)} ${esc(p.unit)}</span>`}</td>
                <td class="erp-actions"><button type="button" data-erp="edit-product" data-id="${p.id}" title="Editar"><i class="fa-solid fa-pen"></i></button>
                <button type="button" data-erp="delete-product" data-id="${p.id}" title="Excluir"><i class="fa-solid fa-trash"></i></button></td></tr>`).join('')}</tbody></table></div>` : empty('Cadastre seus produtos e serviços para usar nas vendas e compras.'));
    }

    function productForm(p) {
        const isNew = !p;
        p = p || { unit: 'un', cost_price: 0, sale_price: 0, min_stock: 0, stock: 0, is_service: false, active: true };
        const body = `<div class="modal-grid-2">
            <div class="form-group"><label>Nome *</label><input id="p-name" value="${esc(p.name || '')}"></div>
            <div class="form-group"><label>SKU / código</label><input id="p-sku" value="${esc(p.sku || '')}"></div>
            <div class="form-group"><label>Categoria</label><input id="p-cat" value="${esc(p.category || '')}"></div>
            <div class="form-group"><label>Unidade</label><input id="p-unit" value="${esc(p.unit || 'un')}" maxlength="12"></div>
            <div class="form-group"><label>Preço de custo (R$)</label><input id="p-cost" type="number" step="0.01" min="0" value="${p.cost_price}"></div>
            <div class="form-group"><label>Preço de venda (R$)</label><input id="p-sale" type="number" step="0.01" min="0" value="${p.sale_price}"></div>
            <div class="form-group"><label>Estoque mínimo</label><input id="p-min" type="number" step="0.001" min="0" value="${p.min_stock}"></div>
            ${isNew ? `<div class="form-group"><label>Estoque inicial</label><input id="p-stock" type="number" step="0.001" min="0" value="0"></div>` : '<div></div>'}</div>
            <details class="erp-details" ${p.ncm || p.cfop ? 'open' : ''}><summary>Dados fiscais (necessários para emitir NF-e)</summary>
              <div class="modal-grid-2">
                <div class="form-group"><label>NCM</label><input id="p-ncm" inputmode="numeric" maxlength="10" placeholder="8 dígitos" value="${esc(p.ncm || '')}"></div>
                <div class="form-group"><label>CEST</label><input id="p-cest" inputmode="numeric" maxlength="9" placeholder="7 dígitos, se houver" value="${esc(p.cest || '')}"></div>
                <div class="form-group"><label>CFOP</label><input id="p-cfop" inputmode="numeric" maxlength="4" placeholder="5102 (mesma UF) ou 6102 (outra UF)" value="${esc(p.cfop || '')}"></div>
                <div class="form-group"><label>Origem da mercadoria</label><select id="p-origem">${[['0', '0 – Nacional'], ['1', '1 – Estrangeira (importação direta)'], ['2', '2 – Estrangeira (mercado interno)'], ['3', '3 – Nacional, importação 40% a 70%'], ['4', '4 – Nacional, processos produtivos básicos'], ['5', '5 – Nacional, importação até 40%'], ['6', '6 – Estrangeira, sem similar (direta)'], ['7', '7 – Estrangeira, sem similar (interna)'], ['8', '8 – Nacional, importação acima de 70%']].map((o) => `<option value="${o[0]}" ${String(p.origem === undefined || p.origem === '' ? '0' : p.origem) === o[0] ? 'selected' : ''}>${o[1]}</option>`).join('')}</select></div>
                <div class="form-group"><label>Situação tributária do ICMS</label><input id="p-icms" inputmode="numeric" maxlength="3" placeholder="Simples: 102 · Normal: 00" value="${esc(p.icms_situacao || '')}"></div>
                <div class="form-group"><label>Alíquota de ICMS (%)</label><input id="p-icms-aliq" type="number" step="0.01" min="0" max="100" value="${p.icms_aliquota || 0}"></div></div></details>
            <label class="erp-check"><input type="checkbox" id="p-service" ${p.is_service ? 'checked' : ''}> É um serviço (não controla estoque)</label>
            <label class="erp-check"><input type="checkbox" id="p-active" ${p.active ? 'checked' : ''}> Ativo</label>
            ${isNew ? '' : '<p class="erp-muted">O saldo de estoque só muda por movimentações (aba Estoque) ou por pedidos.</p>'}`;
        openModal(isNew ? 'Novo produto/serviço' : 'Editar produto', body,
            `<button class="btn-secondary" type="button" data-erp="close-modal">Cancelar</button>
             <button class="btn-primary" type="button" data-erp="save-product" data-id="${isNew ? '' : p.id}">Salvar</button>`);
    }

    const saveProduct = safe(async function (btn) {
        const body = {
            name: $('#p-name').value, sku: $('#p-sku').value, category: $('#p-cat').value, unit: $('#p-unit').value,
            cost_price: $('#p-cost').value, sale_price: $('#p-sale').value, min_stock: $('#p-min').value,
            is_service: $('#p-service').checked, active: $('#p-active').checked,
            ncm: $('#p-ncm').value, cest: $('#p-cest').value, cfop: $('#p-cfop').value, origem: $('#p-origem').value,
            icms_situacao: $('#p-icms').value, icms_aliquota: $('#p-icms-aliq').value
        };
        if ($('#p-stock')) body.stock = $('#p-stock').value;
        const id = btn.dataset.id;
        await api(id ? '/products/' + id : '/products', { method: id ? 'PUT' : 'POST', body });
        toast('Produto salvo.', 'success');
        closeModal(); render();
    });

    // ---------- estoque ----------
    function viewStock() {
        const prods = S.products.filter((p) => !p.is_service && matches(p, ['name', 'sku']));
        const typeLabel = { entrada: ['Entrada', 'ok'], saida: ['Saída', 'bad'], ajuste: ['Ajuste', 'warn'] };
        return toolbar(searchBox('Buscar produto…'), '') + (prods.length
            ? `<div class="erp-table-wrap"><table class="crm-table"><thead><tr><th>Produto</th><th>Saldo</th><th>Mínimo</th><th>Situação</th><th>Movimentar</th></tr></thead><tbody>
            ${prods.map((p) => { const low = p.min_stock > 0 && p.stock <= p.min_stock; return `<tr><td>${esc(p.name)}</td><td>${qtyFmt(p.stock)} ${esc(p.unit)}</td><td>${qtyFmt(p.min_stock)}</td>
                <td>${p.stock <= 0 ? badge('Sem estoque', 'bad') : low ? badge('Baixo', 'warn') : badge('OK', 'ok')}</td>
                <td class="erp-actions"><button type="button" data-erp="move" data-kind="entrada" data-id="${p.id}"><i class="fa-solid fa-plus"></i> Entrada</button>
                <button type="button" data-erp="move" data-kind="saida" data-id="${p.id}"><i class="fa-solid fa-minus"></i> Saída</button>
                <button type="button" data-erp="move" data-kind="ajuste" data-id="${p.id}"><i class="fa-solid fa-sliders"></i> Ajuste</button></td></tr>`; }).join('')}</tbody></table></div>`
            : empty('Nenhum produto com controle de estoque.')) +
            `<h3 class="erp-h3" style="margin-top:1.5rem">Histórico de movimentações</h3>` +
            (S.moves.length ? `<div class="erp-table-wrap"><table class="crm-table"><thead><tr><th>Data</th><th>Produto</th><th>Tipo</th><th>Qtd</th><th>Saldo</th><th>Motivo</th></tr></thead><tbody>
            ${S.moves.map((m) => `<tr><td>${dateBR(m.created_at)}</td><td>${esc(m.product_name)}</td><td>${badge(typeLabel[m.type][0], typeLabel[m.type][1])}</td>
                <td class="${m.qty < 0 ? 'erp-red' : ''}">${m.qty > 0 ? '+' : ''}${qtyFmt(m.qty)}</td><td>${qtyFmt(m.balance_after)} ${esc(m.unit)}</td><td>${esc(m.reason)}</td></tr>`).join('')}</tbody></table></div>` : empty('Sem movimentações ainda.'));
    }

    function moveForm(id, kind) {
        const p = S.products.find((x) => x.id === Number(id));
        if (!p) return;
        const names = { entrada: 'Entrada de estoque', saida: 'Saída de estoque', ajuste: 'Ajuste de inventário' };
        openModal(`${names[kind]} — ${esc(p.name)}`,
            `<p class="erp-muted">Saldo atual: <strong>${qtyFmt(p.stock)} ${esc(p.unit)}</strong></p>
             <div class="form-group"><label>${kind === 'ajuste' ? 'Quantidade contada (novo saldo)' : 'Quantidade'}</label><input id="m-qty" type="number" step="0.001" min="0" autofocus></div>
             <div class="form-group"><label>Motivo</label><input id="m-reason" maxlength="255" placeholder="${kind === 'ajuste' ? 'Ex.: inventário de outubro' : kind === 'entrada' ? 'Ex.: devolução de cliente' : 'Ex.: perda / avaria'}"></div>`,
            `<button class="btn-secondary" type="button" data-erp="close-modal">Cancelar</button>
             <button class="btn-primary" type="button" data-erp="save-move" data-id="${p.id}" data-kind="${kind}">Confirmar</button>`);
    }

    const saveMove = safe(async function (btn) {
        await api(`/products/${btn.dataset.id}/move`, { method: 'POST', body: { type: btn.dataset.kind, qty: $('#m-qty').value, reason: $('#m-reason').value } });
        toast('Estoque atualizado.', 'success');
        closeModal(); render();
    });

    // ---------- clientes e fornecedores ----------
    function viewParties() {
        const rows = S.parties.filter((p) => matches(p, ['name', 'doc', 'email', 'phone']));
        const kindLabel = { cliente: 'Cliente', fornecedor: 'Fornecedor', ambos: 'Cliente e fornecedor' };
        return toolbar(searchBox('Buscar por nome, documento, e-mail…'),
            '<button class="btn-primary" type="button" data-erp="new-party"><i class="fa-solid fa-plus"></i> Novo cadastro</button>') +
            (rows.length ? `<div class="erp-table-wrap"><table class="crm-table"><thead><tr><th>Nome</th><th>Tipo</th><th>CPF/CNPJ</th><th>Telefone</th><th>E-mail</th><th>Cidade</th><th></th></tr></thead><tbody>
            ${rows.map((p) => `<tr class="${p.active ? '' : 'erp-inactive'}"><td>${esc(p.name)} ${p.active ? '' : badge('Inativo', 'off')}</td><td>${kindLabel[p.kind]}</td><td>${esc(p.doc)}</td><td>${esc(p.phone)}</td><td>${esc(p.email)}</td><td>${esc((p.endereco && p.endereco.cidade) || '')}${p.endereco && p.endereco.uf ? '/' + esc(p.endereco.uf) : ''}</td>
                <td class="erp-actions"><button type="button" data-erp="edit-party" data-id="${p.id}"><i class="fa-solid fa-pen"></i></button>
                <button type="button" data-erp="delete-party" data-id="${p.id}"><i class="fa-solid fa-trash"></i></button></td></tr>`).join('')}</tbody></table></div>` : empty('Cadastre clientes e fornecedores para usar em vendas, compras e no financeiro.'));
    }

    function partyForm(p) {
        const isNew = !p;
        p = p || { kind: 'cliente', active: true };
        const e = p.endereco || {};
        openModal(isNew ? 'Novo cadastro' : 'Editar cadastro',
            `<div class="modal-grid-2">
              <div class="form-group"><label>Nome / Razão social *</label><input id="c-name" value="${esc(p.name || '')}"></div>
              <div class="form-group"><label>Tipo</label><select id="c-kind">${[['cliente', 'Cliente'], ['fornecedor', 'Fornecedor'], ['ambos', 'Cliente e fornecedor']].map((k) => `<option value="${k[0]}" ${p.kind === k[0] ? 'selected' : ''}>${k[1]}</option>`).join('')}</select></div>
              <div class="form-group"><label>CPF / CNPJ</label><input id="c-doc" value="${esc(p.doc || '')}"></div>
              <div class="form-group"><label>Telefone</label><input id="c-phone" value="${esc(p.phone || '')}"></div>
              <div class="form-group"><label>E-mail</label><input id="c-email" type="email" value="${esc(p.email || '')}"></div>
              <div class="form-group"><label>Endereço (texto livre)</label><input id="c-addr" value="${esc(p.address || '')}"></div></div>
             <details class="erp-details" ${(p.endereco && (p.endereco.cep || p.endereco.logradouro)) ? 'open' : ''}><summary>Endereço completo (necessário para emitir nota fiscal)</summary>
              <div class="form-group"><label>CEP</label><div class="erp-cep-row"><input id="c-cep" inputmode="numeric" maxlength="9" placeholder="00000-000" value="${esc(e.cep || '')}">
                <button class="btn-secondary" type="button" data-erp="cep-lookup"><i class="fa-solid fa-magnifying-glass"></i> Buscar</button></div></div>
              <div class="modal-grid-2">
                <div class="form-group"><label>Rua</label><input id="c-log" maxlength="150" value="${esc(e.logradouro || '')}"></div>
                <div class="form-group"><label>Número</label><input id="c-num" maxlength="20" value="${esc(e.numero || '')}"></div>
                <div class="form-group"><label>Complemento</label><input id="c-comp" maxlength="80" value="${esc(e.complemento || '')}"></div>
                <div class="form-group"><label>Bairro</label><input id="c-bairro" maxlength="80" value="${esc(e.bairro || '')}"></div>
                <div class="form-group"><label>Cidade</label><input id="c-cidade" maxlength="80" value="${esc(e.cidade || '')}"></div>
                <div class="form-group"><label>UF</label><input id="c-uf" maxlength="2" value="${esc(e.uf || '')}"></div>
                <div class="form-group"><label>Código IBGE do município</label><input id="c-ibge" inputmode="numeric" maxlength="7" value="${esc(e.codigo_municipio || '')}"></div></div></details>
             <div class="form-group"><label>Observações</label><textarea id="c-notes" rows="2">${esc(p.notes || '')}</textarea></div>
             <label class="erp-check"><input type="checkbox" id="c-active" ${p.active ? 'checked' : ''}> Ativo</label>`,
            `<button class="btn-secondary" type="button" data-erp="close-modal">Cancelar</button>
             <button class="btn-primary" type="button" data-erp="save-party" data-id="${isNew ? '' : p.id}">Salvar</button>`, true);
    }

    const saveParty = safe(async function (btn) {
        const body = { name: $('#c-name').value, kind: $('#c-kind').value, doc: $('#c-doc').value, phone: $('#c-phone').value,
            email: $('#c-email').value, address: $('#c-addr').value, notes: $('#c-notes').value, active: $('#c-active').checked,
            endereco: { cep: $('#c-cep').value, logradouro: $('#c-log').value, numero: $('#c-num').value, complemento: $('#c-comp').value,
                bairro: $('#c-bairro').value, cidade: $('#c-cidade').value, uf: $('#c-uf').value, codigo_municipio: $('#c-ibge').value } };
        const id = btn.dataset.id;
        await api(id ? '/parties/' + id : '/parties', { method: id ? 'PUT' : 'POST', body });
        toast('Cadastro salvo.', 'success');
        closeModal(); render();
    });

    // ---------- financeiro ----------
    function viewTx() {
        const isIn = S.tab === 'receber';
        const rows = S.tx.filter((t) => matches(t, ['description', 'party_name', 'category']));
        const total = rows.filter((t) => t.status !== 'cancelado').reduce((s, t) => s + t.amount, 0);
        const overdue = rows.filter((t) => t.overdue).reduce((s, t) => s + t.amount, 0);
        const statusSel = `<select data-erp="tx-status">${[['aberto', 'Em aberto'], ['pago', isIn ? 'Recebidos' : 'Pagos'], ['cancelado', 'Cancelados'], ['', 'Todos']]
            .map((s) => `<option value="${s[0]}" ${S.filters.txStatus === s[0] ? 'selected' : ''}>${s[1]}</option>`).join('')}</select>`;
        return toolbar(searchBox('Buscar lançamento…') + statusSel,
            `<button class="btn-primary" type="button" data-erp="new-tx"><i class="fa-solid fa-plus"></i> ${isIn ? 'Nova receita' : 'Nova despesa'}</button>`) +
            `<div class="erp-cards small">${card('Total listado', money(total), '', 'fa-sigma')}${card('Vencido', money(overdue), overdue > 0 ? 'bad' : '', 'fa-triangle-exclamation')}</div>` +
            (rows.length ? `<div class="erp-table-wrap"><table class="crm-table"><thead><tr><th>Vencimento</th><th>Descrição</th><th>${isIn ? 'Cliente' : 'Fornecedor'}</th><th>Categoria</th><th>Valor</th><th>Situação</th><th></th></tr></thead><tbody>
            ${rows.map((t) => `<tr><td class="${t.overdue ? 'erp-red' : ''}">${dateBR(t.due_date)}</td><td>${esc(t.description)}</td><td>${esc(t.party_name)}</td><td>${esc(t.category)}</td><td>${money(t.amount)}</td>
                <td>${t.status === 'pago' ? badge(isIn ? 'Recebido ' + dateBR(t.paid_at) : 'Pago ' + dateBR(t.paid_at), 'ok') : t.status === 'cancelado' ? badge('Cancelado', 'off') : t.overdue ? badge('Vencido', 'bad') : badge('Em aberto', 'warn')}</td>
                <td class="erp-actions">
                  ${t.status === 'aberto' ? `<button type="button" data-erp="pay-tx" data-id="${t.id}" title="${isIn ? 'Receber' : 'Pagar'}"><i class="fa-solid fa-check"></i></button>
                    <button type="button" data-erp="edit-tx" data-id="${t.id}" title="Editar"><i class="fa-solid fa-pen"></i></button>
                    <button type="button" data-erp="cancel-tx" data-id="${t.id}" title="Cancelar"><i class="fa-solid fa-ban"></i></button>` : ''}
                  ${t.status === 'pago' ? `<button type="button" data-erp="reopen-tx" data-id="${t.id}" title="Estornar"><i class="fa-solid fa-rotate-left"></i></button>` : ''}
                  ${!t.order_id && t.status !== 'pago' ? `<button type="button" data-erp="delete-tx" data-id="${t.id}" title="Excluir"><i class="fa-solid fa-trash"></i></button>` : ''}
                </td></tr>`).join('')}</tbody></table></div>` : empty('Nenhum lançamento nesta lista.'));
    }

    function txForm(t) {
        const isNew = !t;
        const isIn = S.tab === 'receber';
        t = t || { due_date: today(), amount: '', description: '', category: '', method: '', notes: '' };
        const parties = S.parties.filter((p) => p.active && (p.kind === 'ambos' || p.kind === (isIn ? 'cliente' : 'fornecedor')) || p.id === t.party_id);
        openModal(isNew ? (isIn ? 'Nova receita' : 'Nova despesa') : 'Editar lançamento',
            `<div class="form-group"><label>Descrição *</label><input id="t-desc" value="${esc(t.description)}"></div>
             <div class="modal-grid-2">
              <div class="form-group"><label>Valor (R$) *</label><input id="t-amount" type="number" step="0.01" min="0.01" value="${t.amount}" ${t.order_id ? 'disabled' : ''}></div>
              <div class="form-group"><label>Vencimento *</label><input id="t-due" type="date" value="${t.due_date}"></div>
              <div class="form-group"><label>${isIn ? 'Cliente' : 'Fornecedor'}</label><select id="t-party"><option value="">—</option>${parties.map((p) => `<option value="${p.id}" ${t.party_id === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>
              <div class="form-group"><label>Categoria</label><input id="t-cat" list="t-cats" value="${esc(t.category)}"><datalist id="t-cats">${(isIn ? ['Vendas', 'Serviços', 'Outras receitas'] : ['Compras', 'Aluguel', 'Salários', 'Impostos', 'Energia/Água/Internet', 'Marketing', 'Outras despesas']).map((c) => `<option value="${c}">`).join('')}</datalist></div>
              <div class="form-group"><label>Forma de pagamento</label><select id="t-method"><option value="">—</option>${METHODS.map((m) => `<option ${t.method === m ? 'selected' : ''}>${m}</option>`).join('')}</select></div>
              ${isNew ? '<div class="form-group"><label>Parcelas (mensais)</label><input id="t-inst" type="number" min="1" max="36" value="1"></div>' : '<div></div>'}</div>
             <div class="form-group"><label>Observações</label><textarea id="t-notes" rows="2">${esc(t.notes)}</textarea></div>
             ${isNew ? `<label class="erp-check"><input type="checkbox" id="t-paid"> ${isIn ? 'Já recebido' : 'Já pago'}</label>` : ''}`,
            `<button class="btn-secondary" type="button" data-erp="close-modal">Cancelar</button>
             <button class="btn-primary" type="button" data-erp="save-tx" data-id="${isNew ? '' : t.id}" data-order="${t.order_id ? '1' : ''}" data-amount="${t.amount}">Salvar</button>`);
    }

    const saveTx = safe(async function (btn) {
        const body = {
            type: S.tab, description: $('#t-desc').value, amount: btn.dataset.order ? btn.dataset.amount : $('#t-amount').value,
            due_date: $('#t-due').value, party_id: $('#t-party').value || null, category: $('#t-cat').value,
            method: $('#t-method').value, notes: $('#t-notes').value
        };
        if ($('#t-inst')) { body.installments = parseInt($('#t-inst').value, 10) || 1; body.paid_now = $('#t-paid').checked; }
        const id = btn.dataset.id;
        await api(id ? '/transactions/' + id : '/transactions', { method: id ? 'PUT' : 'POST', body });
        toast('Lançamento salvo.', 'success');
        closeModal(); render();
    });

    function payForm(id) {
        const t = S.tx.find((x) => x.id === Number(id));
        if (!t) return;
        const isIn = t.type === 'receber';
        openModal(isIn ? 'Registrar recebimento' : 'Registrar pagamento',
            `<p>${esc(t.description)} — <strong>${money(t.amount)}</strong></p>
             <div class="modal-grid-2">
              <div class="form-group"><label>Data</label><input id="pay-date" type="date" value="${today()}"></div>
              <div class="form-group"><label>Valor ${isIn ? 'recebido' : 'pago'} (R$)</label><input id="pay-amount" type="number" step="0.01" min="0.01" value="${t.amount}"></div></div>
             <div class="form-group"><label>Forma de pagamento</label><select id="pay-method"><option value="">—</option>${METHODS.map((m) => `<option ${t.method === m ? 'selected' : ''}>${m}</option>`).join('')}</select></div>`,
            `<button class="btn-secondary" type="button" data-erp="close-modal">Cancelar</button>
             <button class="btn-primary" type="button" data-erp="save-pay" data-id="${t.id}">Confirmar</button>`);
    }

    const savePay = safe(async function (btn) {
        await api(`/transactions/${btn.dataset.id}/pay`, { method: 'POST', body: { paid_date: $('#pay-date').value, paid_amount: $('#pay-amount').value, method: $('#pay-method').value } });
        toast('Baixa registrada.', 'success');
        closeModal(); render();
    });

    // ---------- notas fiscais (Focus NFe) ----------
    const DOC_STATUS = {
        autorizado: ['Autorizada', 'ok'], processando_autorizacao: ['Processando', 'warn'], enviando: ['Enviando', 'warn'],
        cancelando: ['Cancelando', 'warn'], cancelado: ['Cancelada', 'off'], erro_envio: ['Erro de envio', 'bad'], erro_autorizacao: ['Rejeitada', 'bad']
    };

    function viewNotas() {
        const cfg = S.fiscalCfg || {};
        const rows = S.docs.filter((d) => matches(d, ['party_name', 'numero', 'description']));
        const aviso = !cfg.has_token
            ? `<div class="erp-note warn"><i class="fa-solid fa-triangle-exclamation"></i> Falta configurar a emissão: informe o token da Focus NFe e os dados fiscais da empresa em <strong>Configurar emissão</strong>.</div>`
            : cfg.ambiente !== 'producao'
                ? `<div class="erp-note warn"><i class="fa-solid fa-flask"></i> Ambiente de <strong>homologação</strong>: as notas emitidas agora são de teste e não têm validade fiscal.</div>` : '';
        return aviso + toolbar(searchBox('Buscar por cliente, número ou descrição…'),
            `<button class="btn-secondary" type="button" data-erp="fiscal-settings"><i class="fa-solid fa-gear"></i> Configurar emissão</button>
             <button class="btn-primary" type="button" data-erp="new-nfse"><i class="fa-solid fa-plus"></i> Emitir NFS-e avulsa</button>`) +
            `<p class="erp-muted" style="margin:-.25rem 0 1rem">A NF-e (produtos) e a NFS-e (serviços) de uma venda saem na aba Vendas, no pedido confirmado. Aqui você acompanha todas as notas.</p>` +
            (rows.length ? `<div class="erp-table-wrap"><table class="crm-table"><thead><tr><th>Data</th><th>Nota</th><th>Cliente</th><th>Valor</th><th>Situação</th><th></th></tr></thead><tbody>
            ${rows.map((d) => { const st = DOC_STATUS[d.status] || [d.status, 'off']; return `<tr>
                <td>${dateBR(d.created_at)}</td>
                <td><strong>${d.kind === 'nfe' ? 'NF-e' : 'NFS-e'}</strong>${d.numero ? ' nº ' + esc(d.numero) : ''}${d.order_number ? `<br><span class="erp-muted">Venda #${d.order_number}</span>` : ''}${d.ambiente !== 'producao' ? ' ' + badge('Teste', 'off') : ''}</td>
                <td>${esc(d.party_name) || '<em>—</em>'}</td><td>${money(d.amount)}</td>
                <td>${badge(st[0], st[1])}${d.errors ? `<br><span class="erp-red" style="font-size:.78rem">${esc(d.errors)}</span>` : ''}</td>
                <td class="erp-actions">
                  <button type="button" data-erp="doc-print" data-id="${d.id}" title="Imprimir nota"><i class="fa-solid fa-print"></i></button>
                  <button type="button" data-erp="doc-export" data-id="${d.id}" title="Exportar / baixar nota"><i class="fa-solid fa-download"></i></button>
                  ${d.url ? `<a href="${esc(d.url)}" target="_blank" rel="noopener" title="Abrir nota"><i class="fa-solid fa-arrow-up-right-from-square"></i></a>` : ''}
                  ${d.danfe_url ? `<a href="${esc(d.danfe_url)}" target="_blank" rel="noopener" title="DANFE (PDF)"><i class="fa-solid fa-file-pdf"></i></a>` : ''}
                  ${d.xml_url ? `<a href="${esc(d.xml_url)}" target="_blank" rel="noopener" title="XML"><i class="fa-solid fa-file-code"></i></a>` : ''}
                  ${['processando_autorizacao', 'erro_envio', 'enviando', 'cancelando'].includes(d.status) ? `<button type="button" data-erp="doc-refresh" data-id="${d.id}" title="Atualizar situação"><i class="fa-solid fa-rotate"></i></button>` : ''}
                  ${d.status === 'autorizado' ? `<button type="button" data-erp="doc-cancel" data-id="${d.id}" title="Cancelar nota"><i class="fa-solid fa-ban"></i></button>` : ''}
                </td></tr>`; }).join('')}</tbody></table></div>` : empty('Nenhuma nota emitida ainda.'));
    }

    // ---------- imprimir e exportar notas ----------
    // Impressão: usa a janela de impressão do navegador, que lista qualquer impressora instalada no computador ou celular
    // (USB, rede, Wi-Fi, Bluetooth, térmica de cupom). Basta conectar/instalar a impressora no sistema e escolhê-la na janela.
    const docName = (d) => `${d.kind === 'nfe' ? 'NF-e' : 'NFS-e'}${d.numero ? ' ' + d.numero : ''}`;
    const fileBase = (d) => `${d.kind === 'nfe' ? 'NFe' : 'NFSe'}-${String(d.numero || d.id).replace(/[^A-Za-z0-9_-]/g, '')}`;
    const findDoc = (id) => S.docs.find((x) => x.id === Number(id));

    async function fetchDocFile(id, tipo) {
        const res = await fetch(`${API}/fiscal/docs/${id}/file?tipo=${tipo}`, { headers: { 'Authorization': 'Bearer ' + token() } });
        if (!res.ok) {
            let m = 'Não foi possível obter o arquivo da nota.';
            try { m = (await res.json()).message || m; } catch (e) { /* sem corpo */ }
            throw new Error(m);
        }
        return res.blob();
    }
    function saveBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = filename; a.style.display = 'none';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
    }
    // imprime um arquivo (PDF ou HTML) num iframe invisível; se o navegador não deixar, abre numa aba para imprimir de lá
    function printBlob(blob) {
        const url = URL.createObjectURL(blob);
        const f = document.createElement('iframe');
        f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
        let done = false;
        const cleanup = () => { setTimeout(() => { f.remove(); URL.revokeObjectURL(url); }, 60000); };
        f.onload = () => {
            if (done) return; done = true;
            try { f.contentWindow.focus(); f.contentWindow.print(); }
            catch (e) { window.open(url, '_blank', 'noopener'); }
            cleanup();
        };
        f.src = url;
        document.body.appendChild(f);
    }

    // comprovante da nota (A4 ou cupom de 80 mm). Não substitui o DANFE nem a nota oficial.
    function receiptHtml(d, paper) {
        const cupom = paper === 'cupom';
        const row = (k, v) => (v ? `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>` : '');
        const st = (DOC_STATUS[d.status] || [d.status])[0];
        const teste = d.ambiente !== 'producao' ? '<p class="teste">AMBIENTE DE TESTE: sem validade fiscal</p>' : '';
        const css = cupom
            ? '@page{size:80mm auto;margin:3mm}body{width:74mm;font:11px/1.35 "Courier New",monospace}h1{font-size:13px}'
            : '@page{size:A4;margin:15mm}body{font:14px/1.5 system-ui,Arial,sans-serif;max-width:720px;margin:0 auto}h1{font-size:20px}';
        return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${esc(fileBase(d))}</title><style>
            ${css}
            body{color:#000;margin:0;padding:${cupom ? '0' : '8px'}}
            h1{margin:0 0 4px;text-align:${cupom ? 'center' : 'left'}}
            .sub{margin:0 0 10px;text-align:${cupom ? 'center' : 'left'};color:#444}
            table{width:100%;border-collapse:collapse}
            th{text-align:left;vertical-align:top;padding:3px 6px 3px 0;white-space:nowrap;font-weight:600}
            td{padding:3px 0;word-break:break-word}
            .valor td{font-size:${cupom ? '14px' : '18px'};font-weight:700}
            .teste{border:1px dashed #000;padding:4px;text-align:center;font-weight:700;margin:8px 0}
            .aviso{margin-top:14px;font-size:${cupom ? '9px' : '11px'};color:#555;border-top:1px solid #999;padding-top:6px}
        </style></head><body>
        <h1>${esc(docName(d))}</h1><p class="sub">${d.kind === 'nfe' ? 'Nota fiscal de produto' : 'Nota fiscal de serviço'} · ${esc(st)}</p>${teste}
        <table>
            ${row('Cliente', d.party_name)}
            ${row('Venda', d.order_number ? '#' + d.order_number : '')}
            ${row('Descrição', d.description)}
            ${row('Série', d.serie)}
            ${row('Emitida em', d.created_at ? new Date(d.created_at).toLocaleString('pt-BR') : '')}
            ${row('Cód. verificação', d.codigo_verificacao)}
            ${row('Chave de acesso', d.chave)}
            <tr class="valor"><th>Valor total</th><td>${esc(money(d.amount))}</td></tr>
        </table>
        <p class="aviso">Comprovante gerado pela KL Web. Não substitui o DANFE nem a nota fiscal oficial${d.url ? '. Consulte a nota em: ' + esc(d.url) : '.'}</p>
        </body></html>`;
    }
    const receiptBlob = (d, paper) => new Blob([receiptHtml(d, paper)], { type: 'text/html;charset=utf-8' });

    function docPrintForm(id) {
        const d = findDoc(id); if (!d) return;
        openModal('<i class="fa-solid fa-print"></i> Imprimir nota',
            `<p><strong>${esc(docName(d))}</strong> · ${esc(d.party_name || 'sem cliente')} · ${money(d.amount)}</p>
             <label class="erp-check"><input type="radio" name="dp-fmt" value="a4" ${d.danfe_url ? 'checked' : ''}> <span>${d.danfe_url ? 'A4: DANFE oficial em PDF' : 'A4: comprovante da nota'}</span></label>
             <label class="erp-check"><input type="radio" name="dp-fmt" value="cupom" ${d.danfe_url ? '' : 'checked'}> <span>Cupom 80 mm (impressora térmica): comprovante resumido</span></label>
             <p class="erp-muted">Ao continuar, abre a janela de impressão: escolha ali a impressora. Qualquer impressora instalada no seu computador ou celular (USB, rede, Wi-Fi ou Bluetooth) aparece na lista. Para guardar em PDF, escolha “Salvar como PDF”.</p>`,
            `<button class="btn-secondary" type="button" data-erp="close-modal">Fechar</button>
             <button class="btn-primary" type="button" data-erp="doc-print-now" data-id="${d.id}"><i class="fa-solid fa-print"></i> Imprimir</button>`);
    }
    const docPrintNow = safe(async function (el) {
        const d = findDoc(el.dataset.id); if (!d) return;
        const pick = modalEl && modalEl.querySelector('input[name="dp-fmt"]:checked');
        const fmt = pick ? pick.value : 'a4';
        el.disabled = true;
        try {
            toast('Preparando a impressão…', 'info');
            if (fmt === 'a4' && d.danfe_url) printBlob(await fetchDocFile(d.id, 'danfe'));
            else printBlob(receiptBlob(d, fmt));
            closeModal();
        } finally { el.disabled = false; }
    });

    function docExportForm(id) {
        const d = findDoc(id); if (!d) return;
        const btn = (act, icon, label, off) => `<button class="btn-secondary" type="button" style="width:100%;margin-bottom:.5rem;text-align:left" data-erp="${act}" data-id="${d.id}" ${off ? 'disabled title="Ainda não disponível para esta nota"' : ''}><i class="fa-solid ${icon}"></i> ${label}</button>`;
        openModal('<i class="fa-solid fa-download"></i> Exportar nota',
            `<p><strong>${esc(docName(d))}</strong> · ${esc(d.party_name || 'sem cliente')} · ${money(d.amount)}</p>` +
            btn('doc-dl-pdf', 'fa-file-pdf', 'Baixar DANFE (PDF)', !d.danfe_url) +
            btn('doc-dl-xml', 'fa-file-code', 'Baixar XML', !d.xml_url) +
            btn('doc-dl-receipt', 'fa-file-lines', 'Baixar comprovante (A4)', false) +
            `<p class="erp-muted">O XML é o arquivo que o contador usa. Notas de serviço (NFS-e) normalmente não têm DANFE: use “Abrir nota” na lista para ver a da prefeitura.</p>`,
            `<button class="btn-secondary" type="button" data-erp="close-modal">Fechar</button>`);
    }
    const docDownload = (kind) => safe(async function (el) {
        const d = findDoc(el.dataset.id); if (!d) return;
        el.disabled = true;
        try {
            if (kind === 'receipt') saveBlob(receiptBlob(d, 'a4'), `${fileBase(d)}-comprovante.html`);
            else saveBlob(await fetchDocFile(d.id, kind === 'pdf' ? 'danfe' : 'xml'), `${fileBase(d)}.${kind}`);
            toast('Download iniciado.', 'success');
        } finally { el.disabled = false; }
    });

    function fiscalSettingsForm(c) {
        c = c || {};
        const sel = (id, label, opts, val) => `<div class="form-group"><label>${label}</label><select id="${id}">${opts.map((o) => `<option value="${o[0]}" ${String(val) === o[0] ? 'selected' : ''}>${o[1]}</option>`).join('')}</select></div>`;
        const inp = (id, label, val, extra) => `<div class="form-group"><label>${label}</label><input id="${id}" value="${esc(val)}" ${extra || ''}></div>`;
        openModal('<i class="fa-solid fa-gear"></i> Configurar emissão de notas',
            `<div class="form-group"><label>Token da Focus NFe</label><input id="f-token" type="password" autocomplete="off" placeholder="${c.has_token ? 'Já configurado — preencha só para trocar' : 'Cole o token da sua conta Focus NFe'}">
                <p class="erp-muted">Fica guardado criptografado e nunca é exibido de volta.</p></div>
             ${c.has_token ? '<label class="erp-check"><input type="checkbox" id="f-rmtoken"> Remover o token salvo</label>' : ''}
             <div class="modal-grid-2">
               ${sel('f-amb', 'Ambiente', [['homologacao', 'Homologação (teste, sem validade)'], ['producao', 'Produção (valendo)']], c.ambiente || 'homologacao')}
               ${inp('f-cnpj', 'CNPJ da empresa', c.cnpj, 'inputmode="numeric" maxlength="18"')}
               ${inp('f-uf', 'UF da empresa', c.uf, 'maxlength="2"')}
               ${sel('f-regtrib', 'Regime tributário (NF-e)', [['', 'Selecione'], ['1', '1 – Simples Nacional'], ['2', '2 – Simples (excesso de sublimite)'], ['3', '3 – Regime Normal']], c.regime_tributario || '')}
               ${inp('f-ie', 'Inscrição estadual (NF-e)', c.inscricao_estadual)}
               ${sel('f-pis', 'Situação de PIS/COFINS (NF-e)', ['04', '05', '06', '07', '08', '09'].map((v) => [v, v]), c.pis_cofins_situacao || '07')}</div>
             <details class="erp-details" open><summary>Nota de serviço (NFS-e)</summary><div class="modal-grid-2">
               ${inp('f-im', 'Inscrição municipal', c.inscricao_municipal)}
               ${inp('f-mun', 'Código IBGE do município', c.codigo_municipio, 'inputmode="numeric" maxlength="7"')}
               ${inp('f-item', 'Item da lista de serviços', c.item_lista_servico, 'placeholder="Ex.: 14.01"')}
               ${inp('f-ctm', 'Código tributário do município', c.codigo_tributario_municipio)}
               <div class="form-group"><label>Alíquota de ISS (%)</label><input id="f-aliq" type="number" step="0.01" min="0" max="100" value="${c.aliquota || 0}"></div>
               ${sel('f-nat', 'Natureza da operação', [['1', '1 – Tributação no município'], ['2', '2 – Tributação fora do município'], ['3', '3 – Isenção'], ['4', '4 – Imune'], ['5', '5 – Exigibilidade suspensa (judicial)'], ['6', '6 – Exigibilidade suspensa (administrativa)']], c.natureza_operacao || '1')}
               ${inp('f-regesp', 'Regime especial de tributação', c.regime_especial, 'maxlength="2" placeholder="Código, se houver"')}</div>
               <label class="erp-check"><input type="checkbox" id="f-simples" ${c.optante_simples !== false ? 'checked' : ''}> Optante pelo Simples Nacional</label>
               <label class="erp-check"><input type="checkbox" id="f-issret" ${c.iss_retido ? 'checked' : ''}> ISS retido pelo tomador</label></details>`,
            `<button class="btn-secondary" type="button" data-erp="close-modal">Cancelar</button>
             <button class="btn-primary" type="button" data-erp="save-fiscal">Salvar</button>`, true);
    }

    const saveFiscal = safe(async function () {
        const body = {
            ambiente: $('#f-amb').value, cnpj: $('#f-cnpj').value, uf: $('#f-uf').value, regime_tributario: $('#f-regtrib').value,
            inscricao_estadual: $('#f-ie').value, pis_cofins_situacao: $('#f-pis').value,
            inscricao_municipal: $('#f-im').value, codigo_municipio: $('#f-mun').value, item_lista_servico: $('#f-item').value,
            codigo_tributario_municipio: $('#f-ctm').value, aliquota: $('#f-aliq').value, natureza_operacao: $('#f-nat').value,
            regime_especial: $('#f-regesp').value, optante_simples: $('#f-simples').checked, iss_retido: $('#f-issret').checked
        };
        if ($('#f-rmtoken') && $('#f-rmtoken').checked) body.remove_token = true;
        else if ($('#f-token').value.trim()) body.token = $('#f-token').value.trim();
        S.fiscalCfg = await api('/fiscal/settings', { method: 'PUT', body });
        toast('Configuração fiscal salva.', 'success');
        closeModal(); render();
    });

    function nfseForm(orderId) {
        const o = orderId ? S.orders.find((x) => x.id === orderId) : null;
        const parties = S.parties.filter((p) => p.active && (p.kind === 'ambos' || p.kind === 'cliente'));
        openModal(o ? `<i class="fa-solid fa-file-lines"></i> Emitir NFS-e — venda #${o.number}` : '<i class="fa-solid fa-file-lines"></i> Emitir NFS-e avulsa',
            (o ? `<p class="erp-muted">O valor (${money(o.total)}) e o cliente saem do pedido. O cliente precisa ter CPF ou CNPJ válido no cadastro.</p>` : `
             <div class="modal-grid-2">
               <div class="form-group"><label>Cliente</label><select id="n-party"><option value="">— Selecione —</option>${parties.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></div>
               <div class="form-group"><label>Valor do serviço (R$) *</label><input id="n-valor" type="number" step="0.01" min="0.01"></div></div>
             <div class="form-group"><label>CPF/CNPJ do tomador</label><input id="n-doc" inputmode="numeric" placeholder="Só se o cliente não tiver documento no cadastro"></div>`) + `
             <div class="form-group"><label>Descrição do serviço ${o ? '' : '*'}</label><textarea id="n-desc" rows="3" placeholder="${o ? 'Em branco: usa os itens do pedido' : 'Ex.: Manutenção de site — outubro'}"></textarea></div>`,
            `<button class="btn-secondary" type="button" data-erp="close-modal">Cancelar</button>
             <button class="btn-primary" type="button" data-erp="save-nfse" data-order="${o ? o.id : ''}">Emitir nota</button>`);
    }

    const saveNfse = safe(async function (btn) {
        const orderId = btn.dataset.order;
        const body = orderId
            ? { order_id: Number(orderId), descricao: $('#n-desc').value }
            : { party_id: $('#n-party').value || null, valor: $('#n-valor').value, descricao: $('#n-desc').value };
        if (!orderId && $('#n-doc').value.trim()) body.tomador = { documento: $('#n-doc').value };
        await api('/fiscal/nfse', { method: 'POST', body });
        toast('Nota enviada. Acompanhe a situação na aba Notas Fiscais.', 'success');
        closeModal(); if (S.tab === 'notas') render();
    });

    function nfeForm(orderId) {
        const o = S.orders.find((x) => x.id === orderId);
        openModal(`<i class="fa-solid fa-file-invoice"></i> Emitir NF-e — venda #${o ? o.number : orderId}`,
            `<p class="erp-muted">Só os produtos do pedido entram na NF-e (serviços saem pela NFS-e). O cliente precisa ter CPF/CNPJ e endereço completo, e cada produto precisa de NCM, CFOP e ICMS.</p>
             <div class="form-group"><label>Presença do comprador</label><select id="e-pres">
               ${[['1', 'Operação presencial'], ['2', 'Não presencial, internet'], ['3', 'Não presencial, teleatendimento'], ['4', 'Entrega em domicílio'], ['9', 'Outros']].map((x) => `<option value="${x[0]}">${x[1]}</option>`).join('')}</select></div>`,
            `<button class="btn-secondary" type="button" data-erp="close-modal">Cancelar</button>
             <button class="btn-primary" type="button" data-erp="save-nfe" data-id="${orderId}">Emitir NF-e</button>`);
    }

    const saveNfe = safe(async function (btn) {
        await api('/fiscal/nfe', { method: 'POST', body: { order_id: Number(btn.dataset.id), presenca: $('#e-pres').value } });
        toast('NF-e enviada. Acompanhe a situação na aba Notas Fiscais.', 'success');
        closeModal();
    });

    function docCancelForm(id) {
        openModal('<i class="fa-solid fa-ban"></i> Cancelar nota',
            `<div class="form-group"><label>Justificativa *</label><textarea id="dc-just" rows="3" placeholder="Mínimo de 15 caracteres"></textarea></div>
             <p class="erp-muted">A justificativa fica registrada na nota. O cancelamento pode levar alguns instantes: depois use “Atualizar situação”.</p>`,
            `<button class="btn-secondary" type="button" data-erp="close-modal">Voltar</button>
             <button class="btn-primary" type="button" data-erp="save-doc-cancel" data-id="${id}">Cancelar nota</button>`);
    }

    const saveDocCancel = safe(async function (btn) {
        await api(`/fiscal/docs/${btn.dataset.id}/cancel`, { method: 'POST', body: { justificativa: $('#dc-just').value } });
        toast('Cancelamento solicitado.', 'success');
        closeModal(); render();
    });

    // ---------- eventos ----------
    const act = {
        'close-modal': () => closeModal(),
        'tab': (el) => { S.tab = el.dataset.tab; S.filters.q = ''; S.filters.orderStatus = ''; S.filters.txStatus = 'aberto'; render(); },
        'new-order': () => openOrder(S.tab),
        'open-order': (el) => openOrder(el.dataset.id),
        'add-item': () => { $('#o-items', modalEl).insertAdjacentHTML('beforeend', itemRow({})); recalcOrder(); },
        'remove-item': (el) => { if (modalEl.querySelectorAll('.erp-item').length > 1) { el.closest('tr').remove(); recalcOrder(); } },
        'save-order': (el) => saveOrder(el),
        'confirm-order': safe(async (el) => {
            const o = S.orders.find((x) => x.id === Number(el.dataset.id));
            const msg = o.type === 'venda' ? 'Confirmar esta venda? O estoque será baixado e as contas a receber serão geradas.' : 'Confirmar o recebimento? O estoque receberá a entrada e as contas a pagar serão geradas.';
            if (!confirm(msg)) return;
            await api(`/orders/${o.id}/confirm`, { method: 'POST', body: {} });
            toast('Pedido confirmado.', 'success'); render();
        }),
        'cancel-order': safe(async (el) => {
            if (!confirm('Cancelar este pedido? O estoque será revertido e as parcelas em aberto canceladas.')) return;
            await api(`/orders/${el.dataset.id}/cancel`, { method: 'POST', body: {} });
            toast('Pedido cancelado.', 'success'); render();
        }),
        'delete-order': safe(async (el) => {
            if (!confirm('Excluir este rascunho?')) return;
            await api('/orders/' + el.dataset.id, { method: 'DELETE' }); render();
        }),
        'new-product': () => productForm(null),
        'edit-product': (el) => productForm(S.products.find((p) => p.id === Number(el.dataset.id))),
        'save-product': (el) => saveProduct(el),
        'delete-product': safe(async (el) => {
            if (!confirm('Excluir este produto? Se ele tiver histórico, será apenas inativado.')) return;
            const r = await api('/products/' + el.dataset.id, { method: 'DELETE' });
            toast(r.message || 'Produto excluído.', 'success'); render();
        }),
        'move': (el) => moveForm(el.dataset.id, el.dataset.kind),
        'save-move': (el) => saveMove(el),
        'new-party': () => partyForm(null),
        'edit-party': (el) => partyForm(S.parties.find((p) => p.id === Number(el.dataset.id))),
        'save-party': (el) => saveParty(el),
        'delete-party': safe(async (el) => {
            if (!confirm('Excluir este cadastro? Se ele tiver histórico, será apenas inativado.')) return;
            const r = await api('/parties/' + el.dataset.id, { method: 'DELETE' });
            toast(r.message || 'Cadastro excluído.', 'success'); render();
        }),
        'cep-lookup': safe(async () => {
            const cep = $('#c-cep').value.replace(/\D/g, '');
            if (cep.length !== 8) throw new Error('O CEP tem 8 dígitos.');
            const r = await api('/cep/' + cep);
            const set = (id, v) => { if (v) $(id).value = v; };
            set('#c-log', r.logradouro); set('#c-bairro', r.bairro); set('#c-cidade', r.cidade); set('#c-uf', r.uf); set('#c-ibge', r.codigo_municipio);
            $('#c-cep').value = r.cep;
            $('#c-num').focus();
        }),
        'new-tx': () => txForm(null),
        'edit-tx': (el) => txForm(S.tx.find((t) => t.id === Number(el.dataset.id))),
        'save-tx': (el) => saveTx(el),
        'pay-tx': (el) => payForm(el.dataset.id),
        'save-pay': (el) => savePay(el),
        'reopen-tx': safe(async (el) => {
            if (!confirm('Estornar este pagamento? O lançamento volta para "em aberto".')) return;
            await api(`/transactions/${el.dataset.id}/reopen`, { method: 'POST', body: {} }); render();
        }),
        'cancel-tx': safe(async (el) => {
            if (!confirm('Cancelar este lançamento?')) return;
            await api(`/transactions/${el.dataset.id}/cancel`, { method: 'POST', body: {} }); render();
        }),
        'fiscal-settings': () => fiscalSettingsForm(S.fiscalCfg),
        'save-fiscal': (el) => saveFiscal(el),
        'new-nfse': () => nfseForm(null),
        'order-nfse': (el) => nfseForm(Number(el.dataset.id)),
        'save-nfse': (el) => saveNfse(el),
        'order-nfe': (el) => nfeForm(Number(el.dataset.id)),
        'save-nfe': (el) => saveNfe(el),
        'doc-refresh': safe(async (el) => {
            await api(`/fiscal/docs/${el.dataset.id}/refresh`, { method: 'POST', body: {} });
            toast('Situação da nota atualizada.', 'success'); render();
        }),
        'doc-print': (el) => docPrintForm(el.dataset.id),
        'doc-print-now': (el) => docPrintNow(el),
        'doc-export': (el) => docExportForm(el.dataset.id),
        'doc-dl-pdf': docDownload('pdf'),
        'doc-dl-xml': docDownload('xml'),
        'doc-dl-receipt': docDownload('receipt'),
        'doc-cancel': (el) => docCancelForm(el.dataset.id),
        'save-doc-cancel': (el) => saveDocCancel(el),
        'delete-tx': safe(async (el) => {
            if (!confirm('Excluir este lançamento?')) return;
            await api('/transactions/' + el.dataset.id, { method: 'DELETE' }); render();
        })
    };

    function onClick(e) {
        const el = e.target.closest('[data-erp]');
        if (el && act[el.dataset.erp] && !['search', 'order-status', 'tx-status', 'item-product'].includes(el.dataset.erp)) act[el.dataset.erp](el);
    }

    // busca e filtros (re-renderiza só a lista, sem perder o foco da caixa de busca)
    let searchTimer = null;
    function onInput(e) {
        const el = e.target;
        if (el.dataset.erp === 'search') {
            S.filters.q = el.value;
            clearTimeout(searchTimer);
            searchTimer = setTimeout(() => {
                const box = $('#erp-content');
                const pos = el.selectionStart;
                const views = { venda: viewOrders, compra: viewOrders, produtos: viewProducts, estoque: viewStock, cadastros: viewParties, receber: viewTx, pagar: viewTx, notas: viewNotas };
                if (views[S.tab]) {
                    box.innerHTML = views[S.tab]();
                    const again = $('.erp-search', box);
                    if (again) { again.focus(); again.setSelectionRange(pos, pos); }
                }
            }, 200);
        }
    }
    document.addEventListener('change', (e) => {
        const el = e.target;
        if (el.dataset && el.dataset.erp === 'order-status') { S.filters.orderStatus = el.value; $('#erp-content').innerHTML = viewOrders(); }
        if (el.dataset && el.dataset.erp === 'tx-status') { S.filters.txStatus = el.value; render(); }
        if (el.dataset && el.dataset.erp === 'item-product' && modalEl) {
            const tr = el.closest('tr');
            const p = S.products.find((x) => x.id === Number(el.value));
            const type = $('[data-erp="save-order"]', modalEl) ? $('[data-erp="save-order"]', modalEl).dataset.type : 'venda';
            if (p) {
                if (!$('.it-desc', tr).value.trim()) $('.it-desc', tr).value = p.name;
                $('.it-price', tr).value = type === 'venda' ? p.sale_price : p.cost_price;
            }
            recalcOrder();
        }
    });
    document.addEventListener('input', (e) => {
        if (modalEl && e.target.closest && e.target.closest('.erp-item, #o-discount')) recalcOrder();
    });
    // cliques dentro dos modais (ficam fora do #tab-erp)
    document.addEventListener('click', (e) => {
        if (!modalEl || !modalEl.contains(e.target)) return;
        const el = e.target.closest('[data-erp]');
        if (el && act[el.dataset.erp] && !['search', 'order-status', 'tx-status', 'item-product'].includes(el.dataset.erp)) act[el.dataset.erp](el);
    });

    // ---------- ativação: renderiza quando a aba ERP é aberta ----------
    function watch() {
        const pane = $('#tab-erp');
        if (!pane) return;
        const check = () => { if (pane.classList.contains('active')) boot(); };
        new MutationObserver((muts) => {
            if (muts.some((m) => m.attributeName === 'class') && pane.classList.contains('active')) check();
        }).observe(pane, { attributes: true, attributeFilter: ['class'] });
        check();
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watch); else watch();
})();