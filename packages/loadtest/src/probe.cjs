// Preloaded into ws-backend with `node --require`, so the server source stays
// untouched. Appends one JSON line per second to LOADTEST_PROBE_FILE with
// memory, CPU, event-loop health and the bufferedAmount of every server socket.
const fs = require('node:fs');
const Module = require('node:module');
const { monitorEventLoopDelay, performance } = require('node:perf_hooks');

const file = process.env.LOADTEST_PROBE_FILE;
if (file) {
  const sockets = new Set();
  const originalLoad = Module._load;
  let patched = false;

  Module._load = function (request, ...rest) {
    const loaded = originalLoad.call(this, request, ...rest);
    if (request === 'ws' && !patched && loaded && loaded.WebSocket) {
      patched = true;
      const send = loaded.WebSocket.prototype.send;
      loaded.WebSocket.prototype.send = function (...args) {
        sockets.add(this);
        return send.apply(this, args);
      };
    }
    return loaded;
  };

  const delay = monitorEventLoopDelay({ resolution: 5 });
  delay.enable();
  let lastElu = performance.eventLoopUtilization();

  const sample = () => {
    let sumBuffered = 0;
    let maxBuffered = 0;
    for (const socket of sockets) {
      if (socket.readyState === 3) {
        sockets.delete(socket);
        continue;
      }
      const buffered = socket.bufferedAmount;
      sumBuffered += buffered;
      if (buffered > maxBuffered) maxBuffered = buffered;
    }
    const elu = performance.eventLoopUtilization();
    const interval = performance.eventLoopUtilization(elu, lastElu);
    lastElu = elu;
    const memory = process.memoryUsage();
    const cpu = process.cpuUsage();
    fs.appendFileSync(file, JSON.stringify({
      t: Date.now(),
      rss: memory.rss,
      heapUsed: memory.heapUsed,
      external: memory.external,
      cpuMicros: cpu.user + cpu.system,
      elu: interval.utilization,
      loopP99Ms: delay.percentile(99) / 1e6,
      loopMaxMs: delay.max / 1e6,
      sumBuffered,
      maxBuffered,
      sockets: sockets.size,
    }) + '\n');
    delay.reset();
  };

  setInterval(sample, 1000).unref();
}
