import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function loadClient(initial) {
  let loaded, registered, bound, calls = [];
  let snapshot = initial;
  const hookStates = [];
  let hookIndex = 0;
  const React = {
    createElement(type, props, ...children) { return { type, props: props ?? {}, children }; },
    useCallback(fn) { return fn; },
    useSyncExternalStore(subscribe, get) { return get(); },
    useState(value) {
      const index = hookIndex++;
      if (!(index in hookStates)) hookStates[index] = value;
      return [hookStates[index], value => { hookStates[index] = value; }];
    },
  };
  const scope = {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    async set(field, value) { calls.push({ field, value }); },
  };
  vm.runInNewContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load(module) { loaded = module.factory(() => React); } } },
  });
  loaded.apply({
    configForms: { get(namespace) { bound = { namespace }; return scope; } },
    locale: { register() {}, bind() { return key => key; } },
    slots: { inject(name, fn) { fn(); }, register(spec, Component) { registered = { spec, Component }; } },
  });
  return { loaded, bound, calls, scope, setSnapshot: value => { snapshot = value; },
    render() { hookIndex = 0; return registered.Component(registered.spec.inject()); } };
}
function inputs(tree) {
  if (!tree || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap(inputs);
  return [...(tree.type === 'input' ? [tree] : []), ...tree.children.flatMap(inputs)];
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('web switches read and write the native settings scope, never localStorage', async () => {
  const c = loadClient({ status: 'ready', mode: 'host', writable: true,
    value: { enabled: true, overrideCompaction: true, injectTools: true } });
  assert.equal(c.bound.namespace, 'context-management');
  assert.equal(inputs(c.render())[0].props.checked, true);
  inputs(c.render())[0].props.onChange({ target: { checked: false } });
  await tick();
  assert.equal(c.calls.length, 1); assert.equal(c.calls[0].field, 'enabled'); assert.equal(c.calls[0].value, false);
  // No optimistic false acknowledgement: render only the last accepted host value.
  assert.equal(inputs(c.render())[0].props.checked, true);
  c.setSnapshot({ status: 'ready', mode: 'host', writable: true, value: { enabled: false } });
  assert.equal(inputs(c.render())[0].props.checked, false);
});

test('web refuses unavailable or process-local writes, and surfaces backend errors', async () => {
  const c = loadClient({ status: 'loading', mode: 'memory', writable: false });
  assert.ok(inputs(c.render()).every(input => input.props.disabled));
  inputs(c.render())[0].props.onChange({ target: { checked: true } });
  assert.equal(c.calls.length, 0);
  c.setSnapshot({ status: 'ready', mode: 'host', writable: true, value: { enabled: true } });
  c.scope.set = async () => { throw new Error('Host rejected write'); };
  inputs(c.render())[0].props.onChange({ target: { checked: false } });
  await tick();
  assert.match(JSON.stringify(c.render()), /Host rejected write/);
  assert.equal(inputs(c.render())[0].props.checked, true);
});
