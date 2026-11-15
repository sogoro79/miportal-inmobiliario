import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = path => readFileSync(new URL('../public/' + path, import.meta.url), 'utf8');
const script = read('js/crm-import-guide.js');

for (const [page, section] of [
  ['admin', /<dialog id="crmDelegatedDialog"[\s\S]*?<\/dialog>/],
  ['perfil', /id="crmImportCard"[\s\S]*?id="crmFeedType"/],
  ['publicar', /<section class="publicar-ayuda"[\s\S]*?<\/section>/],
  ['planes', /<section class="planes-ayuda"[\s\S]*?<\/section>/]
]) {
  test(page + ' ofrece la guía compartida en su panel', () => {
    const html = read(page + '.html');
    assert.match(html.match(section)[0], /<button type="button"[^>]*data-crm-guide[^>]*>Guía de importación CRM<\/button>/);
    assert.equal(html.match(/src="\/js\/crm-import-guide.js"/g).length, 1);
    assert.match(html, /href="\/css\/crm-import-guide.css"/);
  });
}

function mount() {
  function button() {
    return { addEventListener(type, fn) { assert.equal(type, 'click'); this.click = fn; } };
  }
  const openers = [button(), button()];
  const close = button();
  const body = { scrollTop: 120 };
  const dialog = {
    setAttribute(name, value) { this[name] = value; },
    querySelector(selector) { return selector === 'button' ? close : body; },
    showModal() { this.open = true; },
    close() { this.open = false; }
  };
  const added = [];
  const document = {
    createElement(tag) { assert.equal(tag, 'dialog'); return dialog; },
    body: { append(element) { added.push(element); } },
    querySelectorAll(selector) { assert.equal(selector, '[data-crm-guide]'); return openers; }
  };
  // The isolated help UI has DOM access only; CRM clients, storage and fetch are unavailable.
  vm.runInNewContext(script, { document });
  return { added, dialog, openers, close, body };
}

test('ambos accesos abren el mismo diálogo desde el inicio y Cerrar lo cierra', () => {
  const { added, dialog, openers, close, body } = mount();
  assert.deepEqual(added, [dialog]);
  for (const opener of openers) {
    opener.click();
    assert.equal(dialog.open, true);
    assert.equal(body.scrollTop, 0);
    close.click();
    assert.equal(dialog.open, false);
  }
  assert.match(dialog.innerHTML, /autofocus>Cerrar/);
  assert.ok(dialog.innerHTML.includes('id="' + dialog['aria-labelledby'] + '"'));
});

test('siete pasos, límites, cinco estados y tres reglas importantes', () => {
  const { innerHTML } = mount().dialog;
  assert.equal(innerHTML.match(/<li><h3>/g).length, 7);
  assert.equal(innerHTML.match(/<dt>/g).length, 5);
  assert.equal(innerHTML.split('<aside')[1].match(/<li>/g).length, 3);
  for (const texto of ['Simular no publica nada.', '10 inmuebles en cada operación',
    'No repitas una importación que siga procesándose.', 'Simular no publica, modifica ni elimina ningún inmueble.']) {
    assert.ok(innerHTML.includes(texto));
  }
});

test('el diálogo limita su tamaño y el contenido tiene scroll independiente del cierre', () => {
  const css = read('css/crm-import-guide.css');
  assert.match(css, /width: min\(42rem, calc\(100% - 2rem\)\)/);
  assert.match(css, /max-height: 90dvh/);
  assert.match(css, /\.crm-guide-body\s*\{[^}]*overflow-y: auto/);
  assert.match(mount().dialog.innerHTML, /Cerrar<\/button>\s*<\/header>\s*<div class="crm-guide-body" tabindex="0"/);
});
