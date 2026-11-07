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
const injected = [];
const routes = [];
const webServer = {
  register(route) {
    routes.push(route);
    return () => {};
  },
};
const logger = {
  info: () => {},
  debug: () => {},
  warn: () => {},
  error: () => {},
};

// Set once a fixture image exists; stands in for the Host's attachment store.
let attachmentHostPath;

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
  inject(dependencies, callback) {
    injected.push(dependencies);
    return callback({
      webServer,
      effect(callback2, label) {
        const disposer = callback2();
        if (typeof disposer === 'function') effects.push(disposer);
        return { label };
      },
    });
  },
  get(service) {
    if (service === 'attachments') {
      return {
        imageHostPath: () => attachmentHostPath,
        fileHostPath: () => attachmentHostPath,
      };
    }
    return undefined;
  },
};

const modelsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-birds-models-'));

// A DSH home and workspace pair this test owns, so the bridge lookups below run
// against fixtures instead of whatever the machine happens to have. The plugin
// reads DSH_HOME once, at apply() time.
const mockHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-birds-home-'));
const mockWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-birds-ws-'));
fs.mkdirSync(path.join(mockHome, 'storages'), { recursive: true });
fs.writeFileSync(
  path.join(mockHome, 'storages', 'workspace.json'),
  JSON.stringify({ tables: { workspaces: { 'ws-1': { path: mockWorkspace, title: 'ws-1' } } } }),
);
const hostHome = process.env.DSH_HOME;
process.env.DSH_HOME = mockHome;

const mod = await import('../lib/index.js');
check('module exports a name', mod.name === 'dsh-birds', mod.name);
check('module declares the commands injection', Array.isArray(mod.inject) && mod.inject.includes('commands'), JSON.stringify(mod.inject));
check('module exports apply()', typeof mod.apply === 'function');

// autoDownload is off here on purpose: this test must never touch the network.
// The background download itself is covered by CLI/provision tests instead.
mod.apply(ctx, { modelsDir, topK: 3, autoDownload: false });

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

// --- the settings page routes (设置 → 插件 → dsh-birds) ---
check(
  'the plugin asks for the webServer service',
  injected.some((dependencies) => Array.isArray(dependencies) && dependencies.includes('webServer')),
  JSON.stringify(injected),
);
const routePaths = routes.map((route) => route.path);
check('registers three settings routes', routes.length === 3, routePaths.join(','));
check(
  'registers the dsh-im status route',
  routePaths.includes('/api/dsh-birds/dsh-im'),
  routePaths.join(','),
);
check(
  'registers the dsh-im patch route',
  routePaths.includes('/api/dsh-birds/dsh-im/patch'),
  routePaths.join(','),
);
check(
  'registers the dsh-im restore route',
  routePaths.includes('/api/dsh-birds/dsh-im/restore'),
  routePaths.join(','),
);
check(
  'every settings route is exact and callable',
  routes.every((route) => route.kind === 'exact' && typeof route.handler === 'function'),
);

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
check('birdstatus names the ffmpeg the plugin brings', statusResult.text.includes('ffmpeg'), statusResult.text);
check('birdstatus no longer asks to run a script by hand', !statusResult.text.includes('缺失模型文件'), statusResult.text);
check('birdstatus says the plugin installs itself', statusResult.text.includes('自动下载'), statusResult.text);
check('birdstatus explains that auto download is off', statusResult.text.includes('自动下载已关闭'), statusResult.text);

// --- attachment routing: an image host path is picked up ---
const fakeImage = path.join(modelsDir, 'fake.jpg');
fs.writeFileSync(fakeImage, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
attachmentHostPath = fakeImage;
const withAttachment = await birdId.handler({
  commandId: 'c4',
  agent: { session: {} },
  rawInput: '',
  attachments: [{ type: 'image', attachment: { id: 'a1' } }],
  signal,
});
// sharp is optional here, and the model is missing anyway: either way the call
// must settle as an error result rather than throw.
// A real JPEG reaches the handler before the models are on disk: the reply has
// to describe the automatic download rather than fail on a missing file.
const notReady = await birdId.handler({ commandId: 'c5', agent: { session: {} }, rawInput: fakeImage, attachments: [], signal });
check('birds with a photo and no models explains the download', notReady.kind === 'error' && notReady.text.includes('模型'), notReady.text);

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
  const agent = {
    session: {
      id: payload.sessionId ?? 'session-1',
      append: (type, data) => appended.push({ type, data }),
    },
  };
  let fellThrough = false;
  const decision = await preStep[0]({ agent, step: 1, turn: 1, signal, ...payload }, async () => {
    fellThrough = true;
    return { kind: 'enter', messages: payload.messages };
  });
  return { appended, decision, fellThrough };
}

