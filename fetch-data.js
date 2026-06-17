// fetch-data.js — Busca dados do Pipefy e gera data.json
// Executado pelo GitHub Actions a cada 4h (seg-sex)
// Requer Node.js 22+ (usa fetch nativo)
//
// Sempre busca TODAS as fases (ativas + finalizadas) para garantir que
// cotações aprovadas, reprovadas e compras concluídas nunca fiquem de fora.

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
  labels { name color }
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

/**
 * Busca cards de fases do pipe.
 * @param {string}  pipeId
 * @param {string}  label      - Nome amigável para logs
 * @param {boolean} allPhases  - true = inclui fases done; false = só fases ativas
 */
async function fetchPipeCards(pipeId, label, allPhases = false) {
  const pipeData = await pipefyGQL(`
    query($id: ID!) {
      pipe(id: $id) {
        phases {
          id name done cards_count
        }
      }
    }`, { id: pipeId });

  const phases = pipeData.pipe.phases.filter(p => {
    if (p.cards_count === 0) return false;
    return allPhases ? true : !p.done;
  });

  if (phases.length === 0) {
    console.log(`  ${label} — nenhuma fase ${allPhases ? '' : 'ativa '}com cards.`);
    return [];
  }

  const modeLabel = allPhases ? 'todas' : 'apenas ativas';
  console.log(`  ${label} — ${phases.length} fase(s) (${modeLabel}): ${phases.map(p => p.name + (p.done ? ' [done]' : '')).join(', ')}`);

  const cards = [];
  for (const phase of phases) {
    let cursor = null;
    let page = 1;
    do {
      process.stdout.write(`  ${label} / ${phase.name} — pág. ${page++}...\r`);
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
    process.stdout.write('\n');
  }

  return cards;
}

/**
 * Mescla cards frescos da API com o data.json existente.
 *
 * CORREÇÃO v2: preserva TODOS os cards que não estão na lista de frescos,
 * independente de finished_at. O bug anterior filtrava c.finished_at !== null,
 * descartando cards que transitaram de ativo→finalizado entre dois syncs
 * (no cache ainda tinham finished_at=null mesmo já estando em fase done).
 */
function mergeCards(freshCards, existingCards) {
  const freshIds = new Set(freshCards.map(c => String(c.id)));
  const preserved = (existingCards || []).filter(c => !freshIds.has(String(c.id)));
  return [...freshCards, ...preserved];
}

async function main() {
  console.log(`🔄 Sincronizando com Pipefy — todas as fases (ativas + finalizadas)\n`);

  const state = {
    cotacoes:  [],
    compras:   [],
    logistica: [],
    syncedAt:  new Date().toISOString()
  };

  if (PIPE_COTACOES) {
    console.log('📋 Buscando cotações (todas as fases)...');
    state.cotacoes = await fetchPipeCards(PIPE_COTACOES, 'Cotações', true);
    console.log(`  ✅ ${state.cotacoes.length} cards total\n`);
  } else {
    console.warn('  ⚠️  PIPE_COTACOES_ID não definido — pulando\n');
  }

  if (PIPE_COMPRAS) {
    console.log('🛒 Buscando compras (todas as fases)...');
    state.compras = await fetchPipeCards(PIPE_COMPRAS, 'Compras', true);
    console.log(`  ✅ ${state.compras.length} cards total\n`);
  } else {
    console.warn('  ⚠️  PIPE_COMPRAS_ID não definido — pulando\n');
  }

  if (PIPE_LOGISTICA) {
    console.log('🚚 Buscando logística (todas as fases)...');
    state.logistica = await fetchPipeCards(PIPE_LOGISTICA, 'Logística', true);
    console.log(`  ✅ ${state.logistica.length} cards total\n`);
  } else {
    console.warn('  ⚠️  PIPE_LOGISTICA_ID não definido — pulando\n');
  }

  fs.writeFileSync('data.json', JSON.stringify(state, null, 2), 'utf-8');

  const allCards    = [...state.cotacoes, ...state.compras, ...state.logistica];
  const totalActive = allCards.filter(c => !c.finished_at).length;
  const totalDone   = allCards.filter(c =>  c.finished_at).length;

  console.log(`✅ data.json salvo — ${totalActive} ativos + ${totalDone} finalizados = ${allCards.length} cards`);
  console.log(`   Sincronizado em: ${new Date(state.syncedAt).toLocaleString('pt-BR')}`);
}

main().catch(e => {
  console.error('\n❌ Erro na sincronização:', e.message);
  process.exit(1);
});
