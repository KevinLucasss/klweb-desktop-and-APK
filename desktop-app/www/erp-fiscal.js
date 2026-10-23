/*!
 * KL Web — Tela Fiscal do ERP (front)
 *
 * Um arquivo só, sem dependências. Cobre:
 *   • Notas: lista, atualizar status, abrir nota/DANFE/XML, cancelar e emitir NFS-e (serviço) ou NF-e (produto) de um pedido confirmado
 *   • Configuração fiscal da empresa (token da Focus NFe, ambiente, NFS-e e NF-e)
 *   • Clientes: endereço estruturado, com busca por CEP
 *   • Produtos: NCM, CEST, CFOP, origem e ICMS
 *
 * Como usar (veja INTEGRACAO.md):
 *   <div id="erpFiscalRoot"></div>
 *   <script src="erp-fiscal.js"></script>
 *   <script>KLErpFiscal.mount('#erpFiscalRoot');</script>
 *
 * Opções de mount(alvo, opts):
 *   getToken()        → devolve o JWT (padrão: procura em localStorage/sessionStorage: token, authToken, jwt, accessToken)
 *   apiBase           → prefixo das rotas (padrão: '' = mesma origem)
 *   onUnauthorized()  → chamado quando a API devolve 401
 *
 * Segurança: todo texto vindo da API entra na página por textContent (nunca innerHTML).
 */