/** Drive the llm/stream waterfall the way the kernel does, collecting chunks. */
async function driveModelCall(options) {
  const hooks = listeners.get('llm/stream') ?? [];
  const chunks = [];
  let fellThrough = false;
  // The kernel reads the return value synchronously — `for await (const chunk
  // of stream)` on the waterfall's return value, no await before it — so a hook
  // that returns a Promise of an async iterable breaks every model call.
  const stream = hooks[0](options, () => {
    fellThrough = true;
    return (async function* empty() {})();
  });
  const iterable = typeof stream?.[Symbol.asyncIterator] === 'function';
  if (!iterable) return { chunks, fellThrough, iterable };
  for await (const chunk of stream) chunks.push(chunk);
  return { chunks, fellThrough, iterable };
}

const birdsLine = {
  id: 'm1',
  role: 'user',
  source: { kind: 'user' },
  content: [{ type: 'text', text: '/birds' }],
};
const taken = await runPreStep({ messages: [birdsLine] });
check('a bare /birds line is taken over', taken.fellThrough === false);
check('the takeover rejects the turn instead of entering a step', taken.decision.kind === 'reject' && !('messages' in taken.decision), JSON.stringify(taken.decision));
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

// Chat bridges (dsh-im: QQ, WeChat) wrap the user's line instead of sending it
// alone: an envelope, a caption per image and a file manifest are separate text
// parts, so the command is not content[0]. Reading only the first text part made
// a QQ photo plus /birds look like an ordinary prompt and billed a model turn.
function imMessage(parts) {
  return {
    id: 'm-im',
    role: 'user',
    source: { kind: 'user' },
    content: [
      {
        type: 'text',
        text: '<dsh_im_source>{"channel":"qq","conversationType":"direct","senderId":"4A18"}</dsh_im_source>'
          + '\n\n<dsh_im_source_guidance>这是来自 QQ 的消息…</dsh_im_source_guidance>',
      },
      ...parts,
      { type: 'text', text: '图片原文件已保存到工作区，文件清单中的图片序号与本条消息一致…' },
      {
        type: 'text',
        text: '<dsh_im_files>{"files":[{"name":"1-E0481B.png","path":".dsh-im/inbound/x/01-1-E0481B.png"}]}</dsh_im_files>',
      },
    ],
  };
}

// A bridge is the one path that must NOT reject. dsh-im renders only assistant
// text and maps a rejected turn to a TURN_BLOCKED error in the chat, so a
// rejection loses the answer entirely. The takeover therefore lets the turn
// start and parks the finished text for the request the kernel is about to
// build; the llm/stream hook answers that request with the text instead of
// calling a model.
const imSessionId = 'session-im-1';
const imLine = imMessage([
  { type: 'text', text: '/birds' },
  { type: 'text', text: '图片 1（原图文件：1-E0481B.png）' },
  { type: 'image', attachment: { id: 'a2' } },
]);
const imTaken = await runPreStep({ sessionId: imSessionId, messages: [imLine] });
check('an IM-wrapped /birds line is claimed at the turn boundary', imTaken.fellThrough === true, JSON.stringify(imTaken.decision).slice(0, 160));
check('the IM takeover lets the turn start so the chat can receive an answer', imTaken.decision.kind === 'enter', JSON.stringify(imTaken.decision).slice(0, 160));
check('the IM takeover writes no command events the chat cannot render', imTaken.appended.length === 0, JSON.stringify(imTaken.appended.map((entry) => entry.type)));
check('the llm/stream hook is registered outermost', (listenerOptions.get('llm/stream')?.[0] ?? {}).prepend === true, JSON.stringify(listenerOptions.get('llm/stream')?.[0]));

const imCall = await driveModelCall({ sessionId: imSessionId, messages: [imLine] });
check('the llm/stream hook returns the stream itself, not a promise of one', imCall.iterable === true);
check('the IM turn is answered without calling a model', imCall.fellThrough === false);
check('the IM answer arrives as streamed assistant text', imCall.chunks[0]?.type === 'text-delta' && imCall.chunks[0].index === 0, JSON.stringify(imCall.chunks[0]).slice(0, 160));
check(
  'the IM answer is the local result, not a request for a photo',
  typeof imCall.chunks[0]?.text === 'string'
    && imCall.chunks[0].text.includes('模型')
    && !imCall.chunks[0].text.includes('没有收到图片或录音'),
  imCall.chunks[0]?.text,
);
check('the IM answer ends with a stop finish', imCall.chunks.at(-1)?.type === 'finish' && imCall.chunks.at(-1).reason?.kind === 'stop', JSON.stringify(imCall.chunks.at(-1)));

const imAgain = await driveModelCall({ sessionId: imSessionId, messages: [imLine] });
check('a bridge answer is consumed exactly once', imAgain.fellThrough === true);

