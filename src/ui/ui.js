// Small DOM toolkit: menus, modal dialogs, toasts and the PropertyManager form builder.
import { icon } from './icons.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) e.append(c.nodeType ? c : document.createTextNode(c));
  return e;
}
export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function toast(msg, isErr = false, ms = 3500) {
  const d = el('div', { class: isErr ? 'err' : '', text: msg });
  $('#toast').append(d);
  setTimeout(() => d.remove(), isErr ? ms * 1.6 : ms);
}
export function setHint(t) {
  $('#hint').textContent = t;
}

// ---------------------------------------------------------------- popup menus
let openMenu = null;
export function closeMenu() {
  if (openMenu) {
    openMenu.remove();
    openMenu = null;
    document.querySelectorAll('#menubar button.open').forEach((b) => b.classList.remove('open'));
  }
}
export function popup(items, x, y) {
  closeMenu();
  const m = el('div', { class: 'menu' });
  for (const it of items) {
    if (!it) continue;
    if (it === '-') {
      m.append(el('div', { class: 'msep' }));
      continue;
    }
    const b = el('button', { class: 'mi', disabled: it.disabled, html: `${it.icon ? icon(it.icon) : '<svg></svg>'}<span>${esc(it.label)}</span>${it.key ? `<kbd>${esc(it.key)}</kbd>` : ''}` });
    b.addEventListener('click', () => {
      closeMenu();
      it.action && it.action();
    });
    m.append(b);
  }
  document.body.append(m);
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(2, Math.min(x, innerWidth - r.width - 4)) + 'px';
  m.style.top = Math.max(2, Math.min(y, innerHeight - r.height - 4)) + 'px';
  openMenu = m;
  return m;
}
document.addEventListener('pointerdown', (e) => {
  if (openMenu && !openMenu.contains(e.target) && !e.target.closest('#menubar')) closeMenu();
}, true);

// ---------------------------------------------------------------- modal dialogs
export function modal({ title, body, buttons = [{ label: 'OK', primary: true }], wide = false }) {
  return new Promise((resolve) => {
    const host = $('#modal');
    const bodyEl = el('div', { class: 'body' });
    if (typeof body === 'string') bodyEl.innerHTML = body;
    else if (body) bodyEl.append(body);
    const foot = el('div', { class: 'foot' });
    const close = (v) => {
      host.hidden = true;
      host.innerHTML = '';
      resolve(v);
    };
    for (const b of buttons) {
      foot.append(el('button', { class: 'btn' + (b.primary ? ' primary' : ''), text: b.label, onclick: async () => {
        const v = b.action ? await b.action(bodyEl) : b.value ?? b.label;
        if (v !== false) close(v);
      } }));
    }
    host.innerHTML = '';
    host.append(el('div', { class: 'dlg' + (wide ? ' wide' : '') }, el('h3', { text: title }), bodyEl, foot));
    host.hidden = false;
    host.onclick = (e) => {
      if (e.target === host) close(null);
    };
    const first = bodyEl.querySelector('input,select,textarea');
    if (first) setTimeout(() => first.focus(), 30);
  });
}
export const alertDlg = (title, html) => modal({ title, body: html });
export const confirmDlg = (title, html) => modal({ title, body: html, buttons: [{ label: 'Cancel', value: false }, { label: 'OK', primary: true, value: true }] });
export async function promptDlg(title, label, value = '') {
  const inp = el('input', { type: 'text', value, style: { width: '100%', padding: '6px' } });
  const r = await modal({ title, body: el('div', {}, el('p', { text: label, style: { margin: '0 0 8px' } }), inp), buttons: [{ label: 'Cancel', value: null }, { label: 'OK', primary: true, action: () => inp.value }] });
  return r;
}

