/**
 * Web Worker — Modelo de Forças Vetorial para Nearby
 *
 * Calcula, para cada ponto candidato P (coordenada real de estabelecimento
 * existente no parquet, sem filtro de CNAE), a força resultante vetorial
 * gerada pelos estabelecimentos do CNAE selecionado na vizinhança.
 * Pontos com menor |F| indicam melhores locais (equilíbrio competitivo).
 *
 * Todas as contribuições AFASTAM o candidato da loja (vetor S_i → P):
 *   - Ativa (qualquer idade):       magnitude = idade_anos / d_km²
 *   - Aberta últimos 24m e ativa:   magnitude = meses_desde_abertura / d_km²
 *   - Fechada últimos 24m:          magnitude = meses_desde_fechamento / d_km²
 *
 * Filtro de densidade: apenas pontos candidatos com ≥10 estabelecimentos
 * (do parquet completo) num raio de 100m são considerados válidos.
 */

/* ────────────────── Constantes ────────────────── */
const DEG_TO_RAD = Math.PI / 180;
const EARTH_RADIUS_KM = 6371;

/* ────────────────── Haversine (km) ────────────────── */
/**
 * Distância haversine entre dois pontos (lat/lon em graus).
 * @param {number} lat1 - Latitude do ponto 1 (graus)
 * @param {number} lon1 - Longitude do ponto 1 (graus)
 * @param {number} lat2 - Latitude do ponto 2 (graus)
 * @param {number} lon2 - Longitude do ponto 2 (graus)
 * @returns {number} Distância em km
 */
function haversine(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * DEG_TO_RAD;
  const dLon = (lon2 - lon1) * DEG_TO_RAD;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * DEG_TO_RAD) *
      Math.cos(lat2 * DEG_TO_RAD) *
      Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a));
}

/* ────────────────── Índice espacial simples (grid hash) ────────────────── */
/**
 * Cria um índice espacial baseado em grid hash para busca rápida por vizinhança.
 * Cada célula do hash tem tamanho ~cellSizeKm convertido em graus.
 * @param {Float64Array} lats - Array de latitudes
 * @param {Float64Array} lons - Array de longitudes
 * @param {number} cellSizeKm - Tamanho da célula em km (~raio de corte)
 * @returns {object} Índice espacial { cells, cellSizeLat, cellSizeLon }
 */
function buildSpatialIndex(lats, lons, cellSizeKm) {
  // Converter km para graus (aproximação para latitude média de SP ~-23.55)
  const avgLat = -23.45;
  const cellSizeLat = cellSizeKm / 111.32;
  const cellSizeLon = cellSizeKm / (111.32 * Math.cos(avgLat * DEG_TO_RAD));

  const cells = new Map();
  const n = lats.length;

  for (let i = 0; i < n; i++) {
    const cx = Math.floor(lats[i] / cellSizeLat);
    const cy = Math.floor(lons[i] / cellSizeLon);
    const key = cx + ',' + cy;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(i);
  }

  return { cells, cellSizeLat, cellSizeLon };
}

/**
 * Busca índices de estabelecimentos dentro do raio de corte de um ponto.
 * @param {object} index - Índice espacial
 * @param {number} lat - Latitude do ponto candidato
 * @param {number} lon - Longitude do ponto candidato
 * @param {number} radiusKm - Raio de corte em km
 * @param {Float64Array} lats - Array de latitudes
 * @param {Float64Array} lons - Array de longitudes
 * @returns {number[]} Índices dos estabelecimentos dentro do raio
 */
