window.__ModuleLoader__.load({
  id: '@local/dsh-context-management',
  factory: function (require) {
    var React = require('react');
    var h = React.createElement;
    var namespace = 'context-management';
    var dictionaries = {
      zh: {
        title: '上下文管理',
        description: '设置应用于当前 DSH 实例的所有会话。笔记与历史按会话隔离。',
        enabled: '启用上下文管理',
        overrideCompaction: '使用 checkpoint 换窗',
        injectTools: '提供笔记与历史工具',
        active: '使用 checkpoint 与近期对话继续任务；旧内容可通过历史工具检索。',
        legacy: '当前使用 DSH 原生摘要压缩。',
        unavailable: '后端设置尚不可用，或当前连接不能修改设置。',
        loading: '正在读取后端状态…',
        saving: '正在保存…',
        commands: '/ctx 切换开关；/compact 执行当前压缩方式。',
        limits: '换窗只注入有限长度的 checkpoint；检索结果分页返回。',
      },
      en: {
        title: 'Context management',
        description: 'Settings apply to all sessions on this DSH instance. Notes and history stay isolated per session.',
        enabled: 'Enable context management',
        overrideCompaction: 'Use checkpoint windowing',
        injectTools: 'Provide notes and history tools',
        active: 'Continue from a checkpoint and recent conversation; retrieve earlier details with history tools.',
        legacy: 'DSH native summary compaction is active.',
        unavailable: 'Host settings are unavailable or this connection cannot modify them.',
        loading: 'Reading host state…',
        saving: 'Saving…',
        commands: '/ctx toggles the setting; /compact runs the current compaction mode.',
        limits: 'Checkpoints have a fixed size limit; history results are paginated.',
      },
    };

    function ContextSettings(props) {
      var scope = props.scope;
      var t = props.t;
      var snapshot = React.useSyncExternalStore(
        React.useCallback(function (listener) { return scope.subscribe(listener); }, [scope]),
        React.useCallback(function () { return scope.getSnapshot(); }, [scope])
      );
      var pending = React.useState(false);
      var busy = pending[0];
      var setBusy = pending[1];
      var errorState = React.useState('');
      var error = errorState[0];
      var setError = errorState[1];
      var value = snapshot.value;
      var writable = snapshot.status === 'ready' && snapshot.writable && snapshot.mode === 'host';
      function update(field, next) {
        if (busy || !writable) return;
        setBusy(true);
        setError('');
        return scope.set(field, next).catch(function (failure) {
          setError(String(failure.message || failure));
        }).finally(function () { setBusy(false); });
      }
      var active = value && value.enabled && value.injectTools && value.overrideCompaction;
      return h('section', { style: { padding: '16px 24px', maxWidth: 640 }, 'aria-busy': busy },
        h('h2', null, t('title')),
        h('p', null, t('description')),
        snapshot.status === 'loading' ? h('p', { role: 'status' }, t('loading')) : null,
        !writable && snapshot.status !== 'loading' ? h('p', { role: 'status' }, t('unavailable')) : null,
        ['enabled', 'overrideCompaction', 'injectTools'].map(function (field) {
          return h('label', { key: field, style: { display: 'flex', gap: 12, padding: '10px 0', alignItems: 'center' } },
            h('input', { type: 'checkbox', checked: Boolean(value && value[field]), disabled: !writable || busy,
              onChange: function (event) { update(field, event.target.checked); } }), t(field));
        }),
        value ? h('p', { role: 'status' }, busy ? t('saving') : t(active ? 'active' : 'legacy')) : null,
        error ? h('p', { role: 'alert' }, error) : null,
        h('p', null, t('commands')),
        h('p', null, t('limits'))
      );
    }

    function apply(ctx) {
      var scope = ctx.configForms.get(namespace);
      ctx.locale.register(namespace, dictionaries);
      var t = ctx.locale.bind(namespace);
      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register({
          name: 'settings.section', id: namespace, order: 22,
          label: function () { return t('title'); }, locale: namespace,
          inject: function () { return { scope: scope, t: t }; },
        }, ContextSettings);
      });
    }
    return { name: namespace, inject: ['slots', 'locale', 'configForms'], apply: apply };
  },
});
