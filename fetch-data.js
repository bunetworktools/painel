// fetch-data.js — Busca dados do Pipefy e gera data.json
// Executado pelo GitHub Actions 2x/dia (08h e 14h Brasília)
// Requer Node.js 22+ (usa fetch nativo)
//
// ESTRATÉGIA DE CHAMADAS:
//   Busca apenas cards de fases ATIVAS (não finalizadas) — server-side filter.
//   Cards finalizados são preservados do data.json existente sem chamar a API.
//   Consumo proporcional ao trabalho ativo, não ao histórico acumulado.

const fs = require('fs');

const TOKEN           = process.env.PIPEFY_TOKEN;
const PIPE_COTACOES   = process.env.PIPE_COTACOES_ID;
const PIPE_COMPRAS    = process.env.PIPE_COMPRAS_ID;
const PIPE_LOGISTICA  = process.env.PIPE_LOGISTICA_ID;

if (!TOKEN) {
  console.error('❌ PIPEFY_TOKEN não definido. Configure o secret no GitHub.');
  process.exit(1);
}

const CARD_FIELDS = `
  id title
  current_phase { name }
  created_at finished_at updated_at
  fields { name value }
`;

async function pipefyGQL(query, variables = {}) {
  const res = await fetch('https://api.pipefy.com/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${TOKEN}`
    },
    body: JSON.stringify({ query, variables })
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${await res.text()}`);
  const json = await res.json();
  if (json.errors) throw new Error(json.errors.map(e => e.message).join('; '));
  return json.data;
}

async function fetchActivePipeCards(pipeId, label) {
  const pipeData = await pipefyGQL(`
    query($id: ID!) {
      pipe(id: $id) {
        phases {
          id
          name
          done
          cards_count
        }
      }
    }`, { id: pipeId });

  const activePhases = pipeData.pipe.phases.filter(p => !p.done && p.cards_count > 0);

  if (activePhases.length === 0) {
    console.log(`  ${label} — nenhuma fase ativa com cards.`);
    return [];
  }

  console.log(`  ${label} — ${activePhases.length} fase(s) ativa(s): ${activePhases.map(p => p.name).join(', ')}`);

  const cards = [];
  for (const phase of activePhases) {
    let cursor = null;
    let page = 1;
    do {
      process.stdout.write(`  ${label} / ${phase.name} — página ${page++}...\r`);
      const data = await pipefyGQL(`
        query($id: ID!, $after: String) {
          phase(id: $id) {
            cards(first: 50, after: $after) {
              pageInfo { hasNextPage endCursor }
              edges { node { ${CARD_FIELDS} } }
            }
          }
        }`, { id: phase.id, after: cursor });

      const pg = data.phase.cards;
      cards.push(...pg.edges.map(e => e.node));
      cursor = pg.pageInfo.hasNextPage ? pg.pageInfo.endCursor : null;
    } while (cursor);
  }

  return cards;
}

function mergeCards(activeCards, existingCards) {
  const activeIds = new Set(activeCards.map(c => String(c.id)));
  const historicalFinished = (existingCards || []).filter(
    c => c.finished_at !== null && !activeIds.has(String(c.id))
  );
  return [...activeCards, ...historicalFinished];
}

async function main() {
  console.log('🔄 Sincronizando cards ativos com Pipefy...\n');

  let existing = { cotacoes: [], compras: [], logistica: [] };
  if (fs.existsSync('data.json')) {
    try {
      existing = JSON.parse(fs.readFileSync('data.json', 'utf-8'));
      const totalFinished =
        (existing.cotacoes  || []).filter(c => c.finished_at).length +
        (existing.compras   || []).filter(c => c.finished_at).length +
        (existing.logistica || []).filter(c => c.finished_at).length;
      console.log(`📂 data.json carregado — ${totalFinished} cards finalizados preservados sem chamar a API.\n`);
    } catch {
      console.warn('⚠️  data.json não pôde ser lido. Iniciando do zero.\n');
    }
  }

  const state = {
    cotacoes:  [],
    compras:   [],
    logistica: [],
    syncedAt:  new Date().toISOString()
  };

  if (PIPE_COTACOES) {
    console.log('📋 Buscando cotações ativas...');
    const active = await fetchActivePipeCards(PIPE_COTACOES, 'Cotações');
    state.cotacoes = mergeCards(active, existing.cotacoes);
    console.log(`  ✅ ${active.length} ativos (API) + ${state.cotacoes.length - active.length} finalizados (cache)\n`);
  } else {
    console.warn('  ⚠️  PIPE_COTACOES_ID não definido — pulando\n');
  }

  if (PIPE_COMPRAS) {
    console.log('🛒 Buscando compras ativas...');
    const active = await fetchActivePipeCards(PIPE_COMPRAS, 'Compras');
    state.compras = mergeCards(active, existing.compras);
    console.log(`  ✅ ${active.length} ativos (API) + ${state.compras.length - active.length} finalizados (cache)\n`);
  } else {
    console.warn('  ⚠️  PIPE_COMPRAS_ID não definido — pulando\n');
  }

  if (PIPE_LOGISTICA) {
    console.log('🚚 Buscando logística ativa...');
    const active = await fetchActivePipeCards(PIPE_LOGISTICA, 'Logística');
    state.logistica = mergeCards(active, existing.logistica);
    console.log(`  ✅ ${active.length} ativos (API) + ${state.logistica.length - active.length} finalizados (cache)\n`);
  } else {
    console.warn('  ⚠️  PIPE_LOGISTICA_ID não definido — pulando\n');
  }

  fs.writeFileSync('data.json', JSON.stringify(state, null, 2), 'utf-8');

  const allCards     = [...state.cotacoes, ...state.compras, ...state.logistica];
  const totalActive  = allCards.filter(c => !c.finished_at).length;
  const totalHistory = allCards.filter(c =>  c.finished_at).length;

  console.log(`✅ data.json salvo — ${totalActive} ativos + ${totalHistory} finalizados = ${allCards.length} cards`);
  console.log(`   Sincronizado em: ${new Date(state.syncedAt).toLocaleString('pt-BR')}`);
}

main().catch(e => {
  console.error('\n❌ Erro na sincronização:', e.message);
  process.exit(1);
});
