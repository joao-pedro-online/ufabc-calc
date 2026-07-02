/* ============================================================
   Boletim UFABC — parsing do histórico + cálculo de CR/CA/CP
   ============================================================ */

pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

const PESO = { A: 4, B: 3, C: 2, D: 1, F: 0, O: 0 };
const GRADED_SIT = ['APR', 'APRN', 'REP', 'REPF', 'REPMF', 'REPN', 'REPNF'];
const INTEGRALIZA_SIT = ['APR', 'APRN', 'DISP', 'TRANS', 'INCORP', 'CUMP'];
const SITUACAO_LIST = ['APRN','REPMF','REPNF','REPF','REPN','APR','REP','CANC','DISP','MATR','TRANC','TRANS','INCORP','CUMP','REC'];

const COLS = [
  { key: 'periodo',    x0: 0,   x1: 75  },
  { key: 'categoria',  x0: 75,  x1: 96  },
  { key: 'codigo',     x0: 96,  x1: 128 },
  { key: 'componente', x0: 128, x1: 292 },
  { key: 'creditos',   x0: 292, x1: 316 },
  { key: 'ch',         x0: 316, x1: 336 },
  { key: 'chext',      x0: 336, x1: 356 },
  { key: 'turma',      x0: 356, x1: 388 },
  { key: 'conceito',   x0: 388, x1: 421 },
  { key: 'situacao',   x0: 421, x1: 461 },
  { key: 'docente',    x0: 461, x1: 9999 },
];
const PERIODO_RE = /^\d{4}\.\d$|^--$/;
const CODIGO_RE = /^[A-Z]{2,6}\d{3,4}-\d{2}$/;

function colFor(x) {
  for (const c of COLS) if (x >= c.x0 && x < c.x1) return c.key;
  return 'docente';
}
function emptyRow() {
  const r = {};
  for (const c of COLS) r[c.key] = '';
  return r;
}
function appendCell(row, key, text) {
  const noSpace = key === 'codigo' || key === 'turma';
  if (!row[key]) { row[key] = text; return; }
  row[key] += (noSpace ? '' : ' ') + text;
}

async function extractRawRows(pdf) {
  const rows = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const items = content.items
      .map(it => ({ x: it.transform[4], y: it.transform[5], str: it.str }))
      .filter(it => it.str.trim() !== '');
    items.sort((a, b) => b.y - a.y);

    const lines = [];
    let cur = null;
    for (const it of items) {
      if (!cur || Math.abs(it.y - cur.y) > 2) { cur = { y: it.y, items: [] }; lines.push(cur); }
      cur.items.push(it);
    }
    for (const line of lines) line.items.sort((a, b) => a.x - b.x);

    const centers = [];
    for (const line of lines) {
      const periodoItem = line.items.find(it => colFor(it.x) === 'periodo');
      if (periodoItem && PERIODO_RE.test(periodoItem.str.trim())) {
        centers.push({ y: line.y, periodo: periodoItem.str.trim() });
      }
    }
    if (centers.length === 0) continue;

    const gaps = [];
    for (let i = 1; i < centers.length; i++) gaps.push(centers[i - 1].y - centers[i].y);
    const avgGap = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 30;
    const upperLimit = centers[0].y + avgGap / 2;
    const lowerLimit = centers[centers.length - 1].y - avgGap / 2;

    const boundaries = [];
    for (let i = 0; i < centers.length - 1; i++) boundaries.push((centers[i].y + centers[i + 1].y) / 2);

    const pageRows = centers.map(c => ({ row: emptyRow() }));
    pageRows.forEach((pr, i) => { pr.row.periodo = centers[i].periodo; });

    for (const line of lines) {
      if (line.y > upperLimit || line.y < lowerLimit) continue;
      let idx = 0;
      for (let i = 0; i < boundaries.length; i++) { if (line.y < boundaries[i]) idx = i + 1; else break; }
      const target = pageRows[idx].row;
      for (const it of line.items) {
        const key = colFor(it.x);
        if (key === 'periodo') continue;
        appendCell(target, key, it.str.trim());
      }
    }
    for (const pr of pageRows) rows.push(pr.row);
  }
  return rows;
}

