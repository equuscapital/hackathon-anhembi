/**
 * Web Worker — Modelo de Forças Vetorial para Site Selector
 *
 * Calcula, para cada ponto candidato P em um grid regular, a força resultante
 * vetorial gerada pelos estabelecimentos na vizinhança. Pontos com menor |F|
 * indicam melhores locais (equilíbrio competitivo).
 *
 * Todas as contribuições AFASTAM o candidato da loja (vetor S_i → P):
 *   - Ativa (qualquer idade):       magnitude = f(idade_anos) / d_km²
 *   - Aberta últimos 24m e ativa:   magnitude = meses_desde_abertura / d_km²
 *   - Fechada últimos 24m:          magnitude = meses_desde_fechamento / d_km²
 *
 * Onde d_km = max(haversine(P, S_i), d_min) e f(idade) = idade ou log(1+idade).
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
  const avgLat = -23.55;
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
  const { dMin, wActive, wOpened, wClosed, useLogAge } = params;

  // Força resultante em componentes (usamos lat/lon como proxy de x/y
  // para direção; a magnitude vem de haversine em km)
  let fx = 0; // componente na direção longitude
  let fy = 0; // componente na direção latitude

  for (const idx of neighborIndices) {
    const sLat = lats[idx];
    const sLon = lons[idx];

    // Distância haversine em km, com piso em d_min
    let dKm = haversine(pLat, pLon, sLat, sLon);
    dKm = Math.max(dKm, dMin);

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
    // Magnitude = f(idade_anos) / d_km²
    // Vetor: sentido S_i → P (afasta candidato da loja)
    if (cat & 1) {
      const age = ageYears[idx];
      const effectiveAge = useLogAge ? Math.log(1 + age) : age;
      const mag = wActive * effectiveAge / dKmSq;
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
      // Dados dos estabelecimentos (TypedArrays)
      lats,       // Float64Array
      lons,       // Float64Array
      categories, // Uint8Array (bitmask: 1=ativa, 2=aberta24m, 4=fechada24m)
      ageYears,   // Float32Array
      monthsSinceEvent, // Float32Array

      // Bounding box do grid
      latMin, latMax, lonMin, lonMax,

      // Parâmetros do modelo
      gridSize,   // número de pontos por dimensão (default 150)
      radiusKm,   // raio de corte (default 3)
      dMin,       // distância mínima em km (default 0.05)
      wActive,    // peso contribuição ativa (default 1.0)
      wOpened,    // peso contribuição aberta 24m (default 1.0)
      wClosed,    // peso contribuição fechada 24m (default 1.0)
      useLogAge   // usar log(1+idade) em vez de idade linear (default false)
    } = e.data;

    const params = { dMin, wActive, wOpened, wClosed, useLogAge };

    // Construir índice espacial com células do tamanho do raio
    const spatialIndex = buildSpatialIndex(lats, lons, radiusKm);

    // Gerar grid regular
    const latStep = (latMax - latMin) / (gridSize - 1);
    const lonStep = (lonMax - lonMin) / (gridSize - 1);
    const totalPoints = gridSize * gridSize;

    // Arrays de resultado
    const gridLats = new Float64Array(totalPoints);
    const gridLons = new Float64Array(totalPoints);
    const gridMags = new Float32Array(totalPoints);
    const gridNeighborCounts = new Uint16Array(totalPoints);

    let processed = 0;
    const progressInterval = Math.max(1, Math.floor(totalPoints / 100));

    for (let i = 0; i < gridSize; i++) {
      const pLat = latMin + i * latStep;
      for (let j = 0; j < gridSize; j++) {
        const pLon = lonMin + j * lonStep;
        const idx = i * gridSize + j;

        gridLats[idx] = pLat;
        gridLons[idx] = pLon;

        // Buscar vizinhos dentro do raio de corte
        const neighbors = queryNeighbors(spatialIndex, pLat, pLon, radiusKm, lats, lons);
        gridNeighborCounts[idx] = neighbors.length;

        // Calcular força resultante
        const force = computeForceAtPoint(
          pLat, pLon, neighbors,
          lats, lons, categories, ageYears, monthsSinceEvent,
          params
        );

        gridMags[idx] = force.mag;

        processed++;
        if (processed % progressInterval === 0) {
          self.postMessage({
            type: 'progress',
            percent: Math.round((processed / totalPoints) * 100)
          });
        }
      }
    }

    // Normalizar scores: score = 1 / (|F| + epsilon)
    // Clipar no quantil 95 para evitar outliers dominando o gradiente
    // Pontos sem vizinhos recebem score 0 (não são candidatos válidos)
    const epsilon = 1e-6;
    const scores = new Float32Array(totalPoints);
    for (let i = 0; i < totalPoints; i++) {
      if (gridNeighborCounts[i] >= 3) {
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
    // Excluir pontos sem vizinhos (zonas vazias na borda do grid)
    // Exigir mínimo de 3 vizinhos para ser um ponto candidato válido
    const MIN_NEIGHBORS = 3;
    const top10 = [];
    const indexedScores = [];
    for (let i = 0; i < totalPoints; i++) {
      if (gridNeighborCounts[i] >= MIN_NEIGHBORS) {
        indexedScores.push({ idx: i, score: scores[i], mag: gridMags[i], neighbors: gridNeighborCounts[i] });
      }
    }
    indexedScores.sort((a, b) => b.score - a.score);
    for (let k = 0; k < Math.min(10, indexedScores.length); k++) {
      const entry = indexedScores[k];
      top10.push({
        rank: k + 1,
        lat: gridLats[entry.idx],
        lon: gridLons[entry.idx],
        score: entry.score,
        forceMagnitude: entry.mag,
        neighbors: entry.neighbors
      });
    }

    self.postMessage({
      type: 'result',
      gridLats,
      gridLons,
      normalizedScores,
      rawMags: gridMags,
      top10,
      gridSize
    });
  }
};
