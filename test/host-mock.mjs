/**
 * Load the plugin against a mock DSH host and drive both commands end to end.
 *
 * The point is to prove four things without a real Host:
 *   1. apply() registers through ctx.commands.register with a valid definition;
 *   2. the handler returns a normalisable CommandResult;
 *   3. a missing model file produces an explanatory error, not a crash;
 *   4. a `/birds` line that a client handed to the model is taken over at the
 *      turn boundary, so no request is ever built for it.
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
const listeners = new Map();
const listenerOptions = new Map();
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
  on(event, listener, options) {
    const bucket = listeners.get(event) ?? [];
    bucket.push(listener);
    listeners.set(event, bucket);
    const optionsBucket = listenerOptions.get(event) ?? [];
    optionsBucket.push(options);
    listenerOptions.set(event, optionsBucket);
    return () => {
      const index = bucket.indexOf(listener);
      if (index >= 0) bucket.splice(index, 1);
    };
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

const modelsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-birds-models-'));
const mod = await import('../lib/index.js');
check('module exports a name', mod.name === 'dsh-birds', mod.name);
check('module declares the commands injection', Array.isArray(mod.inject) && mod.inject.includes('commands'), JSON.stringify(mod.inject));
check('module exports apply()', typeof mod.apply === 'function');

mod.apply(ctx, { modelsDir, topK: 3 });

check('two commands registered', registered.length === 2, registered.length);
const names = registered.map((d) => d.name);
check('registers birds', names.includes('birds'), names.join(','));
check('registers birdstatus', names.includes('birdstatus'), names.join(','));
for (const definition of registered) {
  check(`${definition.name} has a non-empty description`, typeof definition.description === 'string' && definition.description.trim().length > 0);
  check(`${definition.name} has a handler`, typeof definition.handler === 'function');
  check(`${definition.name} name matches the registry grammar`, /^[a-z][a-z0-9_-]*$/.test(definition.name), definition.name);
}
const birdId = registered.find((d) => d.name === 'birds');
check('birds opts into attachments', birdId.input?.attachments === true, JSON.stringify(birdId.input));
check('birds supplies an input hint', typeof birdId.input?.hint === 'string' && birdId.input.hint.length > 0);

// --- handler behaviour with no attachments and no models ---
const signal = new AbortController().signal;
const noArgs = await birdId.handler({ commandId: 'c1', agent: { session: {} }, rawInput: '', attachments: [], signal });
check('birds without media returns an error result', noArgs.kind === 'error', noArgs.kind);
check('birds error text explains usage', typeof noArgs.text === 'string' && noArgs.text.includes('/birds'), noArgs.text);

const badPath = await birdId.handler({ commandId: 'c2', agent: { session: {} }, rawInput: '/definitely/not/here.jpg', attachments: [], signal });
check('birds with a bad path stays an error result', badPath.kind === 'error', badPath.kind);

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
check('birds with an attachment settles as a result', typeof withAttachment.kind === 'string', JSON.stringify(withAttachment).slice(0, 120));
check('birds with an attachment reports a readable failure', typeof withAttachment.text === 'string' && withAttachment.text.length > 0, withAttachment.text);

// --- turn-boundary takeover: a /birds line routed to the model ---
const preStep = listeners.get('agent/pre-step') ?? [];
check('registers one agent/pre-step listener', preStep.length === 1, preStep.length);
const hookOptions = listenerOptions.get('agent/pre-step')?.[0] ?? {};
check('the takeover hook runs outermost', hookOptions.prepend === true, JSON.stringify(hookOptions));

/** Drive the listener the way the Host's waterfall does, with a stub session. */
async function runPreStep(payload) {
  const appended = [];
  const agent = { session: { append: (type, data) => appended.push({ type, data }) } };
  let fellThrough = false;
  const decision = await preStep[0]({ agent, step: 1, turn: 1, signal, ...payload }, async () => {
    fellThrough = true;
    return { kind: 'enter', messages: payload.messages };
  });
  return { appended, decision, fellThrough };
}