// ---------------------------------------------------------------- PropertyManager
// spec = { title, icon, message, fields:[...], onChange(vals, key), onOK(vals), onCancel(), okLabel }
// field = { key, label, type, group, options, accept, multi, show(vals), min, max, step, placeholder, html, buttons }
let currentPM = null;
export function pmActive() {
  return currentPM;
}
export function closePM(commit = false) {
  if (!currentPM) return;
  const pm = currentPM;
  currentPM = null;
  $('#pm').innerHTML = '';
  showLeft('tree');
  if (commit) pm.spec.onOK && pm.spec.onOK(pm.vals);
  else pm.spec.onCancel && pm.spec.onCancel();
  pm.spec.onClose && pm.spec.onClose();
}
export function showLeft(tab) {
  for (const b of document.querySelectorAll('#left-tabs button')) b.classList.toggle('active', b.dataset.tab === tab);
  $('#tree').hidden = tab !== 'tree';
  $('#pm').hidden = tab !== 'pm';
}

export function openPM(spec, vals = {}) {
  if (currentPM) closePM(false);
  const host = $('#pm');
  host.innerHTML = '';
  const pm = { spec, vals, activeSel: null, els: {}, refresh, setError, setMessage, pick };
  currentPM = pm;
  const head = el('div', { class: 'pm-head' }, el('span', { html: icon(spec.icon || 'options') }), el('span', { text: spec.title }), el('span', { class: 'sp' }));
  if (!spec.noOK) head.append(el('button', { class: 'ok', title: 'OK (Enter)', text: '✔', onclick: () => closePM(true) }));
  head.append(el('button', { class: 'cancel', title: spec.noOK ? 'Close (Esc)' : 'Cancel (Esc)', text: '✖', onclick: () => closePM(false) }));
  const msg = el('div', { class: 'pm-msg', text: spec.message || '', hidden: !spec.message });
  const err = el('div', { class: 'pm-err', hidden: true });
  const body = el('div');
  host.append(head, msg, err, body);
  showLeft('pm');
  document.getElementById('left').classList.add('open');

  function setError(t) {
    err.hidden = !t;
    err.textContent = t || '';
  }
  function setMessage(t) {
    msg.hidden = !t;
    msg.textContent = t || '';
  }
  function changed(key) {
    refreshVisibility();
    spec.onChange && spec.onChange(pm.vals, key, pm);
  }
  function refreshVisibility() {
    for (const f of spec.fields) if (f.show && pm.els[f.key]) pm.els[f.key].hidden = !f.show(pm.vals);
  }
  function chipList(f, box) {
    box.innerHTML = '';
    const list = pm.vals[f.key] || [];
    if (!list.length) box.append(el('span', { class: 'ph', text: f.placeholder || 'Click here, then select in the graphics area' }));
    list.forEach((it, i) => {
      box.append(el('span', { class: 'chip' }, it.label || 'Item', el('b', { text: '×', onclick: (e) => {
        e.stopPropagation();
        list.splice(i, 1);
        chipList(f, box);
        changed(f.key);
      } })));
    });
  }
  function activate(f, box) {
    host.querySelectorAll('.selbox.active').forEach((b) => b.classList.remove('active'));
    box.classList.add('active');
    pm.activeSel = f;
    spec.onActivate && spec.onActivate(f, pm);
  }
  // called by the app when something is picked in the graphics area / tree. returns true if consumed.
  function pick(item) {
    const f = pm.activeSel;
    if (!f) return false;
    if (f.accept && !f.accept.includes(item.kind)) return false;
    const list = (pm.vals[f.key] = pm.vals[f.key] || []);
    const k = item.key;
    const at = list.findIndex((x) => x.key === k);
    if (at >= 0) list.splice(at, 1);
    else if (f.multi === false) list.splice(0, list.length, item);
    else list.push(item);
    chipList(f, pm.els[f.key].querySelector('.selbox'));
    changed(f.key);
    // auto-advance to the next empty selection box for single-pick fields
    if (f.multi === false && at < 0) {
      const next = spec.fields.find((g) => g.type === 'sel' && g !== f && !(pm.vals[g.key] || []).length && (!g.show || g.show(pm.vals)));
      if (next) activate(next, pm.els[next.key].querySelector('.selbox'));
    }
    return true;
  }
  function refresh() {
    build();
  }
  function build() {
    body.innerHTML = '';
    pm.els = {};
    let group = null, groupEl = null;
    for (const f of spec.fields) {
      if (f.group !== group || !groupEl) {
        group = f.group;
        groupEl = el('div', { class: 'pm-group' }, group ? el('h4', { text: group }) : null);
        body.append(groupEl);
      }
      const wrap = el('div', { class: 'fld' + (f.type === 'sel' || f.type === 'info' || f.type === 'buttons' || f.type === 'textarea' || f.type === 'custom' || f.wide ? ' wide' : '') });
      pm.els[f.key] = wrap;
      const v = pm.vals[f.key];
      if (f.label && f.type !== 'check') wrap.append(el('label', { text: f.label }));
      if (f.type === 'number') {
        const inp = el('input', { type: 'number', value: v ?? 0, step: f.step ?? 'any', min: f.min, max: f.max });
        inp.addEventListener('input', () => {
          const x = parseFloat(inp.value);
          if (Number.isFinite(x)) {
            pm.vals[f.key] = x;
            changed(f.key);
          }
        });
        inp.addEventListener('keydown', (e) => e.key === 'Enter' && !spec.noOK && closePM(true));
        wrap.append(inp);
      } else if (f.type === 'text' || f.type === 'color') {
        const inp = el('input', { type: f.type === 'color' ? 'color' : 'text', value: v ?? '', placeholder: f.placeholder });
        inp.addEventListener('input', () => {
          pm.vals[f.key] = inp.value;
          changed(f.key);
        });
        wrap.append(inp);
      } else if (f.type === 'textarea') {
        const inp = el('textarea', { rows: f.rows || 3, placeholder: f.placeholder });
        inp.value = v ?? '';
        inp.addEventListener('input', () => {
          pm.vals[f.key] = inp.value;
          changed(f.key);
        });
        wrap.append(inp);
      } else if (f.type === 'select') {
        const sel = el('select');
        for (const o of f.options) {
          const [val, lab] = Array.isArray(o) ? o : [o, o];
          sel.append(el('option', { value: val, text: lab, selected: String(val) === String(v) }));
        }
        sel.addEventListener('change', () => {
          pm.vals[f.key] = sel.value;
          changed(f.key);
        });
        wrap.append(sel);
      } else if (f.type === 'check') {
        const inp = el('input', { type: 'checkbox', checked: !!v });
        inp.addEventListener('change', () => {
          pm.vals[f.key] = inp.checked;
          changed(f.key);
        });
        wrap.classList.add('wide');
        wrap.append(el('label', { style: { color: 'inherit', display: 'flex', gap: '6px', alignItems: 'center' } }, inp, f.label));
      } else if (f.type === 'vec') {
        const row = el('div', { class: 'row' });
        const cur = (pm.vals[f.key] = Array.isArray(v) ? v : [0, 0, 0]);
        ['X', 'Y', 'Z'].forEach((ax, i) => {
          const inp = el('input', { type: 'number', value: cur[i], step: 'any', title: ax });
          inp.addEventListener('input', () => {
            const x = parseFloat(inp.value);
            if (Number.isFinite(x)) {
              cur[i] = x;
              changed(f.key);
            }
          });
          row.append(inp);
        });
        wrap.append(row);
      } else if (f.type === 'sel') {
        const box = el('div', { class: 'selbox' });
        box.addEventListener('click', () => activate(f, box));
        chipList(f, box);
        wrap.append(box);
      } else if (f.type === 'info') {
        wrap.append(el('div', { html: typeof f.html === 'function' ? f.html(pm.vals) : f.html || '' }));
      } else if (f.type === 'buttons') {
        const row = el('div', { class: 'btnrow' });
        for (const b of f.buttons) row.append(el('button', { class: 'btn' + (b.primary ? ' primary' : ''), text: b.label, title: b.title, onclick: () => b.action(pm) }));
        wrap.append(row);
      } else if (f.type === 'custom') {
        wrap.append(f.render(pm));
      }
      groupEl.append(wrap);
    }
    refreshVisibility();
    const firstSel = spec.fields.find((f) => f.type === 'sel' && (!f.show || f.show(pm.vals)) && (f.autoFocus !== false));
    if (firstSel && !pm.activeSel) activate(firstSel, pm.els[firstSel.key].querySelector('.selbox'));
    else if (pm.activeSel && pm.els[pm.activeSel.key]) pm.els[pm.activeSel.key].querySelector('.selbox')?.classList.add('active');
  }
  build();
  return pm;
}
