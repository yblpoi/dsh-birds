import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { recognizeFile, resolveExistingFile } from '../recognize.mjs';
import { resolveModelsDir } from '../paths.mjs';

/**
 * Minimal Telegram Bot API bridge.
 *
 * Written directly against the HTTP API instead of the GramJS/telegraf stack so
 * the plugin keeps a single runtime dependency (onnxruntime-node) on a phone.
 *
 * The bridge owns the whole reply path: it answers recognised media locally and
 * never forwards to the Harness, so a bird photo costs zero tokens.
 */
export class TelegramBirdBridge {
  #token;
  #engines;
  #logger;
  #options;
  #offset = 0;
  #running = false;
  #abort;

  constructor({ token, engines, logger, options = {} }) {
    this.#token = token;
    this.#engines = engines;
    this.#logger = logger;
    this.#options = {
      allowedUserIds: options.allowedUserIds ?? [],
      triggerWords: options.triggerWords ?? ['鸟', 'bird', '识别', '认鸟'],
      geo: options.geo ?? null,
      topK: options.topK ?? 5,
      minConfidence: options.minConfidence ?? 0.15,
      // The gate is model contract, not taste: the bridge must apply it exactly
      // as /birds does, otherwise the same photo would get two different answers
      // depending on which door it came through.
      gateEnabled: options.gateEnabled !== false,
      gateConfidence: options.gateConfidence ?? 0.25,
      gateMargin: options.gateMargin ?? 0.25,
      gateMinBoxPx: options.gateMinBoxPx ?? 48,
      gateWeakBird: options.gateWeakBird ?? 0.5,
      maxFileBytes: options.maxFileBytes ?? 20 * 1024 * 1024,
      apiBase: options.apiBase ?? 'https://api.telegram.org',
    };
  }

  get running() {
    return this.#running;
  }

  async #call(method, payload) {
    const response = await fetch(`${this.#options.apiBase}/bot${this.#token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload ?? {}),
      signal: this.#abort?.signal,
    });
    const body = await response.json().catch(() => ({}));
    if (!body.ok) {
      throw new Error(`Telegram ${method} failed: ${body.description ?? response.status}`);
    }
    return body.result;
  }

  async start() {
    if (this.#running) return;
    this.#running = true;
    this.#abort = new AbortController();
    // A stale webhook makes getUpdates fail with 409, so clear it once.
    await this.#call('deleteWebhook', { drop_pending_updates: false }).catch((error) => {
      this.#logger?.debug?.('deleteWebhook: ' + (error?.message ?? error));
    });
    void this.#loop();
    this.#logger?.info?.('telegram bird bridge started');
  }

  async stop() {
    this.#running = false;
    this.#abort?.abort();
  }

  async #loop() {
    let backoff = 1000;
    while (this.#running) {
      try {
        const updates = await this.#call('getUpdates', {
          offset: this.#offset,
          timeout: 30,
          allowed_updates: ['message'],
        });
        backoff = 1000;
        for (const update of updates ?? []) {
          this.#offset = update.update_id + 1;
          try {
            await this.#handle(update.message);
          } catch (error) {
            this.#logger?.warn?.('telegram message failed: ' + (error?.stack ?? error));
            const chatId = update.message?.chat?.id;
            if (chatId) await this.#send(chatId, '识别失败：' + (error?.message ?? error)).catch(() => {});
          }
        }
      } catch (error) {
        if (!this.#running) return;
        this.#logger?.warn?.('telegram poll failed: ' + (error?.message ?? error));
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 30_000);
      }
    }
  }

  #allowed(userId) {
    const list = this.#options.allowedUserIds;
    return !Array.isArray(list) || list.length === 0 || list.includes(userId);
  }

  async #handle(message) {
    if (!message) return;
    const userId = message.from?.id;
    if (!this.#allowed(userId)) {
      await this.#send(message.chat.id, '当前用户不在允许名单内。');
      return;
    }
    const text = (message.text ?? message.caption ?? '').trim();
    const wantsRecognition = this.#options.triggerWords.some((word) => text.toLowerCase().includes(word.toLowerCase()))
      || /^\/(birds|bird|鸟)\b/i.test(text);

    const media = message.photo?.length
      ? { kind: 'photo', fileId: message.photo[message.photo.length - 1].file_id, ext: '.jpg' }
      : message.document
        ? { kind: 'document', fileId: message.document.file_id, ext: path.extname(message.document.file_name ?? '') || '' }
        : message.voice
          ? { kind: 'voice', fileId: message.voice.file_id, ext: '.ogg' }
          : message.audio
            ? { kind: 'audio', fileId: message.audio.file_id, ext: path.extname(message.audio.file_name ?? '') || '.mp3' }
            : message.video_note
              ? { kind: 'video_note', fileId: message.video_note.file_id, ext: '.mp4' }
              : message.video
                ? { kind: 'video', fileId: message.video.file_id, ext: '.mp4' }
                : null;

    if (!media) {
      if (wantsRecognition) {
        await this.#send(message.chat.id, '发一张鸟的照片、或一段鸟鸣录音给我，我会在本机直接识别（不消耗 token）。');
      }
      return;
    }
    if (!wantsRecognition && !this.#options.recognizeEveryMedia) {
      // Media without the trigger word is left to the normal Harness flow so a
      // photo the user means for the LLM is not hijacked.
      return;
    }
    await this.#send(message.chat.id, '正在本机识别…');
    const file = await this.#download(media);
    try {
      const result = await recognizeFile(this.#engines, file, {
        topK: this.#options.topK,
        minConfidence: this.#options.minConfidence,
        geo: this.#options.geo,
        gateEnabled: this.#options.gateEnabled,
        gateConfidence: this.#options.gateConfidence,
        gateMargin: this.#options.gateMargin,
        gateMinBoxPx: this.#options.gateMinBoxPx,
        gateWeakBird: this.#options.gateWeakBird,
        logger: this.#logger,
      });
      await this.#send(message.chat.id, result.text, { markdown: false });
    } finally {
      await fs.rm(file, { force: true }).catch(() => {});
    }
  }

  async #download(media) {
    const info = await this.#call('getFile', { file_id: media.fileId });
    if (info.file_size && info.file_size > this.#options.maxFileBytes) {
      throw new Error(`文件过大（${(info.file_size / 1048576).toFixed(1)} MB），上限 ${(this.#options.maxFileBytes / 1048576).toFixed(0)} MB。`);
    }
    const url = `${this.#options.apiBase}/file/bot${this.#token}/${info.file_path}`;
    const response = await fetch(url, { signal: this.#abort?.signal });
    if (!response.ok) throw new Error('下载文件失败：HTTP ' + response.status);
    const buffer = Buffer.from(await response.arrayBuffer());
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-birds-'));
    const file = path.join(dir, 'media' + (media.ext || path.extname(info.file_path ?? '') || '.bin'));
    await fs.writeFile(file, buffer);
    return file;
  }

  async #send(chatId, text, { markdown = false } = {}) {
    const chunks = splitMessage(text, 3800);
    for (const chunk of chunks) {
      await this.#call('sendMessage', {
        chat_id: chatId,
        text: chunk,
        parse_mode: markdown ? 'Markdown' : undefined,
        disable_web_page_preview: true,
      });
    }
  }
}

function splitMessage(text, limit) {
  if (text.length <= limit) return [text];
  const out = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < limit * 0.5) cut = limit;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest) out.push(rest);
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
