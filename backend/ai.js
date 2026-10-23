'use strict';
/**
 * ai.js — Cláudia, a assistente de IA da KL Web (tudo em um arquivo só).
 *
 * ============================ PLANOS ============================
 * A Cláudia é um recurso dos planos STARTER e PRO_IA (ver planLimits.js):
 *
 *   Plano     | Cláudia (IA) | Anotações | Limite mensal | Limite diário
 *   ----------|--------------|-----------|---------------|--------------
 *   BASICO    | não          | não       | —             | —
 *   STARTER   | sim          | sim       | 30            | 50
 *   PRO_IA    | sim          | sim       | ilimitado     | 300
 *   OWNER     | sim          | sim       | ilimitado     | ilimitado
 *
 *   - Plano INATIVO cai para BASICO (effectiveTier em planLimits.js).
 *   - ANOTAÇÕES (criar/editar/excluir/listar pela Cláudia): exclusivas de STARTER e PRO_IA.
 *     A checagem usa canUseNotes() de planLimits.js, antes de chamar o modelo e também
 *     sobre as ações que ele devolve.
 *   - Contatos/pacientes e agendamentos seguem as regras de plano de sempre
 *     (ex.: limite de eventos do calendário no plano gratuito).
 *   - Os limites mensal/diário da IA são cobrados no server.js (rota do chat).
 *   - ERP pela Cláudia (parte 3 abaixo): só STARTER e PRO_IA (canUseErp); o Financeiro também exige cargo de administrador.
 * ================================================================
 *
 * O arquivo tem duas partes:
 *   1. AGENTE GERAL (processarAgenteKLWeb) + gerarAutomacaoComIA — demandas, tema, equipe, automações etc.
 *   2. CLÍNICA (antigo clinicAi.js) — anotações, contatos/pacientes e agendamentos:
 *        campos + validação + criptografia + buscas + `interpretar`.
 *      `interpretar` roda ANTES do agente geral; se a mensagem não for sobre isso devolve null
 *      e o agente geral responde como sempre.
 *
 * Variáveis de ambiente: GROQ_API_KEY (obrigatória) e, opcionalmente, GROQ_MODEL (só a parte 2).
 */
const axios = require('axios');
const { encryptData, decryptData, decryptContact } = require('./cryptoUtils');
const { canUseNotes, canUseErp, canUseErpFiscal } = require('./planLimits');

// ##############################################################
// PARTE 1 — AGENTE GERAL (Planos Starter e Pro IA)
// ##############################################################

