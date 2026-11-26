/**
 * dsh-shared-browser — Client half.
 *
 * The tab type is taken over through the public `sidebarRightTabs` registry
 * (`kind: 'browser'`, `priority: 'extension'`), so this file needs no edit to
 * DSH: unloading the bundle hands the tab back to the built-in browser.
 *
 * Inside the tab we draw a desktop-browser chrome around the SAME Electron
 * `<webview>` the shell owns — one process, one partition, the user's real
 * logins — and we implement what the stock browser lacks: zoom, find in page,
 * device emulation, history, bookmarks, permissions, storage clearing,
 * screenshots, region screenshots, element picking, element comments,
 * console/network capture, a DevTools panel, and "add to chat".
 *
 * The Host half reaches us over `/dsh-shared-browser/events` (SSE commands) and
 * `/dsh-shared-browser/report` (results and telemetry). Page internals are read
 * through an injected agent that `executeJavaScript` polls, so nothing here
 * depends on a preload script the desktop shell refuses to keep.
 */
window.__ModuleLoader__.load({
  id: 'dsh-shared-browser',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    const VERSION = '0.5.0'
    const PLUGIN_ID = 'dsh-shared-browser'
    const BASE = '/dsh-shared-browser'

    /* ------------------------------------------------------------------ i18n */

    const ZH = {
      'browser.label': '浏览器',
      'browser.guide': '共享浏览器：截图、元素评论、控制台，Agent 可直接操作',
      'browser.untitled': '新标签页',
      'browser.menu': '菜单',
      'action.back': '后退',
      'action.forward': '前进',
      'action.reload': '刷新',
      'action.stop': '停止',
      'action.go': '前往',
      'action.screenshot': '截图到聊天',
      'action.region': '区域截图',
      'action.pick': '选取元素到聊天',
      'action.comment': '评论元素',
      'action.devtools': '开发者工具 (F12)',
      'menu.newTab': '新建标签页',
      'menu.zoomIn': '放大',
      'menu.zoomOut': '缩小',
      'menu.zoomReset': '重置缩放',
      'menu.find': '在页面中查找',
      'menu.emulate': '设备仿真',
      'menu.external': '在外部浏览器中打开',
      'menu.history': '历史记录',
      'menu.bookmark': '添加到收藏夹',
      'menu.bookmarks': '收藏夹',
      'menu.permissions': '网站权限',
      'menu.clearStorage': '清除存储(全局)',
      'menu.settings': '浏览器设置',
      'menu.screenshot': '截图',
      'menu.region': '区域截图',
      'menu.pick': '选取元素',
      'menu.comment': '评论元素',
      'menu.consoleLog': '控制台日志',
      'menu.devtools': '开发者工具',
      'menu.copyUrl': '复制地址',
      'devtools.title': '开发者工具',
      'devtools.console': '控制台',
      'devtools.elements': '元素',
      'devtools.network': '网络',
      'devtools.eval': '运行',
      'devtools.empty': '暂无记录',
      'devtools.hint': '在此运行 JavaScript，Enter 执行，Shift+Enter 换行',
      'devtools.clear': '清空',
      'devtools.elementsHint': '元素树请用工具 bb_snapshot 获取；这里显示选取到的元素。',
      'find.placeholder': '在页面中查找',
      'find.none': '无匹配',
      'find.count': '第 {n} / {total}',
      'addr.placeholder': '输入 HTTP(S) 地址',
      'noBridge': '当前环境没有桌面浏览器桥，仍由内置浏览器接管此页签。',
      'pick.hint': '点击页面元素以添加到聊天（Esc 取消）',
      'comment.hint': '点击元素后填写评论（Esc 取消）',
      'comment.placeholder': '对这个元素的评论，Agent 会读到',
      'comment.submit': '添加评论',
      'comment.cancel': '取消',
      'region.hint': '拖拽选择区域（Esc 取消）',
      'toast.added': '已添加到聊天输入框',
      'toast.copied': '已复制',
      'toast.cleared': '已清除',
      'toast.saved': '已保存',
      'toast.failed': '操作失败',
      'permissions.title': '网站权限',
      'permissions.body': '桌面端共享浏览器按工作区隔离，且默认拒绝所有站点权限请求（摄像头、麦克风、通知、定位、弹窗、下载）。该策略在 DSH 桌面壳内固定，插件无法在运行时放开。',
      'permissions.site': '当前站点',
      'note.screenshot': '截图',
      'note.region': '区域截图',
      'note.site': '地址',
      'element.link': '链接',
      'element.selector': '选择器',
      'element.text': '文本',
      'element.comment': '评论',
      'permissions.partition': '存储分区',
      'history.title': '历史记录',
      'history.empty': '暂无历史记录',
      'history.clear': '清空历史',
      'bookmarks.title': '收藏夹',
      'bookmarks.empty': '暂无收藏',
      'settings.title': '浏览器设置',
      'settings.defaultZoom': '当前缩放',
      'settings.zoomHint': '缩放只作用于当前页签。',
      'emulate.title': '设备仿真',
      'emulate.none': '关闭仿真',
      'emulate.desktop': '桌面 1280×800',
      'title.close': '关闭',
      'status.loading': '加载中…',
    }

    const EN = {
      'browser.label': 'Browser',
      'browser.guide': 'Shared browser: screenshots, element comments, console — Agent can drive it',
      'browser.untitled': 'New tab',
      'browser.menu': 'Menu',
      'action.back': 'Back',
      'action.forward': 'Forward',
      'action.reload': 'Reload',
      'action.stop': 'Stop',
      'action.go': 'Go',
      'action.screenshot': 'Screenshot to chat',
      'action.region': 'Region screenshot',
      'action.pick': 'Pick element to chat',
      'action.comment': 'Comment element',
      'action.devtools': 'DevTools (F12)',
      'menu.newTab': 'New tab',
      'menu.zoomIn': 'Zoom in',
      'menu.zoomOut': 'Zoom out',
      'menu.zoomReset': 'Reset zoom',
      'menu.find': 'Find in page',
      'menu.emulate': 'Device emulation',
      'menu.external': 'Open in external browser',
      'menu.history': 'History',
      'menu.bookmark': 'Add to bookmarks',
      'menu.bookmarks': 'Bookmarks',
      'menu.permissions': 'Site permissions',
      'menu.clearStorage': 'Clear storage (all)',
      'menu.settings': 'Browser settings',
      'menu.screenshot': 'Screenshot',
      'menu.region': 'Region screenshot',
      'menu.pick': 'Pick element',
      'menu.comment': 'Comment element',
      'menu.consoleLog': 'Console log',
      'menu.devtools': 'DevTools',
      'menu.copyUrl': 'Copy address',
      'devtools.title': 'DevTools',
      'devtools.console': 'Console',
      'devtools.elements': 'Elements',
      'devtools.network': 'Network',
      'devtools.eval': 'Console input',
      'devtools.empty': 'Nothing captured yet',
      'devtools.hint': 'Run JavaScript here. Enter executes, Shift+Enter adds a line.',
      'devtools.clear': 'Clear',
      'devtools.elementsHint': 'Read the element tree with bb_snapshot; this shows the element you picked.',
      'find.placeholder': 'Find in page',
      'find.none': 'No matches',
      'find.count': '{n} of {total}',
      'addr.placeholder': 'Enter an HTTP(S) address',
      'noBridge': 'No desktop browser bridge here; the built-in browser keeps this tab.',
      'pick.hint': 'Click a page element to add it to chat (Esc cancels)',
      'comment.hint': 'Click an element, then write the comment (Esc cancels)',
      'comment.placeholder': 'Comment for this element; the agent reads it',
      'comment.submit': 'Add comment',
      'comment.cancel': 'Cancel',
      'region.hint': 'Drag to select a region (Esc cancels)',
      'toast.added': 'Added to the chat composer',
      'toast.copied': 'Copied',
      'toast.cleared': 'Cleared',
      'toast.saved': 'Saved',
      'toast.failed': 'Operation failed',
      'permissions.title': 'Site permissions',
      'permissions.body': 'The desktop shared browser is per-workspace and refuses every site permission request (camera, microphone, notifications, geolocation, popups, downloads). That policy lives in the desktop shell; a plugin cannot relax it at runtime.',
      'permissions.site': 'Current site',
      'note.screenshot': 'Screenshot',
      'note.region': 'Region screenshot',
      'note.site': 'Address',
      'element.link': 'Link',
      'element.selector': 'Selector',
      'element.text': 'Text',
      'element.comment': 'Comment',
      'permissions.partition': 'Storage partition',
      'history.title': 'History',
      'history.empty': 'No history yet',
      'history.clear': 'Clear history',
      'bookmarks.title': 'Bookmarks',
      'bookmarks.empty': 'No bookmarks yet',
      'settings.title': 'Browser settings',
      'settings.defaultZoom': 'Current zoom',
      'settings.zoomHint': 'Zoom applies to this tab only.',
      'emulate.title': 'Device emulation',
      'emulate.none': 'Disable emulation',
      'emulate.desktop': 'Desktop 1280×800',
      'title.close': 'Close',
      'status.loading': 'Loading…',
    }

    const strings = String((typeof navigator !== 'undefined' && navigator.language) || 'zh').toLowerCase().startsWith('zh') ? ZH : EN

    /** Look up one localized string, substituting `{name}` placeholders. */
    const t = (key, vars) => {
      const template = strings[key] ?? EN[key] ?? key
      if (vars === undefined) return template
      return template.replace(/\{(\w+)\}/gu, (_, name) => (vars[name] === undefined ? `{${name}}` : String(vars[name])))
    }

    /* ------------------------------------------------------------- utilities */

    const route = path => `${BASE}${path}`
    const clamp = (value, min, max) => Math.min(Math.max(value, min), max)

    /** Truncate text without splitting a surrogate pair. */
    const cut = (text, max) => {
      const value = String(text ?? '')
      return value.length <= max ? value : `${value.slice(0, max)}…`
    }

    const load = (key, fallback) => {
      try {
        const raw = window.localStorage.getItem(`dsb.${key}`)
        return raw === null ? fallback : JSON.parse(raw)
      } catch {
        return fallback
      }
    }

    const save = (key, value) => {
      try { window.localStorage.setItem(`dsb.${key}`, JSON.stringify(value)) } catch { /* storage is optional */ }
    }

    const ZOOM_STEPS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3]

    /** Next or previous stop of the zoom ladder. */
    const nextZoom = (current, direction) => {
      const index = ZOOM_STEPS.findIndex(step => Math.abs(step - current) < 0.001)
      const base = index === -1 ? 4 : index
      return ZOOM_STEPS[clamp(base + direction, 0, ZOOM_STEPS.length - 1)]
    }

    const EMULATION_PRESETS = {
      'iphone-14': { width: 390, height: 844, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' },
      'pixel-7': { width: 412, height: 915, ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36' },
      'galaxy-s23': { width: 360, height: 780, ua: 'Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36' },
      'ipad-mini': { width: 744, height: 1133, ua: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' },
      'desktop-720': { width: 1280, height: 800, ua: null },
    }

    /* --------------------------------------------------------------- in-page */

    /**
     * Agent installed into the guest page: console/error/network capture, element
     * description and refs, the picker, and comment markers.
     *
     * A guest without a preload cannot call back into the host renderer, so the
     * agent only ever appends to a queue the renderer drains.
     */
    const AGENT_SOURCE = String.raw`(function () {
  if (window.__dsbAgent && window.__dsbAgent.version === 1) return 'already';
  var queue = [];
  var MAX = 600;
  function push(event) {
    queue.push(event);
    if (queue.length > MAX) queue.splice(0, queue.length - MAX);
  }
  function str(value, limit) {
    limit = limit || 600;
    try {
      if (typeof value === 'string') return value.length > limit ? value.slice(0, limit) + '…' : value;
      if (value instanceof Error) return (value.name || 'Error') + ': ' + value.message;
      var text = JSON.stringify(value);
      if (text === undefined) text = String(value);
      return text.length > limit ? text.slice(0, limit) + '…' : text;
    } catch (error) { return String(value); }
  }
  function visible(el) {
    if (!el || el.nodeType !== 1) return false;
    var rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;
    var style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0.02;
  }
  function cssPath(el) {
    if (!el || el.nodeType !== 1) return '';
    if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) return '#' + el.id;
    var testId = el.getAttribute('data-testid') || el.getAttribute('data-test-id');
    if (testId) return '[data-testid="' + testId.replace(/"/g, '\\"') + '"]';
    var parts = [];
    var node = el;
    var guard = 0;
    while (node && node.nodeType === 1 && guard++ < 8) {
      var part = node.tagName.toLowerCase();
      if (node.id && /^[A-Za-z][\w-]*$/.test(node.id)) { parts.unshift('#' + node.id); break; }
      var parent = node.parentElement;
      var siblings = parent ? Array.prototype.filter.call(parent.children, function (child) { return child.tagName === node.tagName; }) : [];
      if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
      parts.unshift(part);
      if (!parent || parent === document.body) { parts.unshift('body'); break; }
      node = parent;
    }
    return parts.join(' > ');
  }
  function labelOf(el) {
    var aria = el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title'));
    if (aria) return aria.trim();
    var text = (el.innerText || el.value || el.getAttribute('placeholder') || el.getAttribute('alt') || '').trim();
    return text.replace(/\s+/g, ' ').slice(0, 160);
  }
  function describe(el) {
    var rect = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      selector: cssPath(el),
      ref: el.getAttribute('data-dsb-ref') || null,
      text: (el.innerText || el.value || '').trim().replace(/\s+/g, ' ').slice(0, 400),
      html: (el.outerHTML || '').slice(0, 1200),
      role: el.getAttribute('role') || null,
      name: labelOf(el),
      id: el.id || null,
      classes: (typeof el.className === 'string') ? el.className.slice(0, 200) : null,
      href: el.getAttribute ? el.getAttribute('href') : null,
      rect: { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) }
    };
  }
  var INTERACTIVE = 'a,button,input,select,textarea,summary,label,[role="button"],[role="link"],[role="tab"],[role="checkbox"],[role="radio"],[contenteditable="true"],[tabindex]:not([tabindex="-1"])';
  function isInteractive(el) {
    try { return el.matches(INTERACTIVE) || el.hasAttribute('onclick') } catch (error) { return false }
  }
  var refSeq = 0;
  var refs = new Map();
  function assignRef(el) {
    var existing = el.getAttribute('data-dsb-ref');
    if (existing) return existing;
    var ref = 'e' + (++refSeq);
    el.setAttribute('data-dsb-ref', ref);
    try { refs.set(ref, new WeakRef(el)) } catch (error) { /* WeakRef missing */ }
    return ref;
  }
  function resolve(target) {
    if (!target) return null;
    if (/^e[0-9]+$/.test(target)) {
      var el = document.querySelector('[data-dsb-ref="' + target + '"]');
      if (el) return el;
      var held = refs.get(target);
      return held && held.deref ? (held.deref() || null) : null;
    }
    try { return document.querySelector(target) } catch (error) { return null }
  }
  function snapshot(options) {
    options = options || {};
    var interactiveOnly = options.interactiveOnly === true;
    var maxDepth = options.maxDepth || 12;
    var budget = options.maxChars || 20000;
    var lines = [];
    var used = 0;
    function walk(el, depth) {
      if (used > budget || depth > maxDepth) return;
      if (!el || el.nodeType !== 1 || !visible(el)) return;
      var tag = el.tagName.toLowerCase();
      if (['script', 'style', 'noscript', 'template', 'svg', 'path', 'head'].indexOf(tag) >= 0) return;
      var interactive = isInteractive(el);
      if (!interactiveOnly || interactive) {
        var text = labelOf(el);
        if (interactive || text.length > 1) {
          var ref = assignRef(el);
          var line = ref + ' <' + tag + '>' + (text ? ' "' + text + '"' : '');
          if (used + line.length <= budget) { lines.push(line); used += line.length + 1; }
        }
      }
      var children = Array.prototype.slice.call(el.children).slice(0, 150);
      for (var index = 0; index < children.length; index += 1) walk(children[index], depth + 1);
    }
    walk(document.body, 0);
    return { lines: lines, truncated: used > budget, url: location.href, title: document.title };
  }
  /* -------------------------------------------- console, errors, network */
  ['log', 'info', 'warn', 'error', 'debug'].forEach(function (level) {
    var original = console[level];
    if (typeof original !== 'function') return;
    console[level] = function () {
      try {
        var args = Array.prototype.slice.call(arguments).map(function (value) { return str(value, 400); });
        push({ type: 'console', level: level === 'warn' ? 'warning' : level === 'log' ? 'info' : level, text: args.join(' '), source: 'console', ts: Date.now() });
      } catch (error) { /* never break the page's logging */ }
      return original.apply(this, arguments);
    };
  });
  window.addEventListener('error', function (event) {
    var target = event.target;
    if (target && target !== window && target.tagName) {
      push({ type: 'console', level: 'error', text: 'resource error: ' + target.tagName.toLowerCase() + ' ' + (target.src || target.href || ''), source: 'error', ts: Date.now() });
      return;
    }
    push({ type: 'console', level: 'error', text: (event.message || 'error') + ' @ ' + (event.filename || location.href) + ':' + (event.lineno || 0), source: 'error', ts: Date.now() });
  }, true);
  window.addEventListener('unhandledrejection', function (event) {
    push({ type: 'console', level: 'error', text: 'Unhandled rejection: ' + str(event.reason), source: 'unhandledrejection', ts: Date.now() });
  });
  if (typeof window.fetch === 'function') {
    var originalFetch = window.fetch;
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      var method = (init && init.method) || (input && input.method) || 'GET';
      var started = performance.now();
      return originalFetch.apply(this, arguments).then(function (response) {
        push({ type: 'network', method: method, url: url, status: response.status, ok: response.ok, ms: Math.round(performance.now() - started), ts: Date.now() });
        return response;
      }, function (error) {
        push({ type: 'network', method: method, url: url, status: 0, ok: false, ms: Math.round(performance.now() - started), error: str(error, 200), ts: Date.now() });
        throw error;
      });
    };
  }
  if (window.XMLHttpRequest) {
    var openXhr = XMLHttpRequest.prototype.open;
    var sendXhr = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__dsb = { method: method, url: url };
      return openXhr.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      var xhr = this;
      var started = performance.now();
      xhr.addEventListener('loadend', function () {
        var meta = xhr.__dsb || {};
        push({ type: 'network', method: meta.method || 'GET', url: meta.url || '', status: xhr.status, ok: xhr.status >= 200 && xhr.status < 400, ms: Math.round(performance.now() - started), ts: Date.now() });
      });
      return sendXhr.apply(this, arguments);
    };
  }
  /* ---------------------------------------------------------------- picker */
  function pickBox() {
    var box = document.getElementById('__dsb_pick_box');
    if (box) return box;
    box = document.createElement('div');
    box.id = '__dsb_pick_box';
    box.style.cssText = 'position:fixed;z-index:2147483646;pointer-events:none;border:2px solid #3b82f6;background:rgba(59,130,246,0.12);border-radius:2px;transition:all 40ms linear;display:none';
    document.documentElement.appendChild(box);
    return box;
  }
  var picker = null;
  function stopPicker() {
    if (!picker) return false;
    document.removeEventListener('mousemove', picker.move, true);
    document.removeEventListener('click', picker.click, true);
    document.removeEventListener('keydown', picker.key, true);
    var box = pickBox();
    box.style.display = 'none';
    picker = null;
    return true;
  }
  function startPicker(mode) {
    stopPicker();
    var box = pickBox();
    picker = {
      mode: mode || 'pick',
      move: function (event) {
        var el = event.target;
        if (!el || el === box) return;
        var rect = el.getBoundingClientRect();
        box.style.display = 'block';
        box.style.left = rect.left + 'px';
        box.style.top = rect.top + 'px';
        box.style.width = rect.width + 'px';
        box.style.height = rect.height + 'px';
        picker.hover = el;
      },
      click: function (event) {
        event.preventDefault();
        event.stopPropagation();
        var el = (picker && picker.hover) || event.target;
        if (!el || el === box) return;
        var info = describe(el);
        info.ref = assignRef(el);
        push({ type: 'pick', mode: picker.mode, element: info, ts: Date.now() });
        stopPicker();
      },
      key: function (event) {
        if (event.key === 'Escape') { push({ type: 'pick', mode: 'cancel', ts: Date.now() }); stopPicker(); }
      }
    };
    document.addEventListener('mousemove', picker.move, true);
    document.addEventListener('click', picker.click, true);
    document.addEventListener('keydown', picker.key, true);
    return true;
  }
  /* ------------------------------------------------------- comment markers */
  /* Right-click inside the page opens the plugin's own menu: the guest has no
     native context menu, so the page side forwards the position instead. */
  document.addEventListener('contextmenu', function (event) {
    if (picker) return;
    event.preventDefault();
    push({ type: 'menu', x: event.clientX, y: event.clientY, ts: Date.now() });
  }, true);

  function drawMarkers(list) {
    var layer = document.getElementById('__dsb_markers');
    if (!layer) {
      layer = document.createElement('div');
      layer.id = '__dsb_markers';
      layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483645';
      document.documentElement.appendChild(layer);
    }
    layer.textContent = '';
    (list || []).forEach(function (comment) {
      var el = null;
      try { el = document.querySelector(comment.selector) } catch (error) { el = null }
      if (!el) return;
      var rect = el.getBoundingClientRect();
      var pin = document.createElement('div');
      pin.title = comment.note || '';
      pin.textContent = String(comment.index || '•');
      pin.style.cssText = 'position:absolute;left:' + Math.round(rect.left) + 'px;top:' + Math.round(rect.top) + 'px;transform:translate(-50%,-50%);min-width:18px;height:18px;border-radius:9px;background:' + (comment.color || '#f59e0b') + ';color:#111;font:600 11px/18px system-ui;text-align:center;box-shadow:0 1px 4px rgba(0,0,0,0.35);pointer-events:auto;cursor:help;padding:0 4px';
      layer.appendChild(pin);
    });
    return true;
  }
  /* ------------------------------------------------------------ page actions */
  function rectOf(target) {
    var el = resolve(target);
    if (!el) return null;
    try { el.scrollIntoView({ block: 'center', inline: 'center' }) } catch (error) { /* detached */ }
    var rect = el.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  }
  function nativeSet(el, text) {
    var proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    var descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor && descriptor.set) descriptor.set.call(el, text); else el.value = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  /* Count text occurrences without relying on the guest find session. */
  function countText(text, limit) {
    var needle = String(text || '').toLowerCase();
    if (needle === '') return 0;
    var cap = limit || 2000;
    var total = 0;
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    var node;
    while ((node = walker.nextNode())) {
      var value = node.nodeValue;
      if (!value) continue;
      var hay = value.toLowerCase();
      var index = hay.indexOf(needle);
      while (index !== -1) {
        total += 1;
        if (total >= cap) return total;
        index = hay.indexOf(needle, index + needle.length);
      }
    }
    return total;
  }
  window.__dsbAgent = {
    version: 1,
    drain: function () {
      var out = queue.slice();
      queue.length = 0;
      return out;
    },
    snapshot: snapshot,
    text: function (selector, maxChars) {
      var root = selector ? resolve(selector) : (document.querySelector('main,article,[role="main"]') || document.body);
      if (!root) return { text: '', url: location.href, title: document.title };
      var text = (root.innerText || root.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
      var limit = maxChars || 20000;
      return { text: text.length > limit ? text.slice(0, limit) + '…' : text, url: location.href, title: document.title };
    },
    describe: function (target) { var el = resolve(target); return el ? describe(el) : null },
    rect: rectOf,
    countText: countText,
    setValue: function (target, text) {
      var el = resolve(target);
      if (!el) return false;
      el.focus();
      nativeSet(el, text);
      return true;
    },
    appendValue: function (target, text) {
      var el = resolve(target);
      if (!el) return false;
      el.focus();
      nativeSet(el, String(el.value || '') + text);
      return true;
    },
    submit: function (target) {
      var el = target ? resolve(target) : document.activeElement;
      if (!el) return false;
      var form = el.form || (el.closest ? el.closest('form') : null);
      if (form && typeof form.requestSubmit === 'function') { form.requestSubmit(); return true; }
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      return true;
    },
    startPicker: startPicker,
    stopPicker: stopPicker,
    markers: function (list) { try { return drawMarkers(list) } catch (error) { return false } },
    storage: function (clear) {
      var report = { origin: location.origin, localStorageKeys: 0, sessionStorageKeys: 0, cookies: 0, cleared: false };
      try { report.localStorageKeys = localStorage.length } catch (error) { /* opaque origin */ }
      try { report.sessionStorageKeys = sessionStorage.length } catch (error) { /* opaque origin */ }
      try { report.cookies = document.cookie ? document.cookie.split(';').filter(Boolean).length : 0 } catch (error) { /* denied */ }
      if (!clear) return report;
      try { localStorage.clear() } catch (error) { /* denied */ }
      try { sessionStorage.clear() } catch (error) { /* denied */ }
      try {
        document.cookie.split(';').forEach(function (cookie) {
          var name = cookie.split('=')[0].trim();
          if (!name) return;
          document.cookie = name + '=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
        });
      } catch (error) { /* denied */ }
      if (window.caches && caches.keys) {
        caches.keys().then(function (keys) { keys.forEach(function (key) { caches.delete(key) }) }).catch(function () {});
      }
      try {
        if (indexedDB && indexedDB.databases) {
          indexedDB.databases().then(function (list) {
            (list || []).forEach(function (entry) { if (entry && entry.name) indexedDB.deleteDatabase(entry.name) });
          }).catch(function () {});
        }
      } catch (error) { /* unsupported */ }
      report.cleared = true;
      return report;
    }
  };
  return 'installed';
})()`

    /* ------------------------------------------------------------ page guest */

    /** Imperative wrapper around one `<webview>` guest. */
    class Guest {
      /**
       * @param {HTMLElement} container - mount point inside the tab body.
       * @param {{ lease: string, partition: string }} reservation - desktop reservation.
       * @param {(event: Record<string, any>) => void} onEvent - state sink.
       */
      constructor(container, reservation, onEvent) {
        this.reservation = reservation
        this.onEvent = onEvent
        this.url = 'about:blank'
        this.title = ''
        this.loading = false
        this.ready = false
        /** True once the guest is attached and can accept navigation. */
        this.attached = false
        /** Target held until the guest attaches. */
        this.pending = null
        this.find = { text: '', active: 0, total: 0 }
        this.handlers = []
        this.pollTimer = null
        this.keepAlive = null
        /** Set by `create()`: the element must exist before `bind()` subscribes to it. */
        this.element = null
        this.create(container)
      }

      /**
       * Create the element with exactly the attributes the desktop gate checks,
       * mount it, then subscribe.
       * @param {HTMLElement} container - mount point inside the tab body.
       * @returns {Electron.WebviewTag} the mounted element.
       */
      create(container) {
        const element = document.createElement('webview')
        element.className = 'dsb-webview'
        element.dataset.sidebarBrowserFrame = 'webview'
        element.setAttribute('name', this.reservation.lease)
        element.setAttribute('partition', this.reservation.partition)
        element.setAttribute('allowpopups', '')
        element.setAttribute('src', `about:blank#${this.reservation.lease}`)
        element.style.cssText = 'display:flex;flex:1 1 auto;width:100%;height:100%;min-height:0;border:0;background:#fff'
        this.element = element
        container.appendChild(element)
        this.bind()
        return element
      }

      /**
       * Give the guest an explicit viewport size. A webview keeps its previous
       * layout size when it merely sits in a flex box, so emulation would
       * otherwise show a desktop viewport squeezed into a phone frame.
       * @param {number|null} width - CSS pixels, or null to fill the container.
       * @param {number|null} height - CSS pixels, or null to fill the container.
       */
      resize(width, height, scale = 1) {
        if (this.element === null) return
        if (width === null || height === null) {
          this.element.style.cssText = 'display:flex;flex:1 1 auto;width:100%;height:100%;min-height:0;border:0;background:#fff'
          return
        }
        // `display:flex` matters: with block/inline-block the guest keeps its
        // default 150px viewport height even though the box is taller. The
        // scale lives on the guest itself because an Electron webview ignores
        // transforms on its ancestors.
        this.element.style.cssText = `display:flex;flex:0 0 auto;width:${width}px;height:${height}px;border:0;background:#fff;transform:scale(${scale});transform-origin:center center`
      }

      /** Subscribe one DOM event and keep it for teardown. */
      on(name, handler) {
        const bound = event => {
          try { handler(event) } catch (error) { /* never let a guest event break the UI */ }
        }
        this.element.addEventListener(name, bound)
        this.handlers.push([name, bound])
      }

      /** Wire navigation, console and find events. */
      bind() {
        const ready = () => {
          const first = this.attached === false
          this.attached = true
          if (this.ready === false) {
            this.ready = true
            this.onEvent({ kind: 'ready' })
          }
          if (first && this.pending !== null) {
            const target = this.pending
            this.pending = null
            this.element.loadURL(target).catch(() => {})
          }
          this.installAgent()
        }
        this.on('dom-ready', ready)
        this.on('did-start-loading', () => { this.loading = true; this.onEvent({ kind: 'loading', loading: true }) })
        // `dom-ready` never fires for the initial `about:blank#lease` mount, so a
        // guest that has settled counts as ready too; otherwise the tab sits on
        // "loading" forever and no tool can reach the page agent.
        this.on('did-stop-loading', () => { this.loading = false; ready(); this.sync(); this.onEvent({ kind: 'loading', loading: false }) })
        this.on('did-start-navigation', (event) => {
          if (event.isMainFrame === false) return
          this.url = event.url || this.url
          this.onEvent({ kind: 'url', url: this.url })
        })
        this.on('did-navigate', (event) => {
          this.url = event.url || this.url
          this.installAgent()
          this.record()
          this.sync()
          this.onEvent({ kind: 'url', url: this.url })
        })
        this.on('did-navigate-in-page', (event) => {
          this.url = event.url || this.url
          this.record()
          this.sync()
          this.onEvent({ kind: 'url', url: this.url })
        })
        this.on('page-title-updated', (event) => { this.title = event.title || ''; this.onEvent({ kind: 'title', title: this.title }) })
        this.on('did-fail-load', (event) => {
          if (event.errorCode === -3) return
          this.loading = false
          this.onEvent({ kind: 'failed', url: event.validatedURL, description: event.errorDescription })
        })
        this.on('render-process-gone', () => { this.onEvent({ kind: 'gone' }) })
        this.on('destroyed', () => { this.onEvent({ kind: 'destroyed' }) })
        this.on('console-message', (event) => {
          const raw = String(event.level ?? 'info')
          this.onEvent({
            kind: 'console',
            entry: {
              level: raw === 'warning' || raw === '1' ? 'warning' : raw === 'error' || raw === '3' ? 'error' : 'info',
              text: cut(event.message ?? '', 2000),
              source: 'webview',
              url: this.url,
              ts: Date.now(),
            },
          })
        })
        this.on('found-in-page', (event) => {
          if (!event) return
          // The webview re-wraps the IPC payload: counts live on `result`.
          const result = event.result ?? event
          this.find = { text: this.find.text, active: result.activeMatchOrdinal ?? 0, total: result.matches ?? 0 }
          this.onEvent({ kind: 'find', find: this.find })
        })
      }

      /** Begin the event pump and the agent watchdog. */
      start() {
        if (this.pollTimer !== null) return
        this.pollTimer = setInterval(() => { this.poll() }, 400)
        this.keepAlive = setInterval(() => { if (this.ready) this.installAgent() }, 5000)
        // A mounted guest whose document already settled got no `did-stop-loading`
        // we could hear: probe once, then leave the flag alone.
        setTimeout(() => {
          if (this.ready) return
          this.run('document.readyState').then((state) => {
            if (this.ready === false && (state === 'complete' || state === 'interactive')) {
              this.ready = true
              this.onEvent({ kind: 'ready' })
              this.installAgent()
            }
          }).catch(() => {})
        }, 1200)
      }

      /** Stop every timer. */
      stop() {
        if (this.pollTimer !== null) clearInterval(this.pollTimer)
        if (this.keepAlive !== null) clearInterval(this.keepAlive)
        this.pollTimer = null
        this.keepAlive = null
      }

      /** Run one expression in the guest and return its value. */
      async run(code) {
        return this.element.executeJavaScript(code, true)
      }

      /** Drain the agent's event queue. */
      async poll() {
        if (!this.ready) return
        try {
          const events = await this.run('window.__dsbAgent ? window.__dsbAgent.drain() : []')
          if (Array.isArray(events) === false) return
          for (const event of events) this.onEvent({ kind: 'agent', event })
        } catch { /* navigation replaced the context */ }
      }

      /** Install the page agent (idempotent). */
      async installAgent() {
        try {
          const result = await this.run(AGENT_SOURCE)
          if (result !== 'installed' && result !== 'already') return false
          return true
        } catch {
          return false
        }
      }

      /** Refresh back/forward availability. */
      sync() {
        let canGoBack = false
        let canGoForward = false
        try {
          canGoBack = this.element.canGoBack()
          canGoForward = this.element.canGoForward()
        } catch { /* navigator not attached yet */ }
        this.onEvent({ kind: 'nav', canGoBack, canGoForward })
      }

      /** Remember this visit in the shared history. */
      record() {
        if (!/^https?:/u.test(this.url)) return
        this.onEvent({ kind: 'visit', url: this.url, title: this.title || this.url })
      }

      /** Load one address and wait for it to settle. */
      async load(url, waitMs) {
        this.url = url
        this.onEvent({ kind: 'url', url })
        if (this.attached === false) {
          // A guest that has not finished attaching silently drops `loadURL`,
          // so hold the target until the first document signals readiness.
          this.pending = url
          return { url: this.url, title: this.title, pending: true }
        }
        await this.element.loadURL(url)
        if (waitMs !== 0) await this.waitForReady(waitMs ?? 15000)
        return { url: this.url, title: this.title }
      }

      /** Wait until the document reports interactive/complete. */
      async waitForReady(timeoutMs) {
        const deadline = Date.now() + clamp(timeoutMs ?? 15000, 300, 60000)
        while (Date.now() < deadline) {
          try {
            const state = await this.run('document.readyState')
            if (state === 'complete' || state === 'interactive') return true
          } catch { /* mid-navigation */ }
          await new Promise(resolve => setTimeout(resolve, 200))
        }
        return false
      }

      /** Capture the viewport, an element rect, or a page rect. */
      async capture(rect) {
        const image = await this.element.capturePage(rect)
        if (!image) throw new Error('capturePage returned nothing')
        const dataUrl = typeof image.toDataURL === 'function' ? image.toDataURL() : null
        if (!dataUrl) throw new Error('capturePage produced no data URL')
        const size = typeof image.getSize === 'function' ? image.getSize() : null
        return { dataUrl, width: size?.width ?? null, height: size?.height ?? null }
      }

      /** Remove the element and every listener. */
      destroy() {
        this.stop()
        for (const [name, handler] of this.handlers) {
          try { this.element.removeEventListener(name, handler) } catch { /* gone */ }
        }
        this.handlers = []
        try { this.element.remove() } catch { /* already detached */ }
      }
    }

    /* ---------------------------------------------------------------- bridge */

    /** One SSE command stream plus REST reports, shared by every tab. */
    class Bridge {
      constructor() {
        this.source = null
        this.onCommand = null
        this.connected = false
        this.sessionId = null
      }

      /** Begin streaming; EventSource reconnects by itself. */
      start() {
        if (this.source !== null) return
        const suffix = this.sessionId === null ? '' : `&sessionId=${encodeURIComponent(this.sessionId)}`
        const source = new EventSource(`${route('/events')}?version=${encodeURIComponent(VERSION)}${suffix}`)
        this.source = source
        source.addEventListener('open', () => {
          this.connected = true
          this.post({ type: 'hello', version: VERSION, sessionId: this.sessionId })
        })
        source.addEventListener('error', () => { this.connected = false })
        source.addEventListener('command', (event) => {
          let payload
          try { payload = JSON.parse(event.data) } catch { return }
          this.dispatch(payload)
        })
      }

      /** Adopt the Session once the UI knows it, and tell the Host again. */
      identify(sessionId) {
        if (typeof sessionId !== 'string' || sessionId === '') return
        if (this.sessionId === sessionId) return
        this.sessionId = sessionId
        if (this.connected) this.post({ type: 'hello', version: VERSION, sessionId })
      }

      /** POST one report, retried once while the Host may still be booting. */
      async post(payload) {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            const response = await fetch(route('/report'), {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(payload),
            })
            if (response.ok) return await response.json().catch(() => ({ ok: true }))
          } catch { /* Host not ready */ }
          await new Promise(resolve => setTimeout(resolve, 400))
        }
        return { ok: false }
      }

      /** Run one Host command and report its result. */
      async dispatch(payload) {
        const { id, op, args, tabId } = payload
        if (typeof this.onCommand !== 'function') {
          await this.post({ type: 'result', id, ok: false, error: '浏览器页签尚未就绪。' })
          return
        }
        try {
          const value = await this.onCommand(op, args ?? {}, tabId ?? null)
          await this.post({ type: 'result', id, ok: true, value: value ?? null })
        } catch (error) {
          await this.post({ type: 'result', id, ok: false, error: String(error && error.message ? error.message : error) })
        }
      }

      /** Fire-and-forget telemetry. */
      report(payload) {
        this.post(payload).catch(() => {})
      }
    }

    /* ------------------------------------------------------------ app state */

    const bridge = new Bridge()
    /** @type {Map<string, any>} tabId → instance */
    const instances = new Map()
    let activeTabId = null
    let serviceContext = null
    let reportTimer = null

    const settings = Object.assign({ defaultZoom: 1, keepConsole: true, commentColor: '#f59e0b' }, load('settings', {}))
    const historyLog = load('history', [])
    /**
     * One bookmark per address. Older builds could store duplicates, so the
     * stored list is folded on load instead of trusting it.
     */
    const bookmarks = (() => {
      const stored = load('bookmarks', [])
      if (!Array.isArray(stored)) return []
      const seen = new Set()
      return stored.filter((item) => {
        if (item === null || typeof item !== 'object' || typeof item.url !== 'string' || item.url === '') return false
        if (seen.has(item.url)) return false
        seen.add(item.url)
        return true
      })
    })()

    /** Push the tab list to the Host (coalesced). */
    const scheduleReport = () => {
      if (reportTimer !== null) return
      reportTimer = setTimeout(() => {
        reportTimer = null
        const tabs = [...instances.values()].map((entry) => ({
          id: entry.tabId,
          url: entry.guest?.url ?? '',
          title: entry.guest?.title || entry.title || t('browser.untitled'),
          loading: entry.guest?.loading === true,
          visible: entry.tabId === activeTabId,
        }))
        bridge.report({ type: 'tabs', tabs, activeTabId })
      }, 200)
    }

    /* ------------------------------------------------------------- chat glue */

    /** Resolve the session-scoped conversation faces. */
    function conversationFor(sessionId) {
      if (serviceContext === null || !sessionId) return null
      try {
        const sessions = serviceContext.get('sessions')
        if (!sessions || typeof sessions.scope !== 'function') return null
        // The service itself is addressed by session; the session scope is only
        // needed as the context for `input.for(scope)`.
        const conversation = serviceContext.get('conversation')
        const scope = sessions.scope(sessionId)
        if (!conversation || scope === undefined || scope === null) return null
        return { conversation, scope }
      } catch {
        return null
      }
    }

    /** Decode a data URL into a File the composer can take. */
    function fileFromDataUrl(dataUrl, name) {
      const match = /^data:([^;,]+);base64,(.*)$/su.exec(String(dataUrl ?? ''))
      if (match === null) throw new Error('bad data url')
      const binary = atob(match[2])
      const bytes = new Uint8Array(binary.length)
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
      return new File([bytes], name, { type: match[1] })
    }

    /**
     * Put a note and/or an image into the composer draft of one session.
     * @returns {{ added: boolean, attachments: number, reason?: string }}
     */
    function addToComposer(request) {
      const faces = conversationFor(request.sessionId)
      if (faces === null) return { added: false, attachments: 0, reason: '会话输入框不可用，请先切到对应会话。' }
      const { conversation, scope } = faces
      let attachmentIds = []
      if (request.image) {
        try {
          const file = fileFromDataUrl(request.image.dataUrl, request.image.name)
          attachmentIds = conversation.createDrafts(request.sessionId, [file], false).map(draft => draft.id)
        } catch {
          attachmentIds = []
        }
      }
      try {
        const input = conversation.input.for(scope)
        if (attachmentIds.length > 0) input.addAttachments(attachmentIds)
        if (typeof request.note === 'string' && request.note.trim() !== '') {
          const accepted = input.insertQuote(request.note, { label: t('browser.label'), title: t('browser.label'), body: cut(request.note, 400) })
          if (!accepted) input.setDraft(`${request.note}\n`)
        }
        return { added: true, attachments: attachmentIds.length }
      } catch (error) {
        return { added: false, attachments: attachmentIds.length, reason: String(error && error.message ? error.message : error) }
      }
    }

    /* ------------------------------------------------------------- rendering */

    const styles = `
.dsb-root{display:flex;flex-direction:column;min-height:0;height:100%;font:12px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;color:inherit;background:transparent;position:relative}
.dsb-bar{display:flex;align-items:center;gap:2px;padding:4px 6px;min-height:34px;border-bottom:1px solid color-mix(in srgb,currentColor 14%,transparent);flex:0 0 auto;overflow:hidden}
.dsb-btn{display:inline-flex;align-items:center;justify-content:center;min-width:24px;height:24px;padding:0 5px;border:0;border-radius:5px;background:transparent;color:inherit;cursor:pointer;font:inherit;opacity:.82;flex:0 0 auto}
.dsb-btn:hover:not(:disabled){background:color-mix(in srgb,currentColor 12%,transparent);opacity:1}
.dsb-btn:disabled{opacity:.32;cursor:default}
.dsb-btn[data-on="true"]{background:color-mix(in srgb,currentColor 18%,transparent);opacity:1}
.dsb-addr{flex:1 1 auto;min-width:50px;height:24px;padding:0 8px;border-radius:6px;border:1px solid color-mix(in srgb,currentColor 18%,transparent);background:color-mix(in srgb,currentColor 5%,transparent);color:inherit;font:inherit;outline:none}
.dsb-addr:focus{border-color:color-mix(in srgb,currentColor 45%,transparent)}
.dsb-sep{width:1px;height:16px;margin:0 3px;background:color-mix(in srgb,currentColor 16%,transparent);flex:0 0 auto}
.dsb-stage{position:relative;flex:1 1 auto;min-height:0;overflow:hidden;background:#fff;display:flex}
.dsb-view{position:relative;display:flex;flex:1 1 auto;min-height:0;height:100%}
.dsb-stage[data-emulate="true"]{background:#e8e8ea;align-items:center;justify-content:center}
.dsb-stage[data-emulate="true"] .dsb-view{flex:0 0 auto}
.dsb-view[data-hidden="true"]{visibility:hidden;pointer-events:none}
.dsb-emulate{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;overflow:auto;background:color-mix(in srgb,#111 14%,transparent);z-index:4}
.dsb-device{display:flex;background:#fff;box-shadow:0 8px 32px rgba(0,0,0,.35);transform-origin:center center}
.dsb-pop.dsb-pop-menu{position:fixed;right:auto;top:auto;z-index:30;max-height:calc(100vh - 24px)}
.dsb-pop{position:absolute;right:6px;top:38px;z-index:20;min-width:240px;max-width:360px;max-height:340px;overflow:auto;padding:6px;border-radius:8px;border:1px solid color-mix(in srgb,currentColor 18%,transparent);background:var(--dsw-alias-bg-elevated,#fbfbfa);color:inherit;box-shadow:0 12px 32px rgba(0,0,0,.22)}
.dsb-row{display:flex;align-items:center;gap:6px;width:100%;padding:4px 6px;border:0;border-radius:5px;background:transparent;color:inherit;font:inherit;cursor:pointer;text-align:left}
.dsb-row:hover{background:color-mix(in srgb,currentColor 10%,transparent)}
.dsb-hint{position:absolute;left:50%;top:8px;transform:translateX(-50%);z-index:12;padding:4px 10px;border-radius:999px;background:#1f2937;color:#f9fafb;font-size:11px;box-shadow:0 4px 16px rgba(0,0,0,.3);pointer-events:none;max-width:90%}
.dsb-toast{position:absolute;left:50%;bottom:12px;transform:translateX(-50%);z-index:14;padding:5px 12px;border-radius:999px;background:#111827;color:#f9fafb;font-size:11px;box-shadow:0 4px 16px rgba(0,0,0,.3);pointer-events:none}
.dsb-comment{position:absolute;left:8px;bottom:8px;z-index:16;width:min(320px,86%);padding:8px;border-radius:8px;border:1px solid color-mix(in srgb,currentColor 20%,transparent);background:var(--dsw-alias-bg-elevated,#fbfbfa);box-shadow:0 12px 32px rgba(0,0,0,.25)}
.dsb-comment textarea{width:100%;min-height:56px;resize:vertical;border-radius:6px;border:1px solid color-mix(in srgb,currentColor 20%,transparent);background:transparent;color:inherit;font:inherit;padding:4px 6px}
.dsb-region{position:absolute;inset:0;z-index:9;cursor:crosshair;background:rgba(59,130,246,.08)}
.dsb-region-box{position:absolute;border:1px solid #3b82f6;background:rgba(59,130,246,.18);pointer-events:none}
.dsb-devtools{flex:0 0 40%;display:flex;flex-direction:column;min-height:120px;border-top:1px solid color-mix(in srgb,currentColor 18%,transparent);background:color-mix(in srgb,currentColor 3%,transparent)}
.dsb-tabs{display:flex;align-items:center;gap:2px;padding:3px 4px;border-bottom:1px solid color-mix(in srgb,currentColor 12%,transparent);flex:0 0 auto}
.dsb-tab{padding:2px 8px;border-radius:5px;border:0;background:transparent;color:inherit;cursor:pointer;font:inherit;opacity:.7}
.dsb-tab[data-on="true"]{background:color-mix(in srgb,currentColor 14%,transparent);opacity:1}
.dsb-log{flex:1 1 auto;overflow:auto;padding:4px 6px;font:11px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;min-height:0;margin:0;white-space:pre-wrap}
.dsb-line{display:flex;gap:6px;padding:1px 0;white-space:pre-wrap;word-break:break-word}
.dsb-line[data-level="error"]{color:#dc2626}
.dsb-line[data-level="warning"]{color:#b45309}
.dsb-line em{opacity:.55;font-style:normal;flex:0 0 auto}
.dsb-eval{display:flex;flex-direction:column;gap:4px;padding:6px;min-height:0;flex:1 1 auto}
.dsb-eval textarea{min-height:52px;max-height:120px;resize:vertical;border-radius:6px;border:1px solid color-mix(in srgb,currentColor 18%,transparent);background:transparent;color:inherit;font:11px/1.5 ui-monospace,Consolas,monospace;padding:6px}
.dsb-find{display:flex;align-items:center;gap:4px;padding:3px 6px;border-bottom:1px solid color-mix(in srgb,currentColor 12%,transparent);flex:0 0 auto}
.dsb-find input{flex:1 1 auto;min-width:50px;height:22px;padding:0 8px;border-radius:6px;border:1px solid color-mix(in srgb,currentColor 18%,transparent);background:transparent;color:inherit;font:inherit}
.dsb-muted{opacity:.6}
.dsb-list{display:flex;flex-direction:column;gap:1px;max-height:260px;overflow:auto}
.dsb-entry{display:flex;flex-direction:column;gap:1px;padding:3px 6px;border-radius:5px;border:0;background:transparent;color:inherit;font:inherit;cursor:pointer;text-align:left;overflow:hidden}
.dsb-entry:hover{background:color-mix(in srgb,currentColor 9%,transparent)}
.dsb-entry span{opacity:.6;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsb-entry strong{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsb-fill{flex:1 1 auto}
`

    /**
     * One browser tab: chrome, guest stage, overlays, DevTools panel.
     * @param {{ useTabInfo?: () => any, sessionId?: string }} props - seat props.
     */
    function BrowserBody(props) {
      const info = typeof props.useTabInfo === 'function' ? props.useTabInfo() : null
      const tab = info?.tab ?? null
      const tabId = tab?.id ?? 'unknown-tab'
      /**
       * Session identity of the sidebar pane that hosts this tab. The seat's
       * `inject` face carries hooks, not the session id, so read the pane the
       * dockkit renders around us (a public `data-*` attribute, not another
       * plugin's internals) and fall back to a seat-provided id if one appears.
       */
      const rootRef = useRef(null)
      const [sessionId, setSessionId] = useState(props.sessionId ?? null)
      const initialUrl = tab?.navigation?.params?.url ?? null
      const visible = tab === null ? true : tab.visible === true

      const [url, setUrl] = useState(initialUrl ?? '')
      const [title, setTitle] = useState('')
      const [loading, setLoading] = useState(false)
      const [ready, setReady] = useState(false)
      const [nav, setNav] = useState({ canGoBack: false, canGoForward: false })
      const [zoom, setZoom] = useState(settings.defaultZoom)
      const [findOpen, setFindOpen] = useState(false)
      const [findText, setFindText] = useState('')
      const [findState, setFindState] = useState({ active: 0, total: 0 })
      const [devtools, setDevtools] = useState({ open: false, panel: 'console' })
      const [consoleLog, setConsoleLog] = useState([])
      const [networkLog, setNetworkLog] = useState([])
      const [hint, setHint] = useState(null)
      const [toast, setToast] = useState(null)
      const [menu, setMenu] = useState(null)
      const [popover, setPopover] = useState(null)
      const [comment, setComment] = useState(null)
      const [emulate, setEmulate] = useState(null)
      const [picked, setPicked] = useState(null)
      const [region, setRegion] = useState(null)
      const [evalText, setEvalText] = useState('')
      const [evalResult, setEvalResult] = useState(null)
      const [failure, setFailure] = useState(null)

      const viewRef = useRef(null)
      const guestRef = useRef(null)
      const instanceRef = useRef(null)
      const consoleRef = useRef([])
      const networkRef = useRef([])
      const commentsRef = useRef([])
      const regionRef = useRef(null)
      const liveRef = useRef({})

      /* Resolve the hosting pane's session. The panel that carries the data
         attribute is not always an ancestor of the tab body, so fall back to the
         ui-session adapter (the same source the sidebar itself follows). */
      useEffect(() => {
        if (props.sessionId) {
          setSessionId(props.sessionId)
          bridge.identify(props.sessionId)
          return undefined
        }
        const sync = () => {
          const node = rootRef.current
          const panel = node && node.closest ? node.closest('[data-sidebar-right-session]') : null
          const near = panel ? panel.getAttribute('data-sidebar-right-session') : null
          const found = near ?? readSessionId()
          if (typeof found !== 'string' || found === '') return false
          setSessionId(found)
          bridge.identify(found)
          return true
        }
        if (sync()) return undefined
        const timer = window.setInterval(() => { if (sync()) window.clearInterval(timer) }, 700)
        return () => window.clearInterval(timer)
      }, [props.sessionId, tabId])

      liveRef.current = {
        tabId,
        sessionId,
        url,
        zoom,
        devtools,
        emulate,
        picked,
        comment,
        nav,
        visible,
        region,
        findText,
      }

      const flash = useCallback((text) => {
        setToast(text)
        window.setTimeout(() => setToast(current => (current === text ? null : current)), 2200)
      }, [])

      /* --------------------------------------------------- log/comment sinks */
      const pushConsole = useCallback((entry) => {
        const next = [...consoleRef.current, entry].slice(settings.keepConsole ? -500 : -100)
        consoleRef.current = next
        setConsoleLog(next)
      }, [])

      const pushNetwork = useCallback((entry) => {
        const next = [...networkRef.current, entry].slice(-200)
        networkRef.current = next
        setNetworkLog(next)
      }, [])

      const pushHistory = useCallback((visited, pageTitle) => {
        if (!visited) return
        const previous = historyLog[historyLog.length - 1]
        if (previous !== undefined && previous.url === visited) return
        historyLog.push({ url: visited, title: pageTitle || visited, ts: Date.now() })
        if (historyLog.length > 300) historyLog.splice(0, historyLog.length - 300)
        save('history', historyLog)
      }, [])

      const rememberComment = useCallback((payload) => {
        commentsRef.current = [...commentsRef.current, payload]
      }, [])

      const commentMarkers = useCallback(() => commentsRef.current.map((entry, index) => ({
        selector: entry.selector,
        note: entry.note,
        index: index + 1,
        color: settings.commentColor,
      })), [])

      const syncMarkers = useCallback(() => {
        const guest = guestRef.current
        if (guest === null) return
        guest.run(`window.__dsbAgent && window.__dsbAgent.markers(${JSON.stringify(commentMarkers())})`).catch(() => {})
      }, [commentMarkers])

      /* -------------------------------------------------------- chat actions */
      const addNote = useCallback((note) => {
        const result = addToComposer({ sessionId, note })
        flash(result.added ? t('toast.added') : (result.reason ?? t('toast.failed')))
        return result
      }, [flash, sessionId])

      const addCapture = useCallback(async (rect, kind) => {
        const guest = guestRef.current
        if (guest === null) throw new Error('页面尚未就绪')
        const capture = await guest.capture(rect)
        const note = [
          rect ? `${t('note.region')} · ${Math.round(rect.x)},${Math.round(rect.y)} ${Math.round(rect.width)}×${Math.round(rect.height)}` : t('note.screenshot'),
          guest.url ? `${t('note.site')}: ${guest.url}` : null,
        ].filter(Boolean).join('\n')
        const result = addToComposer({ sessionId, note, image: { dataUrl: capture.dataUrl, name: `dsh-browser-${kind}.png` } })
        flash(result.added ? t('toast.added') : (result.reason ?? t('toast.failed')))
        return { ...result, width: capture.width, height: capture.height }
      }, [flash, sessionId])

      const elementNote = useCallback((element, note) => {
        return [
          `${element.tag}${element.name ? ` “${cut(element.name, 80)}”` : ''}`,
          element.url ? `${t('note.site')}: ${element.url}` : null,
          element.href ? `${t('element.link')}: ${element.href}` : null,
          `${t('element.selector')}: \`${element.selector}\``,
          element.text ? `${t('element.text')}: ${cut(element.text.replace(/\n/gu, ' '), 300)}` : null,
          note ? `${t('element.comment')}: ${note}` : null,
          element.html ? '```html\n' + cut(element.html, 1000) + '\n```' : null,
        ].filter(Boolean).join('\n')
      }, [])

      const deliverElement = useCallback((element, note) => {
        const guest = guestRef.current
        const payload = { ...element, url: guest?.url ?? '', note: note ?? null }
        const record = { ...payload, id: `${tabId}-${Date.now()}`, tabId, index: commentsRef.current.length + 1, color: settings.commentColor }
        bridge.report({ type: 'comment', comment: record })
        rememberComment(payload)
        const result = addToComposer({ sessionId, note: elementNote(payload, note) })
        flash(result.added ? t('toast.added') : (result.reason ?? t('toast.failed')))
        syncMarkers()
        return { ...result, element: payload, comment: record }
      }, [elementNote, flash, rememberComment, sessionId, syncMarkers, tabId])

      /* -------------------------------------------------------- guest events */
      const handleGuestEvent = useCallback((event) => {
        const guest = guestRef.current
        switch (event.kind) {
          case 'ready': setReady(true); break
          case 'loading': setLoading(event.loading === true); break
          case 'url': {
            const next = event.url ?? ''
            setUrl(next)
            if (next !== '' && !next.startsWith('about:blank')) save(`url:${tabId}`, next)
            break
          }
          case 'title': setTitle(event.title ?? ''); break
          case 'nav': setNav({ canGoBack: event.canGoBack === true, canGoForward: event.canGoForward === true }); break
          case 'find': setFindState({ active: event.find?.active ?? 0, total: event.find?.total ?? 0 }); break
          case 'failed': setFailure(event.description ?? 'load-failed'); break
          case 'gone':
          case 'destroyed': setReady(false); break
          case 'visit': pushHistory(event.url, event.title); break
          case 'console': {
            const entry = { ...event.entry, url: guest?.url ?? '' }
            pushConsole(entry)
            bridge.report({ type: 'console', entries: [{ ...entry, tabId }] })
            break
          }
          case 'agent': {
            const agentEvent = event.event
            if (agentEvent?.type === 'console') {
              pushConsole({ ...agentEvent, url: guest?.url ?? '' })
              bridge.report({ type: 'console', entries: [{ ...agentEvent, tabId, url: guest?.url ?? '' }] })
            } else if (agentEvent?.type === 'network') {
              pushNetwork(agentEvent)
              bridge.report({ type: 'network', entries: [{ ...agentEvent, tabId, url: guest?.url ?? '' }] })
            } else if (agentEvent?.type === 'menu') {
              /* Page coordinates become pane coordinates through the stage. */
              const view = viewRef.current
              const rect = view === null ? { left: 0, top: 0 } : view.getBoundingClientRect()
              setMenu({ x: rect.left + Number(agentEvent.x ?? 0), y: rect.top + Number(agentEvent.y ?? 0) })
            } else if (agentEvent?.type === 'pick') {
              if (agentEvent.mode === 'cancel') { setHint(null); setComment(null); break }
              setHint(null)
              setPicked(agentEvent.element)
              setComment({ element: agentEvent.element, note: '' })
            }
            break
          }
          default: break
        }
      }, [pushConsole, pushHistory, pushNetwork, tabId])

      /* ------------------------------------------------------------- mounting */
      useEffect(() => {
        const desktop = typeof window !== 'undefined' ? window.dshDesktop : undefined
        if (desktop === undefined || desktop.protocolVersion !== 1 || desktop.browser === undefined) {
          setFailure('no-bridge')
          return undefined
        }
        let disposed = false
        let reservation = null
        const host = viewRef.current
        if (host === null) return undefined

        /** Workspace key shared with the built-in browser, so logins carry over. */
        const workspaceKey = () => {
          try {
            const sessions = serviceContext?.get('sessions')
            const record = sessions?.list?.getSnapshot?.().byId?.[sessionId]
            if (record?.cwd) return `cwd:${record.cwd}`
          } catch { /* fall through */ }
          return sessionId === null ? 'cwd:default' : `session:${sessionId}`
        }

        desktop.browser.acquire(workspaceKey()).then((acquired) => {
          if (disposed) {
            desktop.browser.release(acquired.lease).catch(() => {})
            return
          }
          reservation = acquired
          const guest = new Guest(host, acquired, handleGuestEvent)
          guestRef.current = guest
          const preset = liveRef.current.emulate ?? null
          if (preset !== null) guest.resize(preset.width, preset.height, emulateScale(preset))
          guest.start()
          const instance = createInstance()
          instanceRef.current = instance
          instances.set(tabId, instance)
          scheduleReport()
          // Reloading the shell discards the guest, so remember where each tab was.
          const target = initialUrl ?? load(`url:${tabId}`, '') ?? 'about:blank'
          if (typeof window !== 'undefined' && window.__dshBrowserDebug !== undefined) {
            window.__dshBrowserDebug.lastMount = { tabId, initialUrl, saved: load(`url:${tabId}`, null), target }
          }
          if (typeof target === 'string' && target !== 'about:blank' && target !== '') guest.load(target, 15000).catch((error) => setFailure(String(error && error.message ? error.message : error)))
        }).catch((error) => {
          setFailure(String(error && error.message ? error.message : error))
        })

        return () => {
          disposed = true
          instances.delete(tabId)
          scheduleReport()
          const guest = guestRef.current
          guestRef.current = null
          instanceRef.current = null
          if (guest !== null) guest.destroy()
          if (reservation !== null) desktop.browser.release(reservation.lease).catch(() => {})
        }
      }, [tabId])

      /* --------------------------------------------------- visibility + bars */
      useEffect(() => {
        if (visible) activeTabId = tabId
        scheduleReport()
      }, [visible, tabId, url, title, loading])

      /* ------------------------------------------------------- zoom plumbing */
      const applyZoom = useCallback((factor) => {
        const value = clamp(Number(factor) || 1, 0.25, 5)
        setZoom(value)
        const guest = guestRef.current
        if (guest !== null) {
          try { guest.element.setZoomFactor(value) } catch { /* unsupported */ }
        }
        return { zoom: value }
      }, [])

      const zoomStep = useCallback((direction) => applyZoom(nextZoom(liveRef.current.zoom ?? 1, direction)), [applyZoom])

      /* ------------------------------------------------------- find plumbing */
      // The guest find session does not always report `found-in-page` (Electron
      // only emits it for some guests), so the count comes from the page agent
      // while `findInPage` still drives the native highlight and scrolling.
      const runFind = useCallback(async (text, direction = 'new') => {
        const guest = guestRef.current
        if (guest === null) return { matched: false }
        const clean = String(text ?? '')
        guest.find.text = clean
        if (clean.trim() === '') {
          try { guest.element.stopFindInPage('clearSelection') } catch { /* detached */ }
          setFindState({ active: 0, total: 0 })
          return { matched: true }
        }
        let total = 0
        try {
          total = Number(await guest.run(`window.__dsbAgent ? window.__dsbAgent.countText(${JSON.stringify(clean)}) : 0`)) || 0
        } catch { total = 0 }
        try {
          guest.element.findInPage(clean, { findNext: direction !== 'new', forward: direction !== 'previous' })
        } catch { /* detached */ }
        setFindState((previous) => {
          if (total === 0) return { active: 0, total: 0 }
          const cycle = previous.total === total && previous.active > 0
          if (direction === 'previous') return { active: cycle ? ((previous.active - 2 + total) % total) + 1 : total, total }
          if (direction === 'next') return { active: cycle ? (previous.active % total) + 1 : 1, total }
          return { active: 1, total }
        })
        return { matched: total > 0 }
      }, [])

      /* ------------------------------------------------------ storage/emulate */
      const clearStorage = useCallback(async () => {
        const guest = guestRef.current
        if (guest === null) return { cleared: false }
        const report = await guest.run('window.__dsbAgent ? window.__dsbAgent.storage(true) : null').catch(() => null)
        flash(t('toast.cleared'))
        return { cleared: true, report }
      }, [flash])

      const applyEmulation = useCallback((device) => {
        const guest = guestRef.current
        const preset = device === 'none' ? null : EMULATION_PRESETS[device] ?? null
        if (guest !== null) {
          try { guest.element.setUserAgent(preset?.ua ?? '') } catch { /* the attribute is optional */ }
          guest.resize(preset?.width ?? null, preset?.height ?? null, preset === null ? 1 : emulateScale(preset))
        }
        setEmulate(preset === null ? null : { device, ...preset })
        return { emulation: preset === null ? null : { device, ...preset } }
      }, [])

      /* ------------------------------------------------------------ instance */
      const createInstance = () => {
        const state = () => liveRef.current
        const guest = () => guestRef.current

        /** Resolve a target element and its centre point, or throw. */
        const rectOf = async (args) => {
          const target = args.ref ?? args.selector ?? null
          if (target === null) throw new Error('需要 ref 或 selector。')
          const rect = await guest().run(`window.__dsbAgent ? window.__dsbAgent.rect(${JSON.stringify(target)}) : null`)
          if (rect === null) throw new Error(`元素未找到: ${target}`)
          return rect
        }

        const handlers = {
          async open(args) {
            const target = String(args.url ?? '')
            if (target === '') throw new Error('缺少 url。')
            const result = await guest().load(target, args.waitMs ?? 15000)
            return { tabId: state().tabId, ...result }
          },
          async navigate(args) {
            const action = args.action ?? (typeof args.url === 'string' && args.url !== '' ? 'goto' : 'reload')
            const g = guest()
            if (action === 'goto') {
              const result = await g.load(String(args.url ?? ''), args.waitMs ?? 15000)
              return { tabId: state().tabId, action, ...result }
            }
            if (action === 'back') g.element.goBack()
            else if (action === 'forward') g.element.goForward()
            else if (action === 'reload') g.element.reload()
            else if (action === 'stop') g.element.stop()
            await g.waitForReady(2000)
            g.sync()
            return { tabId: state().tabId, action, url: g.url, title: g.title }
          },
          async tabs(args) {
            const action = args.action ?? 'list'
            if (action === 'list') {
              return { tabs: [...instances.values()].map(entry => ({ id: entry.tabId, url: entry.guest?.url ?? '', title: entry.guest?.title || entry.title || t('browser.untitled'), visible: entry.tabId === activeTabId })), activeTabId }
            }
            if (action === 'activate') {
              ctxFocus(args.tabId ?? state().tabId)
              activeTabId = args.tabId ?? state().tabId
              scheduleReport()
              return { activeTabId }
            }
            if (action === 'close') {
              ctxClose(args.tabId ?? state().tabId)
              return { closed: args.tabId ?? state().tabId }
            }
            if (action === 'reload') { guest().element.reload(); return { tabId: state().tabId, reloaded: true } }
            if (action === 'open') { ctxOpenTab(String(args.url ?? 'about:blank'), args.background === true); return { opened: args.url ?? null } }
            throw new Error(`未知 tabs 操作: ${action}`)
          },
          async snapshot(args) {
            const options = {
              interactiveOnly: args.interactiveOnly === true,
              maxDepth: args.maxDepth ?? 12,
              maxChars: args.maxChars ?? 20000,
            }
            const value = await guest().run(`window.__dsbAgent ? window.__dsbAgent.snapshot(${JSON.stringify(options)}) : null`)
            if (value === null) throw new Error('页面代理未就绪，页面可能仍在加载。')
            const lines = Array.isArray(value.lines) ? value.lines : []
            // The model reads the tree as text; the array is only useful for counts.
            return { tabId: state().tabId, url: value.url, title: value.title, text: lines.join('\n'), lineCount: lines.length, truncated: value.truncated === true }
          },
          async text(args) {
            const value = await guest().run(`window.__dsbAgent ? window.__dsbAgent.text(${JSON.stringify(args.selector ?? null)}, ${Number(args.maxChars ?? 20000)}) : null`)
            if (value === null) throw new Error('页面代理未就绪。')
            return { tabId: state().tabId, ...value }
          },
          async click(args) {
            const g = guest()
            if (typeof args.x === 'number' && typeof args.y === 'number' && args.ref === undefined && args.selector === undefined) {
              const point = { x: Math.round(args.x), y: Math.round(args.y) }
              g.element.sendInputEvent({ type: 'mouseDown', ...point, button: args.button ?? 'left', clickCount: args.clickCount ?? 1 })
              g.element.sendInputEvent({ type: 'mouseUp', ...point, button: args.button ?? 'left', clickCount: args.clickCount ?? 1 })
              return { tabId: state().tabId, clicked: `${point.x},${point.y}` }
            }
            const rect = await rectOf(args)
            const point = { x: Math.round(rect.x), y: Math.round(rect.y) }
            try {
              g.element.sendInputEvent({ type: 'mouseDown', ...point, button: args.button ?? 'left', clickCount: args.clickCount ?? 1 })
              g.element.sendInputEvent({ type: 'mouseUp', ...point, button: args.button ?? 'left', clickCount: args.clickCount ?? 1 })
            } catch {
              const selector = args.selector ?? `[data-dsb-ref="${args.ref}"]`
              await g.run(`(function(){var el=document.querySelector(${JSON.stringify(selector)});if(!el)return false;el.click();return true})()`)
            }
            return { tabId: state().tabId, clicked: args.ref ?? args.selector, point }
          },
          async type(args) {
            const g = guest()
            const text = String(args.text ?? '')
            const target = args.ref ?? args.selector ?? null
            if (target !== null) {
              const code = args.clear === false
                ? `window.__dsbAgent ? window.__dsbAgent.appendValue(${JSON.stringify(target)}, ${JSON.stringify(text)}) : false`
                : `window.__dsbAgent ? window.__dsbAgent.setValue(${JSON.stringify(target)}, ${JSON.stringify(text)}) : false`
              const ok = await g.run(code)
              if (ok !== true) throw new Error(`输入失败，元素未找到: ${target}`)
            } else {
              await g.run('document.activeElement && document.activeElement.focus && document.activeElement.focus()').catch(() => {})
              for (const character of text) {
                g.element.sendInputEvent({ type: 'char', keyCode: character })
                if (args.delayMs) await new Promise(resolve => setTimeout(resolve, args.delayMs))
              }
            }
            if (args.submit === true) {
              await g.run(`window.__dsbAgent ? window.__dsbAgent.submit(${JSON.stringify(target)}) : false`).catch(() => {})
            }
            return { tabId: state().tabId, typed: text.length, submitted: args.submit === true }
          },
          async press(args) {
            const keys = String(args.keys ?? '').trim()
            if (keys === '') throw new Error('缺少 keys。')
            const parts = keys.split('+').map(part => part.trim()).filter(Boolean)
            const key = parts.length > 0 ? parts[parts.length - 1] : keys
            const modifiers = parts.slice(0, -1).map(part => part.toLowerCase())
            const event = { keyCode: normaliseKey(key), modifiers }
            guest().element.sendInputEvent({ type: 'keyDown', ...event })
            guest().element.sendInputEvent({ type: 'keyUp', ...event })
            return { tabId: state().tabId, keys, key, modifiers }
          },
          async wait(args) {
            const g = guest()
            const deadline = Date.now() + clamp(Number(args.timeoutMs ?? 10000), 200, 60000)
            const wantHidden = args.state === 'hidden'
            while (Date.now() < deadline) {
              if (typeof args.selector === 'string' && args.selector !== '') {
                const found = await g.run(`!!document.querySelector(${JSON.stringify(args.selector)})`)
                if (found === !wantHidden) return { tabId: state().tabId, matched: 'selector', value: args.selector }
              } else if (typeof args.text === 'string' && args.text !== '') {
                const found = await g.run(`document.body.innerText.includes(${JSON.stringify(args.text)})`)
                if (found === !wantHidden) return { tabId: state().tabId, matched: 'text', value: args.text }
              } else {
                const stateName = await g.run('document.readyState')
                if (stateName === 'complete') return { tabId: state().tabId, matched: 'readyState' }
              }
              await new Promise(resolve => setTimeout(resolve, 250))
            }
            throw new Error('等待超时。')
          },
          async evaluate(args) {
            const value = await guest().run(String(args.expression ?? ''))
            return { tabId: state().tabId, value: value === undefined ? null : value }
          },
          async screenshot(args) {
            const g = guest()
            if (typeof args.selector === 'string' && args.selector !== '') {
              const rect = await g.run(`(function(){var el=document.querySelector(${JSON.stringify(args.selector)});if(!el)return null;try{el.scrollIntoView({block:'center'})}catch(e){}var r=el.getBoundingClientRect();return {x:r.left,y:r.top,width:r.width,height:r.height}})()`)
              if (rect === null) throw new Error(`元素未找到: ${args.selector}`)
              const capture = await g.capture({ x: Math.max(0, Math.floor(rect.x)), y: Math.max(0, Math.floor(rect.y)), width: Math.ceil(rect.width), height: Math.ceil(rect.height) })
              return { ...capture, name: args.name ?? 'element' }
            }
            if (args.fullPage === true) {
              const metrics = await g.run('({w:document.documentElement.scrollWidth,h:document.documentElement.scrollHeight})')
              const capture = await g.capture({ x: 0, y: 0, width: Math.min(metrics.w, 4096), height: Math.min(metrics.h, 4096) })
              return { ...capture, name: args.name ?? 'fullpage' }
            }
            const capture = await g.capture()
            return { ...capture, name: args.name ?? 'screenshot' }
          },
          async regionScreenshot(args) {
            const rect = {
              x: Math.max(0, Math.round(Number(args.x ?? 0))),
              y: Math.max(0, Math.round(Number(args.y ?? 0))),
              width: Math.max(1, Math.round(Number(args.width ?? 200))),
              height: Math.max(1, Math.round(Number(args.height ?? 200))),
            }
            const capture = await guest().capture(rect)
            return { ...capture, rect, name: args.name ?? 'region' }
          },
          async find(args) {
            const action = args.action ?? 'find'
            const text = String(args.text ?? '')
            const g = guest()
            if (action === 'stop') { g.element.stopFindInPage('clearSelection'); return { stopped: true } }
            g.find.text = text
            g.element.findInPage(text, { findNext: action !== 'find', forward: action !== 'previous' })
            return { tabId: state().tabId, text, action }
          },
          async zoom(args) {
            const action = args.action ?? 'reset'
            if (action === 'in') return applyZoom(nextZoom(state().zoom ?? 1, 1))
            if (action === 'out') return applyZoom(nextZoom(state().zoom ?? 1, -1))
            if (action === 'set') return applyZoom(Number(args.factor ?? 1))
            return applyZoom(settings.defaultZoom)
          },
          async devtools(args) {
            const action = args.action ?? 'toggle'
            const current = state().devtools ?? { open: false, panel: 'console' }
            const open = action === 'open' ? true : action === 'close' ? false : !current.open
            setDevtools({ open, panel: args.panel ?? current.panel })
            return { tabId: state().tabId, open, panel: args.panel ?? current.panel }
          },
          async storage(args) {
            if ((args.action ?? 'status') === 'clear') return clearStorage()
            const report = await guest().run('window.__dsbAgent ? window.__dsbAgent.storage(false) : null').catch(() => null)
            return { tabId: state().tabId, ...(report ?? {}) }
          },
          async permissions() {
            const g = guest()
            return {
              tabId: state().tabId,
              url: g.url,
              partition: g.reservation.partition,
              policy: 'deny-all',
              permissions: ['camera', 'microphone', 'notifications', 'geolocation', 'display-capture', 'clipboard-read', 'popups', 'downloads'],
              note: '桌面壳固定拒绝站点权限与下载。',
            }
          },
          async history(args) {
            if ((args.action ?? 'list') === 'clear') {
              historyLog.length = 0
              save('history', historyLog)
              return { cleared: true }
            }
            const needle = String(args.query ?? '').toLowerCase()
            const limit = clamp(Number(args.limit ?? 50), 1, 300)
            const entries = historyLog
              .filter(entry => needle === '' || entry.url.toLowerCase().includes(needle) || String(entry.title).toLowerCase().includes(needle))
              .slice(-limit)
              .reverse()
            return { count: entries.length, entries }
          },
          async emulate(args) {
            const device = String(args.device ?? 'none')
            if (device === 'none' && typeof args.width !== 'number') return applyEmulation('none')
            if (EMULATION_PRESETS[device] !== undefined) return applyEmulation(device)
            const preset = { width: Math.max(160, Number(args.width ?? 390)), height: Math.max(200, Number(args.height ?? 844)), ua: null }
            try { guest().element.setUserAgent('') } catch { /* unsupported */ }
            setEmulate({ device: 'custom', ...preset })
            return { emulation: { device: 'custom', ...preset } }
          },
          async comment(args) {
            const target = args.ref ?? args.selector ?? null
            let element = state().picked
            if (target !== null) {
              element = await guest().run(`window.__dsbAgent ? window.__dsbAgent.describe(${JSON.stringify(target)}) : null`)
            }
            if (!element) throw new Error('未找到要评论的元素：先选取元素或传入 selector。')
            const payload = { ...element, url: guest().url, note: String(args.note ?? ''), tabId: state().tabId, id: `${state().tabId}-${Date.now()}`, index: commentsRef.current.length + 1, color: settings.commentColor }
            rememberComment(payload)
            bridge.report({ type: 'comment', comment: payload })
            syncMarkers()
            return payload
          },
          async addToChat(args) {
            const kind = String(args.kind ?? 'screenshot')
            if (kind === 'element') {
              const target = args.ref ?? args.selector ?? null
              let element = state().picked
              if (target !== null) {
                element = await guest().run(`window.__dsbAgent ? window.__dsbAgent.describe(${JSON.stringify(target)}) : null`)
              }
              if (!element) throw new Error('未找到元素：先选取元素或传入 selector。')
              return deliverElement(element, args.note ?? null)
            }
            if (kind === 'console') {
              const tail = consoleRef.current.slice(-40).map(entry => `[${entry.level}] ${cut(entry.text, 300)}`).join('\n')
              const note = `**${t('browser.label')}** · ${t('menu.consoleLog')}\n地址: ${guest().url}\n\`\`\`\n${tail || t('devtools.empty')}\n\`\`\``
              const result = addToComposer({ sessionId: state().sessionId, note })
              flash(result.added ? t('toast.added') : (result.reason ?? t('toast.failed')))
              return { ...result, lines: tail === '' ? 0 : tail.split('\n').length }
            }
            if (kind === 'region') {
              const rect = {
                x: Math.max(0, Number(args.x ?? 0)),
                y: Math.max(0, Number(args.y ?? 0)),
                width: Math.max(1, Number(args.width ?? 300)),
                height: Math.max(1, Number(args.height ?? 300)),
              }
              return addCapture(rect, 'region')
            }
            return addCapture(null, 'screenshot')
          },
        }

        return {
          tabId,
          sessionId,
          /** Live guest accessor: the ref is filled asynchronously by the mount effect. */
          get guest() { return guestRef.current },
          get title() { return guestRef.current?.title ?? '' },
          async handle(op, args) {
            const handler = handlers[op]
            if (handler === undefined) throw new Error(`未知浏览器操作: ${op}`)
            if (guestRef.current === null && op !== 'tabs') throw new Error('浏览器尚未就绪。')
            return handler(args ?? {})
          },
        }
      }

      /* --------------------------------------------------------- host routing */
      useEffect(() => {
        bridge.onCommand = async (op, args, tabIdWanted) => {
          if (op === 'tabs') {
            const owner = instances.get(activeTabId) ?? instances.get(tabId) ?? [...instances.values()][0]
            if (owner === undefined) throw new Error('当前没有可用的浏览器页签。')
            return owner.handle(op, args)
          }
          const target = tabIdWanted === null ? instances.get(activeTabId) : instances.get(tabIdWanted)
          const fallback = target ?? (instances.size === 1 ? [...instances.values()][0] : undefined)
          if (fallback === undefined) throw new Error('当前没有可用的浏览器页签：请先打开 Browser 页签。')
          return fallback.handle(op, args)
        }
        return () => { bridge.onCommand = null }
      }, [tabId])

      /* ------------------------------------------------------------ shortcuts */
      useEffect(() => {
        const onKey = (event) => {
          if (!visible) return
          const meta = event.ctrlKey || event.metaKey
          const key = String(event.key || '')
          if (key === 'F12') { event.preventDefault(); setDevtools(current => ({ open: !current.open, panel: current.panel })); return }
          if (meta && key.toLowerCase() === 'f') { event.preventDefault(); setFindOpen(true); return }
          if (meta && (key === '=' || key === '+')) { event.preventDefault(); zoomStep(1); return }
          if (meta && key === '-') { event.preventDefault(); zoomStep(-1); return }
          if (meta && key === '0') { event.preventDefault(); applyZoom(settings.defaultZoom); return }
          if (key === 'Escape') {
            setComment(null)
            setHint(null)
            setRegion(null)
            setMenu(null)
            setPopover(null)
            /* Escape also closes the find bar, like Chromium does. */
            if (findOpen) {
              setFindOpen(false)
              runFind('')
            }
          }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [visible, zoomStep, applyZoom, findOpen, runFind])

      /* Dismiss the menu and popovers on an outside click, like a real browser. */
      useEffect(() => {
        if (menu === null && popover === null) return undefined
        const onDown = (event) => {
          const target = event.target
          if (target instanceof Element && target.closest('.dsb-pop') !== null) return
          setMenu(null)
          setPopover(null)
        }
        document.addEventListener('pointerdown', onDown, true)
        return () => document.removeEventListener('pointerdown', onDown, true)
      }, [menu, popover])

      /* -------------------------------------------------------- address entry */
      const navigateTo = useCallback((raw) => {
        const text = String(raw ?? '').trim()
        if (text === '') return
        const guest = guestRef.current
        if (guest === null) return
        const target = /^(https?|file|about|data):/iu.test(text)
          ? text
          : (/^[\w-]+(\.[\w-]+)+/u.test(text) ? `https://${text}` : `https://www.bing.com/search?q=${encodeURIComponent(text)}`)
        guest.load(target, 15000).catch((error) => setFailure(String(error && error.message ? error.message : error)))
      }, [])

      /* ---------------------------------------------------------- region pick */
      const beginRegion = useCallback(() => {
        setRegion({ startX: 0, startY: 0, x: 0, y: 0, width: 0, height: 0, dragging: false })
        setHint(t('region.hint'))
      }, [])

      const regionPoint = (event) => {
        const stage = event.currentTarget.getBoundingClientRect()
        return { x: Math.round(event.clientX - stage.left), y: Math.round(event.clientY - stage.top) }
      }

      const regionHandlers = {
        onMouseDown: (event) => {
          event.preventDefault()
          const point = regionPoint(event)
          const next = { startX: point.x, startY: point.y, x: point.x, y: point.y, width: 0, height: 0, dragging: true }
          regionRef.current = next
          setRegion(next)
        },
        onMouseMove: (event) => {
          // The point has to be read from the live event: inside a state updater
          // React has already cleared `currentTarget`.
          const current = regionRef.current
          if (current === null || current.dragging !== true) return
          const point = regionPoint(event)
          const next = {
            ...current,
            x: Math.min(current.startX, point.x),
            y: Math.min(current.startY, point.y),
            width: Math.abs(point.x - current.startX),
            height: Math.abs(point.y - current.startY),
          }
          regionRef.current = next
          setRegion(next)
        },
        onMouseUp: () => {
          // Read the drag from the ref: a state updater must stay pure, and the
          // box has to be known before the capture starts.
          const box = regionRef.current
          regionRef.current = null
          setRegion(null)
          if (box === null || box.dragging !== true) return
          if (box.width < 4 || box.height < 4) return
          setHint(null)
          addCapture({ x: box.x, y: box.y, width: box.width, height: box.height }, 'region').catch(() => flash(t('toast.failed')))
        },
        onMouseLeave: () => { regionRef.current = null; setRegion(null) },
      }

      /* ------------------------------------------------------------- pickers */
      const startPicker = useCallback((mode) => {
        const guest = guestRef.current
        if (guest === null) return
        setHint(mode === 'comment' ? t('comment.hint') : t('pick.hint'))
        guest.run(`window.__dsbAgent && window.__dsbAgent.startPicker(${JSON.stringify(mode)})`).catch(() => {})
      }, [])

      /* -------------------------------------------------------------- actions */
      const actions = {
        newTab: () => ctxOpenTab(null, false),
        zoomIn: () => zoomStep(1),
        zoomOut: () => zoomStep(-1),
        zoomReset: () => applyZoom(settings.defaultZoom),
        find: () => setFindOpen(true),
        emulate: () => setPopover('emulate'),
        external: () => {
          const current = guestRef.current?.url ?? ''
          if (current !== '') {
            try { window.open(current, '_blank') } catch { /* shell refused */ }
          }
        },
        history: () => setPopover('history'),
        bookmark: () => {
          const entry = { url: guestRef.current?.url ?? '', title: guestRef.current?.title || url, ts: Date.now() }
          /* One bookmark per address: an existing entry is refreshed in place. */
          const at = bookmarks.findIndex(item => item.url === entry.url)
          if (at === -1) bookmarks.push(entry)
          else bookmarks[at] = entry
          save('bookmarks', bookmarks)
          flash(t('toast.saved'))
        },
        bookmarks: () => setPopover('bookmarks'),
        permissions: () => setPopover('permissions'),
        clearStorage: () => { clearStorage() },
        settings: () => setPopover('settings'),
        screenshot: () => { addCapture(null, 'screenshot').catch(() => flash(t('toast.failed'))) },
        region: () => beginRegion(),
        pick: () => startPicker('pick'),
        comment: () => startPicker('comment'),
        consoleLog: () => addNote(consoleTailNote(consoleRef.current, guestRef.current?.url ?? '')),
        devtools: () => setDevtools(current => ({ open: !current.open, panel: current.panel })),
        copyUrl: () => {
          const current = guestRef.current?.url ?? url
          navigator.clipboard?.writeText(current).then(() => flash(t('toast.copied'))).catch(() => {})
        },
      }

      const submitComment = useCallback(() => {
        const current = liveRef.current.comment
        if (current === null || current === undefined) return
        deliverElement(current.element, current.note.trim() === '' ? null : current.note.trim())
        setComment(null)
        setPicked(null)
      }, [deliverElement])

      /* ------------------------------------------------------------ rendering */
      if (failure === 'no-bridge') {
        return h('div', { className: 'dsb-root dsb-muted', style: { padding: 12 } }, t('noBridge'))
      }

      // The guest is mounted once into a stable container: Electron keeps the
      // guest layer pinned to the element it was attached to, so re-parenting
      // it for emulation would leave the page drawn in the wrong place.
      const stage = h('div', { className: 'dsb-stage', 'data-emulate': emulate === null ? 'false' : 'true' },
        h('div', { className: 'dsb-view', ref: viewRef, 'data-hidden': visible ? 'false' : 'true' }),
        emulate === null ? null : h('div', { className: 'dsb-hint' }, `${emulate.device} · ${emulate.width}×${emulate.height}`),
        region !== null ? h('div', {
          className: 'dsb-region',
          onMouseDown: regionHandlers.onMouseDown,
          onMouseMove: regionHandlers.onMouseMove,
          onMouseUp: regionHandlers.onMouseUp,
          onMouseLeave: regionHandlers.onMouseLeave,
        }, region.width > 0 ? h('div', { className: 'dsb-region-box', style: { left: region.x, top: region.y, width: region.width, height: region.height } }) : null) : null,
        hint !== null ? h('div', { className: 'dsb-hint' }, hint) : null,
        toast !== null ? h('div', { className: 'dsb-toast' }, toast) : null,
        comment !== null ? h('div', { className: 'dsb-comment' },
          h('div', { className: 'dsb-muted', style: { marginBottom: 4 } }, `${comment.element.tag} · ${cut(comment.element.selector, 56)}`),
          h('textarea', {
            value: comment.note,
            placeholder: t('comment.placeholder'),
            autoFocus: true,
            onChange: (event) => setComment({ element: comment.element, note: event.target.value }),
          }),
          h('div', { style: { display: 'flex', gap: 4, marginTop: 6 } },
            h('button', { className: 'dsb-btn', onClick: submitComment }, t('comment.submit')),
            h('button', { className: 'dsb-btn', onClick: () => setComment(null) }, t('comment.cancel')),
          ),
        ) : null,
        menu !== null ? renderMenu(menu, actions, () => setMenu(null)) : null,
        popover !== null ? renderPopover(popover, {
          close: () => setPopover(null),
          url: guestRef.current?.url ?? url,
          partition: guestRef.current?.reservation?.partition ?? '',
          zoom,
          applyZoom,
          flash,
          history: historyLog,
          bookmarks,
          navigate: (value) => { setPopover(null); navigateTo(value) },
          emulateNow: (device) => { setPopover(null); if (device === 'none') applyEmulation('none'); else applyEmulation(device) },
        }) : null,
      )

      return h('div', { className: 'dsb-root', ref: rootRef },
        h('div', { className: 'dsb-bar' },
          h('button', { className: 'dsb-btn', title: t('action.back'), disabled: nav.canGoBack !== true, onClick: () => guestRef.current?.element.goBack() }, '‹'),
          h('button', { className: 'dsb-btn', title: t('action.forward'), disabled: nav.canGoForward !== true, onClick: () => guestRef.current?.element.goForward() }, '›'),
          h('button', {
            className: 'dsb-btn',
            title: loading ? t('action.stop') : t('action.reload'),
            onClick: () => {
              const guest = guestRef.current
              if (guest === null) return
              if (guest.loading) guest.element.stop()
              else guest.element.reload()
            },
          }, loading ? '×' : '⟳'),
          h('input', {
            className: 'dsb-addr',
            value: url === 'about:blank' ? '' : url,
            placeholder: t('addr.placeholder'),
            spellCheck: false,
            onChange: (event) => setUrl(event.target.value),
            onFocus: (event) => event.currentTarget.select(),
            onKeyDown: (event) => {
              if (event.key === 'Enter') { event.preventDefault(); navigateTo(event.currentTarget.value); event.currentTarget.blur() }
              if (event.key === 'Escape') event.currentTarget.blur()
            },
          }),
          h('button', { className: 'dsb-btn', title: t('action.go'), onClick: () => navigateTo(url === 'about:blank' ? '' : url) }, '↵'),
          h('span', { className: 'dsb-sep' }),
          h('button', { className: 'dsb-btn', title: t('action.screenshot'), onClick: actions.screenshot }, '⤓'),
          h('button', { className: 'dsb-btn', title: t('action.region'), onClick: beginRegion }, '▣'),
          h('button', { className: 'dsb-btn', title: t('action.pick'), onClick: () => startPicker('pick') }, '⌖'),
          h('button', { className: 'dsb-btn', title: t('action.comment'), onClick: () => startPicker('comment') }, '✎'),
          h('button', { className: 'dsb-btn', title: t('action.devtools'), 'data-on': devtools.open ? 'true' : 'false', onClick: () => setDevtools(current => ({ open: !current.open, panel: current.panel })) }, '⚙'),
          h('button', {
            className: 'dsb-btn',
            title: t('browser.menu'),
            onClick: (event) => {
              const rect = event.currentTarget.getBoundingClientRect()
              setMenu({ x: rect.right, y: rect.bottom })
            },
          }, '☰'),
        ),
        findOpen ? h('div', { className: 'dsb-find' },
          h('input', {
            autoFocus: true,
            value: findText,
            placeholder: t('find.placeholder'),
            onChange: (event) => { setFindText(event.target.value); runFind(event.target.value, 'new') },
            onKeyDown: (event) => {
              if (event.key === 'Enter') { event.preventDefault(); runFind(findText, event.shiftKey ? 'previous' : 'next') }
              if (event.key === 'Escape') { setFindOpen(false); runFind('') }
            },
          }),
          h('span', { className: 'dsb-muted' }, findState.total === 0 ? t('find.none') : t('find.count', { n: findState.active, total: findState.total })),
          h('button', { className: 'dsb-btn', onClick: () => { setFindOpen(false); runFind('') } }, '×'),
        ) : null,
        h('div', { style: { display: 'flex', flex: '1 1 auto', minHeight: 0, flexDirection: 'column' } },
          stage,
          devtools.open ? renderDevtools({
            panel: devtools.panel,
            consoleLog,
            networkLog,
            picked,
            evalText,
            evalResult,
            onPanel: (panel) => setDevtools({ open: true, panel }),
            onClose: () => setDevtools({ open: false, panel: devtools.panel }),
            onClear: () => { consoleRef.current = []; setConsoleLog([]); networkRef.current = []; setNetworkLog([]) },
            onEval: (text) => {
              setEvalText(text)
              const guest = guestRef.current
              if (guest === null) return
              guest.run(text).then((value) => setEvalResult({ ok: true, value: value === undefined ? null : value })).catch((error) => setEvalResult({ ok: false, error: String(error && error.message ? error.message : error) }))
            },
          }) : null,
        ),
        ready ? null : h('div', { className: 'dsb-hint' }, t('status.loading')),
      )
    }

    /* ----------------------------------------------------------- UI helpers */

    /** Fit a device frame into the stage. */
    function emulateScale(preset) {
      if (preset === null || preset === undefined) return 1
      const available = (typeof window === 'undefined' ? 800 : window.innerHeight) * 0.62
      return clamp(available / preset.height, 0.35, 1)
    }

    /** Map a browser key name onto Electron's sendInputEvent keyCode. */
    function normaliseKey(key) {
      const named = {
        Enter: 'Return', Escape: 'Escape', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete',
        ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
        Home: 'Home', End: 'End', PageUp: 'Prior', PageDown: 'Next', ' ': 'Space', Space: 'Space',
      }
      return named[key] ?? key
    }

    /** Console excerpt inserted by "console log to chat". */
    function consoleTailNote(entries, url) {
      const tail = entries.slice(-40).map(entry => `[${entry.level}] ${cut(entry.text, 300)}`).join('\n')
      return `**${t('browser.label')}** · ${t('menu.consoleLog')}\n地址: ${url}\n\`\`\`\n${tail || t('devtools.empty')}\n\`\`\``
    }

    /** The right-click / menu-button menu, mirroring the product browser menu. */
    function renderMenu(menu, actions, close) {
      const items = [
        ['newTab', 'menu.newTab', 'Ctrl+T'],
        'sep',
        ['zoomIn', 'menu.zoomIn', 'Ctrl+='],
        ['zoomOut', 'menu.zoomOut', 'Ctrl+-'],
        ['zoomReset', 'menu.zoomReset', 'Ctrl+NumPad0'],
        'sep',
        ['find', 'menu.find', 'Ctrl+F'],
        ['emulate', 'menu.emulate', ''],
        ['external', 'menu.external', ''],
        'sep',
        ['history', 'menu.history', 'Ctrl+H'],
        ['bookmark', 'menu.bookmark', 'Ctrl+D'],
        ['bookmarks', 'menu.bookmarks', ''],
        ['permissions', 'menu.permissions', ''],
        ['clearStorage', 'menu.clearStorage', ''],
        'sep',
        ['screenshot', 'menu.screenshot', ''],
        ['region', 'menu.region', ''],
        ['pick', 'menu.pick', ''],
        ['comment', 'menu.comment', ''],
        ['consoleLog', 'menu.consoleLog', ''],
        ['devtools', 'menu.devtools', 'F12'],
        ['copyUrl', 'menu.copyUrl', ''],
        'sep',
        ['settings', 'menu.settings', ''],
      ]
      // The menu is anchored at a viewport point (a right click inside the page or the
      // toolbar button), so it lives in the fixed layer and is clamped to the window.
      // Popovers below keep the stage-relative absolute placement.
      const width = 270
      const height = 420
      const anchorX = Math.round(menu.x)
      const anchorY = Math.round(menu.y)
      const left = anchorX + width + 10 > window.innerWidth
        ? Math.max(8, anchorX - width - 2)
        : Math.max(8, anchorX + 2)
      const top = Math.max(34, Math.min(anchorY, window.innerHeight - height - 8))
      return h('div', {
        className: 'dsb-pop dsb-pop-menu',
        style: { left, top },
        onMouseLeave: close,
      }, items.map((item, index) => {
        if (item === 'sep') return h('div', { key: `sep${index}`, style: { height: 1, margin: '4px 2px', background: 'color-mix(in srgb,currentColor 14%,transparent)' } })
        const [id, key, shortcut] = item
        return h('button', {
          key: id,
          className: 'dsb-row',
          onClick: () => {
            close()
            const run = actions[id]
            if (typeof run === 'function') run()
          },
        }, h('span', { className: 'dsb-fill' }, t(key)), shortcut ? h('span', { className: 'dsb-muted' }, shortcut) : null)
      }))
    }

    /** History, bookmarks, permissions, settings and emulation popovers. */
    function renderPopover(kind, api) {
      const shell = (title, body) => h('div', { className: 'dsb-pop' },
        h('div', { style: { display: 'flex', alignItems: 'center', marginBottom: 4 } },
          h('strong', { style: { flex: '1 1 auto', fontWeight: 600 } }, title),
          h('button', { className: 'dsb-btn', onClick: api.close, title: t('title.close') }, '×'),
        ),
        body,
      )
      if (kind === 'history') {
        const entries = [...api.history].reverse().slice(0, 60)
        return shell(t('history.title'), h('div', { className: 'dsb-list' },
          entries.length === 0
            ? h('div', { className: 'dsb-muted' }, t('history.empty'))
            : entries.map((entry, index) => h('button', {
              key: `${entry.ts}-${index}`,
              className: 'dsb-entry',
              title: entry.url,
              onClick: () => api.navigate(entry.url),
            }, h('strong', null, cut(entry.title || entry.url, 60)), h('span', null, cut(entry.url, 80)))),
          h('button', {
            className: 'dsb-btn',
            style: { marginTop: 4 },
            onClick: () => { api.history.length = 0; save('history', api.history); api.flash(t('toast.cleared')) },
          }, t('history.clear')),
        ))
      }
      if (kind === 'bookmarks') {
        const entries = [...api.bookmarks].reverse().slice(0, 60)
        return shell(t('bookmarks.title'), h('div', { className: 'dsb-list' },
          entries.length === 0
            ? h('div', { className: 'dsb-muted' }, t('bookmarks.empty'))
            : entries.map((entry, index) => h('button', {
              key: `${entry.ts}-${index}`,
              className: 'dsb-entry',
              title: entry.url,
              onClick: () => api.navigate(entry.url),
            }, h('strong', null, cut(entry.title || entry.url, 60)), h('span', null, cut(entry.url, 80)))),
        ))
      }
      if (kind === 'permissions') {
        return shell(t('permissions.title'), h('div', null,
          h('div', { className: 'dsb-muted' }, t('permissions.site')),
          h('div', { style: { marginBottom: 6, wordBreak: 'break-all' } }, api.url || '—'),
          h('div', { className: 'dsb-muted' }, t('permissions.partition')),
          h('div', { style: { marginBottom: 6, wordBreak: 'break-all' } }, api.partition || '—'),
          h('div', { className: 'dsb-muted', style: { lineHeight: 1.5 } }, t('permissions.body')),
        ))
      }
      if (kind === 'settings') {
        return shell(t('settings.title'), h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 4 } },
            h('span', null, t('settings.defaultZoom')),
            h('button', { className: 'dsb-btn', onClick: () => api.applyZoom(nextZoom(api.zoom, -1)) }, '−'),
            h('span', { style: { minWidth: 42, textAlign: 'center' } }, `${Math.round(api.zoom * 100)}%`),
            h('button', { className: 'dsb-btn', onClick: () => api.applyZoom(nextZoom(api.zoom, 1)) }, '+'),
          ),
          h('div', { className: 'dsb-muted' }, t('settings.zoomHint')),
        ))
      }
      if (kind === 'emulate') {
        const devices = ['none', 'iphone-14', 'pixel-7', 'galaxy-s23', 'ipad-mini', 'desktop-720']
        return shell(t('emulate.title'), h('div', { className: 'dsb-list' },
          devices.map(device => h('button', {
            key: device,
            className: 'dsb-entry',
            onClick: () => api.emulateNow(device),
          }, h('strong', null, device === 'none' ? t('emulate.none') : device === 'desktop-720' ? t('emulate.desktop') : device))),
        ))
      }
      return null
    }

    /** The DevTools panel: console, elements, network, eval. */
    function renderDevtools(model) {
      const tabs = [
        ['console', 'devtools.console'],
        ['elements', 'devtools.elements'],
        ['network', 'devtools.network'],
        ['eval', 'devtools.eval'],
      ]
      let body = null
      if (model.panel === 'console') {
        body = model.consoleLog.length === 0
          ? h('div', { className: 'dsb-log dsb-muted' }, t('devtools.empty'))
          : h('div', { className: 'dsb-log' }, model.consoleLog.slice(-400).map((entry, index) => h('div', {
            key: `console-${index}`,
            className: 'dsb-line',
            'data-level': entry.level ?? 'info',
          }, h('em', null, new Date(entry.ts ?? Date.now()).toLocaleTimeString()), h('span', null, cut(entry.text ?? '', 2000)))))
      } else if (model.panel === 'network') {
        body = model.networkLog.length === 0
          ? h('div', { className: 'dsb-log dsb-muted' }, t('devtools.empty'))
          : h('div', { className: 'dsb-log' }, model.networkLog.slice(-200).map((entry, index) => h('div', {
            key: `network-${index}`,
            className: 'dsb-line',
            'data-level': entry.ok === true ? 'info' : 'error',
          }, h('em', null, String(entry.status ?? 0)), h('span', null, `${entry.method ?? 'GET'} ${cut(entry.url ?? '', 240)} · ${entry.ms ?? 0}ms`))))
      } else if (model.panel === 'elements') {
        body = h('div', { className: 'dsb-eval' },
          h('div', { className: 'dsb-muted' }, t('devtools.elementsHint')),
          h('pre', { className: 'dsb-log' }, model.picked === null ? '' : JSON.stringify(model.picked, null, 2)),
        )
      } else {
        body = h('div', { className: 'dsb-eval' },
          h('textarea', {
            value: model.evalText,
            placeholder: t('devtools.hint'),
            onChange: (event) => model.onEval(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); model.onEval(event.currentTarget.value) }
            },
          }),
          h('pre', { className: 'dsb-log', style: { flex: '0 1 auto', maxHeight: 140 } },
            model.evalResult === null ? '' : model.evalResult.ok ? JSON.stringify(model.evalResult.value, null, 2) : `⚠ ${model.evalResult.error}`),
        )
      }
      return h('div', { className: 'dsb-devtools' },
        h('div', { className: 'dsb-tabs' },
          h('strong', { style: { padding: '0 6px', fontWeight: 600, opacity: 0.8 } }, t('devtools.title')),
          tabs.map(([id, key]) => h('button', {
            key: id,
            className: 'dsb-tab',
            'data-on': model.panel === id ? 'true' : 'false',
            onClick: () => model.onPanel(id),
          }, t(key))),
          h('span', { className: 'dsb-fill' }),
          h('button', { className: 'dsb-btn', onClick: model.onClear }, t('devtools.clear')),
          h('button', { className: 'dsb-btn', onClick: model.onClose, title: t('title.close') }, '×'),
        ),
        body,
      )
    }

    /* ------------------------------------------------------- sidebar bridges */

    /** Open a browser tab (or focus the active one) through the sidebar service. */
    function ctxOpenTab(url, background) {
      const ctx = serviceContext
      if (ctx === null) return
      try {
        const sidebar = ctx.get('sidebarRight')
        if (sidebar && typeof sidebar.openTab === 'function') {
          sidebar.openTab('browser', url === null ? {} : { params: { url }, revealIfOpened: background !== true })
          return
        }
      } catch { /* fall through */ }
    }

    /**
     * The Session the user is looking at: the ui-session adapter the sidebar
     * follows, then the panel's data attribute as a fallback.
     * @returns {string|null} session id.
     */
    function readSessionId() {
      try {
        const key = serviceContext?.get?.('uiSession')?.adapter?.current?.getSnapshot?.().key
        if (typeof key === 'string' && key !== '') return key
      } catch { /* the service is optional in some carriers */ }
      const values = new Set()
      for (const node of document.querySelectorAll('[data-sidebar-right-session]')) {
        const id = node.getAttribute('data-sidebar-right-session')
        if (typeof id === 'string' && id !== '') values.add(id)
      }
      if (values.size === 1) { const [only] = values; return only }
      return null
    }

    function ctxFocus(tabId) {
      try { serviceContext?.get('sidebarRight')?.focus?.(tabId) } catch { /* optional */ }
    }

    function ctxClose(tabId) {
      try { serviceContext?.get('sidebarRight')?.close?.(tabId) } catch { /* optional */ }
    }

    /* ------------------------------------------------------------ plugin API */

    return {
      inject: ['slots', 'sidebarRightTabs', 'sessions', 'conversation'],

      apply(ctx) {
        serviceContext = ctx

        const desktop = typeof window !== 'undefined' ? window.dshDesktop : undefined
        const bridgeable = desktop !== undefined && desktop.protocolVersion === 1 && desktop.browser !== undefined

        const style = document.createElement('style')
        style.dataset.plugin = PLUGIN_ID
        style.textContent = styles
        document.head.appendChild(style)
        ctx.effect(() => () => { style.remove() }, 'shared-browser styles')

        if (!bridgeable) {
          // The Web carrier renders the browser as an iframe the app manages; a
          // guest-driven takeover would break it, so the built-in stays in place.
          console.info('[dsh-shared-browser] 没有桌面浏览器桥，保留内置浏览器。')
          return
        }

        ctx.inject(['sessions'], (sessionCtx) => {
          try {
            const list = sessionCtx.sessions.list.getSnapshot()
            const first = Object.values(list.byId ?? {})[0]
            bridge.sessionId = first?.id ?? null
          } catch { /* the bridge still works without a pre-known session */ }
        })

        bridge.start()
        ctx.effect(() => () => { bridge.source?.close?.() }, 'shared-browser stream')

        // Read-only diagnostics for support and for the browser tools' own tests.
        if (typeof window !== 'undefined' && window.__dshBrowserDebug === undefined) {
          window.__dshBrowserDebug = {
            version: VERSION,
            session: () => bridge.sessionId,
            probe: (sessionId) => {
              const id = sessionId ?? bridge.sessionId ?? null
              const step = (fn) => { try { return fn() } catch (error) { return `ERR ${String(error && error.message ? error.message : error)}` } }
              const sessions = step(() => serviceContext?.get?.('sessions'))
              return {
                id,
                sessions: step(() => typeof sessions?.scope),
                strictGet: step(() => String(typeof serviceContext?.get?.('conversation'))),
                proxy: step(() => String(typeof serviceContext?.conversation)),
                scopeId: step(() => sessions?.scope?.(id) === undefined ? 'undefined' : 'ctx'),
                input: step(() => String(typeof serviceContext?.conversation?.input?.for)),
                tabs: [...instances.keys()],
              }
            },
          }
        }

        ctx.inject(['sidebarRightTabs', 'slots'], (uiCtx) => {
          uiCtx.effect(() => uiCtx.sidebarRightTabs.register({
            id: PLUGIN_ID,
            kind: 'browser',
            multiple: true,
            keepMounted: true,
            priority: 'extension',
            title: () => t('browser.label'),
            // The type in force owns the guide page too: without an entry here the
            // Browser capsule would vanish from the sidebar's start page.
            guide: [{
              id: 'new',
              commandId: 'browser.new',
              order: 30,
              title: () => t('browser.label'),
              description: () => t('browser.guide'),
            }],
          }), 'shared-browser tab type')

          uiCtx.slots.inject('sidebar.right.pane.tab', () => uiCtx.slots.register({
            name: 'sidebar.right.pane.tab',
            key: PLUGIN_ID,
          }, BrowserBody))

          uiCtx.slots.inject('sidebar.right.pane.tab.title', () => uiCtx.slots.register({
            name: 'sidebar.right.pane.tab.title',
            key: PLUGIN_ID,
          }, (props) => {
            const info = typeof props.useTabInfo === 'function' ? props.useTabInfo() : null
            const instance = info?.tab?.id ? instances.get(info.tab.id) : null
            /* `guest` is a live accessor, so the title follows page navigations. */
            const live = instance?.guest?.title
            return live || info?.tab?.title || t('browser.label')
          }))
        })

        // The Host keeps every tab listed even while the user never calls a tool.
        ctx.effect(() => {
          const timer = setInterval(scheduleReport, 5000)
          return () => clearInterval(timer)
        }, 'shared-browser heartbeat')
      },
    }
  },
})
