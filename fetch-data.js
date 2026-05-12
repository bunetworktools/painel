// fetch-data.js — Busca dados do Pipefy e gera data.json
// Executado pelo GitHub Actions a cada 4 horas
// Requer Node.js 18+ (usa fetch nativo)

const fs = require('fs');

const TOKEN           = process.env.PIPEFY_TOKEN;
const PIPE_COTACOES   = process.env.PIPE_COTACOES_ID;
const PIPE_COMPRAS    = process.env.PIPE_COMPRAS_ID;
const PIPE_LOGISTICA  = process.env.PIPE_LOGISTICA_ID;

if (!TOKEN) {
  console.error('❌ PIPEFY_TOKEN não definido. Configure o secret no GitHub.');
  process.exit(1);
}

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

async function fetchAllCards(pipeId, label) {
  const cards = [];
  let cursor = null;
  let page = 1;
  do {
    process.stdout.write(`  ${label} — página ${page++}...\r`);
    const data = await pipefyGQL(`
      query($id: ID!, $after: String) {
        allCards(pipeId: $id, first: 50, after: $after) {
          pageInfo { hasNextPage endCursor }
          edges { node {
            id title
            current_phase { name }
            created_at finished_at updated_at
            fields { name value }
          }}
        }
      }`, { id: pipeId, after: cursor });
    const pg = data.allCards;
    cards.push(...pg.edges.map(e => e.node));
    cursor = pg.pageInfo.hasNextPage ? pg.pageInfo.endCursor : null;
  } while (cursor);
  return cards;
}

async function main() {
  console.log('🔄 Iniciando sincronização com Pipefy...\n');

  const state = {
    cotacoes:  [],
    compras:   [],
    logistica: [],
    syncedAt:  new Date().toISOString()
  };

  if (PIPE_COTACOES) {
    console.log('📋 Buscando cotações...');
    state.cotacoes = await fetchAllCards(PIPE_COTACOES, 'Cotações');
    console.log(`  ✅ ${state.cotacoes.length} cotações\n`);
  } else {
    console.warn('  ⚠️  PIPE_COTACOES_ID não definido — pulando\n');
  }

  if (PIPE_COMPRAS) {
    console.log('🛒 Buscando compras...');
    state.compras = await fetchAllCards(PIPE_COMPRAS, 'Compras');
    console.log(`  ✅ ${state.compras.length} compras\n`);
  } else {
    console.warn('  ⚠️  PIPE_COMPRAS_ID não definido — pulando\n');
  }

  if (PIPE_LOGISTICA) {
    console.log('🚚 Buscando logística...');
    state.logistica = await fetchAllCards(PIPE_LOGISTICA, 'Logística');
    console.log(`  ✅ ${state.logistica.length} registros de logística\n`);
  } else {
    console.warn('  ⚠️  PIPE_LOGISTICA_ID não definido — pulando\n');
  }

  fs.writeFileSync('data.json', JSON.stringify(state, null, 2), 'utf-8');

  const total = state.cotacoes.length + state.compras.length + state.logistica.length;
  console.log(`✅ data.json salvo — ${total} cards no total`);
  console.log(`   Sincronizado em: ${new Date(state.syncedAt).toLocaleString('pt-BR')}`);
}

main().catch(e => {
  console.error('\n❌ Erro na sincronização:', e.message);
  process.exit(1);
});