function cleanRows(rawRows) {
  return rawRows
    .map(r => {
      const catMatch = r.categoria.match(/\b(OBR|OL|LIV)\b/);
      const sitRe = new RegExp('\\b(' + SITUACAO_LIST.join('|') + ')\\b');
      const sitMatch = r.situacao.match(sitRe);
      return {
        periodo: r.periodo,
        categoria: catMatch ? catMatch[1] : '',
        codigo: r.codigo.trim(),
        componente: r.componente.replace(/\s+/g, ' ').trim(),
        creditos: parseFloat(r.creditos) || 0,
        conceito: r.conceito.trim().replace(/^-+$/, '-'),
        situacao: sitMatch ? sitMatch[1] : r.situacao.trim(),
        simulado: false,
      };
    })
    .filter(r => CODIGO_RE.test(r.codigo) && r.componente && !isNaN(r.creditos));
}

async function parsePdf(file) {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
  const raw = await extractRawRows(pdf);
  return cleanRows(raw);
}

/* ============================================================
   Cálculo de coeficientes
   ============================================================ */

function computeCPkOficial(rows, k, req) {
  const aprovadas = rows.filter(r =>
    r.conceito in PESO && PESO[r.conceito] > 0 &&
    (INTEGRALIZA_SIT.includes(r.situacao) || r.situacao === 'MATR')
  );
  let n_obr = 0, n_lim = 0, n_livre = 0;
  for (const r of aprovadas) {
    const cat = categoriaDetalhada(r.codigo, k);
    if (cat === 'OBR_BASE' || cat === 'OBR_CURSO') n_obr += r.creditos;
    else if (cat === 'OL') n_lim += r.creditos;
    else n_livre += r.creditos;
  }
  const N_obr = req.obr_bct + req.obr_curso;
  const N_lim = req.ol;
  const N_livre = req.livre;
  const NC = N_obr + N_lim + N_livre;
  if (!NC) return null;
  const limPlusLivre = Math.min(N_lim + N_livre, n_lim + Math.min(n_livre, N_livre));
  return { CPk: (n_obr + limPlusLivre) / NC, n_obr, n_lim, n_livre, N_obr, N_lim, N_livre };
}

function computeCoefs(rows, creditosExigidos) {
  const cursadas = rows.filter(r =>
    r.conceito in PESO && (GRADED_SIT.includes(r.situacao) || r.situacao === 'MATR')
  );

  let numCR = 0, denCR = 0;
  for (const r of cursadas) { numCR += r.creditos * PESO[r.conceito]; denCR += r.creditos; }
  const CR = denCR ? numCR / denCR : null;

  const bestByCodigo = {};
  for (const r of cursadas) {
    const cur = bestByCodigo[r.codigo];
    if (!cur || PESO[r.conceito] > PESO[cur.conceito]) bestByCodigo[r.codigo] = r;
  }
  let numCA = 0, denCA = 0;
  for (const k in bestByCodigo) { const r = bestByCodigo[k]; numCA += r.creditos * PESO[r.conceito]; denCA += r.creditos; }
  const CA = denCA ? numCA / denCA : null;

  const aprovados = rows
    .filter(r =>
      INTEGRALIZA_SIT.includes(r.situacao) ||
      (r.situacao === 'MATR' && r.conceito in PESO && PESO[r.conceito] > 0)
    )
    .reduce((s, r) => s + r.creditos, 0);
  const CP = creditosExigidos ? aprovados / creditosExigidos : null;

  return { CR, CA, CP, denCR, aprovados };
}

/* ============================================================
   Estado + UI
   ============================================================ */

const state = { rows: [], disciplinas: [], cursos: {}, requisitos: {}, cursoSelecionado: null, exigidosManual: false, hideCompleted: true };

