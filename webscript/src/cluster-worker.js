// Ejecutado exclusivamente como cluster.fork() worker (ver startClusteredServer en
// site-builder.js) -- nunca se usa directamente por el CLI. Cada worker recompila el
// sitio EN SU PROPIO PROCESO (independiente del primario y de los demás workers) --
// no se intenta serializar el "table" compilado entre procesos, ya que contiene
// referencias a módulos requeridos, no datos planos. Es una redundancia pequeña
// (recompilar lo mismo varias veces) a cambio de una implementación mucho más simple.
const fs = require('fs');
const { buildSite, buildSingleFileAsSite, startServer } = require('./site-builder');

const srcTarget = process.env.WS_CLUSTER_SRC_TARGET;
const outDir = process.env.WS_CLUSTER_OUT_DIR;
const internalPort = parseInt(process.env.WS_CLUSTER_INTERNAL_PORT, 10);

if (!srcTarget || !outDir || !internalPort) {
  console.error('cluster-worker.js: faltan variables de entorno (WS_CLUSTER_SRC_TARGET/WS_CLUSTER_OUT_DIR/WS_CLUSTER_INTERNAL_PORT) -- no se ejecuta directamente, solo vía startClusteredServer().');
  process.exit(1);
}

const isDirectory = fs.statSync(srcTarget).isDirectory();
const { table, config } = isDirectory ? buildSite(srcTarget, outDir) : buildSingleFileAsSite(srcTarget, outDir);

// Límite reconocido, no oculto: cada worker cuenta las peticiones por SU CUENTA --
// no hay ningún contador compartido entre workers (necesitaría coordinación entre
// procesos, no construida aquí). Con N workers, el límite EFECTIVO para una IP
// insistente es hasta N veces "rate-limit-max", no exactamente ese valor. Se
// documenta así en el README en vez de fingir que el límite configurado es exacto
// en modo cluster.
const server = startServer(table, outDir, internalPort, {
  rateLimitMax: config['rate-limit-max'],
  rateLimitWindowMs: config['rate-limit-window-ms'],
});
server.on('listening', () => {
  if (process.send) process.send({ tipo: 'listo', puerto: internalPort, pid: process.pid });
});