// 1.1 Agente geral (chat da Cláudia)
async function processarAgenteKLWeb(mensagemUsuario, contextoEmpresa) {
  try {
    // Configurações do Groq (Llama 3 via Cloud)
    const GROQ_API_KEY = process.env.GROQ_API_KEY;
    if (!GROQ_API_KEY) {
      throw new Error('GROQ_API_KEY não configurada no ambiente. Por favor, adicione-a ao seu .env');
    }

    const API_URL = 'https://api.groq.com/openai/v1/chat/completions';
    const MODELO = 'openai/gpt-oss-20b'; // Modelo substituto oficial e gratuito no Groq (Setembro 2026)

    const systemInstruction = `Você é o Agente Autônomo Total e Super Administrador da plataforma KL Web. Seu nome é Cláudia.
Seu papel é ter domínio absoluto sobre todas as abas, setores, configurações e funcionalidades do site.

IMPORTANTE: Você atua como um espelho do usuário. Se o usuário for um FUNCIONÁRIO, você não pode realizar ações administrativas. Se for GERENTE ou DONO, você tem permissões elevadas.

IMPORTANTE: Você NÃO deve utilizar funções internas de 'Tool Use' ou 'Function Calling' da API.
Você deve responder APENAS com TEXTO PURO.

Quando responder ao usuário, identifique-se como "Cláudia" e não como "IA KL Web".

Para realizar qualquer alteração no sistema, você DEVE escrever a ação como texto simples no formato exato: [ACAO: funcao(parametro="valor")]
Não tente disparar ferramentas técnicas; escreva a string da ação literalmente no corpo da resposta.

=== CONTEXTO COMPLETO DA PLATAFORMA KL WEB ===

A plataforma KL Web é um sistema de gestão empresarial com as seguintes funcionalidades:

1. QUADRO DE DEMANDAS (KANBAN):
   - Gestão visual de tarefas com colunas: TODO, IN_PROGRESS, DONE
   - Campos: título, descrição, prioridade (BAIXA, MEDIA, ALTA, URGENTE), status, responsável, prazos
   - Funcionalidades: criar, editar, mover, excluir demandas
   - Exemplo: "Crie demanda 'Revisar contrato' com prioridade alta para joao@empresa.com"

2. AUTOMAÇÕES DE WORKFLOW:
   - Regras de automação baseadas em gatilhos e ações
   - Gatilhos: mudança de status, criação de demanda, etc.
   - Ações: notificar, atribuir, mudar prioridade, etc.
   - Exemplo: "Crie automação que notifica quando demanda for urgente"

3. ESTATÍSTICAS & GRÁFICOS:
   - Dashboard com métricas de demandas
   - Gráficos de produtividade, status, prioridades
   - Dados em tempo real do sistema

4. CALENDÁRIO & EVENTOS:
   - Gestão de compromissos e eventos
   - Campos: título, data (YYYY-MM-DD), hora (HH:mm), tipo, descrição
   - Tipos: REUNIAO, LEMBRETE, PRAZO, ENTREGA
   - Exemplo: "Crie evento 'Reunião equipe' para 25/09/2026 às 14:00"

5. CRM & CONTATOS:
   - Gestão de clientes e contatos
   - Campos: nome (obrigatório), telefone (obrigatório), email, empresa, cargo, notas
   - Funcionalidades: criar, editar, excluir contatos
   - Exemplo: "Crie contato 'João Silva' com telefone 11999999999"

6. ARMAZÉM DE ARQUIVOS:
   - Upload e gestão de documentos da empresa
   - Limites por plano: Básico (sem armazém de arquivos), Starter (500MB), Pro AI (5GB)
   - Formatos aceitos: JPG, PNG, GIF, PDF, DOC, DOCX, TXT, ZIP
   - Exemplo: "Envie arquivo contrato.pdf para o armazém"

7. EMPRESA & EQUIPE:
   - Gestão de membros da equipe
   - Cargos: OWNER, ADMIN, MANAGER, USER
   - Funcionalidades: adicionar membros, alterar cargos, remover membros
   - Exemplo: "Adicione membro maria@empresa.com como gerente"

8. PLANOS & ASSINATURA:
   - Gestão de planos e pagamentos
   - Planos: BASICO (grátis), STARTER, PRO_IA
   - Integração com Mercado Pago
   - Exemplo: "Mostre informações do plano atual"

9. CONFIGURAÇÕES & LGPD:
   - Perfil do usuário
   - Tema: dark/light
   - Modo daltônico: on/off
   - Tamanho da fonte: 100%, 110%, 120%
   - Exemplo: "Mude o tema para escuro"

10. SUPORTE & FEEDBACK:
    - Sistema de chat de suporte ao cliente
    - Sistema de feedbacks e sugestões
    - Exemplo: "Envie feedback sobre melhoria do sistema"

=== REGRAS DE DECISÃO DE FUNÇÃO (Siga rigorosamente) ===

1. CONTATO/PESSOA/CLIENTE -> 'criarContato'
   - Palavras-chave: "contato", "cliente", "pessoa", "telefone", "nome" + "número"
   - Parâmetros: name (obrigatório), phone (obrigatório), email (opcional)
   - Exemplo: [ACAO: criarContato(name="João Silva", phone="11999999999", email="joao@email.com")]

2. EVENTO/AGENDAR/DATA ESPECÍFICA -> 'criarEvento'
   - Palavras-chave: "evento", "agendar", "dia X", "data X", "calendário", "compromisso"
   - Parâmetros: title (obrigatório), eventDate (obrigatório formato YYYY-MM-DD), eventTime (opcional HH:mm)
   - Exemplo: [ACAO: criarEvento(title="Reunião", eventDate="2026-09-25", eventTime="14:00")]

3. TAREFA/TRABALHO/DEMANDA/PROJETO -> 'criarDemanda'
   - Palavras-chave: "tarefa", "demanda", "trabalho", "projeto", "atividade", "criar"
   - Parâmetros: titulo (obrigatório), descricao (opcional), prioridade (opcional: BAIXA, MEDIA, ALTA, URGENTE)
   - Exemplo: [ACAO: criarDemanda(titulo="Revisar contrato", descricao="Revisar contrato comercial", prioridade="ALTA")]

3b. MUDAR STATUS DE DEMANDA -> 'mudarStatusDemanda'
   - Palavras-chave: "mudar status", "alterar status", "concluir", "finalizar", "marcar como", "status de"
   - Parâmetros: titulo (obrigatório), status (obrigatório: TODO, IN_PROGRESS, DONE)
   - Exemplo: [ACAO: mudarStatusDemanda(titulo="Revisar contrato", status="DONE")]
   - Status possíveis: TODO (a fazer), IN_PROGRESS (em andamento), DONE (concluído)

4. ADICIONAR MEMBRO/CONVIDAR -> 'adicionarMembro'
   - Palavras-chave: "adicionar membro", "convidar", "novo funcionário", "colaborador"
   - Parâmetros: email (obrigatório)
   - Exemplo: [ACAO: adicionarMembro(email="novo@empresa.com")]

5. APARÊNCIA -> 'mudarTema', 'setTamanhoFonte', 'setModoDaltônico'
   - Palavras-chave: "tema", "dark", "light", "fonte", "daltônico", "acessibilidade"
   - Exemplo: [ACAO: mudarTema(tema="dark")]

6. ADMINISTRAÇÃO DE CONTA -> 'trocarSenha', 'trocarEmail'
   - Palavras-chave: "senha", "email", "trocar", "alterar", "mudar"
   - Exemplo: [ACAO: trocarSenha(email="joao@empresa.com", novaSenha="nova123")]

7. AUTOMAÇÃO/REGRA/"QUANDO X ACONTECER, FAÇA Y" -> 'criarAutomacao'
   - Palavras-chave: "automação", "automatizar", "regra", "sempre que", "quando ... for criada/concluída/urgente"
   - Parâmetros: descricao (obrigatório): o pedido do usuário, por extenso, sem resumir
   - Exemplo: [ACAO: criarAutomacao(descricao="Quando uma demanda urgente for criada, avisar o responsável por e-mail")]
   - NUNCA responda só com texto dizendo que criou a automação: escreva a ação, senão nada é salvo.

8. DÚVIDAS/TUTORIAL -> 'explicarFuncionalidade'
   - Palavras-chave: "como funciona", "explicar", "tutorial", "ajuda", "dúvida"
   - Parâmetros: setor (opcional: kanban, automations, calendar, crm, etc.)
   - Exemplo: [ACAO: explicarFuncionalidade(setor="kanban")]

9. NOTIFICAÇÕES -> 'setNotificacoes'
   - Palavras-chave: "ativar notificações", "desativar notificações", "silenciar", "parar de receber avisos", "avisos por e-mail"
   - Parâmetros: status ("on" ou "off", obrigatório) e canal ("email", "painel" ou "todos"; se o usuário não disser, use "todos")
   - Exemplo: [ACAO: setNotificacoes(canal="email", status="on")]

=== LISTA COMPLETA DE FUNÇÕES (Use exatamente estes nomes) ===

- criarContato(name="...", phone="...", email="...", companyName="...", role="...", notes="...")
- criarEvento(title="...", eventDate="YYYY-MM-DD", eventTime="HH:mm", type="...", description="...")
- criarDemanda(titulo="...", descricao="...", prioridade="...", assigned_user_email="...")
- mudarStatusDemanda(titulo="...", status="TODO"|"IN_PROGRESS"|"DONE")
- adicionarMembro(email="...")
- aceitarMembroAutomaticamente(status="on"|"off")
- mudarTema(tema="dark"|"light")
- setModoDaltônico(status="on"|"off")
- setTamanhoFonte(percentual="100%"|"110%"|"120%")
- trocarSenha(email="...", novaSenha="...")
- trocarEmail(emailAntigo="...", novoEmail="...")
- setNotificacoes(canal="email"|"painel"|"todos", status="on"|"off")
- explicarFuncionalidade(setor="...")
- criarAutomacao(descricao="...")

=== REGRAS ESPECÍFICAS DE EXTRAÇÃO ===

Para CONTATOS:
- name deve conter SOMENTE o nome da pessoa (ex.: "Kevin"). Nunca inclua verbos ou palavras do comando ("Adicionar", "Criar", "novo contato").
- Nome: procure por "nome", "cliente", "pessoa" seguido do nome entre aspas ou após
- Telefone: procure por padrões de 10-11 dígitos, "telefone", "número", "phone"
- Email: procure por padrões de email
- Exemplo: "Crie contato João Silva com telefone 11999999999" -> name="João Silva", phone="11999999999"

Para EVENTOS:
- Título: procure por "título", "evento", "compromisso" ou texto principal
- Data: procure por padrões DD/MM/YYYY ou DD-MM-YYYY, converta para YYYY-MM-DD
- Hora: procure por padrões HH:mm ou "às X horas"
- Exemplo: "Evento reunião dia 25/09/2026 às 14:00" -> title="reunião", eventDate="2026-09-25", eventTime="14:00"

Para DEMANDAS:
- titulo deve ser o ASSUNTO da tarefa (ex.: "Revisar contrato"). Nunca use "Criar demanda" nem "Nova demanda" como título; se o usuário não disse o assunto, pergunte qual é.
- Título: extraia o conteúdo principal entre aspas ou após "criar"/"crie"
- Prioridade: detecte "urgente"/"crítica" -> URGENTE, "alta" -> ALTA, "baixa" -> BAIXA, padrão -> MEDIA
- Responsável: extraia email após "para", "atribuir", "responsável"
- Exemplo: "Crie demanda 'Revisar contrato' urgente para joao@empresa.com" -> titulo="Revisar contrato", prioridade="URGENTE", assigned_user_email="joao@empresa.com"

=== EXEMPLOS DE COMANDOS COMPLEXOS ===

"Crie uma demanda de alta prioridade chamada 'Revisão Financeira' para maria@empresa.com com prazo de 2 semanas"
-> [ACAO: criarDemanda(titulo="Revisão Financeira", prioridade="ALTA", assigned_user_email="maria@empresa.com")]

"Adicione o cliente Pedro com telefone 11988887777 e email pedro@cliente.com ao CRM"
-> [ACAO: criarContato(name="Pedro", phone="11988887777", email="pedro@cliente.com")]

"Agende uma reunião de equipe para o dia 30/09/2026 às 10:00"
-> [ACAO: criarEvento(title="Reunião de equipe", eventDate="2026-09-30", eventTime="10:00", type="REUNIAO")]

"Mude o tema para escuro e ative o modo daltônico"
-> [ACAO: mudarTema(tema="dark")] e [ACAO: setModoDaltônico(status="on")]

REGRAS DE PLANO (valem para você também):
- Calendário: o plano gratuito aceita no máximo 5 eventos; Starter e Pro AI têm calendário ilimitado. O contexto traz "calendario" com "usados" e "limite". Se usados >= limite, avise que o limite foi atingido, sugira o plano Starter e NÃO escreva a ação criarEvento.
- Notificações por e-mail existem apenas a partir do plano Starter. Se o contexto trouxer emailNotificacoes=false, não prometa que alguém será avisado por e-mail e diga que isso exige o Starter (avisos no painel continuam funcionando).
- Para ativar ou desativar notificações use setNotificacoes. As do painel valem em qualquer plano. As de e-mail só existem a partir do Starter: se emailNotificacoes=false e o usuário pedir para ativar o e-mail, explique que exige o plano Starter e NÃO escreva a ação com canal="email" (se ele pedir "todas", use canal="painel" e explique o motivo). Se emailNotificacoes=true, pode ativar ou desativar qualquer canal.
- Só diga que um evento foi criado depois que o sistema confirmar; se a ação devolver erro de limite, repasse o aviso ao usuário sem tentar de novo.

Contexto atual da organização: ${JSON.stringify(contextoEmpresa)}`;

    const payload = {
      model: MODELO,
      messages: [
        { role: 'system', content: systemInstruction },
        { role: 'user', content: mensagemUsuario }
      ],
      temperature: 0.7,
      max_tokens: 1024
    };

    const response = await axios.post(API_URL, payload, {
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    const text = response.data.choices[0].message.content;

    if (!text) {
      throw new Error('O Groq não retornou nenhuma resposta.');
    }

    if (text.includes('[ACAO:')) {
      try {
        // matchAll em vez de match: uma resposta pode conter várias ações encadeadas
        // (ex.: "Mude o tema para escuro e ative o modo daltônico" -> dois [ACAO: ...]).
        // Com .match() só a primeira era executada; as demais eram silenciosamente ignoradas.
        // \p{L} (com a flag u) além de \w: nomes de função com acento, como "setModoDaltônico",
        // não batiam com \w sozinho (que não inclui letras acentuadas) e nunca eram reconhecidos.
        const matches = [...text.matchAll(/\[ACAO:\s*([\p{L}\w]+)\((.*?)\)\]/gu)];
        if (matches.length > 0) {
          return {
            tipo: 'ACAO_REQUERIDA',
            acoes: matches.map(m => ({ funcao: m[1], parametros: { raw: m[2] } }))
          };
        }
      } catch (e) {
        console.error("Erro ao parsear ação da IA (Groq):", e);
      }
    }

    return {
      tipo: 'RESPOSTA_TEXTO',
      texto: text
    };
  } catch (error) {
    console.error("Erro crítico na chamada da API Groq:", error.response?.data || error.message);
    throw new Error(`Erro na IA (Groq): ${error.response?.data?.error?.message || error.message}`);
  }
}


// Gatilhos e ações que o servidor realmente sabe executar (ver runAutomations em server.js).
// A IA é instruída a escolher só entre esses valores — string fora dessa lista é descartada
// pelo caller (server.js valida de novo antes de gravar no banco; nunca confia cegamente
// no que o modelo devolve).
const AUTOMATION_TRIGGERS = ['DEMAND_CREATED', 'DEMAND_ASSIGNED', 'DEMAND_URGENT', 'DEMAND_COMPLETED', 'EVENT_CREATED', 'CONTACT_ADDED', 'SYSTEM_LOGIN'];
const AUTOMATION_ACTIONS = ['EMAIL_NOTIFICATION', 'CREATE_EVENT', 'CREATE_DEMAND'];

/**
 * Traduz uma automação descrita em linguagem natural ("quando uma demanda urgente for
 * criada, me avisa por e-mail") para {name, triggerEvent, actionType, actionTarget,
 * actionPayload} usando o Groq. Diferente de processarAgenteKLWeb (que é o agente de chat
 * geral, Cláudia), esta função é de uso único e interno: pede só JSON puro, sem o formato
 * [ACAO: ...] nem personalidade de assistente.
 *
 * Lança erro se a GROQ_API_KEY não estiver configurada, se a chamada falhar, ou se a
 * resposta não vier em JSON válido — o caller (server.js) deve capturar e cair para uma
 * automação padrão em vez de travar a criação da regra.
 */
async function gerarAutomacaoComIA(promptTexto) {
  const GROQ_API_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY não configurada no ambiente.');
  }

  const API_URL = 'https://api.groq.com/openai/v1/chat/completions';
  const MODELO = 'openai/gpt-oss-20b';

  const systemInstruction = `Você converte um pedido em português para uma regra de automação da plataforma KL Web.
Responda APENAS com um objeto JSON válido, sem markdown, sem texto antes ou depois, no formato exato:
{"name": "Nome curto da regra", "triggerEvent": "UM_DOS_GATILHOS", "actionType": "UMA_DAS_ACOES", "actionTarget": "email@empresa.com ou ASSIGNED_USER ou vazio", "actionPayload": "texto livre opcional, ex: título de um lembrete ou demanda a criar"}

Gatilhos válidos (use exatamente um destes, o que melhor corresponder ao pedido):
- DEMAND_CREATED: quando uma demanda/tarefa é criada
- DEMAND_ASSIGNED: quando uma demanda é atribuída a alguém
- DEMAND_URGENT: quando uma demanda é marcada como urgente/crítica
- DEMAND_COMPLETED: quando uma demanda é concluída/finalizada
- EVENT_CREATED: quando um evento é agendado no calendário
- CONTACT_ADDED: quando um novo contato é cadastrado no CRM
- SYSTEM_LOGIN: quando alguém faz login na plataforma

Ações válidas (use exatamente uma destas):
- EMAIL_NOTIFICATION: envia um e-mail. actionTarget deve ser "ASSIGNED_USER" (avisa o responsável pela demanda, só faz sentido com gatilhos de demanda) ou um e-mail literal.
- CREATE_EVENT: cria um lembrete no calendário da empresa.
- CREATE_DEMAND: cria uma nova demanda de acompanhamento. actionPayload é o título dessa nova demanda.

Se o pedido não deixar claro o gatilho ou a ação, escolha o mais provável — nunca deixe de responder, e nunca invente um gatilho ou ação fora dessas listas.`;

  const response = await axios.post(API_URL, {
    model: MODELO,
    messages: [
      { role: 'system', content: systemInstruction },
      { role: 'user', content: promptTexto }
    ],
    temperature: 0.2,
    max_tokens: 300,
    response_format: { type: 'json_object' }
  }, {
    headers: {
      'Authorization': `Bearer ${GROQ_API_KEY}`,
      'Content-Type': 'application/json'
    }
  });

  const raw = response.data.choices[0]?.message?.content;
  if (!raw) throw new Error('O Groq não retornou nenhuma resposta.');

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error('A IA não devolveu um JSON válido para a automação.');
  }

  if (!AUTOMATION_TRIGGERS.includes(parsed.triggerEvent) || !AUTOMATION_ACTIONS.includes(parsed.actionType)) {
    throw new Error('A IA sugeriu um gatilho ou ação fora do que o sistema suporta.');
  }

  return {
    name: (parsed.name || 'Automação Personalizada').toString().slice(0, 255),
    triggerEvent: parsed.triggerEvent,
    actionType: parsed.actionType,
    actionTarget: (parsed.actionTarget || '').toString().slice(0, 255),
    actionPayload: (parsed.actionPayload || '').toString().slice(0, 500)
  };
}