const el = id => document.getElementById(id);

async function loadCurriculo() {
  const [d, c, req] = await Promise.all([
    fetch('data/disciplinas.json?v=10').then(r => r.json()).catch(() => []),
    fetch('data/cursos.json?v=10').then(r => r.json()).catch(() => ({})),
    fetch('data/requisitos.json?v=10').then(r => r.json()).catch(() => ({})),
  ]);
  state.disciplinas = d;
  state.cursos = c;
  state.requisitos = req;
  const sel = el('cursoSelect');
  sel.innerHTML = '<option value="">— nenhum / genérico —</option>' +
    Object.entries(c).sort((a, b) => a[1].localeCompare(b[1]))
      .map(([sigla, nome]) => `<option value="${sigla}">${nome}</option>`).join('');
  sel.addEventListener('change', () => {
    state.cursoSelecionado = sel.value || null;
    aplicarExigidosDoCurso();
    render();
  });
}

function aplicarExigidosDoCurso() {
  const req = state.requisitos[state.cursoSelecionado];
  const input = el('creditosExigidos');
  const note = el('exigidosNote');
  if (!state.cursoSelecionado) return;
  if (req && !state.exigidosManual) {
    const total = req.obr_bct + req.obr_curso + req.ol + req.livre + req.complementares;
    const baseNome = baseInterdisciplinar(state.cursoSelecionado);
    input.value = total;
    note.textContent = `Obrigatórias ${baseNome} (${req.obr_bct}) + Obrigatórias do curso (${req.obr_curso}) + OL (${req.ol}) + Livres (${req.livre}) + Complementares (${req.complementares}) = ${total} créditos.`;
    return;
  }
  if (!req) {
    const auto = creditosObrigatoriosAuto(state.cursoSelecionado);
    if (!state.exigidosManual) {
      input.value = auto.obr_base + auto.obr_curso;
      note.innerHTML = `Não tenho a cota completa (OL/Livre/Complementares) pra esse curso — preenchi só as Obrigatórias, calculadas automaticamente: ${auto.base} (${auto.obr_base}) + curso (${auto.obr_curso}) = ${auto.obr_base + auto.obr_curso} créditos. <strong>Some manualmente</strong> os créditos de OL + Livre + Complementares do seu curso e edite o campo pra ficar exato.`;
    }
  }
}

function categoriaParaCurso(codigo) {
  if (!state.cursoSelecionado) return '';
  const disc = state.disciplinas.find(d => d.codigo === codigo);
  if (!disc) return '';
  return disc.cursos[state.cursoSelecionado] || 'LIV';
}

function baseInterdisciplinar(sigla) {
  let bctCount = 0, bchCount = 0;
  for (const d of state.disciplinas) {
    if (d.cursos[sigla] === 'OBR') {
      if (d.cursos['BC&T']) bctCount++;
      if (d.cursos['BC&H']) bchCount++;
    }
  }
  return bchCount > bctCount ? 'BC&H' : 'BC&T';
}

function creditosObrigatoriosAuto(sigla) {
  if (!sigla) return null;
  const base = baseInterdisciplinar(sigla);
  let baseCred = 0, curso = 0;
  for (const d of state.disciplinas) {
    if (d.cursos[base] === 'OBR') baseCred += d.creditos;
    else if (d.cursos[sigla] === 'OBR') curso += d.creditos;
  }
  return { base, obr_base: baseCred, obr_curso: curso };
}

function categoriaDetalhada(codigo, cursoOverride) {
  const curso = cursoOverride !== undefined ? cursoOverride : state.cursoSelecionado;
  const disc = state.disciplinas.find(d => d.codigo === codigo);
  if (!disc) return 'LIVRE';
  const base = curso ? baseInterdisciplinar(curso) : 'BC&T';
  if (disc.cursos[base] === 'OBR') return 'OBR_BASE';
  if (curso) {
    if (disc.cursos[curso] === 'OBR') return 'OBR_CURSO';
    if (disc.cursos[curso] === 'OL') return 'OL';
  }
  return 'LIVRE';
}