function queryNeighbors(index, lat, lon, radiusKm, lats, lons) {
  const { cells, cellSizeLat, cellSizeLon } = index;
  const cx = Math.floor(lat / cellSizeLat);
  const cy = Math.floor(lon / cellSizeLon);

  // Quantas células vizinhas precisamos checar
  const cellsToCheck = Math.ceil(radiusKm / (cellSizeLat * 111.32)) + 1;
  const results = [];

  for (let dx = -cellsToCheck; dx <= cellsToCheck; dx++) {
    for (let dy = -cellsToCheck; dy <= cellsToCheck; dy++) {
      const key = (cx + dx) + ',' + (cy + dy);
      const bucket = cells.get(key);
      if (!bucket) continue;
      for (const idx of bucket) {
        const d = haversine(lat, lon, lats[idx], lons[idx]);
        if (d <= radiusKm) results.push(idx);
      }
    }
  }

  return results;
}

/* ────────────────── Cálculo de forças para um ponto ────────────────── */
/**
 * Calcula a força resultante vetorial em um ponto candidato P.
 *
 * Para cada estabelecimento S_i na vizinhança:
 *   - Calcula o vetor unitário de S_i → P (direção que afasta P de S_i)
 *   - Multiplica pela magnitude correspondente à categoria do estabelecimento
 *   - Soma todas as contribuições vetorialmente
 *
 * @param {number} pLat - Latitude do ponto candidato
 * @param {number} pLon - Longitude do ponto candidato
 * @param {number[]} neighborIndices - Índices dos estabelecimentos vizinhos
 * @param {Float64Array} lats - Latitudes dos estabelecimentos
 * @param {Float64Array} lons - Longitudes dos estabelecimentos
 * @param {Uint8Array} categories - Categoria de cada estab (1=ativa, 2=aberta24m+ativa, 4=fechada24m; bitmask)
 * @param {Float32Array} ageYears - Idade em anos de cada estabelecimento
 * @param {Float32Array} monthsSinceEvent - Meses desde abertura (cat 2) ou fechamento (cat 4)
 * @param {object} params - Parâmetros do modelo
 * @returns {{ fx: number, fy: number, mag: number }}
 */
function computeForceAtPoint(pLat, pLon, neighborIndices, lats, lons, categories, ageYears, monthsSinceEvent, params) {
  const { wActive, wOpened, wClosed } = params;

  // Força resultante em componentes (usamos lat/lon como proxy de x/y
  // para direção; a magnitude vem de haversine em km)
  let fx = 0; // componente na direção longitude
  let fy = 0; // componente na direção latitude

  for (const idx of neighborIndices) {
    const sLat = lats[idx];
    const sLon = lons[idx];

    // Distância haversine em km (piso de 10m para evitar singularidade)
    let dKm = haversine(pLat, pLon, sLat, sLon);
    dKm = Math.max(dKm, 0.01);

    // Vetor direção de S_i → P (normalizado)
    // Usamos diferença em graus como proxy de direção; basta a direção, não magnitude
    const dLat = pLat - sLat;
    const dLon = pLon - sLon;
    const dirLen = Math.sqrt(dLat * dLat + dLon * dLon);

    // Se o ponto é coincidente com a loja (dentro de d_min), direção indefinida: pular
    if (dirLen < 1e-10) continue;

    const ux = dLon / dirLen; // versor x (lon)
    const uy = dLat / dirLen; // versor y (lat)

    const dKmSq = dKm * dKm;
    const cat = categories[idx];

    // Contribuição 1: Loja ativa (qualquer idade)
    // Magnitude = idade_anos / d_km²
    // Vetor: sentido S_i → P (afasta candidato da loja)
    if (cat & 1) {
      const age = ageYears[idx];
      const mag = wActive * age / dKmSq;
      fx += mag * ux;
      fy += mag * uy;
    }

    // Contribuição 2: Loja aberta nos últimos 24m E ainda ativa
    // Magnitude = meses_desde_abertura / d_km²
    // Mesmo sentido (S_i → P): competição emergente também repele
    if (cat & 2) {
      const months = monthsSinceEvent[idx];
      const mag = wOpened * months / dKmSq;
      fx += mag * ux;
      fy += mag * uy;
    }

    // Contribuição 3: Loja fechada nos últimos 24m
    // Magnitude = meses_desde_fechamento / d_km²
    // Mesmo sentido (S_i → P): fechamentos indicam região hostil
    if (cat & 4) {
      const months = monthsSinceEvent[idx];
      const mag = wClosed * months / dKmSq;
      fx += mag * ux;
      fy += mag * uy;
    }
  }

  const mag = Math.sqrt(fx * fx + fy * fy);
  return { fx, fy, mag };
}