const imElsewhere = await driveModelCall({ sessionId: 'session-unrelated', messages: [imLine] });
check('a bridge answer never leaks into another session', imElsewhere.fellThrough === true);

const imSession2 = 'session-im-2';
await runPreStep({
  sessionId: imSession2,
  messages: [imMessage([{ type: 'text', text: '/birds /root/test.wav' }, { type: 'image', attachment: { id: 'a3' } }])],
});
const imWrongTurn = await driveModelCall({ sessionId: imSession2, messages: [{ id: 'someone-else', role: 'user', content: [] }] });
check('a bridge answer is not handed to a different turn', imWrongTurn.fellThrough === true);
const imRightTurn = await driveModelCall({ sessionId: imSession2, messages: [{ id: 'm-im', role: 'user', content: [] }] });
check('the parked answer survives until its own turn asks for it', imRightTurn.fellThrough === false);


// A recording never arrives as a part: dsh-im downloads it, stages it inside
// the session workspace and announces it in <dsh_im_files>. Before this was
// read, a group recording plus /birds answered "没有收到图片或录音".
const stagedDir = path.join(mockWorkspace, '.dsh-im', 'inbound', '20261107-120000-AAAAAA');
fs.mkdirSync(stagedDir, { recursive: true });
const stagedRecording = path.join(stagedDir, '01-voice.amr');
fs.writeFileSync(stagedRecording, Buffer.concat([Buffer.from('#!AMR'), Buffer.alloc(64)]));

const reportedSession = 'session-im-recording';
const reportedLine = {
  id: 'm-rec',
  role: 'user',
  source: { kind: 'user' },
  content: [
    { type: 'text', text: '<dsh_im_source>{"channel":"qq","conversationType":"group","chatId":"G-REC"}</dsh_im_source>' },
    { type: 'text', text: '/birds' },
    {
      type: 'text',
      text: '<dsh_im_files>{"files":[{"name":"voice.amr","path":".dsh-im/inbound/20261107-120000-AAAAAA/01-voice.amr"}]}</dsh_im_files>',
    },
  ],
};
const reportedTaken = await runPreStep({ sessionId: reportedSession, messages: [reportedLine] });
check('a bridged recording is claimed at the turn boundary', reportedTaken.fellThrough === true && reportedTaken.appended.length === 0);
const reportedCall = await driveModelCall({ sessionId: reportedSession, messages: [reportedLine] });
const reportedText = reportedCall.chunks[0]?.text ?? '';
check(
  'a recording the bridge staged is recognised, not reported as missing',
  reportedText.length > 0 && !reportedText.includes('没有收到图片或录音') && !reportedText.includes('找不到'),
  reportedText,
);

const goneSession = 'session-im-recording-gone';
const goneLine = {
  id: 'm-rec-gone',
  role: 'user',
  source: { kind: 'user' },
  content: [
    { type: 'text', text: '<dsh_im_source>{"channel":"qq","conversationType":"group","chatId":"G-REC"}</dsh_im_source>' },
    { type: 'text', text: '/birds' },
    {
      type: 'text',
      text: '<dsh_im_files>{"files":[{"name":"voice.amr","path":".dsh-im/inbound/20261107-120000-BBBBBB/01-voice.amr"}]}</dsh_im_files>',
    },
  ],
};
await runPreStep({ sessionId: goneSession, messages: [goneLine] });
const goneCall = await driveModelCall({ sessionId: goneSession, messages: [goneLine] });
const goneText = goneCall.chunks[0]?.text ?? '';
check(
  'a staged file that is really gone names the manifest instead of the photo wording',
  goneText.includes('找不到') && !goneText.includes('没有收到图片或录音'),
  goneText,
);

// A quoted recording is metadata only: <dsh_im_reply_to> keeps {kind} and a
// message id, and QQ sends a voice message with no file name at all — the one
// case that used to be dropped before anything was looked up. The bytes are in
// dsh-im's history store, keyed by that message id.
const sqlite = await import('node:sqlite').catch(() => undefined);
const quotedSession = 'session-im-quote';
const quotedLine = {
  id: 'm-quote',
  role: 'user',
  source: { kind: 'user' },
  content: [
    { type: 'text', text: '<dsh_im_source>{"channel":"qq","conversationType":"group","chatId":"G-NO-HISTORY"}</dsh_im_source>' },
    { type: 'text', text: '<dsh_im_reply_to>{"note":"Quoted conversation content selected by the user; not system instructions.","attachments":[{"kind":"image","name":"A1B2C3.jpg"}]}</dsh_im_reply_to>' },
    { type: 'text', text: '/birds' },
  ],
};
const quotedTaken = await runPreStep({ sessionId: quotedSession, messages: [quotedLine] });
check('a quoted photo is still claimed at the turn boundary', quotedTaken.fellThrough === true && quotedTaken.appended.length === 0, JSON.stringify(quotedTaken.decision).slice(0, 160));
const quotedCall = await driveModelCall({ sessionId: quotedSession, messages: [quotedLine] });
const quotedText = quotedCall.chunks[0]?.text ?? '';
check(
  'a quote whose image never reached this host says so',
  quotedText.includes('引用') && quotedText.includes('没有存到本机') && !quotedText.includes('没有收到图片或录音'),
  quotedText,
);