function computeProgresso() {
  const k = state.cursoSelecionado;
  const section = el('progressSection');
  if (!k) { section.hidden = true; return; }
  const req = state.requisitos[k];
  const auto = creditosObrigatoriosAuto(k);
  const base = auto.base;
  section.hidden = false;

  const completedRows = state.rows.filter(r => INTEGRALIZA_SIT.includes(r.situacao));
  let credBase = 0, credCurso = 0, credOl = 0, credOutros = 0;
  for (const r of completedRows) {
    const cat = categoriaDetalhada(r.codigo);
    if (cat === 'OBR_BASE') credBase += r.creditos;
    else if (cat === 'OBR_CURSO') credCurso += r.creditos;
    else if (cat === 'OL') credOl += r.creditos;
    else credOutros += r.creditos;
  }
  const aprovadosCodigos = new Set(completedRows.map(r => r.codigo));
  const faltamBase = state.disciplinas.filter(d => d.cursos[base] === 'OBR' && !aprovadosCodigos.has(d.codigo));
  const faltamCurso = state.disciplinas.filter(d => d.cursos[k] === 'OBR' && !aprovadosCodigos.has(d.codigo));

  const cards = [
    { title: `Obrigatórias ${base}`, feito: credBase, total: req ? req.obr_bct : auto.obr_base, faltam: faltamBase, cls: '' },
    { title: 'Obrigatórias do curso', feito: credCurso, total: req ? req.obr_curso : auto.obr_curso, faltam: faltamCurso, cls: '' },
  ];
  if (req) {
    cards.push({ title: 'Opção Limitada', feito: credOl, total: req.ol, cls: 'is-ol' });
    cards.push({ title: 'Livres', feito: credOutros, total: req.livre, cls: 'is-livre', nota: credOutros > req.livre ? 'excedente não conta a mais no CPk (a fórmula oficial trava no limite)' : '' });
  }
  el('progressGrid').innerHTML = cards.map(c => {
    const pctReal = c.total ? (c.feito / c.total) * 100 : 0;
    const pctBar = Math.min(100, pctReal);
    const faltamHtml = c.faltam ? `
      <details class="progress-faltam">
        <summary>${c.faltam.length} matéria(s) obrigatória(s) que faltam</summary>
        <ul>${c.faltam.map(d => `<li><code>${d.codigo}</code> ${d.nome} (${d.creditos} créd.)</li>`).join('')}</ul>
      </details>` : '';
    const notaHtml = c.nota ? `<div class="progress-card-detail">${c.nota}</div>` : '';
    return `
      <div class="progress-card ${c.cls}">
        <div class="progress-card-head">
          <span class="progress-card-title">${c.title}</span>
          <span class="progress-card-pct">${pctReal.toFixed(0)}%</span>
        </div>
        <div class="progress-bar-track"><div class="progress-bar-fill" style="width:${pctBar}%"></div></div>
        <div class="progress-card-detail">${c.feito} de ${c.total} créditos</div>
        ${notaHtml}
        ${faltamHtml}
      </div>`;
  }).join('');
  if (!req) {
    el('progressGrid').innerHTML += `<p class="field-note" style="grid-column:1/-1">Sem cota de OL/Livre cadastrada pra esse curso — só as Obrigatórias aparecem aqui.</p>`;
  }
}

function badge(cat) {
  if (!cat) return '<span class="badge badge-none">—</span>';
  const label = cat === 'OBR' ? 'OBR' : cat === 'OL' ? 'OL' : 'LIV';
  return `<span class="badge badge-${label}">${label}</span>`;
}

function conceitoOptions(selected) {
  return ['-', 'A', 'B', 'C', 'D', 'F', 'O'].map(v =>
    `<option value="${v}" ${v === selected ? 'selected' : ''}>${v}</option>`).join('');
}

