// poston 답장 페이지 (폰용) — 담임(나)은 오른쪽 노란 말풍선, 교실은 왼쪽 흰 말풍선
(() => {
  const KEY_NAME = 'poston-admin-key';
  const POLL_MS = 4000;
  const ME = 'home';
  const THEM_NAME = '교실';

  const $ = (id) => document.getElementById(id);
  const coarse = matchMedia('(pointer: coarse)').matches;

  const state = {
    key: readKey(),
    lastId: '',
    epoch: null,
    ids: new Set(),
    lastDay: '',
    lastFrom: '',
    classSeen: 0,
    timer: 0,
    sending: false,
    images: new Map(),
    memo: null,
    memoDraft: null,
    memoDirty: false,
    pastSeq: 0,
    toastTimer: 0,
  };

  function readKey() {
    try { return localStorage.getItem(KEY_NAME) || ''; } catch { return ''; }
  }
  function writeKey(v) {
    try { v ? localStorage.setItem(KEY_NAME, v) : localStorage.removeItem(KEY_NAME); } catch {}
  }

  async function api(method, { query, body, key } = {}) {
    const qs = query ? '?' + new URLSearchParams(query) : '';
    const headers = { 'x-poston-key': key ?? state.key };
    if (body) headers['content-type'] = 'application/json';
    try {
      const res = await fetch('/api/chat' + qs, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        cache: 'no-store',
      });
      let data = null;
      try { data = await res.json(); } catch {}
      return { ok: res.ok, status: res.status, data };
    } catch {
      return { ok: false, status: 0, data: null };
    }
  }

  /* 비밀번호 */
  function showLock(msg = '') {
    clearTimeout(state.timer);
    $('room').hidden = true;
    $('lock').hidden = false;
    $('lockMsg').textContent = msg;
    $('lockKey').value = '';
    $('lockKey').focus();
  }

  $('lockForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const key = $('lockKey').value.trim();
    if (!key) return;
    $('lockMsg').textContent = '';
    const r = await api('GET', { key, query: { since: 'm/9' } });
    if (r.ok && r.data?.role === 'home') {
      state.key = key;
      writeKey(key);
      enterRoom();
    } else if (r.ok && r.data?.role === 'class') {
      $('lockMsg').textContent = '교실 프로그램용 열쇠입니다. 직접 정한 비밀번호를 넣어 주세요.';
    } else if (r.status === 401) {
      $('lockMsg').textContent = '비밀번호가 맞지 않습니다.';
    } else {
      $('lockMsg').textContent = '서버에 연결되지 않습니다. 잠시 뒤 다시 해 주세요.';
    }
  });

  /* 탭 */
  const TABS = { chat: ['tabChat', 'chatPane'], past: ['tabPast', 'pastPane'], memo: ['tabMemo', 'memoPane'] };
  function selectTab(name) {
    for (const [key, [tab, pane]] of Object.entries(TABS)) {
      $(tab).setAttribute('aria-selected', String(key === name));
      $(pane).hidden = key !== name;
    }
    $('clear').hidden = name !== 'chat';
    if (name === 'chat') $('log').scrollTop = $('log').scrollHeight;
    if (name === 'past') showDays();
  }
  for (const [key, [tab]] of Object.entries(TABS)) $(tab).addEventListener('click', () => selectTab(key));

  /* 대화방 */
  function enterRoom() {
    $('lock').hidden = true;
    $('room').hidden = false;
    selectTab('chat');
    resetLog();
    poll();
  }

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function resetLog() {
    state.lastId = '';
    state.lastDay = '';
    state.lastFrom = '';
    state.ids.clear();
    $('log').replaceChildren();
    renderEmpty();
  }

  function renderEmpty() {
    const log = $('log');
    const empty = log.querySelector('.empty');
    if (state.ids.size === 0 && !empty) {
      log.append(el('li', 'empty', '아직 주고받은 메시지가 없습니다.'));
    } else if (state.ids.size > 0 && empty) {
      empty.remove();
    }
  }

  const dayKey = (iso) => new Date(iso).toDateString();
  const dayLabel = (iso) => new Date(iso).toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' });
  const timeLabel = (iso) => new Date(iso).toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' });

  function loadImage(id) {
    if (!state.images.has(id)) {
      const p = fetch('/api/chat?img=' + encodeURIComponent(id), { headers: { 'x-poston-key': state.key } })
        .then((res) => (res.ok ? res.blob() : null))
        .then((blob) => (blob ? URL.createObjectURL(blob) : null))
        .catch(() => null)
        .then((src) => {
          if (!src) state.images.delete(id);
          return src;
        });
      state.images.set(id, p);
    }
    return state.images.get(id);
  }

  function photoButton(id) {
    const btn = el('button', 'photo');
    btn.type = 'button';
    btn.setAttribute('aria-label', '캡처 크게 보기');
    const holder = el('span', 'loading', '사진 불러오는 중');
    btn.append(holder);
    loadImage(id).then((src) => {
      if (!src) { holder.textContent = '사진을 불러오지 못했습니다'; return; }
      const img = el('img');
      img.alt = '교실에서 보낸 캡처';
      img.src = src;
      holder.replaceWith(img);
    });
    btn.addEventListener('click', async () => {
      const src = await loadImage(id);
      if (src) openViewer(src);
    });
    return btn;
  }

  function messageItem(m, showName) {
    const mine = m.from === ME;
    const li = el('li', `msg ${mine ? 'mine' : 'theirs'}`);
    if (!mine && showName) li.append(el('div', 'name', THEM_NAME));
    const row = el('div', 'row');
    const bubble = el('div', 'bubble');
    if (m.image) bubble.append(photoButton(m.id));
    if (m.text) bubble.append(document.createTextNode(m.text));
    if (m.image && !m.text) bubble.style.padding = '5px';
    const time = el('time', '', timeLabel(m.at));
    time.dateTime = m.at;
    row.append(bubble, time);
    li.append(row);
    return li;
  }

  function appendMessage(m) {
    const log = $('log');
    const day = dayKey(m.at);
    if (day !== state.lastDay) {
      log.append(el('li', 'day', dayLabel(m.at)));
      state.lastDay = day;
      state.lastFrom = '';
    }
    log.append(messageItem(m, state.lastFrom !== m.from));
    state.lastFrom = m.from;
  }

  function addMessages(list) {
    const log = $('log');
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    let added = 0;
    for (const m of list) {
      if (state.ids.has(m.id)) continue;
      state.ids.add(m.id);
      appendMessage(m);
      if (m.id > state.lastId) state.lastId = m.id;
      added++;
    }
    renderEmpty();
    if (added && (nearBottom || added === state.ids.size)) log.scrollTop = log.scrollHeight;
    return added;
  }

  function renderSeen() {
    const box = $('seen');
    const text = $('seenText');
    const t = state.classSeen;
    box.classList.remove('is-on');
    if (!t) { text.textContent = '교실 컴퓨터 기록 없음'; return; }
    const min = Math.floor((Date.now() - t) / 60000);
    if (min < 3) { text.textContent = '교실 컴퓨터 켜짐'; box.classList.add('is-on'); return; }
    if (min < 60) text.textContent = `교실 컴퓨터 ${min}분 전 접속`;
    else if (min < 60 * 24) text.textContent = `교실 컴퓨터 ${Math.floor(min / 60)}시간 전 접속`;
    else text.textContent = `교실 컴퓨터 ${Math.floor(min / 1440)}일 전 접속`;
  }

  function showErr(msg) {
    $('err').textContent = msg;
    $('err').hidden = !msg;
  }

  function toast(msg) {
    clearTimeout(state.toastTimer);
    $('toast').textContent = msg;
    $('toast').hidden = false;
    state.toastTimer = setTimeout(() => { $('toast').hidden = true; }, 5000);
  }

  /* 지난 기록 — 날짜를 고르면 그날 대화를 연다 */
  const dateLabel = (date) => dayLabel(date + 'T12:00:00+09:00');

  async function showDays() {
    const seq = ++state.pastSeq;
    $('pastDay').hidden = true;
    $('pastDays').hidden = false;
    const list = $('dayList');
    list.replaceChildren(el('li', 'note', '불러오는 중'));
    const r = await api('GET', { query: { days: 1 } });
    if (seq !== state.pastSeq) return;
    if (!r.ok) { list.replaceChildren(el('li', 'note', '기록을 불러오지 못했습니다.')); return; }
    const days = r.data.days || [];
    if (!days.length) { list.replaceChildren(el('li', 'note', '남아 있는 기록이 없습니다.')); return; }
    list.replaceChildren(...days.map(({ date, count }) => {
      const btn = el('button');
      btn.type = 'button';
      btn.append(el('span', '', dateLabel(date)), el('span', 'count', `${count}개`));
      btn.addEventListener('click', () => showDay(date));
      const li = el('li');
      li.append(btn);
      return li;
    }));
  }

  async function showDay(date) {
    const seq = ++state.pastSeq;
    $('pastDays').hidden = true;
    $('pastDay').hidden = false;
    $('pastTitle').textContent = dateLabel(date);
    const log = $('pastLog');
    log.replaceChildren(el('li', 'empty', '불러오는 중'));
    const r = await api('GET', { query: { day: date } });
    if (seq !== state.pastSeq) return;
    if (!r.ok) { log.replaceChildren(el('li', 'empty', '기록을 불러오지 못했습니다.')); return; }
    let lastFrom = '';
    const items = (r.data.messages || []).map((m) => {
      const li = messageItem(m, lastFrom !== m.from);
      lastFrom = m.from;
      return li;
    });
    log.replaceChildren(...(items.length ? items : [el('li', 'empty', '이날 남은 기록이 없습니다.')]));
    log.scrollTop = 0;
  }
  $('pastBack').addEventListener('click', showDays);

  /* 사진 크게 보기 */
  function openViewer(src) {
    $('viewerImg').src = src;
    $('viewer').hidden = false;
  }
  $('viewerClose').addEventListener('click', () => {
    $('viewer').hidden = true;
    $('viewerImg').removeAttribute('src');
  });

  /* 서버 확인 */
  async function poll() {
    clearTimeout(state.timer);
    if (document.hidden || !state.key) return;
    const query = { since: state.lastId };
    if (state.epoch) query.epoch = state.epoch;
    const r = await api('GET', { query });
    if (r.status === 401) { writeKey(''); state.key = ''; showLock('비밀번호가 바뀌었습니다. 다시 넣어 주세요.'); return; }
    if (r.ok) {
      if (r.data.reset) resetLog();
      state.epoch = r.data.epoch;
      state.classSeen = r.data.classSeen || 0;
      addMessages(r.data.messages || []);
      renderSeen();
      takeMemo(r.data.memo);
      if (!state.sending) showErr('');
    } else {
      showErr('연결이 끊겼습니다. 다시 연결하는 중입니다.');
    }
    state.timer = setTimeout(poll, POLL_MS);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) clearTimeout(state.timer);
    else if (state.key && !$('room').hidden) poll();
  });

  /* 보내기 */
  const textEl = $('text');

  function grow() {
    textEl.style.height = 'auto';
    textEl.style.height = textEl.scrollHeight + 'px';
  }
  textEl.addEventListener('input', grow);

  textEl.addEventListener('keydown', (e) => {
    if (coarse) return;
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      $('compose').requestSubmit();
    }
  });

  $('compose').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = textEl.value.trim();
    if (!text || state.sending) return;
    state.sending = true;
    $('send').disabled = true;
    const r = await api('POST', { body: { text } });
    state.sending = false;
    $('send').disabled = false;
    if (r.ok) {
      textEl.value = '';
      grow();
      showErr('');
      addMessages([r.data.message]);
      $('log').scrollTop = $('log').scrollHeight;
      poll();
    } else if (r.status === 413) {
      showErr('글이 너무 깁니다. 2천 자 안으로 나누어 보내 주세요.');
    } else {
      showErr('보내지 못했습니다. 다시 눌러 주세요.');
    }
  });

  /* 바탕화면 메모 — 고치는 중에는 서버 값으로 덮어쓰지 않는다 */
  function renderMemoForm() {
    const d = state.memoDraft;
    if (!d) return;
    if ($('memoText').value !== d.text) $('memoText').value = d.text;
    $('memoSize').value = d.size;
    $('memoSizeVal').textContent = d.size;
    $('memoVisible').checked = d.visible;
    for (const btn of document.querySelectorAll('[data-align]')) {
      btn.setAttribute('aria-pressed', String(btn.dataset.align === d.align));
    }
  }

  function memoStatus(text, isErr = false) {
    $('memoStatus').textContent = text;
    $('memoStatus').classList.toggle('is-err', isErr);
  }

  function savedLabel(memo) {
    if (!memo.updatedAt) return '아직 반영한 메모가 없습니다.';
    const d = new Date(memo.updatedAt);
    const today = d.toDateString() === new Date().toDateString();
    const when = today ? timeLabel(d.toISOString()) : `${dayLabel(d.toISOString())} ${timeLabel(d.toISOString())}`;
    return `마지막 반영 ${when}`;
  }

  function takeMemo(memo) {
    if (!memo) return;
    const changed = !state.memo || state.memo.updatedAt !== memo.updatedAt;
    state.memo = memo;
    if (!state.memoDirty && changed) {
      state.memoDraft = { text: memo.text, align: memo.align, size: memo.size, visible: memo.visible };
      renderMemoForm();
      memoStatus(savedLabel(memo));
    }
  }

  function touchMemo() {
    state.memoDirty = true;
    memoStatus('아직 반영하지 않은 고친 내용이 있습니다.');
  }

  $('memoText').addEventListener('input', () => {
    state.memoDraft.text = $('memoText').value;
    touchMemo();
  });
  $('memoSize').addEventListener('input', () => {
    state.memoDraft.size = Number($('memoSize').value);
    renderMemoForm();
    touchMemo();
  });
  $('memoVisible').addEventListener('change', () => {
    state.memoDraft.visible = $('memoVisible').checked;
    touchMemo();
  });
  for (const btn of document.querySelectorAll('[data-align]')) {
    btn.addEventListener('click', () => {
      state.memoDraft.align = btn.dataset.align;
      renderMemoForm();
      touchMemo();
    });
  }

  $('memoForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!state.memoDraft) return;
    $('memoSave').disabled = true;
    const r = await api('POST', { body: { memo: state.memoDraft } });
    $('memoSave').disabled = false;
    if (r.ok) {
      state.memoDirty = false;
      state.memo = r.data.memo;
      state.memoDraft = { text: r.data.memo.text, align: r.data.memo.align, size: r.data.memo.size, visible: r.data.memo.visible };
      renderMemoForm();
      memoStatus('반영했습니다. 교실 컴퓨터가 켜져 있으면 15초 안에 바뀝니다.');
    } else if (r.status === 413) {
      memoStatus('메모가 너무 깁니다. 2천 자 안으로 줄여 주세요.', true);
    } else {
      memoStatus('반영하지 못했습니다. 다시 눌러 주세요.', true);
    }
  });

  /* 지우기 — 교실 화면만 비우거나, 기록까지 모두 지운다 */
  const sheet = $('clearSheet');
  const closeSheet = () => { sheet.hidden = true; };
  $('clear').addEventListener('click', () => { sheet.hidden = false; });
  $('clearCancel').addEventListener('click', closeSheet);
  sheet.addEventListener('click', (e) => { if (e.target === sheet) closeSheet(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !sheet.hidden) closeSheet(); });

  $('clearView').addEventListener('click', async () => {
    closeSheet();
    const r = await api('POST', { body: { clear: true } });
    if (r.ok) toast('교실 화면을 비웠습니다. 기록은 지난 기록에 남아 있습니다.');
    else showErr('교실 화면을 비우지 못했습니다.');
  });

  $('clearAll').addEventListener('click', async () => {
    if (!confirm('서버에 남은 대화와 사진을 모두 지울까요? 되돌릴 수 없습니다.')) return;
    closeSheet();
    const r = await api('DELETE');
    if (r.ok) {
      state.epoch = r.data.epoch;
      resetLog();
      toast('기록을 모두 지웠습니다.');
    } else {
      showErr('지우지 못했습니다.');
    }
  });

  /* 나가기 */

  $('leave').addEventListener('click', () => {
    if (!confirm('이 폰에서 로그아웃할까요?')) return;
    writeKey('');
    state.key = '';
    showLock();
  });

  setInterval(() => { if (!$('room').hidden) renderSeen(); }, 30000);

  if (state.key) enterRoom();
  else showLock();
})();