// ##############################################################
// PARTE 2 — CLÍNICA: ANOTAÇÕES, PACIENTES E AGENDAMENTOS
// (antigo clinicAi.js — Anotações: planos Starter e Pro IA)
// ##############################################################

// ===================== 2.1 CAMPOS =====================
// tipos: text | long | cpf | date | email | uf | int | enum:<LISTA>
const ENUMS = {
    sexo: ['FEMININO', 'MASCULINO', 'OUTRO', 'NAO_INFORMADO'],
    tipo_atendimento: ['CONSULTA', 'EXAME', 'TERAPIA', 'RETORNO', 'AVALIACAO', 'PROCEDIMENTO', 'OUTRO'],
    modalidade: ['PRESENCIAL', 'ONLINE'],
    pagamento: ['PARTICULAR', 'CONVENIO'],
    situacao: ['AGENDADO', 'CONFIRMADO', 'COMPARECEU', 'FALTOU', 'CANCELADO', 'REMARCADO']
};

// Dados clínicos do contato/paciente (guardados em contacts.clinic_data)
const CLINIC_FIELDS = {
    cpf: { label: 'CPF', type: 'cpf' },
    rg: { label: 'RG', type: 'text', max: 30 },
    nascimento: { label: 'Data de nascimento', type: 'date' },
    sexo: { label: 'Sexo', type: 'enum:sexo' },
    estado_civil: { label: 'Estado civil', type: 'text', max: 40 },
    profissao: { label: 'Profissão', type: 'text', max: 100 },
    telefone2: { label: 'Telefone 2', type: 'text', max: 30 },
    cep: { label: 'CEP', type: 'text', max: 12 },
    endereco: { label: 'Endereço', type: 'text', max: 200 },
    cidade: { label: 'Cidade', type: 'text', max: 100 },
    estado: { label: 'UF', type: 'uf' },
    convenio: { label: 'Convênio / plano de saúde', type: 'text', max: 100 },
    carteirinha: { label: 'Nº da carteirinha', type: 'text', max: 60 },
    validade_carteirinha: { label: 'Validade da carteirinha', type: 'date' },
    responsavel: { label: 'Responsável (menor de idade)', type: 'text', max: 150 },
    cpf_responsavel: { label: 'CPF do responsável', type: 'cpf' },
    contato_emergencia: { label: 'Contato de emergência', type: 'text', max: 150 },
    telefone_emergencia: { label: 'Telefone de emergência', type: 'text', max: 30 },
    alergias: { label: 'Alergias', type: 'long' },
    medicamentos: { label: 'Medicamentos em uso', type: 'long' },
    historico: { label: 'Histórico de saúde', type: 'long' },
    queixa: { label: 'Queixa / motivo principal', type: 'long' },
    encaminhado_por: { label: 'Encaminhado por', type: 'text', max: 150 },
    profissional_preferido: { label: 'Profissional de preferência', type: 'text', max: 150 }
};