/* ────────────────── Handler do Worker ────────────────── */
self.onmessage = function (e) {
  const { type } = e.data;

  if (type === 'compute') {
    const {
      // Dados dos estabelecimentos filtrados por CNAE (fontes de força)
      lats,       // Float64Array
      lons,       // Float64Array
      categories, // Uint8Array (bitmask: 1=ativa, 2=aberta24m, 4=fechada24m)
      ageYears,   // Float32Array
      monthsSinceEvent, // Float32Array

      // Pontos candidatos (todos os lat/lon únicos do parquet, sem filtro CNAE)
      candidateLats,  // Float64Array
      candidateLons,  // Float64Array

      // Parâmetros do modelo
      radiusKm,   // raio de corte (default 3)
      wActive,    // peso contribuição ativa (default 1.0)
      wOpened,    // peso contribuição aberta 24m (default 1.0)
      wClosed,    // peso contribuição fechada 24m (default 1.0)
    } = e.data;

    const params = { wActive, wOpened, wClosed };

    // Construir índice espacial dos estabelecimentos (fontes de força)
    const spatialIndex = buildSpatialIndex(lats, lons, radiusKm);

    // Filtro de densidade: contar pontos candidatos em cada célula de ~100m
    // Pontos em células com <10 vizinhos são considerados rurais/borda
    const DENSITY_CELL_KM = 0.1;
    const MIN_DENSITY_NEIGHBORS = 10;
    const avgLat = -23.45;
    const densityCellLat = DENSITY_CELL_KM / 111.32;
    const densityCellLon = DENSITY_CELL_KM / (111.32 * Math.cos(avgLat * DEG_TO_RAD));

    // Iterar sobre pontos candidatos (coordenadas reais do parquet)
    const totalPoints = candidateLats.length;

    // Contar pontos por célula (O(n) em vez de O(n²))
    const cellCounts = new Map();
    const cellKeys = new Array(totalPoints);
    for (let i = 0; i < totalPoints; i++) {
      const cx = Math.floor(candidateLats[i] / densityCellLat);
      const cy = Math.floor(candidateLons[i] / densityCellLon);
      const key = cx + ',' + cy;
      cellKeys[i] = key;
      cellCounts.set(key, (cellCounts.get(key) || 0) + 1);
    }

    // Densidade = soma dos pontos na célula + 8 vizinhas (3x3 neighborhood)
    const densityCounts = new Uint16Array(totalPoints);
    for (let i = 0; i < totalPoints; i++) {
      const cx = Math.floor(candidateLats[i] / densityCellLat);
      const cy = Math.floor(candidateLons[i] / densityCellLon);
      let count = 0;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          count += cellCounts.get((cx+dx) + ',' + (cy+dy)) || 0;
        }
      }
      densityCounts[i] = count;
    }

    self.postMessage({ type: 'progress', percent: 5 });

    // Arrays de resultado
    const gridLats = new Float64Array(totalPoints);
    const gridLons = new Float64Array(totalPoints);
    const gridMags = new Float32Array(totalPoints);
    const gridNeighborCounts = new Uint16Array(totalPoints);

    let processed = 0;
    const progressInterval = Math.max(1, Math.floor(totalPoints / 200));

    for (let i = 0; i < totalPoints; i++) {
      const pLat = candidateLats[i];
      const pLon = candidateLons[i];

      gridLats[i] = pLat;
      gridLons[i] = pLon;

      // Ponto sem densidade suficiente: pular cálculo de força
      if (densityCounts[i] < MIN_DENSITY_NEIGHBORS) {
        gridMags[i] = Infinity;
        gridNeighborCounts[i] = 0;
        processed++;
        if (processed % progressInterval === 0) {
          self.postMessage({
            type: 'progress',
            percent: 5 + Math.round((processed / totalPoints) * 90)
          });
        }
        continue;
      }

      // Buscar vizinhos (estabelecimentos do CNAE) dentro do raio de corte
      const neighbors = queryNeighbors(spatialIndex, pLat, pLon, radiusKm, lats, lons);
      gridNeighborCounts[i] = neighbors.length;

      // Calcular força resultante
      const force = computeForceAtPoint(
        pLat, pLon, neighbors,
        lats, lons, categories, ageYears, monthsSinceEvent,
        params
      );

      gridMags[i] = force.mag;

      processed++;
      if (processed % progressInterval === 0) {
        self.postMessage({
          type: 'progress',
          percent: 5 + Math.round((processed / totalPoints) * 90)
        });
      }
    }

    // Normalizar scores: score = 1 / (|F| + epsilon)
    // Clipar no quantil 95 para evitar outliers dominando o gradiente
    // Pontos sem vizinhos recebem score 0 (não são candidatos válidos)
    const epsilon = 1e-6;
    const scores = new Float32Array(totalPoints);
    for (let i = 0; i < totalPoints; i++) {
      if (densityCounts[i] >= MIN_DENSITY_NEIGHBORS && gridMags[i] !== Infinity && gridNeighborCounts[i] >= 1) {
        scores[i] = 1 / (gridMags[i] + epsilon);
      } else {
        scores[i] = 0;
      }
    }

    // Calcular quantil 95 para clipping (apenas scores > 0)
    const nonZeroScores = Array.from(scores).filter(s => s > 0);
    nonZeroScores.sort((a, b) => a - b);
    const q95Idx = Math.floor(0.95 * nonZeroScores.length);
    const q95Val = nonZeroScores.length > 0 ? nonZeroScores[q95Idx] : 1;

    // Normalizar em [0, 1] com clipping no q95
    let maxScore = q95Val;
    let minScore = nonZeroScores.length > 0 ? nonZeroScores[0] : 0;
    if (maxScore <= minScore) maxScore = minScore + 1;

    const normalizedScores = new Float32Array(totalPoints);
    for (let i = 0; i < totalPoints; i++) {
      const clipped = Math.min(scores[i], q95Val);
      normalizedScores[i] = (clipped - minScore) / (maxScore - minScore);
    }

    // Encontrar top-10 pontos (maior score = menor |F|)
    // Exigir densidade mínima (≥10 no raio de 100m) e vizinhos CNAE
    const indexedScores = [];
    for (let i = 0; i < totalPoints; i++) {
      if (densityCounts[i] >= MIN_DENSITY_NEIGHBORS && gridMags[i] !== Infinity && gridNeighborCounts[i] >= 1 && scores[i] > 0) {
        indexedScores.push({ idx: i, score: scores[i], mag: gridMags[i], neighbors: gridNeighborCounts[i], density: densityCounts[i] });
      }
    }
    indexedScores.sort((a, b) => b.score - a.score);
    const top10 = [];
    for (let k = 0; k < Math.min(10, indexedScores.length); k++) {
      const entry = indexedScores[k];
      top10.push({
        rank: k + 1,
        lat: gridLats[entry.idx],
        lon: gridLons[entry.idx],
        score: entry.score,
        forceMagnitude: entry.mag,
        neighbors: entry.neighbors,
        density: entry.density
      });
    }

    self.postMessage({
      type: 'result',
      gridLats,
      gridLons,
      normalizedScores,
      rawMags: gridMags,
      top10,
      totalPoints
    });
  }
};
