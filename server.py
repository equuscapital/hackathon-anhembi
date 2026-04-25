"""
Site Selector — Backend FastAPI + DuckDB

Serve dados de estabelecimentos filtrados por CNAE a partir de arquivo Parquet.
DuckDB consulta o Parquet diretamente sem carregar em memória.

Uso:
    python server.py                          # porta 8080, parquet padrão
    python server.py --port 3000              # porta customizada
    python server.py --parquet outro.parquet   # parquet customizado

Arquitetura:
    - DuckDB lê o Parquet via SQL pushdown (filtros são empurrados para leitura)
    - Endpoint /api/establishments?cnae=XXXXXXX retorna JSON com dados categorizados
    - Arquivos estáticos (index.html, worker.js, etc.) servidos pela mesma porta
    - Extensível: trocar o parquet por outra cidade basta mudar --parquet

Prós:
    - Zero ETL: DuckDB lê Parquet nativamente com performance excelente
    - Baixo consumo de memória: scan colunar com filtros pushdown
    - Setup simples: pip install + python server.py
Contras:
    - Parquet precisa estar no disco local (não suporta S3 sem config extra)
    - DuckDB é single-process (suficiente para MVP single-user)
"""

import argparse
import os
import math
from datetime import datetime, timedelta
from pathlib import Path

import duckdb
from fastapi import FastAPI, Query
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
import uvicorn

# ─── Configuração ───────────────────────────────────────────────
BASE_DIR = Path(__file__).parent
DEFAULT_PARQUET = BASE_DIR / "data" / "estabelecimentos_sp.parquet"

# Bounding box de São Paulo para validação de coordenadas
# Parametrizado para extensibilidade (não hardcoded para SP)
SP_BOUNDS = {
    "lat_min": -24.1,
    "lat_max": -23.3,
    "lon_min": -46.9,
    "lon_max": -46.3,
}

# ─── App FastAPI ────────────────────────────────────────────────
app = FastAPI(title="Site Selector API", version="1.0.0")

# Conexão DuckDB (global, read-only)
con = None
parquet_path = None


def init_db(path: str):
    """Inicializa conexão DuckDB apontando para o arquivo Parquet."""
    global con, parquet_path
    parquet_path = path
    con = duckdb.connect(database=":memory:", read_only=False)
    # Verificar se o arquivo existe
    if not os.path.exists(path):
        raise FileNotFoundError(f"Parquet não encontrado: {path}")
    # Testar leitura
    count = con.execute(
        f"SELECT COUNT(*) FROM read_parquet('{path}')"
    ).fetchone()[0]
    print(f"[DuckDB] Parquet carregado: {count} registros em {path}")


@app.get("/api/establishments")
async def get_establishments(
    cnae: str = Query(..., description="CNAE fiscal principal (7 dígitos)"),
    lat_min: float = Query(SP_BOUNDS["lat_min"], description="Latitude mínima"),
    lat_max: float = Query(SP_BOUNDS["lat_max"], description="Latitude máxima"),
    lon_min: float = Query(SP_BOUNDS["lon_min"], description="Longitude mínima"),
    lon_max: float = Query(SP_BOUNDS["lon_max"], description="Longitude máxima"),
):
    """
    Retorna estabelecimentos filtrados por CNAE, categorizados em:
    - active: situação cadastral = '02' (ativa)
    - opened24m: ativas + data_inicio_atividade nos últimos 24 meses
    - closed24m: não ativas + data_sit_cadastral nos últimos 24 meses
    - allEstablishments: todos com category bitmask e métricas pré-calculadas
    """
    now = datetime.now()
    cutoff_24m = now - timedelta(days=730)  # ~24 meses
    cutoff_str = cutoff_24m.strftime("%Y%m%d")
    now_str = now.strftime("%Y%m%d")

    # Query principal: filtrar por CNAE e bounding box
    query = f"""
    SELECT
        cnpj_basico,
        cnpj_ordem,
        cnpj_dv,
        nome_fantasia,
        razao_social,
        situacao_cadastral,
        data_sit_cadastral,
        data_inicio_atividade,
        latitude,
        longitude,
        logradouro,
        numero,
        bairro
    FROM read_parquet('{parquet_path}')
    WHERE cnae_fiscal_principal = ?
      AND latitude IS NOT NULL
      AND longitude IS NOT NULL
      AND latitude BETWEEN ? AND ?
      AND longitude BETWEEN ? AND ?
    """

    try:
        result = con.execute(
            query, [cnae, lat_min, lat_max, lon_min, lon_max]
        ).fetchall()
    except Exception as e:
        return JSONResponse(
            status_code=500,
            content={"error": str(e)},
        )

    columns = [
        "cnpj_basico", "cnpj_ordem", "cnpj_dv",
        "nome_fantasia", "razao_social",
        "situacao_cadastral", "data_sit_cadastral",
        "data_inicio_atividade",
        "latitude", "longitude",
        "logradouro", "numero", "bairro",
    ]

    active = []
    opened_24m = []
    closed_24m = []
    all_establishments = []

    for row in result:
        rec = dict(zip(columns, row))
        lat = rec["latitude"]
        lon = rec["longitude"]

        # Validar coordenadas
        if lat is None or lon is None:
            continue
        if not (lat_min <= lat <= lat_max and lon_min <= lon <= lon_max):
            continue

        sit = rec["situacao_cadastral"]
        is_active = sit == "02"

        # Parsear datas
        data_inicio = _parse_date(rec["data_inicio_atividade"])
        data_sit = _parse_date(rec["data_sit_cadastral"])

        # Idade em anos
        age_years = 0.0
        if data_inicio:
            age_years = max(0, (now - data_inicio).days / 365.25)

        # Categorizar (bitmask: 1=ativa, 2=aberta24m, 4=fechada24m)
        category = 0
        months_since_event = 0.0

        if is_active:
            category |= 1  # ativa

            # Aberta nos últimos 24m e ativa
            if data_inicio and data_inicio >= cutoff_24m:
                category |= 2  # aberta24m
                months_since_event = max(
                    0, (now - data_inicio).days / 30.44
                )
        else:
            # Fechada nos últimos 24m
            if data_sit and data_sit >= cutoff_24m:
                category |= 4  # fechada24m
                months_since_event = max(
                    0, (now - data_sit).days / 30.44
                )

        # Objeto simplificado para o frontend
        est_base = {
            "lat": lat,
            "lon": lon,
            "cnpj_basico": rec["cnpj_basico"],
            "cnpj_ordem": rec["cnpj_ordem"],
            "cnpj_dv": rec["cnpj_dv"],
            "nome_fantasia": rec["nome_fantasia"] or "",
            "razao_social": rec["razao_social"] or "",
            "logradouro": rec["logradouro"] or "",
            "numero": rec["numero"] or "",
            "bairro": rec["bairro"] or "",
        }

        if is_active:
            active.append(est_base)
            if category & 2:
                opened_24m.append(est_base)
        elif category & 4:
            closed_24m.append(est_base)

        # Todos os estabelecimentos para o worker (dados mínimos)
        all_establishments.append({
            "lat": lat,
            "lon": lon,
            "category": category,
            "age_years": round(age_years, 2),
            "months_since_event": round(months_since_event, 1),
        })

    return {
        "cnae": cnae,
        "total": len(result),
        "active": active,
        "opened24m": opened_24m,
        "closed24m": closed_24m,
        "allEstablishments": all_establishments,
    }