const birdsLine = {
  id: 'm1',
  role: 'user',
  source: { kind: 'user' },
  content: [{ type: 'text', text: '/birds' }],
};
const taken = await runPreStep({ messages: [birdsLine] });
check('a bare /birds line is taken over', taken.fellThrough === false);
check('the takeover enters a step with no messages', taken.decision.kind === 'enter' && taken.decision.messages.length === 0, JSON.stringify(taken.decision));
check('the takeover records command/run', taken.appended[0]?.type === 'command/run', JSON.stringify(taken.appended[0]?.data));
check('the takeover records command/done', taken.appended[1]?.type === 'command/done', JSON.stringify(taken.appended[1]?.data));
check('command/run carries the birds name', taken.appended[0]?.data?.name === 'birds', taken.appended[0]?.data?.name);
check('command/done answers with a readable text', typeof taken.appended[1]?.data?.text === 'string' && taken.appended[1].data.text.length > 0, taken.appended[1]?.data?.text);
check('command/done reuses the run id', taken.appended[0]?.data?.commandId === taken.appended[1]?.data?.commandId);
check('the takeover leaves the turn without a user echo', taken.appended.every((e) => e.type !== 'user/message'));

const withImage = await runPreStep({
  messages: [{
    id: 'm2',
    role: 'user',
    source: { kind: 'user' },
    content: [
      { type: 'text', text: '/birds' },
      { type: 'image', attachment: { id: 'a1' } },
    ],
  }],
});
check('a /birds line with an image is also taken over', withImage.fellThrough === false);
check('the takeover attempts the image and reports back', typeof withImage.appended[1]?.data?.text === 'string' && withImage.appended[1].data.text.length > 0);

const plain = await runPreStep({ messages: [{ id: 'm3', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '这是什么鸟？' }] }] });
check('an ordinary prompt is left to the model', plain.fellThrough === true && plain.appended.length === 0);

const otherCommand = await runPreStep({ messages: [{ id: 'm4', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '/birdstatus' }] }] });
check('another command is left to the registry', otherCommand.fellThrough === true && otherCommand.appended.length === 0);

const batched = await runPreStep({ messages: [birdsLine, { id: 'm5', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }] }] });
check('a queued prompt beside /birds is never swallowed', batched.fellThrough === true && batched.appended.length === 0);

const midTurn = await runPreStep({ step: 2, messages: [birdsLine] });
check('a /birds line mid-turn is left alone', midTurn.fellThrough === true && midTurn.appended.length === 0);

const prefixed = await runPreStep({ messages: [{ id: 'm6', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '/birdsomething' }] }] });
check('a longer command name is not claimed', prefixed.fellThrough === true && prefixed.appended.length === 0);

// --- ordering against a wrapping listener ---
// The Host's own dsh-time-context listener awaits the inner chain and appends a
// context message to whatever came back. On a phone that turned an empty
// `enter` into a one-message decision, so the kernel started a real step and
// billed a model turn. Only the outermost position avoids it.
function composeWaterfall(steps, payload, inner) {
  const queue = [...steps];
  const dispatch = () => {
    const nextStep = queue.shift();
    if (nextStep === undefined) return inner();
    return nextStep(payload, () => dispatch());
  };
  return dispatch();
}

const timeContextLike = async (payload, next) => {
  const decision = await next();
  if (decision.kind === 'reject') return decision;
  return {
    ...decision,
    messages: [...decision.messages, { id: 'ctx', role: 'user', source: { kind: 'time-context' }, content: [] }],
  };
};

function preStepPayload() {
  const appended = [];
  const agent = { session: { append: (type, data) => appended.push({ type, data }) } };
  return { appended, payload: { agent, step: 1, turn: 1, signal, messages: [birdsLine] } };
}

const outermostRun = preStepPayload();
const outermostDecision = await composeWaterfall(
  [preStep[0], timeContextLike],
  outermostRun.payload,
  () => ({ kind: 'enter', messages: [birdsLine] }),
);
check('an outermost takeover leaves the turn with no messages', outermostDecision.kind === 'enter' && outermostDecision.messages.length === 0, JSON.stringify(outermostDecision).slice(0, 160));

const innerRun = preStepPayload();
const innerDecision = await composeWaterfall(
  [timeContextLike, preStep[0]],
  innerRun.payload,
  () => ({ kind: 'enter', messages: [birdsLine] }),
);
check('an inner takeover gets widened by a wrapping listener', innerDecision.messages.length === 1, innerDecision.messages.length);

// --- lifecycle disposer ---
check('lifecycle registered one teardown', effects.length >= 1, effects.length);
for (const dispose of effects) await dispose();

fs.rmSync(modelsDir, { recursive: true, force: true });
console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURES');
process.exit(failures === 0 ? 0 : 1);
