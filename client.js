window.__ModuleLoader__.load({
  id: 'dsh-birds',
  factory: function factory(require) {
    var module = { exports: {} };
    var exports = module.exports;

    var React = require('react');
    var h = React.createElement;

    // primitives 是宿主自带的组件库；万一这版宿主没有，就退回原生元素。
    var primitives = null;
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives');
    } catch (error) {
      primitives = null;
    }

    // 宿主侧 lib/im-patch-api.mjs 里的 ROUTE_PREFIX，两边必须一致。
    var API = '/api/dsh-birds/dsh-im';
    var OWN_ID = 'dsh-birds';

    var COLOR = {
      label: 'var(--dsw-alias-label-primary, #e9e9ec)',
      secondary: 'var(--dsw-alias-label-secondary, #b6b6bd)',
      tertiary: 'var(--dsw-alias-label-tertiary, #8b8b93)',
      border: 'var(--dsw-alias-border-l4, rgba(128, 128, 128, 0.28))',
      layer: 'var(--dsw-alias-bg-layer-1, transparent)',
      success: 'var(--dsw-alias-state-success-primary, #3fb950)',
      warn: 'var(--dsw-alias-state-warn-primary, #d29922)',
      error: 'var(--dsw-alias-state-error-primary, #f85149)',
    };

    /* ---------------- 纯展示逻辑：测试直接调用这两个函数 ---------------- */

    function summarize(payload) {
      var bundles = payload && Array.isArray(payload.bundles) ? payload.bundles : [];
      var patchedCount = 0;
      var backupCount = 0;
      var unsupported = [];
      for (var i = 0; i < bundles.length; i += 1) {
        var bundle = bundles[i] || {};
        if (bundle.patched) patchedCount += 1;
        if (Array.isArray(bundle.backups)) backupCount += bundle.backups.length;
        if (bundle.error) unsupported.push(bundle);
      }
      return {
        total: bundles.length,
        bundles: bundles,
        patchedCount: patchedCount,
        backupCount: backupCount,
        unsupported: unsupported,
        anyPatched: patchedCount > 0,
        allPatched: bundles.length > 0 && patchedCount === bundles.length,
      };
    }

    function cardModel(state, busy) {
      var phase = state && state.phase ? state.phase : 'loading';
      var data = state && state.data ? state.data : null;
      var model = {
        tone: 'idle',
        statusText: '',
        detailLines: [],
        canPatch: false,
        canRestore: false,
        pluginVersion: undefined,
        refreshedAt: undefined,
        hint:
          '改完要重启 DSH（或重开 App）才生效。dsh-im 升级或重装会覆盖补丁，回这里再点一次即可。',
      };

      if (!data) {
        if (phase === 'error') {
          model.tone = 'error';
          model.statusText = '读不到状态：' + (state && state.error ? state.error : '未知错误');
        } else {
          model.statusText = '正在读取 dsh-im 状态…';
        }
        return model;
      }

      model.pluginVersion = data.pluginVersion;
      var info = summarize(data);
      if (info.total === 0) {
        model.tone = 'warning';
        model.statusText = '没有找到 dsh-im（@xmanrui/dsh-im）';
        model.detailLines.push({ kind: 'muted', text: '装好 dsh-im 之后再回到这里，卡片会自动出现它的状态。' });
        return model;
      }

      if (info.allPatched) {
        model.tone = 'success';
        model.statusText = '已打补丁：引用里的图片会一起取回（' + info.total + ' 个 dsh-im）';
      } else if (info.anyPatched) {
        model.tone = 'warning';
        model.statusText = '部分打过补丁（' + info.patchedCount + '/' + info.total + '）';
      } else {
        model.tone = 'warning';
        model.statusText = '还没打补丁：QQ 群里引用一张图时，插件只能按文件名回查本机';
      }

      for (var i = 0; i < info.bundles.length; i += 1) {
        var bundle = info.bundles[i] || {};
        var line = bundle.displayPath || bundle.path || '(未知路径)';
        if (bundle.version) line += '  ·  dsh-im ' + bundle.version;
        line += bundle.patched ? '  ·  已打补丁' : '  ·  未打补丁';
        model.detailLines.push({ kind: 'path', text: line });
        if (bundle.error) model.detailLines.push({ kind: 'warn', text: bundle.error });
        if (Array.isArray(bundle.backups) && bundle.backups.length > 0) {
          var extra = bundle.backups.length > 1 ? '（另有 ' + (bundle.backups.length - 1) + ' 份）' : '';
          model.detailLines.push({
            kind: 'muted',
            text: '备份：' + (bundle.backups[0].displayPath || bundle.backups[0].path) + extra,
          });
        }
      }

      if (info.unsupported.length > 0) {
        model.detailLines.push({
          kind: 'warn',
          text: '有 ' + info.unsupported.length + ' 个 bundle 认不出来（这套补丁是按 dsh-im 5.8.0 的构建产物写的）。',
        });
      }

      model.canPatch = !busy && !info.allPatched;
      model.canRestore = !busy && info.backupCount > 0;
      if (busy) model.statusText = busy === 'patch' ? '正在写入补丁…' : '正在还原…';
      return model;
    }

    /* ------------------------------ 组件 ------------------------------ */

    function Dot(props) {
      if (primitives && primitives.StateDot) {
        return h(primitives.StateDot, { state: props.state, size: 'sm' });
      }
      var color =
        props.state === 'done'
          ? COLOR.success
          : props.state === 'warning'
            ? COLOR.warn
            : props.state === 'error'
              ? COLOR.error
              : COLOR.tertiary;
      return h('span', {
        style: {
          display: 'inline-block',
          width: '8px',
          height: '8px',
          borderRadius: '50%',
          background: color,
          flex: '0 0 auto',
        },
      });
    }

    function ActionButton(props) {
      if (primitives && primitives.Button) {
        return h(
          primitives.Button,
          {
            variant: props.variant,
            size: 'sm',
            disabled: props.disabled,
            onClick: props.onClick,
          },
          props.children,
        );
      }
      var primary = props.variant === 'primary';
      return h(
        'button',
        {
          type: 'button',
          disabled: props.disabled,
          onClick: props.onClick,
          style: {
            padding: '6px 12px',
            fontSize: '13px',
            borderRadius: 'var(--dsw-radius-md, 8px)',
            border: '1px solid ' + (primary ? 'transparent' : COLOR.border),
            background: primary ? 'var(--dsw-alias-button-primary-fill, #3b6cf0)' : 'transparent',
            color: primary ? '#fff' : COLOR.label,
            cursor: props.disabled ? 'default' : 'pointer',
            opacity: props.disabled ? 0.5 : 1,
          },
        },
        props.children,
      );
    }

    function Card() {
      var stateHook = React.useState({ phase: 'loading' });
      var state = stateHook[0];
      var setState = stateHook[1];
      var busyHook = React.useState(null);
      var busy = busyHook[0];
      var setBusy = busyHook[1];
      var noticeHook = React.useState(null);
      var notice = noticeHook[0];
      var setNotice = noticeHook[1];

      var load = React.useCallback(function () {
        setState(function (previous) {
          return { phase: 'loading', data: previous && previous.data ? previous.data : null };
        });
        fetch(API, { headers: { accept: 'application/json' }, credentials: 'same-origin' })
          .then(function (response) {
            return response.json().then(function (body) {
              return { response: response, body: body };
            });
          })
          .then(function (result) {
            if (!result.response.ok || !result.body || result.body.ok !== true) {
              throw new Error((result.body && result.body.error) || 'HTTP ' + result.response.status);
            }
            setState({ phase: 'ready', data: result.body });
          })
          .catch(function (error) {
            setState({ phase: 'error', error: (error && error.message) || String(error) });
          });
      }, []);

      React.useEffect(function () {
        load();
      }, [load]);

      function act(kind) {
        setBusy(kind);
        setNotice(null);
        fetch(API + '/' + kind, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
          .then(function (response) {
            return response.json().then(function (body) {
              return { response: response, body: body };
            });
          })
          .then(function (result) {
            var body = result.body || {};
            if (!result.response.ok || body.ok !== true) {
              throw new Error(body.error || 'HTTP ' + result.response.status);
            }
            var text;
            if (kind === 'patch') {
              text = body.changed > 0 ? '已写入 ' + body.changed + ' 个补丁，重启 DSH 后生效。' : '本来就已经打过补丁。';
            } else {
              text = body.restored > 0 ? '已还原 ' + body.restored + ' 个文件，重启 DSH 后生效。' : '没有可还原的备份。';
            }
            setNotice({ tone: 'success', text: text });
            setBusy(null);
            load();
          })
          .catch(function (error) {
            setNotice({ tone: 'error', text: (error && error.message) || String(error) });
            setBusy(null);
          });
      }

      var model = cardModel(state, busy);
      var children = [];

      children.push(
        h(
          'div',
          { key: 'head', style: { display: 'flex', alignItems: 'flex-start', gap: '10px' } },
          h('div', { style: { paddingTop: '5px' } }, h(Dot, { state: model.tone === 'success' ? 'done' : model.tone })),
          h(
            'div',
            { key: 'titles', style: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 } },
            h(
              'div',
              { style: { fontSize: '14px', fontWeight: 600, color: COLOR.label } },
              'dsh-im 引用图补丁',
            ),
            h(
              'div',
              { style: { fontSize: '12px', color: COLOR.tertiary, lineHeight: 1.5 } },
              'QQ 群里「引用」一张图时，让 /birds 也能取到那张图' +
                (model.pluginVersion ? '  ·  dsh-birds ' + model.pluginVersion : ''),
            ),
          ),
        ),
      );

      children.push(
        h(
          'div',
          { key: 'status', style: { fontSize: '13px', color: COLOR.secondary, lineHeight: 1.6 } },
          model.statusText,
        ),
      );

      if (model.detailLines.length > 0) {
        children.push(
          h(
            'div',
            { key: 'details', style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
            model.detailLines.map(function (line, index) {
              var color =
                line.kind === 'warn' ? COLOR.warn : line.kind === 'muted' ? COLOR.tertiary : COLOR.secondary;
              return h(
                'div',
                {
                  key: 'line-' + index,
                  style: {
                    fontSize: '12px',
                    color: color,
                    lineHeight: 1.5,
                    wordBreak: 'break-all',
                    fontFamily:
                      line.kind === 'path'
                        ? 'var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)'
                        : 'inherit',
                  },
                },
                line.text,
              );
            }),
          ),
        );
      }

      var buttons = [];
      buttons.push(h(ActionButton, { key: 'patch', variant: 'primary', disabled: !model.canPatch, onClick: function () { act('patch'); } }, '注入补丁'));
      buttons.push(h(ActionButton, { key: 'restore', variant: 'outline', disabled: !model.canRestore, onClick: function () { act('restore'); } }, '还原'));
      buttons.push(h(ActionButton, { key: 'refresh', variant: 'ghost', disabled: busy !== null, onClick: function () { load(); } }, '刷新'));
      children.push(
        h('div', { key: 'buttons', style: { display: 'flex', flexWrap: 'wrap', gap: '8px' } }, buttons),
      );

      if (notice) {
        children.push(
          h(
            'div',
            {
              key: 'notice',
              style: {
                fontSize: '12px',
                lineHeight: 1.5,
                color: notice.tone === 'error' ? COLOR.error : COLOR.success,
              },
            },
            notice.text,
          ),
        );
      }

      children.push(
        h(
          'div',
          { key: 'hint', style: { fontSize: '12px', color: COLOR.tertiary, lineHeight: 1.6 } },
          model.hint,
        ),
      );

      return h(
        'section',
        {
          'data-dsh-birds-settings': '1',
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
            padding: '14px',
            border: '1px solid ' + COLOR.border,
            borderRadius: 'var(--dsw-radius-lg, 12px)',
            background: COLOR.layer,
            boxSizing: 'border-box',
            width: '100%',
          },
        },
        children,
      );
    }

    // bundle 概览页会把 view 传进来；summary 视图返回 null，避免在折叠行里塞整张卡。
    function BundleCard(props) {
      if (props && props.view === 'summary') return null;
      return h(Card, props);
    }

    /* ---------------------------- 槽位注册 ---------------------------- */

    function registerSlots(ctx) {
      var slots = ctx && ctx.slots;
      if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return [];
      var registered = [];

      function install(slotName, definition) {
        slots.inject(slotName, function () {
          return slots.register(definition, BundleCard);
        });
        registered.push({ slot: slotName, definition: definition });
      }

      // 当前宿主（0.2.x）：插件管理页的包详情里，key 是 bundle 包名。
      install('plugins.bundle.config', { name: 'plugins.bundle.config', key: OWN_ID });
      // 行级槽：cordis.patch.yml 里的行 id 是 dsh-birds；历史上用过 birds，两个都注册。
      install('plugins.row.config', { name: 'plugins.row.config', key: OWN_ID + '#' + OWN_ID });
      install('plugins.row.config', { name: 'plugins.row.config', key: OWN_ID + '#birds' });
      // 旧宿主（<= 0.1.5）的设置页槽，留着向后兼容。
      install('settings.plugin.item', { name: 'settings.plugin.item', key: OWN_ID, order: 110 });

      return registered;
    }

    function apply(ctx) {
      registerSlots(ctx);
    }

    exports.inject = ['slots'];
    exports.apply = apply;
    exports.__test = {
      API: API,
      summarize: summarize,
      cardModel: cardModel,
      registerSlots: registerSlots,
      Card: Card,
      BundleCard: BundleCard,
    };

    return module.exports;
  },
});