(function (global) {
    'use strict';

    var STYLE_ID = 'klf-style';
    var CSS = [
        '.klf{font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--text,#1f2933);max-width:1100px}',
        '.klf *{box-sizing:border-box}',
        '.klf h3{margin:0 0 .6rem;font-size:1.05rem}',
        '.klf-tabs{display:flex;gap:.25rem;flex-wrap:wrap;border-bottom:1px solid var(--border,#d5dbe1);margin-bottom:1rem}',
        '.klf-tab{border:0;background:none;padding:.55rem .9rem;cursor:pointer;font:inherit;color:inherit;border-bottom:2px solid transparent}',
        '.klf-tab[aria-selected=true]{border-bottom-color:var(--primary,#2563eb);font-weight:600;color:var(--primary,#2563eb)}',
        '.klf-card{border:1px solid var(--border,#d5dbe1);border-radius:10px;padding:1rem;margin-bottom:1rem;background:var(--card,transparent)}',
        '.klf-row{display:flex;gap:.6rem;flex-wrap:wrap;align-items:flex-end}',
        '.klf-field{display:flex;flex-direction:column;gap:.2rem;min-width:160px;flex:1}',
        '.klf-field.sm{min-width:100px;flex:0 0 130px}',
        '.klf-field label{font-size:.78rem;opacity:.8}',
        '.klf input,.klf select,.klf textarea{font:inherit;padding:.45rem .55rem;border:1px solid var(--border,#c3cbd3);border-radius:7px;background:var(--input-bg,#fff);color:inherit;width:100%}',
        '.klf input[type=checkbox]{width:auto}',
        '.klf-check{display:flex;align-items:center;gap:.4rem;padding-bottom:.45rem}',
        '.klf-btn{font:inherit;padding:.45rem .85rem;border-radius:7px;border:1px solid var(--primary,#2563eb);background:var(--primary,#2563eb);color:#fff;cursor:pointer}',
        '.klf-btn.ghost{background:transparent;color:var(--primary,#2563eb)}',
        '.klf-btn.danger{border-color:#b42318;background:#b42318}',
        '.klf-btn.sm{padding:.25rem .55rem;font-size:.8rem}',
        '.klf-btn[disabled]{opacity:.55;cursor:default}',
        '.klf table{width:100%;border-collapse:collapse}',
        '.klf th,.klf td{text-align:left;padding:.45rem .5rem;border-bottom:1px solid var(--border,#e4e8ec);vertical-align:middle}',
        '.klf th{font-size:.78rem;opacity:.75;font-weight:600}',
        '.klf-wrap{overflow-x:auto}',
        '.klf-badge{display:inline-block;padding:.1rem .5rem;border-radius:99px;font-size:.75rem;font-weight:600;background:#e5e7eb;color:#374151}',
        '.klf-badge.ok{background:#d1fae5;color:#065f46}.klf-badge.warn{background:#fef3c7;color:#92400e}.klf-badge.bad{background:#fee2e2;color:#991b1b}',
        '.klf-msg{padding:.6rem .8rem;border-radius:8px;margin-bottom:.8rem;background:#eff6ff;color:#1e3a8a}',
        '.klf-msg.err{background:#fee2e2;color:#991b1b}.klf-msg.ok{background:#d1fae5;color:#065f46}.klf-msg.warn{background:#fef3c7;color:#92400e}',
        '.klf-muted{opacity:.7;font-size:.85rem}',
        '.klf-actions{display:flex;gap:.3rem;flex-wrap:wrap}',
        '.klf a{color:var(--primary,#2563eb)}'
    ].join('\n');

    var UFS = ['AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO'];
    var STATUS = {
        enviando: ['Enviando', 'warn'], processando_autorizacao: ['Processando', 'warn'], autorizado: ['Autorizada', 'ok'],
        erro_autorizacao: ['Recusada', 'bad'], erro_envio: ['Erro de envio', 'bad'], cancelando: ['Cancelando', 'warn'],
        cancelado: ['Cancelada', ''], denegado: ['Denegada', 'bad']
    };

    // ---------- helpers ----------
    function h(tag, attrs, children) {
        var el = document.createElement(tag);
        if (attrs) {
            Object.keys(attrs).forEach(function (k) {
                var v = attrs[k];
                if (v === undefined || v === null || v === false) return;
                if (k === 'class') el.className = v;
                else if (k === 'text') el.textContent = v;
                else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2), v);
                else if (k === 'value') el.value = v;
                else if (v === true) el.setAttribute(k, '');
                else el.setAttribute(k, v);
            });
        }
        (children || []).forEach(function (c) {
            if (c === null || c === undefined || c === false) return;
            el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
        });
        return el;
    }
    var digits = function (v) { return String(v === undefined || v === null ? '' : v).replace(/\D/g, ''); };
    var brl = function (v) { return Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); };
    var fmtDate = function (v) { try { return v ? new Date(v).toLocaleString('pt-BR') : ''; } catch (e) { return ''; } };
    var safeUrl = function (u) { return /^https?:\/\//i.test(String(u || '')) ? String(u) : ''; };

    function field(label, input, cls) {
        return h('div', { class: 'klf-field' + (cls ? ' ' + cls : '') }, [h('label', { text: label }), input]);
    }
    function select(options, value) {
        var s = h('select');
        options.forEach(function (o) {
            var opt = h('option', { value: o[0], text: o[1] });
            if (String(o[0]) === String(value)) opt.selected = true;
            s.appendChild(opt);
        });
        return s;
    }
    function badge(status) {
        var s = STATUS[status] || [status || '—', ''];
        return h('span', { class: 'klf-badge ' + s[1], text: s[0] });
    }

    // ---------- API ----------
    function makeApi(opts) {
        function token() {
            if (typeof opts.getToken === 'function') return opts.getToken();
            var keys = ['token', 'authToken', 'jwt', 'accessToken'];
            for (var i = 0; i < keys.length; i++) {
                try {
                    var v = global.localStorage.getItem(keys[i]) || global.sessionStorage.getItem(keys[i]);
                    if (v) return v.replace(/^"|"$/g, '');
                } catch (e) { /* storage bloqueado */ }
            }
            return '';
        }
        return function api(method, path, body) {
            var headers = { 'Content-Type': 'application/json' };
            var t = token();
            if (t) headers.Authorization = 'Bearer ' + t;
            return global.fetch((opts.apiBase || '') + path, { method: method, headers: headers, body: body === undefined ? undefined : JSON.stringify(body) })
                .then(function (r) {
                    return r.json().catch(function () { return null; }).then(function (data) {
                        if (r.status === 401 && typeof opts.onUnauthorized === 'function') opts.onUnauthorized();
                        if (!r.ok) {
                            var e = new Error((data && data.message) || ('Erro ' + r.status));
                            e.status = r.status; e.code = data && data.code;
                            throw e;
                        }
                        return data;
                    });
                });
        };
    }

    // ---------- app ----------
    function mount(target, opts) {
        opts = opts || {};
        var root = typeof target === 'string' ? document.querySelector(target) : target;
        if (!root) throw new Error('KLErpFiscal: elemento de destino não encontrado.');
        if (!document.getElementById(STYLE_ID)) {
            var st = document.createElement('style');
            st.id = STYLE_ID; st.textContent = CSS;
            document.head.appendChild(st);
        }
        var api = makeApi(opts);
        var state = { tab: 'notas', settings: null };
        var box = h('div', { class: 'klf' });
        root.textContent = '';
        root.appendChild(box);

        function note(host, text, kind) {
            var old = host.querySelector('.klf-msg');
            if (old) old.remove();
            if (!text) return;
            host.insertBefore(h('div', { class: 'klf-msg ' + (kind || ''), role: 'status', text: text }), host.firstChild);
        }
        function busy(btn, on) { btn.disabled = !!on; }
        function run(btn, host, fn, okText) {
            busy(btn, true);
            note(host, '');
            return fn().then(function (r) { if (okText) note(host, okText, 'ok'); return r; })
                .catch(function (e) { note(host, e.message, 'err'); })
                .then(function (r) { busy(btn, false); return r; });
        }

        var views = { notas: viewNotas, config: viewConfig, clientes: viewClientes, produtos: viewProdutos };
        var labels = [['notas', 'Notas fiscais'], ['config', 'Configuração fiscal'], ['clientes', 'Clientes (endereço)'], ['produtos', 'Produtos (dados fiscais)']];

        function shell(access) {
            box.textContent = '';
            var tabs = h('div', { class: 'klf-tabs', role: 'tablist' });
            var body = h('div', { class: 'klf-body' });
            labels.forEach(function (l) {
                tabs.appendChild(h('button', {
                    class: 'klf-tab', role: 'tab', 'aria-selected': state.tab === l[0] ? 'true' : 'false', text: l[1],
                    onclick: function () { state.tab = l[0]; shell(access); }
                }));
            });
            box.appendChild(tabs);
            box.appendChild(body);
            views[state.tab](body, access);
        }

        // ----- Notas -----
        function viewNotas(body) {
            var emit = h('div', { class: 'klf-card' });
            var listBox = h('div', { class: 'klf-card' });
            body.appendChild(emit);
            body.appendChild(listBox);

            var orderSel = h('select', { 'aria-label': 'Pedido de venda' });
            var kindSel = select([['nfse', 'Serviço (NFS-e)'], ['nfe', 'Produto (NF-e)']], 'nfse');
            var emitBtn = h('button', { class: 'klf-btn', text: 'Emitir nota' });
            emit.appendChild(h('h3', { text: 'Emitir nota de um pedido de venda' }));
            var amb = h('div', { class: 'klf-muted', text: '' });
            emit.appendChild(h('div', { class: 'klf-row' }, [field('Pedido confirmado', orderSel), field('Tipo de nota', kindSel, 'sm'), emitBtn]));
            emit.appendChild(amb);

            function loadOrders() {
                return Promise.all([api('GET', '/api/erp/orders?type=venda&status=confirmado'), api('GET', '/api/erp/fiscal/settings')]).then(function (r) {
                    state.settings = r[1];
                    orderSel.textContent = '';
                    if (!r[0].length) orderSel.appendChild(h('option', { value: '', text: 'Nenhum pedido de venda confirmado' }));
                    r[0].forEach(function (o) {
                        orderSel.appendChild(h('option', { value: o.id, text: '#' + o.number + ' · ' + (o.party_name || 'sem cliente') + ' · ' + brl(o.total) }));
                    });
                    amb.textContent = r[1].ambiente === 'producao'
                        ? 'Ambiente: PRODUÇÃO (notas com validade fiscal).'
                        : 'Ambiente: HOMOLOGAÇÃO (testes, sem validade fiscal).';
                }).catch(function (e) { note(emit, e.message, 'err'); });
            }

            emitBtn.addEventListener('click', function () {
                if (!orderSel.value) { note(emit, 'Escolha um pedido de venda confirmado.', 'err'); return; }
                var kind = kindSel.value;
                run(emitBtn, emit, function () {
                    return api('POST', '/api/erp/fiscal/' + kind, { order_id: Number(orderSel.value) }).then(function () { return loadList(); });
                }, 'Nota enviada à Focus NFe. Use "Atualizar" para ver o resultado.');
            });

            function loadList() {
                listBox.textContent = '';
                listBox.appendChild(h('h3', { text: 'Notas emitidas' }));
                var pendBtn = h('button', { class: 'klf-btn ghost sm', text: 'Atualizar todas as pendentes' });
                listBox.appendChild(pendBtn);
                return api('GET', '/api/erp/fiscal/docs').then(function (docs) {
                    if (!docs.length) { listBox.appendChild(h('p', { class: 'klf-muted', text: 'Nenhuma nota emitida ainda.' })); return; }
                    var tb = h('tbody');
                    docs.forEach(function (d) { rowDoc(d).forEach(function (tr) { tb.appendChild(tr); }); });
                    listBox.appendChild(h('div', { class: 'klf-wrap' }, [h('table', null, [
                        h('thead', null, [h('tr', null, ['Tipo', 'Pedido', 'Cliente', 'Valor', 'Status', 'Número', 'Criada em', 'Ações'].map(function (t) { return h('th', { text: t }); }))]),
                        tb
                    ])]));
                    pendBtn.addEventListener('click', function () {
                        var pend = docs.filter(function (d) { return ['processando_autorizacao', 'enviando', 'erro_envio', 'cancelando'].indexOf(d.status) >= 0; });
                        run(pendBtn, listBox, function () {
                            return pend.reduce(function (p, d) { return p.then(function () { return api('POST', '/api/erp/fiscal/docs/' + d.id + '/refresh'); }); }, Promise.resolve()).then(loadList);
                        }, pend.length ? 'Notas atualizadas.' : 'Não há notas pendentes.');
                    });
                }).catch(function (e) { note(listBox, e.message, 'err'); });
            }

            function rowDoc(d) {
                var actions = h('div', { class: 'klf-actions' });
                var refresh = h('button', { class: 'klf-btn ghost sm', text: 'Atualizar' });
                refresh.addEventListener('click', function () {
                    run(refresh, listBox, function () { return api('POST', '/api/erp/fiscal/docs/' + d.id + '/refresh').then(loadList); });
                });
                actions.appendChild(refresh);
                [['Nota', d.url], ['DANFE', d.danfe_url], ['XML', d.xml_url]].forEach(function (l) {
                    if (safeUrl(l[1])) actions.appendChild(h('a', { href: safeUrl(l[1]), target: '_blank', rel: 'noopener noreferrer', class: 'klf-btn ghost sm', text: l[0] }));
                });
                if (d.status === 'autorizado') {
                    var cancel = h('button', { class: 'klf-btn danger sm', text: 'Cancelar' });
                    cancel.addEventListener('click', function () {
                        var j = global.prompt('Justificativa do cancelamento (mínimo de 15 caracteres):');
                        if (j === null) return;
                        run(cancel, listBox, function () { return api('POST', '/api/erp/fiscal/docs/' + d.id + '/cancel', { justificativa: j }).then(loadList); }, 'Cancelamento solicitado.');
                    });
                    actions.appendChild(cancel);
                }
                var cells = [
                    h('td', { text: d.kind === 'nfe' ? 'NF-e' : 'NFS-e' }),
                    h('td', { text: d.order_number ? '#' + d.order_number : '—' }),
                    h('td', { text: d.party_name || '—' }),
                    h('td', { text: brl(d.amount) }),
                    h('td', null, [badge(d.status), d.ambiente === 'homologacao' ? h('div', { class: 'klf-muted', text: 'homologação' }) : null]),
                    h('td', { text: d.numero || '—' }),
                    h('td', { text: fmtDate(d.created_at) }),
                    h('td', null, [actions])
                ];
                var tr = h('tr', null, cells);
                if (d.errors) return [tr, h('tr', null, [h('td', { colspan: 8, class: 'klf-muted', text: 'Motivo: ' + d.errors })])];
                return [tr];
            }

            loadOrders();
            loadList();
        }

        // ----- Configuração fiscal -----
        function viewConfig(body) {
            var card = h('div', { class: 'klf-card' });
            body.appendChild(card);
            api('GET', '/api/erp/fiscal/settings').then(function (s) {
                state.settings = s;
                var f = {};
                function inp(key, label, extra) {
                    f[key] = h('input', Object.assign({ value: s[key] === undefined ? '' : s[key], autocomplete: 'off' }, extra || {}));
                    return field(label, f[key]);
                }
                f.ambiente = select([['homologacao', 'Homologação (testes)'], ['producao', 'Produção']], s.ambiente);
                f.token = h('input', { type: 'password', autocomplete: 'new-password', placeholder: s.has_token ? '•••••••• (já configurado — deixe em branco para manter)' : 'Cole o token da Focus NFe' });
                f.remove = h('input', { type: 'checkbox' });
                f.optante = h('input', { type: 'checkbox' }); f.optante.checked = !!s.optante_simples;
                f.iss = h('input', { type: 'checkbox' }); f.iss.checked = !!s.iss_retido;
                f.regime = select([['', 'Selecione…'], ['1', '1 — Simples Nacional'], ['2', '2 — Simples (excesso de sublimite)'], ['3', '3 — Regime Normal']], s.regime_tributario);
                f.uf = select([['', 'UF…']].concat(UFS.map(function (u) { return [u, u]; })), s.uf);
                f.pis = select([['04', '04'], ['05', '05'], ['06', '06'], ['07', '07 — Isenta'], ['08', '08'], ['09', '09']], s.pis_cofins_situacao);

                card.appendChild(h('h3', { text: 'Focus NFe' }));
                card.appendChild(h('div', { class: 'klf-row' }, [field('Ambiente', f.ambiente), field('Token da empresa na Focus NFe', f.token),
                    h('label', { class: 'klf-check' }, [f.remove, 'Remover token'])]));
                card.appendChild(h('p', { class: 'klf-muted', text: 'O token fica guardado criptografado e nunca é exibido de volta. Comece sempre em Homologação.' }));
                card.appendChild(h('div', { class: 'klf-row' }, [inp('cnpj', 'CNPJ da empresa')]));

                card.appendChild(h('h3', { text: 'Nota de serviço (NFS-e)' }));
                card.appendChild(h('div', { class: 'klf-row' }, [inp('inscricao_municipal', 'Inscrição municipal'), inp('codigo_municipio', 'Código IBGE do município (7 dígitos)'),
                    inp('item_lista_servico', 'Item da lista de serviços (ex.: 14.01)'), inp('codigo_tributario_municipio', 'Código tributário do município'),
                    inp('aliquota', 'Alíquota de ISS (%)', { inputmode: 'decimal' })]));
                card.appendChild(h('div', { class: 'klf-row' }, [inp('natureza_operacao', 'Natureza da operação (1 a 6)'), inp('regime_especial', 'Regime especial de tributação'),
                    h('label', { class: 'klf-check' }, [f.optante, 'Optante pelo Simples Nacional']), h('label', { class: 'klf-check' }, [f.iss, 'ISS retido'])]));

                card.appendChild(h('h3', { text: 'Nota de produto (NF-e)' }));
                card.appendChild(h('div', { class: 'klf-row' }, [inp('inscricao_estadual', 'Inscrição estadual'), field('Regime tributário', f.regime), field('UF da empresa', f.uf, 'sm'), field('PIS/COFINS (situação)', f.pis, 'sm')]));
                card.appendChild(h('p', { class: 'klf-muted', text: 'A NF-e aqui cobre vendas simples: Simples Nacional com CSOSN 102, 103, 300, 400 ou 500, ou Regime Normal com CST 00, 40, 41, 50 ou 60. Casos com substituição tributária ou IPI ainda não são suportados.' }));

                var save = h('button', { class: 'klf-btn', text: 'Salvar configuração' });
                card.appendChild(save);
                save.addEventListener('click', function () {
                    var payload = {
                        ambiente: f.ambiente.value, cnpj: f.cnpj.value, inscricao_municipal: f.inscricao_municipal.value, codigo_municipio: f.codigo_municipio.value,
                        item_lista_servico: f.item_lista_servico.value, codigo_tributario_municipio: f.codigo_tributario_municipio.value, aliquota: f.aliquota.value || 0,
                        natureza_operacao: f.natureza_operacao.value, regime_especial: f.regime_especial.value, optante_simples: f.optante.checked, iss_retido: f.iss.checked,
                        inscricao_estadual: f.inscricao_estadual.value, regime_tributario: f.regime.value, uf: f.uf.value, pis_cofins_situacao: f.pis.value
                    };
                    if (f.remove.checked) payload.remove_token = true;
                    else if (f.token.value.trim()) payload.token = f.token.value.trim();
                    run(save, card, function () {
                        return api('PUT', '/api/erp/fiscal/settings', payload).then(function (r) { state.settings = r; f.token.value = ''; f.remove.checked = false; });
                    }, 'Configuração salva.');
                });
            }).catch(function (e) { note(card, e.message, 'err'); });
        }

        // ----- Clientes (endereço) -----
        function viewClientes(body) {
            var card = h('div', { class: 'klf-card' });
            var editor = h('div', { class: 'klf-card' });
            body.appendChild(card);
            body.appendChild(editor);
            card.appendChild(h('h3', { text: 'Endereço dos clientes' }));
            card.appendChild(h('p', { class: 'klf-muted', text: 'A NF-e exige endereço completo; muitas prefeituras também exigem na NFS-e. Digite o CEP e use “Buscar CEP” para completar.' }));
            var q = h('input', { placeholder: 'Buscar cliente pelo nome…', 'aria-label': 'Buscar cliente' });
            card.appendChild(q);
            var listHost = h('div');
            card.appendChild(listHost);

            var parties = [];
            function missing(e) {
                var m = [];
                if (!e.logradouro) m.push('logradouro'); if (!e.numero) m.push('número'); if (!e.bairro) m.push('bairro');
                if (digits(e.codigo_municipio).length !== 7) m.push('IBGE'); if (!e.uf) m.push('UF'); if (digits(e.cep).length !== 8) m.push('CEP');
                return m;
            }
            function draw() {
                var term = q.value.trim().toLowerCase();
                listHost.textContent = '';
                var rows = parties.filter(function (p) { return p.kind !== 'fornecedor' && p.active && (!term || p.name.toLowerCase().indexOf(term) >= 0); }).slice(0, 200);
                if (!rows.length) { listHost.appendChild(h('p', { class: 'klf-muted', text: 'Nenhum cliente encontrado.' })); return; }
                var tb = h('tbody');
                rows.forEach(function (p) {
                    var m = missing(p.endereco || {});
                    var btn = h('button', { class: 'klf-btn ghost sm', text: 'Editar endereço', onclick: function () { openEditor(p); } });
                    tb.appendChild(h('tr', null, [h('td', { text: p.name }), h('td', { text: p.doc || '—' }),
                        h('td', null, [h('span', { class: 'klf-badge ' + (m.length ? 'warn' : 'ok'), text: m.length ? 'falta: ' + m.join(', ') : 'completo' })]), h('td', null, [btn])]));
                });
                listHost.appendChild(h('div', { class: 'klf-wrap' }, [h('table', null, [h('thead', null, [h('tr', null, ['Cliente', 'CPF/CNPJ', 'Endereço', ''].map(function (t) { return h('th', { text: t }); }))]), tb])]));
            }
            q.addEventListener('input', draw);

            function openEditor(p) {
                editor.textContent = '';
                var e = p.endereco || {};
                var f = {
                    cep: h('input', { value: e.cep || '', inputmode: 'numeric', maxlength: 9 }), logradouro: h('input', { value: e.logradouro || '' }), numero: h('input', { value: e.numero || '' }),
                    complemento: h('input', { value: e.complemento || '' }), bairro: h('input', { value: e.bairro || '' }), cidade: h('input', { value: e.cidade || '' }),
                    codigo_municipio: h('input', { value: e.codigo_municipio || '', inputmode: 'numeric', maxlength: 7 }),
                    uf: select([['', 'UF…']].concat(UFS.map(function (u) { return [u, u]; })), e.uf)
                };
                var buscar = h('button', { class: 'klf-btn ghost sm', text: 'Buscar CEP' });
                var save = h('button', { class: 'klf-btn', text: 'Salvar endereço' });
                editor.appendChild(h('h3', { text: 'Endereço de ' + p.name }));
                editor.appendChild(h('div', { class: 'klf-row' }, [field('CEP', f.cep, 'sm'), buscar]));
                editor.appendChild(h('div', { class: 'klf-row' }, [field('Logradouro', f.logradouro), field('Número', f.numero, 'sm'), field('Complemento', f.complemento)]));
                editor.appendChild(h('div', { class: 'klf-row' }, [field('Bairro', f.bairro), field('Cidade', f.cidade), field('Código IBGE', f.codigo_municipio, 'sm'), field('UF', f.uf, 'sm')]));
                editor.appendChild(save);
                buscar.addEventListener('click', function () {
                    var c = digits(f.cep.value);
                    if (c.length !== 8) { note(editor, 'O CEP tem 8 dígitos.', 'err'); return; }
                    run(buscar, editor, function () {
                        return api('GET', '/api/erp/cep/' + c).then(function (r) {
                            f.logradouro.value = r.logradouro || f.logradouro.value; f.bairro.value = r.bairro || f.bairro.value; f.cidade.value = r.cidade || f.cidade.value;
                            f.codigo_municipio.value = r.codigo_municipio || f.codigo_municipio.value; f.uf.value = r.uf || f.uf.value;
                        });
                    }, 'CEP encontrado. Confira o número e salve.');
                });
                save.addEventListener('click', function () {
                    // O PUT substitui os dados principais do cadastro: reenvia o que já existe para não apagar nada.
                    var bodyReq = {
                        kind: p.kind, name: p.name, doc: p.doc, phone: p.phone, email: p.email, address: p.address, notes: p.notes, active: p.active,
                        endereco: { cep: f.cep.value, logradouro: f.logradouro.value, numero: f.numero.value, complemento: f.complemento.value, bairro: f.bairro.value,
                            cidade: f.cidade.value, codigo_municipio: f.codigo_municipio.value, uf: f.uf.value }
                    };
                    run(save, editor, function () {
                        return api('PUT', '/api/erp/parties/' + p.id, bodyReq).then(function (r) {
                            var i = parties.findIndex(function (x) { return x.id === p.id; });
                            if (i >= 0) parties[i] = r;
                            draw();
                        });
                    }, 'Endereço salvo.');
                });
            }

            api('GET', '/api/erp/parties').then(function (r) { parties = r; draw(); }).catch(function (e) { note(card, e.message, 'err'); });
        }

        // ----- Produtos (dados fiscais) -----
        function viewProdutos(body) {
            var card = h('div', { class: 'klf-card' });
            var editor = h('div', { class: 'klf-card' });
            body.appendChild(card);
            body.appendChild(editor);
            card.appendChild(h('h3', { text: 'Dados fiscais dos produtos' }));
            card.appendChild(h('p', { class: 'klf-muted', text: 'Necessários só para NF-e (nota de produto). Serviços não usam esses campos.' }));
            var q = h('input', { placeholder: 'Buscar produto pelo nome ou SKU…', 'aria-label': 'Buscar produto' });
            card.appendChild(q);
            var listHost = h('div');
            card.appendChild(listHost);
            var products = [];

            function missing(p) {
                var m = [];
                if (digits(p.ncm).length !== 8) m.push('NCM'); if (digits(p.cfop).length !== 4) m.push('CFOP'); if (!p.icms_situacao) m.push('ICMS');
                return m;
            }
            function draw() {
                var term = q.value.trim().toLowerCase();
                listHost.textContent = '';
                var rows = products.filter(function (p) { return !p.is_service && p.active && (!term || (p.name + ' ' + p.sku).toLowerCase().indexOf(term) >= 0); }).slice(0, 300);
                if (!rows.length) { listHost.appendChild(h('p', { class: 'klf-muted', text: 'Nenhum produto encontrado.' })); return; }
                var tb = h('tbody');
                rows.forEach(function (p) {
                    var m = missing(p);
                    tb.appendChild(h('tr', null, [h('td', { text: p.name }), h('td', { text: p.sku || '—' }), h('td', { text: p.ncm || '—' }), h('td', { text: p.cfop || '—' }),
                        h('td', null, [h('span', { class: 'klf-badge ' + (m.length ? 'warn' : 'ok'), text: m.length ? 'falta: ' + m.join(', ') : 'completo' })]),
                        h('td', null, [h('button', { class: 'klf-btn ghost sm', text: 'Editar', onclick: function () { openEditor(p); } })])]));
                });
                listHost.appendChild(h('div', { class: 'klf-wrap' }, [h('table', null, [h('thead', null, [h('tr', null, ['Produto', 'SKU', 'NCM', 'CFOP', 'Dados fiscais', ''].map(function (t) { return h('th', { text: t }); }))]), tb])]));
            }
            q.addEventListener('input', draw);

            function openEditor(p) {
                editor.textContent = '';
                var f = {
                    ncm: h('input', { value: p.ncm || '', inputmode: 'numeric', maxlength: 10, placeholder: '8 dígitos' }),
                    cest: h('input', { value: p.cest || '', inputmode: 'numeric', maxlength: 7, placeholder: 'opcional' }),
                    cfop: h('input', { value: p.cfop || '', inputmode: 'numeric', maxlength: 4, placeholder: 'ex.: 5102' }),
                    origem: select([0, 1, 2, 3, 4, 5, 6, 7, 8].map(function (n) { return [String(n), n + (n === 0 ? ' — Nacional' : n === 1 ? ' — Estrangeira (importação direta)' : n === 2 ? ' — Estrangeira (mercado interno)' : '')]; }), p.origem || '0'),
                    icms: h('input', { value: p.icms_situacao || '', inputmode: 'numeric', maxlength: 3, placeholder: 'CSOSN ou CST', list: 'klf-icms' }),
                    aliq: h('input', { value: p.icms_aliquota || 0, inputmode: 'decimal' })
                };
                var dl = h('datalist', { id: 'klf-icms' }, ['102', '103', '300', '400', '500', '00', '40', '41', '50', '60'].map(function (v) { return h('option', { value: v }); }));
                var save = h('button', { class: 'klf-btn', text: 'Salvar dados fiscais' });
                editor.appendChild(h('h3', { text: 'Dados fiscais de ' + p.name }));
                editor.appendChild(h('div', { class: 'klf-row' }, [field('NCM', f.ncm), field('CEST', f.cest, 'sm'), field('CFOP', f.cfop, 'sm'), field('Origem', f.origem)]));
                editor.appendChild(h('div', { class: 'klf-row' }, [field('ICMS — situação (CSOSN/CST)', f.icms), field('ICMS — alíquota % (só CST 00)', f.aliq, 'sm'), dl]));
                editor.appendChild(h('p', { class: 'klf-muted', text: 'CFOP 5xxx = venda dentro do estado; 6xxx = venda para outro estado.' }));
                editor.appendChild(save);
                save.addEventListener('click', function () {
                    var bodyReq = {
                        sku: p.sku, name: p.name, category: p.category, unit: p.unit, is_service: p.is_service, cost_price: p.cost_price, sale_price: p.sale_price,
                        min_stock: p.min_stock, active: p.active,
                        ncm: f.ncm.value, cest: f.cest.value, cfop: f.cfop.value, origem: f.origem.value, icms_situacao: f.icms.value, icms_aliquota: f.aliq.value || 0
                    };
                    run(save, editor, function () {
                        return api('PUT', '/api/erp/products/' + p.id, bodyReq).then(function (r) {
                            var i = products.findIndex(function (x) { return x.id === p.id; });
                            if (i >= 0) products[i] = r;
                            draw();
                        });
                    }, 'Dados fiscais salvos.');
                });
            }

            api('GET', '/api/erp/products').then(function (r) { products = r; draw(); }).catch(function (e) { note(card, e.message, 'err'); });
        }

        // ----- entrada: confere o acesso antes de mostrar qualquer coisa -----
        box.appendChild(h('p', { class: 'klf-muted', text: 'Carregando…' }));
        return api('GET', '/api/erp/access').then(function (a) {
            if (!a.enabled) { box.textContent = ''; box.appendChild(h('div', { class: 'klf-msg warn', text: a.message || 'O ERP não está liberado no seu plano.' })); return; }
            if (!a.fiscal) {
                box.textContent = '';
                box.appendChild(h('div', { class: 'klf-msg warn', text: a.finance
                    ? 'A emissão de notas fiscais (Focus NFe) é exclusiva do plano Pro AI. Faça upgrade na aba Planos & Assinatura para liberar esse recurso.'
                    : 'Apenas Dono, Admin ou Gerente da empresa podem usar a área fiscal.' }));
                return;
            }
            shell(a);
        }).catch(function (e) { box.textContent = ''; box.appendChild(h('div', { class: 'klf-msg err', text: e.message })); });
    }

    global.KLErpFiscal = { mount: mount };
})(typeof window !== 'undefined' ? window : this);