// Dados do agendamento (guardados em events.patient_data) — só para eventos do tipo HORARIO_MARCADO
const PATIENT_FIELDS = {
    tipo_atendimento: { label: 'Tipo de atendimento', type: 'enum:tipo_atendimento' },
    procedimento: { label: 'Exame / procedimento', type: 'text', max: 150 },
    profissional: { label: 'Profissional', type: 'text', max: 150 },
    especialidade: { label: 'Especialidade', type: 'text', max: 100 },
    local: { label: 'Sala / unidade', type: 'text', max: 100 },
    duracao: { label: 'Duração (min)', type: 'int' },
    modalidade: { label: 'Modalidade', type: 'enum:modalidade' },
    pagamento: { label: 'Pagamento', type: 'enum:pagamento' },
    valor: { label: 'Valor', type: 'text', max: 30 },
    situacao: { label: 'Situação', type: 'enum:situacao' },
    cpf: { label: 'CPF do paciente', type: 'cpf' },
    nascimento: { label: 'Nascimento', type: 'date' },
    email: { label: 'E-mail do paciente', type: 'email' },
    convenio: { label: 'Convênio', type: 'text', max: 100 },
    carteirinha: { label: 'Nº da carteirinha', type: 'text', max: 60 },
    contact_id: { label: 'Contato vinculado', type: 'int' }
};

