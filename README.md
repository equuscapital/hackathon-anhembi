# Site Selector — Mapa de Melhores Regiões para Abertura de Empresas

Aplicativo web que ajuda empreendedores a descobrir as melhores regiões para abrir um novo estabelecimento, com base em dados públicos da Receita Federal (CNPJs ativos, abertos e fechados nos últimos 24 meses), filtrados por CNAE.

**MVP: cidade de São Paulo** — arquitetura parametrizada para extensão ao Brasil todo.

## Como Rodar

### Pré-requisitos

- Python 3.10+
- Arquivo Parquet com dados de estabelecimentos (ver seção "Dados")

### Instalação

```bash
pip install fastapi uvicorn duckdb
```

### Executar

```bash
# Colocar o parquet em data/estabelecimentos_sp.parquet
python server.py
# Acesse http://localhost:8080
```

Opções do servidor:

```bash
python server.py --port 3000                              # porta customizada
python server.py --parquet data/outra_cidade.parquet       # parquet de outra cidade
```

### Testes do Modelo de Forças

Abra `http://localhost:8080/tests/test_forcas.html` no navegador. Os 5 testes sintéticos validam o modelo de forças vetorial com fixtures conhecidos.

## Arquitetura

```
index.html          App principal (UI + Leaflet + camadas)
worker.js           Web Worker — cálculo de forças vetoriais nos pontos candidatos
server.py           Backend FastAPI + DuckDB (consulta Parquet)
cnaes.json          Tabela oficial de CNAEs (1.332 subclasses, IBGE/CONCLA)
data/
  estabelecimentos_sp.parquet         Parquet completo (não versionado)
  estabelecimentos_sp_sample.parquet  Amostra de 1.000 registros (para testes)
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

- **Mapa**: Leaflet com tiles do OpenStreetMap
- **Heatmaps**: leaflet.heat para as 3 camadas (abertas, fechadas, oportunidade)
- **Web Worker**: cálculo de forças nos pontos candidatos em thread separada, sem travar a UI
- **Progresso**: barra de progresso durante o cálculo

### Mapeamento CNAE

1. **Com API Anthropic (Claude)**: se o usuário fornecer API key (sessionStorage), a descrição é enviada ao Claude com a tabela CNAE como contexto
2. **Fallback local**: busca fuzzy com mapa de sinônimos (ex: "cafeteria" → "lanchonete")

## Modelo de Forças (Núcleo)

Para cada ponto candidato `P = (lat, lon)` correspondente a um endereço real de estabelecimento existente no parquet (sem filtro de CNAE):

### Contribuições vetoriais

Cada estabelecimento `S_i` na vizinhança (dentro do raio de corte) gera um vetor `F_i` no sentido `S_i → P` (afastando o candidato da loja):

| Categoria | Magnitude | Lógica |
|---|---|---|
| **Ativa** (qualquer idade) | `f(idade_anos) / d_km²` | Concorrência existente repele |
| **Aberta últimos 24m** (e ativa) | `meses_desde_abertura / d_km²` | Competição emergente repele |
| **Fechada últimos 24m** | `meses_desde_fechamento / d_km²` | Região hostil repele |

Onde:
- `d_km = max(haversine(P, S_i), d_min)` — distância em km com piso de 50m
- `f(idade) = idade` ou `log(1 + idade)` (configurável, para não deixar lojas centenárias dominarem)

### Score do ponto

- **Força resultante**: `F = Σ F_i` (soma vetorial de todas as contribuições)
- **Score**: `1 / (|F| + ε)` — pontos com **menor |F|** são melhores
- **Normalização**: clipping no quantil 95 para evitar outliers

### Interpretação

- `|F| ≈ 0`: equilíbrio — poucas lojas dispersas simetricamente, sem concentração em nenhuma direção
- `|F| alto`: desequilíbrio — concentração de concorrentes de um lado

### Parâmetros configuráveis

| Parâmetro | Default | Descrição |
|---|---|---|
| Raio de corte | 3 km | Distância máxima para considerar vizinhos |
| Distância mínima | 50m | Piso para evitar singularidade |
| Peso Ativas | 1.0 | Multiplicador da contribuição de lojas ativas |
| Peso Abertas 24m | 1.0 | Multiplicador de aberturas recentes |
| Peso Fechadas 24m | 1.0 | Multiplicador de fechamentos recentes |
| log(1+idade) | Desativado | Transforma idade para suavizar lojas antigas |

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

### CNAEs (`cnaes.json`)

1.332 subclasses da CNAE 2.0, obtidas da API oficial do IBGE/CONCLA.
Formato: `[{"codigo": "5611203", "descricao": "LANCHONETES, CASAS DE CHÁ..."}]`

## Limitações do MVP

- Single-user (sem autenticação)
- Dados estáticos (Parquet offline, não atualiza em tempo real)
- Reverse geocoding via Nominatim (rate limited, 1 req/s)
- ~222k pontos candidatos (todos os lat/lon únicos do parquet) — cálculo leva ~2-3 min

## Stack

- **Frontend**: HTML + Vanilla JS + Leaflet + Leaflet.heat
- **Backend**: Python + FastAPI + DuckDB + Uvicorn
- **Dados**: Parquet (Receita Federal) + JSON (CONCLA/IBGE)
- **Worker**: Web Worker para cálculo de forças sem travar UI
