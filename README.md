# Nearby — O bairro em tempo real

Inteligência de mercado em linguagem de gente. Mostra onde abrir, expandir ou evitar com base em dados reais de abertura e fechamento de empresas no seu bairro.

**MVP: cidade de São Paulo** — arquitetura parametrizada para extensão ao Brasil todo.

## Como Rodar

### Pré-requisitos

- Python 3.10+
- Arquivo Parquet de estabelecimentos (ver seção "Dados")
- Arquivo Parquet de descrições CNAE (`data/descricao_cnae.parquet`)

### Instalação

```bash
pip install fastapi uvicorn duckdb
```

### Executar

```bash
# Colocar os parquets em data/
python server.py
# Acesse http://localhost:8080
```

Opções do servidor:

```bash
python server.py --port 3000                              # porta customizada
python server.py --parquet data/outra_cidade.parquet       # parquet de outra cidade
python server.py --cnae-parquet data/descricao_cnae.parquet  # parquet de CNAEs
```

### Testes do Modelo de Forças

Abra `http://localhost:8080/tests/test_forcas.html` no navegador. Os 5 testes sintéticos validam o modelo de forças vetorial com fixtures conhecidos.

## Arquitetura

```
index.html          App principal (UI Nearby + Leaflet + camadas)
worker.js           Web Worker — cálculo de forças vetoriais nos pontos candidatos
server.py           Backend FastAPI + DuckDB (consulta Parquet)
cnaes.json          Tabela legada de CNAEs (1.332 subclasses, IBGE/CONCLA)
data/
  estabelecimentos_sp.parquet         Parquet completo (não versionado)
  estabelecimentos_sp_sample.parquet  Amostra de 1.000 registros (para testes)
  descricao_cnae.parquet              Descrições oficiais de CNAEs
tests/
  test_forcas.html  Testes do modelo de forças com fixtures sintéticos
  fixtures.json     Casos de teste com cálculos manuais documentados
```

### Backend: FastAPI + DuckDB

**Escolha**: DuckDB consulta o Parquet diretamente via SQL pushdown, sem carregar em memória.

**Prós**:
- Zero ETL: DuckDB lê Parquet nativamente com performance excelente
- Baixo consumo de memória: scan colunar com filtros pushdown
- Setup simples: `pip install` + `python server.py`
- Filtragem por CNAE responde em <1s para CNAEs com até 50k estabelecimentos

**Contras**:
- Parquet precisa estar no disco local (não suporta S3 sem config extra)
- DuckDB é single-process (suficiente para MVP single-user)

**Como trocar a fonte de dados**: Basta apontar `--parquet` para outro arquivo. O backend aceita qualquer Parquet com o mesmo schema (campos `cnae_fiscal_principal`, `situacao_cadastral`, `latitude`, `longitude`, etc).

### Frontend: Vanilla JS + Leaflet

- **Mapa**: Leaflet com tiles CARTO (light)
- **Heatmaps**: leaflet.heat para as 3 camadas (abertas, fechadas, oportunidade)
- **Web Worker**: cálculo de forças nos pontos candidatos reais em thread separada
- **Progresso**: barra de progresso durante o cálculo
- **Design**: Brand "Nearby" — Plus Jakarta Sans + JetBrains Mono, paleta verde/coral, Lucide Icons

### Mapeamento CNAE

1. **Com API Anthropic (Claude)**: se o usuário fornecer API key (sessionStorage), a descrição é enviada ao Claude com a tabela CNAE como contexto
2. **Fallback local**: busca fuzzy com mapa de sinônimos (ex: "cafeteria" → "lanchonete")
3. **Base de dados**: `descricao_cnae.parquet` com descrições completas e reduzidas

## Modelo de Forças (Núcleo)

Para cada ponto candidato `P = (lat, lon)` correspondente a um endereço real de estabelecimento existente no parquet (sem filtro de CNAE):

