import sys
import json
import re

def process_ai_request():
    try:
        # Garante a codificação UTF-8 na saída do terminal
        if hasattr(sys.stdout, 'reconfigure'):
            sys.stdout.reconfigure(encoding='utf-8')

        # Lê os dados enviados via stdio/spawn do Node.js
        raw_input = sys.argv[1] if len(sys.argv) > 1 else "{}"
        input_data = json.loads(raw_input)
        
        user_text = input_data.get("text", "").strip()

        # 1. Valida se a mensagem do usuário possui conteúdo utilizável
        if not user_text or len(user_text) < 4:
            output = {
                "status": "INCOMPLETE",
                "message": "Por favor, especifique o título ou os detalhes da demanda (ex: 'Criar reunião urgente com o cliente')."
            }
            print(json.dumps(output, ensure_ascii=False))
            return

        # 2. Análise autônoma de palavras-chave para definir a prioridade
        text_lower = user_text.lower()
        priority = "MEDIA"
        
        if any(w in text_lower for w in ["urgente", "urgência", "hoje", "imediatamente", "crítico"]):
            priority = "URGENTE"
        elif any(w in text_lower for w in ["alta", "importante", "prioritário"]):
            priority = "ALTA"
        elif any(w in text_lower for w in ["baixa", "quando der", "tranquilo", "sem pressa"]):
            priority = "BAIXA"

        # 3. Limpeza do texto para gerar um título enxuto
        clean_title = re.sub(r'(?i)\b(cria|criar|adicione|adicionar|nova|demanda|tarefa|urgente|alta|baixa|para)\b', '', user_text).strip()
        title = clean_title.capitalize() if clean_title else user_text.capitalize()

        if len(title) > 60:
            title = title[:57] + "..."

        # 4. Retorno JSON pronto para inserção no Kanban
        output = {
            "status": "READY_TO_CREATE",
            "message": f"Entendido! Criei a demanda '{title}' com prioridade {priority}.",
            "demand": {
                "title": title,
                "description": user_text,
                "priority": priority,
                "status": "TODO"
            }
        }

        print(json.dumps(output, ensure_ascii=False))

    except Exception as e:
        error_response = {
            "status": "error",
            "message": f"Erro interno de processamento na IA: {str(e)}"
        }
        print(json.dumps(error_response, ensure_ascii=False))

if __name__ == "__main__":
    process_ai_request()