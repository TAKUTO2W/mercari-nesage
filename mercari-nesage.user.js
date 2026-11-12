// ==UserScript==
// @name         メルカリ一括値下げ
// @namespace    usdm.mercari.nesage
// @version      0.6.0
// @description  出品中の商品を、決めた率・金額で1品ずつ順番に値下げする
// @match        https://jp.mercari.com/*
// @updateURL    https://raw.githubusercontent.com/TAKUTO2W/mercari-nesage/main/mercari-nesage.user.js
// @downloadURL  https://raw.githubusercontent.com/TAKUTO2W/mercari-nesage/main/mercari-nesage.user.js
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ---------- 保存まわり ----------
  const DEFAULTS = {
    mode: 'percent',   // percent | yen
    percent: 3,
    yen: 100,
    unit: 10,          // 端数をそろえる単位（切り捨て）
    floor: 300,        // これより下げない
    dailyMax: 500,     // 1日の上限件数
  };
  const S = {
    get: (k, d) => { const v = GM_getValue(k); return v === undefined ? d : v; },
    set: (k, v) => GM_setValue(k, v),
  };
  const WAIT_SEC = 15; // 1品ごとの間隔（秒）。固定
  const settings = () => Object.assign({}, DEFAULTS, S.get('settings', {}));
  if (!S.get('migrated060', false)) {
    const sv = S.get('settings', {});
    if (sv.dailyMax === 50) { sv.dailyMax = 500; S.set('settings', sv); }
    S.set('migrated060', true);
  }
  const today = () => new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD
  const mmdd = (d = new Date()) => `${d.getMonth() + 1}/${d.getDate()}`;
  const doneToday = () => (S.get('dayCount', {})[today()] || 0);
  const addDoneToday = () => { const m = S.get('dayCount', {}); m[today()] = (m[today()] || 0) + 1; S.set('dayCount', m); };
  const log = (msg) => {
    const l = S.get('log', []);
    l.push(`${new Date().toLocaleString('ja-JP')} ${msg}`);
    S.set('log', l.slice(-500));
    console.log('[一括値下げ]', msg);
    renderLog();
  };

  // ---------- 値段の計算 ----------
  function newPrice(p, st) {
    let n = st.mode === 'percent' ? p * (1 - st.percent / 100) : p - st.yen;
    const unit = Math.max(1, Number(st.unit) || 1);
    n = Math.floor(n / unit) * unit;
    n = Math.max(n, Number(st.floor) || 300, 300);
    return n < p ? n : null; // 下がらないなら null（飛ばす）
  }

  // ---------- 小道具 ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitFor(fn, timeout = 20000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { const v = fn(); if (v) return v; await sleep(300); }
    return null;
  }
  const yenToNum = (s) => Number(String(s).replace(/[^0-9]/g, '')) || 0;
  function setReactValue(input, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, String(value));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // ---------- 出品一覧の読み取り ----------
  // 出品中の一覧（/mypage/listings）から 商品ID・名前・値段 を集める
  function readListingRows() {
    const rows = [];
    const seen = new Set();
    document.querySelectorAll('a[href*="/item/m"]').forEach((a) => {
      const m = a.getAttribute('href').match(/\/item\/(m\d+)/);
      if (!m || seen.has(m[1])) return;
      seen.add(m[1]);
      const text = a.innerText || '';
      const priceMatch = text.match(/[¥￥]\s*([\d,]+)/);
      const price = priceMatch ? yenToNum(priceMatch[1]) : 0;
      const name = (text.split('\n').map((t) => t.trim()).find((t) => t && !/[¥￥]/.test(t)) || '');
      const box = a.parentElement?.parentElement?.innerText || '';
      const paused = /公開停止中/.test(box);
      rows.push({ id: m[1], name: name.slice(0, 60), price, paused });
    });
    return rows;
  }

  async function loadAllListings(status) {
    // 「もっと見る」を押せるだけ押す／一番下までスクロールする
    for (let i = 0; i < 200; i++) {
      const before = readListingRows().length;
      const more = [...document.querySelectorAll('button')].find((b) => /もっと見る/.test(b.innerText));
      if (more) more.click(); else window.scrollTo(0, document.body.scrollHeight);
      await sleep(1500);
      const after = readListingRows().length;
      status(`読み込み中… ${after}件`);
      if (after === before && !more) break;
    }
    return readListingRows();
  }

  // 「画像は自分で撮影・作成しました」の確認欄があればチェックを入れる。入れたら true
  async function checkPhotoConfirm() {
    const label = [...document.querySelectorAll('label, span, p, div')]
      .find((el) => el.children.length <= 3 && /画像は自分で撮影・作成しました/.test(el.textContent || '') && (el.textContent || '').length < 60);
    if (!label) return false;
    let box = label.querySelector('input[type="checkbox"]');
    // 近く（4段上まで）にあるチェック欄だけを見る。別の欄を押さないため
    let el = label;
    for (let i = 0; !box && el && i < 4; i++, el = el.parentElement) {
      const boxes = el.querySelectorAll('input[type="checkbox"]');
      if (boxes.length === 1) box = boxes[0];
      if (boxes.length > 1) break;
    }
    if (!box || box.checked) return false;
    box.click();
    await sleep(500);
    if (!box.checked) label.click();
    await sleep(300);
    log('「画像は自分で撮影・作成しました」にチェックを入れました');
    return box.checked;
  }

  function allowLeave() {
    window.addEventListener('beforeunload', (e) => { e.stopImmediatePropagation(); }, true);
    try { window.onbeforeunload = null; } catch (_) { /* 何もしない */ }
  }

  // ---------- 編集画面での値下げ ----------
  // 値下げが済んだときの記録：ログ・履歴・確認一覧の値段と日付を新しくする
  function markDone(cur, from, to) {
    addDoneToday();
    log(`✅ 完了 ${cur.name}　${from.toLocaleString()}円 → ${to.toLocaleString()}円`);
    S.set('history', [...S.get('history', []), { id: cur.id, from, to, at: new Date().toISOString() }].slice(-5000));
    const pv = S.get('preview', []);
    const row = pv.find((r) => r.id === cur.id);
    if (row) { row.price = to; row.lastDown = mmdd(); row.checked = false; S.set('preview', pv); }
  }

  // 保存の途中でページが読み直された場合の後始末（同じ商品を二重に下げないため）
  function finishPendingIfDone(q, priceNow) {
    const pd = q.pending;
    if (!pd) return false;
    const cur = q.items[q.pos];
    const onItem = location.pathname === `/item/${pd.id}`;
    if (cur && cur.id === pd.id && (onItem || priceNow === pd.to)) {
      delete q.pending;
      S.set('queue', q);
      markDone(cur, pd.from, pd.to);
      next(q, true);
      return true;
    }
    return false;
  }

  async function runOnEditPage() {
    const q = S.get('queue', null);
    if (!q || !q.running) return;
    const cur = q.items[q.pos];
    if (!cur || !location.pathname.includes(`/sell/edit/${cur.id}`)) return;
    const head = `（${q.pos + 1}/${q.items.length}）${cur.name}`;

    const st = settings();
    const input = await waitFor(() => document.querySelector('input[data-testid="price-text-input"], input[name="price"]'));
    if (!input) { log(`❌ ${head} 値段の入力欄が見つからないので止めました`); return stop(); }
    await sleep(1000);
    const actual = yenToNum(input.value);
    if (finishPendingIfDone(q, actual)) return;
    if (document.querySelector('[data-testid="auction-price-option"]')?.checked) { log(`⏭ ${head} オークション形式なので飛ばし`); return next(q, false); }
    const target = newPrice(actual, st);
    if (!target) { log(`⏭ ${head} ${actual.toLocaleString()}円 → 下限のため飛ばし`); return next(q, false); }
    if (q.dry) { log(`[試し] ${head}　${actual.toLocaleString()}円 → ${target.toLocaleString()}円（保存はしていません）`); return next(q, false); }
    log(`▶ 値下げ中 ${head}　今 ${actual.toLocaleString()}円 → ${target.toLocaleString()}円`);
    setReactValue(input, target);
    await sleep(800 + Math.random() * 800);

    const btn = document.querySelector('button[data-testid="edit-button"]')
      || [...document.querySelectorAll('button')].find((b) => /^(変更する|更新する)$/.test(b.innerText.trim()));
    if (!btn) { log(`❌ ${head} 「変更する」ボタンが見つからないので止めました`); return stop(); }
    await checkPhotoConfirm();
    q.pending = { id: cur.id, from: actual, to: target };
    S.set('queue', q);
    btn.click();
    const left = () => !location.pathname.includes('/sell/edit/');
    let ok = await waitFor(left, 8000);
    if (!ok && await checkPhotoConfirm()) { // 押した後に確認欄が出た場合はチェックしてもう一度
      await sleep(800);
      btn.click();
      ok = await waitFor(left, 10000);
    }
    if (!ok) ok = await waitFor(left, 4000);
    if (!ok) {
      // 赤字の注意（例: ストレージ容量を選択してください）が出て保存できない → 値段を戻して飛ばす
      const why = [...document.querySelectorAll('p, span, div')]
        .filter((el) => el.children.length === 0 && (el.textContent || '').trim() !== '選択してください'
          && /(選択|入力)してください/.test(el.textContent || '') && (el.textContent || '').length < 40)
        .map((el) => el.textContent.trim());
      delete q.pending; S.set('queue', q);
      setReactValue(input, actual);
      allowLeave();
      log(`⏭ 飛ばし ${head}　保存できませんでした${why.length ? '（' + [...new Set(why)].slice(0, 3).join('／') + '）' : ''}。値段は${actual.toLocaleString()}円のまま　https://jp.mercari.com/sell/edit/${cur.id}`);
      const sk = S.get('skipped', []); sk.push({ id: cur.id, name: cur.name, why, at: new Date().toISOString() }); S.set('skipped', sk.slice(-1000));
      return next(q, false);
    }
    delete q.pending;
    S.set('queue', q);
    markDone(cur, actual, target);
    return next(q, true);
  }

  async function next(q, saved) {
    if (q.dry || saved) q.ok = (q.ok || 0) + 1; else q.skip = (q.skip || 0) + 1;
    q.pos += 1;
    S.set('queue', q);
    const st = settings();
    if (q.pos >= q.items.length) {
      q.result = `完了！ 全${q.items.length}件中 ${q.ok || 0}件 ${q.dry ? '計算OK（試し）' : '値下げ成功'}・${q.skip || 0}件 飛ばし`;
      S.set('queue', q);
      log(`🏁 ${q.result}`);
      return stop();
    }
    if (!q.dry && doneToday() >= st.dailyMax) { log(`今日の上限 ${st.dailyMax}件 に達したので一時停止。明日「続きから」を押してください`); q.running = false; S.set('queue', q); return; }
    const wait = q.dry ? 3 : WAIT_SEC;
    log(`⏳ ${Math.round(wait)}秒待って次へ（${q.pos + 1}/${q.items.length}）${q.items[q.pos].name}`);
    q.nextAt = Date.now() + wait * 1000;
    S.set('queue', q);
    goNextWhenReady();
  }

  // 実行中なら、待ち時間が来たら次の商品の編集画面へ（ページが読み直されても続く）
  let goingNext = false;
  async function goNextWhenReady() {
    if (goingNext) return;
    goingNext = true;
    try {
      for (;;) {
        const q = S.get('queue', null);
        if (!q || !q.running) return;
        if (q.pending && finishPendingIfDone(q, null)) return;
        const cur = q.items[q.pos];
        if (!cur || location.pathname.includes(`/sell/edit/${cur.id}`)) return;
        if (Date.now() >= (q.nextAt || 0)) { location.href = `https://jp.mercari.com/sell/edit/${cur.id}`; return; }
        await sleep(1000);
      }
    } finally { goingNext = false; }
  }

  function stop() {
    const q = S.get('queue', null);
    if (q) { q.running = false; S.set('queue', q); }
    renderPanel();
  }

  function start(dry, resume) {
    let q = S.get('queue', null);
    if (!resume) {
      const items = S.get('preview', []).filter((r) => r.checked);
      if (!items.length) return alert('値下げする商品が選ばれていません');
      q = { items, pos: 0, dry, running: true, ok: 0, skip: 0 };
    } else {
      if (!q) return alert('続きがありません');
      q.running = true;
    }
    S.set('queue', q);
    location.href = `https://jp.mercari.com/sell/edit/${q.items[q.pos].id}`;
  }

  // ---------- 画面のパネル ----------
  let panel;
  function renderLog() {
    const el = panel?.querySelector('#mn-log');
    if (el) { el.textContent = S.get('log', []).slice(-30).join('\n'); el.scrollTop = el.scrollHeight; }
  }
  function renderPanel() {
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'mn-panel';
      panel.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:99999;width:min(560px,calc(100vw - 24px));max-height:90vh;overflow:auto;background:#fff;border:2px solid #e60012;border-radius:8px;padding:10px;font:13px/1.5 sans-serif;color:#222;box-shadow:0 4px 16px rgba(0,0,0,.2)';
      document.body.appendChild(panel);
    }
    const st = settings();
    const q = S.get('queue', null);
    const preview = S.get('preview', []);
    const onList = location.pathname.startsWith('/mypage/listings');
    const running = q && q.running;
    panel.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center">
        <b>一括値下げ</b><button id="mn-min" style="border:0;background:none;cursor:pointer">－</button>
      </div>
      <div id="mn-body">
        <div>今日の値下げ: ${doneToday()} / ${st.dailyMax}件</div>
        ${q && q.result && !running ? `<div style="margin:6px 0;padding:10px;background:#e8f7ee;border:2px solid #0a7d2c;border-radius:6px;color:#0a7d2c;font-size:16px;font-weight:bold;text-align:center">🎉 ${q.result}</div>` : ''}
        ${q ? `<div>進み具合: ${q.pos}/${q.items.length}件（成功 ${q.ok || 0}・飛ばし ${q.skip || 0}） ${q.dry ? '（試し）' : ''} ${running ? '<b style="color:#e60012">実行中</b>' : '停止中'}</div>` : ''}
        ${running ? '<button id="mn-stop" style="width:100%;margin:6px 0;padding:6px;background:#333;color:#fff;border:0;border-radius:4px">止める</button>' : ''}
        ${!running ? `
        <fieldset style="margin:6px 0;border:1px solid #ddd;padding:6px">
          <label><input type="radio" name="mn-mode" value="percent" ${st.mode === 'percent' ? 'checked' : ''}> 率</label>
          ${[3, 5, 7, 10].map((p) => `<button class="mn-p" data-p="${p}" style="margin:0 2px;${st.mode === 'percent' && st.percent === p ? 'background:#e60012;color:#fff' : ''}">${p}%</button>`).join('')}
          <input id="mn-percent" type="number" value="${st.percent}" style="width:48px">%<br>
          <label><input type="radio" name="mn-mode" value="yen" ${st.mode === 'yen' ? 'checked' : ''}> 金額</label>
          <input id="mn-yen" type="number" value="${st.yen}" style="width:70px">円 下げる<br>
          端数 <input id="mn-unit" type="number" value="${st.unit}" style="width:50px">円単位で切り捨て<br>
          下限 <input id="mn-floor" type="number" value="${st.floor}" style="width:70px">円（これより下げない）<br>
          1日の上限 <input id="mn-daily" type="number" value="${st.dailyMax}" style="width:50px">件（間隔は${WAIT_SEC}秒）
        </fieldset>
        ${onList ? '<button id="mn-load" style="width:100%;padding:6px">① 出品中の商品を読み込む</button>' : '<div><a href="/mypage/listings">出品した商品の画面</a>で読み込みます</div>'}
        <div id="mn-status" style="color:#666"></div>
        ${preview.length ? `
          <div style="margin-top:6px">② 確認（${preview.filter((r) => r.checked).length}/${preview.length}件 選択）
            <span style="float:right"><button id="mn-all-on">全部選ぶ</button> <button id="mn-all-off">全部外す</button></span></div>
          <div style="max-height:45vh;overflow:auto;border:1px solid #eee">
            ${preview.map((r, i) => {
              const n = newPrice(r.price, st);
              return `<label style="display:block;border-bottom:1px solid #f3f3f3;${n ? '' : 'color:#aaa'}">
                <input type="checkbox" class="mn-row" data-i="${i}" ${r.checked ? 'checked' : ''} ${n ? '' : 'disabled'}>
                ${r.price.toLocaleString()}円 → <b>${n ? n.toLocaleString() + '円' : '下げない'}</b> ${r.lastDown ? `<span style="color:#0a7d2c">[${r.lastDown} 値下げ済]</span> ` : ''}${escapeHtml(r.name)}</label>`;
            }).join('')}
          </div>
          <button id="mn-dry" style="width:49%;margin-top:6px;padding:6px">③ 試し（保存しない）</button>
          <button id="mn-run" style="width:49%;margin-top:6px;padding:6px;background:#e60012;color:#fff;border:0;border-radius:4px">③ 値下げ開始</button>` : ''}
        ${q && !running && q.pos < q.items.length ? '<button id="mn-resume" style="width:100%;margin-top:6px;padding:6px">続きから</button>' : ''}
        ` : ''}
        <pre id="mn-log" style="margin-top:6px;max-height:140px;overflow:auto;background:#f7f7f7;padding:4px;white-space:pre-wrap;font-size:11px"></pre>
      </div>`;
    renderLog();
    bind();
  }
  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  function saveSettingsFromPanel() {
    const v = (id) => Number(panel.querySelector(id)?.value);
    const mode = panel.querySelector('input[name="mn-mode"]:checked')?.value || 'percent';
    S.set('settings', {
      mode, percent: v('#mn-percent'), yen: v('#mn-yen'), unit: v('#mn-unit'), floor: v('#mn-floor'),
      dailyMax: v('#mn-daily'),
    });
  }

  function bind() {
    const $ = (s) => panel.querySelector(s);
    $('#mn-min').onclick = () => { const b = $('#mn-body'); b.style.display = b.style.display === 'none' ? '' : 'none'; };
    $('#mn-stop') && ($('#mn-stop').onclick = () => { log('止めました'); stop(); });
    panel.querySelectorAll('fieldset input').forEach((el) => { el.onchange = () => { saveSettingsFromPanel(); renderPanel(); }; });
    panel.querySelectorAll('.mn-p').forEach((b) => {
      b.onclick = () => { saveSettingsFromPanel(); S.set('settings', { ...settings(), mode: 'percent', percent: Number(b.dataset.p) }); renderPanel(); };
    });
    $('#mn-load') && ($('#mn-load').onclick = async () => {
      const rows = await loadAllListings((t) => { $('#mn-status').textContent = t; });
      // 一覧は新しい順なので、古い順に並べ替える
      rows.reverse();
      const active = rows.filter((r) => !r.paused);
      const hist = S.get('history', []);
      const lastOf = (id) => { const h = hist.filter((x) => x.id === id).pop(); return h ? mmdd(new Date(h.at)) : ''; };
      S.set('preview', active.map((r) => ({ ...r, checked: false, lastDown: lastOf(r.id) })));
      log(`出品中 ${active.length}件を読み込みました（停止中 ${rows.length - active.length}件は出していません）`);
      renderPanel();
    });
    const setAll = (on) => {
      const st = settings();
      S.set('preview', S.get('preview', []).map((r) => ({ ...r, checked: on && !r.paused && !!newPrice(r.price, st) })));
      renderPanel();
    };
    $('#mn-all-on') && ($('#mn-all-on').onclick = () => setAll(true));
    $('#mn-all-off') && ($('#mn-all-off').onclick = () => setAll(false));
    panel.querySelectorAll('.mn-row').forEach((c) => {
      c.onchange = () => { const p = S.get('preview', []); p[c.dataset.i].checked = c.checked; S.set('preview', p); renderPanel(); };
    });
    $('#mn-dry') && ($('#mn-dry').onclick = () => start(true, false));
    // 確認は小窓（confirm）を使わず、ボタンを2回押す形にする
    $('#mn-run') && ($('#mn-run').onclick = (e) => {
      const b = e.currentTarget;
      const n = S.get('preview', []).filter((r) => r.checked).length;
      if (b.dataset.armed) return start(false, false);
      b.dataset.armed = '1';
      b.textContent = `${n}件を値下げ。もう一度押すと開始`;
      setTimeout(() => { if (b.isConnected) { delete b.dataset.armed; b.textContent = '③ 値下げ開始'; } }, 8000);
    });
    $('#mn-resume') && ($('#mn-resume').onclick = () => start(S.get('queue', {}).dry, true));
  }

  // ---------- 起動 ----------
  // 開いたときは何も選ばれていない状態から始める（実行中は除く）
  if (!S.get('queue', {})?.running) {
    S.set('preview', S.get('preview', []).filter((r) => !r.paused).map((r) => ({ ...r, checked: false })));
  }
  let lastPath = '';
  setInterval(() => {
    if (location.pathname === lastPath) return;
    lastPath = location.pathname;
    renderPanel();
    if (location.pathname.startsWith('/sell/edit/')) runOnEditPage(); else goNextWhenReady();
  }, 1000);
})();