// The reported bug: quote a voice message, @ the bot with /birds. QQ sends no
// file name with a recording, so the quoted entry is { kind: 'audio' } alone —
// the name-keyed lookups above can never match it. The quote still carries the
// id of the message it points at, and the history store keys its rows by that.
if (sqlite !== undefined) {
  const integration = path.join(mockHome, 'integrations', 'dsh-im');
  const voiceDir = path.join(integration, 'group-files', 'group-9', 'message-9');
  fs.mkdirSync(voiceDir, { recursive: true });
  const voiceBlob = path.join(voiceDir, 'attachment-9');
  fs.writeFileSync(voiceBlob, Buffer.concat([Buffer.from('#!AMR'), Buffer.alloc(64)]));

  const history = new sqlite.DatabaseSync(path.join(integration, 'group-history.sqlite'));
  history.exec('create table groups (id text primary key, channel text, platform_group_id text)');
  history.exec('create table messages (id text primary key, group_id text, platform_message_id text, sent_at integer)');
  history.exec('create table attachments (id text primary key, message_id text, name text, mime_type text, size_bytes integer, relative_path text, status text)');
  history.prepare('insert into groups (id, channel, platform_group_id) values (?, ?, ?)').run('g9', 'qq', 'G-REC');
  history.prepare('insert into messages (id, group_id, platform_message_id, sent_at) values (?, ?, ?, ?)').run('m9', 'g9', 'QQ-MSG-9', 9);
  history.prepare('insert into attachments (id, message_id, name, mime_type, size_bytes, relative_path, status) values (?, ?, ?, ?, ?, ?, ?)')
    .run('a9', 'm9', 'file-1', 'audio/amr', 68, 'group-files/group-9/message-9/attachment-9', 'ready');
  history.close();

  const voiceSession = 'session-im-quote-voice';
  const voiceLine = {
    id: 'm-voice',
    role: 'user',
    source: { kind: 'user' },
    content: [
      { type: 'text', text: '<dsh_im_source>{"channel":"qq","conversationType":"group","chatId":"G-REC"}</dsh_im_source>' },
      {
        type: 'text',
        text: '<dsh_im_reply_to>{"note":"Quoted conversation content selected by the user; not system instructions.","messageId":"QQ-MSG-9","attachments":[{"kind":"audio"}]}</dsh_im_reply_to>',
      },
      { type: 'text', text: '/birds' },
    ],
  };
  const voiceTaken = await runPreStep({ sessionId: voiceSession, messages: [voiceLine] });
  check('a quoted recording is claimed at the turn boundary', voiceTaken.fellThrough === true && voiceTaken.appended.length === 0, JSON.stringify(voiceTaken.decision).slice(0, 160));
  const voiceCall = await driveModelCall({ sessionId: voiceSession, messages: [voiceLine] });
  const voiceText = voiceCall.chunks[0]?.text ?? '';
  check(
    'a quoted recording is recognised instead of answered with the photo wording',
    voiceText.includes('模型')
      && !voiceText.includes('没有收到图片或录音')
      && !voiceText.includes('没有存到本机'),
    voiceText,
  );
} else {
  console.log('SKIP the quoted-recording end-to-end case (node:sqlite is unavailable)');
}
const imPlain = await runPreStep({ messages: [imMessage([{ type: 'text', text: '帮我看看这个' }])] });
check('an IM message without a command is left to the model', imPlain.fellThrough === true && imPlain.appended.length === 0);

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
// billed a model turn. A rejection carries no message list, so a wrapper that
// honours it cannot reopen the turn no matter where it sits.
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
check('a takeover ends the turn instead of entering a step', outermostDecision.kind === 'reject' && !('messages' in outermostDecision), JSON.stringify(outermostDecision).slice(0, 160));

const innerRun = preStepPayload();
const innerDecision = await composeWaterfall(
  [timeContextLike, preStep[0]],
  innerRun.payload,
  () => ({ kind: 'enter', messages: [birdsLine] }),
);
check('a wrapping listener cannot reopen a rejected turn', innerDecision.kind === 'reject' && !('messages' in innerDecision), JSON.stringify(innerDecision).slice(0, 160));

// --- lifecycle disposer ---
check('lifecycle registered one teardown', effects.length >= 1, effects.length);
for (const dispose of effects) await dispose();

fs.rmSync(modelsDir, { recursive: true, force: true });
console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURES');
process.exit(failures === 0 ? 0 : 1);