### Filtro de densidade

Apenas pontos com **≥5 estabelecimentos** (do parquet completo) num **raio de 500m** são considerados candidatos válidos. Isso evita sugerir pontos rurais ou de borda.

### Contribuições vetoriais

Cada estabelecimento `S_i` na vizinhança (dentro do raio de corte) gera um vetor `F_i` no sentido `S_i → P`:

| Categoria | Magnitude | Lógica |
|---|---|---|
| **Ativa** (qualquer idade) | `idade_anos / d_km²` | Concorrência existente repele |
| **Aberta últimos 24m** (e ativa) | `meses_desde_abertura / d_km²` | Competição emergente repele |
| **Fechada últimos 24m** | `meses_desde_fechamento / d_km²` | Região hostil repele |

Onde `d_km = max(haversine(P, S_i), 0.01)` — distância em km com piso de 10m.

### Score do ponto

- **Força resultante**: `F = Σ F_i` (soma vetorial de todas as contribuições)
- **Score**: `1 / (|F| + ε)` — pontos com **menor |F|** são melhores
- **Normalização**: clipping no quantil 95 para evitar outliers

### Interpretação

- `|F| ≈ 0`: equilíbrio — poucas lojas dispersas simetricamente
- `|F| alto`: desequilíbrio — concentração de concorrentes de um lado

### Parâmetros configuráveis

| Parâmetro | Default | Descrição |
|---|---|---|
| Raio de corte | 3 km | Distância máxima para considerar vizinhos |
| Peso Ativas | 1.0 | Multiplicador da contribuição de lojas ativas |
| Peso Abertas 24m | 1.0 | Multiplicador de aberturas recentes |
| Peso Fechadas 24m | 1.0 | Multiplicador de fechamentos recentes |

## Extensibilidade: Trocar para Outra Cidade

1. **Obter o Parquet** da cidade desejada (mesmo schema da Receita Federal)
2. **Ajustar o bounding box**: no `server.py`, atualizar `SP_BOUNDS` com as coordenadas da cidade, ou passar via query params `lat_min`, `lat_max`, `lon_min`, `lon_max`
3. **Executar**: `python server.py --parquet data/estabelecimentos_rj.parquet`

A arquitetura não hardcoda São Paulo — cidade/UF são parâmetros.

## Dados

### Parquet principal (`estabelecimentos_sp.parquet`)

| Campo | Tipo | Uso |
|---|---|---|
| `cnae_fiscal_principal` | string (7 dígitos) | Filtro principal |
| `situacao_cadastral` | string ('02' = ativa) | Classificação ativa/inativa |
| `data_inicio_atividade` | string YYYYMMDD | Idade, filtro "abertos 24m" |
| `data_sit_cadastral` | string YYYYMMDD | Data do fechamento |
| `latitude`, `longitude` | float | Posição geográfica |
| `nome_fantasia`, `razao_social`, `bairro` | string | Tooltip |

### CNAEs (`descricao_cnae.parquet`)

1.359 subclasses da CNAE com descrição completa e reduzida.
Campos: `cnae_fiscal_principal`, `descricao_cnae_principal`, `descricao_cnae_principal_reduzido`.

## Limitações do MVP

- Single-user (sem autenticação)
- Dados estáticos (Parquet offline, não atualiza em tempo real)
- Reverse geocoding via Nominatim (rate limited, 1 req/s)
- ~222k pontos candidatos — cálculo leva ~2-3 min
- Light mode apenas (sem dark mode no MVP)

## Stack

- **Frontend**: HTML + Vanilla JS + Leaflet + Leaflet.heat + Lucide Icons
- **Backend**: Python + FastAPI + DuckDB + Uvicorn
- **Dados**: Parquet (Receita Federal + CNAE)
- **Worker**: Web Worker para cálculo de forças sem travar UI
- **Design**: Plus Jakarta Sans + JetBrains Mono, paleta Nearby
