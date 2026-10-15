// Trains the detector off the main thread so the API stays responsive during retraining.
import { parentPort, workerData } from 'worker_threads';
import { train } from './detector.mjs';
import { loadSignalsCache } from './signals-cache.mjs';

try {
  const cache = loadSignalsCache(workerData.dir);
  parentPort.postMessage({ model: train(workerData.samples, { source: workerData.source, signalsFor: cache.signalsFor, cacheSalt: cache.salt }) });
} catch (e) {
  parentPort.postMessage({ error: e.message });
}