@app.get("/api/candidate-points")
async def get_candidate_points(
    lat_min: float = Query(SP_BOUNDS["lat_min"], description="Latitude mínima"),
    lat_max: float = Query(SP_BOUNDS["lat_max"], description="Latitude máxima"),
    lon_min: float = Query(SP_BOUNDS["lon_min"], description="Longitude mínima"),
    lon_max: float = Query(SP_BOUNDS["lon_max"], description="Longitude máxima"),
):
    """
    Retorna todos os (lat, lon) únicos do parquet completo (sem filtro de CNAE).
    Esses são os pontos candidatos onde a força será calculada — cada um
    corresponde a um endereço real de estabelecimento existente.
    """
    query = f"""
    SELECT DISTINCT latitude, longitude
    FROM read_parquet('{parquet_path}')
    WHERE latitude IS NOT NULL
      AND longitude IS NOT NULL
      AND latitude BETWEEN ? AND ?
      AND longitude BETWEEN ? AND ?
    """
    try:
        result = con.execute(
            query, [lat_min, lat_max, lon_min, lon_max]
        ).fetchall()
    except Exception as e:
        return JSONResponse(
            status_code=500,
            content={"error": str(e)},
        )

    # Formato compacto: arrays paralelos em vez de objetos repetidos
    lats = [r[0] for r in result]
    lons = [r[1] for r in result]

    return {"count": len(result), "lats": lats, "lons": lons}


@app.get("/api/cnaes/top")
async def get_top_cnaes(limit: int = Query(50, description="Número de CNAEs")):
    """Retorna os CNAEs mais frequentes no dataset."""
    query = f"""
    SELECT cnae_fiscal_principal, COUNT(*) as cnt
    FROM read_parquet('{parquet_path}')
    WHERE latitude IS NOT NULL AND longitude IS NOT NULL
    GROUP BY cnae_fiscal_principal
    ORDER BY cnt DESC
    LIMIT ?
    """
    result = con.execute(query, [limit]).fetchall()
    return [{"codigo": r[0], "count": r[1]} for r in result]


@app.get("/api/stats")
async def get_stats():
    """Estatísticas gerais do dataset."""
    query = f"""
    SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE situacao_cadastral = '02') as ativos,
        COUNT(*) FILTER (WHERE latitude IS NOT NULL) as com_geo
    FROM read_parquet('{parquet_path}')
    """
    r = con.execute(query).fetchone()
    return {"total": r[0], "ativos": r[1], "com_geo": r[2]}


def _parse_date(s):
    """Parseia data no formato YYYYMMDD. Retorna None se inválida."""
    if not s or len(s) != 8:
        return None
    try:
        return datetime(int(s[:4]), int(s[4:6]), int(s[6:8]))
    except (ValueError, TypeError):
        return None


# ─── Servir arquivos estáticos ──────────────────────────────────
@app.get("/")
async def serve_index():
    return FileResponse(BASE_DIR / "index.html")


@app.get("/worker.js")
async def serve_worker():
    return FileResponse(BASE_DIR / "worker.js")


@app.get("/cnaes.json")
async def serve_cnaes():
    return FileResponse(BASE_DIR / "cnaes.json")


# Servir diretório de testes
app.mount(
    "/tests",
    StaticFiles(directory=str(BASE_DIR / "tests")),
    name="tests",
)


# ─── Entrypoint ────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description="Site Selector Backend")
    parser.add_argument(
        "--port", type=int, default=8080, help="Porta do servidor (default: 8080)"
    )
    parser.add_argument(
        "--parquet",
        type=str,
        default=str(DEFAULT_PARQUET),
        help="Caminho do arquivo Parquet",
    )
    parser.add_argument(
        "--host", type=str, default="0.0.0.0", help="Host (default: 0.0.0.0)"
    )
    args = parser.parse_args()

    init_db(args.parquet)
    print(f"[Server] Iniciando em http://{args.host}:{args.port}")
    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
