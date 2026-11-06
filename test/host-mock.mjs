/**
 * Load the plugin against a mock DSH host and drive both commands end to end.
 *
 * The point is to prove three things without a real Host:
 *   1. apply() registers through ctx.commands.register with a valid definition;
 *   2. the handler returns a normalisable CommandResult;
 *   3. a missing model file produces an explanatory error, not a crash.
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

let failures = 0;
function check(label, condition, detail) {
  if (condition) console.log('OK   ' + label);
  else {
    failures += 1;
    console.log('FAIL ' + label + (detail === undefined ? '' : ' :: ' + detail));
  }
}

const registered = [];
const effects = [];
const logger = {
  info: () => {},
  debug: () => {},
  warn: () => {},
  error: () => {},
};

const ctx = {
  logger: () => logger,
  effect(generator, label) {
    const iterator = generator();
    let step = iterator.next();
    while (!step.done) {
      if (typeof step.value === 'function') effects.push(step.value);
      step = iterator.next();
    }
    return { label };
  },
  commands: {
    register(definition) {
      registered.push(definition);
      return () => {};
    },
  },
  get(service) {
    if (service === 'attachments') {
      return {
        imageHostPath: () => undefined,
        fileHostPath: () => undefined,
      };
    }
    return undefined;
  },
};

const modelsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bird-models-'));
const mod = await import('../lib/index.js');
check('module exports a name', mod.name === 'dsh-bird', mod.name);
check('module declares the commands injection', Array.isArray(mod.inject) && mod.inject.includes('commands'), JSON.stringify(mod.inject));
check('module exports apply()', typeof mod.apply === 'function');

mod.apply(ctx, { modelsDir, topK: 3 });

check('two commands registered', registered.length === 2, registered.length);
const names = registered.map((d) => d.name);
check('registers birdid', names.includes('birdid'), names.join(','));
check('registers birdstatus', names.includes('birdstatus'), names.join(','));
for (const definition of registered) {
  check(`${definition.name} has a non-empty description`, typeof definition.description === 'string' && definition.description.trim().length > 0);
  check(`${definition.name} has a handler`, typeof definition.handler === 'function');
  check(`${definition.name} name matches the registry grammar`, /^[a-z][a-z0-9_-]*$/.test(definition.name), definition.name);
}
const birdId = registered.find((d) => d.name === 'birdid');
check('birdid opts into attachments', birdId.input?.attachments === true, JSON.stringify(birdId.input));
check('birdid supplies an input hint', typeof birdId.input?.hint === 'string' && birdId.input.hint.length > 0);

// --- handler behaviour with no attachments and no models ---
const signal = new AbortController().signal;
const noArgs = await birdId.handler({ commandId: 'c1', agent: { session: {} }, rawInput: '', attachments: [], signal });
check('birdid without media returns an error result', noArgs.kind === 'error', noArgs.kind);
check('birdid error text explains usage', typeof noArgs.text === 'string' && noArgs.text.includes('/birdid'), noArgs.text);

const badPath = await birdId.handler({ commandId: 'c2', agent: { session: {} }, rawInput: '/definitely/not/here.jpg', attachments: [], signal });
check('birdid with a bad path stays an error result', badPath.kind === 'error', badPath.kind);

const status = registered.find((d) => d.name === 'birdstatus');
const statusResult = await status.handler({ commandId: 'c3', agent: { session: {} }, rawInput: '', attachments: [], signal });
check('birdstatus returns success', statusResult.kind === 'success', statusResult.kind);
check('birdstatus lists image model', statusResult.text.includes('imageModel'), statusResult.text);
check('birdstatus lists acoustic model', statusResult.text.includes('audioModel'), statusResult.text);
check('birdstatus lists geomodel', statusResult.text.includes('geoModel'), statusResult.text);
check('birdstatus reports platform', statusResult.text.includes(process.platform), statusResult.text);
check('birdstatus marks missing models', statusResult.text.includes('✗'), statusResult.text);

// --- attachment routing: an image host path is picked up ---
const fakeImage = path.join(modelsDir, 'fake.jpg');
fs.writeFileSync(fakeImage, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
const withAttachment = await birdId.handler({
  commandId: 'c4',
  agent: { session: {} },
  rawInput: '',
  attachments: [{ type: 'image', attachment: { id: 'a1' } }],
  signal,
});
// sharp is optional here, and the model is missing anyway: either way the call
// must settle as an error result rather than throw.
check('birdid with an attachment settles as a result', typeof withAttachment.kind === 'string', JSON.stringify(withAttachment).slice(0, 120));
check('birdid with an attachment reports a readable failure', typeof withAttachment.text === 'string' && withAttachment.text.length > 0, withAttachment.text);

// --- lifecycle disposer ---
check('lifecycle registered one teardown', effects.length >= 1, effects.length);
for (const dispose of effects) await dispose();

fs.rmSync(modelsDir, { recursive: true, force: true });
console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURES');
process.exit(failures === 0 ? 0 : 1);
