const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

const fs = require('fs');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { processarAgenteKLWeb } = require('./ai'); // Importando a lógica da IA
const PLAN_STARTER_URL = process.env.PLAN_STARTER_URL || 'https://mpago.la/1qGm52q';
const PLAN_PRO_AI_URL = process.env.PLAN_PRO_AI_URL || 'https://mpago.la/31zeLGt';
const { Pool, types: pgTypes } = require('pg');
// DATE e TIME viram texto simples ("2026-10-12", "09:00"). Sem isso o node-pg entrega um objeto Date,
// que o JSON converte para "2026-10-12T00:00:00.000Z" e quebra comparações de data no calendário.
pgTypes.setTypeParser(1082, (v) => v);
pgTypes.setTypeParser(1083, (v) => (v ? v.slice(0, 5) : v));
const parsePgUrl = require('pg-connection-string').parse;
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { Resend } = require('resend');
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const { MercadoPagoConfig, Preference, PreApproval, Invoice, WebhookSignatureValidator, InvalidWebhookSignatureError } = require('mercadopago');
const multer = require('multer');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Módulo de Segurança
const {
    sanitizeInput,
    validateEmail,
    validatePhone,
    validateText,
    escapeForLikePattern,
    securityMonitor,
    securityCheck,
    validateSensitiveData,
    generateCSRFToken,
    validateCSRFToken,
    logSecurityEvent,
    validateFileUpload,
    maskSensitiveData,
    escapeXSS,
    setSecurityHeaders,
    trackLoginAttempt,
    clearLoginAttempt,
    verifyRequestOrigin
} = require('./security');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
const {
    PLAN_LIMITS,
    getPlanLimits,
    normalizePlanTier,
    effectiveTier,
    canUseWarehouse,
    canUseAI,
    canCreateDemand,
    canCreateEvent,
    canUseEmailNotifications,
    canUseNotes,
    canUsePushNotifications,
    canUseErp,
    canUseErpFiscal,
    pickHighestTier,
    isPlanActive
} = require('./planLimits');
const totp = require('./totp');
const clinicAi = require('./ai'); // Cláudia: anotações + dados de clínica (agora dentro do ai.js)
const {
    encryptData,
    decryptData,
    decryptUser,
    decryptUsers,
    decryptContact,
    decryptContacts
} = require('./cryptoUtils');

// IMPORTAÇÃO SEGURA DA IA
let aiModule = null;
try {
    aiModule = require('./ai');
    console.log('✅ Módulo de IA carregado com sucesso!');
} catch (err) {
    console.error('❌ Erro crítico ao carregar módulo ai.js:', err.message);
}

// Validação de e-mail única (antes cada rota tinha a sua, e o cadastro não tinha nenhuma).
// Exige parte-local, @, domínio com ponto e TLD de 2+ letras: "joao" e "joao@gmail" são recusados.
function isValidEmail(value) {
    const e = String(value || '').trim();
    return e.length <= 254 && /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/.test(e) && !e.includes('..');
}

// Módulo ERP (erp.js). É preenchido na montagem das rotas, no fim deste arquivo; fica null se o módulo não carregar.
let erpService = null;

// Helper para parsear parâmetros no formato: chave1="valor1", chave2="valor2"
function parseAiParams(paramsString) {
    const params = {};
    const regex = /(\w+)\s*=\s*"([^"]*)"/g;
    let match;
    while ((match = regex.exec(paramsString)) !== null) {
        params[match[1]] = match[2];
    }
    return params;
}

// ---- Auxiliares das ações da Cláudia (contatos/agendamentos/anotações) ----
async function resolveSingleContact(companyId, busca) {
    if (!busca || !String(busca).trim()) throw new Error('Diga o nome, CPF ou telefone do contato.');
    const found = await clinicAi.findContacts(pool, companyId, busca);
    if (found.length === 0) throw new Error(`Não encontrei nenhum contato com \"${busca}\".`);
    if (found.length > 1) throw new Error(`Encontrei ${found.length} contatos parecidos (${found.slice(0, 5).map(c => c.name).join(', ')}). Informe o nome completo ou o CPF.`);
    return found[0];
}
async function resolveSingleEvent(companyId, busca, dataAtual) {
    if (!busca || !String(busca).trim()) throw new Error('Diga o título do evento ou o nome do paciente.');
    const found = await clinicAi.findEvents(pool, companyId, busca, dataAtual || null);
    if (found.length === 0) throw new Error(`Não encontrei nenhum evento com \"${busca}\"${dataAtual ? ' em ' + dataAtual.split('-').reverse().join('/') : ''}.`);
    if (found.length > 1) throw new Error(`Encontrei ${found.length} eventos com esse nome (datas: ${found.slice(0, 5).map(e => (e.event_date_str || '').split('-').reverse().join('/')).join(', ')}). Diga também a data atual do evento.`);
    return found[0];
}
async function resolveSingleNote(companyId, titulo) {
    if (!titulo || !String(titulo).trim()) throw new Error('Diga o título da anotação.');
    const found = await clinicAi.findNotes(pool, companyId, titulo);
    if (found.length === 0) throw new Error(`Não encontrei nenhuma anotação com o título \"${titulo}\".`);
    if (found.length > 1) throw new Error(`Encontrei ${found.length} anotações parecidas (${found.slice(0, 5).map(n => n.title).join(', ')}). Informe o título completo.`);
    return found[0];
}
// Editar/apagar anotação: quem escreveu ou Dono/Gerente.
function assertCanChangeNote(note, req) {
    const isAdmin = ['OWNER', 'MANAGER'].includes(req.user.role);
    if (!isAdmin && Number(note.user_id) !== Number(req.user.id)) {
        throw new Error('Só quem escreveu a anotação (ou o Dono/Gerente) pode editar ou apagar.');
    }
}

async function executeAiAction(funcao, rawParams, req) {
    const params = parseAiParams(rawParams);
    const userId = req.user.id;
    const companyId = req.user.companyId;
    const userRole = req.user.role || 'USER';
    const userPlan = req.user.plan_tier || req.user.planTier || 'BASICO';

    if (!companyId) {
        throw new Error('Você não está vinculado a nenhuma empresa. Por favor, entre em uma organização para usar as ações da IA.');
    }

    // Anotações: só Starter e Pro AI (mesma regra das rotas /api/notes)
    if (['criarAnotacao', 'editarAnotacao', 'excluirAnotacao', 'listarAnotacoes'].includes(funcao) && !userCanUseNotes(req)) {
        throw new Error(NOTES_PLAN_MESSAGE);
    }

    console.log(`[AI Action] Executando ${funcao} para Usuário ${userId} (Cargo: ${userRole}, Plano: ${userPlan})`);

    // ERP: só planos Starter/Pro AI e, no Financeiro, só administradores (regras conferidas em erp.js).
    if (erpService && erpService.ai.isAiFunction(funcao)) {
        const message = await erpService.ai.run(funcao, erpService.ai.contextFrom(req), params);
        return { success: true, message };
    }

    try {
        switch (funcao) {
            case 'criarDemanda': {
                // Validação de Plano: verifica limite de demandas com base na contagem real da empresa
                const demandsCountRes = await pool.query('SELECT COUNT(*) as count FROM demands WHERE company_id = $1', [companyId]);
                const currentDemandsCount = parseInt(demandsCountRes.rows[0].count, 10);
                const demandCheck = canCreateDemand(userPlan, currentDemandsCount);
                if (!demandCheck.allowed) {
                    throw new Error(`Seu plano ${userPlan} atingiu o limite de ${demandCheck.limit} demandas. Faça upgrade para continuar.`);
                }
                const { titulo, descricao, prioridade = 'MEDIA', assigned_user_email } = params;
                if (!titulo) throw new Error('Título da demanda é obrigatório.');

                let targetUserId = null;
                let targetName = 'Colaborador';
                if (assigned_user_email) {
                    const userRes = await pool.query('SELECT id, name FROM users WHERE LOWER(email) = $1 AND company_id = $2', [assigned_user_email.toLowerCase(), companyId]);
                    if (userRes.rows.length > 0) {
                        targetUserId = userRes.rows[0].id;
                        targetName = decryptData(userRes.rows[0].name);
                    }
                }

                const result = await pool.query(
                    `INSERT INTO demands (company_id, user_id, title, description, priority, status, assigned_user_id, assigned_user_name, assigned_user_email)
                     VALUES ($1, $2, $3, $4, $5, 'TODO', $6, $7, $8) RETURNING *`,
                    [companyId, userId, titulo, descricao || '', prioridade, targetUserId, targetName, assigned_user_email || null]
                );
                return { success: true, message: `Demanda "${result.rows[0].title}" criada com sucesso!`, data: result.rows[0] };
            }

            case 'mudarStatusDemanda': {
                const { titulo, status } = params;
                if (!titulo) throw new Error('Título da demanda é obrigatório.');
                if (!status) throw new Error('Status é obrigatório (TODO, IN_PROGRESS ou DONE).');

                const validStatuses = ['TODO', 'IN_PROGRESS', 'DONE'];
                if (!validStatuses.includes(status)) {
                    throw new Error('Status inválido. Use: TODO (a fazer), IN_PROGRESS (em andamento) ou DONE (concluído).');
                }

                const result = await pool.query(
                    `UPDATE demands SET status = $1, completed_at = CASE WHEN $1::varchar = 'DONE' THEN CURRENT_TIMESTAMP ELSE NULL END
                     WHERE company_id = $2 AND title = $3 RETURNING *`,
                    [status, companyId, titulo]
                );

                if (result.rows.length === 0) {
                    throw new Error(`Demanda "${titulo}" não encontrada na sua empresa.`);
                }

                broadcastBoard(companyId, 'demand_updated', { demand: result.rows[0], byUserId: userId });
                return { success: true, message: `Status da demanda "${titulo}" alterado para ${status}!`, data: result.rows[0] };
            }

            case 'criarContato': {
                // Validação de Plano: Contatos são limitados por plano
                if (!canUseWarehouse(userPlan, req.user.plan_status)) {
                    throw new Error(`A criação de contatos avançados é exclusiva dos planos Starter e Pro AI.`);
                }
                const { name, phone, email, companyName, role, notes } = params;
                if (!name || !phone) throw new Error('Nome e Telefone são obrigatórios para contatos.');
                if (email && !isValidEmail(email)) throw new Error('O e-mail do contato é inválido.');
                const clinic = clinicAi.sanitizeClinic(params);
                if (clinic.error) throw new Error(clinic.error);

                const result = await pool.query(
                    `INSERT INTO contacts (company_id, name, phone, email, company_name, role, notes, clinic_data)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
                    [companyId, encryptData(name), encryptData(phone), email ? encryptData(email) : '', companyName || '', role || '', notes ? encryptData(notes) : '', clinicAi.pack(clinic.data)]
                );
                const apiContact = clinicAi.contactToApi(result.rows[0]);
                broadcastBoard(companyId, 'crm_contact_created', { contact: apiContact, byUserId: userId });
                const extras = Object.keys(clinic.data).length ? ` (com ${Object.keys(clinic.data).length} dado(s) de paciente)` : '';
                return { success: true, message: `Contato ${name} adicionado ao CRM com sucesso${extras}!`, data: { id: result.rows[0].id } };
            }

            case 'editarContato': {
                const alvo = await resolveSingleContact(companyId, params.busca);
                const sets = []; const vals = [];
                const add = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
                if (params.name) add('name', encryptData(params.name.trim()));
                if (params.phone) add('phone', encryptData(params.phone.trim()));
                if (params.email !== undefined) {
                    if (params.email && !isValidEmail(params.email)) throw new Error('O e-mail informado é inválido.');
                    add('email', params.email ? encryptData(params.email.trim()) : '');
                }
                if (params.companyName !== undefined) add('company_name', params.companyName.trim());
                if (params.role !== undefined) add('role', params.role.trim());
                if (params.notes !== undefined) add('notes', params.notes ? encryptData(params.notes.trim()) : '');
                const clinic = clinicAi.sanitizeClinic(params);
                if (clinic.error) throw new Error(clinic.error);
                if (Object.keys(clinic.data).length) add('clinic_data', clinicAi.pack(clinicAi.mergeFields(alvo.clinic, clinic.data)));
                if (!sets.length) throw new Error('Não entendi o que alterar no contato. Diga o campo e o novo valor (ex.: "o convênio da Maria é Unimed").');
                vals.push(alvo.id, companyId);
                const upd = await pool.query(`UPDATE contacts SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = $${vals.length - 1} AND company_id = $${vals.length} RETURNING *`, vals);
                broadcastBoard(companyId, 'crm_contact_updated', { contact: clinicAi.contactToApi(upd.rows[0]), byUserId: userId });
                return { success: true, message: `Contato **${alvo.name}** atualizado com sucesso!` };
            }

            case 'excluirContato': {
                const alvo = await resolveSingleContact(companyId, params.busca);
                await pool.query('DELETE FROM contacts WHERE id = $1 AND company_id = $2', [alvo.id, companyId]);
                broadcastBoard(companyId, 'crm_contact_deleted', { id: Number(alvo.id), byUserId: userId });
                return { success: true, message: `Contato **${alvo.name}** excluído do CRM.` };
            }

            case 'buscarContato': {
                const alvo = await resolveSingleContact(companyId, params.busca);
                const linhas = [`**${alvo.name}** — ${alvo.phone || 'sem telefone'}${alvo.email ? ' — ' + alvo.email : ''}`];
                for (const [k, v] of Object.entries(alvo.clinic || {})) {
                    linhas.push(`• ${(clinicAi.CLINIC_FIELDS[k] || {}).label || k}: ${v}`);
                }
                if (alvo.notes) linhas.push(`• Observações: ${alvo.notes}`);
                return { success: true, message: linhas.join('\n') };
            }

            case 'criarEvento': {
                const { title, eventDate, eventTime, type, description } = params;
                if (!title || !eventDate) throw new Error('Título e Data do evento são obrigatórios.');
                if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) throw new Error('Data inválida. Use dia/mês/ano, por exemplo 25/10/2026.');

                const patientIn = clinicAi.sanitizePatient(params);
                if (patientIn.error) throw new Error(patientIn.error);
                const isAppointment = type === 'HORARIO_MARCADO' || !!params.clientName;
                let clientName = isAppointment ? (params.clientName || '').trim().slice(0, 150) : null;
                let clientPhone = isAppointment && params.clientPhone ? params.clientPhone.replace(/[^\d+()\-\s]/g, '').trim().slice(0, 30) : null;
                if (isAppointment && !clientName) throw new Error('Informe o nome do paciente/cliente para marcar o horário.');

                // Se o paciente já está no CRM, aproveita os dados dele (telefone, CPF, convênio...) e vincula.
                let patient = patientIn.data;
                if (isAppointment) {
                    const found = await clinicAi.findContacts(pool, companyId, clientName);
                    if (found.length === 1) {
                        const c = found[0];
                        if (!clientPhone) clientPhone = String(c.phone || '').slice(0, 30);
                        patient = { cpf: c.clinic.cpf, nascimento: c.clinic.nascimento, email: c.email || undefined, convenio: c.clinic.convenio, carteirinha: c.clinic.carteirinha, ...patient, contact_id: c.id };
                        Object.keys(patient).forEach(k => (patient[k] === undefined || patient[k] === '') && delete patient[k]);
                    }
                    if (!patient.situacao) patient.situacao = 'AGENDADO';
                }

                const eventQuota = await getEventQuota(companyId, userId);
                if (!eventQuota.allowed) throw new Error(eventLimitMessage(eventQuota.limit));

                const result = await pool.query(
                    `INSERT INTO events (company_id, user_id, title, event_date, event_time, type, description, client_name, client_phone, patient_data)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
                    [companyId, userId, title, eventDate, eventTime || '09:00', isAppointment ? 'HORARIO_MARCADO' : (type || 'REUNIAO'), description || '', clientName, clientPhone, isAppointment ? clinicAi.pack(patient) : null]
                );
                return { success: true, message: `Evento \"${result.rows[0].title}\" agendado para ${eventDate.split('-').reverse().join('/')}${eventTime ? ' às ' + eventTime : ''}!`, data: result.rows[0] };
            }

            case 'editarEvento': {
                const alvo = await resolveSingleEvent(companyId, params.busca, params.dataAtual);
                const sets = []; const vals = [];
                const add = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
                if (params.title) add('title', params.title.trim().slice(0, 255));
                if (params.eventDate) {
                    if (!/^\d{4}-\d{2}-\d{2}$/.test(params.eventDate)) throw new Error('Data inválida. Use dia/mês/ano, por exemplo 25/10/2026.');
                    add('event_date', params.eventDate);
                }
                if (params.eventTime) add('event_time', params.eventTime);
                if (params.description !== undefined) add('description', params.description);
                if (params.clientName) add('client_name', params.clientName.trim().slice(0, 150));
                if (params.clientPhone) add('client_phone', params.clientPhone.replace(/[^\d+()\-\s]/g, '').trim().slice(0, 30));
                const patientIn = clinicAi.sanitizePatient(params);
                if (patientIn.error) throw new Error(patientIn.error);
                if (Object.keys(patientIn.data).length) {
                    add('patient_data', clinicAi.pack(clinicAi.mergeFields(alvo.patient, patientIn.data)));
                    if (alvo.type !== 'HORARIO_MARCADO') add('type', 'HORARIO_MARCADO');
                }
                if (!sets.length) throw new Error('Não entendi o que alterar no agendamento. Diga o campo e o novo valor (ex.: "remarque para dia 28 às 15:00").');
                vals.push(alvo.id, companyId);
                await pool.query(`UPDATE events SET ${sets.join(', ')} WHERE id = $${vals.length - 1} AND company_id = $${vals.length}`, vals);
                return { success: true, message: `Agendamento **\"${alvo.title}\"** atualizado com sucesso!` };
            }

            case 'excluirEvento': {
                const alvo = await resolveSingleEvent(companyId, params.busca, params.dataAtual);
                await pool.query('DELETE FROM events WHERE id = $1 AND company_id = $2', [alvo.id, companyId]);
                return { success: true, message: `Evento **\"${alvo.title}\"** removido do calendário.` };
            }

            case 'criarAnotacao': {
                const titulo = (params.titulo || '').trim();
                if (!titulo) throw new Error('Qual é o título da anotação?');
                const r = await pool.query(
                    `INSERT INTO notes (company_id, user_id, title, content) VALUES ($1, $2, $3, $4) RETURNING id`,
                    [companyId, userId, encryptData(titulo.slice(0, 200)), encryptData((params.conteudo || '').slice(0, 20000))]
                );
                broadcastBoard(companyId, 'note_changed', { id: r.rows[0].id, byUserId: userId });
                return { success: true, message: `📝 Anotação **\"${titulo}\"** salva no Workspace!` };
            }

            case 'editarAnotacao': {
                const alvo = await resolveSingleNote(companyId, params.titulo);
                assertCanChangeNote(alvo, req);
                let conteudo = alvo.content || '';
                if (params.conteudo !== undefined) conteudo = params.conteudo;
                if (params.acrescentar) conteudo = (conteudo ? conteudo + '\n' : '') + params.acrescentar;
                const novoTitulo = (params.novoTitulo || alvo.title).trim().slice(0, 200);
                await pool.query(
                    `UPDATE notes SET title = $1, content = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3 AND company_id = $4`,
                    [encryptData(novoTitulo), encryptData(conteudo.slice(0, 20000)), alvo.id, companyId]
                );
                broadcastBoard(companyId, 'note_changed', { id: alvo.id, byUserId: userId });
                return { success: true, message: `📝 Anotação **\"${novoTitulo}\"** atualizada!` };
            }

            case 'excluirAnotacao': {
                const alvo = await resolveSingleNote(companyId, params.titulo);
                assertCanChangeNote(alvo, req);
                await pool.query('DELETE FROM notes WHERE id = $1 AND company_id = $2', [alvo.id, companyId]);
                broadcastBoard(companyId, 'note_changed', { id: alvo.id, byUserId: userId });
                return { success: true, message: `🗑️ Anotação **\"${alvo.title}\"** apagada.` };
            }

            case 'listarAnotacoes': {
                const lista = await clinicAi.findNotes(pool, companyId, params.busca);
                if (!lista.length) return { success: true, message: params.busca ? `Não encontrei anotações com \"${params.busca}\".` : 'Ainda não há anotações no Workspace.' };
                return { success: true, message: `📝 **Anotações${params.busca ? ' com \"' + params.busca + '\"' : ''}:**\n` + lista.slice(0, 15).map(n => `• ${n.title}`).join('\n') + (lista.length > 15 ? `\n… e mais ${lista.length - 15}.` : '') };
            }

            case 'adicionarMembro': {
                // Validação de Cargo: Apenas Dono ou Gerente podem adicionar membros
                if (!['OWNER', 'MANAGER'].includes(userRole)) {
                    throw new Error('Você não tem permissão administrativa para adicionar membros à empresa.');
                }
                const { email } = params;
                if (!email) throw new Error('O e-mail do funcionário é obrigatório.');
                if (!isValidEmail(email)) throw new Error('O e-mail informado é inválido.');

                const cleanEmail = email.trim().toLowerCase();
                const memberRes = await pool.query('SELECT id, company_id, membership_status FROM users WHERE LOWER(email) = $1', [cleanEmail]);

                if (memberRes.rows.length === 0) {
                    throw new Error('O funcionário precisa estar cadastrado no sistema antes de ser adicionado à empresa.');
                }

                const member = memberRes.rows[0];
                // Defesa contra acesso entre empresas: só pode adicionar quem não tem empresa ou já está na mesma
                if (member.company_id && Number(member.company_id) !== Number(companyId)) {
                    throw new Error('Este usuário já pertence a outra empresa e não pode ser puxado.');
                }

                const memberId = member.id;
                await pool.query('UPDATE users SET company_id = $1, membership_status = $2 WHERE id = $3', [companyId, 'ACTIVE', memberId]);

                return { success: true, message: `Funcionário ${email} adicionado com sucesso à empresa!` };
            }

            case 'criarAutomacao': {
                // Antes a Cláudia não tinha essa ação: o pedido caía em texto solto e nada era gravado.
                const descricao = (params.descricao || params.prompt || '').trim();
                if (descricao.length < 5) throw new Error('Descreva a automação (ex.: "quando uma demanda urgente for criada, me avise por e-mail").');
                let generated;
                let usedFallback = false;
                try {
                    if (!aiModule || !aiModule.gerarAutomacaoComIA) throw new Error('Módulo de IA indisponível.');
                    generated = await aiModule.gerarAutomacaoComIA(descricao);
                } catch (err) {
                    console.warn('[AI Action] gerarAutomacaoComIA falhou, usando heurística:', err.message);
                    generated = heuristicaAutomacaoFallback(descricao);
                    usedFallback = true;
                }
                const ins = await pool.query(
                    `INSERT INTO automations (company_id, name, trigger_event, action_type, action_target, action_payload)
                     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
                    [companyId, generated.name, generated.triggerEvent, generated.actionType, generated.actionTarget, generated.actionPayload || descricao]
                );
                return {
                    success: true,
                    message: `⚙️ Automação "${generated.name}" criada!\n🎯 Gatilho: ${generated.triggerEvent}\n🚀 Ação: ${generated.actionType}${usedFallback ? '\n(criada por palavras-chave, pois a IA não respondeu agora)' : ''}`,
                    data: ins.rows[0]
                };
            }

            case 'aceitarMembroAutomaticamente': {
                // Validação de Cargo: Apenas DONO pode configurar automações de entrada
                if (req.user.companyRole !== 'OWNER') {
                    throw new Error('Apenas o Dono da empresa pode configurar a aceitação automática de membros.');
                }
                const { status } = params;
                if (!status) throw new Error('O status (on ou off) é obrigatório.');

                // Presumindo que existe ou criaremos uma coluna 'auto_accept_members' na tabela companies
                await pool.query('UPDATE companies SET auto_accept_members = $1 WHERE id = $2', [status === 'on', companyId]);

                const statusFormatado = status === 'on' ? 'ativada' : 'desativada';
                return { success: true, message: `A aceitação automática de novos membros foi ${statusFormatado} com sucesso!` };
            }

            case 'mudarTema': {
                const { tema } = params;
                if (!tema) throw new Error('O tema (dark ou light) é obrigatório.');
                await pool.query('UPDATE users SET theme = $1 WHERE id = $2', [tema, userId]);
                const temaFormatado = tema === 'dark' ? 'Tema Escuro' : 'Tema Claro';
                return { success: true, message: `O ${temaFormatado} foi ativado com sucesso!`, theme: tema };
            }
            case 'setModoDaltônico': {
                const { status } = params;
                if (!status) throw new Error('O status do modo daltônico (on ou off) é obrigatório.');
                await pool.query('UPDATE users SET daltonic_mode = $1 WHERE id = $2', [status, userId]);
                const statusFormatado = status === 'on' ? 'ativado' : 'desativado';
                return { success: true, message: `O modo daltônico foi ${statusFormatado} com sucesso!` };
            }
            case 'setTamanhoFonte': {
                const { percentual } = params;
                if (!percentual) throw new Error('A porcentagem da fonte é obrigatória.');
                await pool.query('UPDATE users SET font_size = $1 WHERE id = $2', [percentual, userId]);
                return { success: true, message: `O tamanho da fonte foi alterado para ${percentual} com sucesso!` };
            }
            case 'explicarFuncionalidade': {
                const { setor } = params;
                const guias = {
                    'kanban': 'No Kanban, você organiza suas demandas em colunas (TODO, IN_PROGRESS, DONE). Você pode arrastar tarefas e mudar a prioridade.',
                    'crm': 'O CRM serve para gerenciar seus contatos. Você pode adicionar nomes, telefones e e-mails de clientes para acesso rápido.',
                    'calendario': 'No Calendário, você agenda reuniões e eventos. Use a IA para agendar rapidamente dizendo "marque para amanhã". O plano gratuito aceita até 5 eventos; Starter e Pro AI têm calendário ilimitado. Avisos por e-mail também são a partir do Starter.',
                    'armazem': 'O Armazém é onde ficam os arquivos da empresa. Todos os membros podem baixar arquivos, mas apenas planos Starter/Pro podem fazer upload.'
                };
                const resposta = guias[setor?.toLowerCase()] || 'Esta funcionalidade permite que você gerencie a empresa de forma eficiente. Use a IA para me perguntar sobre setores específicos!';
                return { success: true, message: `📖 Guia do ${setor || 'Sistema'}: ${resposta}` };
            }

            case 'trocarSenha': {
                const { email, novaSenha } = params;
                if (!email || !novaSenha) throw new Error('E-mail e a nova senha são obrigatórios.');

                const cleanEmail = email.trim().toLowerCase();
                const isOwnEmail = cleanEmail === req.user.email.toLowerCase();
                const isAdmin = ['OWNER', 'MANAGER'].includes(userRole);

                if (!isOwnEmail && !isAdmin) {
                    throw new Error('Você não tem permissão para alterar a senha de outro usuário.');
                }

                const hashedPassword = await bcrypt.hash(novaSenha, 10);
                // Fix: exige company_id para evitar tomada de conta entre empresas
                const result = await pool.query('UPDATE users SET password = $1 WHERE LOWER(email) = $2 AND company_id = $3 RETURNING id, name', [hashedPassword, cleanEmail, companyId]);

                if (result.rowCount === 0) throw new Error('Usuário não encontrado.');
                if (result.rows[0].id !== req.user.id) await revokeUserSessions(result.rows[0].id);

                return { success: true, message: `A senha do usuário ${result.rows[0].name} foi atualizada com sucesso!` };
            }

            case 'trocarEmail': {
                const { emailAntigo, novoEmail } = params;
                if (!emailAntigo || !novoEmail) throw new Error('E-mail antigo e novo e-mail são obrigatórios.');

                const cleanOldEmail = emailAntigo.trim().toLowerCase();
                const cleanNewEmail = novoEmail.trim().toLowerCase();
                const isOwnEmail = cleanOldEmail === req.user.email.toLowerCase();
                const isAdmin = ['OWNER', 'MANAGER'].includes(userRole);

                if (isOwnEmail) {
                    throw new Error('Para trocar o seu próprio e-mail é preciso confirmar com um código enviado ao novo endereço. Peça "Trocar meu e-mail" no chat ou use Configurações.');
                }

                if (!isOwnEmail && !isAdmin) {
                    throw new Error('Você não tem permissão para alterar o e-mail de outro usuário.');
                }

                // Fix: exige company_id para evitar tomada de conta entre empresas
                const result = await pool.query('UPDATE users SET email = $1 WHERE LOWER(email) = $2 AND company_id = $3 RETURNING id, name', [cleanNewEmail, cleanOldEmail, companyId]);

                if (result.rowCount === 0) throw new Error('Usuário com o e-mail antigo não foi encontrado.');
                await revokeUserSessions(result.rows[0].id);

                return { success: true, message: `O e-mail do usuário ${result.rows[0].name} foi alterado para ${cleanNewEmail} com sucesso!` };
            }

            case 'setNotificacoes': {
                const { canal, status } = params;
                if (!status) throw new Error('O status (on ou off) é obrigatório.');
                if (!canal) throw new Error('O canal (email, painel ou todos) é obrigatório.');

                const validChannels = ['email', 'painel', 'todos'];
                const validStatuses = ['on', 'off'];

                if (!validChannels.includes(canal)) {
                    throw new Error('Canal inválido. Use: email, painel ou todos.');
                }
                if (!validStatuses.includes(status)) {
                    throw new Error('Status inválido. Use: on ou off.');
                }

                // Validação de plano para notificações por email
                if (canal === 'email' || canal === 'todos') {
                    if (!canUseWarehouse(userPlan, req.user.plan_status)) {
                        throw new Error('Notificações por e-mail são exclusivas dos planos Starter e Pro AI. Use canal="painel" para ativar apenas notificações no painel.');
                    }
                }

                // Atualiza as preferências de notificação do usuário
                const statusBool = status === 'on';

                // Verifica se já existe preferência para o usuário
                const existingPrefs = await pool.query(
                    'SELECT id FROM notification_preferences WHERE user_id = $1',
                    [userId]
                );

                if (existingPrefs.rows.length > 0) {
                    // Atualiza existente
                    if (canal === 'email') {
                        await pool.query(
                            'UPDATE notification_preferences SET email_enabled = $1, updated_at = CURRENT_TIMESTAMP WHERE user_id = $2',
                            [statusBool, userId]
                        );
                    } else if (canal === 'painel') {
                        await pool.query(
                            'UPDATE notification_preferences SET panel_enabled = $1, updated_at = CURRENT_TIMESTAMP WHERE user_id = $2',
                            [statusBool, userId]
                        );
                    } else if (canal === 'todos') {
                        await pool.query(
                            'UPDATE notification_preferences SET email_enabled = $1, panel_enabled = $1, updated_at = CURRENT_TIMESTAMP WHERE user_id = $2',
                            [statusBool, userId]
                        );
                    }
                } else {
                    // Cria nova preferência
                    await pool.query(
                        `INSERT INTO notification_preferences (user_id, email_enabled, panel_enabled)
                         VALUES ($1, $2, $3)`,
                        [userId, canal === 'painel' ? true : statusBool, canal === 'email' ? true : statusBool]
                    );
                }

                const canalFormatado = canal === 'todos' ? 'todos os canais' : canal;
                const statusFormatado = status === 'on' ? 'ativadas' : 'desativadas';

                return { success: true, message: `Notificações por ${canalFormatado} foram ${statusFormatado} com sucesso!` };
            }

            default:
                throw new Error(`A função ${funcao} não está implementada no servidor.`);
        }
    } catch (error) {
        console.error(`[AI Action Error] Erro ao executar ${funcao}:`, error.message);
        throw error;
    }
}

const app = express();
const server = http.createServer(app);

// Origens que podem chamar a API/socket a partir do navegador. ALLOWED_ORIGINS aceita uma
// lista separada por vírgula para múltiplos domínios/ambientes.
// IMPORTANTE: mesmo uma chamada do PRÓPRIO front (fetch de index.html pro seu próprio
// domínio) manda o cabeçalho Origin em requisições POST/PUT/DELETE com corpo — não é só
// "outro site" que passa por essa checagem. Por isso incluímos automaticamente
// RENDER_EXTERNAL_URL (variável que o Render injeta sozinho com a URL pública do serviço,
// ex: https://kl-web.onrender.com), senão o próprio login do site quebra com erro de CORS
// assim que ele roda fora do domínio digitado manualmente em ALLOWED_ORIGINS/BASE_URL.
const allowedOrigins = [
    ...(process.env.ALLOWED_ORIGINS || process.env.BASE_URL || 'https://klweb.com.br')
        .split(',')
        .map(o => o.trim())
        .filter(Boolean),
    process.env.RENDER_EXTERNAL_URL
]
    .filter(Boolean)
    .map(o => o.replace(/\/+$/, '')); // remove barra final (Origin nunca vem com ela)

function isOriginAllowed(origin) {
    // Sem cabeçalho Origin: não é uma chamada de navegador cross-site (apps mobile, curl,
    // Postman, chamadas servidor-a-servidor) — o CORS do navegador não existe nesse caso.
    if (!origin) return true;
    if (allowedOrigins.includes(origin.replace(/\/+$/, ''))) return true;
    // Qualquer porta em localhost/127.0.0.1, só para facilitar o desenvolvimento local.
    return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

const io = new Server(server, {
    cors: {
        origin: (origin, callback) => {
            if (isOriginAllowed(origin)) return callback(null, true);
            callback(new Error('Origem não permitida pelo CORS.'));
        },
        methods: ['GET', 'POST']
    }
});
const PORT = process.env.PORT || 3000;

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
    console.error('❌ ERRO CRÍTICO: JWT_SECRET não definida no ambiente! Todos os logins seriam invalidados a cada reinício.');
    process.exit(1);
}
const OWNER_EMAIL = process.env.OWNER_EMAIL;
if (!OWNER_EMAIL) {
    console.error('❌ ERRO CRÍTICO: OWNER_EMAIL não definida no ambiente!');
    process.exit(1);
}

function isPlatformOwner(req) {
    return req.user.role === 'OWNER' ||
        !!(req.user.email && req.user.email.toLowerCase() === OWNER_EMAIL.toLowerCase());
}

// Anotações: exclusivas dos planos Starter e Pro AI (o dono da plataforma sempre passa).
// Plano INATIVO conta como Gratuito (ver effectiveTier em planLimits.js).
const NOTES_PLAN_MESSAGE = 'As Anotações são exclusivas dos planos Starter e Pro AI. Faça upgrade na aba Planos & Assinatura para liberar esse recurso.';
function userCanUseNotes(req) {
    return isPlatformOwner(req) || canUseNotes(req.user.plan_tier, req.user.plan_status);
}
function requireNotesPlan(req, res, next) {
    if (userCanUseNotes(req)) return next();
    return res.status(403).json({ code: 'PLAN_NOTES_REQUIRED', message: NOTES_PLAN_MESSAGE });
}

// authenticateToken já revalida plan_tier/plan_status no banco a cada requisição.
function getUserPlanLimits(req) {
    return isPlatformOwner(req) ? getPlanLimits('OWNER') : getPlanLimits(req.user.plan_tier, req.user.plan_status);
}

function formatBytes(bytes) {
    const gb = 1024 * 1024 * 1024;
    const mb = 1024 * 1024;
    if (bytes >= gb) return `${(bytes / gb).toFixed(bytes % gb === 0 ? 0 : 1)} GB`;
    return `${Math.round(bytes / mb)} MB`;
}

// Soma dos arquivos da empresa (ou do próprio usuário, se não tiver empresa).
async function getStorageUsage(db, companyId, userId) {
    const r = await db.query(
        `SELECT COALESCE(SUM(file_size), 0) AS total_size FROM files WHERE (company_id = $1 AND $1 IS NOT NULL) OR user_id = $2`,
        [companyId || null, userId || null]
    );
    return Number(r.rows[0].total_size) || 0;
}

function removeUploadedFile(file) {
    if (file && file.path) fs.unlink(file.path, () => { /* melhor esforço */ });
}

// Bloqueia apenas NOVOS uploads (POST). Leitura, download e exclusão continuam liberados
// mesmo com plano vencido/cancelado, para o cliente ainda acessar e apagar o que já enviou.
async function middlewareArmazem(req, res, next) {
    if (req.method !== 'POST') return next();

    try {
        const limits = getUserPlanLimits(req);

        if (!limits.warehouseAllowed) {
            return res.status(403).json({
                message: 'O envio de novos arquivos é exclusivo dos planos Starter e Pro AI ativos. Seus arquivos atuais continuam disponíveis para visualizar e baixar.',
                upgradeRequired: true
            });
        }

        // Os arquivos novos do Armazém vão para o Supabase Storage. Sem ele configurado, nem aceita o upload.
        if (!supabase) {
            return res.status(503).json({ message: 'O armazenamento em nuvem não está configurado no servidor. Fale com o suporte.' });
        }

        // Pré-checagem ANTES de gravar em disco (Content-Length inclui ~1 KB de cabeçalhos multipart).
        // A checagem definitiva, com o tamanho real do arquivo, é feita em insertFileWithQuota().
        const usage = await getStorageUsage(pool, req.user.companyId, req.user.id);
        const incoming = Math.max(0, (Number(req.headers['content-length']) || 0) - 1024);
        if (usage >= limits.storageBytes || usage + incoming > limits.storageBytes) {
            return res.status(413).json({
                message: `Limite de armazenamento do plano atingido (${formatBytes(usage)} de ${formatBytes(limits.storageBytes)}). Apague arquivos ou faça upgrade.`,
                upgradeRequired: true
            });
        }

        next();
    } catch (err) {
        console.error('Erro ao validar plano para upload:', err.message);
        res.status(500).json({ message: 'Erro ao validar o seu plano. Tente novamente.' });
    }
}

// Grava o arquivo no Supabase Storage + o registro no banco, respeitando a cota, em transação com lock
// por empresa (dois uploads simultâneos não passam juntos do limite). O multer só usa o disco como
// área temporária: a cópia local é sempre apagada. Se algo falhar depois do envio, o objeto na nuvem é removido.
async function insertFileWithQuota(req) {
    const file = req.file;
    const companyId = req.user.companyId || req.user.company_id || null;
    const userId = req.user.id;
    const limit = getUserPlanLimits(req).storageBytes;

    if (!supabase) {
        removeUploadedFile(file);
        return { ok: false, status: 503, message: 'O armazenamento em nuvem não está configurado no servidor. Fale com o suporte.' };
    }

    const client = await pool.connect();
    let storageKey = null;
    try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',
            [companyId ? `files:company:${companyId}` : `files:user:${userId}`]);

        const usage = await getStorageUsage(client, companyId, userId);
        if (usage + file.size > limit) {
            await client.query('ROLLBACK');
            removeUploadedFile(file);
            return {
                ok: false,
                status: 413,
                message: `Este arquivo ultrapassa o limite de armazenamento do plano (${formatBytes(usage)} de ${formatBytes(limit)} em uso). Apague arquivos ou faça upgrade.`
            };
        }

        // Nome do objeto = nome aleatório gerado pelo multer (só números + extensão), seguro para a chave do Storage.
        const key = `arquivos/${companyId || `u${userId}`}/${file.filename}`;
        const buffer = await fs.promises.readFile(file.path);
        const { error: upError } = await supabase.storage
            .from(FILES_BUCKET)
            .upload(key, buffer, { contentType: file.mimetype || 'application/octet-stream', upsert: false });
        removeUploadedFile(file);

        if (upError) {
            console.error('Erro ao enviar arquivo do Armazém para o Supabase:', upError.message || upError);
            await client.query('ROLLBACK');
            return { ok: false, status: 502, message: 'Não foi possível enviar o arquivo para o armazenamento em nuvem. Tente novamente.' };
        }
        storageKey = key;

        const result = await client.query(
            `INSERT INTO files (company_id, user_id, filename, original_name, file_path, file_size, mime_type)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
            [companyId, userId, file.filename, file.originalname, SUPABASE_PATH_PREFIX + key, file.size, file.mimetype]
        );
        await client.query('COMMIT');
        return { ok: true, row: result.rows[0] };
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch (e) { /* ignora */ }
        removeUploadedFile(file);
        if (storageKey) {
            supabase.storage.from(FILES_BUCKET).remove([storageKey]).catch(() => { /* melhor esforço */ });
        }
        throw err;
    } finally {
        client.release();
    }
}

// Supabase Storage (anexos de demandas). Opcional: sem as variáveis de ambiente, fica null e as
// rotas respondem com erro claro em vez de quebrar o servidor.
let supabase = null;
try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
        || process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY;
    if (supabaseUrl && supabaseKey) {
        const { createClient } = require('@supabase/supabase-js');
        supabase = createClient(supabaseUrl, supabaseKey);
    }
} catch (e) {
    console.warn('⚠️ Supabase Storage indisponível:', e.message);
}

// Bucket onde ficam os arquivos do Armazém (e os anexos de demandas). Pode trocar pela variável SUPABASE_FILES_BUCKET.
const FILES_BUCKET = process.env.SUPABASE_FILES_BUCKET || 'armazem';
// Em files.file_path, arquivos novos ficam como "supabase:<caminho no bucket>". Os antigos (caminho em disco) continuam funcionando.
const SUPABASE_PATH_PREFIX = 'supabase:';

// Push (Firebase). Opcional: se o módulo ou a credencial não existirem, o push é simplesmente ignorado.
let pushService = null;
try {
    pushService = require('./push_service');
} catch (e) {
    console.warn('⚠️ push_service indisponível:', e.message);
}

// Configuração do Multer para upload de arquivos
// Em produção no Render, aponte PERSISTENT_DISK_PATH para o Disk montado para os arquivos sobreviverem a deploys.
const uploadDir = process.env.PERSISTENT_DISK_PATH
    ? path.resolve(process.env.PERSISTENT_DISK_PATH)
    : path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
    // Usa o mesmo uploadDir que é servido em app.use('/uploads', ...)
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 100 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        // Extensões permitidas
        const allowedTypes = /\.(jpeg|jpg|png|gif|webp|pdf|doc|docx|txt|zip|xls|xlsx|csv|ppt|pptx)$/i;

        // Valida extensão e mimetype do arquivo
        const extname = allowedTypes.test(file.originalname);
        // O mimetype é informado pelo cliente e não é confiável sozinho; a extensão é a checagem que importa.
        const mimetype = true;

        if (extname && mimetype) {
            return cb(null, true);
        } else {
            return cb(new Error('Tipo de arquivo não suportado!'));
        }
    }
});

const uploadMiddleware = upload.single('file');

app.post('/api/armazem/upload', authenticateToken, requireCompany, middlewareArmazem, upload.single('arquivo'), validateFileUpload, async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ message: 'Nenhum arquivo enviado.' });
    }

    try {
        const saved = await insertFileWithQuota(req);
        if (!saved.ok) {
            return res.status(saved.status).json({ message: saved.message, upgradeRequired: true });
        }

        res.json({
            success: true,
            message: 'Arquivo enviado com sucesso para o Armazém!',
            file: saved.row,
            fileId: saved.row.id,
        });
    } catch (err) {
        console.error('Erro ao salvar arquivo no banco:', err.message);
        res.status(500).json({ message: 'Erro ao salvar informações do arquivo no banco de dados.' });
    }
});

const mpAccessToken = (process.env.MERCADOPAGO_ACCESS_TOKEN || process.env.MP_ACCESS_TOKEN || '').trim();

app.set('trust proxy', 1);

let mpClient = null;
if (mpAccessToken) {
    mpClient = new MercadoPagoConfig({
        accessToken: mpAccessToken
    });
    console.log(`💳 Mercado Pago configurado. Modo: ${mpAccessToken.startsWith('APP_USR') ? 'PRODUÇÃO' : 'TESTE/SANDBOX'}`);
} else {
    console.warn('⚠️ Alerta: MERCADOPAGO_ACCESS_TOKEN não foi encontrado no arquivo .env');
}

app.use((req, res, next) => {
    // Fix: usa req.path para não logar ?token= e outros segredos da query
    console.log(`[REQUEST RECEIVED] ${req.method} ${req.path}`);
    next();
});
app.use(cors({
    origin: (origin, callback) => {
        if (isOriginAllowed(origin)) return callback(null, true);
        callback(new Error('Origem não permitida pelo CORS.'));
    }
}));

// ================= MIDDLEWARES DE SEGURANÇA =================
// Headers de segurança
app.use(setSecurityHeaders);

// Verificação de origem da requisição
app.use(verifyRequestOrigin);

// Sanitização e verificação de segurança
app.use(securityCheck);

// Validação de dados sensíveis em respostas
app.use(validateSensitiveData);
// Uploads de arquivo passam pelo multer (multipart, limite próprio de 100 MB), não por aqui.
// Nenhuma rota espera JSON grande, então 25 MB por requisição em TODA a API só servia para
// deixar mais fácil derrubar o servidor mandando corpos gigantes repetidamente.
// Endereço oficial do site para o Google e para os usuários. Quando CANONICAL_HOST estiver definido
// (ex.: CANONICAL_HOST=klweb.com.br), quem abrir a PÁGINA pelo endereço *.onrender.com é levado ao domínio próprio
// com redirecionamento permanente (301). Só páginas HTML: a API, o socket e os uploads continuam funcionando
// no onrender.com, porque o front hospedado em klweb.com.br chama o backend por lá.
app.use((req, res, next) => {
    const canonicalHost = (process.env.CANONICAL_HOST || '').trim().toLowerCase();
    if (!canonicalHost || !['GET', 'HEAD'].includes(req.method)) return next();
    const host = String(req.hostname || '').toLowerCase();
    if (!host.endsWith('.onrender.com')) return next();
    const p = req.path || '/';
    if (p.startsWith('/api') || p.startsWith('/socket.io') || p.startsWith('/uploads') || p.startsWith('/googled')) return next();
    if (!String(req.headers.accept || '').includes('text/html')) return next();
    return res.redirect(301, `https://${canonicalHost}${req.originalUrl}`);
});

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ limit: '2mb', extended: true }));

function getParsedConnectionString(url) {
    if (!url) {
        throw new Error('DATABASE_URL não configurada. Defina a URL do PostgreSQL do Supabase no ambiente do Render.');
    }

    const safeUrl = url.replace(/#/g, '%23');
    const parsedUrl = new URL(safeUrl);
    const config = parsePgUrl(safeUrl);

    config.host = parsedUrl.hostname;
    config.port = Number(parsedUrl.port) || 5432;
    config.user = decodeURIComponent(parsedUrl.username);
    config.password = decodeURIComponent(parsedUrl.password);
    config.database = decodeURIComponent(parsedUrl.pathname.replace(/^\//, '')) || 'postgres';
    // Fix TLS: Supabase pooler usa cert self-signed na cadeia, precisa de tratamento especial
    const dbCa = process.env.DB_CA || process.env.DB_CERT || null;
    const isPooler = parsedUrl.hostname.includes('pooler.supabase.com') || safeUrl.includes('pgbouncer=true');

    if (dbCa) {
        config.ssl = { ca: dbCa.replace(/\\n/g, '\n'), rejectUnauthorized: true };
        console.log('🔒 SSL com CA customizado (DB_CA)');
    } else if (isPooler) {
        // Pooler do Supabase: o certificado da cadeia é self-signed, rejectUnauthorized true quebra
        // Solução oficial do Supabase: usar sslmode=require = rejectUnauthorized false no pooler
        config.ssl = { rejectUnauthorized: false };
        console.log('🔓 SSL pooler: rejectUnauthorized false (padrão oficial Supabase pooler)');
    } else {
        config.ssl = { rejectUnauthorized: true };
        console.log('🔒 SSL com verificação padrão');
    }
    return config;
}

const pool = new Pool(getParsedConnectionString(process.env.DATABASE_URL));

pool.connect((err, client, release) => {
    if (err) {
        console.error('❌ Erro ao conectar ao PostgreSQL:', err.stack);
    } else {
        console.log('⚡ [BANCO DE DADOS] Conectado ao PostgreSQL (Supabase) com sucesso!');
        initPgTables(client);
        release();
    }
});

// Cabecalhos de seguranca (HSTS, COOP, X-Frame-Options, CSP...).
// IMPORTANTE: ficam ANTES das rotas de HTML e do express.static. Antes o helmet era registrado
// depois delas, entao index.html, style.css e app.js saiam SEM nenhum desses cabecalhos.
const compression = require('compression');
app.use(compression());
const helmet = require('helmet');
app.use(helmet({
    contentSecurityPolicy: {
        useDefaults: false,
        // CSP_REPORT_ONLY=true so reporta violacoes no console do navegador, sem bloquear nada.
        reportOnly: process.env.CSP_REPORT_ONLY === 'true',
        directives: {
            defaultSrc: ["'self'"],
            // 'unsafe-inline' e necessario hoje por causa dos onclick="..." e scripts inline do index.html.
            // Quando os handlers migrarem para addEventListener, da para remover.
            scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdnjs.cloudflare.com', 'https://cdn.jsdelivr.net', 'https://cdn.socket.io'],
            scriptSrcAttr: ["'unsafe-inline'"],
            styleSrc: ["'self'", "'unsafe-inline'", 'https://cdnjs.cloudflare.com', 'https://fonts.googleapis.com'],
            fontSrc: ["'self'", 'data:', 'https://cdnjs.cloudflare.com', 'https://fonts.gstatic.com'],
            imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
            connectSrc: ["'self'", 'ws:', 'wss:'],
            frameSrc: ["'self'", 'blob:'],
            objectSrc: ["'self'"],
            baseUri: ["'self'"],
            formAction: ["'self'"],
            frameAncestors: ["'none'"]
        }
    },
    // Permite que o checkout do Mercado Pago (window.open) continue funcionando.
    crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' }
}));

// Verificação de propriedade do Google Search Console (arquivo HTML).
// Rota própria: funciona mesmo que o arquivo físico não esteja na pasta publicada pelo Render.
// Não remova: o Google confere esse endereço periodicamente.
// Verificação de propriedade do Google Search Console (necessário para o domínio do backend)
// robots.txt e sitemap.xml servidos direto pelo servidor (não dependem de onde os arquivos estáticos ficam).
// O sitemap sempre lista o endereço oficial (klweb.com.br), que é o que o Google deve indexar.
const SITE_URL = (process.env.SITE_URL || 'https://klweb.com.br').replace(/\/+$/, '');
// ads.txt do Google AdSense: autoriza o Google a vender os anuncios deste site (precisa responder em /ads.txt, na raiz).
// O codigo do editor (pub-...) e o mesmo do script do AdSense no index.html. Pode ser trocado por ADSENSE_PUB_ID no ambiente.
const ADSENSE_PUB_ID = (process.env.ADSENSE_PUB_ID || 'pub-7215846315995588').replace(/^ca-/, '');
app.get('/ads.txt', (req, res) => {
    res.type('text/plain').set('Cache-Control', 'public, max-age=3600').send(`google.com, ${ADSENSE_PUB_ID}, DIRECT, f08c47fec0942fa0\n`);
});
app.get('/robots.txt', (req, res) => {
    res.type('text/plain').send(
        `User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /reset-password.html\n\nSitemap: ${SITE_URL}/sitemap.xml\n`
    );
});
app.get('/sitemap.xml', (req, res) => {
    res.type('application/xml').send(
        `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
        `  <url>\n    <loc>${SITE_URL}/</loc>\n    <lastmod>2026-10-14</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>1.0</priority>\n  </url>\n` +
        `  <url>\n    <loc>${SITE_URL}/blog.html</loc>\n    <lastmod>2026-10-14</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.8</priority>\n  </url>\n` +
        `  <url>\n    <loc>${SITE_URL}/alternativa-ao-trello.html</loc>\n    <lastmod>2026-10-16</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>0.8</priority>\n  </url>\n` +
        `  <url>\n    <loc>${SITE_URL}/tutorial.html</loc>\n    <lastmod>2026-10-15</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>0.7</priority>\n  </url>\n` +
        `</urlset>\n`
    );
});

app.get('/googled0d1e7ce229fc096.html', (req, res) => {
    res.type('text/html').send('google-site-verification: googled0d1e7ce229fc096.html');
});

// Rota de health check para o Render
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ==================== APP ANDROID (APK) ====================
// O APK fica no Supabase Storage (bucket público), em app/klweb.apk. Para usar outro lugar (ex.: GitHub Releases),
// defina ANDROID_APK_URL. Para mudar o caminho dentro do bucket, defina ANDROID_APK_PATH.
const ANDROID_APK_PATH = process.env.ANDROID_APK_PATH || 'app/klweb.apk';
let apkCache = { at: 0, value: null };

function getAndroidApkUrl() {
    if (process.env.ANDROID_APK_URL) return process.env.ANDROID_APK_URL;
    if (!supabase) return null;
    return supabase.storage.from(FILES_BUCKET).getPublicUrl(ANDROID_APK_PATH, { download: 'KL-Web.apk' }).data.publicUrl;
}

// Confere (com cache de 60 s) se o APK existe de verdade e qual o tamanho.
async function getAndroidApkInfo() {
    if (Date.now() - apkCache.at < 60 * 1000 && apkCache.value) return apkCache.value;
    let info = { available: false };
    const url = getAndroidApkUrl();
    if (url) {
        try {
            const r = await fetch(url, { method: 'HEAD', redirect: 'follow' });
            const type = String(r.headers.get('content-type') || '');
            if (r.ok && !type.includes('json') && !type.includes('html')) {
                const size = Number(r.headers.get('content-length')) || null;
                info = { available: true, sizeBytes: size, updatedAt: r.headers.get('last-modified') || null };
            }
        } catch (e) {
            console.warn('Não foi possível conferir o APK:', e.message);
        }
    }
    apkCache = { at: Date.now(), value: info };
    return info;
}

app.get('/api/app/android/info', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(await getAndroidApkInfo());
});

app.get('/api/app/android', async (req, res) => {
    const info = await getAndroidApkInfo();
    const url = getAndroidApkUrl();
    if (!info.available || !url) {
        return res.status(404).type('text/plain; charset=utf-8').send('O APK do Android ainda não foi publicado. Tente novamente mais tarde.');
    }
    res.redirect(302, url);
});
// Antes os arquivos ficavam expostos por URL direta, sem login nem checagem de empresa/plano.
// Agora é preciso estar logado E o arquivo precisa pertencer à sua empresa (ou a você).
app.use('/uploads', authenticateToken, async (req, res, next) => {
    try {
        const filename = path.basename(req.path);
        const { rows } = await pool.query(
            'SELECT company_id, user_id FROM files WHERE filename = $1',
            [filename]
        );
        const file = rows[0];
        if (!file) return res.status(404).json({ message: 'Arquivo não encontrado.' });

        const userCompanyId = req.user.companyId || req.user.company_id;
        const sameCompany = file.company_id && userCompanyId && Number(file.company_id) === Number(userCompanyId);
        const isPlatformOwner = req.user.isSiteOwner;
        if (!sameCompany && !isPlatformOwner) {
            return res.status(403).json({ message: 'Acesso negado a este arquivo corporativo.' });
        }
        next();
    } catch (err) {
        console.error('Erro ao validar acesso a /uploads:', err.message);
        res.status(500).json({ message: 'Erro ao validar acesso ao arquivo.' });
    }
}, express.static(uploadDir));

const rateLimit = require('express-rate-limit');

const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: { error: 'Muitas requisições vindas deste IP. Tente novamente em 15 minutos.' }
});
app.use(globalLimiter);

// Rate limiter avançado para autenticação (mais restritivo)
const advancedAuthLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: { message: 'Muitas tentativas de autenticação. Tente novamente em 15 minutos.' },
    skip: (req) => {
        const trustedIPs = process.env.TRUSTED_IPS ? process.env.TRUSTED_IPS.split(',') : [];
        const ip = req.ip || req.connection.remoteAddress;
        return trustedIPs.includes(ip);
    },
    standardHeaders: true,
    legacyHeaders: false,
});

// Rate limiter para rotas admin
const adminLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: { message: 'Muitas tentativas de acesso administrativo. Tente novamente em 15 minutos.' },
    standardHeaders: true,
    legacyHeaders: false,
});

app.use('/api/auth/login', advancedAuthLimiter);
app.use('/api/auth/register', advancedAuthLimiter);

const verifyEmailLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: { message: 'Muitas tentativas. Tente novamente em alguns minutos.' }
});
const resendVerificationLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 6,
    message: { message: 'Muitos pedidos de código. Tente novamente em alguns minutos.' }
});
app.use('/api/auth/verify-email', verifyEmailLimiter);
app.use('/api/auth/resend-verification', resendVerificationLimiter);

const initDb = async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255),
                email VARCHAR(255) UNIQUE NOT NULL,
                cpf VARCHAR(14),
                phone VARCHAR(20),
                password VARCHAR(255),
                role VARCHAR(50) DEFAULT 'USER',
                is_active INTEGER DEFAULT 1,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                theme VARCHAR(20) DEFAULT 'light',
                font_size VARCHAR(20) DEFAULT '100%',
                daltonic_mode VARCHAR(10) DEFAULT 'off'
            );
        `);

        // Garante que as colunas existam em instalações antigas
        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS theme VARCHAR(20) DEFAULT 'light'`);
        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS font_size VARCHAR(20) DEFAULT '100%'`);
        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS daltonic_mode VARCHAR(10) DEFAULT 'off'`);
        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS fcm_token TEXT`);

        console.log('✅ Tabelas e Colunas de Preferências verificadas no PostgreSQL!');
    } catch (err) {
        console.error('❌ Erro ao inicializar banco PostgreSQL:', err.message);
    }
};

// ---------- Revogação de sessões ----------
// Cada JWT leva `tv` (token_version do usuário). Incrementar token_version no banco invalida
// TODOS os tokens já emitidos (qualquer aparelho). Usado quando o e-mail da conta muda.
async function revokeUserSessions(userId, db = pool) {
    const r = await db.query(
        'UPDATE users SET token_version = COALESCE(token_version, 0) + 1 WHERE id = $1 RETURNING token_version',
        [userId]
    );
    disconnectUserSockets(userId);
    return r.rows[0] ? Number(r.rows[0].token_version) : null;
}

function disconnectUserSockets(userId) {
    try {
        for (const [, sock] of io.sockets.sockets) {
            if (sock.user && Number(sock.user.id) === Number(userId)) sock.disconnect(true);
        }
    } catch (e) {
        console.error('Erro ao desconectar sockets do usuário:', e.message);
    }
}

// Lógica do Socket.io para Chat em Tempo Real
// Autentica a conexão do socket com o MESMO JWT usado pela API (enviado em `auth.token` pelo cliente).
// Sem isso, qualquer pessoa sem login podia entrar em qualquer sala de chat e mandar mensagem
// se passando por "Suporte" — e essa era a ÚNICA via que de fato gravava mensagens no banco
// (a rota REST equivalente nunca chegou a inserir nada, ver /api/support/chats/:id/messages).
io.use(async (socket, next) => {
    try {
        const token = socket.handshake.auth?.token;
        if (!token) return next(new Error('unauthorized'));
        const decoded = jwt.verify(token, JWT_SECRET);
        const userId = decoded.id || decoded.userId;
        const result = await pool.query(
            'SELECT role, site_role, is_active, membership_status, name, email, company_id, token_version FROM users WHERE id = $1',
            [userId]
        );
        const user = result.rows[0];
        if (!user) return next(new Error('unauthorized'));
        if (Number(decoded.tv || 0) !== Number(user.token_version || 0)) return next(new Error('unauthorized'));
        if (user.is_active === 0 || user.is_active === false) return next(new Error('unauthorized'));
        if (user.membership_status === 'PENDING') return next(new Error('unauthorized'));
        const isOwner = user.email?.toLowerCase() === OWNER_EMAIL.toLowerCase();
        socket.user = {
            id: userId,
            role: isOwner ? 'OWNER' : user.role,
            isSiteStaff: !!isOwner || user.role === 'ADMIN' || user.site_role === 'SITE_MANAGER',
            name: user.name,
            companyId: user.company_id
        };
        next();
    } catch (err) {
        next(new Error('unauthorized'));
    }
});

// Confere se o usuário do socket pode participar deste chat (dono do chat, ou OWNER/ADMIN).
async function canAccessSupportChat(user, chatId) {
    if (user.isSiteStaff) return true;
    const r = await pool.query('SELECT user_id FROM support_chats WHERE id = $1', [chatId]);
    return r.rows.length > 0 && r.rows[0].user_id === user.id;
}

io.on('connection', (socket) => {
    console.log(`🔌 Novo cliente conectado: ${socket.id} (usuário ${socket.user.id})`);

    // Sala do board da empresa: todo mundo logado entra automaticamente na sala da própria
    // empresa (o companyId já vem verificado do JWT, não tem o que o cliente escolher aqui).
    // É por essa sala que board_demand_created/updated/deleted/reordered chegam em tempo real.
    if (socket.user.companyId) {
        socket.join(`company_${socket.user.companyId}`);
    }

    socket.on('join_chat', async (chatId) => {
        if (!(await canAccessSupportChat(socket.user, chatId))) {
            return socket.emit('error', 'Acesso negado a este chat.');
        }
        socket.join(`chat_${chatId}`);
        console.log(`👥 Cliente ${socket.id} entrou no chat ${chatId}`);
    });

    socket.on('send_message', async (data) => {
        const { chatId, message } = data;
        try {
            if (!(await canAccessSupportChat(socket.user, chatId))) {
                return socket.emit('error', 'Acesso negado a este chat.');
            }
            if (typeof message !== 'string' || !message.trim() || message.length > 4000) {
                return socket.emit('error', 'Mensagem inválida.');
            }

            // senderType e senderId vêm do TOKEN do socket, nunca do que o cliente mandou no payload —
            // é isso que impedia (ou não) alguém de se passar por "Suporte".
            const senderId = socket.user.id;
            const senderType = socket.user.isSiteStaff ? 'SUPPORT' : 'USER';
            const userName = socket.user.name;

            await pool.query(
                'INSERT INTO support_messages (chat_id, sender_id, sender_type, message) VALUES ($1, $2, $3, $4)',
                [chatId, senderId, senderType, message]
            );
            if (senderType === 'USER') {
                await pool.query('UPDATE support_chats SET is_unread = 1 WHERE id = $1', [chatId]);
            }

            io.to(`chat_${chatId}`).emit('receive_message', {
                senderId,
                senderType,
                message,
                userName,
                timestamp: new Date()
            });
        } catch (err) {
            console.error('❌ Erro ao processar send_message:', err.message);
            socket.emit('error', 'Erro ao enviar mensagem.');
        }
    });

    socket.on('typing', async (data) => {
        const { chatId, isTyping } = data;
        if (!(await canAccessSupportChat(socket.user, chatId))) return;
        const room = `chat_${chatId}`;
        const payload = { chatId, userId: socket.user.id, userName: socket.user.name };
        if (isTyping) {
            socket.to(room).emit('user_typing', { ...payload, isTyping: true });
        } else {
            socket.to(room).emit('user_stop_typing', payload);
        }
    });

    socket.on('disconnect', () => {
        console.log(`🔌 Cliente desconectado: ${socket.id}`);
    });
});

// Notifica em tempo real todo mundo logado na mesma empresa sobre uma mudança no board
// (criação, arraste/reordenação, atualização de status ou exclusão de demanda) — usado pelas
// rotas REST de /api/demands abaixo, não por um evento de socket recebido do cliente.
function broadcastBoard(companyId, event, payload) {
    if (!companyId) return;
    io.to(`company_${companyId}`).emit(event, payload);
}

app.post('/api/ai/process', authenticateToken, requireCompany, async (req, res) => {
    try {
        const { mensagem, contexto } = req.body;
        if (!mensagem) {
            return res.status(400).json({ error: 'Mensagem é obrigatória.' });
        }

        const isOwnerUser = req.user.role === 'OWNER' || (req.user.email && req.user.email.toLowerCase() === OWNER_EMAIL.toLowerCase());
        if (!isOwnerUser && !canUseAI(req.user.plan_tier, req.user.plan_status)) {
            return res.status(403).json({
                tipo: 'RESPOSTA_TEXTO',
                texto: 'O Assistente de IA Autônoma é exclusivo dos planos Starter e Pro AI. Faça upgrade na aba Planos & Assinatura para liberar esse recurso.'
            });
        }

        // Limite diário de uso da IA por plano (Starter: 50/dia, Pro AI: 300/dia). O dono da
        // plataforma não tem limite. UPDATE atômico: zera o contador se o dia mudou e só
        // incrementa se ainda houver saldo, tudo em uma única ida ao banco — evita que duas
        // requisições simultâneas do mesmo usuário furem o limite (condição de corrida).
        if (!isOwnerUser) {
            const dailyLimit = getPlanLimits(req.user.plan_tier, req.user.plan_status).aiDailyLimit;
            const usageResult = await pool.query(
                `UPDATE users
                 SET ai_usage_count = CASE WHEN ai_usage_date = CURRENT_DATE THEN ai_usage_count + 1 ELSE 1 END,
                     ai_usage_date = CURRENT_DATE
                 WHERE id = $1
                   AND (ai_usage_date IS DISTINCT FROM CURRENT_DATE OR ai_usage_count < $2)
                 RETURNING ai_usage_count`,
                [req.user.id, dailyLimit]
            );
            if (usageResult.rowCount === 0) {
                return res.status(429).json({
                    tipo: 'RESPOSTA_TEXTO',
                    texto: `Você atingiu o limite de ${dailyLimit} mensagens da Cláudia hoje. O limite é renovado à meia-noite (horário do servidor).`
                });
            }
        }

        if (!process.env.GROQ_API_KEY) {
            console.error('❌ GROQ_API_KEY não configurada no ambiente!');
            return res.status(500).json({
                tipo: 'RESPOSTA_TEXTO',
                texto: 'Desculpe, a chave de API da IA não está configurada no servidor. Entre em contato com o suporte.'
            });
        }

        // O contexto pode vir do cliente, mas vamos enriquecer com os dados do token para segurança
        let calendario = null;
        let emailNotificacoes = false;
        try {
            const quota = await getEventQuota(req.user.companyId, req.user.id);
            calendario = { usados: quota.current, limite: quota.limit };
            emailNotificacoes = canUseEmailNotifications(quota.tier);
        } catch (e) { /* contexto opcional para a IA */ }
        const contextoEnriquecido = {
            ...contexto,
            userId: req.user.id,
            role: req.user.role,
            planTier: req.user.plan_tier,
            calendario,
            emailNotificacoes
        };

        console.log(`[AI Chat] Processando mensagem de ${req.user.email}...`);
        // Anotações (Starter/Pro IA), pacientes (contatos) e agendamentos: interpretador próprio (ai.js, parte 2).
        // Devolve null quando o pedido é de outro assunto, e aí o agente padrão responde como sempre.
        // ERP (cadastros, produtos/estoque, financeiro): interpretador próprio, bloqueado por plano e cargo (ai.js, parte 3).
        let resultado = await clinicAi.interpretarErp(mensagem, { nomeUsuario: req.user.name, planTier: req.user.plan_tier, planStatus: req.user.plan_status, role: req.user.role, isOwner: !!req.user.isSiteOwner });
        if (!resultado) resultado = await clinicAi.interpretar(mensagem, { nomeUsuario: req.user.name, planTier: req.user.plan_tier, planStatus: req.user.plan_status, isOwner: isOwnerUser });
        if (!resultado) resultado = await processarAgenteKLWeb(mensagem, contextoEnriquecido);

        if (resultado.tipo === 'ACAO_REQUERIDA') {
            // Executa TODAS as ações que a IA pediu, em ordem, mesmo que uma falhe no meio —
            // assim "mude o tema E ative o daltônico" não para na primeira ação só porque
            // a segunda deu erro. As mensagens (de sucesso ou erro) são concatenadas no final.
            const mensagens = [];
            let theme = null;
            for (const acao of resultado.acoes) {
                try {
                    console.log(`[AI Chat] Ação detectada: ${acao.funcao}`);
                    const execResult = await executeAiAction(acao.funcao, acao.parametros.raw, req);
                    mensagens.push(execResult.message);
                    if (execResult.theme) theme = execResult.theme;
                } catch (actionError) {
                    console.error(`[AI Chat] Erro ao executar ação ${acao.funcao}:`, actionError.message);
                    mensagens.push(`Houve um erro ao tentar realizar a ação "${acao.funcao}": ${actionError.message}`);
                }
            }
            resultado = {
                tipo: 'RESPOSTA_TEXTO',
                texto: mensagens.join('\n\n'),
                theme
            };
        }

        res.json(resultado);
    } catch (error) {
        console.error('❌ Erro crítico ao processar mensagem da IA:', error);
        res.status(500).json({
            tipo: 'RESPOSTA_TEXTO',
            texto: `Erro técnico: ${error.message}. Por favor, tente novamente mais tarde.`
        });
    }
});

// Histórico da Cláudia compartilhado por empresa. Cada mensagem guarda QUEM falou (user_id/user_name),
// então o colega vê "Maria: ..." em vez de achar que foi ele. Quem grava é o front (todas as mensagens,
// inclusive as resolvidas localmente), por isso /api/ai/process não grava nada — evita duplicar.
app.get('/api/ai/history', authenticateToken, requireCompany, async (req, res) => {
    try {
        const r = await pool.query(
            `SELECT id, user_id, user_name, sender, message, created_at FROM (
                SELECT * FROM ai_chat_messages WHERE company_id = $1 ORDER BY id DESC LIMIT 100
             ) t ORDER BY id ASC`,
            [req.user.companyId]
        );
        res.json(r.rows);
    } catch (err) {
        console.error('Erro ao buscar histórico da IA:', err.message);
        res.status(500).json({ message: 'Erro ao buscar histórico da IA.' });
    }
});

app.post('/api/ai/history', authenticateToken, requireCompany, async (req, res) => {
    try {
        const { sender, message } = req.body || {};
        if (!req.user.companyId) return res.status(400).json({ message: 'Sem empresa vinculada.' });
        if (!['USER', 'AI'].includes(sender) || typeof message !== 'string' || !message.trim() || message.length > 6000) {
            return res.status(400).json({ message: 'Mensagem inválida.' });
        }
        const me = await pool.query('SELECT name FROM users WHERE id = $1', [req.user.id]);
        const userName = me.rows[0]?.name || req.user.name || 'Colega';
        const ins = await pool.query(
            `INSERT INTO ai_chat_messages (company_id, user_id, user_name, sender, message)
             VALUES ($1, $2, $3, $4, $5) RETURNING id, user_id, user_name, sender, message, created_at`,
            [req.user.companyId, req.user.id, userName, sender, message]
        );
        res.status(201).json(ins.rows[0]);
        broadcastBoard(req.user.companyId, 'ai_chat_message', ins.rows[0]);
    } catch (err) {
        console.error('Erro ao gravar histórico da IA:', err.message);
        res.status(500).json({ message: 'Erro ao gravar histórico da IA.' });
    }
});

app.get('/api/checkout/plans', (req, res) => {
    res.json({
        starter: PLAN_STARTER_URL,
        pro: PLAN_PRO_AI_URL
    });
});

// Gera um checkout de Assinatura (Preapproval) do Mercado Pago vinculado ao usuário logado,
// com external_reference contendo id/e-mail/plano — para o webhook saber exatamente quem
// pagou e qual plano ativar (os links estáticos antigos não permitiam isso).
// Usa o modelo "sem plano associado, com pagamento pendente": o preapproval_plan_id exige
// card_token_id na criação (tokenização de cartão no back-end), então em vez de reusar o
// plano do painel, recriamos os mesmos valores (preço/frequência) sem vínculo a ele.
const PLAN_PRICES = { STARTER: 29.90, PRO_IA: 69.90 };

function getPublicBaseUrl(req) {
    const configuredUrl = process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL;
    const requestUrl = req ? `${req.protocol}://${req.get('host')}` : 'https://klweb.com.br';
    return (configuredUrl || requestUrl).replace(/\/+$/, '');
}

function canReceivePaymentWebhook(baseUrl) {
    try {
        const url = new URL(baseUrl);
        return url.protocol === 'https:' && !['localhost', '127.0.0.1', '::1'].includes(url.hostname);
    } catch (error) {
        return false;
    }
}

// Antes de criar uma assinatura nova, verifica no Mercado Pago a assinatura que já está salva para o
// usuário. Se ela está autorizada (cobrando ou em período de teste) ou pausada (pode ser retomada),
// bloqueia a nova: duas assinaturas ficariam cobrando o cartão em paralelo e o sistema só conseguiria
// cancelar uma. Uma antiga que ficou "pending" (checkout abandonado) é cancelada para que ninguém a
// conclua depois sem o sistema saber.
async function checkExistingSubscription(userId) {
    const row = (await pool.query(`SELECT mp_subscription_id FROM users WHERE id = $1`, [userId])).rows[0];
    if (!row || !row.mp_subscription_id) return { blocked: false };

    const pre = new PreApproval(mpClient);
    let sub = null;
    try {
        sub = await pre.get({ id: row.mp_subscription_id });
    } catch (e) {
        const notFound = e?.status === 404 || e?.statusCode === 404 || /not found/i.test(String(e?.message || ''));
        if (notFound) return { blocked: false };
        throw e; // Na dúvida, não arrisca criar uma segunda cobrança.
    }
    if (!sub) return { blocked: false };
    if (['authorized', 'paused'].includes(sub.status)) return { blocked: true };
    if (sub.status === 'pending') {
        try {
            await pre.update({ id: row.mp_subscription_id, body: { status: 'cancelled' } });
        } catch (e) {
            console.warn('Não foi possível cancelar a assinatura pendente antiga:', e?.message || e);
        }
    }
    return { blocked: false };
}

const DUPLICATE_SUBSCRIPTION_MESSAGE = 'Você já tem uma assinatura em andamento. Cancele a atual em Planos & Assinatura antes de assinar outro plano, para não ser cobrado duas vezes.';

app.post('/api/payments/subscribe', authenticateToken, async (req, res) => {
    const planTier = (req.body.planTier || '').toUpperCase();

    if (!['STARTER', 'PRO_IA'].includes(planTier)) {
        return res.status(400).json({ message: 'Plano inválido. Selecione STARTER ou PRO_IA.' });
    }

    if (!mpClient) {
        return res.status(500).json({ message: 'Mercado Pago não configurado no servidor.' });
    }
    if (!process.env.MERCADOPAGO_WEBHOOK_SECRET) {
        return res.status(503).json({ message: 'Confirmação segura do pagamento não está configurada. Entre em contato com o suporte.' });
    }

    // Verifica se o usuário já usou o trial gratuito
    const userRow = (await pool.query('SELECT free_trial_used FROM users WHERE id = $1', [req.user.id])).rows[0];
    const hasUsedTrial = userRow?.free_trial_used || false;

    // O checkout do Mercado Pago só aceita pagar com a conta MP cujo e-mail é igual ao payer_email.
    // Por isso a pessoa pode informar o e-mail da conta dela no Mercado Pago, que pode ser diferente
    // do e-mail da KL Web. Quem ativa o plano é o userId do external_reference, não esse e-mail.
    const rawPayerEmail = String(req.body.payerEmail || '').trim().toLowerCase();
    if (rawPayerEmail && !isValidEmail(rawPayerEmail)) {
        return res.status(400).json({ message: 'Informe um e-mail válido da sua conta do Mercado Pago.' });
    }
    const payerEmail = rawPayerEmail || String(req.user.email || '').trim().toLowerCase();

    try {
        const preApproval = new PreApproval(mpClient);
        const baseUrl = getPublicBaseUrl(req);
        if (!canReceivePaymentWebhook(baseUrl)) {
            return res.status(503).json({ message: 'Checkout temporariamente indisponível: o servidor precisa de uma URL pública HTTPS para confirmar o pagamento.' });
        }
        const planDisplayName = planTier === 'PRO_IA' ? 'Pro AI' : 'Starter';

        const existing = await checkExistingSubscription(req.user.id);
        if (existing.blocked) {
            return res.status(409).json({ message: DUPLICATE_SUBSCRIPTION_MESSAGE });
        }

        const result = await preApproval.create({
            body: {
                reason: `Assinatura ${planDisplayName} - KL Web`,
                payer_email: payerEmail,
                external_reference: JSON.stringify({ userId: req.user.id, email: req.user.email, plan_tier: planTier }),
                auto_recurring: {
                    frequency: 1,
                    frequency_type: 'months',
                    transaction_amount: PLAN_PRICES[planTier],
                    currency_id: 'BRL',
                    // Trial gratuito de 7 dias se o usuário ainda não usou
                    free_trial: !hasUsedTrial ? {
                        frequency: 7,
                        frequency_type: 'days'
                    } : undefined
                },
                back_url: `${baseUrl}/?payment=return`,
                // Assinaturas não usam a URL configurada no painel "Suas integrações" — precisa
                // ser enviada aqui, na própria criação (diferente do fluxo de Preference/Payment).
                notification_url: `${baseUrl}/api/payments/webhook`,
                status: 'pending'
            }
        });

        // Guarda o id logo na criação: assim o cancelamento funciona mesmo antes da primeira cobrança
        // (ex.: durante o período de teste, com o cartão já autorizado).
        await pool.query(`UPDATE users SET mp_subscription_id = $1 WHERE id = $2`, [result.id, req.user.id]);

        return res.json({ success: true, initPoint: result.init_point, hasFreeTrial: !hasUsedTrial });
    } catch (error) {
        console.error('Erro ao criar assinatura no Mercado Pago (payer_email=' + payerEmail + '):',
            require('util').inspect({ message: error?.message, status: error?.status, cause: error?.cause, response: error?.response }, { depth: 6 }));
        const mpText = String((error && (error.message || '')) + ' ' + JSON.stringify((error && error.cause) || '')).toLowerCase();
        if (mpText.includes('cannot be the same user')) {
            return res.status(400).json({ message: 'Você não pode assinar com o mesmo e-mail da conta do Mercado Pago que recebe os pagamentos. Use outra conta (outro e-mail) para assinar.' });
        }
        if (mpText.includes('payer_email') || mpText.includes('invalid') && mpText.includes('email')) {
            return res.status(400).json({ message: 'O Mercado Pago não aceitou esse e-mail. Confira o e-mail da sua conta do Mercado Pago e tente de novo.' });
        }
        return res.status(500).json({ message: 'Erro ao gerar checkout de assinatura.' });
    }
});

app.post('/api/payments/cancel', authenticateToken, async (req, res) => {
    if (!mpClient) {
        return res.status(500).json({ message: 'Mercado Pago não configurado no servidor.' });
    }
    try {
        const row = (await pool.query(`SELECT plan_tier, plan_status, mp_subscription_id FROM users WHERE id = $1`, [req.user.id])).rows[0];
        if (!row) {
            return res.status(404).json({ message: 'Usuário não encontrado.' });
        }

        if (!row.mp_subscription_id) {
            // Plano pago liberado sem assinatura no Mercado Pago (ex.: painel master): não há cobrança
            // recorrente para parar por aqui, então só o suporte pode encerrar.
            if (row.plan_status === 'ACTIVE' && ['STARTER', 'PRO_IA'].includes(normalizePlanTier(row.plan_tier))) {
                return res.status(409).json({ message: 'Não encontramos o código da sua assinatura. Entre em contato com o suporte para cancelar.' });
            }
            return res.status(400).json({ message: 'Você não tem uma assinatura para cancelar.' });
        }

        // Não depende de o plano estar ACTIVE: durante o período de teste o cartão já está autorizado
        // e será cobrado no fim dele, então o cliente precisa conseguir cancelar nessa fase também.
        const subscriptionId = row.mp_subscription_id;
        const preApproval = new PreApproval(mpClient);

        let current = null;
        try {
            current = await preApproval.get({ id: subscriptionId });
        } catch (e) {
            const notFound = e?.status === 404 || e?.statusCode === 404 || /not found/i.test(String(e?.message || ''));
            if (!notFound) throw e;
        }

        if (current && current.status !== 'cancelled') {
            const updated = await preApproval.update({ id: subscriptionId, body: { status: 'cancelled' } });
            // Só diz que parou de cobrar se o Mercado Pago confirmou o cancelamento.
            if (!updated || updated.status !== 'cancelled') {
                throw new Error(`Mercado Pago não confirmou o cancelamento (status: ${updated?.status || 'desconhecido'}).`);
            }
        }

        await pool.query(`UPDATE users SET plan_status = 'INACTIVE', mp_subscription_id = NULL WHERE id = $1`, [req.user.id]);
        console.log(`⛔ Assinatura ${subscriptionId} cancelada pelo usuário ${req.user.id}`);
        auditLog(req, 'ASSINATURA_CANCELADA');
        return res.json({ message: 'Assinatura cancelada. Nenhuma nova cobrança será feita no seu cartão.' });
    } catch (error) {
        console.error('Erro ao cancelar assinatura:', error?.cause || error.message || error);
        return res.status(500).json({ message: 'Não foi possível cancelar agora. Tente novamente ou fale com o suporte.' });
    }
});

// ==================== TESTAR CONEXÃO COM MERCADO PAGO ====================
app.get('/api/payments/test-connection', authenticateToken, async (req, res) => {
    try {
        if (!mpClient) {
            return res.status(500).json({
                success: false,
                message: 'Mercado Pago não configurado. Verifique MERCADOPAGO_ACCESS_TOKEN no .env'
            });
        }

        // Testar conexão com a API do Mercado Pago
        const PreApproval = require('mercadopago').PreApproval;
        const preApproval = new PreApproval(mpClient);

        // Fazer uma chamada simples para verificar as credenciais
        const result = await preApproval.search({ limit: 1 });

        res.json({
            success: true,
            message: 'Conexão com Mercado Pago está funcionando!',
            mode: 'PRODUÇÃO',
            credentials: {
                accessTokenPrefix: process.env.MERCADOPAGO_ACCESS_TOKEN?.substring(0, 8) + '...',
                hasAccessToken: !!process.env.MERCADOPAGO_ACCESS_TOKEN,
                hasWebhookSecret: !!process.env.MERCADOPAGO_WEBHOOK_SECRET
            },
            apiTest: {
                successful: true,
                response: 'API respondeu corretamente'
            }
        });
    } catch (error) {
        console.error('Erro ao testar conexão com Mercado Pago:', error);

        // Verificar se é erro de autenticação
        const errorMessage = error?.message || '';
        if (errorMessage.includes('401') || errorMessage.includes('unauthorized') || errorMessage.includes('token')) {
            return res.status(401).json({
                success: false,
                message: 'Erro de autenticação. O Access Token pode estar inválido ou expirado.',
                error: errorMessage
            });
        }

        res.status(500).json({
            success: false,
            message: 'Erro ao conectar com Mercado Pago',
            error: errorMessage
        });
    }
});

// ==================== VERIFICAR STATUS DE UMA ORDEM ====================
app.get('/api/payments/check-order/:orderId', authenticateToken, async (req, res) => {
    try {
        const { orderId } = req.params;

        if (!mpClient) {
            return res.status(500).json({ message: 'Mercado Pago não configurado.' });
        }

        const response = await fetch(`https://api.mercadopago.com/v1/orders/${orderId}`, {
            headers: {
                'Authorization': `Bearer ${process.env.MERCADOPAGO_ACCESS_TOKEN}`
            }
        });

        const data = await response.json();

        if (!response.ok) {
            return res.status(response.status).json({
                success: false,
                message: 'Erro ao buscar ordem',
                error: data
            });
        }

        res.json({
            success: true,
            order: data,
            status: data.status,
            status_detail: data.status_detail,
            message: `Status: ${data.status} - ${data.status_detail}`
        });
    } catch (error) {
        console.error('Erro ao verificar ordem:', error);
        res.status(500).json({
            success: false,
            message: 'Erro ao verificar ordem',
            error: error.message
        });
    }
});

// ==================== OBTER URL DE PAGAMENTO PENDENTE ====================
app.get('/api/payments/pending-url', authenticateToken, async (req, res) => {
    try {
        const userRow = (await pool.query(
            'SELECT mp_subscription_id FROM users WHERE id = $1',
            [req.user.id]
        )).rows[0];

        if (!userRow || !userRow.mp_subscription_id) {
            return res.status(404).json({ message: 'Nenhuma assinatura pendente encontrada.' });
        }

        const preApproval = new PreApproval(mpClient);
        const subscription = await preApproval.get({ id: userRow.mp_subscription_id });

        if (!subscription) {
            return res.status(404).json({ message: 'Assinatura não encontrada no Mercado Pago.' });
        }

        if (subscription.status !== 'pending') {
            return res.status(400).json({
                message: `Assinatura não está pendente. Status atual: ${subscription.status}`
            });
        }

        res.json({
            success: true,
            initPoint: subscription.init_point,
            message: 'URL de pagamento pendente encontrada.'
        });
    } catch (error) {
        console.error('Erro ao obter URL pendente:', error);
        res.status(500).json({ message: 'Erro ao obter URL de pagamento.' });
    }
});

// ==================== ANEXOS DE DEMANDAS ====================
app.post('/api/demands/:demandId/attachments', authenticateToken, requireCompany, upload.single('file'), async (req, res) => {
    try {
        const { demandId } = req.params;
        const companyId = req.user.companyId;

        // Verificar se a demanda pertence à empresa
        const demand = await pool.query(
            'SELECT id FROM demands WHERE id = $1 AND company_id = $2',
            [demandId, companyId]
        );

        if (demand.rows.length === 0) {
            return res.status(404).json({ message: 'Demanda não encontrada.' });
        }

        if (!req.file) {
            return res.status(400).json({ message: 'Nenhum arquivo enviado.' });
        }

        // Usar Supabase Storage para armazenar o arquivo
        if (!supabase) {
            removeUploadedFile(req.file);
            return res.status(500).json({ message: 'Supabase Storage não configurado.' });
        }

        const fileExtension = req.file.originalname.split('.').pop();
        const fileName = `${Date.now()}-${Math.random().toString(36).substring(7)}.${fileExtension}`;
        const storagePath = `demandas/${demandId}/${fileName}`;

        // O multer grava em disco (não existe req.file.buffer): lê o arquivo e apaga a cópia temporária.
        const fileBuffer = req.file.buffer || await fs.promises.readFile(req.file.path);

        // Upload para Supabase Storage
        const { data, error } = await supabase.storage
            .from('armazem')
            .upload(storagePath, fileBuffer, {
                contentType: req.file.mimetype,
                upsert: false
            });
        removeUploadedFile(req.file);

        if (error) {
            console.error('Erro ao fazer upload para Supabase:', error);
            return res.status(500).json({ message: 'Erro ao fazer upload do arquivo.' });
        }

        // Salvar metadados no banco
        const result = await pool.query(
            `INSERT INTO demand_attachments (demand_id, user_id, user_name, filename, original_name, file_size, mime_type, storage_path)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
            [demandId, req.user.id, req.user.name, fileName, req.file.originalname, req.file.size, req.file.mimetype, storagePath]
        );

        // Gerar URL pública
        const { data: urlData } = supabase.storage
            .from('armazem')
            .getPublicUrl(storagePath);

        res.status(201).json({
            ...result.rows[0],
            url: urlData.publicUrl
        });
    } catch (error) {
        console.error('Erro ao fazer upload de anexo:', error);
        res.status(500).json({ message: 'Erro ao fazer upload do anexo.' });
    }
});

app.get('/api/demands/:demandId/attachments', authenticateToken, requireCompany, async (req, res) => {
    try {
        const { demandId } = req.params;
        const companyId = req.user.companyId;

        // Verificar se a demanda pertence à empresa
        const demand = await pool.query(
            'SELECT id FROM demands WHERE id = $1 AND company_id = $2',
            [demandId, companyId]
        );

        if (demand.rows.length === 0) {
            return res.status(404).json({ message: 'Demanda não encontrada.' });
        }

        // Buscar anexos
        const result = await pool.query(
            'SELECT * FROM demand_attachments WHERE demand_id = $1 ORDER BY created_at DESC',
            [demandId]
        );

        // Gerar URLs públicas para cada anexo
        const attachments = await Promise.all(result.rows.map(async (attachment) => {
            const urlData = supabase
                ? supabase.storage.from('armazem').getPublicUrl(attachment.storage_path).data
                : null;

            return {
                ...attachment,
                url: urlData ? urlData.publicUrl : null
            };
        }));

        res.json(attachments);
    } catch (error) {
        console.error('Erro ao buscar anexos:', error);
        res.status(500).json({ message: 'Erro ao buscar anexos.' });
    }
});

app.delete('/api/demands/:demandId/attachments/:attachmentId', authenticateToken, requireCompany, async (req, res) => {
    try {
        const { demandId, attachmentId } = req.params;
        const companyId = req.user.companyId;

        // Verificar se a demanda pertence à empresa
        const demand = await pool.query(
            'SELECT id FROM demands WHERE id = $1 AND company_id = $2',
            [demandId, companyId]
        );

        if (demand.rows.length === 0) {
            return res.status(404).json({ message: 'Demanda não encontrada.' });
        }

        // Buscar anexo
        const attachment = await pool.query(
            'SELECT * FROM demand_attachments WHERE id = $1 AND demand_id = $2',
            [attachmentId, demandId]
        );

        if (attachment.rows.length === 0) {
            return res.status(404).json({ message: 'Anexo não encontrado.' });
        }

        // Deletar do Supabase Storage
        if (supabase) {
            const { error } = await supabase.storage
                .from('armazem')
                .remove([attachment.rows[0].storage_path]);

            if (error) {
                console.error('Erro ao deletar do Supabase:', error);
            }
        }

        // Deletar do banco
        await pool.query(
            'DELETE FROM demand_attachments WHERE id = $1',
            [attachmentId]
        );

        res.json({ message: 'Anexo deletado com sucesso.' });
    } catch (error) {
        console.error('Erro ao deletar anexo:', error);
        res.status(500).json({ message: 'Erro ao deletar anexo.' });
    }
});

// ==================== TRIAL GRATUITO DE 7 DIAS ====================
app.post('/api/trial/start', authenticateToken, async (req, res) => {
    // Nenhum dado de cartão passa por aqui: número, validade, nome e CVC são digitados só na página
    // do Mercado Pago, que valida o cartão de verdade e devolve a autorização via webhook.
    const rawPayerEmail = String(req.body?.payerEmail || '').trim().toLowerCase();
    if (rawPayerEmail && !isValidEmail(rawPayerEmail)) {
        return res.status(400).json({ message: 'Informe um e-mail válido da sua conta do Mercado Pago.' });
    }
    const payerEmail = rawPayerEmail || String(req.user.email || '').trim().toLowerCase();

    try {
        // Verificar se usuário já usou trial
        const userRow = (await pool.query(
            'SELECT free_trial_used, trial_end_date FROM users WHERE id = $1',
            [req.user.id]
        )).rows[0];

        if (!userRow) {
            return res.status(404).json({ message: 'Usuário não encontrado.' });
        }

        if (userRow.free_trial_used) {
            return res.status(400).json({ message: 'Você já usou o trial grátis. Cada conta só pode usar o trial uma vez.' });
        }

        // Verificar se tem plano BÁSICO
        if (userRow.plan_tier && userRow.plan_tier !== 'BASICO') {
            return res.status(400).json({ message: 'Trial só está disponível para usuários do plano Básico.' });
        }

        // Criar assinatura com trial de 7 dias no Mercado Pago
        if (!mpClient) {
            return res.status(500).json({ message: 'Mercado Pago não configurado.' });
        }

        const existing = await checkExistingSubscription(req.user.id);
        if (existing.blocked) {
            return res.status(409).json({ message: DUPLICATE_SUBSCRIPTION_MESSAGE });
        }

        const trialPlan = 'STARTER';
        const trialEndDate = new Date();
        trialEndDate.setDate(trialEndDate.getDate() + 7);

        const preApproval = new PreApproval(mpClient);
        const baseUrl = getPublicBaseUrl(req);

        const result = await preApproval.create({
            body: {
                reason: `Trial Gratuito 7 Dias - KL Web Starter`,
                payer_email: payerEmail,
                external_reference: JSON.stringify({
                    userId: req.user.id,
                    email: req.user.email,
                    trial: true,
                    trialEnd: trialEndDate.toISOString(),
                    plan_tier: trialPlan
                }),
                auto_recurring: {
                    frequency: 1,
                    frequency_type: 'months',
                    transaction_amount: PLAN_PRICES[trialPlan],
                    currency_id: 'BRL',
                    free_trial: {
                        frequency: 7,
                        frequency_type: 'days'
                    }
                },
                back_url: `${baseUrl}/?payment=return`,
                notification_url: `${baseUrl}/api/payments/webhook`,
                status: 'pending'
            }
        });

        // Guarda o id logo na criação para o cancelamento funcionar durante o teste.
        await pool.query(`UPDATE users SET mp_subscription_id = $1 WHERE id = $2`, [result.id, req.user.id]);

        console.log(`📦 [TRIAL] Assinatura criada para usuário ${req.user.id}`);
        console.log(`📦 [TRIAL] Subscription ID: ${result.id}`);
        console.log(`📦 [TRIAL] Init Point (URL): ${result.init_point}`);
        console.log(`📦 [TRIAL] Trial End: ${trialEndDate.toISOString()}`);

        res.json({
            success: true,
            initPoint: result.init_point,
            subscriptionId: result.id,
            trialEnd: trialEndDate.toISOString(),
            message: 'Trial iniciado! Redirecionando para o Mercado Pago...'
        });
    } catch (error) {
        console.error('Erro ao iniciar trial (payer_email=' + payerEmail + '):',
            require('util').inspect({ message: error?.message, status: error?.status, cause: error?.cause }, { depth: 6 }));
        const mpText = String((error && (error.message || '')) + ' ' + JSON.stringify((error && error.cause) || '')).toLowerCase();
        if (mpText.includes('cannot be the same user')) {
            return res.status(400).json({ message: 'Você não pode usar o mesmo e-mail da conta do Mercado Pago que recebe os pagamentos. Use outra conta (outro e-mail).' });
        }
        if (mpText.includes('payer_email') || (mpText.includes('invalid') && mpText.includes('email'))) {
            return res.status(400).json({ message: 'O Mercado Pago não aceitou esse e-mail. Confira o e-mail da sua conta do Mercado Pago e tente de novo.' });
        }
        res.status(500).json({ message: 'Erro ao iniciar trial. Tente novamente.' });
    }
});

// ==================== VERIFICAR ELEGIBILIDADE DE TRIAL ====================
app.get('/api/trial/check-eligibility', authenticateToken, async (req, res) => {
    try {
        const userRow = (await pool.query(
            'SELECT free_trial_used, trial_end_date, plan_tier FROM users WHERE id = $1',
            [req.user.id]
        )).rows[0];

        if (!userRow) {
            return res.status(404).json({ message: 'Usuário não encontrado.' });
        }

        if (userRow.free_trial_used) {
            return res.json({
                eligible: false,
                message: 'Você já usou o trial grátis. Cada conta só pode usar o trial uma vez.'
            });
        }

        if (userRow.plan_tier && userRow.plan_tier !== 'BASICO') {
            return res.json({
                eligible: false,
                message: 'Trial só está disponível para usuários do plano Básico.'
            });
        }

        res.json({ eligible: true, message: 'Você é elegível para o trial grátis.' });
    } catch (err) {
        console.error('Erro ao verificar elegibilidade:', err);
        res.status(500).json({ message: 'Erro ao verificar elegibilidade.' });
    }
});

// ==================== JOB PARA ENVIAR LEMBRETES DE ASSINATURA PENDING ====================
async function sendPendingSubscriptionReminders() {
    try {
        // Buscar usuários com assinatura pending
        const result = await pool.query(`
            SELECT u.id, u.name, u.email, u.mp_subscription_id, u.trial_end_date
            FROM users u
            WHERE u.mp_subscription_id IS NOT NULL
            AND u.plan_status = 'INACTIVE'
            AND u.trial_end_date IS NULL
            AND u.id NOT IN (
                SELECT user_id FROM trial_reminders WHERE sent = TRUE
            )
            LIMIT 10
        `);

        for (const user of result.rows) {
            try {
                // Verificar status da assinatura no Mercado Pago
                const preApproval = new PreApproval(mpClient);
                const subscription = await preApproval.get({ id: user.mp_subscription_id });

                if (subscription.status === 'pending') {
                    // Enviar email para completar pagamento
                    const subject = '⚠️ Complete seu pagamento do KL Web';
                    const html = `
                        <h2>Seu pagamento está pendente!</h2>
                        <p>Olá ${user.name},</p>
                        <p>Você iniciou a assinatura do KL Web, mas ainda não completou o pagamento.</p>
                        <p><strong>Para completar:</strong></p>
                        <ol>
                            <li>Acesse o painel do KL Web</li>
                            <li>Vá em "Planos & Assinatura"</li>
                            <li>Clique em "Completar Pagamento"</li>
                            <li>Complete o pagamento no Mercado Pago</li>
                        </ol>
                        <p>Se você não completar o pagamento em 24 horas, a assinatura será cancelada automaticamente.</p>
                        <p>Se você já pagou, desconsidere este email.</p>
                        <p>Atenciosamente,<br>Equipe KL Web</p>
                    `;

                    await sendMail({ to: user.email, subject, html });
                    console.log(`📧 Lembrete de pagamento pendente enviado para ${user.email}`);
                }
            } catch (err) {
                console.error(`Erro ao verificar assinatura do usuário ${user.id}:`, err.message);
            }
        }
    } catch (err) {
        console.error('Erro ao enviar lembretes de assinatura pending:', err);
    }
}

// Executa job de lembretes de assinatura pending a cada 6 horas
setInterval(sendPendingSubscriptionReminders, 6 * 60 * 60 * 1000);

// ==================== AGENDAR LEMBRETE DE TRIAL ====================
async function scheduleTrialReminder(userId, trialEndDate) {
    const reminderDate = new Date(trialEndDate);
    reminderDate.setDate(reminderDate.getDate() - 1); // 1 dia antes

    await pool.query(
        `INSERT INTO trial_reminders (user_id, reminder_date) VALUES ($1, $2)`,
        [userId, reminderDate]
    );
    console.log(`📅 Lembrete agendado para usuário ${userId} em ${reminderDate}`);
}

// ==================== JOB PARA ENVIAR LEMBRETES DE TRIAL ====================
async function sendTrialReminders() {
    try {
        const reminders = await pool.query(
            `SELECT tr.id, tr.user_id, u.email, u.name
             FROM trial_reminders tr
             JOIN users u ON tr.user_id = u.id
             WHERE tr.reminder_date <= CURRENT_TIMESTAMP
             AND tr.sent = FALSE`
        );

        for (const reminder of reminders.rows) {
            const subject = '⚠️ Seu trial do KL Web termina em 1 dia!';
            const html = `
                <h2>Seu trial do KL Web está quase acabando!</h2>
                <p>Olá ${reminder.name},</p>
                <p>Seu trial gratuito de 7 dias do plano Starter termina amanhã.</p>
                <p>Se você não cancelar, será cobrado R$ 29,90/mês no seu cartão.</p>
                <p><strong>Para cancelar:</strong></p>
                <ul>
                    <li>Acesse o painel do KL Web</li>
                    <li>Vá em "Planos & Assinatura"</li>
                    <li>Clique em "Cancelar Assinatura"</li>
                </ul>
                <p>Se você gostou do sistema, não precisa fazer nada - a assinatura continuará ativa!</p>
                <p>Atenciosamente,<br>Equipe KL Web</p>
            `;

            await sendMail({ to: reminder.email, subject, html });

            await pool.query(`UPDATE trial_reminders SET sent = TRUE WHERE id = $1`, [reminder.id]);
            console.log(`📧 Lembrete enviado para ${reminder.email}`);
        }
    } catch (err) {
        console.error('Erro ao enviar lembretes de trial:', err);
    }
}

// ==================== VERIFICAÇÃO DE TRIAL ====================
app.get('/api/trial/status', authenticateToken, async (req, res) => {
    try {
        const userRow = (await pool.query(
            'SELECT trial_end_date, free_trial_used FROM users WHERE id = $1',
            [req.user.id]
        )).rows[0];

        if (!userRow) {
            return res.status(404).json({ message: 'Usuário não encontrado.' });
        }

        const trialEnd = userRow.trial_end_date;
        const hasUsedTrial = userRow.free_trial_used;

        if (!trialEnd) {
            return res.json({ hasTrial: false, message: 'Nenhum trial ativo.' });
        }

        const now = new Date();
        const daysRemaining = Math.ceil((new Date(trialEnd) - now) / (1000 * 60 * 60 * 24));

        res.json({
            hasTrial: true,
            trialEnd,
            daysRemaining: daysRemaining > 0 ? daysRemaining : 0,
            hasUsedTrial,
            message: daysRemaining > 0
                ? `Você tem ${daysRemaining} dias restantes no trial.`
                : 'Seu trial terminou.'
        });
    } catch (err) {
        console.error('Erro ao verificar status do trial:', err);
        res.status(500).json({ message: 'Erro ao verificar status do trial.' });
    }
});

// Executa job de lembretes a cada hora
setInterval(sendTrialReminders, 60 * 60 * 1000);

// ==================== JOB PARA EXPIRAR TRIALS ====================
// Verifica a cada hora quais usuários tiveram o trial expirado e reverte para BASICO/INACTIVE.
// Só reverte se o usuário não tiver uma assinatura paga ativa (mp_subscription_id).
async function checkAndExpireTrials() {
    try {
        const result = await pool.query(
            `UPDATE users
             SET plan_tier = 'BASICO', plan_status = 'INACTIVE'
             WHERE plan_tier = 'STARTER'
               AND plan_status = 'ACTIVE'
               AND trial_end_date IS NOT NULL
               AND trial_end_date < CURRENT_TIMESTAMP
               AND (mp_subscription_id IS NULL OR mp_subscription_id = '')
             RETURNING id, email`
        );
        if (result.rowCount > 0) {
            console.log(`⏱️ Trial expirado para ${result.rowCount} usuário(s):`, result.rows.map(r => r.email).join(', '));
        }
    } catch (err) {
        console.error('Erro ao expirar trials:', err?.message || err);
    }
}
// Roda imediatamente ao iniciar (para pegar expirações que ocorreram enquanto o servidor estava offline)
// e depois a cada hora.
checkAndExpireTrials();
setInterval(checkAndExpireTrials, 60 * 60 * 1000);

initDb();

function generateCompanyCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 8; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

async function initPgTables(client) {
    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS companies (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                owner_id INT,
                invite_code VARCHAR(24) UNIQUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS security_logs (
                id SERIAL PRIMARY KEY,
                user_id INT,
                user_email VARCHAR(255),
                action VARCHAR(255) NOT NULL,
                ip_address VARCHAR(100),
                user_agent TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                email VARCHAR(255) UNIQUE NOT NULL,
                phone VARCHAR(50) NOT NULL,
                cpf VARCHAR(50) DEFAULT '',
                password TEXT NOT NULL,
                role VARCHAR(50) DEFAULT 'USER',
                is_active INT DEFAULT 1,
                company_id INT REFERENCES companies(id) ON DELETE SET NULL,
                plan_tier VARCHAR(50) DEFAULT 'BASICO',
                plan_status VARCHAR(50) DEFAULT 'INACTIVE',
                membership_status VARCHAR(20) DEFAULT 'ACTIVE',
                requested_at TIMESTAMP,
                ai_usage_count INT DEFAULT 0,
                reset_token TEXT,
                reset_token_expires BIGINT,
                lgpd_consent INT DEFAULT 1,
                theme VARCHAR(20) DEFAULT 'light',
                font_size VARCHAR(20) DEFAULT '100%',
                daltonic_mode VARCHAR(10) DEFAULT 'off',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS ai_chat_messages (
                id SERIAL PRIMARY KEY,
                company_id INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
                user_id INT,
                user_name VARCHAR(255),
                sender VARCHAR(10) NOT NULL,
                message TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS demands (
                id SERIAL PRIMARY KEY,
                company_id INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
                user_id INT,
                title VARCHAR(255) NOT NULL,
                description TEXT,
                priority VARCHAR(50) DEFAULT 'MEDIA',
                status VARCHAR(50) DEFAULT 'TODO',
                assigned_user_id INT,
                assigned_user_name VARCHAR(255),
                assigned_user_email VARCHAR(255),
                completed_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS demand_checklist_items (
                id SERIAL PRIMARY KEY,
                demand_id INT NOT NULL REFERENCES demands(id) ON DELETE CASCADE,
                text VARCHAR(500) NOT NULL,
                done BOOLEAN DEFAULT FALSE,
                position INT DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS demand_comments (
                id SERIAL PRIMARY KEY,
                demand_id INT NOT NULL REFERENCES demands(id) ON DELETE CASCADE,
                user_id INT,
                user_name VARCHAR(255),
                message TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS demand_attachments (
                id SERIAL PRIMARY KEY,
                demand_id INT NOT NULL REFERENCES demands(id) ON DELETE CASCADE,
                user_id INT,
                user_name VARCHAR(255),
                filename VARCHAR(255) NOT NULL,
                original_name VARCHAR(255) NOT NULL,
                file_size BIGINT,
                mime_type VARCHAR(100),
                storage_path TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS contacts (
                id SERIAL PRIMARY KEY,
                company_id INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
                name VARCHAR(255) NOT NULL,
                phone VARCHAR(50) NOT NULL,
                email VARCHAR(255),
                company_name VARCHAR(255) DEFAULT '',
                role VARCHAR(100) DEFAULT '',
                notes TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS events (
                id SERIAL PRIMARY KEY,
                company_id INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
                user_id INT,
                title VARCHAR(255) NOT NULL,
                event_date VARCHAR(50) NOT NULL,
                event_time VARCHAR(50),
                type VARCHAR(50) DEFAULT 'REUNIAO',
                description TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS automations (
                id SERIAL PRIMARY KEY,
                company_id INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
                name VARCHAR(255) NOT NULL,
                trigger_event VARCHAR(100) NOT NULL,
                action_type VARCHAR(100) NOT NULL,
                action_target VARCHAR(255),
                action_payload TEXT,
                is_active INT DEFAULT 1,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS notifications (
                id SERIAL PRIMARY KEY,
                user_id INT,
                user_email VARCHAR(255) NOT NULL,
                title VARCHAR(255) NOT NULL,
                message TEXT NOT NULL,
                type VARCHAR(50) DEFAULT 'assignment',
                is_read INT DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS files (
                id SERIAL PRIMARY KEY,
                company_id INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
                user_id INT,
                filename VARCHAR(255) NOT NULL,
                original_name VARCHAR(255) NOT NULL,
                file_size BIGINT,
                mime_type VARCHAR(100),
                file_path TEXT,
                uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS support_chats (
                id SERIAL PRIMARY KEY,
                user_id INT,
                user_email VARCHAR(255) NOT NULL,
                user_name VARCHAR(255),
                subject VARCHAR(100) NOT NULL,
                status VARCHAR(50) DEFAULT 'OPEN',
                is_unread INT DEFAULT 1,
                typing_user_id INT,
                typing_expires_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS support_messages (
                id SERIAL PRIMARY KEY,
                chat_id INT REFERENCES support_chats(id) ON DELETE CASCADE,
                sender_id INT,
                sender_type VARCHAR(50) NOT NULL,
                message TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS feedbacks (
                id SERIAL PRIMARY KEY,
                user_id INT,
                user_email VARCHAR(255) NOT NULL,
                user_name VARCHAR(255),
                type VARCHAR(50) NOT NULL,
                content TEXT NOT NULL,
                status VARCHAR(50) DEFAULT 'PENDING',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS playbooks (
                id SERIAL PRIMARY KEY,
                company_id INT REFERENCES companies(id) ON DELETE CASCADE,
                title VARCHAR(255) NOT NULL,
                category VARCHAR(50) DEFAULT 'GERAL',
                steps_instruction TEXT,
                is_system BOOLEAN DEFAULT FALSE,
                is_active INT DEFAULT 1,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            ALTER TABLE users ADD COLUMN IF NOT EXISTS company_id INT REFERENCES companies(id) ON DELETE SET NULL;
            ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_tier VARCHAR(50) DEFAULT 'BASICO';
            ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_status VARCHAR(50) DEFAULT 'INACTIVE';
            ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INT DEFAULT 0;
            ALTER TABLE users ADD COLUMN IF NOT EXISTS fcm_token TEXT;
            ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret_enc TEXT;
            ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN DEFAULT FALSE;
            ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_last_step BIGINT;
            ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_backup_codes TEXT;
        `);

        // Add sender_id column to support_messages if it doesn't exist (for existing tables)
        await client.query(`
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'support_messages'
                    AND column_name = 'sender_id'
                ) THEN
                    ALTER TABLE support_messages ADD COLUMN sender_id INT;
                END IF;
            END $$;
        `);

        await client.query(`
            ALTER TABLE companies ADD COLUMN IF NOT EXISTS invite_code VARCHAR(24);
            ALTER TABLE companies ADD COLUMN IF NOT EXISTS owner_id INT;

            ALTER TABLE users ADD COLUMN IF NOT EXISTS membership_status VARCHAR(20) DEFAULT 'ACTIVE';
            ALTER TABLE users ADD COLUMN IF NOT EXISTS requested_at TIMESTAMP;
            ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_usage_count INT DEFAULT 0;
            ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_usage_date DATE;
            ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token TEXT;
            ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_expires BIGINT;
            ALTER TABLE users ADD COLUMN IF NOT EXISTS lgpd_consent INT DEFAULT 1;
            ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active INT DEFAULT 1;
            ALTER TABLE users ADD COLUMN IF NOT EXISTS notif_prefs TEXT;
            ALTER TABLE users ADD COLUMN IF NOT EXISTS mp_subscription_id TEXT;
            ALTER TABLE events ADD COLUMN IF NOT EXISTS client_name VARCHAR(150);
            ALTER TABLE events ADD COLUMN IF NOT EXISTS client_phone VARCHAR(30);
            ALTER TABLE users ADD COLUMN IF NOT EXISTS site_role VARCHAR(20);
            ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified INT DEFAULT 1;
            CREATE TABLE IF NOT EXISTS email_verifications (
                user_id INT PRIMARY KEY,
                code_hash VARCHAR(64) NOT NULL,
                expires_at BIGINT NOT NULL,
                attempts INT DEFAULT 0,
                last_sent_at BIGINT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS email_change_requests (
                user_id INT PRIMARY KEY,
                new_email VARCHAR(255) NOT NULL,
                code_hash VARCHAR(64) NOT NULL,
                expires_at BIGINT NOT NULL,
                attempts INT NOT NULL DEFAULT 0,
                last_sent_at BIGINT NOT NULL
            );
            UPDATE users SET plan_tier = 'BASICO' WHERE COALESCE(plan_status, 'INACTIVE') <> 'ACTIVE' AND plan_tier IN ('STARTER', 'PRO_IA', 'PRO_PME', 'CORPORATE');

            UPDATE users SET membership_status = 'ACTIVE' WHERE membership_status IS NULL;
            UPDATE companies c
            SET owner_id = first_manager.id
            FROM (
                SELECT DISTINCT ON (company_id) company_id, id
                FROM users
                WHERE company_id IS NOT NULL AND role IN ('OWNER', 'MANAGER')
                ORDER BY company_id, CASE WHEN role = 'OWNER' THEN 0 ELSE 1 END, id
            ) AS first_manager
            WHERE c.id = first_manager.company_id AND c.owner_id IS NULL;
            CREATE UNIQUE INDEX IF NOT EXISTS companies_invite_code_unique
                ON companies (invite_code) WHERE invite_code IS NOT NULL;

            ALTER TABLE demands ADD COLUMN IF NOT EXISTS position INT DEFAULT 0;
        `);

        // Backfill de 'position' para demandas antigas (criadas antes desta coluna existir):
        // sem isso, toda demanda existente ficaria com position = 0 e a ordem dentro de cada
        // coluna do board ficaria indefinida na primeira renderização com Sortable.
        await client.query(`
            UPDATE demands d
            SET position = sub.rn
            FROM (
                SELECT id, ROW_NUMBER() OVER (PARTITION BY company_id, status ORDER BY created_at ASC) AS rn
                FROM demands
            ) sub
            WHERE d.id = sub.id AND d.position = 0;
        `);

        const companiesWithoutCode = await client.query(
            `SELECT id FROM companies WHERE invite_code IS NULL OR invite_code = ''`
        );
        for (const company of companiesWithoutCode.rows) {
            const newCode = generateCompanyCode();
            await client.query(
                `UPDATE companies SET invite_code = $1 WHERE id = $2`,
                [newCode, company.id]
            );
        }

        await client.query(`
            INSERT INTO companies (id, name)
            VALUES (1, 'Workspace Master')
            ON CONFLICT (id) DO NOTHING;
        `);

        // Seed Tutorial de IA Autônoma em Playbooks
        await client.query(`
            INSERT INTO playbooks (company_id, title, category, steps_instruction)
            VALUES (1, 'Guia de Uso da IA Autônoma', 'TUTORIAL',
            '1. 📅 Calendário: Mencione datas/horas para criar eventos automaticamente.
             2. 📋 Kanban: Peça tarefas ou demandas para organizar seu fluxo de trabalho.
             3. 👥 CRM: Adicione contatos informando nome e telefone.
             4. 🏢 Equipe: Use e-mails para adicionar novos membros à empresa.
             5. 🔐 Admin: Altere senhas e e-mails (apenas para Owners/Managers).
             6. 🎨 Visual: Peça para mudar para tema claro ou escuro.
             7. 💰 Planos: Pergunte sobre os benefícios dos planos Starter, Pro e Enterprise.')
            ON CONFLICT DO NOTHING;
        `);

        // ⚠️ REMOVIDO (de novo): não recriar o usuário OWNER com senha hardcoded
        // no código toda vez que o servidor sobe. O login já reconhece o OWNER
        // dinamicamente comparando o e-mail com OWNER_EMAIL. Para ter a conta,
        // cadastre-se normalmente pela tela de registro do sistema.

        // ================= MIGRAÇÕES DE SEGURANÇA =================
        // Prioridades 3-7 de segurança do banco de dados

        // PRIORIDADE 3: Hash de tokens de recuperação
        await client.query(`
            CREATE TABLE IF NOT EXISTS password_reset_tokens (
                id SERIAL PRIMARY KEY,
                user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                token_hash VARCHAR(255) NOT NULL,
                expires_at BIGINT NOT NULL,
                used_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS email_change_tokens (
                id SERIAL PRIMARY KEY,
                user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                new_email VARCHAR(255) NOT NULL,
                token_hash VARCHAR(255) NOT NULL,
                expires_at BIGINT NOT NULL,
                used_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // PRIORIDADE 4: company_id NOT NULL onde aplicável
        await client.query(`ALTER TABLE notifications ADD COLUMN IF NOT EXISTS company_id INT REFERENCES companies(id) ON DELETE CASCADE`);
        await client.query(`ALTER TABLE security_logs ADD COLUMN IF NOT EXISTS company_id INT REFERENCES companies(id) ON DELETE SET NULL`);

        // PRIORIDADE 7: Melhorar tipos de data/hora
        try {
            await client.query(`
            ALTER TABLE events ALTER COLUMN event_date TYPE DATE USING
            CASE
                WHEN event_date::text ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN event_date::text::DATE
                WHEN event_date::text ~ '^\\d{2}/\\d{2}/\\d{4}$' THEN TO_DATE(event_date::text, 'DD/MM/YYYY')
                ELSE CURRENT_DATE
            END
        `);
        } catch (e) {
            console.log('⚠️  event_date já é DATE ou erro na conversão:', e.message);
        }

        // Substitua o bloco da event_time por:
        try {
            await client.query(`
                ALTER TABLE events ALTER COLUMN event_time TYPE TIME USING
                CASE
                    WHEN event_time::text ~ '^\\d{2}:\\d{2}$' THEN event_time::text::TIME
                    WHEN event_time::text ~ '^\\d{2}:\\d{2}:\\d{2}$' THEN event_time::text::TIME
                    ELSE CURRENT_TIME
                END
            `);
        } catch (e) {
            console.log('⚠️  event_time já é TIME ou erro na conversão:', e.message);
        }

        // Tabela de preferências de notificação
        await client.query(`
            CREATE TABLE IF NOT EXISTS notification_preferences (
                id SERIAL PRIMARY KEY,
                user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                email_enabled BOOLEAN DEFAULT TRUE,
                panel_enabled BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(user_id)
            );
        `);

        // Colunas para trial gratuito
        await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS free_trial_used BOOLEAN DEFAULT FALSE`);
        await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_start_date TIMESTAMP`);
        await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_end_date TIMESTAMP`);

        // ÍNDICES DE PERFORMANCE
        await client.query(`CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user_id ON password_reset_tokens(user_id)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_expires_at ON password_reset_tokens(expires_at)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_email_change_tokens_user_id ON email_change_tokens(user_id)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_email_change_tokens_expires_at ON email_change_tokens(expires_at)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_notifications_company_id ON notifications(company_id)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_security_logs_company_id ON security_logs(company_id)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_demands_company_status ON demands(company_id, status)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_contacts_company ON contacts(company_id)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_events_company_date ON events(company_id, event_date)`);

        // Tabela para agendar lembretes de trial
        await client.query(`
            CREATE TABLE IF NOT EXISTS trial_reminders (
                id SERIAL PRIMARY KEY,
                user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                reminder_date TIMESTAMP NOT NULL,
                sent BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_trial_reminders_date ON trial_reminders(reminder_date, sent)`);

        // CONSTRAINTS DE SEGURANÇA
        await client.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_password_reset_tokens_active
            ON password_reset_tokens(user_id)
            WHERE used_at IS NULL
        `);
        await client.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_email_change_tokens_active
            ON email_change_tokens(user_id)
            WHERE used_at IS NULL
        `);

        // DADOS DE AUDITORIA - updated_at
        await client.query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`);
        await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`);
        await client.query(`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`);
        await client.query(`ALTER TABLE automations ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`);

        // CLÍNICA / PACIENTES + ANOTAÇÕES
        // clinic_data e patient_data guardam um JSON CRIPTOGRAFADO (CPF, convênio, histórico etc. são dados
        // pessoais sensíveis pela LGPD, então seguem o mesmo cuidado de nome/telefone/e-mail dos contatos).
        await client.query(`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS clinic_data TEXT`);

        // STATUS DOS CONTATOS (Lead, Cliente ativo...): os padrões ficam no código (DEFAULT_CONTACT_STATUSES);
        // os criados pela equipe ficam nesta tabela, por empresa. contacts.status guarda a chave do padrão
        // (ex.: 'ATIVO') ou 'c:<id>' para um status personalizado.
        await client.query(`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS status VARCHAR(100) DEFAULT ''`);
        await client.query(`
            CREATE TABLE IF NOT EXISTS contact_statuses (
                id SERIAL PRIMARY KEY,
                company_id INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
                name VARCHAR(40) NOT NULL,
                color VARCHAR(9) NOT NULL DEFAULT '#64748b',
                created_by INT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_statuses_company_name ON contact_statuses(company_id, LOWER(name))`);
        await client.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS patient_data TEXT`);
        await client.query(`
            CREATE TABLE IF NOT EXISTS notes (
                id SERIAL PRIMARY KEY,
                company_id INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
                user_id INT REFERENCES users(id) ON DELETE SET NULL,
                title TEXT NOT NULL,
                content TEXT,
                color VARCHAR(20) DEFAULT 'default',
                pinned BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_notes_company ON notes(company_id, updated_at DESC)`);

        // Trigger para updated_at
        await client.query(`
            CREATE OR REPLACE FUNCTION update_updated_at_column()
            RETURNS TRIGGER AS $$
            BEGIN
                NEW.updated_at = CURRENT_TIMESTAMP;
                RETURN NEW;
            END;
            $$ language 'plpgsql'
        `);

        await client.query(`DROP TRIGGER IF EXISTS update_companies_updated_at ON companies`);
        await client.query(`
            CREATE TRIGGER update_companies_updated_at
            BEFORE UPDATE ON companies
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()
        `);

        await client.query(`DROP TRIGGER IF EXISTS update_users_updated_at ON users`);
        await client.query(`
            CREATE TRIGGER update_users_updated_at
            BEFORE UPDATE ON users
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()
        `);

        await client.query(`DROP TRIGGER IF EXISTS update_contacts_updated_at ON contacts`);
        await client.query(`
            CREATE TRIGGER update_contacts_updated_at
            BEFORE UPDATE ON contacts
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()
        `);

        await client.query(`DROP TRIGGER IF EXISTS update_automations_updated_at ON automations`);
        await client.query(`
            CREATE TRIGGER update_automations_updated_at
            BEFORE UPDATE ON automations
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()
        `);

        console.log(`✅ [POSTGRESQL] Tabelas sincronizadas com sucesso no Supabase!`);
        console.log(`✅ [POSTGRESQL] Migrações de segurança aplicadas (tokens hash, índices, triggers).`);
    } catch (err) {
        console.error('❌ Erro ao inicializar tabelas no PostgreSQL:', err.message);
    }
}

async function sendMail({ to, subject, html }) {
    try {
        if (!process.env.RESEND_API_KEY) {
            console.log(`\n==================================================\n[E-MAIL SIMULADO KL WEB ENVIADO PARA: ${to}]\nAssunto: ${subject}\nConteúdo: ${html.replace(/<[^>]+>/g, ' ')}\n==================================================\n`);
            return true;
        }
        const result = await resend.emails.send({
            from: process.env.RESEND_FROM || 'KL Web <nao-responda@klweb.com.br>',
            to,
            subject,
            html
        });
        // O SDK do Resend NÃO lança exceção quando o envio é recusado: devolve { error }.
        // Antes isso era tratado como sucesso (o site dizia "código enviado" e nada chegava).
        if (result && result.error) {
            console.error(`Resend recusou o envio para ${to}:`, result.error);
            if (!process.env.RESEND_FROM) {
                console.error('RESEND_FROM não está definido: o remetente de teste (onboarding@resend.dev) só entrega para o e-mail dono da conta Resend. Verifique um domínio no Resend e defina RESEND_FROM.');
            }
            return false;
        }
        return true;
    } catch (err) {
        console.error('Erro no envio de e-mail:', err);
        return false;
    }
}

function addSystemNotification(userEmail, title, message, type = 'assignment', userId = null) {
    if (!userEmail) return;
    const cleanEmail = userEmail.trim().toLowerCase();
    pool.query(
        `INSERT INTO notifications (user_id, user_email, title, message, type, is_read)
         VALUES ($1, $2, $3, $4, $5, 0)`,
        [userId || null, cleanEmail, title, message, type]
    ).then(() => {
        console.log(`🔔 Notificação criada para ${cleanEmail}: ${title}`);
        sendPushToEmail(cleanEmail, title, message);
    }).catch(err => console.error('Erro ao gravar notificação:', err.message));
}

// Push no celular: só para quem registrou o token do app e tem plano Starter/Pro IA (ou é o dono do site).
async function sendPushToEmail(userEmail, title, message) {
    try {
        if (!pushService || !userEmail) return;
        const { rows } = await pool.query(
            `SELECT fcm_token, plan_tier, plan_status FROM users WHERE LOWER(TRIM(email)) = $1 LIMIT 1`,
            [String(userEmail).trim().toLowerCase()]
        );
        const u = rows[0];
        if (!u || !u.fcm_token) return;
        const isOwner = OWNER_EMAIL && String(userEmail).trim().toLowerCase() === OWNER_EMAIL.toLowerCase();
        if (!isOwner && !canUsePushNotifications(u.plan_tier, u.plan_status)) return;
        await pushService.sendPushNotification(u.fcm_token, title, String(message || '').slice(0, 300));
    } catch (err) {
        console.error('Erro ao enviar push:', err.message);
    }
}

const NOTIFICATION_KINDS = {
    event_created: 'Novo evento no calendário',
    contact_added: 'Novo contato no CRM',
    member_added: 'Entrada de pessoas na empresa',
    role_changed: 'Mudança de cargo (ex.: virar gerente)',
    member_removed: 'Remoção da conexão com a empresa',
    request_decision: 'Resposta a pedidos de entrada'
};

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function parseNotifPrefs(raw) {
    let saved = {};
    try { saved = raw ? JSON.parse(raw) : {}; } catch { saved = {}; }
    const prefs = {};
    for (const key of Object.keys(NOTIFICATION_KINDS)) {
        prefs[key] = { panel: saved[key]?.panel !== false, email: saved[key]?.email !== false };
    }
    return prefs;
}

// Entrega a notificação no painel e/ou e-mail conforme o que a pessoa silenciou nas configurações.
async function notifyUser(target, kind, title, message) {
    try {
        if (!target || !target.email || !NOTIFICATION_KINDS[kind]) return;
        const email = String(target.email).trim().toLowerCase();
        const row = await pool.query(
            `SELECT id, name, notif_prefs, company_id FROM users WHERE LOWER(TRIM(email)) = $1 LIMIT 1`,
            [email]
        );
        const user = row.rows[0];
        const prefs = parseNotifPrefs(user?.notif_prefs)[kind];
        if (prefs.panel) {
            addSystemNotification(email, title, message, 'info', target.id || user?.id || null);
        }
        if (prefs.email && user && await companyCanSendEmail(user.company_id, user.id)) {
            await sendMail({
                to: email,
                subject: `${title} - KL Web`,
                html: `
                    <div style="font-family: Arial, sans-serif; padding: 20px; max-width: 550px;">
                        <h2 style="color:#6366f1; margin-top:0;">${escapeHtml(title)}</h2>
                        <p>Olá, <strong>${escapeHtml(decryptData(user?.name) || decryptData(target.name) || 'Colaborador')}</strong>!</p>
                        <p>${escapeHtml(message)}</p>
                        <hr style="border:none; border-top:1px solid #e2e8f0; margin:20px 0;">
                        <small style="color:#64748b;">Você pode silenciar este tipo de aviso em Configurações &gt; Notificações no painel da KL Web.</small>
                    </div>
                `
            });
        }
    } catch (err) {
        console.error('Erro ao notificar usuário:', err.message);
    }
}

async function notifyCompanyMembers(companyId, kind, title, message, excludeUserId = null) {
    try {
        if (!companyId) return;
        const members = await pool.query(
            `SELECT id, email, name FROM users WHERE company_id = $1 AND membership_status = 'ACTIVE' AND id <> $2`,
            [companyId, excludeUserId || 0]
        );
        await Promise.all(decryptUsers(members.rows).map(m => notifyUser(m, kind, title, message)));
    } catch (err) {
        console.error('Erro ao notificar empresa:', err.message);
    }
}

async function notifyAssignedEmployee(employeeEmail, employeeName, demandTitle, priority, assignerName, userId = null, companyId = null) {
    if (!employeeEmail) return;
    const cleanEmail = employeeEmail.trim().toLowerCase();
    const priorityColor = priority === 'URGENTE' ? '#ef4444' : (priority === 'ALTA' ? '#f59e0b' : '#3b82f6');

    addSystemNotification(
        cleanEmail,
        'Nova Tarefa Atribuída',
        `A demanda "${demandTitle}" (Prioridade: ${priority}) foi designada para você por ${assignerName || 'gestor'}.`,
        'assignment',
        userId
    );

    // E-mail só a partir do Starter; o aviso no painel (acima) vale para todos os planos.
    if (!(await companyCanSendEmail(companyId, userId))) return;

    await sendMail({
        to: cleanEmail,
        subject: `Nova Demanda Atribuída a Você: ${demandTitle} - KL Web`,
        html: `
            <div style="font-family: Arial, sans-serif; background-color: #0b0f19; color: #f8fafc; padding: 30px; border-radius: 12px; max-width: 550px; margin: 0 auto; border: 1px solid #38bdf8;">
                <h2 style="color: #6366f1; margin-top: 0;">KL Web - Nova Demanda Designada</h2>
                <p style="font-size: 15px;">Olá, <strong>${employeeName || 'Colaborador'}</strong>!</p>
                <p style="font-size: 14px; color: #cbd5e1; line-height: 1.6;">
                    O gestor <strong>${assignerName || 'da sua equipe'}</strong> atribuiu uma nova demanda para você dar continuidade no painel da empresa:
                </p>
                <div style="background: rgba(255,255,255,0.05); padding: 18px; border-radius: 8px; border-left: 4px solid ${priorityColor}; margin: 20px 0;">
                    <h3 style="margin: 0 0 8px 0; color: #ffffff;">${demandTitle}</h3>
                    <p style="margin: 0; font-size: 13px; color: #94a3b8;">Prioridade: <strong style="color: ${priorityColor};">${priority}</strong></p>
                </div>
                <p style="font-size: 13px; color: #94a3b8;">Acesse o painel da <strong>KL Web</strong> para iniciar ou atualizar o status da demanda.</p>
                <hr style="border: none; border-top: 1px solid #1e293b; margin: 20px 0;">
                <small style="color: #64748b; font-size: 11px;">Notificação automática gerada pela plataforma KL Web sob termos da LGPD.</small>
            </div>
        `
    });
}

// Únicos gatilhos e ações que o servidor de fato executa (ver runAutomations logo abaixo e
// os pontos que chamam runAutomations(...) pelo arquivo). Usado para validar tanto a criação
// manual de regra quanto o que a IA sugere — nenhuma regra é salva fora dessa lista, senão
// vira uma "automação fantasma" que o usuário acha que está ativa mas nunca dispara.
const VALID_AUTOMATION_TRIGGERS = ['DEMAND_CREATED', 'DEMAND_ASSIGNED', 'DEMAND_URGENT', 'DEMAND_COMPLETED', 'EVENT_CREATED', 'CONTACT_ADDED', 'SYSTEM_LOGIN'];
const VALID_AUTOMATION_ACTIONS = ['EMAIL_NOTIFICATION', 'CREATE_EVENT', 'CREATE_DEMAND'];

// isFromAutomation evita loop infinito: uma demanda criada pela ação CREATE_DEMAND de uma
// regra NUNCA dispara DEMAND_CREATED de novo (senão "ao criar demanda -> criar demanda"
// entraria em loop até estourar a memória/conexões do banco).
async function runAutomations(companyId, triggerEvent, contextData, isFromAutomation = false) {
    if (isFromAutomation) return;
    try {
        const result = await pool.query(
            `SELECT * FROM automations
             WHERE company_id = $1 AND is_active = 1 AND trigger_event = $2`,
            [companyId, triggerEvent]
        );

        for (const rule of result.rows) {
            console.log(`[AUTOMAÇÃO KL WEB DISPARADA] Regra "${rule.name}" executada para o evento ${triggerEvent}`);

            if (rule.action_type === 'EMAIL_NOTIFICATION') {
                const targetEmail = rule.action_target === 'ASSIGNED_USER' ? contextData.assigned_user_email : rule.action_target;
                if (targetEmail && await companyCanSendEmail(companyId)) {
                    sendMail({
                        to: targetEmail,
                        subject: `[Automação KL Web] ${rule.name}`,
                        html: `<h3>${rule.name}</h3><p>Demanda: <strong>${contextData.title || ''}</strong></p><p>Status Atual: <strong>${contextData.status || ''}</strong></p>`
                    });
                }
            } else if (rule.action_type === 'CREATE_EVENT') {
                const eventQuota = await getEventQuota(companyId, contextData.user_id || null);
                if (!eventQuota.allowed) {
                    console.log(`[AUTOMAÇÃO] Regra "${rule.name}" não criou o evento: limite de ${eventQuota.limit} eventos do plano gratuito atingido.`);
                } else {
                    const today = new Date().toISOString().split('T')[0];
                    await pool.query(
                        `INSERT INTO events (company_id, user_id, title, event_date, event_time, type, description)
                         VALUES ($1, $2, $3, $4, '10:00', 'LEMBRETE', $5)`,
                        [companyId, contextData.user_id || 1, `[Automação] ${rule.name}: ${contextData.title || ''}`, today, `Gerado pela regra ${rule.name}`]
                    );
                }
            } else if (rule.action_type === 'CREATE_DEMAND') {
                const followUpTitle = (rule.action_payload || '').trim() || `[Automação] ${rule.name}`;
                const assignedEmail = rule.action_target === 'ASSIGNED_USER' ? (contextData.assigned_user_email || null) : (rule.action_target || null);
                const posResult = await pool.query(
                    `SELECT COALESCE(MAX(position), -1) + 1 AS next_position FROM demands WHERE company_id = $1 AND status = 'TODO'`,
                    [companyId]
                );
                const insertResult = await pool.query(
                    `INSERT INTO demands (company_id, user_id, title, description, priority, status, assigned_user_email, position)
                     VALUES ($1, $2, $3, $4, 'MEDIA', 'TODO', $5, $6) RETURNING *`,
                    [companyId, contextData.user_id || null, followUpTitle,
                        `Criada automaticamente pela regra "${rule.name}", disparada por ${triggerEvent}.`,
                        assignedEmail, posResult.rows[0].next_position]
                );
                broadcastBoard(companyId, 'board_demand_created', insertResult.rows[0]);
            }
        }
    } catch (err) {
        console.error('Erro ao executar automações:', err.message);
    }
}

async function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    // Fix: ?token= só permitido para SSE (/stream), nunca logado em req.url
    const allowQueryToken = req.path && (req.path.includes('/stream') || req.path.includes('/sse'));
    const token = (authHeader && authHeader.split(' ')[1]) || (allowQueryToken ? req.query.token : null);

    if (!token) {
        return res.status(401).json({ message: 'Token ausente.' });
    }

    let user;
    try {
        user = jwt.verify(token, JWT_SECRET);
    } catch (err) {
        // 401 (e não 403): o cliente trata 401 como "login inválido" e volta para a tela de entrada.
        // 403 fica reservado para "logado, mas sem permissão".
        return res.status(401).json({
            message: 'Sessão expirada.',
            code: err && err.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID'
        });
    }

    // Mapeamento a partir do token. O PLANO nunca é herdado do token (ele pode estar vencido ou
    // cancelado há dias): se a revalidação no banco abaixo falhar, o usuário cai para BASICO/INACTIVE.
    req.user = user;
    req.user.id = user.id || user.userId;
    req.user.companyId = user.companyId ?? user.company_id ?? null;
    req.user.company_id = req.user.companyId;
    req.user.plan_tier = 'BASICO';
    req.user.planTier = 'BASICO';
    req.user.plan_status = 'INACTIVE';
    req.user.companyRole = 'USER';

    // O pagamento (webhook do Mercado Pago) atualiza o plano direto no banco, mas o token
    // JWT já emitido continua com o plano antigo por até 7 dias. Revalida aqui a cada
    // requisição para que upgrade/downgrade valha imediatamente, sem exigir novo login.
    try {
        const { rows } = await pool.query(
            `SELECT u.name, u.email, u.phone, u.token_version, u.plan_tier, u.plan_status, u.role, u.site_role, u.company_id,
                    u.is_active, u.membership_status, u.email_verified, u.mp_subscription_id,
                    u.free_trial_used, u.trial_end_date,
                    c.owner_id AS company_owner_id, c.name AS company_name
             FROM users u
             LEFT JOIN companies c ON c.id = u.company_id
             WHERE u.id = $1`,
            [req.user.id]
        );
        const dbUser = rows[0];
        if (!dbUser) {
            // Conta apagada: o token ainda é criptograficamente válido por até 7 dias, mas não vale mais.
            return res.status(401).json({ message: 'Conta não encontrada. Faça login novamente.' });
        }

        // Fix: bloqueia usuários inativos e pendentes
        if (dbUser.is_active === 0 || dbUser.is_active === false) {
            return res.status(403).json({ message: 'Conta desativada. Contate o administrador.' });
        }
        if (dbUser.membership_status === 'PENDING') {
            return res.status(403).json({ message: 'Sua conta está aguardando aprovação.' });
        }
        if (dbUser.email_verified != null && Number(dbUser.email_verified) === 0) {
            return res.status(401).json({ message: 'Confirme seu e-mail para continuar.', code: 'EMAIL_NOT_VERIFIED' });
        }

        // Sessão revogada (ex.: e-mail da conta foi trocado em outro aparelho): o token antigo não vale mais.
        if (Number(user.tv || 0) !== Number(dbUser.token_version || 0)) {
            return res.status(401).json({
                message: 'Sua sessão foi encerrada. Entre novamente.',
                code: 'SESSION_REVOKED'
            });
        }

        // Dados de identidade vêm do banco (o token pode estar velho depois de trocar nome/e-mail).
        req.user.email = dbUser.email;
        req.user.name = decryptData(dbUser.name);
        req.user.phone = decryptData(dbUser.phone) || '';
        req.user.companyName = dbUser.company_name || null;
        req.user.tokenVersion = Number(dbUser.token_version || 0);
        req.user.hasSubscription = !!dbUser.mp_subscription_id;
        req.user.freeTrialUsed = !!dbUser.free_trial_used;
        req.user.trialEnd = dbUser.trial_end_date || null;

        const isOwner = req.user.email && req.user.email.toLowerCase() === OWNER_EMAIL.toLowerCase();

        // Inline trial expiry: if the trial window has passed and there's no paid subscription,
        // treat the user as BASICO/INACTIVE immediately (without waiting for the hourly job).
        // The hourly job will update the DB; here we just serve the correct plan to this request.
        let effectivePlanTier = dbUser.plan_tier;
        let effectivePlanStatus = dbUser.plan_status;
        if (
            effectivePlanTier === 'STARTER' &&
            effectivePlanStatus === 'ACTIVE' &&
            dbUser.trial_end_date &&
            new Date(dbUser.trial_end_date) < new Date() &&
            !dbUser.mp_subscription_id
        ) {
            effectivePlanTier = 'BASICO';
            effectivePlanStatus = 'INACTIVE';
            // Fire-and-forget DB update so the next request reads the right value from DB too.
            pool.query(
                `UPDATE users SET plan_tier = 'BASICO', plan_status = 'INACTIVE'
                 WHERE id = $1 AND plan_tier = 'STARTER' AND plan_status = 'ACTIVE'
                   AND trial_end_date IS NOT NULL AND trial_end_date < CURRENT_TIMESTAMP
                   AND (mp_subscription_id IS NULL OR mp_subscription_id = '')`,
                [req.user.id]
            ).catch(e => console.error('Inline trial expiry update failed:', e?.message));
        }

        req.user.plan_status = isOwner ? 'ACTIVE' : (effectivePlanStatus || 'INACTIVE');
        req.user.plan_tier = isOwner ? 'PRO_IA' : effectiveTier(effectivePlanTier, req.user.plan_status);
        req.user.planTier = req.user.plan_tier;
        req.user.role = isOwner ? 'OWNER' : (dbUser.role || req.user.role);
        req.user.siteRole = dbUser.site_role || null;
        req.user.isSiteOwner = !!isOwner;
        req.user.isSiteStaff = !!isOwner || dbUser.role === 'ADMIN' || dbUser.site_role === 'SITE_MANAGER';
        req.user.companyId = dbUser.company_id ?? req.user.companyId;
        req.user.company_id = req.user.companyId;
        req.user.companyRole = Number(dbUser.company_owner_id) === Number(req.user.id)
            ? 'OWNER'
            : (dbUser.role === 'MANAGER' ? 'MANAGER' : dbUser.role === 'OWNER' ? 'OWNER' : 'USER');
    } catch (err) {
        console.error('Erro ao revalidar plano do usuário:', err.message);
        return res.status(503).json({ message: 'Serviço temporariamente indisponível. Tente novamente em instantes.', code: 'DB_UNAVAILABLE' });
    }

    next();
}

function requireCompany(req, res, next) {
    const companyId = req.user?.companyId || req.user?.company_id;
    if (!companyId) {
        return res.status(403).json({
            success: false,
            message: 'Acesso negado: você precisa estar vinculado a uma organização ativa.',
            code: 'COMPANY_REQUIRED'
        });
    }
    req.user.companyId = Number(companyId);
    req.user.company_id = Number(companyId);
    next();
}

async function resolveCompanyPlan(companyId, userId) {
    try {
        if (companyId) {
            const result = await pool.query(
                `SELECT plan_tier, plan_status, email FROM users WHERE company_id = $1`,
                [companyId]
            );
            const activeTiers = result.rows
                .filter((row) => isPlanActive(row.plan_status, row.plan_tier) || (row.email && row.email.toLowerCase() === OWNER_EMAIL.toLowerCase()))
                .map((row) => (row.email && row.email.toLowerCase() === OWNER_EMAIL.toLowerCase() ? 'OWNER' : row.plan_tier));
            if (activeTiers.length > 0) {
                return pickHighestTier(activeTiers);
            }
        }
        if (userId) {
            const self = await pool.query(`SELECT plan_tier, plan_status, email FROM users WHERE id = $1`, [userId]);
            const row = self.rows[0];
            if (row && row.email && row.email.toLowerCase() === OWNER_EMAIL.toLowerCase()) return 'OWNER';
            if (row && isPlanActive(row.plan_status, row.plan_tier)) return normalizePlanTier(row.plan_tier);
        }
    } catch (err) {
        console.error('Erro ao resolver plano da empresa:', err.message);
    }
    return 'BASICO';
}

// Cota de eventos do calendário e permissão de e-mail seguem o plano da EMPRESA (maior plano
// ativo da equipe, ver resolveCompanyPlan), igual ao resto dos limites.
async function getEventQuota(companyId, userId) {
    const tier = await resolveCompanyPlan(companyId, userId);
    const countRes = await pool.query('SELECT COUNT(*) AS count FROM events WHERE company_id = $1', [companyId]);
    const current = parseInt(countRes.rows[0].count, 10);
    return { tier, ...canCreateEvent(tier, current) };
}

function eventLimitMessage(limit) {
    return `O plano gratuito permite até ${limit} eventos no calendário. Assine o Starter para ter calendário ilimitado.`;
}

async function companyCanSendEmail(companyId, userId = null) {
    try {
        return canUseEmailNotifications(await resolveCompanyPlan(companyId, userId));
    } catch (err) {
        console.error('Erro ao verificar plano para e-mail:', err.message);
        return false;
    }
}

app.get('/api/company/validate-code', async (req, res) => {
    const { code } = req.query;
    if (!code) {
        return res.status(400).json({ valid: false, message: 'Código não fornecido.' });
    }

    try {
        const result = await pool.query(
            `SELECT id, name FROM companies WHERE invite_code = $1`,
            [code.trim().toUpperCase()]
        );

        if (result.rows.length > 0) {
            res.json({
                valid: true,
                company: result.rows[0],
                message: 'Código válido!'
            });
        } else {
            res.json({
                valid: false,
                message: 'Código de empresa inválido.'
            });
        }
    } catch (err) {
        console.error('Erro ao validar código:', err.message);
        res.status(500).json({ valid: false, message: 'Erro ao validar código.' });
    }
});

app.get('/api/company/check-name', async (req, res) => {
    const { name } = req.query;
    if (!name) {
        return res.status(400).json({ exists: false, message: 'Nome não fornecido.' });
    }

    try {
        const result = await pool.query(
            `SELECT id FROM companies WHERE LOWER(TRIM(name)) = LOWER(TRIM($1))`,
            [name.trim()]
        );

        res.json({
            exists: result.rows.length > 0,
            message: result.rows.length > 0 ? 'Esta empresa já está cadastrada. Use o código de convite para entrar.' : 'Nome disponível.'
        });
    } catch (err) {
        console.error('Erro ao verificar nome:', err.message);
        res.status(500).json({ exists: false, message: 'Erro ao verificar nome.' });
    }
});

app.post('/api/auth/register', async (req, res) => {
    const { name, email, phone, password, lgpdConsent, companyName, companyCode } = req.body;

    if (!name || !email || !phone || !password) {
        return res.status(400).json({ message: 'Preencha todos os campos obrigatórios.' });
    }
    if (password.length < 4) {
        return res.status(400).json({ message: 'A senha deve ter pelo menos 4 caracteres.' });
    }
    if (!isValidEmail(email)) {
        return res.status(400).json({ message: 'Informe um e-mail válido, por exemplo: nome@gmail.com.' });
    }

    try {
        const cleanEmail = email.trim().toLowerCase();
        // Cadastro antigo desse e-mail que nunca foi confirmado não pode "segurar" o e-mail de
        // quem é o dono de verdade da caixa de entrada: é descartado e o cadastro novo vale.
        await purgeUnverifiedAccount(cleanEmail);
        const hashedPassword = await bcrypt.hash(password, 10);
        const isOwner = cleanEmail === OWNER_EMAIL.toLowerCase();

        let companyId = null;
        let role = 'USER';
        let planTier = 'BASICO';
        let planStatus = 'INACTIVE';
        let membershipStatus = 'ACTIVE';

        if (companyCode) {
            const companyResult = await pool.query(
                `SELECT id, name FROM companies WHERE invite_code = $1`,
                [companyCode.trim().toUpperCase()]
            );

            if (companyResult.rows.length === 0) {
                return res.status(400).json({ message: 'Código de empresa inválido.' });
            }

            companyId = companyResult.rows[0].id;
            role = 'USER';
            planTier = 'BASICO';
            planStatus = 'INACTIVE';
            membershipStatus = 'PENDING';

            await pool.query(`
                INSERT INTO users (name, email, phone, cpf, password, role, is_active, company_id, plan_tier, plan_status, membership_status, lgpd_consent, requested_at, email_verified)
                VALUES ($1, $2, $3, '', $4, $5, 1, $6, $7, $8, $9, $10, CURRENT_TIMESTAMP, 0)
            `, [encryptData(name.trim()), cleanEmail, encryptData(phone.trim()), hashedPassword, role, companyId, planTier, planStatus, membershipStatus, lgpdConsent !== false ? 1 : 0]);

            // O aviso para donos/gerentes só sai depois que o e-mail for confirmado (ver /api/auth/verify-email).
            const verification = await sendVerificationForEmail(cleanEmail);
            console.log(`💾 [POSTGRESQL] Novo usuário cadastrado com código: ${cleanEmail} (aguardando confirmação de e-mail)`);
            return res.status(201).json({
                message: 'Cadastro realizado! Enviamos um código de 6 dígitos para o seu e-mail. Depois de confirmar, sua solicitação aguardará a aprovação do dono ou gerente.',
                requiresVerification: true,
                email: cleanEmail,
                emailSent: verification.sent
            });
        }

        if (companyName) {
            const existingCompany = await pool.query(
                `SELECT id FROM companies WHERE LOWER(TRIM(name)) = LOWER(TRIM($1))`,
                [companyName.trim()]
            );

            if (existingCompany.rows.length > 0) {
                return res.status(400).json({
                    message: 'Esta empresa já está cadastrada. Use o código de convite para entrar como funcionário.'
                });
            }

            const newCompanyCode = generateCompanyCode();
            role = isOwner ? 'OWNER' : 'MANAGER';
            planTier = isOwner ? 'PRO_IA' : 'BASICO';
            planStatus = isOwner ? 'ACTIVE' : 'INACTIVE';

            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                const companyResult = await client.query(
                    `INSERT INTO companies (name, invite_code) VALUES ($1, $2) RETURNING id`,
                    [companyName.trim(), newCompanyCode]
                );
                companyId = companyResult.rows[0].id;
                const userResult = await client.query(`
                    INSERT INTO users (name, email, phone, cpf, password, role, is_active, company_id, plan_tier, plan_status, lgpd_consent, email_verified)
                    VALUES ($1, $2, $3, '', $4, $5, 1, $6, $7, $8, $9, 0)
                    RETURNING id
                `, [encryptData(name.trim()), cleanEmail, encryptData(phone.trim()), hashedPassword, role, companyId, planTier, planStatus, lgpdConsent !== false ? 1 : 0]);
                await client.query(
                    'UPDATE companies SET owner_id = $1 WHERE id = $2',
                    [userResult.rows[0].id, companyId]
                );
                await client.query('COMMIT');
            } catch (err) {
                await client.query('ROLLBACK').catch(() => { });
                throw err;
            } finally {
                client.release();
            }

            console.log(`💾 [POSTGRESQL] Nova empresa criada: ${companyName} com código: ${newCompanyCode}`);
            console.log(`💾 [POSTGRESQL] Novo usuário salvo com sucesso: ${cleanEmail} (Role: ${role})`);
            const verification = await sendVerificationForEmail(cleanEmail);
            return res.status(201).json({
                message: `Cadastro quase pronto! Enviamos um código de 6 dígitos para o seu e-mail. Confirme para ativar a conta. O código da sua empresa é: ${newCompanyCode}`,
                companyCode: newCompanyCode,
                requiresVerification: true,
                email: cleanEmail,
                emailSent: verification.sent
            });
        }

        const defaultCompanyCode = generateCompanyCode();
        role = isOwner ? 'OWNER' : 'MANAGER';
        planTier = isOwner ? 'PRO_IA' : 'BASICO';
        planStatus = isOwner ? 'ACTIVE' : 'INACTIVE';

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const companyResult = await client.query(
                `INSERT INTO companies (name, invite_code) VALUES ($1, $2) RETURNING id`,
                [`Workspace de ${name.trim()}`, defaultCompanyCode]
            );
            companyId = companyResult.rows[0].id;
            const userResult = await client.query(`
                INSERT INTO users (name, email, phone, cpf, password, role, is_active, company_id, plan_tier, plan_status, lgpd_consent, email_verified)
                VALUES ($1, $2, $3, '', $4, $5, 1, $6, $7, $8, $9, 0)
                RETURNING id
            `, [encryptData(name.trim()), cleanEmail, encryptData(phone.trim()), hashedPassword, role, companyId, planTier, planStatus, lgpdConsent !== false ? 1 : 0]);
            await client.query(
                'UPDATE companies SET owner_id = $1 WHERE id = $2',
                [userResult.rows[0].id, companyId]
            );
            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK').catch(() => { });
            throw err;
        } finally {
            client.release();
        }

        console.log(`💾 [POSTGRESQL] Novo usuário salvo com sucesso: ${cleanEmail}`);
        const verification = await sendVerificationForEmail(cleanEmail);
        res.status(201).json({
            message: 'Cadastro quase pronto! Enviamos um código de 6 dígitos para o seu e-mail. Confirme para ativar a conta.',
            requiresVerification: true,
            email: cleanEmail,
            emailSent: verification.sent
        });
    } catch (e) {
        if (e.code === '23505') {
            return res.status(400).json({ message: 'Este e-mail já está cadastrado no sistema.' });
        }
        console.error('Erro ao salvar cadastro no PostgreSQL:', e.message);
        console.error('Stack trace:', e.stack);
        res.status(500).json({ message: 'Erro ao salvar cadastro no banco de dados.', error: e.message });
    }
});

// ==================== CONFIRMAÇÃO DE E-MAIL POR CÓDIGO ====================
const EMAIL_CODE_TTL_MS = 15 * 60 * 1000;      // o código vale 15 minutos
const EMAIL_CODE_COOLDOWN_MS = 60 * 1000;      // intervalo mínimo entre envios
const EMAIL_CODE_MAX_ATTEMPTS = 5;             // erros permitidos por código

function hashVerificationCode(userId, code) {
    // HMAC com o segredo do servidor: o código nunca fica salvo em texto puro no banco.
    return crypto.createHmac('sha256', JWT_SECRET).update(`email-verify:${userId}:${code}`).digest('hex');
}

// Gera um código novo, grava só o hash e envia por e-mail. Devolve { sent, cooldown }.
async function sendVerificationCode(userId, email, name, { force = false } = {}) {
    const now = Date.now();
    if (!force) {
        const cur = await pool.query('SELECT last_sent_at FROM email_verifications WHERE user_id = $1', [userId]);
        if (cur.rows[0] && now - Number(cur.rows[0].last_sent_at) < EMAIL_CODE_COOLDOWN_MS) {
            return { sent: false, cooldown: true };
        }
    }
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    await pool.query(
        `INSERT INTO email_verifications (user_id, code_hash, expires_at, attempts, last_sent_at)
         VALUES ($1, $2, $3, 0, $4)
         ON CONFLICT (user_id) DO UPDATE
         SET code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at, attempts = 0, last_sent_at = EXCLUDED.last_sent_at`,
        [userId, hashVerificationCode(userId, code), now + EMAIL_CODE_TTL_MS, now]
    );
    const firstName = escapeHtml(String(name || '').trim().split(' ')[0] || 'tudo bem');
    const sent = await sendMail({
        to: email,
        subject: `${code} é o seu código de confirmação da KL Web`,
        html: `<div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
            <h2 style="margin: 0 0 12px;">Olá, ${firstName}!</h2>
            <p style="color: #475569; line-height: 1.6;">Use o código abaixo para confirmar seu e-mail e ativar seu cadastro na KL Web:</p>
            <p style="font-size: 34px; font-weight: 700; letter-spacing: 10px; text-align: center; background: #f1f5f9; border-radius: 10px; padding: 16px; margin: 20px 0;">${code}</p>
            <p style="color: #64748b; font-size: 13px; line-height: 1.5;">O código vale por 15 minutos. Se você não criou uma conta na KL Web, ignore esta mensagem.</p>
        </div>`
    });
    return { sent: !!sent };
}

async function sendVerificationForEmail(cleanEmail) {
    try {
        const r = await pool.query('SELECT id, name, email FROM users WHERE LOWER(TRIM(email)) = $1', [cleanEmail]);
        if (!r.rows[0]) return { sent: false };
        return await sendVerificationCode(r.rows[0].id, r.rows[0].email, r.rows[0].name, { force: true });
    } catch (err) {
        console.error('Erro ao enviar código de confirmação:', err.message);
        return { sent: false };
    }
}

// Remove cadastros do mesmo e-mail que nunca foram confirmados (sem dados, já que não puderam entrar).
async function purgeUnverifiedAccount(cleanEmail) {
    try {
        const r = await pool.query('SELECT id, company_id FROM users WHERE LOWER(TRIM(email)) = $1 AND email_verified = 0', [cleanEmail]);
        for (const u of r.rows) {
            await pool.query('DELETE FROM email_verifications WHERE user_id = $1', [u.id]);
            await pool.query('UPDATE companies SET owner_id = NULL WHERE owner_id = $1', [u.id]);
            await pool.query('DELETE FROM notifications WHERE user_id = $1', [u.id]);
            await pool.query('DELETE FROM users WHERE id = $1', [u.id]);
            if (u.company_id) {
                await pool.query(
                    'DELETE FROM companies WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM users WHERE company_id = $1)',
                    [u.company_id]
                );
            }
        }
    } catch (err) {
        console.warn('Não foi possível limpar cadastro não confirmado:', err.message);
    }
}

app.post('/api/auth/verify-email', async (req, res) => {
    const cleanEmail = String(req.body?.email || '').trim().toLowerCase();
    const code = String(req.body?.code || '').replace(/\D/g, '');
    if (!cleanEmail || code.length !== 6) {
        return res.status(400).json({ success: false, message: 'Informe o código de 6 dígitos.' });
    }

    try {
        const r = await pool.query(
            'SELECT id, name, email, email_verified, membership_status, company_id FROM users WHERE LOWER(TRIM(email)) = $1',
            [cleanEmail]
        );
        const user = r.rows[0];
        if (!user) {
            return res.status(400).json({ success: false, code: 'VERIFY_RESTART', message: 'Código inválido ou expirado. Peça um novo código.' });
        }
        if (user.email_verified == null || Number(user.email_verified) !== 0) {
            return res.json({ success: true, message: 'Seu e-mail já estava confirmado. Faça login.' });
        }

        // Conta a tentativa ANTES de comparar (atômico): impede adivinhar o código em requisições paralelas.
        const upd = await pool.query(
            `UPDATE email_verifications SET attempts = attempts + 1
             WHERE user_id = $1 AND attempts < $2 AND expires_at > $3
             RETURNING code_hash, attempts`,
            [user.id, EMAIL_CODE_MAX_ATTEMPTS, Date.now()]
        );
        if (upd.rowCount === 0) {
            return res.status(400).json({ success: false, code: 'VERIFY_RESTART', message: 'O código expirou ou excedeu o limite de tentativas. Peça um novo código.' });
        }

        const expected = Buffer.from(upd.rows[0].code_hash, 'hex');
        const given = Buffer.from(hashVerificationCode(user.id, code), 'hex');
        if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
            const remaining = Math.max(0, EMAIL_CODE_MAX_ATTEMPTS - Number(upd.rows[0].attempts));
            return res.status(400).json({
                success: false,
                code: remaining === 0 ? 'VERIFY_RESTART' : 'VERIFY_WRONG_CODE',
                message: remaining === 0
                    ? 'Código incorreto. Você usou todas as tentativas: peça um novo código.'
                    : `Código incorreto. Você ainda tem ${remaining} tentativa${remaining === 1 ? '' : 's'}.`
            });
        }

        await pool.query('UPDATE users SET email_verified = 1 WHERE id = $1', [user.id]);
        await pool.query('DELETE FROM email_verifications WHERE user_id = $1', [user.id]);

        // Auto-activates 7-day STARTER trial for new independent accounts (non-company-code joiners).
        // Company employees wait for owner approval, so they don't get the trial here.
        if (!user.membership_status || user.membership_status !== 'PENDING') {
            const trialEnd = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
            const trialActivated = await pool.query(
                `UPDATE users SET
                    plan_tier = 'STARTER', plan_status = 'ACTIVE',
                    free_trial_used = TRUE,
                    trial_start_date = CURRENT_TIMESTAMP,
                    trial_end_date = $2
                 WHERE id = $1 AND free_trial_used IS NOT TRUE`,
                [user.id, trialEnd]
            );
            if (trialActivated.rowCount > 0) {
                console.log(`🎁 Trial de 7 dias ativado automaticamente para ${user.email} — termina em ${trialEnd.toISOString()}`);
                scheduleTrialReminder(user.id, trialEnd).catch(err =>
                    console.error('Erro ao agendar lembrete do trial:', err?.message || err));
            }
        }

        let message = 'E-mail confirmado! Agora é só fazer login.';
        if (user.membership_status === 'PENDING' && user.company_id) {
            // Quem entrou por código de empresa: só agora avisa donos e gerentes.
            await pool.query(`
                INSERT INTO notifications (user_id, user_email, title, message, type)
                SELECT id, email, 'Nova Solicitação de Entrada',
                       'O usuário ' || $1 || ' (' || $2 || ') solicitou entrada na empresa usando o código de convite.',
                       'approval_request'
                FROM users
                WHERE company_id = $3 AND role IN ('OWNER', 'MANAGER') AND id != $4
            `, [user.name, user.email, user.company_id, user.id]);
            emailOwnerAboutJoinRequest(user.company_id, user.id, user.name, user.email);
            message = 'E-mail confirmado! Sua solicitação foi enviada e aguarda a aprovação do dono ou gerente da empresa.';
        }
        console.log(`✅ [POSTGRESQL] E-mail confirmado: ${user.email}`);
        return res.json({ success: true, message });
    } catch (err) {
        console.error('Erro ao confirmar e-mail:', err.message);
        return res.status(500).json({ success: false, message: 'Erro ao confirmar o e-mail. Tente novamente.' });
    }
});

app.post('/api/auth/resend-verification', async (req, res) => {
    const cleanEmail = String(req.body?.email || '').trim().toLowerCase();
    if (!cleanEmail) return res.status(400).json({ success: false, message: 'Informe o e-mail.' });
    try {
        const r = await pool.query(
            'SELECT id, name, email FROM users WHERE LOWER(TRIM(email)) = $1 AND email_verified = 0',
            [cleanEmail]
        );
        // Resposta igual para e-mail inexistente ou já confirmado (não revela quais e-mails têm conta).
        if (!r.rows[0]) return res.json({ success: true });
        const result = await sendVerificationCode(r.rows[0].id, r.rows[0].email, r.rows[0].name);
        if (result.cooldown) {
            return res.status(429).json({ success: false, message: 'Aguarde um minuto para pedir outro código.' });
        }
        if (!result.sent) {
            return res.status(502).json({ success: false, message: 'Não foi possível enviar o e-mail agora. Tente novamente em instantes.' });
        }
        return res.json({ success: true });
    } catch (err) {
        console.error('Erro ao reenviar código:', err.message);
        return res.status(500).json({ success: false, message: 'Erro ao reenviar o código.' });
    }
});

// ==================== 2FA (TOTP) — helpers ====================
// O token "pendente" (emitido após a senha correta, antes do código) usa um segredo
// DIFERENTE do JWT de sessão. Assim ele nunca é aceito pelo authenticateToken.
const TWOFA_PENDING_SECRET = `${JWT_SECRET}:2fa-pending`;

function buildLoginResponse(rawUser) {
    const user = decryptUser(rawUser);
    const cleanEmail = String(user.email || '').trim().toLowerCase();
    let role = user.role;
    let planTier = user.plan_tier;
    let planStatus = user.plan_status || 'INACTIVE';
    const companyRole = Number(user.company_owner_id) === Number(user.id) || user.role === 'OWNER'
        ? 'OWNER'
        : user.role === 'MANAGER' ? 'MANAGER' : 'USER';
    if (cleanEmail === OWNER_EMAIL.toLowerCase()) {
        role = 'OWNER';
        planTier = 'PRO_IA';
        planStatus = 'ACTIVE';
    }

    // Apply inline trial expiry so the first login response already reflects the correct plan.
    const trialEndRaw = user.trial_end_date || null;
    let resolvedTier = planTier;
    let resolvedStatus = planStatus;
    if (
        resolvedTier === 'STARTER' &&
        resolvedStatus === 'ACTIVE' &&
        trialEndRaw &&
        new Date(trialEndRaw) < new Date() &&
        !user.mp_subscription_id
    ) {
        resolvedTier = 'BASICO';
        resolvedStatus = 'INACTIVE';
    }

    const token = jwt.sign(
        { id: user.id, email: user.email, name: user.name, companyId: user.company_id, role, companyRole, planTier: resolvedTier, tv: Number(user.token_version || 0) },
        JWT_SECRET,
        { expiresIn: '7d' }
    );

    return {
        token, user: {
            id: user.id, name: user.name, email: user.email, phone: user.phone,
            role, companyRole, companyId: user.company_id, companyName: user.company_name || 'Meu Workspace',
            planTier: resolvedTier, planStatus: resolvedStatus,
            hasSubscription: !!user.mp_subscription_id,
            freeTrialUsed: !!user.free_trial_used,
            trialEnd: trialEndRaw ? new Date(trialEndRaw).toISOString() : null,
            aiUsageCount: user.ai_usage_count || 0,
            isSiteOwner: cleanEmail === OWNER_EMAIL.toLowerCase(),
            isSiteStaff: cleanEmail === OWNER_EMAIL.toLowerCase() || user.role === 'ADMIN' || user.site_role === 'SITE_MANAGER',
            siteRole: user.site_role || null
        }
    };
}

app.get('/api/auth/me', authenticateToken, (req, res) => {
    // Renovação deslizante: quem usa o site com frequência não é deslogado a cada 7 dias.
    // Quando restam menos de 3 dias, devolve um token novo (mais 7 dias) junto com os dados.
    let refreshedToken = null;
    const secondsLeft = Number(req.user.exp) - Math.floor(Date.now() / 1000);
    if (Number.isFinite(secondsLeft) && secondsLeft < 3 * 24 * 60 * 60) {
        refreshedToken = jwt.sign(
            {
                id: req.user.id, email: req.user.email, name: req.user.name,
                companyId: req.user.companyId, role: req.user.role,
                companyRole: req.user.companyRole, planTier: req.user.plan_tier,
                tv: req.user.tokenVersion || 0
            },
            JWT_SECRET,
            { expiresIn: '7d' }
        );
    }
    res.json({
        ...(refreshedToken ? { token: refreshedToken } : {}),
        user: {
            id: req.user.id,
            name: req.user.name,
            email: req.user.email,
            phone: req.user.phone || '',
            role: req.user.role,
            companyRole: req.user.companyRole,
            companyId: req.user.companyId,
            companyName: req.user.companyName || 'Meu Workspace',
            planTier: req.user.plan_tier,
            planStatus: req.user.plan_status,
            hasSubscription: !!req.user.hasSubscription,
            freeTrialUsed: !!req.user.freeTrialUsed,
            trialEnd: req.user.trialEnd ? new Date(req.user.trialEnd).toISOString() : null,
            isSiteOwner: String(req.user.email || '').toLowerCase() === OWNER_EMAIL.toLowerCase(),
            isSiteStaff: !!req.user.isSiteStaff,
            siteRole: req.user.siteRole || null
        }
    });
});

// Limite de tentativas de código por usuário (5 a cada 10 min), além do limite por IP.
const totpAttempts = new Map();
function totpRateLimited(key, max = 5, windowMs = 10 * 60 * 1000) {
    const now = Date.now();
    let rec = totpAttempts.get(key);
    if (!rec || now > rec.resetAt) {
        rec = { count: 0, resetAt: now + windowMs };
        totpAttempts.set(key, rec);
    }
    rec.count += 1;
    return rec.count > max;
}
setInterval(() => {
    const now = Date.now();
    for (const [k, v] of totpAttempts) if (now > v.resetAt) totpAttempts.delete(k);
}, 10 * 60 * 1000).unref();

/**
 * Confere o 2º fator: código de 6 dígitos do app OU código de backup (uso único).
 * As atualizações são condicionais no SQL, então o mesmo código não vale duas vezes
 * nem mesmo em requisições simultâneas.
 */
async function verifySecondFactor(user, code) {
    const clean = String(code || '').replace(/\s+/g, '');

    if (/^\d{6}$/.test(clean)) {
        const secret = totp.decryptSecret(user.totp_secret_enc);
        const step = totp.verifyTotp(secret, clean, { lastStep: user.totp_last_step });
        if (step === null) return false;
        const upd = await pool.query(
            `UPDATE users SET totp_last_step = $1
             WHERE id = $2 AND (totp_last_step IS NULL OR totp_last_step < $1)`,
            [step, user.id]
        );
        return upd.rowCount === 1;
    }

    let hashes = [];
    try { hashes = JSON.parse(user.totp_backup_codes || '[]'); } catch (e) { hashes = []; }
    const remaining = totp.consumeBackupCode(hashes, clean);
    if (remaining === null) return false;
    const upd = await pool.query(
        `UPDATE users SET totp_backup_codes = $1 WHERE id = $2 AND totp_backup_codes = $3`,
        [JSON.stringify(remaining), user.id, user.totp_backup_codes]
    );
    return upd.rowCount === 1;
}

app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ message: 'Preencha o e-mail e a senha para entrar.' });
    }

    // Validar email
    if (!validateEmail(email)) {
        return res.status(400).json({ message: 'E-mail inválido.' });
    }

    const cleanEmail = email.trim().toLowerCase();

    // Rastrear tentativas de login
    const loginAttempt = trackLoginAttempt(cleanEmail);
    if (loginAttempt.blocked) {
        logSecurityEvent('LOGIN_BLOCKED', req, { email: cleanEmail });
        const remainingMinutes = Math.ceil(loginAttempt.remainingTime / 60000);
        return res.status(429).json({
            message: `Muitas tentativas de login. Tente novamente em ${remainingMinutes} minutos.`
        });
    }

    try {
        const result = await pool.query(`
            SELECT u.*, c.name AS company_name, c.owner_id AS company_owner_id
            FROM users u
            LEFT JOIN companies c ON u.company_id = c.id
            WHERE LOWER(TRIM(u.email)) = $1
        `, [cleanEmail]);
        const user = result.rows[0];

        // Mesma mensagem/status tanto para e-mail inexistente quanto para senha errada,
        // para não permitir descobrir quais e-mails têm conta na plataforma.
        if (!user) {
            logSecurityEvent('LOGIN_EMAIL_NOT_FOUND', req, { email: cleanEmail });
            return res.status(401).json({ message: 'E-mail ou senha incorretos.' });
        }

        // A senha é conferida PRIMEIRO: antes disso, nenhuma resposta revela o estado da conta.
        if (!await bcrypt.compare(password, user.password)) {
            logSecurityEvent('LOGIN_PASSWORD_WRONG', req, { email: cleanEmail });
            return res.status(401).json({ message: 'E-mail ou senha incorretos.' });
        }

        // Limpar tentativas de login bem-sucedidas
        clearLoginAttempt(cleanEmail);

        // E-mail ainda não confirmado: reenvia um código (respeitando o intervalo mínimo) e deixa o
        // front abrir a tela do código.
        if (user.email_verified != null && Number(user.email_verified) === 0) {
            sendVerificationCode(user.id, user.email, decryptData(user.name)).catch(() => { });
            return res.status(403).json({
                code: 'EMAIL_NOT_VERIFIED',
                email: user.email,
                message: 'Confirme seu e-mail para entrar. Enviamos um código de 6 dígitos para a sua caixa de entrada.'
            });
        }
        if (user.is_active === 0 || user.is_active === false) {
            return res.status(403).json({ message: 'Conta desativada. Contate o administrador.' });
        }
        if (user.membership_status === 'PENDING') {
            return res.status(403).json({ message: 'Sua conta está aguardando aprovação do dono ou gerente da empresa.' });
        }

        // Senha correta. Se o usuário ativou o 2FA, NÃO emitimos o token de sessão ainda:
        // devolvemos um token pendente (5 min) e o front pede o código do autenticador.
        if (user.totp_enabled) {
            const twoFactorToken = jwt.sign({ id: user.id, purpose: '2fa-login' }, TWOFA_PENDING_SECRET, { expiresIn: '5m' });
            auditLog(req, 'LOGIN_AGUARDANDO_2FA', user.id, user.email);
            logSecurityEvent('LOGIN_2FA_REQUIRED', req, { email: cleanEmail });
            return res.json({ requires2FA: true, twoFactorToken });
        }

        logSecurityEvent('LOGIN_SUCCESS', req, { email: cleanEmail });
        res.json(buildLoginResponse(user));
        runAutomations(user.company_id, 'SYSTEM_LOGIN', { title: decryptData(user.name) || user.email, status: 'Login realizado', user_id: user.id });
    } catch (err) {
        console.error('Erro ao consultar PostgreSQL:', err.message);
        res.status(500).json({ message: 'Erro ao consultar banco de dados.' });
    }
});

// ==================== 2FA (TOTP) — rotas ====================
// Etapa 2 do login: recebe o token pendente + código e só então emite o JWT de sessão.
// (Caminho fora de /api/auth/login de propósito: aquele prefixo tem o authLimiter de 10/15min por IP.)
app.post('/api/auth/2fa/totp/login', async (req, res) => {
    const { twoFactorToken, code } = req.body;
    if (!twoFactorToken || !code) {
        return res.status(400).json({ message: 'Informe o código de verificação.' });
    }

    let pending;
    try {
        pending = jwt.verify(twoFactorToken, TWOFA_PENDING_SECRET);
        if (pending.purpose !== '2fa-login') throw new Error('purpose inválido');
    } catch (e) {
        return res.status(401).json({ message: 'A verificação expirou. Faça login novamente.', restart: true });
    }

    const rlKey = `login:${pending.id}`;
    if (totpRateLimited(rlKey)) {
        return res.status(429).json({ message: 'Muitas tentativas incorretas. Aguarde alguns minutos e tente novamente.' });
    }

    try {
        const result = await pool.query(`
            SELECT u.*, c.name AS company_name, c.owner_id AS company_owner_id
            FROM users u
            LEFT JOIN companies c ON u.company_id = c.id
            WHERE u.id = $1
        `, [pending.id]);
        const user = result.rows[0];

        if (!user || !user.totp_enabled) {
            return res.status(401).json({ message: 'A verificação expirou. Faça login novamente.', restart: true });
        }
        if (user.is_active === 0 || user.is_active === false) {
            return res.status(403).json({ message: 'Conta desativada. Contate o administrador.' });
        }

        if (user.membership_status === 'PENDING') {
            return res.status(403).json({ message: 'Sua conta está aguardando aprovação do dono ou gerente da empresa.' });
        }

        if (!await verifySecondFactor(user, code)) {
            auditLog(req, 'LOGIN_2FA_CODIGO_INVALIDO', user.id, user.email);
            return res.status(400).json({ message: 'Código incorreto ou já utilizado. Tente novamente.' });
        }

        totpAttempts.delete(rlKey);
        auditLog(req, 'LOGIN_2FA_SUCESSO', user.id, user.email);
        res.json(buildLoginResponse(user));
        runAutomations(user.company_id, 'SYSTEM_LOGIN', { title: user.name || user.email, status: 'Login realizado', user_id: user.id });
        return;
    } catch (err) {
        console.error('Erro no login 2FA:', err.message);
        return res.status(500).json({ message: 'Erro ao validar o código de verificação.' });
    }
});

app.get('/api/auth/2fa/totp/status', authenticateToken, async (req, res) => {
    try {
        const { rows } = await pool.query(
            'SELECT totp_enabled, totp_backup_codes FROM users WHERE id = $1', [req.user.id]
        );
        if (!rows[0]) return res.status(404).json({ message: 'Usuário não encontrado.' });
        let remaining = 0;
        try { remaining = JSON.parse(rows[0].totp_backup_codes || '[]').length; } catch (e) { /* ignora */ }
        res.json({ enabled: !!rows[0].totp_enabled, backupCodesRemaining: remaining });
    } catch (err) {
        console.error('Erro ao consultar status 2FA:', err.message);
        res.status(500).json({ message: 'Erro ao consultar o status do 2FA.' });
    }
});

// Passo 1 da ativação: gera o segredo (ainda NÃO ativa) e devolve o link para o QR Code.
app.post('/api/auth/2fa/totp/setup', authenticateToken, async (req, res) => {
    try {
        const { rows } = await pool.query('SELECT email, totp_enabled FROM users WHERE id = $1', [req.user.id]);
        const user = rows[0];
        if (!user) return res.status(404).json({ message: 'Usuário não encontrado.' });
        if (user.totp_enabled) {
            return res.status(400).json({ message: 'O 2FA já está ativado. Desative-o antes de configurar novamente.' });
        }

        const secret = totp.generateSecret();
        await pool.query(
            `UPDATE users SET totp_secret_enc = $1, totp_enabled = FALSE, totp_last_step = NULL, totp_backup_codes = NULL WHERE id = $2`,
            [totp.encryptSecret(secret), req.user.id]
        );

        res.json({ secret, otpauthUrl: totp.buildOtpAuthUrl({ secret, account: user.email, issuer: 'KL Web' }) });
    } catch (err) {
        console.error('Erro ao iniciar 2FA:', err.message);
        res.status(500).json({ message: err.message.includes('TOTP_ENCRYPTION_KEY') ? err.message : 'Erro ao iniciar a configuração do 2FA.' });
    }
});

// Passo 2: o usuário digita o 1º código do app; se bater, o 2FA é ativado e os códigos de backup são exibidos (uma única vez).
app.post('/api/auth/2fa/totp/enable', authenticateToken, async (req, res) => {
    const { code } = req.body;
    if (!code) return res.status(400).json({ message: 'Informe o código de 6 dígitos do aplicativo.' });

    const rlKey = `enable:${req.user.id}`;
    if (totpRateLimited(rlKey)) {
        return res.status(429).json({ message: 'Muitas tentativas incorretas. Aguarde alguns minutos.' });
    }

    try {
        const { rows } = await pool.query(
            'SELECT id, totp_enabled, totp_secret_enc FROM users WHERE id = $1', [req.user.id]
        );
        const user = rows[0];
        if (!user) return res.status(404).json({ message: 'Usuário não encontrado.' });
        if (user.totp_enabled) return res.status(400).json({ message: 'O 2FA já está ativado.' });
        if (!user.totp_secret_enc) return res.status(400).json({ message: 'Inicie a configuração do 2FA primeiro.' });

        const step = totp.verifyTotp(totp.decryptSecret(user.totp_secret_enc), code);
        if (step === null) {
            return res.status(400).json({ message: 'Código incorreto. Confira o app e a hora do celular e tente de novo.' });
        }

        const backupCodes = totp.generateBackupCodes(8);
        await pool.query(
            `UPDATE users SET totp_enabled = TRUE, totp_last_step = $1, totp_backup_codes = $2 WHERE id = $3`,
            [step, JSON.stringify(backupCodes.map(totp.hashBackupCode)), req.user.id]
        );

        totpAttempts.delete(rlKey);
        auditLog(req, '2FA_TOTP_ATIVADO');
        res.json({ success: true, backupCodes });
    } catch (err) {
        console.error('Erro ao ativar 2FA:', err.message);
        res.status(500).json({ message: 'Erro ao ativar o 2FA.' });
    }
});

// Desativar exige senha E um código válido (app ou backup), para que uma sessão roubada não consiga desligar o 2FA.
app.post('/api/auth/2fa/totp/disable', authenticateToken, async (req, res) => {
    const { password, code } = req.body;
    if (!password || !code) return res.status(400).json({ message: 'Informe a senha e um código de verificação.' });

    const rlKey = `disable:${req.user.id}`;
    if (totpRateLimited(rlKey)) {
        return res.status(429).json({ message: 'Muitas tentativas incorretas. Aguarde alguns minutos.' });
    }

    try {
        const { rows } = await pool.query(
            'SELECT id, password, totp_enabled, totp_secret_enc, totp_last_step, totp_backup_codes FROM users WHERE id = $1',
            [req.user.id]
        );
        const user = rows[0];
        if (!user) return res.status(404).json({ message: 'Usuário não encontrado.' });
        if (!user.totp_enabled) return res.status(400).json({ message: 'O 2FA não está ativado.' });

        if (!await bcrypt.compare(password, user.password)) {
            return res.status(400).json({ message: 'Senha incorreta.' });
        }
        if (!await verifySecondFactor(user, code)) {
            return res.status(400).json({ message: 'Código incorreto ou já utilizado.' });
        }

        await pool.query(
            `UPDATE users SET totp_enabled = FALSE, totp_secret_enc = NULL, totp_last_step = NULL, totp_backup_codes = NULL WHERE id = $1`,
            [req.user.id]
        );
        totpAttempts.delete(rlKey);
        auditLog(req, '2FA_TOTP_DESATIVADO');
        res.json({ success: true });
    } catch (err) {
        console.error('Erro ao desativar 2FA:', err.message);
        res.status(500).json({ message: 'Erro ao desativar o 2FA.' });
    }
});

app.post('/api/company/plan', authenticateToken, async (req, res) => {
    const { planTier, amount, gateway } = req.body;
    const MERCHANT_CPF = process.env.NUPAY_MERCHANT_CPF;
    if (!MERCHANT_CPF) {
        return res.status(500).json({ message: 'Pagamento via NuPay não está configurado (NUPAY_MERCHANT_CPF ausente).' });
    }
    const normalizedPlanTier = planTier === 'PRO_PME' ? 'STARTER' : planTier === 'CORPORATE' ? 'PRO_IA' : planTier;

    if (!['STARTER', 'PRO_IA'].includes(normalizedPlanTier)) {
        return res.status(400).json({ message: 'Plano inválido para checkout.' });
    }

    // Preço definido no servidor: o valor enviado pelo cliente (amount) é ignorado.
    const price = PLAN_PRICES[normalizedPlanTier];

    if (gateway === 'mercadopago') {
        if (!mpClient) {
            return res.status(500).json({ message: 'Mercado Pago não configurado no .env' });
        }

        try {
            const preference = new Preference(mpClient);
            const result = await preference.create({
                body: {
                    items: [
                        {
                            id: normalizedPlanTier,
                            title: `Assinatura Mensal ${normalizedPlanTier.replace('_', ' ')} - KL Web`,
                            quantity: 1,
                            currency_id: 'BRL',
                            unit_price: price
                        }
                    ],
                    payer: {
                        email: req.user.email,
                        name: req.user.name
                    },
                    payment_methods: {
                        installments: 1,
                        default_installments: 1
                    },
                    external_reference: JSON.stringify({ email: req.user.email, plan_tier: normalizedPlanTier, billing: 'MONTHLY' }),
                    back_urls: {
                        success: 'https://klweb.com.br/sucesso',
                        failure: 'https://klweb.com.br/cancelado'
                    },
                    auto_return: 'approved'
                }
            });

            return res.json({
                success: true,
                paymentUrl: result.init_point
            });
        } catch (err) {
            console.error(err);
            return res.status(500).json({ message: 'Erro na comunicação com o Mercado Pago.' });
        }
    }

    const NUPAY_BASE_URL = 'https://sandbox-api.spinpay.com.br';
    const MERCHANT_KEY = process.env.NUPAY_MERCHANT_KEY || 'SEU_X_MERCHANT_KEY';
    const MERCHANT_TOKEN = process.env.NUPAY_MERCHANT_TOKEN || 'SEU_X_MERCHANT_TOKEN';

    try {
        const referenceId = `REF_${Date.now()}`;
        const nameParts = (req.user.name || 'Cliente KL Web').trim().split(' ');

        const payload = {
            merchantOrderReference: `ORDER_${Date.now()}`,
            referenceId: referenceId,
            merchantName: 'KL Web',
            amount: { value: price, currency: 'BRL' },
            paymentMethod: { type: 'nupay', authorizationType: 'manually_authorized' },
            paymentFlow: {
                returnUrl: 'https://klweb.com.br/sucesso',
                cancelUrl: 'https://klweb.com.br/cancelado'
            },
            shopper: {
                firstName: nameParts[0],
                lastName: nameParts.slice(1).join(' ') || 'Cliente',
                document: MERCHANT_CPF,
                documentType: 'CPF',
                email: req.user.email
            },
            items: [
                {
                    id: `PLAN_${normalizedPlanTier}`,
                    description: `Assinatura Plano ${normalizedPlanTier.replace('_', ' ')}`,
                    value: price,
                    quantity: 1
                }
            ],
            callbackUrl: 'https://klweb.com.br/api/webhooks/nupay'
        };

        const response = await fetch(`${NUPAY_BASE_URL}/v1/checkouts/payments`, {
            method: 'POST',
            headers: {
                'X-Merchant-Key': MERCHANT_KEY,
                'X-Merchant-Token': MERCHANT_TOKEN,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        const data = await response.json();

        if (response.ok && data.paymentUrl) {
            return res.json({
                success: true,
                paymentUrl: data.paymentUrl,
                pspReferenceId: data.pspReferenceId
            });
        }

        return res.status(400).json({ message: data.message || 'Não foi possível gerar a cobrança NuPay.' });
    } catch (err) {
        return res.status(500).json({ message: 'Erro ao se comunicar com a NuPay.' });
    }
});

app.post('/api/auth/forgot-password', async (req, res) => {
    let { email } = req.body;

    if (!email) {
        return res.status(400).json({ success: false, message: 'E-mail obrigatório.' });
    }

    const cleanEmail = email.trim().toLowerCase();

    try {
        const result = await pool.query(
            'SELECT id, email FROM users WHERE LOWER(TRIM(email)) = $1',
            [cleanEmail]
        );
        const user = result.rows[0];

        // Mesma resposta exista ou não o e-mail, para não revelar quais e-mails têm conta.
        // O e-mail só é de fato enviado quando a conta existe (ver abaixo).
        if (!user) {
            return res.json({ success: true, message: 'Se este e-mail estiver cadastrado, você receberá um link de recuperação.' });
        }

        // O token só existe em texto puro no e-mail enviado ao usuário; no banco fica só o hash,
        // para quem lê os logs (ou tem acesso de leitura ao banco) não conseguir trocar a senha de ninguém.
        const resetToken = crypto.randomBytes(32).toString('hex');
        const resetTokenHash = crypto.createHash('sha256').update(resetToken).digest('hex');
        const expiresAt = Date.now() + 60 * 60 * 1000;
        await pool.query(
            'UPDATE users SET reset_token = $1, reset_token_expires = $2 WHERE id = $3',
            [resetTokenHash, expiresAt, user.id]
        );

        const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
        const resetLink = `${baseUrl}/reset-password.html?token=${resetToken}`;


        await sendMail({
            to: user.email,
            subject: 'Redefinição de Senha - KL Web',
            html: `
                <div style="font-family: Arial, sans-serif; padding: 20px;">
                    <h2>Redefinição de Senha - KL Web</h2>
                    <p>Clique no botão abaixo para redefinir sua senha:</p>
                    <a href="${resetLink}" style="padding: 10px 20px; background-color: #818cf8; color: #fff; text-decoration: none; border-radius: 5px; display: inline-block;">Redefinir Senha</a>
                </div>
            `
        });

        return res.json({ success: true, message: 'Se este e-mail estiver cadastrado, você receberá um link de recuperação.' });

    } catch (error) {
        console.error('❌ Erro forgot-password:', error);
        return res.status(500).json({ success: false, message: 'Erro interno no servidor.' });
    }
});

app.post('/api/auth/reset-password', async (req, res) => {
    const { token, oldPassword, newPassword } = req.body;

    if (!token) {
        return res.status(400).json({ success: false, message: 'Token de redefinição não fornecido.' });
    }

    if (!newPassword || newPassword.length < 4) {
        return res.status(400).json({ success: false, message: 'A nova senha deve ter pelo menos 4 caracteres.' });
    }

    try {
        // 1. Busca o usuário pelo HASH do token de redefinição (o token em si nunca é salvo no banco)
        const tokenHash = crypto.createHash('sha256').update(String(token)).digest('hex');
        const result = await pool.query(
            'SELECT id, email, password, reset_token_expires FROM users WHERE reset_token = $1',
            [tokenHash]
        );

        if (result.rows.length === 0) {
            return res.status(400).json({ success: false, message: 'Token inválido ou inexistente. Solicite um novo link de recuperação.' });
        }

        const user = result.rows[0];

        // 2. Valida expiração do token
        if (user.reset_token_expires && Number(user.reset_token_expires) < Date.now()) {
            return res.status(400).json({ success: false, message: 'O link de redefinição expirou. Solicite uma nova recuperação de senha.' });
        }

        // 3. Se fornecida a senha antiga (confirmação da senha antiga), valida contra o banco
        if (oldPassword) {
            const isOldMatch = await bcrypt.compare(oldPassword, user.password);
            if (!isOldMatch) {
                return res.status(400).json({ success: false, message: 'A senha antiga informada está incorreta.' });
            }
        }

        // 4. Criptografar nova senha
        const hashedPassword = await bcrypt.hash(newPassword, 10);

        // 5. Atualizar no banco e limpar token
        const updateRes = await pool.query(
            'UPDATE users SET password = $1, reset_token = NULL, reset_token_expires = NULL WHERE id = $2 RETURNING id, email',
            [hashedPassword, user.id]
        );
        await revokeUserSessions(user.id);

        if (updateRes.rowCount === 0) {
            return res.status(404).json({ success: false, message: 'Usuário não encontrado para atualização.' });
        }

        console.log(`✅ [RESET PASSWORD] Senha atualizada para o usuário ID: ${user.id}`);

        return res.json({ success: true, message: 'Senha atualizada com sucesso!' });
    } catch (err) {
        console.error('Erro ao redefinir senha:', err.message);
        return res.status(500).json({ success: false, message: 'Erro ao atualizar a senha no banco de dados.' });
    }
});

const handleUserChangePassword = async (req, res) => {
    const oldPassword = req.body.oldPassword || req.body.currentPassword || req.body.senhaAtual;
    const newPassword = req.body.newPassword || req.body.novaSenha;

    if (!newPassword || newPassword.length < 4) {
        return res.status(400).json({ success: false, message: 'A nova senha deve conter no mínimo 4 caracteres.' });
    }

    const userId = req.user?.id || req.user?.userId;
    if (!userId) {
        return res.status(401).json({ success: false, message: 'Usuário não autenticado corretamente.' });
    }

    try {
        const userRes = await pool.query('SELECT id, email, password FROM users WHERE id = $1', [userId]);
        if (userRes.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Usuário não encontrado no banco de dados.' });
        }

        const user = userRes.rows[0];

        if (oldPassword) {
            const isMatch = await bcrypt.compare(oldPassword, user.password);
            if (!isMatch) {
                return res.status(400).json({ success: false, message: 'Senha atual incorreta.' });
            }
        }

        const hashedPassword = await bcrypt.hash(newPassword, 10);
        await pool.query('UPDATE users SET password = $1 WHERE id = $2', [hashedPassword, userId]);

        try {
            await sendMail({
                to: user.email,
                subject: 'Confirmação de Alteração de Senha - KL Web',
                html: `<h3>Olá!</h3><p>Sua senha na plataforma <strong>KL Web</strong> foi alterada com sucesso.</p><p>Se você não reconhece esta alteração, entre em contato imediatamente com o suporte.</p>`
            });
        } catch (mailError) {
            console.error('Erro ao enviar e-mail de confirmação de senha:', mailError.message);
        }

        return res.json({ success: true, message: 'Senha atualizada com sucesso no banco de dados!' });
    } catch (e) {
        console.error('Erro ao processar alteração de senha:', e.message);
        return res.status(500).json({ success: false, message: 'Erro ao processar nova senha no banco de dados.' });
    }
};

app.post('/api/auth/change-password', authenticateToken, handleUserChangePassword);
app.put('/api/user/change-password', authenticateToken, handleUserChangePassword);
app.put('/api/users/change-password', authenticateToken, handleUserChangePassword);

// ---------- Troca de e-mail com confirmação por código ----------
const EMAIL_CHANGE_TTL_MS = 10 * 60 * 1000;      // código vale 10 minutos
const EMAIL_CHANGE_RESEND_MS = 60 * 1000;        // 1 pedido por minuto
const EMAIL_CHANGE_MAX_ATTEMPTS = 5;             // erros permitidos por código
const emailChangeLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 30,
    message: { success: false, message: 'Muitas tentativas. Tente novamente mais tarde.' }
});

function hashEmailChangeCode(userId, newEmail, code) {
    return crypto.createHash('sha256').update(`${userId}:${newEmail}:${code}`).digest('hex');
}

const handleUserChangeEmail = async (req, res) => {
    const password = req.body.password || req.body.currentPassword || req.body.senhaAtual;
    const newEmail = req.body.newEmail || req.body.novoEmail;

    if (!newEmail || !isValidEmail(newEmail)) {
        return res.status(400).json({ success: false, message: 'Por favor, informe um endereço de e-mail válido.' });
    }

    const cleanEmail = newEmail.trim().toLowerCase();
    const userId = req.user?.id || req.user?.userId;

    if (!userId) {
        return res.status(401).json({ success: false, message: 'Usuário não autenticado corretamente.' });
    }

    try {
        const userRes = await pool.query('SELECT id, email, password FROM users WHERE id = $1', [userId]);
        if (userRes.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Usuário não encontrado no banco de dados.' });
        }

        const user = userRes.rows[0];

        // A senha atual é obrigatória: sem ela, quem tivesse só o token trocaria o e-mail da conta.
        if (!password) {
            return res.status(400).json({ success: false, message: 'Informe a senha atual para autorizar a troca de e-mail.' });
        }
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(400).json({ success: false, message: 'Senha atual incorreta para autorizar a troca de e-mail.' });
        }

        const checkExisting = await pool.query('SELECT id FROM users WHERE LOWER(email) = $1 AND id != $2', [cleanEmail, userId]);
        if (checkExisting.rows.length > 0) {
            return res.status(400).json({ success: false, message: 'Este e-mail já está sendo utilizado por outra conta.' });
        }

        // Cooldown de reenvio: evita usar o formulário para disparar e-mails em sequência.
        const pending = await pool.query('SELECT last_sent_at FROM email_change_requests WHERE user_id = $1', [userId]);
        if (pending.rows[0] && Date.now() - Number(pending.rows[0].last_sent_at) < EMAIL_CHANGE_RESEND_MS) {
            return res.status(429).json({ success: false, message: 'Aguarde cerca de 1 minuto antes de pedir um novo código.' });
        }

        // A troca só acontece depois que o código enviado ao NOVO e-mail for confirmado
        // (handleConfirmEmailChange): assim ninguém cadastra um endereço que não é seu.
        const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
        await pool.query(
            `INSERT INTO email_change_requests (user_id, new_email, code_hash, expires_at, attempts, last_sent_at)
             VALUES ($1, $2, $3, $4, 0, $5)
             ON CONFLICT (user_id) DO UPDATE SET new_email = EXCLUDED.new_email, code_hash = EXCLUDED.code_hash,
                 expires_at = EXCLUDED.expires_at, attempts = 0, last_sent_at = EXCLUDED.last_sent_at`,
            [userId, cleanEmail, hashEmailChangeCode(userId, cleanEmail, code), Date.now() + EMAIL_CHANGE_TTL_MS, Date.now()]
        );

        const sent = await sendMail({
            to: cleanEmail,
            subject: 'Código para confirmar seu novo e-mail - KL Web',
            html: `
                <div style="font-family: Arial, sans-serif; padding: 20px; max-width: 480px;">
                    <h2 style="color:#6366f1; margin-top:0;">Confirme seu novo e-mail</h2>
                    <p>Use o código abaixo na KL Web para confirmar que este endereço é seu:</p>
                    <p style="font-size: 32px; letter-spacing: 8px; font-weight: bold; margin: 20px 0;">${code}</p>
                    <p style="color:#64748b; font-size: 13px;">O código vale por ${EMAIL_CHANGE_TTL_MS / 60000} minutos. Se você não pediu essa troca, ignore esta mensagem: nada será alterado.</p>
                </div>`
        });
        if (!sent) {
            await pool.query('DELETE FROM email_change_requests WHERE user_id = $1', [userId]);
            return res.status(502).json({ success: false, message: 'Não foi possível enviar o código para esse e-mail. Confira o endereço e tente de novo.' });
        }

        return res.json({
            success: true,
            requiresCode: true,
            newEmail: cleanEmail,
            expiresInMinutes: EMAIL_CHANGE_TTL_MS / 60000,
            message: `Enviamos um código de 6 dígitos para ${cleanEmail}. Digite-o para concluir a troca.`
        });
    } catch (err) {
        if (err.code === '23505') {
            return res.status(400).json({ success: false, message: 'Este e-mail já está sendo utilizado por outra conta.' });
        }
        console.error('Erro ao atualizar e-mail:', err.message);
        return res.status(500).json({ success: false, message: 'Erro ao atualizar e-mail no servidor.' });
    }
};

// Perfil: nome e telefone. (E-mail e senha têm rotas próprias que exigem a senha atual.)
app.put('/api/user/profile', authenticateToken, async (req, res) => {
    const name = String(req.body.name || '').trim();
    const phone = String(req.body.phone || '').trim();
    const phoneDigits = phone.replace(/\D/g, '');

    if (name.length < 2 || name.length > 100) {
        return res.status(400).json({ success: false, message: 'Informe um nome entre 2 e 100 caracteres.' });
    }
    if (phone && (phone.length > 20 || phoneDigits.length < 8)) {
        return res.status(400).json({ success: false, message: 'Informe um telefone válido.' });
    }

    try {
        const result = await pool.query(
            `UPDATE users SET name = $1, phone = COALESCE(NULLIF($2, ''), phone) WHERE id = $3 RETURNING id, name, phone`,
            [encryptData(name), phone ? encryptData(phone) : null, req.user.id]
        );
        if (!result.rows[0]) {
            return res.status(404).json({ success: false, message: 'Usuário não encontrado.' });
        }
        return res.json({ success: true, message: 'Perfil atualizado.', user: decryptUser(result.rows[0]) });
    } catch (err) {
        console.error('Erro ao atualizar perfil:', err.message);
        return res.status(500).json({ success: false, message: 'Erro ao salvar o perfil no servidor.' });
    }
});

const handleConfirmEmailChange = async (req, res) => {
    const userId = req.user?.id || req.user?.userId;
    const code = String(req.body.code || '').replace(/\D/g, '');
    if (!userId) {
        return res.status(401).json({ success: false, message: 'Usuário não autenticado corretamente.' });
    }
    if (code.length !== 6) {
        return res.status(400).json({ success: false, message: 'Digite o código de 6 dígitos enviado ao novo e-mail.' });
    }

    const restart = (status, message) => res.status(status).json({ success: false, code: 'EMAIL_CHANGE_RESTART', message });
    const client = await pool.connect();
    try {
        const reqRes = await client.query('SELECT * FROM email_change_requests WHERE user_id = $1', [userId]);
        const pending = reqRes.rows[0];
        if (!pending) {
            return restart(400, 'Nenhuma troca de e-mail pendente. Peça um novo código.');
        }
        if (Number(pending.expires_at) < Date.now()) {
            await client.query('DELETE FROM email_change_requests WHERE user_id = $1', [userId]);
            return restart(400, 'O código expirou. Peça um novo código.');
        }
        if (pending.attempts >= EMAIL_CHANGE_MAX_ATTEMPTS) {
            await client.query('DELETE FROM email_change_requests WHERE user_id = $1', [userId]);
            return restart(429, 'Muitas tentativas erradas. Peça um novo código.');
        }

        const newEmail = pending.new_email;
        if (!safeCompare(hashEmailChangeCode(userId, newEmail, code), pending.code_hash)) {
            const upd = await client.query('UPDATE email_change_requests SET attempts = attempts + 1 WHERE user_id = $1 RETURNING attempts', [userId]);
            const left = Math.max(EMAIL_CHANGE_MAX_ATTEMPTS - (upd.rows[0]?.attempts || 0), 0);
            if (left === 0) {
                await client.query('DELETE FROM email_change_requests WHERE user_id = $1', [userId]);
                return restart(429, 'Código incorreto. Muitas tentativas: peça um novo código.');
            }
            return res.status(400).json({ success: false, message: `Código incorreto. Você ainda tem ${left} tentativa(s).` });
        }

        // Código certo. Reconfere se o endereço continua livre (alguém pode ter cadastrado nesse meio-tempo).
        const taken = await client.query('SELECT id FROM users WHERE LOWER(email) = $1 AND id != $2', [newEmail, userId]);
        if (taken.rows.length > 0) {
            await client.query('DELETE FROM email_change_requests WHERE user_id = $1', [userId]);
            return restart(400, 'Este e-mail já está sendo utilizado por outra conta.');
        }

        const before = await client.query('SELECT email FROM users WHERE id = $1', [userId]);
        const oldEmail = before.rows[0]?.email || null;

        await client.query('BEGIN');
        const result = await client.query(
            'UPDATE users SET email = $1, token_version = COALESCE(token_version, 0) + 1 WHERE id = $2 RETURNING id, name, role, company_id, plan_tier, token_version',
            [newEmail, userId]
        );
        await client.query('UPDATE demands SET assigned_user_email = $1 WHERE assigned_user_id = $2', [newEmail, userId]);
        await client.query('UPDATE notifications SET user_email = $1 WHERE user_id = $2', [newEmail, userId]);
        await client.query('DELETE FROM email_change_requests WHERE user_id = $1', [userId]);
        await client.query('COMMIT');

        const updatedUser = result.rows[0];
        const newToken = jwt.sign(
            {
                id: updatedUser.id,
                email: newEmail,
                name: updatedUser.name,
                companyId: updatedUser.company_id,
                role: updatedUser.role,
                planTier: updatedUser.plan_tier,
                tv: Number(updatedUser.token_version || 0)
            },
            JWT_SECRET,
            { expiresIn: '7d' }
        );

        // Todos os outros aparelhos (tokens com a versão antiga) caem; o socket de cada um é fechado.
        disconnectUserSockets(userId);

        // Aviso de segurança no e-mail antigo (se não foi a pessoa, ela fica sabendo).
        if (oldEmail && oldEmail.toLowerCase() !== newEmail) {
            sendMail({
                to: oldEmail,
                subject: 'Seu e-mail na KL Web foi alterado',
                html: `<div style="font-family: Arial, sans-serif; padding: 20px;"><h3>E-mail alterado</h3><p>O e-mail de acesso da sua conta KL Web agora é <strong>${escapeHtml(newEmail)}</strong>.</p><p>Se não foi você, entre em contato com o suporte imediatamente.</p></div>`
            }).catch(() => { });
        }

        return res.json({
            success: true,
            message: 'E-mail confirmado e alterado com sucesso! Os outros aparelhos foram desconectados.',
            token: newToken,
            newEmail
        });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => { });
        if (err.code === '23505') {
            return restart(400, 'Este e-mail já está sendo utilizado por outra conta.');
        }
        console.error('Erro ao confirmar troca de e-mail:', err.message);
        return res.status(500).json({ success: false, message: 'Erro ao confirmar a troca de e-mail no servidor.' });
    } finally {
        client.release();
    }
};

app.post('/api/users/change-email/request', emailChangeLimiter, authenticateToken, handleUserChangeEmail);
app.post('/api/users/change-email/confirm', emailChangeLimiter, authenticateToken, handleConfirmEmailChange);

// ==================== TOKEN DE PUSH DO APP MOBILE (FCM) ====================
async function handleSaveFcmToken(req, res) {
    try {
        const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
        if (token.length < 20 || token.length > 4096 || /\s/.test(token)) {
            return res.status(400).json({ message: 'Token inválido.' });
        }
        if (!canUsePushNotifications(req.user.planTier, req.user.plan_status)) {
            return res.status(403).json({
                message: 'Notificações push estão disponíveis nos planos Starter e Pro IA.',
                code: 'PLAN_REQUIRED'
            });
        }
        // O mesmo aparelho não pode ficar ligado a duas contas (ex.: celular compartilhado).
        await pool.query(`UPDATE users SET fcm_token = NULL WHERE fcm_token = $1 AND id <> $2`, [token, req.user.id]);
        await pool.query(`UPDATE users SET fcm_token = $1 WHERE id = $2`, [token, req.user.id]);
        res.json({ success: true });
    } catch (err) {
        console.error('Erro ao salvar token FCM:', err.message);
        res.status(500).json({ message: 'Erro ao registrar notificações do aparelho.' });
    }
}

async function handleDeleteFcmToken(req, res) {
    try {
        await pool.query(`UPDATE users SET fcm_token = NULL WHERE id = $1`, [req.user.id]);
        res.json({ success: true });
    } catch (err) {
        console.error('Erro ao remover token FCM:', err.message);
        res.status(500).json({ message: 'Erro ao remover token do aparelho.' });
    }
}

app.post('/api/user/fcm-token', authenticateToken, handleSaveFcmToken);
app.post('/api/users/fcm-token', authenticateToken, handleSaveFcmToken);
app.delete('/api/user/fcm-token', authenticateToken, handleDeleteFcmToken);
app.delete('/api/users/fcm-token', authenticateToken, handleDeleteFcmToken);

app.post('/api/auth/change-email', emailChangeLimiter, authenticateToken, handleUserChangeEmail);
app.put('/api/user/change-email', emailChangeLimiter, authenticateToken, handleUserChangeEmail);
app.put('/api/users/change-email', emailChangeLimiter, authenticateToken, handleUserChangeEmail);

const handleUpdateEmployeePassword = async (req, res) => {
    const targetEmail = req.body.email || req.body.targetEmail;
    const oldPassword = req.body.oldPassword || req.body.senhaAtual || req.body.currentPassword;
    const newPassword = req.body.newPassword || req.body.novaSenha;

    if (!targetEmail) {
        return res.status(400).json({ success: false, message: 'Informe o e-mail do funcionário.' });
    }

    if (!newPassword || newPassword.length < 4) {
        return res.status(400).json({ success: false, message: 'A nova senha deve ter no mínimo 4 caracteres.' });
    }

    const cleanEmail = targetEmail.trim().toLowerCase();
    const requesterRole = (req.user?.role || '').toUpperCase();
    const isManagerOrOwner = ['OWNER', 'MANAGER', 'ADMIN', 'DONO', 'GERENTE'].includes(requesterRole);

    try {
        const targetRes = await pool.query(
            `SELECT u.id, u.name, u.email, u.password, u.company_id, c.owner_id AS company_owner_id
             FROM users u
             LEFT JOIN companies c ON c.id = u.company_id
             WHERE LOWER(u.email) = $1 AND u.company_id = $2`,
            [cleanEmail, req.user.companyId]
        );
        if (targetRes.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Funcionário não encontrado no banco de dados.' });
        }

        const employee = targetRes.rows[0];

        if (Number(employee.company_owner_id) === Number(employee.id) &&
            Number(req.user.id) !== Number(employee.id) &&
            req.user.companyRole !== 'OWNER') {
            return res.status(403).json({ success: false, message: 'Apenas o Dono pode alterar as credenciais do Dono da empresa.' });
        }

        if (employee.id !== req.user.id && !isManagerOrOwner) {
            return res.status(403).json({ success: false, message: 'Acesso negado: apenas Gerentes ou Donos podem alterar credenciais de membros.' });
        }

        if (!oldPassword) {
            return res.status(400).json({ success: false, message: 'A senha antiga do funcionário é obrigatória para confirmação.' });
        }

        const isMatch = await bcrypt.compare(oldPassword, employee.password);
        if (!isMatch) {
            return res.status(400).json({ success: false, message: 'A senha antiga informada está incorreta no banco de dados.' });
        }

        const hashedPassword = await bcrypt.hash(newPassword, 10);
        await pool.query('UPDATE users SET password = $1 WHERE id = $2', [hashedPassword, employee.id]);
        if (employee.id !== req.user.id) await revokeUserSessions(employee.id);

        console.log(`✅ [PASSWORD UPDATE] Senha do funcionário ${employee.email} atualizada com sucesso no banco de dados.`);

        return res.json({
            success: true,
            message: `Senha do funcionário ${employee.name || employee.email} atualizada com sucesso no banco de dados!`
        });
    } catch (err) {
        console.error('Erro ao atualizar senha do funcionário:', err);
        return res.status(500).json({ success: false, message: 'Erro interno ao atualizar senha no banco de dados.' });
    }
};

app.put('/api/users/update-employee-password', authenticateToken, handleUpdateEmployeePassword);
app.put('/api/company/reset-member-password', authenticateToken, handleUpdateEmployeePassword);

const handleUpdateEmployeeEmail = async (req, res) => {
    const targetEmail = req.body.email || req.body.targetEmail || req.body.currentEmail;
    const password = req.body.password || req.body.senhaAtual || req.body.oldPassword;
    const newEmail = req.body.newEmail || req.body.novoEmail;

    if (!targetEmail || !newEmail) {
        return res.status(400).json({ success: false, message: 'Informe o e-mail atual e o novo e-mail do funcionário.' });
    }

    if (!isValidEmail(newEmail)) {
        return res.status(400).json({ success: false, message: 'O novo e-mail informado é inválido.' });
    }

    const cleanOldEmail = targetEmail.trim().toLowerCase();
    const cleanNewEmail = newEmail.trim().toLowerCase();

    const requesterRole = (req.user?.role || '').toUpperCase();
    const isManagerOrOwner = ['OWNER', 'MANAGER', 'ADMIN', 'DONO', 'GERENTE'].includes(requesterRole);

    try {
        const targetRes = await pool.query(
            `SELECT u.id, u.name, u.email, u.password, u.company_id, c.owner_id AS company_owner_id
             FROM users u
             LEFT JOIN companies c ON c.id = u.company_id
             WHERE LOWER(u.email) = $1 AND u.company_id = $2`,
            [cleanOldEmail, req.user.companyId]
        );
        if (targetRes.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Funcionário não encontrado no banco de dados.' });
        }

        const employee = targetRes.rows[0];

        if (Number(employee.company_owner_id) === Number(employee.id) &&
            Number(req.user.id) !== Number(employee.id) &&
            req.user.companyRole !== 'OWNER') {
            return res.status(403).json({ success: false, message: 'Apenas o Dono pode alterar as credenciais do Dono da empresa.' });
        }

        if (employee.id !== req.user.id && !isManagerOrOwner) {
            return res.status(403).json({ success: false, message: 'Acesso negado: apenas Gerentes ou Donos podem alterar credenciais de membros.' });
        }

        if (!password) {
            return res.status(400).json({ success: false, message: 'A senha de confirmação é obrigatória para autorizar a troca de e-mail.' });
        }

        // Fix: exige SEMPRE a senha do alvo, nunca aceita a própria senha do solicitante
        const isEmpPassMatch = await bcrypt.compare(password, employee.password);

        if (!isEmpPassMatch) {
            return res.status(400).json({ success: false, message: 'A senha do funcionário informada está incorreta. Alteração de e-mail não autorizada.' });
        }

        const existingRes = await pool.query('SELECT id FROM users WHERE LOWER(email) = $1 AND id != $2', [cleanNewEmail, employee.id]);
        if (existingRes.rows.length > 0) {
            return res.status(400).json({ success: false, message: 'Este novo e-mail já está em uso por outro usuário.' });
        }

        await pool.query('UPDATE users SET email = $1 WHERE id = $2', [cleanNewEmail, employee.id]);
        await pool.query('UPDATE demands SET assigned_user_email = $1 WHERE assigned_user_id = $2', [cleanNewEmail, employee.id]);
        const newVersion = await revokeUserSessions(employee.id);

        // Se a pessoa trocou o próprio e-mail por aqui, este aparelho continua logado com um token novo.
        let selfToken = null;
        if (Number(employee.id) === Number(req.user.id)) {
            selfToken = jwt.sign(
                {
                    id: employee.id, email: cleanNewEmail, name: req.user.name,
                    companyId: req.user.companyId, role: req.user.role,
                    companyRole: req.user.companyRole, planTier: req.user.plan_tier,
                    tv: newVersion || 0
                },
                JWT_SECRET,
                { expiresIn: '7d' }
            );
        }

        console.log(`✅ [EMAIL UPDATE] E-mail do funcionário ${employee.name} alterado de ${cleanOldEmail} para ${cleanNewEmail} no banco de dados.`);

        return res.json({
            success: true,
            message: `E-mail de ${employee.name || employee.email} alterado com sucesso no banco de dados!`,
            newEmail: cleanNewEmail,
            ...(selfToken ? { token: selfToken } : {})
        });
    } catch (err) {
        console.error('Erro ao atualizar e-mail do funcionário:', err);
        return res.status(500).json({ success: false, message: 'Erro interno ao atualizar e-mail no banco de dados.' });
    }
};

app.put('/api/users/update-employee-email', authenticateToken, handleUpdateEmployeeEmail);
app.put('/api/company/update-member-email', authenticateToken, handleUpdateEmployeeEmail);

app.delete('/api/users/delete-by-email', authenticateToken, async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ message: 'E-mail não informado.' });

    const cleanEmail = email.toLowerCase().trim();
    const tokenEmail = (req.user?.email || '').toLowerCase().trim();

    // Garante que o usuário só apaga a própria conta
    if (cleanEmail !== tokenEmail) {
        return res.status(403).json({ message: 'Você só pode excluir a sua própria conta.' });
    }
    // A conta do dono da plataforma nunca pode ser apagada: se fosse, qualquer pessoa poderia se
    // cadastrar depois com o mesmo e-mail (OWNER_EMAIL) e herdar automaticamente o papel de OWNER.
    if (cleanEmail === OWNER_EMAIL.toLowerCase()) {
        return res.status(403).json({ message: 'A conta do dono da plataforma não pode ser excluída.' });
    }

    try {
        // 1. Desvincula o usuário de todas as demandas atreladas a ele primeiro
        await pool.query(
            `UPDATE demands
             SET assigned_user_email = NULL, assigned_user_name = 'Sem responsável'
             WHERE LOWER(assigned_user_email) = $1`,
            [cleanEmail]
        );

        // 2. Remove o usuário do banco de dados
        const result = await pool.query(
            'DELETE FROM users WHERE LOWER(email) = $1 RETURNING id',
            [cleanEmail]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Conta não encontrada para exclusão.' });
        }

        console.log(`❌ Conta (${cleanEmail}) apagada permanentemente do banco de dados.`);

        return res.json({
            success: true,
            message: 'Sua conta e e-mail foram excluídos permanentemente do sistema.'
        });

    } catch (err) {
        console.error('Erro ao apagar usuário do banco:', err.message);

        // Trata erro de Restrição de Chave Estrangeira (FK constraint)
        if (err.code === '23503') {
            return res.status(400).json({
                message: 'Não é possível excluir a conta pois existem registros vinculados a ela que dependem do seu usuário.'
            });
        }

        return res.status(500).json({ message: 'Erro ao apagar usuário do banco de dados.' });
    }
});

// Rate limit simples por IP para os endpoints públicos de checkout (não exigem login,
// então qualquer um na internet pode chamá-los e gerar preferências no Mercado Pago).
// Mesmo padrão de janela deslizante usado em totpRateLimited, mais abaixo no arquivo.
const checkoutAttempts = new Map();
function checkoutRateLimited(key, max = 8, windowMs = 15 * 60 * 1000) {
    const now = Date.now();
    let rec = checkoutAttempts.get(key);
    if (!rec || now > rec.resetAt) {
        rec = { count: 0, resetAt: now + windowMs };
        checkoutAttempts.set(key, rec);
    }
    rec.count += 1;
    return rec.count > max;
}
setInterval(() => {
    const now = Date.now();
    for (const [k, v] of checkoutAttempts) if (now > v.resetAt) checkoutAttempts.delete(k);
}, 15 * 60 * 1000).unref();

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Cria a preferência de checkout no Mercado Pago para o plano escolhido.
 * Usada tanto por /create-checkout quanto por /public-checkout — antes cada rota tinha
 * sua própria cópia dessa lógica, com pequenas divergências que podiam gerar bugs
 * inconsistentes entre os dois links (ex: normalização de plano só existia em um deles).
 *
 * O e-mail é OBRIGATÓRIO e deve ser o mesmo que o cliente usa (ou vai usar) para logar
 * no KL Web: é por esse e-mail que o webhook encontra a conta e libera o plano depois
 * que o pagamento é confirmado (ver applyPlanFromReference). Não há mais fallback para
 * um e-mail genérico — isso fazia compras de pessoas diferentes caírem todas na mesma
 * conta, sobrescrevendo o plano uma da outra.
 */
async function criarPreferenciaCheckout({ planTier, email, baseUrl }) {
    // Aceita os nomes antigos de plano (PRO_PME/CORPORATE) usados em links já distribuídos.
    const aliasMap = { PRO_PME: 'STARTER', CORPORATE: 'PRO_IA' };
    const currentPlan = aliasMap[(planTier || '').toUpperCase()] || (planTier || '').toUpperCase();

    const allowedPlans = ['STARTER', 'PRO_IA'];
    if (!allowedPlans.includes(currentPlan)) {
        const err = new Error('Plano inválido. Selecione STARTER ou PRO_IA.');
        err.statusCode = 400;
        throw err;
    }

    const payerEmail = String(email || '').trim().toLowerCase();
    if (!payerEmail || !EMAIL_REGEX.test(payerEmail)) {
        const err = new Error('Informe o e-mail que o cliente usa (ou vai usar) no KL Web.');
        err.statusCode = 400;
        throw err;
    }

    if (!mpClient) {
        const err = new Error('MERCADOPAGO_ACCESS_TOKEN não configurado no servidor.');
        err.statusCode = 500;
        throw err;
    }
    if (!process.env.MERCADOPAGO_WEBHOOK_SECRET) {
        const err = new Error('Confirmação segura do pagamento não está configurada no servidor.');
        err.statusCode = 503;
        throw err;
    }

    // Preço e nome de exibição definidos no servidor: nada vindo do cliente decide o valor cobrado.
    // Isso garante que ao confirmar o pagamento o plano liberado (Starter ou Pro IA) é exatamente
    // o que foi cobrado — ver a checagem de paidAmount em applyPlanFromReference.
    const numericPrice = PLAN_PRICES[currentPlan];
    const planDisplayName = currentPlan === 'PRO_IA' ? 'Pro IA' : 'Starter';
    const publicBaseUrl = getPublicBaseUrl();
    const checkoutBaseUrl = baseUrl || publicBaseUrl;
    if (!canReceivePaymentWebhook(checkoutBaseUrl)) {
        const err = new Error('Checkout temporariamente indisponível: o servidor precisa de uma URL pública HTTPS para confirmar o pagamento.');
        err.statusCode = 503;
        throw err;
    }

    const preference = new Preference(mpClient);
    const response = await preference.create({
        body: {
            items: [
                {
                    id: currentPlan,
                    title: `Assinatura Plano ${planDisplayName} - KL Web`,
                    quantity: 1,
                    unit_price: numericPrice,
                    currency_id: 'BRL'
                }
            ],
            payer: {
                email: payerEmail
            },
            payment_methods: {
                installments: 1,
                default_installments: 1
            },
            // O webhook usa este e-mail + plan_tier para saber, ao confirmar o pagamento,
            // qual conta atualizar e para qual plano (STARTER ou PRO_IA) liberar os benefícios.
            external_reference: JSON.stringify({
                email: payerEmail,
                plan_tier: currentPlan,
                billing: 'MONTHLY'
            }),
            notification_url: `${checkoutBaseUrl}/api/payments/webhook`,
            back_urls: {
                success: `${checkoutBaseUrl}/?payment=success`,
                failure: `${checkoutBaseUrl}/?payment=failure`,
                pending: `${checkoutBaseUrl}/?payment=pending`
            },
            auto_return: 'approved'
        }
    });

    return { init_point: response.init_point, id: response.id, planTier: currentPlan };
}

app.post('/api/payments/create-checkout', async (req, res) => {
    if (checkoutRateLimited(`create:${req.ip}`)) {
        return res.status(429).json({ message: 'Muitas tentativas de checkout. Aguarde alguns minutos e tente novamente.' });
    }
    try {
        const { planTier, email } = req.body;
        const payerEmail = email || req.body.userEmail;
        const baseUrl = getPublicBaseUrl(req);
        const result = await criarPreferenciaCheckout({ planTier, email: payerEmail, baseUrl });
        return res.json({ init_point: result.init_point, id: result.id });
    } catch (error) {
        if (error.statusCode) {
            return res.status(error.statusCode).json({ message: error.message });
        }
        console.error('Erro ao criar preferência no Mercado Pago:', error?.cause || error.message || error);
        return res.status(500).json({ message: 'Erro ao gerar checkout de pagamento.' });
    }
});

const Payment = require('mercadopago').Payment; // Certifique-se de importar o Payment do SDK

// Aplica a atualização de plano no banco a partir de um external_reference decodificado,
// usado tanto pelo fluxo de assinatura (preapproval) quanto pelo antigo fluxo de pagamento único.
async function applyPlanFromReference(rawExternalReference, fallbackEmail, paidAmount, currencyId, subscriptionId = null) {
    let metadata = {};
    try {
        metadata = JSON.parse(rawExternalReference || '{}');
    } catch (e) {
        console.error('Erro ao decodificar external_reference:', rawExternalReference);
    }

    const payerEmail = (metadata.email || fallbackEmail || '').toLowerCase().trim();
    const paidPlanTier = normalizePlanTier(metadata.plan_tier || 'STARTER');

    // Só planos pagos são ativáveis por aqui (nunca BASICO/OWNER, nem valores desconhecidos).
    if (!['STARTER', 'PRO_IA'].includes(paidPlanTier)) {
        console.error(`❌ Plano inválido no external_reference: ${metadata.plan_tier}. Nada foi ativado.`);
        return;
    }

    // Marca o trial como usado se for a primeira ativação do plano
    const userRow = (await pool.query('SELECT id, free_trial_used FROM users WHERE LOWER(email) = $1', [payerEmail])).rows[0];
    if (userRow && !userRow.free_trial_used) {
        await pool.query(
            `UPDATE users SET free_trial_used = TRUE, trial_start_date = CURRENT_TIMESTAMP, trial_end_date = CURRENT_TIMESTAMP + INTERVAL '7 days' WHERE id = $1`,
            [userRow.id]
        );
        console.log(`🎁 Trial gratuito de 7 dias marcado como usado para ${payerEmail}`);
    }

    // Defesa em profundidade: o valor efetivamente cobrado precisa cobrir o preço do plano.
    if (!Number.isFinite(Number(paidAmount)) || Number(paidAmount) + 0.001 < PLAN_PRICES[paidPlanTier] || currencyId !== 'BRL') {
        console.error(`❌ Cobrança inválida para ${paidPlanTier}: valor=${paidAmount}, moeda=${currencyId}. Plano NÃO ativado.`);
        return;
    }

    if (!payerEmail && !metadata.userId) {
        console.error('❌ Não foi possível identificar o pagador (sem userId nem e-mail).');
        return;
    }

    let user;
    if (metadata.userId) {
        user = (await pool.query('SELECT id FROM users WHERE id = $1', [metadata.userId])).rows[0];
        if (!user) {
            // O checkout foi gerado para uma conta logada; se ela não existe mais, não criamos uma conta órfã.
            console.error(`❌ external_reference aponta para o usuário ${metadata.userId}, que não existe mais. Nada foi ativado.`);
            return;
        }
    } else {
        user = (await pool.query('SELECT id FROM users WHERE LOWER(email) = $1', [payerEmail])).rows[0];
    }

    if (user) {
        await pool.query(
            `UPDATE users SET plan_tier = $1, plan_status = 'ACTIVE', mp_subscription_id = COALESCE($3, mp_subscription_id) WHERE id = $2`,
            [paidPlanTier, user.id, subscriptionId]
        );
        console.log(`✅ Plano ${paidPlanTier} ativado com sucesso para ${payerEmail}`);
    } else {
        const temporaryPassword = crypto.randomBytes(16).toString('hex');
        const passwordHash = await bcrypt.hash(temporaryPassword, 10);

        await pool.query(
            `INSERT INTO users (name, email, cpf, phone, password, role, is_active, plan_status, plan_tier)
             VALUES ($1, $2, $3, $4, $5, 'USER', true, 'ACTIVE', $6)`,
            [encryptData(payerEmail.split('@')[0]), payerEmail, encryptData('00000000000'), encryptData('00000000000'), passwordHash, paidPlanTier]
        );
        console.log(`👤 Conta criada e ativada para ${payerEmail} com plano ${paidPlanTier}`);
    }
}

app.post('/api/payments/webhook', async (req, res) => {
    // Valida a assinatura (x-signature) antes de confiar na notificação: garante que a
    // requisição realmente veio do Mercado Pago e não foi forjada por terceiros.
    const webhookSecret = process.env.MERCADOPAGO_WEBHOOK_SECRET;
    if (!webhookSecret) {
        console.error('Webhook do Mercado Pago recusado: segredo de assinatura não configurado.');
        return res.status(503).send('Webhook signature is not configured');
    }
    try {
        WebhookSignatureValidator.validate({
            xSignature: req.headers['x-signature'],
            xRequestId: req.headers['x-request-id'],
            dataId: req.query['data.id'] || req.body?.data?.id,
            secret: webhookSecret
        });
    } catch (err) {
        const reason = err instanceof InvalidWebhookSignatureError ? err.reason : err.message;
        console.error(`❌ Webhook do Mercado Pago rejeitado (assinatura inválida): ${reason}`);
        return res.status(401).send('Invalid signature');
    }

    try {
        const { type, data } = req.body || {};

        if (!mpClient) {
            console.error('Webhook do Mercado Pago recebido sem cliente configurado.');
            return res.status(503).send('Payment provider unavailable');
        }
        if (!data?.id) return res.status(200).send('Ignored');

        // Autorização cria/atualiza a assinatura, mas não confirma que uma cobrança foi liquidada.
        if (type === 'subscription_preapproval') {
            const preApproval = new PreApproval(mpClient);
            const subscription = await preApproval.get({ id: data.id });

            if (!subscription) return res.status(200).send('Subscription not found');

            if (['cancelled', 'paused'].includes(subscription.status)) {
                // Assinatura cancelada/pausada: rebaixa o plano para não deixar benefício ativo indevidamente
                let metadata = {};
                try { metadata = JSON.parse(subscription.external_reference || '{}'); } catch (e) { /* noop */ }
                const email = (metadata.email || subscription.payer_email || '').toLowerCase().trim();
                if (metadata.userId) {
                    // Pelo ID: continua funcionando mesmo que o usuário tenha trocado de e-mail depois de assinar.
                    // Só rebaixa se for a assinatura atual do usuário: o cancelamento de uma assinatura antiga
                    // não pode derrubar o plano de uma assinatura nova que está ativa.
                    await pool.query(
                        `UPDATE users SET plan_status = 'INACTIVE',
                                mp_subscription_id = CASE WHEN $3 = 'cancelled' THEN NULL ELSE mp_subscription_id END
                         WHERE id = $1 AND (mp_subscription_id IS NULL OR mp_subscription_id = $2)`,
                        [metadata.userId, String(subscription.id), subscription.status]
                    );
                    console.log(`⛔ Assinatura ${subscription.status} (${subscription.id}) — plano do usuário ${metadata.userId} marcado como INACTIVE`);
                } else if (email) {
                    await pool.query(`UPDATE users SET plan_status = 'INACTIVE' WHERE LOWER(email) = $1`, [email]);
                    console.log(`⛔ Assinatura ${subscription.status} — plano de ${email} marcado como INACTIVE`);
                }
            }

            // Reforço: se o usuário não tem id salvo (contas antigas), vincula a assinatura autorizada
            // para que o botão de cancelar consiga encerrá-la.
            if (subscription.status === 'authorized') {
                let authMeta = {};
                try { authMeta = JSON.parse(subscription.external_reference || '{}'); } catch (e) { /* noop */ }
                if (authMeta.userId) {
                    await pool.query(
                        `UPDATE users SET mp_subscription_id = $2 WHERE id = $1 AND mp_subscription_id IS NULL`,
                        [authMeta.userId, String(subscription.id)]
                    );
                }

                // Trial: com o cartão autorizado no Mercado Pago, o acesso começa agora (a primeira cobrança
                // só acontece ao fim dos 7 dias). "free_trial_used IS NOT TRUE" faz notificações repetidas
                // não reiniciarem o teste nem duplicarem o lembrete por e-mail.
                if (authMeta.trial && authMeta.userId) {
                    const trialEnd = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
                    const started = await pool.query(
                        `UPDATE users SET free_trial_used = TRUE, trial_start_date = CURRENT_TIMESTAMP, trial_end_date = $3,
                                plan_tier = 'STARTER', plan_status = 'ACTIVE', mp_subscription_id = $2
                         WHERE id = $1 AND free_trial_used IS NOT TRUE`,
                        [authMeta.userId, String(subscription.id), trialEnd]
                    );
                    if (started.rowCount > 0) {
                        console.log(`🎁 Trial iniciado para o usuário ${authMeta.userId} - termina em ${trialEnd.toISOString()}`);
                        scheduleTrialReminder(authMeta.userId, trialEnd).catch(err =>
                            console.error('Erro ao agendar lembrete do trial:', err?.message || err));
                    }
                }
            }
            return res.status(200).send('OK');
        }

        // A primeira ativação exige a fatura da assinatura efetivamente aprovada.
        if (type === 'subscription_authorized_payment') {
            const invoice = await new Invoice(mpClient).get({ id: data.id });
            if (!invoice || invoice.payment?.status !== 'approved') {
                console.log(`ℹ️ Cobrança recorrente ${data.id} recebida sem aprovação: ${invoice?.payment?.status || 'desconhecida'}`);
                return res.status(200).send('Payment not approved');
            }
            if (!invoice.preapproval_id) {
                console.error(`Cobrança recorrente ${data.id} sem preapproval_id.`);
                return res.status(200).send('Subscription reference missing');
            }

            const subscription = await new PreApproval(mpClient).get({ id: invoice.preapproval_id });
            if (!subscription) throw new Error(`Assinatura ${invoice.preapproval_id} não encontrada para a cobrança ${data.id}.`);

            // Cobrança que chegou depois do cancelamento/pausa não pode reativar o plano.
            if (['cancelled', 'paused'].includes(subscription.status)) {
                console.log(`ℹ️ Cobrança ${data.id} ignorada: a assinatura ${invoice.preapproval_id} está ${subscription.status}.`);
                return res.status(200).send('Subscription not active');
            }

            // Verifica se é um trial
            let metadata = {};
            try { metadata = JSON.parse(subscription.external_reference || '{}'); } catch (e) { /* noop */ }

            if (metadata.trial && metadata.userId) {
                // É um trial - marca as datas no banco usando o userId
                const trialEnd = metadata.trialEnd ? new Date(metadata.trialEnd) : null;
                const userId = metadata.userId;

                const trialAlreadyStarted = userId
                    ? (await pool.query('SELECT free_trial_used FROM users WHERE id = $1', [userId])).rows[0]?.free_trial_used
                    : false;

                if (userId && trialEnd && !trialAlreadyStarted) {
                    await pool.query(
                        `UPDATE users SET
                         free_trial_used = TRUE,
                         trial_start_date = CURRENT_TIMESTAMP,
                         trial_end_date = $1,
                         plan_tier = 'STARTER',
                         plan_status = 'ACTIVE'
                         WHERE id = $2`,
                        [trialEnd, userId]
                    );
                    console.log(`🎁 Trial iniciado para usuário ${userId} - termina em ${trialEnd}`);

                    // Agendar aviso de email 1 dia antes
                    scheduleTrialReminder(userId, trialEnd);
                }
            }

            await applyPlanFromReference(
                subscription.external_reference,
                subscription.payer_email,
                invoice.transaction_amount,
                invoice.currency_id,
                invoice.preapproval_id
            );
            return res.status(200).send('OK');
        }

        // Mantido por compatibilidade: pagamento único via Preference (fluxo antigo)
        if (type === 'payment') {
            const paymentInstance = new Payment(mpClient);
            const payment = await paymentInstance.get({ id: data.id });

            if (!payment || payment.status !== 'approved') {
                console.log(`ℹ️ Pagamento ${data.id} recebido com status: ${payment?.status || 'desconhecido'}`);
                return res.status(200).send('Payment not approved');
            }

            await applyPlanFromReference(payment.external_reference, payment.payer?.email, payment.transaction_amount, payment.currency_id);
            return res.status(200).send('OK');
        }

        // Outros tipos de notificação não alteram planos.
        return res.status(200).send('Ignored');
    } catch (error) {
        console.error('Erro no processamento do webhook do Mercado Pago:', error?.message || error);
        // 5xx faz o Mercado Pago tentar entregar a notificação novamente.
        return res.status(500).send('Temporary processing error');
    }
});

// Avisa por e-mail o DONO do workspace quando alguém pede para entrar (o aviso do painel continua igual).
// Nunca atrapalha o fluxo: qualquer falha de envio só vai para o log.
async function emailOwnerAboutJoinRequest(companyId, requesterId, requesterName, requesterEmail) {
    try {
        const ownerRes = await pool.query(
            `SELECT c.name AS company_name, o.id AS owner_id, o.name AS owner_name, o.email AS owner_email
             FROM companies c JOIN users o ON o.id = c.owner_id
             WHERE c.id = $1`,
            [companyId]
        );
        let recipients = ownerRes.rows.map((r) => ({ name: r.owner_name, email: r.owner_email, id: r.owner_id, company: r.company_name }));

        // Empresa sem dono definido: avisa quem recebe o aviso no painel (donos e gerentes).
        if (recipients.length === 0) {
            const fallback = await pool.query(
                `SELECT u.id, u.name, u.email, c.name AS company_name
                 FROM users u JOIN companies c ON c.id = u.company_id
                 WHERE u.company_id = $1 AND u.role IN ('OWNER', 'MANAGER') AND COALESCE(u.membership_status, 'ACTIVE') = 'ACTIVE'`,
                [companyId]
            );
            recipients = fallback.rows.map((r) => ({ name: r.name, email: r.email, id: r.id, company: r.company_name }));
        }

        for (const to of recipients) {
            if (!to.email || Number(to.id) === Number(requesterId)) continue;
            await sendMail({
                to: to.email,
                subject: `Novo pedido de entrada no workspace ${to.company}`,
                html: `<div style="font-family: Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px;">
                    <h2 style="margin: 0 0 12px;">Olá, ${escapeHtml(String(to.name || '').split(' ')[0] || 'tudo bem')}!</h2>
                    <p style="color: #475569; line-height: 1.6;"><strong>${escapeHtml(requesterName)}</strong> (${escapeHtml(requesterEmail)}) pediu para entrar no workspace <strong>${escapeHtml(to.company)}</strong> usando o código de convite.</p>
                    <p style="color: #475569; line-height: 1.6;">Entre no KL Web e abra as notificações para aprovar ou recusar o pedido. Enquanto isso, a pessoa não tem acesso aos dados da empresa.</p>
                    <p style="margin: 24px 0;"><a href="${SITE_URL}" style="background: #0e7490; color: #fff; padding: 12px 22px; border-radius: 8px; text-decoration: none; font-weight: 600;">Abrir o KL Web</a></p>
                    <p style="color: #64748b; font-size: 13px; line-height: 1.5;">Se você não reconhece esta pessoa, basta recusar o pedido no painel.</p>
                </div>`
            });
        }
    } catch (err) {
        console.error('Erro ao avisar o dono por e-mail sobre o pedido de entrada:', err.message);
    }
}

app.post('/api/company/request-join', authenticateToken, async (req, res) => {
    const { companyCode } = req.body;
    if (!companyCode) {
        return res.status(400).json({ message: 'O código da empresa é obrigatório.' });
    }

    try {
        const ownedCompany = await pool.query(
            'SELECT id FROM companies WHERE owner_id = $1 LIMIT 1',
            [req.user.id]
        );
        if (ownedCompany.rows.length > 0) {
            return res.status(403).json({ message: 'Transfira a propriedade da sua empresa antes de solicitar entrada em outra.' });
        }

        const cleanCode = companyCode.trim().toUpperCase();
        const companyResult = await pool.query(
            'SELECT id, name FROM companies WHERE invite_code = $1',
            [cleanCode]
        );

        if (companyResult.rows.length === 0) {
            return res.status(404).json({ message: 'Código de empresa inválido.' });
        }

        const companyId = companyResult.rows[0].id;

        // Verifica se o usuário já faz parte desta empresa
        const memberCheck = await pool.query(
            'SELECT id FROM users WHERE id = $1 AND company_id = $2',
            [req.user.id, companyId]
        );

        if (memberCheck.rows.length > 0) {
            return res.status(400).json({ message: 'Você já é membro desta empresa.' });
        }

        // Atualiza o usuário para PENDING na nova empresa
        await pool.query(
            `UPDATE users SET company_id = $1, role = 'USER', membership_status = 'PENDING', requested_at = CURRENT_TIMESTAMP WHERE id = $2`,
            [companyId, req.user.id]
        );

        // Notifica donos e gerentes da empresa
        await pool.query(`
            INSERT INTO notifications (user_id, user_email, title, message, type)
            SELECT id, email, 'Nova Solicitação de Entrada',
                   'O usuário ' || $1 || ' (' || $2 || ') solicitou entrada na empresa via código.',
                   'approval_request'
            FROM users
            WHERE company_id = $3 AND role IN ('OWNER', 'MANAGER')
        `, [req.user.name, req.user.email, companyId]);
        emailOwnerAboutJoinRequest(companyId, req.user.id, req.user.name, req.user.email);

        res.json({
            success: true,
            message: `Solicitação de entrada enviada para a empresa ${companyResult.rows[0].name} com sucesso! Aguarde a aprovação de um gestor.`
        });
    } catch (err) {
        console.error('Erro ao processar solicitação de entrada:', err.message);
        res.status(500).json({ message: 'Erro interno ao processar solicitação de entrada.' });
    }
});

app.get('/api/company/code', authenticateToken, async (req, res) => {
    try {
        let companyId = req.user.companyId;
        if (!companyId) {
            const userRes = await pool.query(`SELECT company_id FROM users WHERE id = $1`, [req.user.id]);
            if (userRes.rows.length > 0 && userRes.rows[0].company_id) {
                companyId = userRes.rows[0].company_id;
                req.user.companyId = companyId;
            }
        }

        if (!companyId) {
            return res.json({ code: null, name: null });
        }

        const result = await pool.query(
            `SELECT invite_code, name FROM companies WHERE id = $1`,
            [companyId]
        );

        if (result.rows.length === 0) {
            return res.json({ code: null, name: null });
        }

        res.json({
            code: result.rows[0].invite_code,
            name: result.rows[0].name
        });
    } catch (err) {
        console.error('Erro ao buscar código da empresa:', err.message);
        res.status(500).json({ message: 'Erro ao buscar código da empresa.' });
    }
});

app.get('/api/company/pending-requests', authenticateToken, async (req, res) => {
    if (!['OWNER', 'MANAGER'].includes(req.user.role)) {
        return res.status(403).json({ message: 'Acesso negado.' });
    }

    try {
        const result = await pool.query(`
            SELECT id, name, email, phone, requested_at
            FROM users
            WHERE company_id = $1 AND membership_status = 'PENDING'
            ORDER BY requested_at ASC
        `, [req.user.companyId]);

        res.json(decryptUsers(result.rows));
    } catch (err) {
        console.error('Erro ao buscar solicitações pendentes:', err.message);
        res.status(500).json({ message: 'Erro ao buscar solicitações pendentes.' });
    }
});

app.post('/api/company/approve-request', authenticateToken, async (req, res) => {
    const { userId } = req.body;

    if (!['OWNER', 'MANAGER'].includes(req.user.role)) {
        return res.status(403).json({ message: 'Acesso negado.' });
    }

    try {
        // Mesmo limite de membros do plano já aplicado em /api/company/add-member. Sem esta
        // checagem, uma empresa no plano gratuito podia crescer sem limite só pedindo para
        // entrar com o código da empresa em vez de ser convidada — o convite direto bloqueava,
        // mas aprovar uma solicitação pendente não bloqueava nada.
        const membersCountResult = await pool.query(
            `SELECT COUNT(*) as count FROM users WHERE company_id = $1 AND membership_status = 'ACTIVE'`,
            [req.user.companyId]
        );
        const currentMembersCount = parseInt(membersCountResult.rows[0].count, 10);
        const planLimits = PLAN_LIMITS[req.user.planTier] || PLAN_LIMITS.BASICO;

        if (currentMembersCount >= planLimits.userLimit) {
            return res.status(403).json({
                message: `Limite de usuários atingido para o plano ${req.user.planTier}. Faça upgrade para aprovar mais membros.`,
                currentLimit: planLimits.userLimit,
                upgradeRequired: true
            });
        }

        const result = await pool.query(
            `UPDATE users SET membership_status = 'ACTIVE', requested_at = NULL
             WHERE id = $1 AND company_id = $2 RETURNING email, name`,
            [userId, req.user.companyId]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Solicitação não encontrada.' });
        }

        const user = decryptUser(result.rows[0]);

        await notifyUser(user, 'request_decision', 'Sua solicitação foi aprovada!',
            `Sua solicitação para entrar na empresa foi aprovada por ${req.user.name}. Você já pode fazer login na plataforma.`);

        res.json({ message: `Solicitação de ${user.name} aprovada com sucesso!` });
    } catch (err) {
        console.error('Erro ao aprovar solicitação:', err.message);
        res.status(500).json({ message: 'Erro ao aprovar solicitação.' });
    }
});

app.post('/api/company/reject-request', authenticateToken, async (req, res) => {
    const { userId } = req.body;

    if (!['OWNER', 'MANAGER'].includes(req.user.role)) {
        return res.status(403).json({ message: 'Acesso negado.' });
    }

    try {
        const result = await pool.query(
            `UPDATE users SET company_id = NULL, membership_status = 'ACTIVE', requested_at = NULL
             WHERE id = $1 AND company_id = $2 RETURNING email, name`,
            [userId, req.user.companyId]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Solicitação não encontrada.' });
        }

        const user = decryptUser(result.rows[0]);

        await notifyUser(user, 'request_decision', 'Sua solicitação foi rejeitada',
            'Sua solicitação para entrar na empresa foi rejeitada. Entre em contato com o administrador para mais informações.');

        res.json({ message: `Solicitação de ${user.name} rejeitada.` });
    } catch (err) {
        console.error('Erro ao rejeitar solicitação:', err.message);
        res.status(500).json({ message: 'Erro ao rejeitar solicitação.' });
    }
});

app.get('/api/support/admin/chats', authenticateToken, async (req, res) => {
    if (!req.user.isSiteStaff) {
        return res.status(403).json({ message: 'Acesso negado.' });
    }

    try {
        // Exemplo de consulta das filas/chats de suporte
        const result = await pool.query(
            `SELECT * FROM support_chats ORDER BY updated_at DESC`
        );
        res.json({ chats: result.rows });
    } catch (err) {
        console.error('Erro ao buscar chats de admin:', err.message);
        res.status(500).json({ message: 'Erro interno no servidor.' });
    }
});

app.post('/api/company/change-role', authenticateToken, async (req, res) => {
    const { userId, newRole } = req.body;

    if (req.user.companyRole !== 'OWNER') {
        return res.status(403).json({ message: 'Apenas o dono pode alterar cargos.' });
    }

    if (!['USER', 'MANAGER'].includes(newRole)) {
        return res.status(400).json({ message: 'Cargo inválido.' });
    }

    try {
        const result = await pool.query(
            `UPDATE users SET role = $1
             WHERE id = $2 AND company_id = $3
               AND ((SELECT owner_id FROM companies WHERE id = $3) IS NULL
                    OR id <> (SELECT owner_id FROM companies WHERE id = $3))
             RETURNING name, email`,
            [newRole, userId, req.user.companyId]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Usuário não encontrado.' });
        }

        const user = result.rows[0];

        notifyUser(user, 'role_changed', 'Seu cargo foi alterado',
            `Seu cargo foi alterado para ${newRole === 'MANAGER' ? 'Gerente' : 'Funcionário'} por ${req.user.name}.`);

        res.json({ message: `Cargo de ${user.name} alterado para ${newRole} com sucesso!` });
    } catch (err) {
        console.error('Erro ao alterar cargo:', err.message);
        res.status(500).json({ message: 'Erro ao alterar cargo.' });
    }
});

app.post('/api/company/add-member', authenticateToken, async (req, res) => {
    const { memberEmail, role } = req.body;
    if (!req.user.companyId || !['OWNER', 'MANAGER'].includes(req.user.role)) {
        return res.status(403).json({ message: 'Apenas o Dono ou um Gerente da empresa pode adicionar membros.' });
    }
    if (!memberEmail) {
        return res.status(400).json({ message: 'Informe o e-mail do colaborador.' });
    }
    if (!isValidEmail(memberEmail)) {
        return res.status(400).json({ message: 'Informe um e-mail válido para o colaborador, por exemplo: nome@empresa.com.' });
    }

    const cleanEmail = memberEmail.trim().toLowerCase();

    try {
        // Verificar limites de usuários por plano. Só conta membros ATIVOS (uma solicitação
        // pendente ainda não ocupa vaga) — mesmo critério usado em /api/company/approve-request.
        const membersCountResult = await pool.query(
            `SELECT COUNT(*) as count FROM users WHERE company_id = $1 AND membership_status = 'ACTIVE'`,
            [req.user.companyId]
        );
        const currentMembersCount = parseInt(membersCountResult.rows[0].count);

        const planLimits = PLAN_LIMITS[req.user.planTier] || PLAN_LIMITS.BASICO;

        if (currentMembersCount >= planLimits.userLimit) {
            return res.status(403).json({
                message: `Limite de usuários atingido para o plano ${req.user.planTier}. Faça upgrade para adicionar mais membros.`,
                currentLimit: planLimits.userLimit,
                upgradeRequired: true
            });
        }

        const memberResult = await pool.query(
            `SELECT u.id, u.name, u.email, u.company_id, u.is_active, u.membership_status, c.owner_id AS current_company_owner_id
             FROM users u
             LEFT JOIN companies c ON c.id = u.company_id
             WHERE LOWER(TRIM(u.email)) = $1`,
            [cleanEmail]
        );
        const member = decryptUser(memberResult.rows[0]);
        if (!member) {
            return res.status(404).json({ message: 'Este e-mail precisa se cadastrar na plataforma antes de ser conectado.' });
        }
        if (member.is_active === 0 || member.is_active === false) {
            return res.status(403).json({ message: 'Esta conta está desativada.' });
        }
        if (Number(member.current_company_owner_id) === Number(member.id) && member.company_id !== req.user.companyId) {
            return res.status(400).json({ message: 'O Dono de outra empresa não pode ser transferido como membro.' });
        }
        // Fix: só pode adicionar quem não tem empresa ou já está na mesma
        if (member.company_id && Number(member.company_id) !== Number(req.user.companyId)) {
            return res.status(400).json({ message: 'Este usuário já pertence a outra empresa.' });
        }

        const newRole = role || 'USER';
        if (!['USER', 'MANAGER'].includes(newRole)) {
            return res.status(400).json({ message: 'O cargo do novo membro deve ser Funcionário ou Gerente.' });
        }
        await pool.query(`UPDATE users SET company_id = $1, role = $2, membership_status = $3 WHERE id = $4`, [req.user.companyId, newRole, 'ACTIVE', member.id]);

        await pool.query(`
            INSERT INTO notifications (user_id, user_email, title, message, type)
            VALUES ($1, $2, $3, $4, 'info')
        `, [req.user.id, req.user.email, 'Conexão Adicionada', `A conta ${member.email} foi conectada ao seu workspace.`]);

        notifyUser(member, 'member_added', 'Nova Conexão Ativa',
            `Você foi conectado à empresa por ${req.user.name} como ${newRole === 'MANAGER' ? 'Gerente' : 'Funcionário'}.`);

        console.log(`🔗 [POSTGRESQL] ${req.user.email} conectou-se a ${cleanEmail}`);
        res.json({ message: `Colaborador ${member.name} (${member.email}) conectado com sucesso!` });
    } catch (err) {
        console.error('Erro ao salvar conexão no PostgreSQL:', err.message);
        res.status(500).json({ message: 'Erro ao salvar conexão no banco de dados.' });
    }
});

app.get('/api/company/members', authenticateToken, requireCompany, async (req, res) => {
    const companyId = req.user.companyId;
    try {
        const result = await pool.query(`
            SELECT u.id, u.name, u.email,
                   CASE WHEN c.owner_id = u.id THEN 'OWNER' ELSE u.role END AS role,
                   u.phone, u.is_active, u.company_id
            FROM users u
            LEFT JOIN companies c ON c.id = u.company_id
            WHERE u.company_id = $1
        `, [companyId]);
        const members = decryptUsers(result.rows).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        res.json(members);
    } catch (err) {
        console.error('Erro ao buscar conexões:', err.message);
        res.status(500).json({ error: 'Erro ao buscar membros da equipe.' });
    }
});

app.get('/api/company/playbooks', authenticateToken, requireCompany, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT * FROM playbooks WHERE company_id = $1 OR is_system = TRUE ORDER BY created_at DESC`,
            [req.user.companyId]
        );
        res.json(result.rows);
    } catch (err) {
        console.error('Erro ao buscar playbooks:', err.message);
        res.status(500).json({ error: 'Erro ao carregar playbooks.' });
    }
});

app.delete('/api/company/members/:id', authenticateToken, async (req, res) => {
    const memberId = parseInt(req.params.id);

    if (!req.user.companyId || !['OWNER', 'MANAGER'].includes(req.user.role)) {
        return res.status(403).json({ message: 'Apenas o Dono ou um Gerente pode remover membros da empresa.' });
    }

    if (memberId === req.user.id) {
        return res.status(400).json({ message: 'Você não pode desvincular a si mesmo do seu próprio workspace.' });
    }

    try {
        const result = await pool.query(
            `UPDATE users SET company_id = NULL, role = 'USER'
             WHERE id = $1 AND company_id = $2
               AND ((SELECT owner_id FROM companies WHERE id = $2) IS NULL
                    OR id <> (SELECT owner_id FROM companies WHERE id = $2))
             RETURNING id, email, name`,
            [memberId, req.user.companyId]
        );
        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'E-mail não encontrado nesta conexão.' });
        }
        notifyUser(result.rows[0], 'member_removed', 'Você foi removido da empresa',
            `${req.user.name} removeu sua conta da conexão com a empresa. Sua conta continua ativa, mas você não tem mais acesso aos dados dela.`);
        res.json({ message: 'E-mail removido da conexão com sucesso. A conta foi preservada.' });
    } catch (err) {
        console.error('Erro ao remover conexão:', err.message);
        res.status(500).json({ message: 'Erro ao remover membro.' });
    }
});

app.post('/api/company/replace-member', authenticateToken, async (req, res) => {
    const { oldMemberEmail, newMemberEmail, newPassword } = req.body;

    if (!oldMemberEmail || !newMemberEmail) {
        return res.status(400).json({ message: 'Informe o e-mail antigo e o novo e-mail cadastrado.' });
    }
    if (!isValidEmail(oldMemberEmail) || !isValidEmail(newMemberEmail)) {
        return res.status(400).json({ message: 'Informe e-mails válidos (com @ e domínio, ex.: nome@empresa.com).' });
    }

    const cleanOld = oldMemberEmail.trim().toLowerCase();
    const cleanNew = newMemberEmail.trim().toLowerCase();
    const companyId = req.user.companyId || req.user.company_id;

    if (!companyId) {
        return res.status(400).json({ message: 'Empresa não identificada para este usuário.' });
    }
    // Antes qualquer membro podia tirar um colega da empresa por esta rota.
    if (!['OWNER', 'MANAGER', 'ADMIN'].includes(String(req.user.role || '').toUpperCase())) {
        return res.status(403).json({ message: 'Apenas o Dono ou Gerentes podem substituir o e-mail de um membro.' });
    }

    const client = await pool.connect();

    try {
        // 1. Busca membro antigo
        const oldUserResult = await client.query(
            `SELECT u.id, u.name, c.owner_id
             FROM users u
             LEFT JOIN companies c ON c.id = u.company_id
             WHERE LOWER(u.email) = $1 AND u.company_id = $2`,
            [cleanOld, companyId]
        );
        const oldUser = oldUserResult.rows[0];
        if (!oldUser) {
            client.release();
            return res.status(404).json({ message: 'O e-mail antigo não foi encontrado nesta empresa.' });
        }
        if (Number(oldUser.owner_id) === Number(oldUser.id)) {
            client.release();
            return res.status(403).json({ message: 'O Dono da empresa não pode ser substituído como membro.' });
        }

        // 2. Busca membro novo
        const newUserResult = await client.query(
            `SELECT u.id, u.name, u.company_id, c.owner_id AS current_company_owner_id
             FROM users u
             LEFT JOIN companies c ON c.id = u.company_id
             WHERE LOWER(u.email) = $1`,
            [cleanNew]
        );
        const newUser = newUserResult.rows[0];
        if (!newUser) {
            client.release();
            return res.status(404).json({ message: 'O novo e-mail precisa estar previamente cadastrado na plataforma.' });
        }
        if (Number(newUser.current_company_owner_id) === Number(newUser.id) && newUser.company_id !== companyId) {
            client.release();
            return res.status(400).json({ message: 'O Dono de outra empresa não pode ser transferido como membro.' });
        }

        // 3. Busca demandas ativas do funcionário antigo para a IA analisar
        const demandsResult = await client.query(
            `SELECT title, description, status FROM demands WHERE (user_id = $1 OR assigned_user_id = $1) AND company_id = $2`,
            [oldUser.id, companyId]
        );
        const oldUserDemands = demandsResult.rows;

        // 4. Início da Transação SQL
        await client.query('BEGIN');

        // Atualiza a empresa do novo usuário
        await client.query(`UPDATE users SET company_id = $1 WHERE id = $2`, [companyId, newUser.id]);

        // Opcional: Atualiza a senha do novo membro se enviada na requisição
        if (newPassword && newPassword.length >= 4) {
            const hashedPassword = await bcrypt.hash(newPassword, 10);
            await client.query(`UPDATE users SET password = $1 WHERE id = $2`, [hashedPassword, newUser.id]);
        }

        // Isolamento do usuário antigo em workspace individual
        const isolatedCompany = await client.query(
            `INSERT INTO companies (name) VALUES ($1) RETURNING id`,
            ['Workspace Individual Antigo']
        );
        const isolatedCompanyId = isolatedCompany.rows[0].id;
        await client.query(`UPDATE users SET company_id = $1 WHERE id = $2`, [isolatedCompanyId, oldUser.id]);

        // Transferência de demandas
        await client.query(`UPDATE demands SET user_id = $1 WHERE user_id = $2 AND company_id = $3`, [newUser.id, oldUser.id, companyId]);
        await client.query(
            `UPDATE demands SET assigned_user_id = $1, assigned_user_name = $2, assigned_user_email = $3 WHERE assigned_user_id = $4 AND company_id = $5`,
            [newUser.id, newUser.name, cleanNew, oldUser.id, companyId]
        );

        await client.query('COMMIT');

        // 5. Execução da IA: Gerar briefing/resumo de transição para o novo membro
        let aiSummary = '';
        if (oldUserDemands.length > 0 && process.env.GEMINI_API_KEY) {
            try {
                const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
                const prompt = `Atue como um gestor de projetos. O colaborador ${oldUser.name} foi substituído por ${newUser.name}.
                Abaixo está a lista de demandas em andamento que foram transferidas:
                ${JSON.stringify(oldUserDemands, null, 2)}

                Gere um resumo curto e direto (em até 3 tópicos) orientando ${newUser.name} sobre as principais tarefas que deve priorizar agora.`;

                const aiResponse = await model.generateContent(prompt);
                aiSummary = aiResponse.response.text();
            } catch (aiErr) {
                console.error('Erro ao gerar resumo da IA na transição:', aiErr.message);
                aiSummary = 'Demandas transferidas com sucesso. O resumo de IA não pôde ser gerado no momento.';
            }
        } else {
            aiSummary = 'O novo colaborador não possui demandas pendentes no momento.';
        }

        return res.json({
            message: `Conexão transferida com sucesso de ${cleanOld} para ${cleanNew}!`,
            passwordUpdated: !!(newPassword && newPassword.length >= 4),
            aiBriefing: aiSummary
        });

    } catch (err) {
        await client.query('ROLLBACK').catch(() => { });
        console.error('Erro ao transferir conexão:', err.message);
        return res.status(500).json({ message: 'Erro ao vincular nova conta.' });
    } finally {
        client.release();
    }
});

app.get('/api/demands', authenticateToken, requireCompany, async (req, res) => {
    const userEmail = req.user.email ? req.user.email.trim().toLowerCase() : '';
    const companyId = req.user.companyId;
    try {
        // checklist_total/checklist_done/comment_count viram os badges do card no board
        // (ver renderKanban em app.js) — agregados aqui pra não precisar de N+1 requests,
        // uma por card, só pra saber se ele tem checklist ou comentário.
        const result = await pool.query(`
        SELECT d.id, d.company_id, d.user_id, d.title, d.description, d.priority, d.status,
               d.assigned_user_id, d.assigned_user_name, d.assigned_user_email,
               d.completed_at, d.created_at, d.position,
               COALESCE(cl.total, 0) AS checklist_total,
               COALESCE(cl.done, 0) AS checklist_done,
               COALESCE(cm.total, 0) AS comment_count
        FROM demands d
        LEFT JOIN (
            SELECT demand_id, COUNT(*) AS total, COUNT(*) FILTER (WHERE done) AS done
            FROM demand_checklist_items GROUP BY demand_id
        ) cl ON cl.demand_id = d.id
        LEFT JOIN (
            SELECT demand_id, COUNT(*) AS total FROM demand_comments GROUP BY demand_id
        ) cm ON cm.demand_id = d.id
        WHERE d.company_id = $1
        ORDER BY d.status ASC, d.position ASC, d.created_at DESC
        `, [companyId]);
        res.json(result.rows);
    } catch (err) {
        console.error('❌ Erro ao buscar demandas:', err.message);
        res.status(500).json({ error: 'Erro ao carregar demandas do banco.' });
    }
});

// Detalhe completo de UMA demanda, incluindo checklist e comentários — usado pelo modal
// de card (ver openDemandDetail em app.js). Qualquer pessoa da empresa pode VER; editar
// checklist/comentar segue a checagem de permissão de cada rota abaixo.
app.get('/api/demands/:id', authenticateToken, requireCompany, async (req, res) => {
    const demandId = req.params.id;
    const userEmail = req.user.email ? req.user.email.trim().toLowerCase() : '';
    try {
        const demandResult = await pool.query(
            `SELECT * FROM demands WHERE id = $1 AND company_id = $2`,
            [demandId, req.user.companyId]
        );
        const demand = demandResult.rows[0];
        if (!demand) return res.status(404).json({ message: 'Demanda não encontrada.' });

        const checklistResult = await pool.query(
            `SELECT * FROM demand_checklist_items WHERE demand_id = $1 ORDER BY position ASC, id ASC`,
            [demandId]
        );
        const commentsResult = await pool.query(
            `SELECT * FROM demand_comments WHERE demand_id = $1 ORDER BY created_at ASC`,
            [demandId]
        );

        res.json({ ...demand, checklist: checklistResult.rows, comments: commentsResult.rows });
    } catch (err) {
        console.error('Erro ao buscar detalhe da demanda:', err.message);
        res.status(500).json({ message: 'Erro ao buscar demanda.' });
    }
});

app.post('/api/demands', authenticateToken, requireCompany, async (req, res) => {
    const {
        title,
        description,
        priority = 'MEDIA',
        status,
        assigned_user_email,
        assignedUserEmail,
        assigned_user_name
    } = req.body;

    // 1. Validação de perfil (Apenas OWNER e MANAGER)
    if (!['OWNER', 'MANAGER'].includes(req.user.role)) {
        return res.status(403).json({ message: 'Apenas gerentes e donos podem criar demandas.' });
    }

    // 2. Validação dos campos obrigatórios
    if (!title || !title.trim()) {
        return res.status(400).json({ message: 'O título da demanda é obrigatório.' });
    }

    const cleanTargetEmail = (assigned_user_email || assignedUserEmail || '').trim().toLowerCase();

    try {
        // 3. Verificação de limites do plano contratado
        const demandsCountResult = await pool.query(
            `SELECT COUNT(*) as count FROM demands WHERE company_id = $1`,
            [req.user.companyId]
        );
        const currentDemandsCount = parseInt(demandsCountResult.rows[0].count, 10);
        const planLimits = PLAN_LIMITS[req.user.planTier] || PLAN_LIMITS.BASICO;

        if (currentDemandsCount >= planLimits.demandsLimit) {
            return res.status(403).json({
                message: `Limite de demandas atingido para o plano ${req.user.planTier}. Faça upgrade para continuar.`,
                currentLimit: planLimits.demandsLimit,
                upgradeRequired: true
            });
        }

        // 4. Busca do usuário atribuído
        let targetUserId = null;
        let targetName = assigned_user_name || 'Colaborador';

        if (cleanTargetEmail) {
            const userResult = await pool.query(
                `SELECT id, name, email FROM users WHERE LOWER(TRIM(email)) = $1 AND company_id = $2 LIMIT 1`,
                [cleanTargetEmail, req.user.companyId]
            );
            if (userResult.rows.length > 0) {
                const targetUser = userResult.rows[0];
                targetUserId = targetUser.id;
                targetName = assigned_user_name || targetUser.name;
            }
        }

        // Definição do status inicial
        const demandStatus = status || (priority === 'URGENTE' ? 'URGENT' : 'TODO');
        const defaultDescription = description || (cleanTargetEmail ? `Demanda atribuída a ${cleanTargetEmail}` : '');

        // Nova demanda entra no fim da coluna (maior position da coluna + 1), não no topo,
        // pra não empurrar os cards que já estavam lá pra baixo sem o usuário pedir isso.
        const positionResult = await pool.query(
            `SELECT COALESCE(MAX(position), -1) + 1 AS next_position FROM demands WHERE company_id = $1 AND status = $2`,
            [req.user.companyId, demandStatus]
        );
        const nextPosition = positionResult.rows[0].next_position;

        // 5. Inserção no PostgreSQL
        const insertQuery = `
            INSERT INTO demands (
                company_id, user_id, title, description, priority, status,
                assigned_user_id, assigned_user_name, assigned_user_email, position
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            RETURNING *
        `;
        const queryValues = [
            req.user.companyId,
            req.user.id,
            title.trim(),
            defaultDescription,
            priority,
            demandStatus,
            targetUserId,
            targetName,
            cleanTargetEmail || null,
            nextPosition
        ];

        const result = await pool.query(insertQuery, queryValues);
        const newDemand = result.rows[0];

        // 6. Envio de Notificações e E-mails
        if (cleanTargetEmail) {
            addSystemNotification(
                cleanTargetEmail,
                'Nova Demanda Atribuída',
                `A demanda "${title.trim()}" foi atribuída a você por ${req.user.name || 'outro usuário'}.`,
                'assignment',
                targetUserId
            );

            if (typeof notifyAssignedEmployee === 'function') {
                notifyAssignedEmployee(cleanTargetEmail, targetName, title.trim(), priority, req.user.name, targetUserId, req.user.companyId);
            }
        }

        addSystemNotification(
            req.user.email,
            'Demanda Criada',
            `A demanda "${title.trim()}" foi criada${cleanTargetEmail ? ` e atribuída a ${cleanTargetEmail}` : ''}.`,
            'assignment',
            req.user.id
        );

        // 7. Execução de Automações do Sistema
        await runAutomations(req.user.companyId, 'DEMAND_CREATED', newDemand);
        if (cleanTargetEmail) await runAutomations(req.user.companyId, 'DEMAND_ASSIGNED', newDemand);
        if (newDemand.priority === 'URGENTE') await runAutomations(req.user.companyId, 'DEMAND_URGENT', newDemand);

        // 8. Tempo real: outros usuários da empresa veem o card novo aparecer sem precisar de F5.
        broadcastBoard(req.user.companyId, 'board_demand_created', newDemand);

        return res.status(201).json(newDemand);

    } catch (err) {
        console.error('Erro ao salvar demanda no PostgreSQL:', err.message);
        return res.status(500).json({ error: 'Erro interno ao criar ou atribuir demanda.' });
    }
});

app.put('/api/demands/:id/assign', authenticateToken, requireCompany, async (req, res) => {
    const { assignedUserEmail } = req.body;
    const demandId = req.params.id;

    if (!['OWNER', 'MANAGER'].includes(req.user.role)) {
        return res.status(403).json({ message: 'Apenas gerentes e donos podem editar demandas.' });
    }

    if (!assignedUserEmail) {
        return res.status(400).json({ message: 'Informe o e-mail do funcionário a receber a demanda.' });
    }

    const cleanEmail = assignedUserEmail.trim().toLowerCase();

    try {
        // Fix: busca usuário só dentro da mesma empresa
        const userResult = await pool.query(`SELECT id, name, email FROM users WHERE LOWER(email) = $1 AND company_id = $2`, [cleanEmail, req.user.companyId]);
        const user = userResult.rows[0];
        if (!user) {
            return res.status(404).json({ message: 'Funcionário não encontrado no sistema. Verifique se o e-mail está cadastrado.' });
        }

        const result = await pool.query(`UPDATE demands
            SET assigned_user_id = $1, assigned_user_name = $2, assigned_user_email = $3
            WHERE id = $4 AND company_id = $5 RETURNING *`,
            [user.id, user.name, user.email, demandId, req.user.companyId]);
        const demand = result.rows[0];
        if (!demand) return res.status(404).json({ message: 'Demanda não encontrada nesta empresa.' });
        notifyAssignedEmployee(user.email, user.name, demand.title, demand.priority, req.user.name, user.id, req.user.companyId);
        await runAutomations(req.user.companyId, 'DEMAND_ASSIGNED', demand);
        res.json({ message: `Demanda transferida para ${user.name} (${user.email}) com sucesso e notificação enviada!` });
    } catch (err) {
        console.error('Erro ao transferir demanda:', err.message);
        res.status(500).json({ message: 'Erro ao transferir demanda.' });
    }
});

app.put('/api/demands/:id/status', authenticateToken, requireCompany, async (req, res) => {
    const { status } = req.body;
    const validStatuses = ['TODO', 'IN_PROGRESS', 'URGENT', 'DONE'];

    if (!['OWNER', 'MANAGER'].includes(req.user.role)) {
        return res.status(403).json({ message: 'Apenas gerentes e donos podem editar demandas.' });
    }

    if (!validStatuses.includes(status)) {
        return res.status(400).json({ message: 'Status inválido.' });
    }

    const completedAt = status === 'DONE' ? new Date().toISOString() : null;

    try {
        const result = await pool.query(`UPDATE demands SET status = $1, completed_at = $2
            WHERE id = $3 AND company_id = $4 RETURNING *`, [status, completedAt, req.params.id, req.user.companyId]);
        const demand = result.rows[0];
        if (!demand) return res.status(404).json({ message: 'Demanda não encontrada nesta empresa.' });
        if (status === 'DONE') await runAutomations(req.user.companyId, 'DEMAND_COMPLETED', demand);
        if (status === 'URGENT') await runAutomations(req.user.companyId, 'DEMAND_URGENT', demand);
        broadcastBoard(req.user.companyId, 'board_demand_updated', {
            id: demand.id, status: demand.status, priority: demand.priority, completed_at: demand.completed_at,
            byUserId: req.user.id, byUserName: req.user.name
        });
        res.json({ message: 'Status atualizado com sucesso.', id: req.params.id, status });
    } catch (err) {
        res.status(500).json({ message: 'Erro ao atualizar status da demanda.' });
    }
});

// Persiste a ordem dos cards após um arraste no board (Sortable no front). Substitui/complementa
// o antigo /status: além de mudar a coluna, agora também grava a posição de cada card dentro
// das colunas afetadas — sem isso, um reordenamento manual "voltava ao normal" a cada F5, porque
// não existia nenhuma coluna 'position' no banco para lembrar a ordem escolhida pelo usuário.
app.put('/api/demands/reorder', authenticateToken, requireCompany, async (req, res) => {
    const { movedId, toStatus, order } = req.body;
    const validStatuses = ['TODO', 'IN_PROGRESS', 'URGENT', 'DONE'];

    if (!['OWNER', 'MANAGER'].includes(req.user.role)) {
        return res.status(403).json({ message: 'Apenas gerentes e donos podem editar demandas.' });
    }

    if (!validStatuses.includes(toStatus)) {
        return res.status(400).json({ message: 'Status inválido.' });
    }

    if (!order || typeof order !== 'object' || Array.isArray(order)) {
        return res.status(400).json({ message: 'Formato de "order" inválido.' });
    }

    // order = { TODO: [id, id, ...], IN_PROGRESS: [id, ...] } — só as colunas realmente
    // afetadas pelo arraste (a de origem e a de destino, quando são diferentes).
    const affectedStatuses = Object.keys(order).filter((s) => validStatuses.includes(s));
    if (affectedStatuses.length === 0) {
        return res.status(400).json({ message: 'Nenhuma coluna válida em "order".' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        for (const columnStatus of affectedStatuses) {
            const ids = order[columnStatus];
            if (!Array.isArray(ids)) continue;

            for (let index = 0; index < ids.length; index++) {
                const cardId = Number(ids[index]);
                if (!cardId) continue;
                const isMovedCard = movedId && Number(movedId) === cardId;

                if (isMovedCard) {
                    const completedAt = columnStatus === 'DONE' ? new Date().toISOString() : null;
                    await client.query(
                        `UPDATE demands SET status = $1, position = $2, completed_at = $3
                         WHERE id = $4 AND company_id = $5`,
                        [columnStatus, index, completedAt, cardId, req.user.companyId]
                    );
                } else {
                    await client.query(
                        `UPDATE demands SET status = $1, position = $2
                         WHERE id = $3 AND company_id = $4`,
                        [columnStatus, index, cardId, req.user.companyId]
                    );
                }
            }
        }

        await client.query('COMMIT');

        // Automações disparadas pela mudança de status só fazem sentido pro card que
        // de fato mudou de coluna (os outros só tiveram a posição ajustada).
        if (movedId) {
            const movedResult = await pool.query(
                `SELECT * FROM demands WHERE id = $1 AND company_id = $2`,
                [movedId, req.user.companyId]
            );
            const movedDemand = movedResult.rows[0];
            if (movedDemand) {
                if (toStatus === 'DONE') await runAutomations(req.user.companyId, 'DEMAND_COMPLETED', movedDemand);
                if (toStatus === 'URGENT') await runAutomations(req.user.companyId, 'DEMAND_URGENT', movedDemand);
            }
        }

        res.json({ message: 'Ordem do board atualizada com sucesso.' });

        // Tempo real: todo mundo da empresa recebe a nova ordem, incluindo quem arrastou —
        // é assim que o estado local (state.demands) fica com a mesma ordem que o servidor
        // gravou, sem precisar de um refetch completo depois de cada arraste.
        broadcastBoard(req.user.companyId, 'board_reordered', {
            movedId: movedId ? Number(movedId) : null,
            toStatus,
            order,
            byUserId: req.user.id,
            byUserName: req.user.name
        });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => { });
        console.error('Erro ao reordenar demandas:', err.message);
        res.status(500).json({ message: 'Erro ao salvar a nova ordem do board.' });
    } finally {
        client.release();
    }
});

app.delete('/api/demands/:id', authenticateToken, requireCompany, async (req, res) => {
    if (!['OWNER', 'MANAGER'].includes(req.user.role)) {
        return res.status(403).json({ message: 'Apenas gerentes e donos podem excluir demandas.' });
    }

    try {
        await pool.query(`DELETE FROM demands WHERE id = $1 AND company_id = $2`, [req.params.id, req.user.companyId]);
        // Sem FK/CASCADE no schema (ver criação das tabelas): limpar manualmente, senão
        // checklist e comentários da demanda excluída ficam órfãos no banco pra sempre.
        await pool.query(`DELETE FROM demand_checklist_items WHERE demand_id = $1`, [req.params.id]);
        await pool.query(`DELETE FROM demand_comments WHERE demand_id = $1`, [req.params.id]);
        res.json({ message: 'Demanda removida com sucesso.' });
        broadcastBoard(req.user.companyId, 'board_demand_deleted', { id: Number(req.params.id) });
    } catch (err) {
        res.status(500).json({ message: 'Erro ao excluir demanda.' });
    }
});

// Confirma que a demanda existe e que o usuário pode vê-la (mesma empresa, ou é o
// atribuído). Usado pelos endpoints de checklist/comentários abaixo antes de qualquer
// escrita — sem isso, alguém de outra empresa poderia comentar numa demanda alheia só
// sabendo o id.
async function canAccessDemand(req, demandId) {
    const companyId = req.user?.companyId || req.user?.company_id;
    if (!companyId) return false;
    const result = await pool.query(
        `SELECT id FROM demands WHERE id = $1 AND company_id = $2`,
        [demandId, companyId]
    );
    return result.rows.length > 0;
}

// ---------- Checklist do cartão ----------
// Aberto a qualquer pessoa da empresa (não só OWNER/MANAGER): quem faz a tarefa geralmente
// é o funcionário atribuído, e é ele quem vai marcar os itens do checklist como feitos.
app.post('/api/demands/:id/checklist', authenticateToken, requireCompany, async (req, res) => {
    const demandId = req.params.id;
    const text = (req.body.text || '').trim();
    if (!text) return res.status(400).json({ message: 'Descreva o item do checklist.' });
    if (text.length > 500) return res.status(400).json({ message: 'Item muito longo (máx. 500 caracteres).' });

    try {
        if (!(await canAccessDemand(req, demandId))) {
            return res.status(404).json({ message: 'Demanda não encontrada.' });
        }
        const posResult = await pool.query(
            `SELECT COALESCE(MAX(position), -1) + 1 AS next_position FROM demand_checklist_items WHERE demand_id = $1`,
            [demandId]
        );
        const result = await pool.query(
            `INSERT INTO demand_checklist_items (demand_id, text, position) VALUES ($1, $2, $3) RETURNING *`,
            [demandId, text, posResult.rows[0].next_position]
        );
        const item = result.rows[0];
        res.status(201).json(item);
        broadcastBoard(req.user.companyId, 'board_checklist_changed', { demandId: Number(demandId) });
    } catch (err) {
        console.error('Erro ao criar item do checklist:', err.message);
        res.status(500).json({ message: 'Erro ao adicionar item ao checklist.' });
    }
});

app.put('/api/demands/:id/checklist/:itemId', authenticateToken, requireCompany, async (req, res) => {
    const { id: demandId, itemId } = req.params;
    const { done, text } = req.body;

    try {
        if (!(await canAccessDemand(req, demandId))) {
            return res.status(404).json({ message: 'Demanda não encontrada.' });
        }

        const fields = [];
        const values = [];
        if (typeof done === 'boolean') { fields.push(`done = $${fields.length + 1}`); values.push(done); }
        if (typeof text === 'string' && text.trim()) {
            if (text.trim().length > 500) return res.status(400).json({ message: 'Item muito longo (máx. 500 caracteres).' });
            fields.push(`text = $${fields.length + 1}`);
            values.push(text.trim());
        }
        if (fields.length === 0) return res.status(400).json({ message: 'Nada para atualizar.' });

        values.push(itemId, demandId);
        const result = await pool.query(
            `UPDATE demand_checklist_items SET ${fields.join(', ')}
             WHERE id = $${values.length - 1} AND demand_id = $${values.length} RETURNING *`,
            values
        );
        if (!result.rows[0]) return res.status(404).json({ message: 'Item não encontrado.' });
        res.json(result.rows[0]);
        broadcastBoard(req.user.companyId, 'board_checklist_changed', { demandId: Number(demandId) });
    } catch (err) {
        console.error('Erro ao atualizar item do checklist:', err.message);
        res.status(500).json({ message: 'Erro ao atualizar item.' });
    }
});

app.delete('/api/demands/:id/checklist/:itemId', authenticateToken, requireCompany, async (req, res) => {
    const { id: demandId, itemId } = req.params;
    try {
        if (!(await canAccessDemand(req, demandId))) {
            return res.status(404).json({ message: 'Demanda não encontrada.' });
        }
        await pool.query(`DELETE FROM demand_checklist_items WHERE id = $1 AND demand_id = $2`, [itemId, demandId]);
        res.json({ message: 'Item removido.' });
        broadcastBoard(req.user.companyId, 'board_checklist_changed', { demandId: Number(demandId) });
    } catch (err) {
        res.status(500).json({ message: 'Erro ao remover item.' });
    }
});

// ---------- Comentários do cartão ----------
app.post('/api/demands/:id/comments', authenticateToken, requireCompany, async (req, res) => {
    const demandId = req.params.id;
    const message = (req.body.message || '').trim();
    if (!message) return res.status(400).json({ message: 'Escreva um comentário.' });
    if (message.length > 2000) return res.status(400).json({ message: 'Comentário muito longo (máx. 2000 caracteres).' });

    try {
        if (!(await canAccessDemand(req, demandId))) {
            return res.status(404).json({ message: 'Demanda não encontrada.' });
        }

        const result = await pool.query(
            `INSERT INTO demand_comments (demand_id, user_id, user_name, message) VALUES ($1, $2, $3, $4) RETURNING *`,
            [demandId, req.user.id, req.user.name, message]
        );
        const comment = result.rows[0];

        // @menções: só reconhece @email@dominio.com (sem espaço, sem ambiguidade de nomes
        // repetidos ou com espaço). O front oferece um autocomplete que já insere nesse
        // formato ao escolher alguém da equipe — ver abrirAutocompleteMencao em app.js.
        const mentionedEmails = [...message.matchAll(/@([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g)]
            .map(m => m[1].toLowerCase());
        if (mentionedEmails.length > 0) {
            const demandResult = await pool.query(`SELECT title FROM demands WHERE id = $1`, [demandId]);
            const demandTitle = demandResult.rows[0]?.title || 'uma demanda';
            const usersResult = await pool.query(
                `SELECT id, email FROM users WHERE company_id = $1 AND LOWER(email) = ANY($2::text[])`,
                [req.user.companyId, mentionedEmails]
            );
            for (const mentionedUser of usersResult.rows) {
                addSystemNotification(
                    mentionedUser.email,
                    'Você foi mencionado',
                    `${req.user.name || 'Alguém'} mencionou você em um comentário na demanda "${demandTitle}".`,
                    'assignment',
                    mentionedUser.id
                );
            }
        }

        res.status(201).json(comment);
        broadcastBoard(req.user.companyId, 'board_comment_added', { demandId: Number(demandId), comment });
    } catch (err) {
        console.error('Erro ao criar comentário:', err.message);
        res.status(500).json({ message: 'Erro ao publicar comentário.' });
    }
});

async function checkStorageLimit(req) {
    try {
        const limits = getUserPlanLimits(req);
        const limit = limits.storageBytes;
        const currentUsage = await getStorageUsage(pool, req.user.companyId, req.user.id);
        const remaining = Math.max(0, limit - currentUsage);
        const allowed = limits.warehouseAllowed && remaining > 0;

        return {
            allowed,
            limit,
            currentUsage,
            remaining,
            planTier: isPlatformOwner(req) ? 'OWNER' : effectiveTier(req.user.plan_tier, req.user.plan_status),
            message: allowed ? 'Armazenamento disponível' : 'Novos uploads bloqueados (limite atingido ou plano sem armazém)'
        };
    } catch (err) {
        console.error('Erro ao verificar limites de armazenamento:', err.message);
        return { allowed: false, limit: 0, currentUsage: 0, remaining: 0, planTier: 'BASICO', message: 'Erro ao verificar limites' };
    }
}

// Exibição e exclusão dinâmica no Armazém
async function loadFiles() {
    try {
        const response = await fetchWithAuth('/api/files');
        const data = await response.json();

        const filesList = document.getElementById('files-list');
        if (filesList) {
            if (data.length === 0) {
                filesList.innerHTML = '<p style="color: var(--text-secondary); text-align: center; padding: 1rem;">Nenhum arquivo no armazém.</p>';
            } else {
                filesList.innerHTML = data.map(file => {
                    const safeName = escapeHtml(file.original_name);
                    const escapedNameForAttr = safeName.replace(/'/g, "\\'"); // Evita quebra nas aspas do onclick

                    return `
                    <div class="member-item">
                        <div class="member-avatar" style="background: var(--primary);">
                            <i class="${getFileIcon(file.mime_type)}"></i>
                        </div>
                        <div class="member-info">
                            <strong>${safeName}</strong>
                            <span>${(file.file_size / (1024 * 1024)).toFixed(2)} MB | ${new Date(file.uploaded_at).toLocaleDateString('pt-BR')}</span>
                        </div>
                        <div class="member-actions">
                            <button class="btn-secondary" onclick="downloadFile(${file.id}, '${escapedNameForAttr}')">
                                <i class="fa-solid fa-download"></i> Baixar
                            </button>
                            <button class="btn-del-member" onclick="deleteFile(${file.id})">
                                <i class="fa-solid fa-trash"></i> Apagar
                            </button>
                        </div>
                    </div>
                `}).join('');
            }
        }
    } catch (error) {
        console.error('Erro ao carregar arquivos:', error);
    }
}

// ROTA DE UPLOAD (Ajuste o caminho onde o arquivo é salvo no banco)
app.post('/api/files/upload', authenticateToken, requireCompany, middlewareArmazem, upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ message: 'Nenhum arquivo enviado.' });
        }

        const saved = await insertFileWithQuota(req);
        if (!saved.ok) {
            return res.status(saved.status).json({ message: saved.message, upgradeRequired: true });
        }

        return res.status(201).json({ message: 'Arquivo enviado com sucesso!', file: saved.row });
    } catch (error) {
        console.error('Erro no upload:', error);
        return res.status(500).json({ message: 'Erro ao salvar arquivo.' });
    }
});
// ROTA DE DOWNLOAD (Busca robusta no disco)
app.get('/api/files/:id/download', authenticateToken, requireCompany, async (req, res) => {
    try {
        const fileId = req.params.id;
        const companyId = req.user.companyId;
        const isPlatformOwner = req.user.isSiteOwner;

        const result = isPlatformOwner
            ? await pool.query(`SELECT * FROM files WHERE id = $1`, [fileId])
            : await pool.query(`SELECT * FROM files WHERE id = $1 AND company_id = $2`, [fileId, companyId]);

        console.log(`[Download Debug] FileID: ${fileId}, UserID: ${req.user.id}, CompanyID: ${companyId}, RowsFound: ${result.rows.length}`);

        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Arquivo não encontrado.' });
        }

        const file = result.rows[0];
        const rawPath = file.file_path || file.path;

        if (!rawPath) {
            return res.status(404).json({ message: 'Caminho do arquivo não registrado no banco.' });
        }

        const fileName = file.original_name || file.name || `arquivo_${fileId}`;

        // Arquivos novos: vêm do Supabase Storage (o acesso continua protegido por login + empresa acima).
        if (String(rawPath).startsWith(SUPABASE_PATH_PREFIX)) {
            if (!supabase) {
                return res.status(503).json({ message: 'O armazenamento em nuvem não está configurado no servidor.' });
            }
            const key = String(rawPath).slice(SUPABASE_PATH_PREFIX.length);
            const { data: blob, error: dlError } = await supabase.storage.from(FILES_BUCKET).download(key);
            if (dlError || !blob) {
                console.error(`[Download Error] Objeto ausente no Supabase (${key}):`, dlError && dlError.message);
                return res.status(404).json({ message: 'Arquivo não encontrado no armazenamento em nuvem.' });
            }
            const buf = Buffer.from(await blob.arrayBuffer());
            res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
            res.setHeader('Content-Length', buf.length);
            res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
            return res.send(buf);
        }

        // Arquivos antigos (gravados em disco antes da migração para o Supabase)
        const absolutePath = path.isAbsolute(rawPath)
            ? rawPath
            : path.resolve(process.cwd(), rawPath.replace(/^\/+/, ''));

        if (!fs.existsSync(absolutePath)) {
            console.error(`[Download Error] Arquivo físico ausente: ${absolutePath}`);
            return res.status(404).json({ message: 'Arquivo não existe mais no disco do servidor.' });
        }

        return res.download(absolutePath, fileName);
    } catch (error) {
        console.error('Erro na rota de download:', error);
        return res.status(500).json({ message: 'Erro interno ao processar download.', details: error.message });
    }
});

app.get('/api/files', authenticateToken, requireCompany, middlewareArmazem, async (req, res) => {
    try {
        const companyId = req.user.companyId;

        const result = await pool.query(`
            SELECT * FROM files
            WHERE company_id = $1
            ORDER BY uploaded_at DESC
        `, [companyId]);

        console.log(`[DEBUG FILES] Encontrados ${result.rows.length} arquivos para CompanyID ${companyId}`);

        res.json(result.rows);
    } catch (err) {
        console.error('Erro ao listar arquivos:', err.message);
        res.status(500).json({ message: 'Erro ao listar arquivos.' });
    }
});

app.get('/api/files/storage-info', authenticateToken, requireCompany, middlewareArmazem, async (req, res) => {
    try {
        const storageInfo = await checkStorageLimit(req);

        // Garante que o retorno seja em Bytes numéricos puros
        res.json({
            allowed: storageInfo.allowed,
            limit: Number(storageInfo.limit), // Ex: 5368709120 para 5GB
            currentUsage: Number(storageInfo.currentUsage),
            remaining: Number(storageInfo.remaining),
            planTier: storageInfo.planTier
        });
    } catch (err) {
        console.error('Erro ao obter informações de armazenamento:', err.message);
        res.status(500).json({ message: 'Erro ao obter informações de armazenamento.' });
    }
});

app.delete('/api/files/:id', authenticateToken, requireCompany, middlewareArmazem, async (req, res) => {
    try {
        const companyId = req.user.companyId;
        const isPlatformOwner = req.user.isSiteOwner;
        const result = isPlatformOwner
            ? await pool.query(`SELECT * FROM files WHERE id = $1`, [req.params.id])
            : await pool.query(`SELECT * FROM files WHERE id = $1 AND company_id = $2`, [req.params.id, companyId]);

        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Arquivo não encontrado.' });
        }

        const file = result.rows[0];

        if (file.file_path && String(file.file_path).startsWith(SUPABASE_PATH_PREFIX)) {
            if (supabase) {
                const key = String(file.file_path).slice(SUPABASE_PATH_PREFIX.length);
                const { error: rmError } = await supabase.storage.from(FILES_BUCKET).remove([key]);
                if (rmError) {
                    console.error('Erro ao remover arquivo do Supabase:', rmError.message || rmError);
                    return res.status(502).json({ message: 'Não foi possível remover o arquivo do armazenamento em nuvem. Tente novamente.' });
                }
            }
        } else if (file.file_path && fs.existsSync(file.file_path)) {
            fs.unlinkSync(file.file_path);
        }

        await pool.query(`DELETE FROM files WHERE id = $1`, [req.params.id]);

        res.json({ message: 'Arquivo deletado com sucesso!' });
    } catch (err) {
        console.error('Erro ao deletar arquivo:', err.message);
        res.status(500).json({ message: 'Erro ao deletar arquivo.' });
    }
});

app.get('/api/automations', authenticateToken, requireCompany, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM automations WHERE company_id = $1 ORDER BY created_at DESC',
            [req.user.companyId]
        );
        res.json(result.rows);
    } catch (err) {
        console.error('Erro ao listar automações:', err.message);
        res.status(500).json({ message: 'Erro ao listar automações.' });
    }
});

app.post('/api/automations', authenticateToken, requireCompany, async (req, res) => {
    const { name, triggerEvent, actionType, actionTarget, actionPayload } = req.body;

    if (!name || !triggerEvent || !actionType) {
        return res.status(400).json({ message: 'Nome, Gatilho e Tipo de Ação são obrigatórios.' });
    }
    if (!VALID_AUTOMATION_TRIGGERS.includes(triggerEvent)) {
        return res.status(400).json({ message: 'Gatilho inválido.' });
    }
    if (!VALID_AUTOMATION_ACTIONS.includes(actionType)) {
        return res.status(400).json({ message: 'Tipo de ação inválido.' });
    }

    try {
        const result = await pool.query(
            `INSERT INTO automations (company_id, name, trigger_event, action_type, action_target, action_payload)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
            [req.user.companyId, name.trim(), triggerEvent, actionType, actionTarget || '', actionPayload || '']
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error('Erro ao salvar automação:', err.message);
        res.status(500).json({ message: 'Erro ao salvar automação.' });
    }
});

// Heurística por palavra-chave usada SÓ como rede de segurança se a IA de verdade (Groq)
// falhar (sem GROQ_API_KEY, fora do ar, JSON malformado etc.) — sem isso, o recurso
// simplesmente quebraria pro usuário sempre que a chamada externa desse problema.
function heuristicaAutomacaoFallback(prompt) {
    const lower = prompt.toLowerCase();
    let name = 'Automação Personalizada';
    let triggerEvent = 'DEMAND_COMPLETED';
    let actionType = 'EMAIL_NOTIFICATION';
    const actionTarget = 'ASSIGNED_USER';

    if (lower.includes('concluir') || lower.includes('finalizada') || lower.includes('done') || lower.includes('terminar')) {
        triggerEvent = 'DEMAND_COMPLETED';
        name = 'Aviso ao Concluir Demanda';
    } else if (lower.includes('urgente') || lower.includes('crítico')) {
        triggerEvent = 'DEMAND_URGENT';
        name = 'Alerta de Demanda Urgente';
    } else if (lower.includes('contato') || lower.includes('cliente novo') || lower.includes('crm')) {
        triggerEvent = 'CONTACT_ADDED';
        name = 'Aviso de Novo Contato no CRM';
    } else if (lower.includes('login') || lower.includes('acesso')) {
        triggerEvent = 'SYSTEM_LOGIN';
        name = 'Aviso de Novo Login';
    } else if (lower.includes('calendário') || lower.includes('evento') || lower.includes('lembrete')) {
        triggerEvent = 'EVENT_CREATED';
        name = 'Aviso de Novo Evento';
    } else if (lower.includes('criar') || lower.includes('nova demanda') || lower.includes('atribuir')) {
        triggerEvent = 'DEMAND_CREATED';
        name = 'Notificar Responsável ao Criar Demanda';
    }

    return { name, triggerEvent, actionType, actionTarget, actionPayload: prompt };
}

app.post('/api/automations/generate-ai', authenticateToken, requireCompany, async (req, res) => {
    const { prompt } = req.body;

    if (!prompt || prompt.trim().length < 5) {
        return res.status(400).json({ message: 'Descreva a automação desejada em linguagem natural.' });
    }

    let generated;
    let usedFallback = false;
    try {
        if (!aiModule || !aiModule.gerarAutomacaoComIA) throw new Error('Módulo de IA indisponível.');
        generated = await aiModule.gerarAutomacaoComIA(prompt.trim());
    } catch (err) {
        console.warn('IA indisponível para gerar automação, usando heurística de fallback:', err.message);
        generated = heuristicaAutomacaoFallback(prompt.trim());
        usedFallback = true;
    }

    try {
        const result = await pool.query(
            `INSERT INTO automations (company_id, name, trigger_event, action_type, action_target, action_payload)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
            [req.user.companyId, generated.name, generated.triggerEvent, generated.actionType, generated.actionTarget, generated.actionPayload || prompt]
        );
        res.json({
            message: usedFallback
                ? `⚙️ **Automação criada!** (a Cláudia não conseguiu processar agora, então usei uma regra por palavras-chave)\n\n⚡ **Regra:** ${generated.name}\n🎯 **Gatilho:** ${generated.triggerEvent}\n🚀 **Ação:** ${generated.actionType}`
                : `🤖 **Automação gerada com sucesso pela Cláudia!**\n\n⚡ **Regra:** ${generated.name}\n🎯 **Gatilho:** ${generated.triggerEvent}\n🚀 **Ação:** ${generated.actionType}`,
            automation: result.rows[0]
        });
    } catch (err) {
        console.error('Erro ao gerar automação:', err.message);
        res.status(500).json({ message: 'Erro ao gerar automação com IA.' });
    }
});

app.delete('/api/automations/:id', authenticateToken, requireCompany, async (req, res) => {
    try {
        await pool.query('DELETE FROM automations WHERE id = $1 AND company_id = $2', [req.params.id, req.user.companyId]);
        res.json({ message: 'Automação removida com sucesso.' });
    } catch (err) {
        console.error('Erro ao excluir automação:', err.message);
        res.status(500).json({ message: 'Erro ao excluir automação.' });
    }
});

// ==================== STATUS DOS CONTATOS (CRM) ====================
const DEFAULT_CONTACT_STATUSES = [
    { key: 'LEAD', name: 'Lead', color: '#3b82f6' },
    { key: 'NEGOCIACAO', name: 'Em negociação', color: '#f59e0b' },
    { key: 'ATIVO', name: 'Cliente ativo', color: '#10b981' },
    { key: 'INATIVO', name: 'Cliente inativo', color: '#94a3b8' },
    { key: 'PACIENTE', name: 'Paciente', color: '#14b8a6' },
    { key: 'PARCEIRO', name: 'Parceiro', color: '#8b5cf6' },
    { key: 'FORNECEDOR', name: 'Fornecedor', color: '#ec4899' }
];
const MAX_CUSTOM_CONTACT_STATUSES = 15;

// Devolve '' (sem status), a chave válida, ou null se o status não existe para a empresa.
async function resolveContactStatus(companyId, raw) {
    const v = raw === undefined || raw === null ? '' : String(raw).trim();
    if (!v) return '';
    if (DEFAULT_CONTACT_STATUSES.some(d => d.key === v)) return v;
    const m = /^c:(\d+)$/.exec(v);
    if (!m) return null;
    const r = await pool.query('SELECT 1 FROM contact_statuses WHERE id = $1 AND company_id = $2', [Number(m[1]), companyId]);
    return r.rows.length ? v : null;
}

app.get('/api/contact-statuses', authenticateToken, requireCompany, async (req, res) => {
    try {
        const r = await pool.query('SELECT id, name, color, created_by FROM contact_statuses WHERE company_id = $1 ORDER BY LOWER(name)', [req.user.companyId]);
        res.json({
            defaults: DEFAULT_CONTACT_STATUSES,
            custom: r.rows.map(x => ({ key: `c:${x.id}`, id: x.id, name: x.name, color: x.color, created_by: x.created_by })),
            max_custom: MAX_CUSTOM_CONTACT_STATUSES
        });
    } catch (err) {
        console.error('Erro ao listar status de contatos:', err.message);
        res.status(500).json({ message: 'Erro ao listar os status dos contatos.' });
    }
});

app.post('/api/contact-statuses', authenticateToken, requireCompany, async (req, res) => {
    const name = String((req.body && req.body.name) || '').trim().replace(/\s+/g, ' ');
    const color = String((req.body && req.body.color) || '#64748b').trim();
    if (name.length < 2 || name.length > 30) return res.status(400).json({ message: 'O nome do status deve ter entre 2 e 30 caracteres.' });
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) return res.status(400).json({ message: 'Cor inválida para o status.' });
    const lower = name.toLowerCase();
    if (DEFAULT_CONTACT_STATUSES.some(d => d.name.toLowerCase() === lower)) {
        return res.status(409).json({ message: 'Já existe um status padrão com esse nome. Escolha-o na lista.' });
    }
    try {
        const cnt = await pool.query('SELECT COUNT(*)::int AS n FROM contact_statuses WHERE company_id = $1', [req.user.companyId]);
        if (cnt.rows[0].n >= MAX_CUSTOM_CONTACT_STATUSES) {
            return res.status(400).json({ message: `Sua empresa já tem ${MAX_CUSTOM_CONTACT_STATUSES} status personalizados. Exclua algum para criar outro.` });
        }
        const ins = await pool.query(
            'INSERT INTO contact_statuses (company_id, name, color, created_by) VALUES ($1, $2, $3, $4) RETURNING id, name, color, created_by',
            [req.user.companyId, name, color, req.user.id]
        );
        const x = ins.rows[0];
        res.status(201).json({ key: `c:${x.id}`, id: x.id, name: x.name, color: x.color, created_by: x.created_by });
    } catch (err) {
        if (err.code === '23505') return res.status(409).json({ message: 'Já existe um status com esse nome.' });
        console.error('Erro ao criar status de contato:', err.message);
        res.status(500).json({ message: 'Erro ao criar o status.' });
    }
});

app.delete('/api/contact-statuses/:id', authenticateToken, requireCompany, async (req, res) => {
    try {
        const st = await pool.query('SELECT id, created_by FROM contact_statuses WHERE id = $1 AND company_id = $2', [req.params.id, req.user.companyId]);
        if (!st.rows.length) return res.status(404).json({ message: 'Status não encontrado.' });
        const isAdmin = req.user.companyRole === 'OWNER' || req.user.companyRole === 'MANAGER';
        if (!isAdmin && Number(st.rows[0].created_by) !== Number(req.user.id)) {
            return res.status(403).json({ message: 'Só quem criou o status, o dono ou um gerente pode excluí-lo.' });
        }
        // Contatos que usavam esse status ficam sem status (não são apagados).
        const cleared = await pool.query(`UPDATE contacts SET status = '' WHERE company_id = $1 AND status = $2`, [req.user.companyId, `c:${st.rows[0].id}`]);
        await pool.query('DELETE FROM contact_statuses WHERE id = $1 AND company_id = $2', [st.rows[0].id, req.user.companyId]);
        res.json({ message: 'Status removido.', contacts_updated: cleared.rowCount || 0 });
    } catch (err) {
        console.error('Erro ao excluir status de contato:', err.message);
        res.status(500).json({ message: 'Erro ao excluir o status.' });
    }
});

app.get('/api/contacts', authenticateToken, requireCompany, async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM contacts WHERE company_id = $1`, [req.user.companyId]);
        const contacts = (result.rows || []).map(clinicAi.contactToApi).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        res.json(contacts);
    } catch (err) {
        console.error('Erro ao buscar contatos do CRM:', err.message);
        res.status(500).json({ message: 'Erro ao buscar contatos do CRM.' });
    }
});

app.post('/api/contacts', authenticateToken, requireCompany, async (req, res) => {
    const { name, phone, email, role, notes } = req.body;
    // O front manda company_name (nome da coluna); versões antigas mandavam companyName.
    const companyName = req.body.company_name ?? req.body.companyName;

    if (!name || !phone) {
        return res.status(400).json({ message: 'Nome e Telefone são campos obrigatórios para o contato.' });
    }
    if (email && String(email).trim() && !isValidEmail(email)) {
        return res.status(400).json({ message: 'O e-mail do contato é inválido.' });
    }

    // Dados de paciente (CPF, convênio, histórico...) — opcionais, validados e guardados criptografados.
    const clinicIn = clinicAi.sanitizeClinic(req.body.clinic);
    if (clinicIn.error) return res.status(400).json({ message: clinicIn.error });

    try {
        const statusIn = await resolveContactStatus(req.user.companyId, req.body.status);
        if (statusIn === null) return res.status(400).json({ message: 'Status de contato inválido.' });
        const result = await pool.query(
            `INSERT INTO contacts (company_id, name, phone, email, company_name, role, notes, clinic_data, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
            [req.user.companyId, encryptData(String(name).trim()), encryptData(String(phone).trim()), email ? encryptData(String(email).trim()) : '', companyName ? String(companyName).trim() : '', role ? String(role).trim() : '', notes ? encryptData(String(notes).trim()) : '', clinicAi.pack(clinicIn.data), statusIn]
        );
        const newContact = clinicAi.contactToApi(result.rows[0]);
        res.status(201).json(newContact);
        // Todo mundo logado na mesma empresa vê o contato na hora (antes só quem criou via localStorage).
        broadcastBoard(req.user.companyId, 'crm_contact_created', { contact: newContact, byUserId: req.user.id });
        notifyCompanyMembers(
            req.user.companyId,
            'contact_added',
            'Novo Contato no CRM',
            `${req.user.name} adicionou o contato "${newContact.name}" ao CRM.`,
            req.user.id
        );
        // CONTACT_ADDED: trigger real de automação (antes existia só no dropdown do front,
        // sem nada no backend disparando — a regra nunca executava, era um botão morto).
        runAutomations(req.user.companyId, 'CONTACT_ADDED', { title: name, status: 'Novo Contato', user_id: req.user.id });
    } catch (err) {
        console.error('Erro ao salvar contato no CRM:', err.message);
        res.status(500).json({ message: 'Erro ao salvar contato no CRM.' });
    }
});

// Editar contato/paciente (antes só dava para criar e excluir).
app.put('/api/contacts/:id', authenticateToken, requireCompany, async (req, res) => {
    try {
        const cur = await pool.query('SELECT * FROM contacts WHERE id = $1 AND company_id = $2', [req.params.id, req.user.companyId]);
        if (!cur.rows.length) return res.status(404).json({ message: 'Contato não encontrado.' });
        const atual = clinicAi.contactToApi(cur.rows[0]);
        const b = req.body || {};

        const name = b.name !== undefined ? String(b.name).trim() : atual.name;
        const phone = b.phone !== undefined ? String(b.phone).trim() : atual.phone;
        const email = b.email !== undefined ? String(b.email).trim() : (atual.email || '');
        if (!name || !phone) return res.status(400).json({ message: 'Nome e Telefone são campos obrigatórios para o contato.' });
        if (email && !isValidEmail(email)) return res.status(400).json({ message: 'O e-mail do contato é inválido.' });
        const companyName = (b.company_name ?? b.companyName) !== undefined ? String(b.company_name ?? b.companyName).trim() : (atual.company_name || '');
        const role = b.role !== undefined ? String(b.role).trim() : (atual.role || '');
        const notes = b.notes !== undefined ? String(b.notes).trim() : (atual.notes || '');

        const clinicIn = clinicAi.sanitizeClinic(b.clinic);
        if (clinicIn.error) return res.status(400).json({ message: clinicIn.error });
        const clinic = clinicAi.mergeFields(atual.clinic, clinicIn.data);

        let status = atual.status || '';
        if (b.status !== undefined) {
            const st = await resolveContactStatus(req.user.companyId, b.status);
            if (st === null) return res.status(400).json({ message: 'Status de contato inválido.' });
            status = st;
        }

        const upd = await pool.query(
            `UPDATE contacts SET name = $1, phone = $2, email = $3, company_name = $4, role = $5, notes = $6, clinic_data = $7, status = $8, updated_at = CURRENT_TIMESTAMP
             WHERE id = $9 AND company_id = $10 RETURNING *`,
            [encryptData(name), encryptData(phone), email ? encryptData(email) : '', companyName, role, notes ? encryptData(notes) : '', clinicAi.pack(clinic), status, req.params.id, req.user.companyId]
        );
        const contact = clinicAi.contactToApi(upd.rows[0]);
        res.json(contact);
        broadcastBoard(req.user.companyId, 'crm_contact_updated', { contact, byUserId: req.user.id });
    } catch (err) {
        console.error('Erro ao editar contato:', err.message);
        res.status(500).json({ message: 'Erro ao editar contato.' });
    }
});

app.delete('/api/contacts/:id', authenticateToken, requireCompany, async (req, res) => {
    try {
        await pool.query(`DELETE FROM contacts WHERE id = $1 AND company_id = $2`, [req.params.id, req.user.companyId]);
        res.json({ message: 'Contato removido do CRM.' });
        broadcastBoard(req.user.companyId, 'crm_contact_deleted', { id: Number(req.params.id), byUserId: req.user.id });
    } catch (err) {
        console.error('Erro ao remover contato:', err.message);
        res.status(500).json({ message: 'Erro ao remover contato.' });
    }
});

app.post('/api/events', authenticateToken, requireCompany, async (req, res) => {
    const { title, eventDate, eventTime, type, description } = req.body;
    if (!title || !eventDate) {
        return res.status(400).json({ message: 'Título e Data são obrigatórios.' });
    }
    const clientName = type === 'HORARIO_MARCADO' && req.body.clientName
        ? String(req.body.clientName).trim().slice(0, 150)
        : null;
    const clientPhone = type === 'HORARIO_MARCADO' && req.body.clientPhone
        ? String(req.body.clientPhone).replace(/[^\d+()\-\s]/g, '').trim().slice(0, 30)
        : null;
    if (type === 'HORARIO_MARCADO' && !clientName) {
        return res.status(400).json({ message: 'Informe o nome do(a) cliente para o Horário Marcado.' });
    }
    // Ficha do agendamento (tipo de atendimento, profissional, convênio, CPF...) — só em Horário Marcado.
    const patientIn = type === 'HORARIO_MARCADO' ? clinicAi.sanitizePatient(req.body.patient) : { data: {} };
    if (patientIn.error) return res.status(400).json({ message: patientIn.error });
    if (type === 'HORARIO_MARCADO' && !patientIn.data.situacao) patientIn.data.situacao = 'AGENDADO';

    try {
        const quota = await getEventQuota(req.user.companyId, req.user.id);
        if (!quota.allowed) {
            return res.status(403).json({
                code: 'EVENT_LIMIT',
                message: eventLimitMessage(quota.limit),
                limit: quota.limit,
                current: quota.current
            });
        }

        const result = await pool.query(
            `INSERT INTO events (company_id, user_id, title, event_date, event_time, type, description, client_name, client_phone, patient_data)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
            [req.user.companyId, req.user.id, title, eventDate, eventTime || '09:00', type || 'REUNIAO', description || '', clientName, clientPhone, type === 'HORARIO_MARCADO' ? clinicAi.pack(patientIn.data) : null]
        );
        const newEvent = clinicAi.eventToApi(result.rows[0]);

        // Garantir que a data esteja no formato correto para o frontend
        if (newEvent.event_date) {
            const dateObj = new Date(newEvent.event_date);
            newEvent.event_date = dateObj.toISOString().split('T')[0];
        }

        // Notifica os demais membros da empresa (painel e/ou e-mail, conforme as preferências de cada um)
        notifyCompanyMembers(
            req.user.companyId,
            'event_created',
            'Novo Evento Agendado',
            `Um novo evento "${title}"${clientName ? ' (cliente: ' + clientName + (clientPhone ? ' - ' + clientPhone : '') + ')' : ''} foi criado por ${req.user.name} para o dia ${eventDate}${eventTime ? ' às ' + eventTime : ''}.`,
            req.user.id
        );

        res.status(201).json(newEvent);
        // EVENT_CREATED: mesma situação do CONTACT_ADDED — o gatilho já existia no dropdown
        // do front, mas nada no backend chamava runAutomations pra ele.
        runAutomations(req.user.companyId, 'EVENT_CREATED', { title, status: 'Evento Agendado', user_id: req.user.id });
    } catch (err) {
        console.error('Erro ao criar evento:', err.message);
        res.status(500).json({ message: 'Erro interno ao criar evento.' });
    }
});

app.get('/api/events', authenticateToken, requireCompany, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT e.*, u.name AS creator_name FROM events e
             LEFT JOIN users u ON e.user_id = u.id
             WHERE e.company_id = $1 ORDER BY e.event_date ASC, e.event_time ASC`,
            [req.user.companyId]
        );

        // Garantir que as datas estejam no formato correto YYYY-MM-DD
        const formattedEvents = result.rows.map(event => {
            const formatted = clinicAi.eventToApi(event);
            if (formatted.event_date) {
                const dateObj = new Date(formatted.event_date);
                // Formata como YYYY-MM-DD (local time, não UTC)
                const year = dateObj.getFullYear();
                const month = String(dateObj.getMonth() + 1).padStart(2, '0');
                const day = String(dateObj.getDate()).padStart(2, '0');
                formatted.event_date = `${year}-${month}-${day}`;
            }
            return formatted;
        });

        res.json(formattedEvents);
    } catch (err) {
        console.error('Erro ao buscar eventos:', err.message);
        res.status(500).json({ message: 'Erro ao buscar eventos do calendário.' });
    }
});

// Editar / remarcar evento ou agendamento de paciente.
app.put('/api/events/:id', authenticateToken, requireCompany, async (req, res) => {
    try {
        const cur = await pool.query('SELECT * FROM events WHERE id = $1 AND company_id = $2', [req.params.id, req.user.companyId]);
        if (!cur.rows.length) return res.status(404).json({ message: 'Evento não encontrado.' });
        const atual = clinicAi.eventToApi(cur.rows[0]);
        const b = req.body || {};

        const title = b.title !== undefined ? String(b.title).trim().slice(0, 255) : atual.title;
        const eventDate = b.eventDate ?? b.event_date;
        const eventTime = b.eventTime ?? b.event_time;
        const type = b.type || atual.type;
        if (!title) return res.status(400).json({ message: 'Título é obrigatório.' });
        if (eventDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(eventDate))) {
            return res.status(400).json({ message: 'Data inválida.' });
        }
        const isAppt = type === 'HORARIO_MARCADO';
        const clientName = isAppt ? String((b.clientName ?? atual.client_name) || '').trim().slice(0, 150) : null;
        const clientPhone = isAppt ? String((b.clientPhone ?? atual.client_phone) || '').replace(/[^\d+()\-\s]/g, '').trim().slice(0, 30) : null;
        if (isAppt && !clientName) return res.status(400).json({ message: 'Informe o nome do(a) cliente para o Horário Marcado.' });

        const patientIn = isAppt ? clinicAi.sanitizePatient(b.patient) : { data: {} };
        if (patientIn.error) return res.status(400).json({ message: patientIn.error });
        const patient = isAppt ? clinicAi.mergeFields(atual.patient, patientIn.data) : null;

        const dateStr = eventDate !== undefined ? eventDate : String(cur.rows[0].event_date instanceof Date
            ? `${cur.rows[0].event_date.getFullYear()}-${String(cur.rows[0].event_date.getMonth() + 1).padStart(2, '0')}-${String(cur.rows[0].event_date.getDate()).padStart(2, '0')}`
            : cur.rows[0].event_date).slice(0, 10);

        const upd = await pool.query(
            `UPDATE events SET title = $1, event_date = $2, event_time = $3, type = $4, description = $5, client_name = $6, client_phone = $7, patient_data = $8
             WHERE id = $9 AND company_id = $10 RETURNING *`,
            [title, dateStr, eventTime || String(atual.event_time || '09:00').slice(0, 5), type, b.description !== undefined ? String(b.description) : (atual.description || ''),
                clientName, clientPhone, isAppt ? clinicAi.pack(patient) : null, req.params.id, req.user.companyId]
        );
        const out = clinicAi.eventToApi(upd.rows[0]);
        if (out.event_date) out.event_date = String(dateStr).slice(0, 10);
        res.json(out);
    } catch (err) {
        console.error('Erro ao editar evento:', err.message);
        res.status(500).json({ message: 'Erro ao editar evento.' });
    }
});

app.delete('/api/events/:id', authenticateToken, requireCompany, async (req, res) => {
    try {
        await pool.query('DELETE FROM events WHERE id = $1 AND company_id = $2', [req.params.id, req.user.companyId]);
        res.json({ message: 'Evento removido com sucesso.' });
    } catch (err) {
        console.error('Erro ao remover evento:', err.message);
        res.status(500).json({ message: 'Erro ao remover evento.' });
    }
});

// ==================== ANOTAÇÕES DO WORKSPACE ====================
// Todos da empresa veem as anotações; só quem escreveu (ou Dono/Gerente) edita e apaga.
// Título e texto são criptografados no banco (podem conter dados de pacientes).
function noteToApi(row, req) {
    const isAdmin = ['OWNER', 'MANAGER'].includes(req.user.role);
    return {
        id: row.id,
        title: decryptData(row.title),
        content: decryptData(row.content || ''),
        color: row.color || 'default',
        pinned: !!row.pinned,
        user_id: row.user_id,
        author_name: row.author_name_enc ? decryptData(row.author_name_enc) : 'Ex-colaborador',
        created_at: row.created_at,
        updated_at: row.updated_at,
        can_edit: isAdmin || Number(row.user_id) === Number(req.user.id)
    };
}
const NOTE_COLORS = ['default', 'yellow', 'green', 'blue', 'pink', 'purple'];

app.get('/api/notes', authenticateToken, requireCompany, requireNotesPlan, async (req, res) => {
    try {
        const r = await pool.query(
            `SELECT n.*, u.name AS author_name_enc FROM notes n LEFT JOIN users u ON u.id = n.user_id
             WHERE n.company_id = $1 ORDER BY n.pinned DESC, n.updated_at DESC LIMIT 1000`,
            [req.user.companyId]
        );
        res.json(r.rows.map(row => noteToApi(row, req)));
    } catch (err) {
        console.error('Erro ao listar anotações:', err.message);
        res.status(500).json({ message: 'Erro ao carregar as anotações.' });
    }
});

app.post('/api/notes', authenticateToken, requireCompany, requireNotesPlan, async (req, res) => {
    const title = String(req.body.title || '').trim().slice(0, 200);
    const content = String(req.body.content || '').slice(0, 20000);
    const color = NOTE_COLORS.includes(req.body.color) ? req.body.color : 'default';
    if (!title) return res.status(400).json({ message: 'Dê um título para a anotação.' });
    try {
        const count = await pool.query('SELECT COUNT(*)::int AS c FROM notes WHERE company_id = $1', [req.user.companyId]);
        if (count.rows[0].c >= 1000) return res.status(403).json({ message: 'Limite de 1000 anotações por empresa atingido. Apague as antigas.' });
        const ins = await pool.query(
            `INSERT INTO notes (company_id, user_id, title, content, color, pinned) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
            [req.user.companyId, req.user.id, encryptData(title), encryptData(content), color, !!req.body.pinned]
        );
        const r = await pool.query(`SELECT n.*, u.name AS author_name_enc FROM notes n LEFT JOIN users u ON u.id = n.user_id WHERE n.id = $1`, [ins.rows[0].id]);
        res.status(201).json(noteToApi(r.rows[0], req));
        broadcastBoard(req.user.companyId, 'note_changed', { id: ins.rows[0].id, byUserId: req.user.id });
    } catch (err) {
        console.error('Erro ao salvar anotação:', err.message);
        res.status(500).json({ message: 'Erro ao salvar a anotação.' });
    }
});

app.put('/api/notes/:id', authenticateToken, requireCompany, requireNotesPlan, async (req, res) => {
    try {
        const cur = await pool.query('SELECT * FROM notes WHERE id = $1 AND company_id = $2', [req.params.id, req.user.companyId]);
        if (!cur.rows.length) return res.status(404).json({ message: 'Anotação não encontrada.' });
        const isAdmin = ['OWNER', 'MANAGER'].includes(req.user.role);
        if (!isAdmin && Number(cur.rows[0].user_id) !== Number(req.user.id)) {
            return res.status(403).json({ message: 'Só quem escreveu a anotação (ou o Dono/Gerente) pode editá-la.' });
        }
        const title = req.body.title !== undefined ? String(req.body.title).trim().slice(0, 200) : decryptData(cur.rows[0].title);
        const content = req.body.content !== undefined ? String(req.body.content).slice(0, 20000) : decryptData(cur.rows[0].content || '');
        const color = req.body.color !== undefined ? (NOTE_COLORS.includes(req.body.color) ? req.body.color : 'default') : cur.rows[0].color;
        const pinned = req.body.pinned !== undefined ? !!req.body.pinned : !!cur.rows[0].pinned;
        if (!title) return res.status(400).json({ message: 'Dê um título para a anotação.' });
        await pool.query(
            `UPDATE notes SET title = $1, content = $2, color = $3, pinned = $4, updated_at = CURRENT_TIMESTAMP WHERE id = $5 AND company_id = $6`,
            [encryptData(title), encryptData(content), color, pinned, req.params.id, req.user.companyId]
        );
        const r = await pool.query(`SELECT n.*, u.name AS author_name_enc FROM notes n LEFT JOIN users u ON u.id = n.user_id WHERE n.id = $1`, [req.params.id]);
        res.json(noteToApi(r.rows[0], req));
        broadcastBoard(req.user.companyId, 'note_changed', { id: Number(req.params.id), byUserId: req.user.id });
    } catch (err) {
        console.error('Erro ao editar anotação:', err.message);
        res.status(500).json({ message: 'Erro ao editar a anotação.' });
    }
});

app.delete('/api/notes/:id', authenticateToken, requireCompany, requireNotesPlan, async (req, res) => {
    try {
        const cur = await pool.query('SELECT user_id FROM notes WHERE id = $1 AND company_id = $2', [req.params.id, req.user.companyId]);
        if (!cur.rows.length) return res.status(404).json({ message: 'Anotação não encontrada.' });
        const isAdmin = ['OWNER', 'MANAGER'].includes(req.user.role);
        if (!isAdmin && Number(cur.rows[0].user_id) !== Number(req.user.id)) {
            return res.status(403).json({ message: 'Só quem escreveu a anotação (ou o Dono/Gerente) pode apagá-la.' });
        }
        await pool.query('DELETE FROM notes WHERE id = $1 AND company_id = $2', [req.params.id, req.user.companyId]);
        res.json({ message: 'Anotação apagada.' });
        broadcastBoard(req.user.companyId, 'note_changed', { id: Number(req.params.id), byUserId: req.user.id });
    } catch (err) {
        console.error('Erro ao apagar anotação:', err.message);
        res.status(500).json({ message: 'Erro ao apagar a anotação.' });
    }
});

app.get('/api/plan/features', authenticateToken, async (req, res) => {
    try {
        const quota = await getEventQuota(req.user.companyId, req.user.id);
        res.json({
            tier: quota.tier,
            eventsLimit: quota.limit,
            eventsUsed: quota.current,
            emailAllowed: canUseEmailNotifications(quota.tier)
        });
    } catch (err) {
        console.error('Erro ao buscar recursos do plano:', err.message);
        res.status(500).json({ message: 'Erro ao buscar recursos do plano.' });
    }
});

app.get('/api/analytics/summary', authenticateToken, async (req, res) => {
    const companyId = req.user.companyId;

    try {
        const result = await pool.query(`SELECT * FROM demands WHERE company_id = $1`, [companyId]);
        const demands = result.rows;

        const now = new Date();
        const days = 14;
        const dailyStats = [];

        for (let i = days - 1; i >= 0; i--) {
            const d = new Date();
            d.setDate(now.getDate() - i);
            const dateStr = d.toISOString().split('T')[0];
            const labelStr = d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });

            const createdCount = (demands || []).filter(item => {
                if (!item.created_at) return false;
                return item.created_at.startsWith(dateStr);
            }).length;

            const completedCount = (demands || []).filter(item => {
                if (item.status === 'DONE') {
                    if (item.completed_at && item.completed_at.startsWith(dateStr)) return true;
                    if (!item.completed_at && item.created_at && item.created_at.startsWith(dateStr)) return true;
                }
                return false;
            }).length;

            dailyStats.push({
                date: dateStr,
                label: labelStr,
                created: createdCount,
                completed: completedCount
            });
        }

        const priorityCounts = {
            URGENTE: (demands || []).filter(d => d.priority === 'URGENTE').length,
            ALTA: (demands || []).filter(d => d.priority === 'ALTA').length,
            MEDIA: (demands || []).filter(d => d.priority === 'MEDIA').length,
            BAIXA: (demands || []).filter(d => d.priority === 'BAIXA').length
        };

        const statusCounts = {
            TODO: (demands || []).filter(d => d.status === 'TODO').length,
            IN_PROGRESS: (demands || []).filter(d => d.status === 'IN_PROGRESS').length,
            URGENT: (demands || []).filter(d => d.status === 'URGENT').length,
            DONE: (demands || []).filter(d => d.status === 'DONE').length
        };

        const totalDemands = (demands || []).length;
        const completionRate = totalDemands > 0 ? Math.round((statusCounts.DONE / totalDemands) * 100) : 0;

        res.json({
            dailyStats,
            priorityCounts,
            statusCounts,
            totalDemands,
            completionRate
        });
    } catch (err) {
        console.error('Erro ao consultar analytics:', err);
        return res.status(500).json({ message: 'Erro ao gerar dados analíticos.' });
    }
});

const automationLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    message: { message: 'Muitas mensagens automáticas. Aguarde um minuto.' }
});

app.post('/api/automation/send', authenticateToken, automationLimiter, async (req, res) => {
    const { type, recipient, message } = req.body;

    if (!recipient || !message) {
        return res.status(400).json({ message: 'Destinatário e mensagem são obrigatórios.' });
    }

    if (type === 'EMAIL') {
        // Fix: valida se destinatário é contato da empresa e escapa HTML
        const contactRows = (await pool.query(
            `SELECT id, email FROM contacts WHERE company_id = $1`,
            [req.user.companyId]
        )).rows;
        const isCompanyContact = contactRows.some(c => decryptData(c.email).toLowerCase() === recipient.trim().toLowerCase());
        if (!isCompanyContact) {
            // Também permite enviar para usuários da mesma empresa
            const userCheck = await pool.query(
                `SELECT id FROM users WHERE company_id = $1 AND LOWER(email) = $2`,
                [req.user.companyId, recipient.trim().toLowerCase()]
            );
            if (userCheck.rows.length === 0) {
                return res.status(403).json({ message: 'Destinatário deve ser um contato ou usuário da sua empresa.' });
            }
        }

        // escapeHtml já existe no arquivo (linha 1490)
        const safeMessage = (typeof escapeHtml === 'function' ? escapeHtml(message) : message.replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]))).replace(/\n/g, '<br>');
        const sent = await sendMail({
            to: recipient,
            subject: 'Notificação KL Web - Mensagem Corporativa',
            html: `<div style="font-family: sans-serif; padding: 25px; background: #f8fafc; border-radius: 8px; border: 1px solid #e2e8f0;">
                     <h2 style="color: #6366f1; margin-top: 0;">KL Web - Mensagem da Empresa</h2>
                     <p style="font-size: 15px; color: #334155; line-height: 1.6;">${safeMessage}</p>
                     <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 20px 0;">
                     <small style="color: #94a3b8;">Enviado via plataforma <strong>KL Web</strong>.</small>
                   </div>`
        });
        return res.json({ message: sent ? 'E-mail enviado com sucesso para o cliente!' : 'Erro ao despachar e-mail.' });
    } else {
        const cleanPhone = recipient.replace(/\D/g, '');
        const formattedPhone = cleanPhone.startsWith('55') ? cleanPhone : `55${cleanPhone}`;
        const waUrl = `https://api.whatsapp.com/send?phone=${formattedPhone}&text=${encodeURIComponent(message)}`;
        return res.json({ message: 'Link de envio para WhatsApp gerado!', waUrl });
    }
});

app.post('/api/payments/public-checkout', async (req, res) => {
    if (checkoutRateLimited(`public:${req.ip}`)) {
        return res.status(429).json({ message: 'Muitas tentativas de checkout. Aguarde alguns minutos e tente novamente.' });
    }
    try {
        const { planTier, email } = req.body;
        const result = await criarPreferenciaCheckout({ planTier, email });
        return res.json({ success: true, paymentUrl: result.init_point, id: result.id });
    } catch (error) {
        if (error.statusCode) {
            return res.status(error.statusCode).json({ message: error.message });
        }
        console.error('Erro Mercado Pago:', error);
        return res.status(500).json({ message: 'Erro ao gerar checkout do Mercado Pago.' });
    }
});

app.get('/api/notifications', authenticateToken, async (req, res) => {
    const userEmail = req.user.email ? req.user.email.trim().toLowerCase() : '';
    try {
        const result = await pool.query(
            `SELECT * FROM notifications WHERE LOWER(TRIM(user_email)) = $1 ORDER BY created_at DESC`,
            [userEmail]
        );
        res.json(result.rows);
    } catch (err) {
        console.error('❌ Erro ao buscar notificações:', err.message);
        res.status(500).json({ error: 'Erro ao carregar notificações.' });
    }
});

app.put('/api/notifications/:id/read', authenticateToken, (req, res) => {
    pool.query(
        `UPDATE notifications SET is_read = 1 WHERE id = $1 AND LOWER(user_email) = $2`,
        [req.params.id, req.user.email.toLowerCase()]
    ).then(() => res.json({ success: true }))
        .catch(() => res.status(500).json({ message: 'Erro ao atualizar notificação.' }));
});

app.delete('/api/notifications/clear', authenticateToken, (req, res) => {
    pool.query(`DELETE FROM notifications WHERE LOWER(user_email) = $1`, [req.user.email.toLowerCase()])
        .then(() => res.json({ success: true, message: 'Notificações limpas com sucesso.' }))
        .catch(() => res.status(500).json({ message: 'Erro ao limpar notificações.' }));
});

const MASTER_PASSWORD = process.env.MASTER_PASSWORD;
if (!MASTER_PASSWORD) {
    console.error('❌ ERRO CRÍTICO: MASTER_PASSWORD não definida no arquivo .env!');
    process.exit(1); // Força a parada do servidor se a chave não estiver configurada
}

function middlewareMaster(req, res, next) {
    const email = (req.user && req.user.email) ? req.user.email.toLowerCase() : '';
    if (!email || email !== OWNER_EMAIL.toLowerCase()) {
        return res.status(403).json({ message: 'Acesso restrito ao Painel Master.' });
    }
    next();
}

// Equipe do site (dono, administradores e gerentes do site): só consulta e troca de plano.
function middlewareMasterStaff(req, res, next) {
    if (!req.user || !req.user.isSiteStaff) {
        return res.status(403).json({ message: 'Acesso restrito ao Painel Master.' });
    }
    next();
}

app.get('/api/master/usuarios', authenticateToken, middlewareMaster, async (req, res) => {
    try {
        const { rows } = await pool.query(
            'SELECT id, name, email, plan_tier, created_at FROM users ORDER BY created_at DESC'
        );
        res.json(decryptUsers(rows));
    } catch (err) {
        console.error('Erro ao buscar usuários (painel master):', err.message);
        res.status(500).json({ message: 'Erro ao buscar usuários.' });
    }
});

app.put('/api/master/usuarios/:id/email', authenticateToken, middlewareMaster, async (req, res) => {
    const { id } = req.params;
    const { novoEmail } = req.body;

    if (!novoEmail) {
        return res.status(400).json({ message: 'Informe o novo e-mail.' });
    }

    try {
        await pool.query('UPDATE users SET email = $1 WHERE id = $2', [novoEmail.trim().toLowerCase(), id]);
        await revokeUserSessions(id);
        res.json({ success: true, message: 'E-mail atualizado com sucesso!' });
    } catch (err) {
        console.error('Erro ao alterar e-mail (painel master):', err.message);
        res.status(500).json({ message: 'Erro ao alterar e-mail.' });
    }
});

app.put('/api/master/usuarios/:id/senha', authenticateToken, middlewareMaster, async (req, res) => {
    const { id } = req.params;
    const { novaSenha } = req.body;

    if (!novaSenha || novaSenha.length < 8) {
        return res.status(400).json({ message: 'A nova senha deve ter pelo menos 8 caracteres.' });
    }

    try {
        const hashSenha = await bcrypt.hash(novaSenha, 10);
        await pool.query('UPDATE users SET password = $1 WHERE id = $2', [hashSenha, id]);
        await revokeUserSessions(id);
        res.json({ success: true, message: 'Senha redefinida com sucesso!' });
    } catch (err) {
        console.error('Erro ao redefinir senha (painel master):', err.message);
        res.status(500).json({ message: 'Erro ao redefinir senha.' });
    }
});

function safeCompare(a, b) {
    const bufA = Buffer.from(String(a));
    const bufB = Buffer.from(String(b));
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

app.post('/api/admin/users-list', adminLimiter, authenticateToken, middlewareMasterStaff, async (req, res) => {
    const { masterPassword } = req.body;

    if (!masterPassword || !safeCompare(masterPassword, MASTER_PASSWORD)) {
        return res.status(403).json({ error: 'Acesso negado: Senha master incorreta.' });
    }

    try {
        const result = await pool.query(
            `SELECT u.id, u.name, u.email, u.role, u.plan_tier, u.plan_status, u.site_role, u.created_at, c.name as company_name, (c.owner_id = u.id) AS is_company_owner
             FROM users u LEFT JOIN companies c ON u.company_id = c.id
             ORDER BY u.created_at DESC`
        );
        res.json({ success: true, users: decryptUsers(result.rows || []) });
    } catch (err) {
        console.error('Erro ao listar usuários (admin):', err.message);
        res.status(500).json({ error: 'Erro ao listar usuários.' });
    }
});

app.post('/api/admin/change-user-role', adminLimiter, authenticateToken, middlewareMaster, async (req, res) => {
    const { masterPassword, targetUserId, role } = req.body;
    const userId = Number(targetUserId);

    if (!masterPassword || !safeCompare(masterPassword, MASTER_PASSWORD)) {
        return res.status(403).json({ error: 'Acesso negado: Senha master incorreta.' });
    }
    if (!Number.isSafeInteger(userId) || userId <= 0 || !['USER', 'MANAGER', 'ADMIN', 'SITE_MANAGER'].includes(role)) {
        return res.status(400).json({ error: 'Usuário ou cargo inválido.' });
    }

    try {
        const targetResult = await pool.query(
            'SELECT u.id, u.name, u.email, u.role, (c.owner_id = u.id) AS is_company_owner FROM users u LEFT JOIN companies c ON c.id = u.company_id WHERE u.id = $1',
            [userId]
        );
        const target = targetResult.rows[0];
        if (!target) return res.status(404).json({ error: 'Usuário não encontrado.' });
        if (target.is_company_owner) {
            return res.status(403).json({ error: 'Esta conta é Dona de uma empresa. O cargo dela é definido pela empresa, não pelo Painel Master.' });
        }
        if (target.role === 'OWNER' || target.email.toLowerCase() === OWNER_EMAIL.toLowerCase()) {
            return res.status(403).json({ error: 'O dono do site não pode ser rebaixado.' });
        }

        // SITE_MANAGER é um cargo do site, separado do cargo dentro da empresa: não mexe em users.role.
        const result = role === 'SITE_MANAGER'
            ? await pool.query(
                "UPDATE users SET site_role = 'SITE_MANAGER' WHERE id = $1 RETURNING id, name, email, role",
                [userId]
            )
            : await pool.query(
                'UPDATE users SET role = $1, site_role = NULL WHERE id = $2 RETURNING id, name, email, role',
                [role, userId]
            );
        await auditLog(req, `CARGO_SITE_ALTERADO: ${target.role} -> ${role}`, target.id, target.email);

        res.json({
            success: true,
            message: `Cargo de ${result.rows[0].name || result.rows[0].email} alterado para ${role}.`,
            user: result.rows[0]
        });
    } catch (err) {
        console.error('Erro ao alterar cargo pelo Painel Master:', err.message);
        res.status(500).json({ error: 'Erro ao alterar cargo do usuário.' });
    }
});

app.post('/api/admin/delete-user', adminLimiter, authenticateToken, middlewareMaster, async (req, res) => {
    const { masterPassword, targetUserId } = req.body;
    const userId = Number(targetUserId);

    if (!masterPassword || !safeCompare(masterPassword, MASTER_PASSWORD)) {
        return res.status(403).json({ error: 'Acesso negado: Senha master incorreta.' });
    }
    if (!Number.isSafeInteger(userId) || userId <= 0) {
        return res.status(400).json({ error: 'Usuário inválido.' });
    }
    if (userId === req.user.id) {
        return res.status(400).json({ error: 'Você não pode apagar a sua própria conta por aqui.' });
    }

    try {
        const target = (await pool.query(
            `SELECT u.id, u.name, u.email, u.role, u.company_id, c.owner_id
             FROM users u LEFT JOIN companies c ON c.id = u.company_id
             WHERE u.id = $1`,
            [userId]
        )).rows[0];
        if (!target) return res.status(404).json({ error: 'Usuário não encontrado.' });
        if (target.role === 'OWNER' || String(target.email).toLowerCase() === OWNER_EMAIL.toLowerCase()) {
            return res.status(403).json({ error: 'A conta do dono do site não pode ser apagada.' });
        }

        const isCompanyOwner = target.company_id && Number(target.owner_id) === Number(target.id);
        if (isCompanyOwner) {
            const others = await pool.query(
                `SELECT COUNT(*) AS count FROM users WHERE company_id = $1 AND id <> $2`,
                [target.company_id, target.id]
            );
            if (parseInt(others.rows[0].count, 10) > 0) {
                return res.status(409).json({ error: 'Esta conta é a Dona de uma empresa que ainda tem outros membros. Remova ou apague os membros antes.' });
            }
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(
                `UPDATE demands SET assigned_user_email = NULL, assigned_user_name = 'Sem responsável' WHERE LOWER(assigned_user_email) = $1`,
                [String(target.email).toLowerCase()]
            );
            await client.query(`DELETE FROM notifications WHERE LOWER(user_email) = $1`, [String(target.email).toLowerCase()]);
            await client.query(`DELETE FROM users WHERE id = $1`, [target.id]);
            if (isCompanyOwner) {
                await client.query(`UPDATE companies SET owner_id = NULL WHERE id = $1`, [target.company_id]);
            }
            await client.query('COMMIT');
        } catch (txErr) {
            await client.query('ROLLBACK');
            throw txErr;
        } finally {
            client.release();
        }

        await auditLog(req, `CONTA_APAGADA_PELO_MASTER: ${target.email}`, null, target.email);
        res.json({ success: true, message: `Conta de ${target.name || target.email} apagada.` });
    } catch (err) {
        console.error('Erro ao apagar conta pelo Painel Master:', err.message);
        res.status(500).json({ error: 'Erro ao apagar a conta.' });
    }
});

app.post('/api/admin/master-change-plan', adminLimiter, authenticateToken, middlewareMasterStaff, async (req, res) => {
    const { masterPassword, targetEmail, planTier, planStatus } = req.body;

    if (!masterPassword || !safeCompare(masterPassword, MASTER_PASSWORD)) {
        return res.status(403).json({ error: 'Acesso negado: Senha master incorreta.' });
    }

    if (!targetEmail) {
        return res.status(400).json({ error: 'E-mail do usuário é obrigatório.' });
    }

    const cleanEmail = targetEmail.trim().toLowerCase();
    const validPlans = ['BASICO', 'STARTER', 'PRO_IA'];
    const newPlan = validPlans.includes(planTier) ? planTier : 'BASICO';
    const newStatus = planStatus === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE';

    try {
        const userResult = await pool.query(`SELECT id, name, email, plan_tier FROM users WHERE LOWER(email) = $1`, [cleanEmail]);
        const user = userResult.rows[0];
        if (!user) {
            return res.status(404).json({ error: 'Usuário não encontrado no banco de dados.' });
        }
        if (!req.user.isSiteOwner) {
            const t = (await pool.query('SELECT role, site_role FROM users WHERE id = $1', [user.id])).rows[0];
            if (cleanEmail === OWNER_EMAIL.toLowerCase() || t.role === 'OWNER' || t.role === 'ADMIN' || t.site_role === 'SITE_MANAGER') {
                return res.status(403).json({ error: 'Apenas o dono do site altera o plano da equipe do site.' });
            }
        }

        await pool.query(`UPDATE users SET plan_tier = $1, plan_status = $2 WHERE id = $3`, [newPlan, newStatus, user.id]);

        console.log(`🔑 [PAINEL MASTER] Plano do usuário ${cleanEmail} alterado para ${newPlan} (${newStatus})`);

        addSystemNotification(
            cleanEmail,
            'Plano Atualizado pelo Administrador',
            `Seu plano na plataforma KL Web foi atualizado para ${newPlan}. Aproveite os novos recursos!`,
            'info',
            user.id
        );

        res.json({
            success: true,
            message: `Plano de ${user.name} (${cleanEmail}) alterado para ${newPlan} com status ${newStatus} com sucesso!`,
            user: {
                id: user.id,
                email: cleanEmail,
                planTier: newPlan,
                planStatus: newStatus
            }
        });
    } catch (err) {
        console.error('Erro ao atualizar plano no banco:', err.message);
        res.status(500).json({ error: 'Erro ao atualizar plano no banco.' });
    }
});

// Nova funcionalidade: Resetar senha de usuário via painel master
app.post('/api/admin/reset-user-password', adminLimiter, authenticateToken, middlewareMaster, async (req, res) => {
    try {
        const { masterPassword, targetEmail, newPassword } = req.body;

        if (!targetEmail || !targetEmail.trim()) {
            return res.status(400).json({ error: 'O e-mail do usuário é obrigatório.' });
        }

        if (!masterPassword || !safeCompare(masterPassword, MASTER_PASSWORD)) {
            return res.status(403).json({ error: 'Acesso negado: Senha master incorreta.' });
        }

        if (!newPassword || newPassword.length < 8) {
            return res.status(400).json({ error: 'A nova senha deve ter no mínimo 8 caracteres.' });
        }

        const hashedPassword = await bcrypt.hash(newPassword, 10);

        const result = await pool.query(
            `UPDATE users SET password = $1 WHERE LOWER(email) = LOWER($2) RETURNING id`,
            [hashedPassword, targetEmail.trim()]
        );
        for (const row of result.rows) await revokeUserSessions(row.id);

        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Usuário não encontrado.' });
        }

        return res.json({ success: true, message: 'Senha redefinida com sucesso!' });
    } catch (err) {
        console.error('Erro ao redefinir senha:', err);
        return res.status(500).json({ error: 'Erro interno no servidor ao redefinir senha.' });
    }
});

// Nova funcionalidade: Trocar email de usuário via painel master
app.post('/api/admin/change-user-email', adminLimiter, authenticateToken, middlewareMaster, async (req, res) => {
    const { masterPassword, targetEmail, newEmail } = req.body;

    if (!masterPassword || !safeCompare(masterPassword, MASTER_PASSWORD)) {
        return res.status(403).json({ error: 'Acesso negado: Senha master incorreta.' });
    }

    if (!targetEmail || !newEmail) {
        return res.status(400).json({ error: 'E-mail atual e novo e-mail são obrigatórios.' });
    }

    const cleanTargetEmail = targetEmail.trim().toLowerCase();
    const cleanNewEmail = newEmail.trim().toLowerCase();

    try {
        // Verificar se novo email já existe
        const existingUser = await pool.query(`SELECT id FROM users WHERE LOWER(email) = $1`, [cleanNewEmail]);
        if (existingUser.rows.length > 0) {
            return res.status(400).json({ error: 'Este novo e-mail já está em uso por outro usuário.' });
        }

        const userResult = await pool.query(`SELECT id, name, email FROM users WHERE LOWER(email) = $1`, [cleanTargetEmail]);
        const user = userResult.rows[0];
        if (!user) {
            return res.status(404).json({ error: 'Usuário não encontrado no banco de dados.' });
        }

        await pool.query(`UPDATE users SET email = $1 WHERE id = $2`, [cleanNewEmail, user.id]);
        await revokeUserSessions(user.id);

        console.log(`🔑 [PAINEL MASTER] Email do usuário ${cleanTargetEmail} alterado para ${cleanNewEmail}`);

        // Notificar usuário antigo
        addSystemNotification(
            cleanTargetEmail,
            'E-mail Alterado pelo Administrador',
            `Seu e-mail na plataforma KL Web foi alterado para ${cleanNewEmail}. Se você não solicitou esta alteração, entre em contato imediatamente.`,
            'security',
            user.id
        );

        // Notificar usuário novo
        addSystemNotification(
            cleanNewEmail,
            'Bem-vindo à KL Web',
            `Sua conta foi configurada com o e-mail ${cleanNewEmail}. Faça login para acessar o sistema.`,
            'info',
            user.id
        );

        res.json({
            success: true,
            message: `E-mail de ${user.name} alterado de ${cleanTargetEmail} para ${cleanNewEmail} com sucesso!`
        });
    } catch (err) {
        console.error('Erro ao alterar email:', err.message);
        res.status(500).json({ error: 'Erro ao alterar e-mail.' });
    }
});

async function auditLog(req, action, userId = null, userEmail = null) {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';
    const userAgent = req.headers['user-agent'] || 'Desconhecido';
    const email = userEmail || (req.user ? req.user.email : 'ANÔNIMO');
    const uid = userId || (req.user ? req.user.id : null);

    try {
        await pool.query(
            `INSERT INTO security_logs (user_id, user_email, action, ip_address, user_agent) VALUES ($1, $2, $3, $4, $5)`,
            [uid, email, action, ip, userAgent]
        );
    } catch (err) {
        console.error('Erro ao gravar log de auditoria:', err.message);
    }
}

// (O antigo sistema de 2FA por código de e-mail — /api/auth/2fa/send e /api/auth/2fa/verify —
// foi removido daqui: o front nunca chamava essas rotas, só o 2FA por app autenticador
// (TOTP, /api/auth/2fa/totp/*) está em uso. Deixar aquelas rotas vivas era um risco real:
// /send não tinha NENHUM rate limit e mandava e-mail pra qualquer endereço informado no
// corpo da requisição, sem autenticação — um caminho aberto pra usar seu SMTP como
// mail relay/spam, mesmo sem nenhuma tela do site apontando pra ele.)

function checkPermission(requiredRole) {
    // Hierarquia de cargos do menor para o maior privilégio
    const roleHierarchy = {
        'USER': 1,
        'MANAGER': 2,
        'ADMIN': 3,
        'OWNER': 4
    };

    return (req, res, next) => {
        if (!req.user || !req.user.role) {
            return res.status(401).json({ message: 'Acesso não autorizado. Identificação ausente.' });
        }

        const userLevel = roleHierarchy[req.user.role] || 0;
        const requiredLevel = roleHierarchy[requiredRole] || 99;

        if (userLevel < requiredLevel) {
            if (typeof auditLog === 'function') {
                auditLog(req, `ACESSO_NEGADO_PRIVILEGIO_INSUFICIENTE (Requerido: ${requiredRole})`);
            }
            return res.status(403).json({ message: 'Acesso negado: Você não possui os privilégios necessários para esta operação.' });
        }

        next();
    };
}

app.post('/api/security/phishing-simulation-log', authenticateToken, checkPermission('ADMIN'), (req, res) => {
    const { targetEmail, status } = req.body;

    auditLog(req, `SIMULACAO_PHISHING_REGISTRADA: ${targetEmail} (${status})`);
    res.json({ message: 'Métrica de treinamento anti-phishing registrada com sucesso.' });
});

// ================= SUPPORT CHAT APIS =================

// Adicione este endpoint no backend (server_3.js) para gerenciar conexões em tempo real
const activeSseClients = new Map(); // chatId -> Set(res)

app.get('/api/support/chats/:id/stream', authenticateToken, async (req, res) => {
    const chatId = String(req.params.id);

    // O token pode vir por querystring (?token=) porque EventSource não permite cabeçalhos
    // customizados; por isso é essencial confirmar aqui que este usuário pode ver ESTE chat.
    if (!req.user.isSiteStaff) {
        const chatCheck = await pool.query('SELECT user_id FROM support_chats WHERE id = $1', [chatId]);
        if (chatCheck.rows.length === 0 || chatCheck.rows[0].user_id !== req.user.id) {
            return res.status(403).json({ message: 'Acesso negado.' });
        }
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.flushHeaders();

    if (!activeSseClients.has(chatId)) {
        activeSseClients.set(chatId, new Set());
    }
    activeSseClients.get(chatId).add(res);

    // Initial connection handshake
    res.write(`data: ${JSON.stringify({ type: 'connected', chatId })}\n\n`);

    const keepAlive = setInterval(() => {
        try {
            res.write(': keep-alive\n\n');
        } catch (e) {
            clearInterval(keepAlive);
        }
    }, 25000);

    req.on('close', () => {
        clearInterval(keepAlive);
        const clients = activeSseClients.get(chatId);
        if (clients) {
            clients.delete(res);
            if (clients.size === 0) activeSseClients.delete(chatId);
        }
    });
});

// Função auxiliar para notificar clientes conectados via SSE
function broadcastSupportEvent(chatId, payload) {
    const clients = activeSseClients.get(String(chatId));
    if (clients && clients.size > 0) {
        const data = `data: ${JSON.stringify(payload)}\n\n`;
        clients.forEach(client => {
            try {
                client.write(data);
            } catch (e) {
                clients.delete(client);
            }
        });
    }
}

function broadcastNewSupportMessage(chatId, messageObj) {
    broadcastSupportEvent(chatId, { type: 'message', message: messageObj });
}

app.get('/api/support/chats', authenticateToken, async (req, res) => {
    try {
        // If user is owner/admin, show all chats
        if (req.user.isSiteStaff) {
            const result = await pool.query(`
                SELECT sc.*,
                       COUNT(sm.id) as message_count,
                       MAX(sm.created_at) as last_message_at
                FROM support_chats sc
                LEFT JOIN support_messages sm ON sc.id = sm.chat_id
                GROUP BY sc.id
                ORDER BY sc.updated_at DESC
            `);

            res.json({ chats: result.rows });
        } else {
            // Regular users only see their own chats
            const result = await pool.query(`
                SELECT sc.*,
                       COUNT(sm.id) as message_count,
                       MAX(sm.created_at) as last_message_at
                FROM support_chats sc
                LEFT JOIN support_messages sm ON sc.id = sm.chat_id
                WHERE sc.user_id = $1
                GROUP BY sc.id
                ORDER BY sc.updated_at DESC
            `, [req.user.id]);

            res.json({ chats: result.rows });
        }
    } catch (err) {
        console.error('Erro ao buscar chats de suporte:', err.message);
        res.status(500).json({ message: 'Erro ao buscar chats de suporte.' });
    }
});

app.patch('/api/support/chats/:id/status', authenticateToken, async (req, res) => {
    if (!req.user.isSiteStaff) {
        return res.status(403).json({ message: 'Apenas o suporte pode encerrar atendimentos.' });
    }

    const newStatus = req.body?.status;
    if (!['OPEN', 'CLOSED'].includes(newStatus)) {
        return res.status(400).json({ message: 'Status de atendimento inválido.' });
    }

    try {
        const result = await pool.query(
            `UPDATE support_chats
             SET status = $1, updated_at = CURRENT_TIMESTAMP
             WHERE id = $2
             RETURNING id, status, updated_at`,
            [newStatus, req.params.id]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Chat não encontrado.' });
        }

        res.json({ chat: result.rows[0] });
    } catch (err) {
        console.error('Erro ao encerrar atendimento:', err.message);
        res.status(500).json({ message: 'Erro ao encerrar atendimento.' });
    }
});

app.get('/api/support/chats/:id/messages', authenticateToken, async (req, res) => {
    try {
        const chatId = req.params.id;

        // Check if user is owner/admin or the chat owner
        if (!req.user.isSiteStaff) {
            const chatCheck = await pool.query(
                'SELECT user_id FROM support_chats WHERE id = $1',
                [chatId]
            );
            if (chatCheck.rows.length === 0 || chatCheck.rows[0].user_id !== req.user.id) {
                return res.status(403).json({ message: 'Acesso negado.' });
            }
        }

        const result = await pool.query(
            'SELECT * FROM support_messages WHERE chat_id = $1 ORDER BY created_at ASC',
            [chatId]
        );

        // Mark chat as read if it's the admin viewing
        if (req.user.isSiteStaff) {
            await pool.query(
                'UPDATE support_chats SET is_unread = 0 WHERE id = $1',
                [chatId]
            );
        }

        res.json({ messages: result.rows });
    } catch (err) {
        console.error('Erro ao buscar mensagens do chat:', err.message);
        res.status(500).json({ message: 'Erro ao buscar mensagens do chat.' });
    }
});

app.post('/api/support/chats', authenticateToken, async (req, res) => {
    try {
        const { subject } = req.body;
        const userId = req.user.id;
        const userEmail = req.user.email;
        const userName = req.user.name;

        if (!subject) {
            return res.status(400).json({ message: 'Assunto é obrigatório.' });
        }

        const result = await pool.query(
            `INSERT INTO support_chats (user_id, user_email, user_name, subject, status, is_unread)
             VALUES ($1, $2, $3, $4, 'OPEN', 1)
             RETURNING *`,
            [userId, userEmail, userName, subject]
        );

        // Add initial system message
        await pool.query(
            `INSERT INTO support_messages (chat_id, sender_type, message)
             VALUES ($1, 'SYSTEM', 'Olá! Como posso ajudar você hoje?')`,
            [result.rows[0].id]
        );

        res.json({ chat: result.rows[0] });
    } catch (err) {
        console.error('Erro ao criar chat de suporte:', err.message);
        res.status(500).json({ message: 'Erro ao criar chat de suporte.' });
    }
});

app.post('/api/support/chats/:id/messages', authenticateToken, async (req, res) => {
    try {
        const chatId = req.params.id;
        const userId = req.user.id;
        const userRole = req.user.role;

        // Buscar proprietário do chat
        const chatQuery = await pool.query('SELECT user_id, status FROM support_chats WHERE id = $1', [chatId]);
        if (chatQuery.rows.length === 0) {
            return res.status(404).json({ message: 'Chat não encontrado.' });
        }

        const isOwner = chatQuery.rows[0].user_id === userId;
        const isAdmin = !!req.user.isSiteStaff;

        if (!isOwner && !isAdmin) {
            return res.status(403).json({ message: 'Acesso negado: Você não tem permissão para interagir neste chat.' });
        }

        if (isAdmin && chatQuery.rows[0].status === 'CLOSED') {
            return res.status(409).json({ message: 'Este atendimento já foi encerrado.' });
        }

        const { message } = req.body;
        if (typeof message !== 'string' || !message.trim() || message.length > 4000) {
            return res.status(400).json({ message: 'Mensagem inválida.' });
        }

        const senderType = isAdmin ? 'SUPPORT' : 'USER';
        const result = await pool.query(
            `INSERT INTO support_messages (chat_id, sender_id, sender_type, message) VALUES ($1, $2, $3, $4) RETURNING *`,
            [chatId, userId, senderType, message]
        );
        if (senderType === 'USER') {
            await pool.query(
                `UPDATE support_chats
                 SET is_unread = 1, status = 'OPEN', updated_at = CURRENT_TIMESTAMP
                 WHERE id = $1`,
                [chatId]
            );
        } else {
            await pool.query('UPDATE support_chats SET updated_at = CURRENT_TIMESTAMP WHERE id = $1', [chatId]);
        }

        // Também transmite em tempo real para quem está com o socket aberto nesta sala
        // (ex.: usuário mandando pelo formulário sem JS de socket, ou socket ainda conectando).
        io.to(`chat_${chatId}`).emit('receive_message', {
            senderId: userId,
            senderType,
            message,
            userName: req.user.name,
            timestamp: result.rows[0].created_at
        });

        return res.status(201).json({ success: true, message: result.rows[0] });
    } catch (err) {
        console.error('Erro ao enviar mensagem:', err);
        return res.status(500).json({ message: 'Erro interno do servidor.' });
    }
});

app.get('/api/support/unread-count', authenticateToken, async (req, res) => {
    try {
        let count = 0;

        if (req.user.isSiteStaff) {
            // Admins see all unread chats
            const result = await pool.query(
                'SELECT COUNT(*) as count FROM support_chats WHERE is_unread = 1'
            );
            count = parseInt(result.rows[0].count);
        } else {
            // Regular users see their own unread chats
            const result = await pool.query(
                'SELECT COUNT(*) as count FROM support_chats WHERE user_id = $1 AND is_unread = 1',
                [req.user.id]
            );
            count = parseInt(result.rows[0].count);
        }

        res.json({ count });
    } catch (err) {
        console.error('Erro ao buscar contagem de chats não lidos:', err.message);
        res.status(500).json({ message: 'Erro ao buscar contagem.' });
    }
});

// ================= FEEDBACK APIS =================
app.get('/api/feedbacks', authenticateToken, async (req, res) => {
    try {
        // Only owners and admins can see feedbacks
        if (!req.user.isSiteStaff) {
            return res.status(403).json({ message: 'Acesso negado.' });
        }

        const result = await pool.query(`
            SELECT * FROM feedbacks
            ORDER BY created_at DESC
        `);

        res.json({ feedbacks: result.rows });
    } catch (err) {
        console.error('Erro ao buscar feedbacks:', err.message);
        res.status(500).json({ message: 'Erro ao buscar feedbacks.' });
    }
});

app.post('/api/feedbacks', authenticateToken, async (req, res) => {
    try {
        const { type, content } = req.body;
        const userId = req.user.id;
        const userEmail = req.user.email;
        const userName = req.user.name;

        if (!type || !content) {
            return res.status(400).json({ message: 'Tipo e conteúdo são obrigatórios.' });
        }

        const validTypes = ['MELHORIA', 'CRITICA', 'DUVIDA', 'ELOGIO'];
        if (!validTypes.includes(type)) {
            return res.status(400).json({ message: 'Tipo de feedback inválido.' });
        }

        const result = await pool.query(
            `INSERT INTO feedbacks (user_id, user_email, user_name, type, content, status)
             VALUES ($1, $2, $3, $4, $5, 'PENDING')
             RETURNING *`,
            [userId, userEmail, userName, type, content]
        );

        res.json({ feedback: result.rows[0] });
    } catch (err) {
        console.error('Erro ao criar feedback:', err.message);
        res.status(500).json({ message: 'Erro ao criar feedback.' });
    }
});

app.put('/api/feedbacks/:id/status', authenticateToken, async (req, res) => {
    try {
        const feedbackId = req.params.id;
        const { status } = req.body;

        // Only owners and admins can update feedback status
        if (!req.user.isSiteStaff) {
            return res.status(403).json({ message: 'Acesso negado.' });
        }

        const validStatuses = ['PENDING', 'REVIEWED', 'RESOLVED'];
        if (!validStatuses.includes(status)) {
            return res.status(400).json({ message: 'Status inválido.' });
        }

        await pool.query(
            'UPDATE feedbacks SET status = $1 WHERE id = $2',
            [status, feedbackId]
        );

        res.json({ message: 'Status do feedback atualizado com sucesso.' });
    } catch (err) {
        console.error('Erro ao atualizar status do feedback:', err.message);
        res.status(500).json({ message: 'Erro ao atualizar status do feedback.' });
    }
});

// Support typing indicator routes
app.post('/api/support/chats/:id/typing', authenticateToken, async (req, res) => {
    try {
        const chatId = req.params.id;
        const { isTyping } = req.body;

        // Verify user has access to this chat
        const chatResult = await pool.query(
            'SELECT * FROM support_chats WHERE id = $1',
            [chatId]
        );

        if (chatResult.rows.length === 0) {
            return res.status(404).json({ message: 'Chat não encontrado.' });
        }

        const chat = chatResult.rows[0];
        const isAdmin = ['ADMIN', 'OWNER'].includes(req.user.role);

        // Check access: admin can access all, user can only access their own
        if (!isAdmin && chat.user_id !== req.user.id) {
            return res.status(403).json({ message: 'Acesso negado.' });
        }

        // Update typing state in database
        const typingExpiresAt = new Date(Date.now() + 5000); // 5 seconds

        if (isTyping) {
            await pool.query(
                `UPDATE support_chats
                 SET typing_user_id = $1, typing_expires_at = $2
                 WHERE id = $3`,
                [req.user.id, typingExpiresAt, chatId]
            );
        } else {
            await pool.query(
                `UPDATE support_chats
                 SET typing_user_id = NULL, typing_expires_at = NULL
                 WHERE id = $3`,
                [chatId]
            );
        }

        // Transmite o evento de digitação imediatamente via SSE
        broadcastSupportEvent(chatId, {
            type: 'typing',
            isTyping: !!isTyping,
            userId: req.user.id,
            userName: req.user.name,
            role: req.user.role
        });

        res.json({ success: true });
    } catch (err) {
        console.error('Erro ao atualizar estado de digitação:', err.message);
        res.status(500).json({ message: 'Erro ao atualizar estado de digitação.' });
    }
});

app.get('/api/support/chats/:id/typing', authenticateToken, async (req, res) => {
    try {
        const chatId = req.params.id;

        // Verify user has access to this chat
        const chatResult = await pool.query(
            'SELECT * FROM support_chats WHERE id = $1',
            [chatId]
        );

        if (chatResult.rows.length === 0) {
            return res.status(404).json({ message: 'Chat não encontrado.' });
        }

        const chat = chatResult.rows[0];
        const isAdmin = ['ADMIN', 'OWNER'].includes(req.user.role);

        // Check access
        if (!isAdmin && chat.user_id !== req.user.id) {
            return res.status(403).json({ message: 'Acesso negado.' });
        }

        // Check if someone is typing (and not expired)
        const now = new Date();
        if (chat.typing_user_id && chat.typing_expires_at && new Date(chat.typing_expires_at) > now) {
            // Only show typing if it's NOT the current user
            if (chat.typing_user_id !== req.user.id) {
                res.json({ isTyping: true, userId: chat.typing_user_id });
            } else {
                res.json({ isTyping: false });
            }
        } else {
            // Clear expired typing state
            if (chat.typing_expires_at && new Date(chat.typing_expires_at) <= now) {
                await pool.query(
                    `UPDATE support_chats
                     SET typing_user_id = NULL, typing_expires_at = NULL
                     WHERE id = $1`,
                    [chatId]
                );
            }
            res.json({ isTyping: false });
        }
    } catch (err) {
        console.error('Erro ao verificar estado de digitação:', err.message);
        res.status(500).json({ message: 'Erro ao verificar estado de digitação.' });
    }
});

// User preferences endpoints
app.get('/api/user/preferences', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT theme, font_size, daltonic_mode, notif_prefs FROM users WHERE id = $1`,
            [req.user.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Usuário não encontrado.' });
        }

        const user = result.rows[0];
        res.json({
            theme: user.theme || 'light',
            font_size: user.font_size || '100%',
            daltonic_mode: user.daltonic_mode || 'off'
        });
    } catch (err) {
        console.error('Erro ao buscar preferências:', err.message);
        res.status(500).json({ message: 'Erro ao buscar preferências.' });
    }
});

app.get('/api/user/notification-settings', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(`SELECT notif_prefs FROM users WHERE id = $1`, [req.user.id]);
        const emailAllowed = await companyCanSendEmail(req.user.companyId, req.user.id);
        res.json({
            kinds: NOTIFICATION_KINDS,
            prefs: parseNotifPrefs(result.rows[0]?.notif_prefs),
            emailAllowed
        });
    } catch (err) {
        console.error('Erro ao buscar configurações de notificação:', err.message);
        res.status(500).json({ message: 'Erro ao buscar configurações de notificação.' });
    }
});

app.put('/api/user/notification-settings', authenticateToken, async (req, res) => {
    try {
        const incoming = req.body?.prefs || {};
        // Plano gratuito não liga e-mail: mantém o que já estava salvo (o envio também é barrado em notifyUser).
        const emailAllowed = await companyCanSendEmail(req.user.companyId, req.user.id);
        let existing = null;
        if (!emailAllowed) {
            const cur = await pool.query(`SELECT notif_prefs FROM users WHERE id = $1`, [req.user.id]);
            existing = parseNotifPrefs(cur.rows[0]?.notif_prefs);
        }
        const clean = {};
        for (const key of Object.keys(NOTIFICATION_KINDS)) {
            clean[key] = { panel: incoming[key]?.panel !== false, email: emailAllowed ? incoming[key]?.email !== false : existing[key].email };
        }
        await pool.query(`UPDATE users SET notif_prefs = $1 WHERE id = $2`, [JSON.stringify(clean), req.user.id]);
        res.json({ message: 'Preferências de notificação salvas.', prefs: clean });
    } catch (err) {
        console.error('Erro ao salvar configurações de notificação:', err.message);
        res.status(500).json({ message: 'Erro ao salvar configurações de notificação.' });
    }
});

app.put('/api/user/preferences', authenticateToken, async (req, res) => {
    try {
        const { theme, font_size, daltonic_mode } = req.body;

        await pool.query(
            `UPDATE users SET theme = $1, font_size = $2, daltonic_mode = $3 WHERE id = $4`,
            [theme, font_size, daltonic_mode, req.user.id]
        );

        res.json({ message: 'Preferências atualizadas com sucesso.' });
    } catch (err) {
        console.error('Erro ao atualizar preferências:', err.message);
        res.status(500).json({ message: 'Erro ao atualizar preferências.' });
    }
});

// LDAP/Active Directory: não é usado em nenhum fluxo de autenticação hoje (login é só
// e-mail/senha via bcrypt). Carregado de forma defensiva para o servidor não cair caso
// o pacote falhe ao carregar (ex.: dependência nativa incompatível no ambiente de deploy).
let ActiveDirectory = null;
let adConfig = null;
try {
    ActiveDirectory = require('activedirectory2');
    adConfig = {
        url: process.env.LDAP_URL || 'ldap://corp.klweb.com.br',
        baseDN: process.env.LDAP_BASE_DN || 'dc=klweb,dc=com,dc=br',
        username: process.env.LDAP_USER || 'admin@klweb.com.br',
        password: process.env.LDAP_PASSWORD || ''
    };
} catch (err) {
    console.warn('⚠️ Módulo activedirectory2 não pôde ser carregado (recurso não utilizado hoje):', err.message);
}

// ==================== ERP KL Web (rotas /api/erp/* + ações da Cláudia) ====================
// Cria as tabelas erp_* sozinho na primeira subida. ERP: Starter e Pro AI (canUseErp); nota fiscal Focus NFe: só Pro AI (canUseErpFiscal).
try {
    erpService = require('./erp')(app, { pool, authenticateToken, requireCompany, encryptData, decryptData, canUseErp, canUseErpFiscal });
    console.log('📦 Módulo ERP carregado.');
} catch (err) {
    console.error('❌ Não foi possível carregar o módulo ERP (erp.js):', err.message);
}

// Tratamento de erros de upload (multer) e de JSON inválido: sempre responde JSON
app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        const msg = err.code === 'LIMIT_FILE_SIZE'
            ? 'Arquivo muito grande. O limite é de 100 MB.'
            : `Erro no upload: ${err.message}`;
        return res.status(400).json({ message: msg });
    }
    if (err && err.message === 'Tipo de arquivo não suportado!') {
        return res.status(400).json({ message: err.message });
    }
    if (err && err.type === 'entity.parse.failed') {
        return res.status(400).json({ message: 'Corpo da requisição inválido.' });
    }
    if (err && err.message === 'Origem não permitida pelo CORS.') {
        return res.status(403).json({ message: err.message });
    }
    next(err);
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor iniciado com sucesso!`);
    console.log(`🌐 Escutando na porta: ${PORT}`);
    console.log(`📍 Host: 0.0.0.0`);
}).on('error', (err) => {
    console.error('❌ Erro crítico ao iniciar o servidor:', err);
    process.exit(1);
});