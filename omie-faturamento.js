/**
 * omie-faturamento.js — Integração Omie · Aba Faturamento
 * Be You Dashboard · v2
 *
 * Todos os dados vêm exclusivamente da Omie:
 *  • state.omieNFes     → NF-e emitidas (faturamento real)
 *  • state.omiePedidos  → Pedidos de venda (cotações / orçamentos)
 *
 * Etapas dos pedidos Omie:
 *  10 = Orçamento (cotação em aberto)
 *  20 = Pedido confirmado (cotação aprovada, aguardando NF)
 *  50 = Faturado (NF emitida a partir deste pedido)
 *  60 = Cancelado
 *  70 = Devolvido
 *
 * COMO USAR: adicione antes de </body> no dashboard.html:
 *   <script src="omie-faturamento.js"></script>
 */
(function () {
  'use strict';

  /* ── Credenciais Omie ─────────────────────────────────────── */
  const OMIE_KEY    = '3386409280254';
  const OMIE_SECRET = '0df8348a9be3b2d0bc7c60476ff9c961';

  const MESES_PT = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
  const CUR_YEAR = new Date().getFullYear();

  /* ── Helpers ─────────────────────────────────────────────── */
  function waitFor(fn, ms) {
    return new Promise((ok, err) => {
      const t = Date.now();
      (function p() {
        if (fn()) return ok();
        if (Date.now() - t > (ms || 15000)) return err('timeout');
        setTimeout(p, 200);
      })();
    });
  }

  function R(id) { return document.getElementById(id); }

  function setText(id, val) { const e = R(id); if (e) e.textContent = val; }

  function fmtBRL(v) {
    if (typeof window.fmtBRL === 'function') return window.fmtBRL(v);
    return Number(v || 0).toLocaleString('pt-BR', {
      style: 'currency', currency: 'BRL',
      minimumFractionDigits: 0, maximumFractionDigits: 0
    });
  }

  function fmtPct(v) {
    if (typeof window.fmtPct === 'function') return window.fmtPct(v);
    return ((v || 0) * 100).toFixed(1) + '%';
  }

  function escHtml(s) {
    const d = document.createElement('div');
    d.appendChild(document.createTextNode(String(s || '')));
    return d.innerHTML;
  }

  function diasAtras(date) {
    if (!date) return null;
    return Math.round((Date.now() - new Date(date).getTime()) / 86400000);
  }

  /* ================================================================
     HTML DA ABA FATURAMENTO
     ================================================================ */
  function injectHTML() {
    if (R('omie-fat-root')) return;

    /* Âncoras em ordem de preferência:
       1. omie-patch-root — div reservado no dashboard exatamente para isso
       2. antes de fatNFesWrap — tabela NF-e já existente
       3. no final de tab-faturamento */
    const patchRoot = R('omie-patch-root');
    const fatWrap   = R('fatNFesWrap');
    const tabFat    = R('tab-faturamento');
    if (!patchRoot && !fatWrap && !tabFat) return;

    const html = `
<div id="omie-fat-root" style="margin-top:4px">

  <!-- ══ CABEÇALHO DA SEÇÃO ════════════════════════════════════ -->
  <div style="display:flex;align-items:center;justify-content:space-between;
              padding:18px 0 12px;border-top:1px solid var(--border);margin-top:8px">
    <div>
      <span style="font-size:11px;font-weight:700;text-transform:uppercase;
                   letter-spacing:.7px;color:#a78bfa">🟠 Omie — Dados de Faturamento e Cotações</span>
      <span id="omie-sync-ts" style="font-size:11px;color:var(--muted);margin-left:10px"></span>
    </div>
    <button onclick="window._omieRefresh && window._omieRefresh()"
      style="font-size:11px;padding:4px 12px;border-radius:6px;border:1px solid var(--border);
             background:var(--card);color:var(--text);cursor:pointer">
      🔄 Atualizar Omie
    </button>
  </div>

  <!-- ══ 1. FATURAMENTO ANUAL & MENSAL (NF-e) ══════════════════ -->
  <div style="font-size:12px;font-weight:600;color:var(--muted);
              text-transform:uppercase;letter-spacing:.4px;margin-bottom:10px">
    📄 Faturamento — NF-e Emitidas (${CUR_YEAR})
  </div>

  <div class="metrics" style="margin-bottom:24px">
    <div class="metric">
      <div class="metric-label">Faturamento Anual</div>
      <div class="metric-value" id="of-fat-anual">—</div>
      <div class="metric-delta" id="of-fat-anual-sub">Total NF-e ${CUR_YEAR}</div>
    </div>
    <div class="metric">
      <div class="metric-label">NFs Emitidas</div>
      <div class="metric-value" id="of-nf-count">—</div>
      <div class="metric-delta" id="of-nf-clientes">—</div>
    </div>
    <div class="metric">
      <div class="metric-label">Ticket Médio NF</div>
      <div class="metric-value" id="of-ticket-nf">—</div>
      <div class="metric-delta">Por nota fiscal</div>
    </div>
    <div class="metric">
      <div class="metric-label">Faturamento Mês Atual</div>
      <div class="metric-value" id="of-fat-mes">—</div>
      <div class="metric-delta" id="of-fat-mes-sub">—</div>
    </div>
    <div class="metric">
      <div class="metric-label">Faturamento Mês Anterior</div>
      <div class="metric-value" id="of-fat-mes-ant">—</div>
      <div class="metric-delta" id="of-fat-mes-ant-var">—</div>
    </div>
    <div class="metric">
      <div class="metric-label">Maior NF do Ano</div>
      <div class="metric-value" id="of-maior-nf">—</div>
      <div class="metric-delta" id="of-maior-nf-cli">—</div>
    </div>
  </div>

  <!-- Gráfico faturamento mensal -->
  <div class="charts" style="margin-bottom:24px">
    <div class="chart-card" style="grid-column:1/-1">
      <div class="chart-title">
        Faturamento Mensal — NF-e Omie (${CUR_YEAR})
        <span class="chart-subtitle">R$ por mês</span>
      </div>
      <div class="chart-wrap tall"><canvas id="of-chart-fat-mensal"></canvas></div>
    </div>
  </div>

  <!-- ══ 2. COTAÇÕES (PEDIDOS DE VENDA) ════════════════════════ -->
  <div style="font-size:12px;font-weight:600;color:var(--muted);
              text-transform:uppercase;letter-spacing:.4px;margin:24px 0 10px">
    📋 Cotações — Pedidos de Venda Omie (${CUR_YEAR})
  </div>

  <div class="metrics" style="margin-bottom:24px">
    <div class="metric">
      <div class="metric-label">Total de Cotações</div>
      <div class="metric-value" id="of-cot-total">—</div>
      <div class="metric-delta">Orçamentos + Pedidos + Faturados</div>
    </div>
    <div class="metric">
      <div class="metric-label">Valor Total Cotações</div>
      <div class="metric-value" id="of-cot-valor">—</div>
      <div class="metric-delta">Soma de todos os pedidos</div>
    </div>
    <div class="metric">
      <div class="metric-label">Orçamentos Abertos</div>
      <div class="metric-value" id="of-cot-orcamentos">—</div>
      <div class="metric-delta" id="of-cot-orc-valor">Aguardando aprovação</div>
    </div>
    <div class="metric">
      <div class="metric-label">Pedidos Confirmados</div>
      <div class="metric-value" id="of-cot-pedidos">—</div>
      <div class="metric-delta" id="of-cot-ped-valor">Aprovados, aguardando NF</div>
    </div>
    <div class="metric">
      <div class="metric-label">Faturados (etapa 50)</div>
      <div class="metric-value" id="of-cot-faturados">—</div>
      <div class="metric-delta" id="of-cot-fat-valor">NF emitida</div>
    </div>
    <div class="metric">
      <div class="metric-label">Cancelados</div>
      <div class="metric-value" id="of-cot-cancelados">—</div>
      <div class="metric-delta" id="of-cot-can-valor">—</div>
    </div>
  </div>

  <!-- Gráfico cotações mensais -->
  <div class="charts" style="margin-bottom:24px">
    <div class="chart-card">
      <div class="chart-title">
        Volume de Cotações por Mês
        <span class="chart-subtitle">unidades</span>
      </div>
      <div class="chart-wrap tall"><canvas id="of-chart-cot-vol"></canvas></div>
    </div>
    <div class="chart-card">
      <div class="chart-title">
        Valor de Cotações por Mês
        <span class="chart-subtitle">R$</span>
      </div>
      <div class="chart-wrap tall"><canvas id="of-chart-cot-val"></canvas></div>
    </div>
  </div>

  <!-- ══ 3. COMPARAÇÃO COTAÇÕES APROVADAS × NF-e ═══════════════ -->
  <div style="font-size:12px;font-weight:600;color:var(--muted);
              text-transform:uppercase;letter-spacing:.4px;margin:24px 0 10px">
    📊 Comparação — Cotações Aprovadas × NFs Emitidas
  </div>

  <!-- Métricas de conversão -->
  <div class="metrics" style="margin-bottom:20px">
    <div class="metric">
      <div class="metric-label">Cotações Aprovadas</div>
      <div class="metric-value" id="of-conv-aprov">—</div>
      <div class="metric-delta" id="of-conv-aprov-val">Etapas 20 + 50</div>
    </div>
    <div class="metric">
      <div class="metric-label">NFs Geradas</div>
      <div class="metric-value" id="of-conv-nfs">—</div>
      <div class="metric-delta" id="of-conv-nfs-val">NF-e emitidas Omie</div>
    </div>
    <div class="metric">
      <div class="metric-label">Taxa Cot → NF</div>
      <div class="metric-value" id="of-conv-taxa">—</div>
      <div class="metric-delta">Faturados ÷ Total cotações</div>
    </div>
    <div class="metric">
      <div class="metric-label">Valor Aprovado vs Faturado</div>
      <div class="metric-value" id="of-conv-gap">—</div>
      <div class="metric-delta" id="of-conv-gap-sub">Diferença aprovado → NF</div>
    </div>
  </div>

  <!-- Gráfico comparação por mês -->
  <div class="charts" style="margin-bottom:24px">
    <div class="chart-card">
      <div class="chart-title">
        Volume: Cotações Aprovadas × NFs por Mês
        <span class="chart-subtitle">unidades</span>
      </div>
      <div class="chart-wrap tall"><canvas id="of-chart-comp-vol"></canvas></div>
    </div>
    <div class="chart-card">
      <div class="chart-title">
        Valor: Cotações Aprovadas × Faturamento NF
        <span class="chart-subtitle">R$</span>
      </div>
      <div class="chart-wrap tall"><canvas id="of-chart-comp-val"></canvas></div>
    </div>
  </div>

  <!-- ══ 4. CLIENTES ATIVOS (NF RECENTE) ══════════════════════ -->
  <div class="table-card" style="margin-bottom:24px">
    <div class="table-header">
      ✅ Clientes Ativos — com NF emitida recentemente
      <div style="display:flex;align-items:center;gap:8px">
        <span id="of-ativos-count" class="tag tag-green" style="font-size:11px"></span>
        <select id="of-ativos-filtro"
          style="font-size:12px;padding:4px 8px;border:1px solid var(--border);
                 border-radius:6px;background:var(--card);color:var(--text)"
          onchange="window._omieRenderClientesAtivos && window._omieRenderClientesAtivos()">
          <option value="30">Últimos 30 dias</option>
          <option value="60" selected>Últimos 60 dias</option>
          <option value="90">Últimos 90 dias</option>
          <option value="180">Últimos 180 dias</option>
          <option value="9999">Todo ${CUR_YEAR}</option>
        </select>
      </div>
    </div>
    <table>
      <thead><tr>
        <th>#</th>
        <th>Cliente</th>
        <th>CNPJ / CPF</th>
        <th>Última NF</th>
        <th>Dias desde última NF</th>
        <th>Valor Última NF</th>
        <th>Total ${CUR_YEAR}</th>
        <th>Nº NFs</th>
      </tr></thead>
      <tbody id="of-ativos-body">
        <tr><td colspan="8" style="text-align:center;padding:32px;color:var(--muted)">
          Aguardando sincronização com Omie…
        </td></tr>
      </tbody>
    </table>
  </div>

</div><!-- #omie-fat-root -->
`;

    if (patchRoot) {
      /* Insere o bloco Omie logo após o div reservado */
      patchRoot.insertAdjacentHTML('afterend', html);
    } else if (fatWrap) {
      /* Insere antes da tabela NF-e detalhada */
      fatWrap.insertAdjacentHTML('beforebegin', html);
    } else {
      /* Fallback: no final da aba */
      tabFat.insertAdjacentHTML('beforeend', html);
    }
  }

  /* ================================================================
     RENDERIZAÇÃO PRINCIPAL
     ================================================================ */
  function render() {
    const nfes    = window.state?.omieNFes    || [];
    const pedidos = window.state?.omiePedidos || [];

    renderFaturamento(nfes, pedidos);
    renderCotacoes(pedidos);
    renderComparacao(nfes, pedidos);
    renderClientesAtivos();

    /* Timestamp de sync */
    const ts = R('omie-sync-ts');
    if (ts && nfes.length) {
      ts.textContent = `• ${nfes.length} NF-es · ${pedidos.length} pedidos · atualizado ${new Date().toLocaleTimeString('pt-BR')}`;
    }
  }

  /* ── 1. FATURAMENTO ANUAL & MENSAL ────────────────────────── */
  function renderFaturamento(nfes, pedidos) {
    if (!nfes.length) return;

    const fatByM = Array(12).fill(0);
    nfes.forEach(nf => {
      if (nf.mes >= 0 && nf.mes < 12) fatByM[nf.mes] += (nf.valor || 0);
    });

    const fatAnual = fatByM.reduce((a, b) => a + b, 0);
    const nfCount  = nfes.length;
    const ticket   = nfCount > 0 ? fatAnual / nfCount : 0;

    const mesAtual = new Date().getMonth();
    const fatMes   = fatByM[mesAtual] || 0;
    const fatMesAnt= mesAtual > 0 ? fatByM[mesAtual - 1] : 0;
    const varMes   = fatMesAnt > 0 ? (fatMes - fatMesAnt) / fatMesAnt : null;

    /* Maior NF */
    const maiorNF  = nfes.reduce((mx, n) => n.valor > (mx?.valor || 0) ? n : mx, null);

    /* Clientes únicos */
    const clientesUnicos = new Set(nfes.map(n => n.cnpj || n.cliente)).size;

    /* Atualiza cards */
    setText('of-fat-anual',       fmtBRL(fatAnual));
    setText('of-fat-anual-sub',   `${nfCount} NFs · ${clientesUnicos} clientes`);
    setText('of-nf-count',        nfCount);
    setText('of-nf-clientes',     `${clientesUnicos} clientes distintos`);
    setText('of-ticket-nf',       fmtBRL(ticket));
    setText('of-fat-mes',         fmtBRL(fatMes));
    setText('of-fat-mes-sub',     MESES_PT[mesAtual] + '/' + CUR_YEAR);
    setText('of-fat-mes-ant',     fmtBRL(fatMesAnt));

    if (varMes !== null) {
      const varEl = R('of-fat-mes-ant-var');
      if (varEl) {
        varEl.textContent = (varMes >= 0 ? '▲ +' : '▼ ') + fmtPct(Math.abs(varMes)) + ' vs mês anterior';
        varEl.style.color = varMes >= 0 ? 'var(--green-d)' : 'var(--red-d)';
      }
    }

    if (maiorNF) {
      setText('of-maior-nf',     fmtBRL(maiorNF.valor));
      setText('of-maior-nf-cli', maiorNF.cliente || maiorNF.nfNum || '—');
    }

    /* Gráfico faturamento mensal */
    const labels = MESES_PT.slice(0, mesAtual + 1);
    const data   = fatByM.slice(0, mesAtual + 1);
    mkChart('of-chart-fat-mensal', 'bar', labels,
      [{ label: 'Faturamento NF-e', data, color: 'rgba(124,58,237,0.8)', borderColor: '#7c3aed' }],
      true);
  }

  /* ── 2. COTAÇÕES (PEDIDOS DE VENDA) ──────────────────────── */
  function renderCotacoes(pedidos) {
    if (!pedidos.length) return;

    const orcamentos = pedidos.filter(p => p.etapa === '10');
    const confirmados= pedidos.filter(p => p.etapa === '20');
    const faturados  = pedidos.filter(p => p.etapa === '50');
    const cancelados = pedidos.filter(p => p.etapa === '60');
    /* Total exclui cancelados para volume */
    const ativos     = pedidos.filter(p => p.etapa !== '60' && p.etapa !== '70');

    const soma = arr => arr.reduce((s, p) => s + (p.valor || 0), 0);

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

    /* Gráficos por mês */
    const mesAtual  = new Date().getMonth();
    const labels    = MESES_PT.slice(0, mesAtual + 1);
    const volByM    = Array(12).fill(0);
    const valByM    = Array(12).fill(0);
    const fatByM    = Array(12).fill(0);
    const fatValByM = Array(12).fill(0);

    ativos.forEach(p => {
      if (p.mes >= 0 && p.mes < 12) {
        volByM[p.mes]++;
        valByM[p.mes] += (p.valor || 0);
      }
    });
    faturados.forEach(p => {
      if (p.mes >= 0 && p.mes < 12) {
        fatByM[p.mes]++;
        fatValByM[p.mes] += (p.valor || 0);
      }
    });

    mkChart('of-chart-cot-vol', 'bar', labels, [
      { label: 'Orçamentos/Pedidos', data: volByM.slice(0, mesAtual + 1), color: 'rgba(124,58,237,0.75)' },
    ], false);

    mkChart('of-chart-cot-val', 'bar', labels, [
      { label: 'Valor Cotações', data: valByM.slice(0, mesAtual + 1), color: 'rgba(124,58,237,0.75)' },
    ], true);
  }

  /* ── 3. COMPARAÇÃO COTAÇÕES × NF-e ──────────────────────── */
  function renderComparacao(nfes, pedidos) {
    if (!nfes.length && !pedidos.length) return;

    /* Aprovadas = pedidos confirmados (20) + faturados (50) */
    const aprovados  = pedidos.filter(p => p.etapa === '20' || p.etapa === '50');
    const faturados  = pedidos.filter(p => p.etapa === '50');
    const totalCot   = pedidos.filter(p => p.etapa !== '60' && p.etapa !== '70');
    const soma = arr => arr.reduce((s, p) => s + (p.valor || 0), 0);
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
    setText('of-conv-gap-sub',
      gap > 0
        ? `R$ ${fmtBRL(gap).replace('R$','').trim()} aprovado ainda não faturado`
        : 'Faturamento alinhado com aprovações');

    /* Gráficos comparativos por mês */
    const mesAtual  = new Date().getMonth();
    const labels    = MESES_PT.slice(0, mesAtual + 1);
    const aprovVolM = Array(12).fill(0);
    const aprovValM = Array(12).fill(0);
    const nfVolM    = Array(12).fill(0);
    const nfValM    = Array(12).fill(0);

    aprovados.forEach(p => {
      if (p.mes >= 0 && p.mes < 12) {
        aprovVolM[p.mes]++;
        aprovValM[p.mes] += (p.valor || 0);
      }
    });
    nfes.forEach(n => {
      if (n.mes >= 0 && n.mes < 12) {
        nfVolM[n.mes]++;
        nfValM[n.mes] += (n.valor || 0);
      }
    });

    mkChart('of-chart-comp-vol', 'bar', labels, [
      { label: 'Cotações Aprovadas', data: aprovVolM.slice(0, mesAtual + 1), color: 'rgba(124,58,237,0.75)' },
      { label: 'NFs Emitidas',       data: nfVolM.slice(0, mesAtual + 1),   color: 'rgba(16,185,129,0.75)' },
    ], false);

    mkChart('of-chart-comp-val', 'bar', labels, [
      { label: 'Valor Aprovado', data: aprovValM.slice(0, mesAtual + 1), color: 'rgba(124,58,237,0.75)' },
      { label: 'Faturamento NF', data: nfValM.slice(0, mesAtual + 1),   color: 'rgba(16,185,129,0.75)' },
    ], true);
  }

  /* ── 4. CLIENTES ATIVOS ──────────────────────────────────── */
  function renderClientesAtivos() {
    const tbody = R('of-ativos-body');
    const badge = R('of-ativos-count');
    if (!tbody) return;

    const nfes = window.state?.omieNFes || [];
    if (!nfes.length) {
      tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:32px;color:var(--muted)">
        Sem dados de NF-e. Clique em "Atualizar Omie" para carregar.</td></tr>`;
      return;
    }

    const dias   = parseInt(R('of-ativos-filtro')?.value || '60');
    const cutoff = new Date();
    if (dias < 9999) cutoff.setDate(cutoff.getDate() - dias);
    else cutoff.setFullYear(CUR_YEAR, 0, 1);

    /* Agrupa NFs por CNPJ/cliente */
    const map = {};
    nfes.forEach(nf => {
      const key = (nf.cnpj && nf.cnpj !== '—' && nf.cnpj !== '') ? nf.cnpj : (nf.cliente || '_sem_id');
      if (!map[key]) {
        map[key] = {
          nome:       nf.cliente || '—',
          cnpj:       nf.cnpj    || '—',
          nfs:        [],
          total:      0,
          ultimaData: null,
          ultimaNF:   null,
        };
      }
      /* Normaliza nome (decodifica entidades HTML se necessário) */
      if (map[key].nome === '—' && nf.cliente) map[key].nome = nf.cliente;
      map[key].nfs.push(nf);
      map[key].total += (nf.valor || 0);
      if (!map[key].ultimaData || (nf.data && nf.data > map[key].ultimaData)) {
        map[key].ultimaData = nf.data;
        map[key].ultimaNF   = nf;
      }
    });

    /* Filtra por período e ordena por data mais recente */
    const ativos = Object.values(map)
      .filter(c => c.ultimaData && c.ultimaData >= cutoff)
      .sort((a, b) => (b.ultimaData || 0) - (a.ultimaData || 0));

    if (badge) badge.textContent = ativos.length + ' clientes';

    if (!ativos.length) {
      tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:32px;color:var(--muted)">
        Nenhum cliente com NF emitida no período selecionado.</td></tr>`;
      return;
    }

    tbody.innerHTML = '';
    ativos.forEach((c, idx) => {
      const d = c.ultimaData ? diasAtras(c.ultimaData) : null;
      const urgClass = d === null   ? 'tag-gray'
                     : d <= 30     ? 'tag-green'
                     : d <= 60     ? 'tag-yellow'
                     : 'tag-red';
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td style="color:var(--muted);font-size:12px">${idx + 1}</td>
        <td><strong>${escHtml(c.nome)}</strong></td>
        <td style="font-family:monospace;font-size:12px">${escHtml(c.cnpj)}</td>
        <td>${c.ultimaData ? c.ultimaData.toLocaleDateString('pt-BR') : '—'}</td>
        <td><span class="tag ${urgClass}">${d !== null ? d + 'd atrás' : '—'}</span></td>
        <td>${fmtBRL(c.ultimaNF?.valor || 0)}</td>
        <td><strong>${fmtBRL(c.total)}</strong></td>
        <td>${c.nfs.length}</td>`;
      tbody.appendChild(tr);
    });
  }

  /* ================================================================
     GRÁFICOS (Chart.js direto — sem depender dos helpers internos)
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
          borderWidth:     type === 'line' ? 2 : 0,
          borderRadius:    4,
          fill:            type === 'line',
          tension:         0.4,
        })),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { labels: { color: '#8a8da8', font: { size: 11 } } },
          tooltip: {
            callbacks: {
              label: ctx => ' ' + ctx.dataset.label + ': ' +
                (isMoney ? fmtBRL(ctx.raw) : ctx.raw),
            },
          },
          datalabels: { display: false },
        },
        scales: {
          x: {
            grid:  { color: 'rgba(255,255,255,.04)' },
            ticks: { color: '#8a8da8', font: { size: 11 } },
          },
          y: {
            grid:  { color: 'rgba(255,255,255,.04)' },
            ticks: {
              color: '#8a8da8',
              font:  { size: 11 },
              callback: v => isMoney
                ? (v >= 1e6 ? 'R$' + (v / 1e6).toFixed(1) + 'M'
                 : v >= 1e3 ? 'R$' + (v / 1e3).toFixed(0) + 'k'
                 : fmtBRL(v))
                : v,
            },
          },
        },
      },
    });
  }

  /* ================================================================
     INIT — sem patches em funções globais do dashboard
     (patches quebravam handlers dos botões)
     ================================================================ */
  async function safeRender() {
    try { render(); } catch(e) { console.warn('[omie-fat] render error:', e); }
  }

  async function init() {
    try {
      await waitFor(() =>
        typeof window.cfg      !== 'undefined' &&
        typeof window.state    !== 'undefined' &&
        typeof window.syncOmie === 'function'
      );

      /* Credenciais */
      if (!window.cfg.omieKey)    window.cfg.omieKey    = OMIE_KEY;
      if (!window.cfg.omieSecret) window.cfg.omieSecret = OMIE_SECRET;

      /* Injeta HTML das seções Omie */
      injectHTML();

      /* Expõe globais para o select de filtro e botão Atualizar */
      window._omieRenderClientesAtivos = renderClientesAtivos;
      window._omieRefresh = async () => {
        setText('omie-sync-ts', 'sincronizando…');
        try {
          await window.syncOmie();
          await safeRender();
        } catch (e) {
          setText('omie-sync-ts', '⚠️ erro: ' + e.message);
        }
      };

      /* Sincroniza com Omie e renderiza — sem tocar nas funções do dashboard */
      if (!window.state.omieNFes?.length || !window.state.omiePedidos?.length) {
        setText('omie-sync-ts', 'sincronizando…');
        try {
          await window.syncOmie();
          await safeRender();
        } catch (e) {
          setText('omie-sync-ts', '⚠️ sync falhou — use o botão Atualizar Omie');
          console.warn('[omie-fat] sync falhou:', e);
        }
      } else {
        await safeRender();
      }

      console.log('[omie-fat] ✅ Integração Omie v2 ativa.');
    } catch (e) {
      console.error('[omie-fat] falha init:', e);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(init, 800));
  } else {
    setTimeout(init, 800);
  }

})();