// ===================== 2.2 VALIDAÇÃO =====================
function norm(s) {
    return String(s == null ? '' : s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

function isValidCPF(value) {
    const d = String(value || '').replace(/\D/g, '');
    if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
    for (let t = 9; t < 11; t++) {
        let sum = 0;
        for (let i = 0; i < t; i++) sum += Number(d[i]) * (t + 1 - i);
        const dv = ((sum * 10) % 11) % 10;
        if (dv !== Number(d[t])) return false;
    }
    return true;
}
const formatCPF = d => String(d).replace(/\D/g, '').replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');

function normalizeDate(v) {
    const s = String(v).trim();
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    let y, mo, d;
    if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; }
    else if ((m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/))) { d = +m[1]; mo = +m[2]; y = +m[3]; }
    else return null;
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
    return `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function normalizeEnum(listName, v) {
    const n = norm(v).replace(/[\s\-]+/g, '_').toUpperCase();
    const list = ENUMS[listName];
    if (list.includes(n)) return n;
    // sinônimos comuns
    const alias = {
        FEMININA: 'FEMININO', MULHER: 'FEMININO', F: 'FEMININO', MASCULINA: 'MASCULINO', HOMEM: 'MASCULINO', M: 'MASCULINO',
        PSICOTERAPIA: 'TERAPIA', SESSAO: 'TERAPIA', PSICOLOGIA: 'TERAPIA', AVALIACAO_PSICOLOGICA: 'AVALIACAO',
        EXAMES: 'EXAME', CONSULTAS: 'CONSULTA', VOLTA: 'RETORNO', REMARCADA: 'REMARCADO', CANCELADA: 'CANCELADO',
        CONFIRMADA: 'CONFIRMADO', FALTA: 'FALTOU', FALTA_DO_PACIENTE: 'FALTOU', PRESENTE: 'COMPARECEU', ATENDIDO: 'COMPARECEU',
        REALIZADO: 'COMPARECEU', REALIZADA: 'COMPARECEU', REMOTO: 'ONLINE', VIRTUAL: 'ONLINE', TELECONSULTA: 'ONLINE',
        PLANO: 'CONVENIO', PLANO_DE_SAUDE: 'CONVENIO', PARTICULAR_: 'PARTICULAR', MARCADO: 'AGENDADO'
    };
    return alias[n] && list.includes(alias[n]) ? alias[n] : null;
}

/**
 * Valida e limpa um objeto de campos. `partial=true` = edição (ignora o que não veio).
 * Valor vazio ("") significa "apagar esse campo". Retorna { data, error }.
 */
function sanitize(input, schema) {
    const data = {};
    if (!input || typeof input !== 'object') return { data };
    for (const [key, def] of Object.entries(schema)) {
        if (!(key in input) || input[key] === undefined || input[key] === null) continue;
        let v = typeof input[key] === 'string' ? input[key].trim() : input[key];
        if (v === '') { data[key] = ''; continue; }
        const t = def.type;
        if (t === 'cpf') {
            if (!isValidCPF(v)) return { error: `${def.label} inválido. Confira os 11 números.` };
            v = formatCPF(v);
        } else if (t === 'email') {
            const e = String(v);
            if (!/^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/.test(e) || e.length > 254) return { error: `${def.label} inválido.` };
            v = e;
        } else if (t === 'date') {
            const d = normalizeDate(v);
            if (!d) return { error: `${def.label} inválida. Use dia/mês/ano (ex.: 25/10/1990).` };
            v = d;
        } else if (t === 'uf') {
            v = String(v).toUpperCase().slice(0, 2);
        } else if (t === 'int') {
            const n = parseInt(String(v).replace(/\D/g, ''), 10);
            if (!Number.isFinite(n) || n < 0 || n > 100000) return { error: `${def.label} inválido.` };
            v = n;
        } else if (t.startsWith('enum:')) {
            const e = normalizeEnum(t.slice(5), v);
            if (!e) return { error: `${def.label} inválido. Opções: ${ENUMS[t.slice(5)].join(', ')}.` };
            v = e;
        } else if (t === 'long') {
            v = String(v).slice(0, 2000);
        } else {
            v = String(v).slice(0, def.max || 200);
        }
        data[key] = v;
    }
    return { data };
}
const sanitizeClinic = i => sanitize(i, CLINIC_FIELDS);
const sanitizePatient = i => sanitize(i, PATIENT_FIELDS);

// junta o que já existe com o que mudou; "" apaga a chave
function mergeFields(current, changes) {
    const out = { ...(current || {}) };
    for (const [k, v] of Object.entries(changes || {})) {
        if (v === '' || v === null) delete out[k]; else out[k] = v;
    }
    return out;
}

// ===================== 2.3 CRIPTOGRAFIA (JSON) =====================
function pack(obj) {
    if (!obj || !Object.keys(obj).length) return null;
    return encryptData(JSON.stringify(obj));
}
function unpack(raw) {
    if (!raw) return {};
    try {
        const txt = decryptData(raw);
        const o = JSON.parse(txt);
        return o && typeof o === 'object' ? o : {};
    } catch (e) {
        return {};
    }
}

// Contato (linha do banco) -> objeto da API, com .clinic
function contactToApi(row) {
    const c = decryptContact(row);
    c.clinic = unpack(row.clinic_data);
    delete c.clinic_data;
    return c;
}
// Evento (linha do banco) -> objeto da API, com .patient
function eventToApi(row) {
    const e = { ...row };
    e.patient = unpack(row.patient_data);
    delete e.patient_data;
    return e;
}

// ===================== 2.4 BUSCAS (usadas pela Cláudia) =====================
async function findContacts(pool, companyId, term) {
    const q = norm(term);
    if (!q) return [];
    const digits = String(term).replace(/\D/g, '');
    const rows = (await pool.query('SELECT * FROM contacts WHERE company_id = $1', [companyId])).rows;
    const all = rows.map(contactToApi);
    const exact = all.filter(c => norm(c.name) === q);
    if (exact.length) return exact;
    return all.filter(c =>
        norm(c.name).includes(q) ||
        (digits.length >= 8 && (String(c.phone || '').replace(/\D/g, '').includes(digits) || String(c.clinic.cpf || '').replace(/\D/g, '') === digits)) ||
        (c.email && norm(c.email) === q)
    );
}
async function findEvents(pool, companyId, term, dateStr) {
    const q = norm(term);
    const rows = (await pool.query(
        `SELECT *, substr(event_date::text, 1, 10) AS event_date_str FROM events WHERE company_id = $1 ORDER BY event_date DESC`, [companyId]
    )).rows;
    let list = rows.map(eventToApi);
    if (dateStr) list = list.filter(e => e.event_date_str === dateStr);
    if (!q) return list;
    const exact = list.filter(e => norm(e.title) === q || norm(e.client_name) === q);
    if (exact.length) return exact;
    return list.filter(e => norm(e.title).includes(q) || norm(e.client_name).includes(q));
}
async function findNotes(pool, companyId, term) {
    const q = norm(term);
    const rows = (await pool.query('SELECT * FROM notes WHERE company_id = $1 ORDER BY updated_at DESC', [companyId])).rows;
    const all = rows.map(r => ({ ...r, title: decryptData(r.title), content: decryptData(r.content || '') }));
    if (!q) return all;
    const exact = all.filter(n => norm(n.title) === q);
    if (exact.length) return exact;
    return all.filter(n => norm(n.title).includes(q));
}

// ===================== 2.5 CLÁUDIA: INTERPRETADOR =====================
const RX_NOTA = /\banota(?:r|cao|coes)?\b|\banote\b|\bbloco de notas\b|\b(?:nova|criar|crie|salve|salvar|apague|apagar|exclua|excluir|delete|deletar|edite|editar|altere|mude|liste|listar|mostre)\s+(?:a\s+|as\s+|uma\s+|minha\s+|minhas\s+|essa\s+|esta\s+)?(?:nota|notas)\b/;
const RX_CLINICA = /\b(paciente|pacientes|consulta|consultas|exame|exames|terapia|psicolog\w*|clinica|prontuario|cpf|convenio|carteirinha|sessao|retorno|horario marcado|fisioterapia|dentista|agendamento|agendamentos)\b/;
const RX_GERENCIAR = /\b(edit\w*|alter\w*|mude|mudar|atualiz\w*|exclu\w*|apag\w*|remov\w*|delet\w*|cancel\w*|remarc\w*|remarqu\w*|desmarc\w*|desmarqu\w*)\b.*\b(contato|cliente|evento|agendamento|compromisso|reuniao|horario)\b/;
const RX_NAO_NOTA = /nota fiscal|notas fiscais|nota de|nota do|nota da|nota final|notas do|notas da/;
const RX_DEMANDA = /\b(demanda|demandas|tarefa|tarefas)\b/;

// A mensagem fala de anotações? (usado para barrar o recurso em planos sem direito a ele)
function pedidoDeAnotacao(mensagem) {
    const t = norm(mensagem);
    return !!t && RX_NOTA.test(t) && !RX_NAO_NOTA.test(t);
}

function parecePedidoDaClinica(mensagem) {
    const t = norm(mensagem);
    if (!t) return false;
    if (RX_NOTA.test(t) && !RX_NAO_NOTA.test(t)) return true;
    if (RX_DEMANDA.test(t)) return false; // demandas continuam no fluxo de sempre
    return RX_CLINICA.test(t) || RX_GERENCIAR.test(t);
}

const FUNCOES_PERMITIDAS = [
    'criarAnotacao', 'editarAnotacao', 'excluirAnotacao', 'listarAnotacoes',
    'criarContato', 'editarContato', 'excluirContato', 'buscarContato',
    'criarEvento', 'editarEvento', 'excluirEvento'
];

// Funções de anotação — exclusivas dos planos Starter e Pro IA
const FUNCOES_ANOTACAO = ['criarAnotacao', 'editarAnotacao', 'excluirAnotacao', 'listarAnotacoes'];
const AVISO_ANOTACOES_PLANO = 'As Anotações são exclusivas dos planos Starter e Pro AI. Faça upgrade na aba Planos & Assinatura para liberar esse recurso.';

function systemPrompt(hojeISO, nomeUsuario) {
    const clinicKeys = Object.keys(CLINIC_FIELDS).join(', ');
    const patientKeys = Object.keys(PATIENT_FIELDS).filter(k => k !== 'contact_id').join(', ');
    return `Você é a Cláudia, assistente do workspace KL Web. Hoje é ${hojeISO} (fuso de Brasília). Quem fala com você: ${nomeUsuario || 'usuário'}.
Sua tarefa agora: transformar o pedido do usuário em AÇÕES para ANOTAÇÕES, CONTATOS/PACIENTES e AGENDAMENTOS (calendário). Responda SOMENTE com JSON.

FORMATO DA RESPOSTA (escolha um):
1) {"acoes":[{"funcao":"<nome>","params":{...}}]}  -> quando há ação para executar (pode ter várias, em ordem).
2) {"resposta":"<texto curto em português>"} -> quando faltar uma informação OBRIGATÓRIA (pergunte só o que falta) ou for uma dúvida sobre esses recursos.
3) {"fora_do_escopo":true} -> quando o pedido NÃO for sobre anotações, contatos/pacientes ou agendamentos (ex.: demandas, tarefas, tema, senha, equipe, automações).

