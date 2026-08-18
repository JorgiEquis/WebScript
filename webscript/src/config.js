// wconfig.json -- configuración opcional del proyecto. Se busca en el mismo
// directorio que los .ws que se están compilando (o el directorio del archivo
// concreto, si se compila uno suelto). Si no existe, se usan estos valores por
// defecto -- el lenguaje sigue siendo completamente usable sin ningún wconfig.json,
// igual que hasta ahora.
const DEFAULTS = {
  'http-port': 3000,
  'ws-port': 3001, // reservado -- WebSocket todavía no implementado, ver README
  'allow-acorn': true, // si es false, fuerza el motor de respaldo por regex aunque Acorn esté instalado
  'wson-history-route': null, // null = comportamiento por defecto (junto al server.js, vía __dirname)
  'cluster-workers': 1, // 1 = sin clustering (comportamiento de siempre); >1 = N procesos, sesiones pegajosas por cookie
  'stylesheets': [], // URLs de hojas de estilo externas (ej. Bootstrap por CDN), inyectadas como <link> en el <head>
  'rate-limit-max': 300, // peticiones permitidas por IP en la ventana -- 0 desactiva el límite
  'rate-limit-window-ms': 60000, // duración de la ventana en ms (1 minuto por defecto)
  'wson-replay-window-ms': 5 * 60 * 1000, // ventana de validez de una firma WSON -- protección contra reenvío (5 min por defecto)
};

const VALID_KEYS = new Set(Object.keys(DEFAULTS));

// Lee wconfig.json de `dir` si existe; si no, devuelve los valores por defecto tal
// cual. Si el archivo EXISTE pero tiene JSON inválido o una clave desconocida, lanza
// un error explícito -- un wconfig.json mal escrito falla claro, en vez de ignorarse
// en silencio y dejar al desarrollador preguntándose por qué su configuración no
// tuvo ningún efecto.
function loadConfig(dir) {
  const fs = require('fs');
  const path = require('path');
  const configPath = path.join(dir, 'wconfig.json');

  if (!fs.existsSync(configPath)) {
    return { ...DEFAULTS };
  }

  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (e) {
    throw new Error(`No se pudo leer "${configPath}": ${e.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new SyntaxError(`"${configPath}" no es JSON válido: ${e.message}`);
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SyntaxError(`"${configPath}" debe ser un objeto JSON, ej. { "http-port": 3000 }`);
  }

  const unknownKeys = Object.keys(parsed).filter(k => !VALID_KEYS.has(k));
  if (unknownKeys.length > 0) {
    throw new SyntaxError(
      `"${configPath}" tiene ${unknownKeys.length === 1 ? 'una clave desconocida' : 'claves desconocidas'}: ` +
      `${unknownKeys.map(k => `"${k}"`).join(', ')} -- las válidas son ${[...VALID_KEYS].map(k => `"${k}"`).join(', ')}.`
    );
  }

  if ('http-port' in parsed && (!Number.isInteger(parsed['http-port']) || parsed['http-port'] < 0)) {
    throw new SyntaxError(`"${configPath}": "http-port" debe ser un entero positivo.`);
  }
  if ('ws-port' in parsed && (!Number.isInteger(parsed['ws-port']) || parsed['ws-port'] < 0)) {
    throw new SyntaxError(`"${configPath}": "ws-port" debe ser un entero positivo.`);
  }
  if ('allow-acorn' in parsed && typeof parsed['allow-acorn'] !== 'boolean') {
    throw new SyntaxError(`"${configPath}": "allow-acorn" debe ser true o false.`);
  }
  if ('wson-history-route' in parsed && parsed['wson-history-route'] !== null && typeof parsed['wson-history-route'] !== 'string') {
    throw new SyntaxError(`"${configPath}": "wson-history-route" debe ser un string (ruta) o null.`);
  }
  if ('cluster-workers' in parsed && (!Number.isInteger(parsed['cluster-workers']) || parsed['cluster-workers'] < 1)) {
    throw new SyntaxError(`"${configPath}": "cluster-workers" debe ser un entero de 1 o más (1 = sin clustering).`);
  }
  if ('stylesheets' in parsed) {
    if (!Array.isArray(parsed.stylesheets) || parsed.stylesheets.some(s => typeof s !== 'string' || s.trim() === '')) {
      throw new SyntaxError(`"${configPath}": "stylesheets" debe ser un array de strings (URLs), ej. ["https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css"].`);
    }
  }
  if ('rate-limit-max' in parsed && (!Number.isInteger(parsed['rate-limit-max']) || parsed['rate-limit-max'] < 0)) {
    throw new SyntaxError(`"${configPath}": "rate-limit-max" debe ser un entero de 0 o más (0 = sin límite).`);
  }
  if ('rate-limit-window-ms' in parsed && (!Number.isInteger(parsed['rate-limit-window-ms']) || parsed['rate-limit-window-ms'] <= 0)) {
    throw new SyntaxError(`"${configPath}": "rate-limit-window-ms" debe ser un entero mayor que 0.`);
  }
  if ('wson-replay-window-ms' in parsed && (!Number.isInteger(parsed['wson-replay-window-ms']) || parsed['wson-replay-window-ms'] <= 0)) {
    throw new SyntaxError(`"${configPath}": "wson-replay-window-ms" debe ser un entero mayor que 0.`);
  }

  return { ...DEFAULTS, ...parsed };
}

module.exports = { loadConfig, DEFAULTS };