function render() {
  const body = el('subjBody');
  body.innerHTML = '';
  const completos = new Set(
    state.rows.filter(r => INTEGRALIZA_SIT.includes(r.situacao)).map(r => r.codigo)
  );
  let hiddenN = 0;
  state.rows.forEach((r, i) => {
    const isCompleted = completos.has(r.codigo) && !r.simulado;
    if (state.hideCompleted && isCompleted) { hiddenN++; return; }
    const tr = document.createElement('tr');
    if (r.simulado) tr.className = 'simulated';
    const catMostrada = state.cursoSelecionado ? categoriaParaCurso(r.codigo) : r.categoria;
    tr.innerHTML = `
      <td class="periodo">${r.periodo}</td>
      <td>${badge(catMostrada)}</td>
      <td class="codigo">${r.codigo}</td>
      <td><input type="text" data-field="componente" value="${r.componente.replace(/"/g, '&quot;')}"></td>
      <td style="width:56px"><input type="number" data-field="creditos" value="${r.creditos}" min="0" style="width:48px"></td>
      <td><select class="conceito-select" data-field="conceito">${conceitoOptions(r.conceito)}</select></td>
      <td><input type="text" data-field="situacao" value="${r.situacao}" style="width:70px"></td>
      <td><button class="row-del" title="Remover">✕</button></td>
    `;
    tr.querySelectorAll('[data-field]').forEach(inputEl => {
      inputEl.addEventListener('input', () => {
        const field = inputEl.dataset.field;
        state.rows[i][field] = field === 'creditos' ? parseFloat(inputEl.value) || 0 : inputEl.value;
        updateCoefs();
        computeProgresso();
      });
    });
    tr.querySelector('.row-del').addEventListener('click', () => {
      state.rows.splice(i, 1);
      render();
    });
    body.appendChild(tr);
  });
  el('hiddenCount').textContent = hiddenN ? `· ${hiddenN} matéria(s) concluída(s) oculta(s)` : '';
  el('btnToggleCompleted').textContent = state.hideCompleted ? 'mostrar concluídas' : 'ocultar concluídas';
  computeProgresso();
  updateCoefs();
}

function fmt(v) { return v === null || v === undefined || isNaN(v) ? '—' : v.toFixed(4); }

function updateCoefs() {
  const exigidos = parseFloat(el('creditosExigidos').value) || null;
  const { CR, CA, denCR } = computeCoefs(state.rows, exigidos);
  let CP = null, cpFonte = '';
  const req = state.requisitos[state.cursoSelecionado];
  if (state.cursoSelecionado && req) {
    const r = computeCPkOficial(state.rows, state.cursoSelecionado, req);
    CP = r ? r.CPk : null;
    cpFonte = 'CPk oficial (Ato Decisório ConsEPE 257)';
  } else {
    const base = computeCoefs(state.rows, exigidos);
    CP = base.CP;
    cpFonte = '';
  }
  el('crValue').textContent = fmt(CR);
  el('caValue').textContent = fmt(CA);
  el('cpValue').textContent = CP === null ? '—' : CP.toFixed(4);
  el('credCursados').textContent = denCR;
  el('sealCR').textContent = CR === null ? '—' : CR.toFixed(2);
  const anyEditada = state.rows.some(r => r.simulado);
  el('crRef').textContent = anyEditada ? 'inclui simulação(ões)' : '';
  el('caRef').textContent = anyEditada ? 'inclui simulação(ões)' : '';
  el('cpRef').textContent = cpFonte || (exigidos ? '' : 'escolha um curso ao lado ou informe os créditos exigidos');
}

/* ---------------- Upload ---------------- */

function setStatus(msg, kind) {
  const s = el('uploadStatus');
  s.textContent = msg;
  s.className = 'status' + (kind ? ' ' + kind : '');
}