FUNÇÕES e PARÂMETROS (todos os valores são texto; datas em AAAA-MM-DD; hora em HH:MM, 24h):
- criarAnotacao: titulo (obrigatório), conteudo
- editarAnotacao: titulo (anotação existente, obrigatório), novoTitulo, conteudo (substitui todo o texto), acrescentar (texto a adicionar no fim)
- excluirAnotacao: titulo (obrigatório)
- listarAnotacoes: busca (opcional)
- criarContato: name e phone (obrigatórios), email, companyName, role, notes, mais campos de paciente: ${clinicKeys}
- editarContato: busca (nome, CPF ou telefone do contato existente, obrigatório) + só os campos que mudam: name, phone, email, companyName, role, notes, ${clinicKeys}
- excluirContato: busca (obrigatório)
- buscarContato: busca (obrigatório) -> mostra os dados do contato/paciente
- criarEvento: title, eventDate (obrigatórios), eventTime, description, type (REUNIAO, PRAZO, LEMBRETE, ATENDIMENTO ou HORARIO_MARCADO). Para marcar consulta/exame/terapia/sessão de um cliente ou paciente use type=HORARIO_MARCADO e informe clientName (obrigatório), clientPhone e, se o usuário disser, os campos: ${patientKeys}
- editarEvento: busca (título ou nome do cliente do evento existente, obrigatório), dataAtual (se houver mais de um com o mesmo nome), + só o que muda: title, eventDate, eventTime, description, clientName, clientPhone, ${patientKeys}
- excluirEvento: busca (obrigatório), dataAtual (opcional)

VALORES ACEITOS: sexo=${ENUMS.sexo.join('|')}; tipo_atendimento=${ENUMS.tipo_atendimento.join('|')}; modalidade=${ENUMS.modalidade.join('|')}; pagamento=${ENUMS.pagamento.join('|')}; situacao=${ENUMS.situacao.join('|')}. nascimento e datas de paciente também em AAAA-MM-DD.

REGRAS:
- Resolva datas relativas (amanhã, segunda que vem, dia 25) a partir de hoje (${hojeISO}). Se não houver hora, use 09:00.
- Em "title" de consulta/exame/terapia use algo curto, ex.: "Consulta - Maria Silva". Nunca invente CPF, telefone, e-mail ou datas: se o usuário não disse, NÃO inclua o parâmetro.
- Excluir só se o usuário pediu claramente para apagar/remover/cancelar. Nunca exclua por inferência.
- "Remarcar" = editarEvento com a nova eventDate/eventTime. "Cancelar consulta" = editarEvento com situacao=CANCELADO (a menos que peça para apagar/excluir).
- Não use aspas duplas dentro dos valores.
- Sem texto fora do JSON.`;
}

function hojeBrasilia() {
    try { return new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' }); }
    catch (e) { return new Date().toISOString().slice(0, 10); }
}

function paramsToRaw(params) {
    return Object.entries(params || {})
        .filter(([k, v]) => /^\w+$/.test(k) && v !== undefined && v !== null && String(v).trim() !== '')
        .map(([k, v]) => `${k}="${String(v).replace(/"/g, "'")}"`)
        .join(', ');
}

/**
 * Tenta resolver a mensagem como pedido de anotação/contato/agendamento.
 * contexto: { nomeUsuario, planTier, planStatus, isOwner } — planTier/planStatus vêm do usuário
 * logado; sem eles o recurso de anotações é tratado como indisponível (falha segura).
 * Retorna:
 *   { tipo:'ACAO_REQUERIDA', acoes:[{funcao, parametros:{raw}}] }
 *   { tipo:'RESPOSTA_TEXTO', texto }
 *   null  -> não é com este módulo; o agente padrão (ai.js) assume.
 */
