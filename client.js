window.__ModuleLoader__.load({
  id: 'dsh-screen-watch',
  factory: require => {
    const React = require('react');
    const { createElement: h, useEffect, useState } = React;
    const PREFIX = '/api/screen-watch';

    const column = { display: 'flex', flexDirection: 'column', gap: 12 };
    const row = { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' };
    const muted = { color: 'var(--dsw-alias-label-tertiary)', fontSize: 13, margin: 0 };
    const card = { border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 12, padding: 12, display: 'grid', gridTemplateColumns: '120px 1fr', gap: 12, alignItems: 'start' };
    const thumb = { width: 120, height: 68, objectFit: 'cover', borderRadius: 8, background: 'var(--dsw-alias-bg-base)' };
    const buttonStyle = { font: 'inherit', padding: '7px 14px', borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)', cursor: 'pointer' };

    async function request(path, init) {
      const response = await fetch(PREFIX + path, { credentials: 'same-origin', cache: 'no-store', ...init });
      const value = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
      return value;
    }

    function clock(iso) {
      if (!iso) return '';
      const d = new Date(iso);
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
    }

    function Panel() {
      const [state, setState] = useState(null);
      const [error, setError] = useState('');
      const [busy, setBusy] = useState(false);
      const [stamp, setStamp] = useState(Date.now());

      useEffect(() => {
        let alive = true;
        const load = async () => {
          try {
            const value = await request('/state');
            if (alive) { setState(value); setError(''); }
          } catch (err) {
            if (alive) setError(err.message);
          }
        };
        void load();
        const timer = setInterval(load, 3000);
        return () => { alive = false; clearInterval(timer); };
      }, []);

      const session = state?.sessions?.[0];
      const running = session?.running === true;
      const groups = state?.groups || [];

      const act = async (path) => {
        setBusy(true);
        try {
          await request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
          const value = await request('/state');
          setState(value);
          setStamp(Date.now());
          setError('');
        } catch (err) {
          setError(err.message);
        } finally {
          setBusy(false);
        }
      };

      return h('div', { style: column },
        h('div', { style: row },
          h('strong', null, running ? '正在陪你看' : '没在看'),
          h('span', { style: muted }, session
            ? `窗口 ${session.process} · 已抓 ${session.count ?? 0} 帧 · 保留 ${groups.length} 条视频`
            : '还没有开始'),
          h('span', { style: muted }, state ? `更新于 ${clock(state.at)}` : ''),
          h('div', { style: { flex: 1 } }),
          h('button', {
            type: 'button',
            style: { ...buttonStyle, opacity: busy ? 0.6 : 1 },
            disabled: busy,
            onClick: () => void act(running ? '/stop' : '/start'),
          }, busy ? '处理中…' : running ? '暂停' : '开始'),
        ),
        error ? h('p', { style: { ...muted, color: 'var(--dsw-alias-label-error, #d33)' } }, `接口报错：${error}`) : null,
        session?.lastError ? h('p', { style: muted }, `最近一次抓图出错：${session.lastError}`) : null,
        groups.length === 0
          ? h('p', { style: muted }, '还没有分组。点“开始”，然后正常刷抖音就行。')
          : h('div', { style: column }, ...groups.map((group) => h('div', { key: `${group.process}-${group.id}`, style: card },
            h('img', {
              src: `${PREFIX}/thumb?group=${encodeURIComponent(group.id)}&process=${encodeURIComponent(group.process)}&t=${stamp}`,
              style: thumb,
              alt: group.id,
            }),
            h('div', { style: column },
              h('div', { style: row },
                h('strong', null, group.id),
                h('span', { style: muted }, `${group.frames} 帧`),
                h('span', { style: muted }, `${clock(group.from)} – ${clock(group.to)}`),
              ),
              h('p', { style: { ...muted, overflowWrap: 'anywhere' } }, group.title || '（没读到标题）'),
            ),
          ))),
        h('p', { style: muted }, '面板只显示状态和缩略图；想看某条的拼版图和转写，在对话里说一声，它会把整条铺开给你看。'),
      );
    }

    function apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'screen-watch',
        order: 30,
        label: () => '陪刷抖音',
      }, Panel));
    }

    return { name: 'screen-watch-settings', inject: ['slots'], apply, Panel };
  },
});