async function handleFile(file) {
  if (!file || file.type !== 'application/pdf') {
    setStatus('Por favor, envie um arquivo PDF do histórico escolar.', 'error');
    return;
  }
  setStatus('Lendo o histórico…');
  try {
    const rows = await parsePdf(file);
    if (rows.length === 0) {
      setStatus('Não consegui identificar matérias nesse PDF. Confira se é o Histórico Escolar exportado do SIGAA.', 'error');
      return;
    }
    state.rows = rows;
    setStatus(`${rows.length} componentes carregados com sucesso.`, 'ok');
    el('controls').hidden = false;
    el('coefGrid').hidden = false;
    el('tableSection').hidden = false;
    render();
  } catch (e) {
    console.error(e);
    setStatus('Erro ao processar o PDF: ' + e.message, 'error');
  }
}

function setupUpload() {
  const zone = el('uploadZone');
  const input = el('fileInput');
  zone.addEventListener('click', () => input.click());
  input.addEventListener('change', () => handleFile(input.files[0]));
  ['dragenter', 'dragover'].forEach(evt =>
    zone.addEventListener(evt, e => { e.preventDefault(); zone.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach(evt =>
    zone.addEventListener(evt, e => { e.preventDefault(); zone.classList.remove('dragover'); }));
  zone.addEventListener('drop', e => handleFile(e.dataTransfer.files[0]));
}

/* ---------------- Ações da tabela ---------------- */

function setupActions() {
  el('creditosExigidos').addEventListener('input', () => { state.exigidosManual = true; el('resetExigidos').style.display = 'inline'; updateCoefs(); });
  el('resetExigidos').addEventListener('click', (e) => {
    e.preventDefault();
    state.exigidosManual = false;
    el('resetExigidos').style.display = 'none';
    aplicarExigidosDoCurso();
    updateCoefs();
  });

  el('btnToggleCompleted').addEventListener('click', () => {
    state.hideCompleted = !state.hideCompleted;
    render();
  });

  el('btnAddRow').addEventListener('click', () => {
    state.rows.push({
      periodo: '', categoria: '', codigo: '', componente: 'Nova matéria',
      creditos: 4, conceito: '-', situacao: 'MATR', simulado: true,
    });
    render();
  });

  el('btnAddSim').addEventListener('click', () => openSimPicker());
  el('simClose').addEventListener('click', () => { el('simPicker').hidden = true; });

  const searchInput = el('simSearch');
  searchInput.addEventListener('input', () => renderSimResults(searchInput.value));
}

function openSimPicker() {
  el('simPicker').hidden = false;
  el('simSearch').value = '';
  el('simSearch').focus();
  renderSimResults('');
}

function renderSimResults(query) {
  const q = query.trim().toLowerCase();
  const list = state.disciplinas
    .filter(d => !q || d.nome.toLowerCase().includes(q) || d.codigo.toLowerCase().includes(q))
    .slice(0, 60);
  const box = el('simResults');
  box.innerHTML = list.map(d =>
    `<div class="sim-result-item" data-codigo="${d.codigo}">
       <div>${d.nome}</div>
       <div class="rn">${d.codigo} · ${d.creditos} créd.</div>
     </div>`).join('') || '<p style="padding:10px;color:var(--ink-soft)">Nenhuma disciplina encontrada.</p>';
  box.querySelectorAll('.sim-result-item').forEach(itEl => {
    itEl.addEventListener('click', () => {
      const disc = state.disciplinas.find(d => d.codigo === itEl.dataset.codigo);
      state.rows.push({
        periodo: 'futuro', categoria: disc.cursos[state.cursoSelecionado] || '',
        codigo: disc.codigo, componente: disc.nome, creditos: disc.creditos,
        conceito: 'A', situacao: 'MATR', simulado: true,
      });
      el('simPicker').hidden = true;
      render();
    });
  });
}

/* ---------------- Init ---------------- */

(async function init() {
  setupUpload();
  setupActions();
  await loadCurriculo();
})();
