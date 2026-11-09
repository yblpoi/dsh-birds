import { ImageClassifier } from './imageclf.mjs';
import { BirdGate } from './yologate.mjs';
import { AcousticClassifier } from './audio/birdnet.mjs';
import { GeoPrior } from './geo.mjs';

/**
 * Lazily-constructed singleton holder.
 *
 * A phone cannot keep a 212 MB image graph and a 45 MB acoustic graph resident
 * the whole time, so each engine is built on first use and the plugin exposes a
 * release() the host can call on idle if it wants the memory back.
 */
export class BirdEngines {
  #modelsDir;
  #logger;
  #gate;
  #image;
  #audio;
  #geo;
  #ortAvailable;

  constructor({ modelsDir, logger }) {
    this.#modelsDir = modelsDir;
    this.#logger = logger;
  }

  async probeOrt() {
    if (this.#ortAvailable !== undefined) return this.#ortAvailable;
    try {
      await import('onnxruntime-node');
      this.#ortAvailable = true;
    } catch (error) {
      this.#ortAvailable = false;
      this.#logger?.warn?.('onnxruntime-node unavailable: ' + (error?.message ?? error));
    }
    return this.#ortAvailable;
  }

  /**
   * The gate is the smallest graph of the three (11 MB), so it is the cheapest
   * to keep resident - but it is still built lazily, because a host that only
   * ever sends audio should never touch these weights.
   */
  get gate() {
    this.#gate ??= new BirdGate({ modelsDir: this.#modelsDir, logger: this.#logger });
    return this.#gate;
  }

  get image() {
    this.#image ??= new ImageClassifier({ modelsDir: this.#modelsDir, logger: this.#logger });
    return this.#image;
  }

  get audio() {
    this.#audio ??= new AcousticClassifier({ modelsDir: this.#modelsDir, logger: this.#logger });
    return this.#audio;
  }

  get geo() {
    this.#geo ??= new GeoPrior({ modelsDir: this.#modelsDir, logger: this.#logger });
    return this.#geo;
  }

  release() {
    this.#gate = undefined;
    this.#image = undefined;
    this.#audio = undefined;
    this.#geo = undefined;
  }
}