async function interpretar(mensagem, contexto = {}) {
    if (!parecePedidoDaClinica(mensagem)) return null;
    if (!process.env.GROQ_API_KEY) return null;

    // Anotações: só Starter e Pro IA (o dono da plataforma tem acesso sempre).
    const anotacoesLiberadas = !!contexto.isOwner || canUseNotes(contexto.planTier, contexto.planStatus || 'ACTIVE');
    if (!anotacoesLiberadas && pedidoDeAnotacao(mensagem)) {
        return { tipo: 'RESPOSTA_TEXTO', texto: AVISO_ANOTACOES_PLANO };
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25000);
    try {
        const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            signal: ctrl.signal,
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
            body: JSON.stringify({
                model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
                temperature: 0,
                max_tokens: 900,
                response_format: { type: 'json_object' },
                messages: [
                    { role: 'system', content: systemPrompt(hojeBrasilia(), contexto.nomeUsuario) },
                    { role: 'user', content: String(mensagem).slice(0, 3000) }
                ]
            })
        });
        if (!resp.ok) { console.error('[ai/clinica] Groq HTTP', resp.status); return null; }
        const json = await resp.json();
        const out = JSON.parse(json.choices?.[0]?.message?.content || '{}');

        if (out.fora_do_escopo) return null;
        if (Array.isArray(out.acoes) && out.acoes.length) {
            const acoes = out.acoes
                .filter(a => a && FUNCOES_PERMITIDAS.includes(a.funcao))
                // segunda barreira: mesmo que o modelo devolva uma ação de anotação, ela só passa se o plano permitir
                .filter(a => anotacoesLiberadas || !FUNCOES_ANOTACAO.includes(a.funcao))
                .slice(0, 5)
                .map(a => ({ funcao: a.funcao, parametros: { raw: paramsToRaw(a.params) } }));
            if (acoes.length) return { tipo: 'ACAO_REQUERIDA', acoes };
            // todas as ações eram de anotação e o plano não permite
            return { tipo: 'RESPOSTA_TEXTO', texto: AVISO_ANOTACOES_PLANO };
        }
        if (typeof out.resposta === 'string' && out.resposta.trim()) {
            return { tipo: 'RESPOSTA_TEXTO', texto: out.resposta.trim() };
        }
        return null;
    } catch (e) {
        console.error('[ai/clinica] falha ao interpretar:', e.message);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

// ===================== 2.6 CLÁUDIA: ERP =====================
// Mesmo desenho das anotações: filtro por palavras (barato) -> plano/cargo ANTES de chamar o modelo ->
// modelo devolve JSON -> lista de funções permitidas -> segunda barreira por plano/cargo.
// Quem executa é o server.js (executeAiAction), que também confere plano e cargo. Excluir/cancelar NÃO existe por aqui.
//
//   Plano     | ERP pela Cláudia | Financeiro (contas a pagar/receber)
//   ----------|------------------|-------------------------------------
//   BASICO    | não              | não
//   STARTER   | sim              | só Dono/Admin/Gerente
//   PRO_IA    | sim              | só Dono/Admin/Gerente
//   OWNER     | sim              | sim
//   Nota fiscal (Focus NFe): só PRO_IA/OWNER + cargo de administrador (canUseErpFiscal).
//
// "cliente" sozinho continua sendo CONTATO (CRM). Vai para o ERP quando a frase tem vocabulário de ERP
// (fornecedor, produto, estoque, conta a pagar/receber, "no ERP"...).
const ERP_ADMIN_ROLES = ['OWNER', 'ADMIN', 'MANAGER'];
const AVISO_ERP_PLANO = 'O ERP é exclusivo dos planos Starter e Pro AI. Faça upgrade na aba Planos & Assinatura para liberar esse recurso.';
const AVISO_ERP_CARGO = 'O Financeiro do ERP só pode ser usado por Dono, Admin ou Gerente da empresa.';
const AVISO_FISCAL_PLANO = 'A emissão de notas fiscais (Focus NFe) é exclusiva do plano Pro AI. Faça upgrade na aba Planos & Assinatura para liberar esse recurso.';
const AVISO_FISCAL_CARGO = 'A emissão de notas fiscais só pode ser feita por Dono, Admin ou Gerente da empresa.';

const RX_ERP_GERAL = /\b(erp|fornecedor|fornecedores|estoque|sku|produto|produtos|servico cadastrado|pedido de venda|pedido de compra|pedidos de venda|pedidos de compra|mercadoria|mercadorias|inventario)\b/;
const RX_ERP_FINANCEIRO = /\b(conta a pagar|contas a pagar|conta a receber|contas a receber|a pagar|a receber|fluxo de caixa|financeiro|inadimplencia|inadimplente|dar baixa|da baixa|baixar a conta|baixar conta|despesa|despesas|receita|receitas|lance uma conta|lancar conta|lance conta|paguei|recebi|resumo financeiro|contas vencidas|conta vencida)\b/;
const RX_ERP_FISCAL = /\b(nota fiscal|notas fiscais|nfse|nfs-e|nf-e|nfe|nota de servico|notas de servico|(?:emitir|emita|emite|gerar|gere|gera|faca|fazer)\s+(?:a\s+|uma\s+|essa\s+|esta\s+)?nota)\b/;
const RX_CLINICA_FORTE = /\b(paciente|pacientes|consulta|consultas|exame|exames|terapia|psicolog\w*|clinica|prontuario|agendamento|agendamentos|fisioterapia|dentista)\b/;

function parecePedidoErp(mensagem) {
    const t = norm(mensagem);
    if (!t) return false;
    if (RX_DEMANDA.test(t)) return false; // demandas continuam no fluxo de sempre
    if (RX_ERP_FISCAL.test(t)) return true; // "nota fiscal" é do ERP (antes do filtro de anotações)
    if (RX_NOTA.test(t) && !RX_NAO_NOTA.test(t)) return false; // anotações têm fluxo próprio
    if (RX_CLINICA_FORTE.test(t) && !/\berp\b/.test(t)) return false;
    return RX_ERP_GERAL.test(t) || RX_ERP_FINANCEIRO.test(t);
}

function pedidoFinanceiro(mensagem) {
    return RX_ERP_FINANCEIRO.test(norm(mensagem));
}

function pedidoFiscal(mensagem) {
    return RX_ERP_FISCAL.test(norm(mensagem));
}

const ERP_FUNCOES_BASE = ['erpCriarCadastro', 'erpBuscarCadastro', 'erpCriarProduto', 'erpMovimentarEstoque', 'erpConsultarEstoque'];
const ERP_FUNCOES_FINANCEIRO = ['erpLancarConta', 'erpBaixarConta', 'erpListarContas', 'erpResumoFinanceiro'];
const ERP_FUNCOES_FISCAL = ['erpEmitirNota', 'erpConsultarNota', 'erpEmitirNfe'];

function systemPromptErp(hojeISO, nomeUsuario, financeiroLiberado, fiscalLiberado) {
    const financeiro = financeiroLiberado ? `
- erpLancarConta: tipo (pagar|receber), descricao, valor (obrigatórios), vencimento (se não disser, use hoje), parcelas (padrão 1), categoria, parceiro (nome de cliente/fornecedor JÁ cadastrado), forma, pago (sim|nao; use sim se o usuário disse que já pagou/recebeu)
- erpBaixarConta: busca (parte da descrição ou nome do cliente/fornecedor, obrigatório), vencimento (só se houver mais de um com o mesmo nome), valorPago, dataPagamento, forma -> marca uma conta ABERTA como paga/recebida
- erpListarContas: tipo (pagar|receber), situacao (aberto|vencido|pago), de, ate (datas)
- erpResumoFinanceiro: sem parâmetros -> totais a receber, a pagar, vencidos e saldo previsto` : '';
    const fiscal = fiscalLiberado ? `
- erpEmitirNota: pedido (número do pedido de venda JÁ confirmado) OU cliente (nome) + descricao + valor; documento (CPF/CNPJ do cliente, se o usuário disse) -> emite NFS-e (nota de SERVIÇO) pela Focus NFe
- erpEmitirNfe: pedido (número do pedido de venda JÁ confirmado, obrigatório) -> emite NF-e (nota de PRODUTO/mercadoria) pela Focus NFe; usa os produtos do pedido e o endereço do cliente já cadastrados
- erpConsultarNota: pedido (número do pedido; vazio = a última nota emitida) -> mostra se a nota (serviço ou produto) foi autorizada, o número e o link` : '';
    const semFiscal = fiscalLiberado ? '' : '\n- Pedidos de nota fiscal: responda com {"resposta":"A emissão de notas fiscais é exclusiva do plano Pro AI e de administradores da empresa."}';
    const semFinanceiro = financeiroLiberado ? '' : '\n- Pedidos de contas a pagar/receber, baixa ou resumo financeiro: responda com {"resposta":"O Financeiro do ERP só pode ser usado por Dono, Admin ou Gerente da empresa."}';
    return `Você é a Cláudia, assistente do workspace KL Web. Hoje é ${hojeISO} (fuso de Brasília). Quem fala com você: ${nomeUsuario || 'usuário'}.
Sua tarefa agora: transformar o pedido do usuário em AÇÕES do módulo ERP (cadastros, produtos/estoque e financeiro). Responda SOMENTE com JSON.

FORMATO DA RESPOSTA (escolha um):
1) {"acoes":[{"funcao":"<nome>","params":{...}}]}  -> quando há ação para executar (pode ter várias, em ordem).
2) {"resposta":"<texto curto em português>"} -> quando faltar uma informação OBRIGATÓRIA (pergunte só o que falta) ou for uma dúvida sobre o ERP.
3) {"fora_do_escopo":true} -> quando o pedido NÃO for sobre ERP (ex.: demandas, tarefas, anotações, contatos/pacientes, agenda, tema, senha, equipe, automações).

FUNÇÕES e PARÂMETROS (todos os valores são texto; datas em AAAA-MM-DD; números sem símbolo, ex.: 1500.50):
- erpCriarCadastro: nome (obrigatório), tipo (cliente|fornecedor|ambos; padrão cliente), telefone, email, documento (CPF/CNPJ), endereco (texto livre), observacoes; endereço estruturado (só o que o usuário disser): cep, logradouro, numero, complemento, bairro, cidade, uf (sigla com 2 letras), codigoMunicipio (código IBGE de 7 dígitos, só se o usuário disser; com o CEP o sistema completa o resto)
- erpBuscarCadastro: busca (nome ou CPF/CNPJ, obrigatório)
- erpCriarProduto: nome (obrigatório), precoVenda, precoCusto, unidade (un, kg, cx, l...), sku, categoria, servico (sim|nao), estoqueInicial, estoqueMinimo; dados fiscais (só se o usuário disser): ncm (8 dígitos), cest (7 dígitos), cfop (4 dígitos), origem (0 a 8), icmsSituacao (CSOSN ou CST do ICMS), icmsAliquota
- erpMovimentarEstoque: produto (nome ou SKU, obrigatório), tipo (entrada|saida|ajuste), quantidade (obrigatório), motivo. "ajuste" = contagem de inventário: define o saldo para a quantidade informada
- erpConsultarEstoque: busca (nome do produto; vazio = produtos abaixo do estoque mínimo)${financeiro}${fiscal}

REGRAS:
- Resolva datas relativas (amanhã, dia 10, mês que vem) a partir de hoje (${hojeISO}).
- Nunca invente valores, telefones, documentos ou datas: se o usuário não disse, NÃO inclua o parâmetro. Se faltar um dado obrigatório, use {"resposta":"..."} perguntando só o que falta.
- Você NÃO exclui, cancela nem estorna nada no ERP. Se pedirem isso, responda com {"resposta":"Por segurança, excluir, cancelar ou estornar é feito direto na aba ERP."}
- Pedidos de venda/compra com itens ainda não são feitos por aqui: responda com {"resposta":"Os pedidos de venda e compra são criados na aba ERP. Posso cadastrar clientes, produtos, mexer no estoque${financeiroLiberado ? ' e lançar contas' : ''} por aqui."}
- Nunca invente CPF/CNPJ, NCM, CFOP, endereço, valores ou números de pedido. Nota de SERVIÇO usa erpEmitirNota; nota de PRODUTO/mercadoria (NF-e) usa erpEmitirNfe. Se o usuário pedir só "nota fiscal" e não der para saber se é de serviço ou de produto, pergunte com {"resposta":"A nota é de serviço (NFS-e) ou de produto (NF-e)?"}
- "Cliente" sem contexto de ERP é um contato do CRM: nesse caso responda {"fora_do_escopo":true}.${semFinanceiro}${semFiscal}
- Não use aspas duplas dentro dos valores. Sem texto fora do JSON.`;
}

/**
 * Tenta resolver a mensagem como pedido do ERP.
 * contexto: { nomeUsuario, planTier, planStatus, role, isOwner } (vêm do usuário logado; sem plano = recurso indisponível).
 * Retorna { tipo:'ACAO_REQUERIDA', acoes:[...] } | { tipo:'RESPOSTA_TEXTO', texto } | null (não é com este módulo).
 */
async function interpretarErp(mensagem, contexto = {}) {
    if (!parecePedidoErp(mensagem)) return null;

    // Plano: barrado ANTES de gastar uma chamada ao modelo.
    const erpLiberado = !!contexto.isOwner || canUseErp(contexto.planTier, contexto.planStatus || 'ACTIVE');
    if (!erpLiberado) return { tipo: 'RESPOSTA_TEXTO', texto: AVISO_ERP_PLANO };

    // Cargo: Financeiro só para administradores.
    const financeiroLiberado = !!contexto.isOwner || ERP_ADMIN_ROLES.includes(contexto.role);
    // Nota fiscal: plano Pro AI + cargo de administrador (barrado antes do modelo, nessa ordem).
    const fiscalPlano = !!contexto.isOwner || canUseErpFiscal(contexto.planTier, contexto.planStatus || 'ACTIVE');
    if (pedidoFiscal(mensagem)) {
        if (!fiscalPlano) return { tipo: 'RESPOSTA_TEXTO', texto: AVISO_FISCAL_PLANO };
        if (!financeiroLiberado) return { tipo: 'RESPOSTA_TEXTO', texto: AVISO_FISCAL_CARGO };
    }
    const fiscalLiberado = fiscalPlano && financeiroLiberado;

    if (!financeiroLiberado && pedidoFinanceiro(mensagem)) {
        return { tipo: 'RESPOSTA_TEXTO', texto: AVISO_ERP_CARGO };
    }

    if (!process.env.GROQ_API_KEY) return null;

    const permitidas = ERP_FUNCOES_BASE
        .concat(financeiroLiberado ? ERP_FUNCOES_FINANCEIRO : [])
        .concat(fiscalLiberado ? ERP_FUNCOES_FISCAL : []);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25000);
    try {
        const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            signal: ctrl.signal,
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
            body: JSON.stringify({
                model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
                temperature: 0,
                max_tokens: 900,
                response_format: { type: 'json_object' },
                messages: [
                    { role: 'system', content: systemPromptErp(hojeBrasilia(), contexto.nomeUsuario, financeiroLiberado, fiscalLiberado) },
                    { role: 'user', content: String(mensagem).slice(0, 3000) }
                ]
            })
        });
        if (!resp.ok) { console.error('[ai/erp] Groq HTTP', resp.status); return null; }
        const json = await resp.json();
        const out = JSON.parse(json.choices?.[0]?.message?.content || '{}');

        if (out.fora_do_escopo) return null;
        if (Array.isArray(out.acoes) && out.acoes.length) {
            const acoes = out.acoes
                .filter(a => a && permitidas.includes(a.funcao)) // segunda barreira: plano/cargo + lista fechada
                .slice(0, 5)
                .map(a => ({ funcao: a.funcao, parametros: { raw: paramsToRaw(a.params) } }));
            if (acoes.length) return { tipo: 'ACAO_REQUERIDA', acoes };
            return { tipo: 'RESPOSTA_TEXTO', texto: financeiroLiberado ? 'Não consegui montar essa ação no ERP. Pode reformular?' : AVISO_ERP_CARGO };
        }
        if (typeof out.resposta === 'string' && out.resposta.trim()) {
            return { tipo: 'RESPOSTA_TEXTO', texto: out.resposta.trim() };
        }
        return null;
    } catch (e) {
        console.error('[ai/erp] falha ao interpretar:', e.message);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

module.exports = {
    // Parte 1 — agente geral
    processarAgenteKLWeb, gerarAutomacaoComIA,
    // Parte 2 — clínica (antes em clinicAi.js)
    ENUMS, CLINIC_FIELDS, PATIENT_FIELDS,
    norm, isValidCPF, formatCPF, normalizeDate,
    sanitizeClinic, sanitizePatient, mergeFields,
    pack, unpack, contactToApi, eventToApi,
    findContacts, findEvents, findNotes,
    parecePedidoDaClinica, pedidoDeAnotacao, interpretar, FUNCOES_PERMITIDAS, FUNCOES_ANOTACAO,
    // Parte 3 — ERP
    parecePedidoErp, pedidoFinanceiro, pedidoFiscal, interpretarErp, ERP_FUNCOES_BASE, ERP_FUNCOES_FINANCEIRO, ERP_FUNCOES_FISCAL
};