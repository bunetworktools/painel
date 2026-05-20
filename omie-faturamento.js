/**
 * omie-faturamento.js — Be You Dashboard · v3
 *
 * Completamente independente do dashboard:
 *  • Credenciais hardcoded (não depende de window.cfg)
 *  • Estado local próprio (não depende de window.state)
 *  • Fetch próprio para a API Omie (não chama window.syncOmie)
 *
 * Etapas Omie: 10=Orçamento, 20=Pedido, 50=Faturado, 60=Cancelado, 70=Devolvido
 */
(function () {
  'use strict';

  /* ── Credenciais e URLs ─────────────────────────────────────── */
  const OMIE_KEY    = '3386409280254';
  const OMIE_SECRET = '0df8348a9be3b2d0bc7c60476ff9c961';
  const PROXY_URL   = 'http://localhost:8765';
  const OMIE_URL    = 'https://app.omie.com.br/api/v1';

  const MESES_PT = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
  const CUR_YEAR = new Date().getFullYear();

  /* ── Estado local (independente do dashboard) ───────────────── */
  const omieData = { nfes: [], pedidos: [] };
  let omieViaProxy = null;

  /* ── Helpers DOM ─────────────────────────────────────────────── */
  function R(id)          { return document.getElementById(id); }
  function setText(id, v) { const e = R(id); if (e) e.textContent = v; }

  function fmtBRL(v) {
    return Number(v || 0).toLocaleString('pt-BR', {
      style:'currency', currency:'BRL',
      minimumFractionDigits:0, maximumFractionDigits:0
    });
  }
  function fmtPct(v)  { return ((v || 0) * 100).toFixed(1) + '%'; }
  function escHtml(s) {
    const d = document.createElement('div');
    d.appendChild(document.createTextNode(String(s || '')));
    return d.innerHTML;
  }
  function diasAtras(date) {
    if (!date) return null;
    return Math.round((Date.now() - new Date(date).getTime()) / 86400000);
  }
  function parseDate(s) {
    if (!s) return null;
    const m = String(s).match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (m) return new Date(+m[3], +m[2] - 1, +m[1]);
    const d = new Date(s);
    return isNaN(d) ? null : d;
  }

  /* ── API Omie (fetch próprio, credenciais hardcoded) ────────── */
  function withTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout')), ms);
      promise.then(v => { clearTimeout(t); resolve(v); },
                   e => { clearTimeout(t); reject(e); });
    });
  }

  async function omieCall(endpoint, call, param) {
    const body = JSON.stringify({
      call, app_key: OMIE_KEY, app_secret: OMIE_SECRET, param: [param]
    });

    /* Tenta proxy local primeiro (evita CORS) — timeout 2s */
    if (omieViaProxy !== false) {
      try {
        const res = await withTimeout(
          fetch(`${PROXY_URL}/${endpoint}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body
          }), 2000);
        if (res.ok) {
          omieViaProxy = true;
          const json = await res.json();
          if (json.faultstring) throw new Error(json.faultstring);
          return json;
        }
        throw new Error('proxy not ok');
      } catch(e) { omieViaProxy = false; }
    }

    /* Chamada direta à API Omie */
    const res = await fetch(`${OMIE_URL}/${endpoint}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json.faultstring) throw new Error(json.faultstring);
    return json;
  }

  async function omiePageAll(endpoint, call, paramBase, arrayKey) {
    let page = 1, all = [];
    while (true) {
      const res = await omieCall(endpoint, call, {
        ...paramBase, pagina: page, registros_por_pagina: 50
      });
      const arr = res[arrayKey] || [];
      all = all.concat(arr);
      const total = res.total_de_registros || res.nTotReg || arr.length;
      if (all.length >= total || arr.length === 0) break;
      page++;
    }
    return all;
  }

  async function fetchOmieData() {
    let nfErr = null, pedErr = null;

    /* NF-e — erro não impede busca de pedidos */
    try {
      setText('omie-sync-ts', 'buscando NF-e…');
      const nfRaw = await omiePageAll('produtos/nfe', 'ListarNFe', {
        filtrar_por_data_de:  `01/01/${CUR_YEAR}`,
        filtrar_por_data_ate: `31/12/${CUR_YEAR}`,
      }, 'nfCadastro');

      omieData.nfes = nfRaw.map(nf => {
        const dataStr = nf.data_emissao || nf.dEmi        || nf.ide?.dEmi        || '';
        const cliente = nf.nome_destinatario || nf.nfDestInt?.cRazao || nf.xNome || nf.dest?.xNome || '';
        const cnpj    = nf.cnpj_cpf_destinatario || nf.nfDestInt?.cnpj_cpf || nf.CNPJ || nf.dest?.CNPJ || '';
        const valor   = parseFloat(nf.valor_total_nfe || nf.vNF || nf.total?.ICMSTot?.vNF || 0);
        const nfNum   = nf.numero_nfe || nf.nNF          || nf.ide?.nNF          || '';
        const dt      = parseDate(dataStr);
        return { nfNum, data: dt, mes: dt?.getMonth() ?? -1, cliente, cnpj, valor };
      }).filter(n => n.valor > 0);
    } catch(e) {
      nfErr = e;
      console.warn('[omie-fat] NF-e:', e.message);
    }

    /* Pedidos — erro não cancela resultado das NF-es */
    try {
      setText('omie-sync-ts', 'buscando pedidos…');
      const pedRaw = await omiePageAll('produtos/pedido', 'ListarPedidos', {
        filtrar_por_data_de:  `01/01/${CUR_YEAR}`,
        filtrar_por_data_ate: `31/12/${CUR_YEAR}`,
      }, 'pedido_venda_produto');

      omieData.pedidos = pedRaw.map(p => {
        const cab = p.cabecalho    || {};
        const tot = p.total_pedido || {};
        const dt  = parseDate(cab.data_previsao || (p.infoCadastro || {}).dEmi);
        return {
          id:      cab.codigo_pedido       || '',
          data:    dt,
          mes:     dt?.getMonth()          ?? -1,
          cliente: cab.codigo_cliente_nome || '',
          etapa:   String(cab.etapa        || '10'),
          valor:   parseFloat(tot.valor_total_pedido || cab.valor_total || 0),
        };
      });
    } catch(e) {
      pedErr = e;
      console.warn('[omie-fat] Pedidos:', e.message);
    }

    /* Status final */
    if (nfErr && pedErr) {
      throw new Error('CORS — acesse pelo proxy local ou verifique a rede');
    }
  }

  /* ================================================================
     HTML DA ABA FATURAMENTO — já está no dashboard.html como HTML estático.
     Esta função é mantida apenas por compatibilidade; não faz nada.
     ================================================================ */
  function injectHTML() { /* no-op: HTML embutido diretamente no dashboard.html */ }

  /* ================================================================
     RENDERIZAÇÃO (usa omieData — não depende de window.state)
     ================================================================ */
  function render() {
    try { renderFaturamento(); }  catch(e) { console.warn('[omie-fat] renderFaturamento:', e); }
    try { renderCotacoes(); }     catch(e) { console.warn('[omie-fat] renderCotacoes:', e); }
    try { renderComparacao(); }   catch(e) { console.warn('[omie-fat] renderComparacao:', e); }
    try { renderClientesAtivos(); } catch(e) { console.warn('[omie-fat] renderClientes:', e); }

    const ts = R('omie-sync-ts');
    if (ts && omieData.nfes.length) {
      ts.textContent = `• ${omieData.nfes.length} NF-es · ${omieData.pedidos.length} pedidos · ${new Date().toLocaleTimeString('pt-BR')}`;
    }
  }

  /* ── 1. FATURAMENTO ── */
  function renderFaturamento() {
    const nfes = omieData.nfes;
    if (!nfes.length) return;

    const fatByM = Array(12).fill(0);
    nfes.forEach(nf => { if (nf.mes >= 0) fatByM[nf.mes] += (nf.valor || 0); });

    const fatAnual  = fatByM.reduce((a, b) => a + b, 0);
    const nfCount   = nfes.length;
    const ticket    = nfCount > 0 ? fatAnual / nfCount : 0;
    const mesAtual  = new Date().getMonth();
    const fatMes    = fatByM[mesAtual] || 0;
    const fatMesAnt = mesAtual > 0 ? fatByM[mesAtual - 1] : 0;
    const varMes    = fatMesAnt > 0 ? (fatMes - fatMesAnt) / fatMesAnt : null;
    const maiorNF   = nfes.reduce((mx, n) => n.valor > (mx?.valor || 0) ? n : mx, null);
    const clientesUnicos = new Set(nfes.map(n => n.cnpj || n.cliente)).size;

    setText('of-fat-anual',     fmtBRL(fatAnual));
    setText('of-fat-anual-sub', `${nfCount} NFs · ${clientesUnicos} clientes`);
    setText('of-nf-count',      nfCount);
    setText('of-nf-clientes',   `${clientesUnicos} clientes distintos`);
    setText('of-ticket-nf',     fmtBRL(ticket));
    setText('of-fat-mes',       fmtBRL(fatMes));
    setText('of-fat-mes-sub',   MESES_PT[mesAtual] + '/' + CUR_YEAR);
    setText('of-fat-mes-ant',   fmtBRL(fatMesAnt));

    if (varMes !== null) {
      const el = R('of-fat-mes-ant-var');
      if (el) {
        el.textContent = (varMes >= 0 ? '▲ +' : '▼ ') + fmtPct(Math.abs(varMes)) + ' vs mês anterior';
        el.style.color = varMes >= 0 ? 'var(--green-d)' : 'var(--red-d)';
      }
    }
    if (maiorNF) {
      setText('of-maior-nf',     fmtBRL(maiorNF.valor));
      setText('of-maior-nf-cli', maiorNF.cliente || maiorNF.nfNum || '—');
    }

    mkChart('of-chart-fat-mensal', 'bar',
      MESES_PT.slice(0, mesAtual + 1),
      [{ label:'Faturamento NF-e', data: fatByM.slice(0, mesAtual + 1), color:'rgba(124,58,237,0.8)' }],
      true);
  }

  /* ── 2. COTAÇÕES ── */
  function renderCotacoes() {
    const pedidos = omieData.pedidos;
    if (!pedidos.length) return;

    const orcamentos  = pedidos.filter(p => p.etapa === '10');
    const confirmados = pedidos.filter(p => p.etapa === '20');
    const faturados   = pedidos.filter(p => p.etapa === '50');
    const cancelados  = pedidos.filter(p => p.etapa === '60');
    const ativos      = pedidos.filter(p => p.etapa !== '60' && p.etapa !== '70');
    const soma = arr  => arr.reduce((s, p) => s + (p.valor || 0), 0);

    setText('of-cot-total',      ativos.length);
    setText('of-cot-valor',      fmtBRL(soma(ativos)));
    setText('of-cot-orcamentos', orcamentos.length);
    setText('of-cot-orc-valor',  fmtBRL(soma(orcamentos)));
    setText('of-cot-pedidos',    confirmados.length);
    setText('of-cot-ped-valor',  fmtBRL(soma(confirmados)));
    setText('of-cot-faturados',  faturados.length);
    setText('of-cot-fat-valor',  fmtBRL(soma(faturados)));
    setText('of-cot-cancelados', cancelados.length);
    setText('of-cot-can-valor',  fmtBRL(soma(cancelados)));

    const mesAtual = new Date().getMonth();
    const labels   = MESES_PT.slice(0, mesAtual + 1);
    const volByM   = Array(12).fill(0);
    const valByM   = Array(12).fill(0);
    ativos.forEach(p => {
      if (p.mes >= 0 && p.mes < 12) { volByM[p.mes]++; valByM[p.mes] += (p.valor || 0); }
    });

    mkChart('of-chart-cot-vol', 'bar', labels,
      [{ label:'Cotações', data: volByM.slice(0, mesAtual+1), color:'rgba(124,58,237,0.75)' }], false);
    mkChart('of-chart-cot-val', 'bar', labels,
      [{ label:'Valor Cotações', data: valByM.slice(0, mesAtual+1), color:'rgba(124,58,237,0.75)' }], true);
  }

  /* ── 3. COMPARAÇÃO ── */
  function renderComparacao() {
    const nfes    = omieData.nfes;
    const pedidos = omieData.pedidos;
    if (!nfes.length && !pedidos.length) return;

    const aprovados = pedidos.filter(p => p.etapa === '20' || p.etapa === '50');
    const faturados = pedidos.filter(p => p.etapa === '50');
    const totalCot  = pedidos.filter(p => p.etapa !== '60' && p.etapa !== '70');
    const soma   = arr => arr.reduce((s, p) => s + (p.valor || 0), 0);
    const somaNF = arr => arr.reduce((s, n) => s + (n.valor || 0), 0);

    const valorAprov = soma(aprovados);
    const valorNFes  = somaNF(nfes);
    const taxa       = totalCot.length > 0 ? faturados.length / totalCot.length : 0;
    const gap        = valorAprov - valorNFes;

    setText('of-conv-aprov',     aprovados.length);
    setText('of-conv-aprov-val', fmtBRL(valorAprov));
    setText('of-conv-nfs',       nfes.length);
    setText('of-conv-nfs-val',   fmtBRL(valorNFes));
    setText('of-conv-taxa',      fmtPct(taxa));
    setText('of-conv-gap',       fmtBRL(Math.abs(gap)));
    setText('of-conv-gap-sub',   gap > 0
      ? `${fmtBRL(gap)} aprovado ainda não faturado`
      : 'Faturamento alinhado com aprovações');

    const mesAtual  = new Date().getMonth();
    const labels    = MESES_PT.slice(0, mesAtual + 1);
    const aprovVolM = Array(12).fill(0), aprovValM = Array(12).fill(0);
    const nfVolM    = Array(12).fill(0), nfValM    = Array(12).fill(0);

    aprovados.forEach(p => {
      if (p.mes >= 0 && p.mes < 12) { aprovVolM[p.mes]++; aprovValM[p.mes] += (p.valor || 0); }
    });
    nfes.forEach(n => {
      if (n.mes >= 0 && n.mes < 12) { nfVolM[n.mes]++; nfValM[n.mes] += (n.valor || 0); }
    });

    mkChart('of-chart-comp-vol', 'bar', labels, [
      { label:'Cotações Aprovadas', data: aprovVolM.slice(0, mesAtual+1), color:'rgba(124,58,237,0.75)' },
      { label:'NFs Emitidas',       data: nfVolM.slice(0, mesAtual+1),   color:'rgba(16,185,129,0.75)' },
    ], false);
    mkChart('of-chart-comp-val', 'bar', labels, [
      { label:'Valor Aprovado',  data: aprovValM.slice(0, mesAtual+1), color:'rgba(124,58,237,0.75)' },
      { label:'Faturamento NF',  data: nfValM.slice(0, mesAtual+1),   color:'rgba(16,185,129,0.75)' },
    ], true);
  }

  /* ── 4. CLIENTES ATIVOS ── */
  function renderClientesAtivos() {
    const tbody = R('of-ativos-body');
    const badge = R('of-ativos-count');
    if (!tbody) return;

    const nfes = omieData.nfes;
    if (!nfes.length) {
      tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:32px;color:var(--muted)">
        Sem dados. Clique em "Atualizar Omie".</td></tr>`;
      return;
    }

    const dias   = parseInt(R('of-ativos-filtro')?.value || '60');
    const cutoff = new Date();
    if (dias < 9999) cutoff.setDate(cutoff.getDate() - dias);
    else cutoff.setFullYear(CUR_YEAR, 0, 1);

    const map = {};
    nfes.forEach(nf => {
      const key = (nf.cnpj && nf.cnpj !== '—') ? nf.cnpj : (nf.cliente || '_sem');
      if (!map[key]) map[key] = { nome: nf.cliente||'—', cnpj: nf.cnpj||'—', nfs:[], total:0, ultimaData:null, ultimaNF:null };
      if (map[key].nome === '—' && nf.cliente) map[key].nome = nf.cliente;
      map[key].nfs.push(nf);
      map[key].total += (nf.valor || 0);
      if (!map[key].ultimaData || (nf.data && nf.data > map[key].ultimaData)) {
        map[key].ultimaData = nf.data;
        map[key].ultimaNF   = nf;
      }
    });

    const ativos = Object.values(map)
      .filter(c => c.ultimaData && c.ultimaData >= cutoff)
      .sort((a, b) => (b.ultimaData||0) - (a.ultimaData||0));

    if (badge) badge.textContent = ativos.length + ' clientes';

    if (!ativos.length) {
      tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:32px;color:var(--muted)">
        Nenhum cliente com NF no período.</td></tr>`;
      return;
    }

    tbody.innerHTML = '';
    ativos.forEach((c, idx) => {
      const d = c.ultimaData ? diasAtras(c.ultimaData) : null;
      const cls = d===null?'tag-gray': d<=30?'tag-green': d<=60?'tag-yellow':'tag-red';
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td style="color:var(--muted);font-size:12px">${idx+1}</td>
        <td><strong>${escHtml(c.nome)}</strong></td>
        <td style="font-family:monospace;font-size:12px">${escHtml(c.cnpj)}</td>
        <td>${c.ultimaData ? c.ultimaData.toLocaleDateString('pt-BR') : '—'}</td>
        <td><span class="tag ${cls}">${d!==null ? d+'d atrás':'—'}</span></td>
        <td>${fmtBRL(c.ultimaNF?.valor||0)}</td>
        <td><strong>${fmtBRL(c.total)}</strong></td>
        <td>${c.nfs.length}</td>`;
      tbody.appendChild(tr);
    });
  }

  /* ================================================================
     GRÁFICOS
     ================================================================ */
  const _ch = {};
  function mkChart(id, type, labels, datasets, isMoney) {
    const canvas = R(id);
    if (!canvas || typeof Chart === 'undefined') return;
    if (_ch[id]) { try { _ch[id].destroy(); } catch(e) {} }
    _ch[id] = new Chart(canvas.getContext('2d'), {
      type,
      data: {
        labels,
        datasets: datasets.map(ds => ({
          label:           ds.label,
          data:            ds.data,
          backgroundColor: ds.color,
          borderColor:     ds.borderColor || ds.color,
          borderWidth:     type==='line' ? 2 : 0,
          borderRadius:    4,
          fill:            type==='line',
          tension:         0.4,
        })),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { labels: { color:'#8a8da8', font:{ size:11 } } },
          tooltip: { callbacks: { label: ctx => ' '+ctx.dataset.label+': '+(isMoney ? fmtBRL(ctx.raw) : ctx.raw) } },
          datalabels: { display: false },
        },
        scales: {
          x: { grid:{ color:'rgba(255,255,255,.04)' }, ticks:{ color:'#8a8da8', font:{ size:11 } } },
          y: { grid:{ color:'rgba(255,255,255,.04)' }, ticks: { color:'#8a8da8', font:{ size:11 },
            callback: v => isMoney
              ? (v>=1e6 ? 'R$'+(v/1e6).toFixed(1)+'M' : v>=1e3 ? 'R$'+(v/1e3).toFixed(0)+'k' : fmtBRL(v))
              : v,
          }},
        },
      },
    });
  }

  /* ================================================================
     INIT
     ================================================================ */
  async function init() {
    /* Aguarda âncora de injeção estar no DOM */
    let tries = 0;
    while (!R('omie-patch-root') && !R('tab-faturamento') && tries++ < 50) {
      await new Promise(r => setTimeout(r, 200));
    }

    injectHTML();

    window._omieRenderClientesAtivos = renderClientesAtivos;
    window._omieRefresh = async () => {
      setText('omie-sync-ts', 'sincronizando…');
      try { await fetchOmieData(); render(); }
      catch(e) { setText('omie-sync-ts', '⚠️ erro: ' + e.message); }
    };

    try {
      await fetchOmieData();
    } catch(e) {
      const msg = e.message?.includes('CORS') || e.message?.includes('Failed to fetch')
        ? '⚠️ CORS bloqueado — use o botão Atualizar Omie ou o proxy local'
        : '⚠️ ' + e.message;
      setText('omie-sync-ts', msg);
      console.warn('[omie-fat] init:', e);
    } finally {
      render(); // Sempre renderiza — mostra o que foi carregado (mesmo parcialmente)
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(init, 1000));
  } else {
    setTimeout(init, 1000);
  }

})();
