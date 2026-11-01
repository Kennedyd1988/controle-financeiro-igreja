// Módulo "Agendas semanais" do SOFT+ Financeiro de Igrejas.
//
// Fica num arquivo próprio (e não dentro do app.js) porque é um módulo grande e
// quase independente do financeiro. Recebe do app.js, por `iniciarAgendas`, o
// que precisa (banco, estado, utilitários) — assim não duplicamos login nem
// permissões.
//
// Estrutura de dados (por igreja, em subcoleções — nunca misturado em coleção global):
//   cultosPadrao/{id}      nome, ícone (base64 pequeno), horário, dia, funções, entra na semana modelo
//   agendas/{AAAA-MM-DD}   UMA semana por documento (id = segunda-feira): 1 leitura por semana
//   participacoes/{...}    índice plano de "quem participou de quê" para o rodízio (campo
//                          composto funcaoData = "funcao|AAAA-MM-DD" → um único filtro de intervalo)
//   lembretes/{id}         calendário de datas a lembrar
//   mensagens/{id}         central de mensagens do WhatsApp (campo `fila` = "p|data" pendente / "e|data" enviada)
//   configAgenda/modelos   textos-modelo das mensagens
import {
  collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc,
  query, where, orderBy, limit, startAfter, writeBatch
} from "https://www.gstatic.com/firebasejs/10.14.0/firebase-firestore.js";
import { desenharAgendaPdf } from "./agenda-pdf.js?v=16";

// ---------- constantes ----------
export const FUNCOES_PADRAO = [
  { id:'direcao', label:'Direção' }, { id:'leitura', label:'Leitura' }, { id:'pregacao', label:'Pregação' },
  { id:'louvor', label:'Louvor' }, { id:'porteiro', label:'Porteiro' },
];
const DIAS = ['SEG','TER','QUA','QUI','SEX','SAB','DOM'];
const DIAS_LONGO = ['segunda-feira','terça-feira','quarta-feira','quinta-feira','sexta-feira','sábado','domingo'];
const MESES_LONGO = ['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
const MESES_CURTO = ['JAN','FEV','MAR','ABR','MAI','JUN','JUL','AGO','SET','OUT','NOV','DEZ'];
const MODELOS_PADRAO = {
  escala: 'Paz do Senhor, {nome}! Você está escalado(a) para *{funcao}* no *{culto}* ({dia}, {data} às {horario}).{equipe}\n\nQualquer imprevisto, avise com antecedência. Deus abençoe! — {igreja}',
  lembrete: 'Paz do Senhor, {nome}! Lembrete: hoje você participa como *{funcao}* no *{culto}* às {horario}.{equipe}\n\nDeus abençoe! — {igreja}',
  troca_saiu: 'Paz do Senhor, {nome}! Houve uma alteração na escala: você não está mais como *{funcao}* no *{culto}* de {dia}, {data}. Obrigado pela disposição! — {igreja}',
  troca_entrou: 'Paz do Senhor, {nome}! Houve uma alteração na escala e você foi escalado(a) como *{funcao}* no *{culto}* ({dia}, {data} às {horario}).{equipe}\n\nDeus abençoe! — {igreja}',
};
const ROTULO_TIPO_MSG = { escala:'Escala', lembrete:'Lembrete', troca_saiu:'Troca (saiu)', troca_entrou:'Troca (entrou)' };

// ---------- contexto injetado pelo app.js ----------
let C = null;
const S = {
  sub: 'semana', semanaIni: null, agenda: null, original: null, sujo: false,
  cultos: [], baseCarregada: false, modelos: null, pool: null, hist: {},
  lembretes: null, msgAba: 'pendentes', msgPag: [], msgCursor: null, msgTemMais: false,
  editandoCultoId: null, cultoIconePendente: undefined, editandoLembId: null, editandoMsgId: null,
};

// ---------- utilitários ----------
const $ = (id)=> document.getElementById(id);
const h = (s)=> String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const uid = ()=> Math.random().toString(36).slice(2,9);
const clone = (o)=> JSON.parse(JSON.stringify(o));
const slug = (t)=> C.normalizarTexto(t||'').replace(/[^a-z0-9]/g,'');
const col = (nome)=> collection(C.db, 'igrejas', C.state.igrejaAtualId, nome);
const docRef = (nome, id)=> doc(C.db, 'igrejas', C.state.igrejaAtualId, nome, id);
const hojeISO = ()=> C.dataLocalISO(new Date());
function parseISO(s){ const [a,m,d] = s.split('-').map(Number); return new Date(a, m-1, d); }
function addDias(iso, n){ const d = parseISO(iso); d.setDate(d.getDate()+n); return C.dataLocalISO(d); }
function segundaDe(iso){ const d = parseISO(iso); const wd = (d.getDay()+6)%7; d.setDate(d.getDate()-wd); return C.dataLocalISO(d); }
const dm = (iso)=> { const [, m, d] = iso.split('-'); return `${d}/${m}`; };
const dmy = (iso)=> { const [a, m, d] = iso.split('-'); return `${d}/${m}/${a}`; };
function tituloSemana(ini){
  const a = parseISO(ini), b = parseISO(addDias(ini,6));
  const da = String(a.getDate()).padStart(2,'0'), db_ = String(b.getDate()).padStart(2,'0');
  if(a.getMonth() === b.getMonth()) return `${da} a ${db_} de ${MESES_LONGO[b.getMonth()]} de ${b.getFullYear()}`;
  if(a.getFullYear() === b.getFullYear()) return `${da} de ${MESES_CURTO[a.getMonth()]} a ${db_} de ${MESES_CURTO[b.getMonth()]} de ${b.getFullYear()}`;
  return `${da} de ${MESES_CURTO[a.getMonth()]} de ${a.getFullYear()} a ${db_} de ${MESES_CURTO[b.getMonth()]} de ${b.getFullYear()}`;
}
function podeEditar(){ return C.podeEditarAba('agendas'); }
function bloqueada(){ return S.agenda?.status === 'publicada'; }
function marcarSujo(){ S.sujo = true; const b = $('agBtnSalvar'); if(b) b.classList.add('ag-pulso'); }

function novaAgendaVazia(ini){
  return { semanaIni: ini, status: 'rascunho', dias: DIAS.map((_,i)=>({ data: addDias(ini,i), linhas: [] })), porteiros: [], pastoral: [] };
}
function funcoesDe(labels){ return labels.map(l => ({ key: slug(l), label: l, pessoa: null })); }
function novaLinha(tipo='culto'){
  return { id: uid(), tipo, horario:'', cultoId:'', titulo:'', obs:'', texto:'', funcoes: tipo === 'culto' ? funcoesDe(['Direção','Leitura','Pregação']) : [] };
}
function aplicarCulto(l, culto){
  l.cultoId = culto.id; l.titulo = culto.nome;
  if(!l.horario) l.horario = culto.horario || '';
  if(!l.obs && culto.obsPadrao) l.obs = culto.obsPadrao;
  if(l.tipo === 'culto'){
    const antigas = new Map((l.funcoes||[]).map(f => [f.key, f.pessoa]));
    l.funcoes = (culto.funcoes && culto.funcoes.length ? culto.funcoes : ['Direção','Leitura','Pregação'])
      .map(lb => ({ key: slug(lb), label: lb, pessoa: antigas.get(slug(lb)) || null }));
  }
}
const cultoPorId = (id)=> S.cultos.find(c => c.id === id);
function ordenarLinhas(dia){
  dia.linhas.sort((a,b)=> (a.horario||'99:99').localeCompare(b.horario||'99:99'));
}

// ---------- imagem em PNG (ícones de culto, com transparência) ----------
function reduzirImagemPng(file, max = 96){
  return new Promise((resolve, reject)=>{
    if(!file.type.startsWith('image/')){ reject(new Error('Selecione um arquivo de imagem.')); return; }
    const r = new FileReader();
    r.onload = (e)=>{
      const img = new Image();
      img.onload = ()=>{
        let w = img.width, hh = img.height;
        const f = Math.min(1, max / Math.max(w, hh)); w = Math.round(w*f); hh = Math.round(hh*f);
        const cv = document.createElement('canvas'); cv.width = w; cv.height = hh;
        cv.getContext('2d').drawImage(img, 0, 0, w, hh);
        resolve(cv.toDataURL('image/png'));
      };
      img.onerror = ()=> reject(new Error('Não foi possível ler a imagem.'));
      img.src = e.target.result;
    };
    r.onerror = ()=> reject(new Error('Não foi possível ler o arquivo.'));
    r.readAsDataURL(file);
  });
}

// ---------- carga inicial por igreja ----------
async function carregarBase(){
  if(S.baseCarregada) return;
  const [cs, md] = await Promise.all([
    getDocs(col('cultosPadrao')).catch(()=>({ docs: [] })),
    getDoc(docRef('configAgenda','modelos')).catch(()=>null),
  ]);
  S.cultos = C.ordenarPorNome(cs.docs.map(d => ({ id:d.id, ...d.data() })));
  S.modelos = { ...MODELOS_PADRAO, ...((md && md.exists && md.exists()) ? md.data() : {}) };
  S.baseCarregada = true;
}
async function carregarPool(){
  if(S.pool) return S.pool;
  // Só quem participa da programação é baixado (não a lista inteira de fiéis).
  const snaps = await getDocs(query(col('membros'), where('participaProg','==',true)));
  S.pool = snaps.docs.map(d => { const x = d.data(); return {
    id: d.id, nome: x.nome || '', nomeProg: x.nomeProg || '', exibe: x.nomeProg || x.nome || '',
    tel: x.telefone || '', funcoes: Array.isArray(x.funcoesProg) ? x.funcoesProg : [] }; });
  S.pool.sort((a,b)=> C.normalizarTexto(a.exibe).localeCompare(C.normalizarTexto(b.exibe)));
  return S.pool;
}
export function resetarAgendas(){
  Object.assign(S, { semanaIni:null, agenda:null, original:null, sujo:false, cultos:[], baseCarregada:false, modelos:null,
    pool:null, hist:{}, lembretes:null, msgPag:[], msgCursor:null, msgTemMais:false });
}

// ---------- estilos e esqueleto ----------
function injetarEstilos(){
  const st = document.createElement('style');
  st.textContent = `
  .ag-tabs{display:flex; gap:6px; flex-wrap:wrap; margin-bottom:14px;}
  .ag-tab{padding:7px 14px; border-radius:99px; border:1px solid var(--line); background:var(--surface); cursor:pointer; font-size:13px; color:var(--text-dim);}
  .ag-tab.active{background:var(--brand-dim); color:var(--brand); border-color:var(--brand); font-weight:600;}
  .ag-bar{display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:10px;}
  .ag-bar .ag-titulo{font-weight:600; font-size:15px; min-width:210px; text-align:center;}
  .ag-status{font-size:11.5px; padding:2px 9px; border-radius:99px; font-weight:600;}
  .ag-status.rascunho{background:#fff3e0; color:#b26a00;} .ag-status.publicada{background:var(--green-dim); color:var(--green);}
  .ag-acoes{display:flex; gap:6px; flex-wrap:wrap; margin-bottom:12px;}
  .ag-aviso{background:#fff8e1; border:1px solid #ffe0a3; color:#8a5a00; border-radius:8px; padding:8px 12px; font-size:12.5px; margin-bottom:10px;}
  .ag-dia{border:1px solid var(--line); border-left:4px solid var(--brand); border-radius:10px; background:var(--surface); padding:10px 12px; margin-bottom:10px;}
  .ag-dia-head{display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:8px;}
  .ag-dia-head b{font-size:14px;} .ag-dia-head .ag-data{color:#e07b00; font-weight:700;}
  .ag-dia-head .ag-sp{flex:1;}
  .ag-linha{border:1px solid var(--line); border-radius:8px; padding:8px; margin-bottom:8px; background:var(--surface-2, #fafafa);}
  .ag-linha-top{display:grid; grid-template-columns:auto 90px 1fr 1fr; gap:6px; align-items:center; margin-bottom:6px;}
  #view-agendas input:not([type=checkbox]):not([type=file]):not([type=color]), #view-agendas select, .modal-backdrop textarea, #agModalPick input:not([type=checkbox]){
    width:100%; padding:7px 9px; border:1px solid var(--line); border-radius:8px; background:var(--surface); color:var(--text); font-size:13px;}
  #agModalPick input, #agModalPick select, #agModalDup input, #agModalGM input{width:100%; padding:7px 9px; border:1px solid var(--line); border-radius:8px;}
  #agModalPick input[type=checkbox], #agModalDup input[type=checkbox], #agModalGM input[type=checkbox]{width:16px;}
  #view-agendas input:focus, #view-agendas select:focus{outline:2px solid var(--brand-dim); border-color:var(--brand);}
  #agIrData{width:auto !important;}
  .ag-ico{width:26px; height:26px; object-fit:contain; border-radius:4px;}
  .ag-slots{display:flex; flex-wrap:wrap; gap:6px; margin-top:6px;}
  .ag-slot{border:1px dashed var(--line); border-radius:8px; padding:5px 9px; font-size:12.5px; cursor:pointer; background:var(--surface); min-width:150px;}
  .ag-slot small{display:block; color:var(--text-dim); font-size:11px;}
  .ag-slot.cheio{border-style:solid; border-color:var(--brand);}
  .ag-slot.conflito{border-color:#e0a000; background:#fff8e1;}
  .ag-sec-titulo{font-weight:600; margin:14px 0 6px;}
  .ag-linha-info{display:grid; grid-template-columns:90px 1fr auto; gap:6px; margin-bottom:6px; align-items:center;}
  .ag-picker-item{display:flex; justify-content:space-between; gap:10px; padding:8px 10px; border:1px solid var(--line); border-radius:8px; margin-bottom:6px; cursor:pointer;}
  .ag-picker-item:hover{border-color:var(--brand); background:var(--brand-dim);}
  .ag-picker-item small{display:block; color:var(--text-dim); font-size:11.5px;}
  .ag-badge{font-size:11px; padding:1px 8px; border-radius:99px; white-space:nowrap; height:fit-content;}
  .ag-badge.novo{background:var(--green-dim); color:var(--green);} .ag-badge.feito{background:#eee; color:#666;}
  .ag-pulso{box-shadow:0 0 0 3px rgba(224,123,0,.35);}
  .ag-msg{border:1px solid var(--line); border-radius:8px; padding:9px 11px; margin-bottom:8px; background:var(--surface);}
  .ag-msg-top{display:flex; justify-content:space-between; gap:8px; flex-wrap:wrap; align-items:center;}
  .ag-msg pre{white-space:pre-wrap; font-family:inherit; font-size:12.5px; color:var(--text-dim); margin:6px 0;}
  .ag-grade-icones{display:flex; gap:8px; align-items:center;}
  @media (max-width:640px){ .ag-linha-top{grid-template-columns:auto 80px 1fr;} .ag-linha-top > :nth-child(4){grid-column:1 / -1;} .ag-bar .ag-titulo{min-width:0; width:100%; order:-1;} }
  `;
  document.head.appendChild(st);
}
function montarEsqueleto(){
  const v = $('view-agendas');
  v.innerHTML = `
    <div class="view-header"><div><div class="view-title">Agendas semanais</div>
      <div class="view-desc">Programação da semana, escalas, lembretes e mensagens</div></div></div>
    <div class="ag-tabs" id="agTabs">
      <button class="ag-tab active" data-sub="semana">Semana</button>
      <button class="ag-tab" data-sub="cultos">Cultos padrão</button>
      <button class="ag-tab" data-sub="lembretes">Lembretes</button>
      <button class="ag-tab" data-sub="mensagens">Mensagens</button>
    </div>
    <div id="agConteudo"></div>`;
  $('agTabs').addEventListener('click', (e)=>{
    const b = e.target.closest('[data-sub]'); if(!b) return;
    if(S.sujo && S.sub === 'semana' && !confirm('Há alterações não salvas nesta semana. Sair mesmo assim?')) return;
    S.sub = b.dataset.sub; renderSub();
  });
}

// ---------- entrada pública ----------
export function iniciarAgendas(ctx){
  C = ctx;
  injetarEstilos();
  montarEsqueleto();
  montarModais();
}
export async function renderAgendas(){
  if(!C.temAcesso('agendas')){ $('agConteudo').innerHTML = '<div class="empty">Você não tem acesso às agendas.</div>'; return; }
  await carregarBase();
  renderSub();
}
function renderSub(){
  document.querySelectorAll('#agTabs .ag-tab').forEach(b => b.classList.toggle('active', b.dataset.sub === S.sub));
  if(S.sub === 'semana') return comCarga(renderSemanaTela());
  if(S.sub === 'cultos') return renderCultos();
  if(S.sub === 'lembretes') return comCarga(renderLembretes());
  if(S.sub === 'mensagens') return comCarga(renderMensagens(true));
}
const comCarga = (p)=> C.comCarregando(p);
export function abrirAgendas(sub){ S.sub = sub || 'semana'; C.switchView('agendas'); }

// ======================================================================
// SEMANA
// ======================================================================
async function carregarSemana(ini){
  const snap = await getDoc(docRef('agendas', ini));
  let ag;
  if(snap.exists()){
    ag = snap.data();
    // Garante os 7 dias mesmo se o documento for antigo/incompleto.
    ag.dias = DIAS.map((_,i)=> (ag.dias||[])[i] || { data: addDias(ini,i), linhas: [] });
    ag.porteiros = ag.porteiros || []; ag.pastoral = ag.pastoral || [];
  } else ag = novaAgendaVazia(ini);
  S.semanaIni = ini; S.agenda = ag; S.original = clone(ag); S.sujo = false;
}
async function renderSemanaTela(){
  if(!S.semanaIni) S.semanaIni = segundaDe(hojeISO());
  await carregarSemana(S.semanaIni);
  desenharSemana();
}
function resumoConflitos(ag){
  const mapa = new Map();
  const add = (pessoa, rotulo)=>{
    if(!pessoa || !pessoa.nome) return;
    const k = pessoa.membroId || ('n:' + C.normalizarTexto(pessoa.nome));
    if(!mapa.has(k)) mapa.set(k, { nome: pessoa.nome, itens: [] });
    mapa.get(k).itens.push(rotulo);
  };
  ag.dias.forEach((d,i)=> d.linhas.forEach(l => (l.funcoes||[]).forEach(f => add(f.pessoa, `${DIAS[i]} ${f.label}`))));
  (ag.porteiros||[]).forEach(p => add(p.pessoa, `${DIAS[p.dia]} Porteiro`));
  return mapa;
}
function slotConflita(ag, pessoa, ignorarId){
  if(!pessoa || !pessoa.nome) return false;
  const k = pessoa.membroId || ('n:' + C.normalizarTexto(pessoa.nome));
  let n = 0;
  const conta = (p, id)=>{ if(id === ignorarId || !p || !p.nome) return; const kk = p.membroId || ('n:' + C.normalizarTexto(p.nome)); if(kk === k) n++; };
  ag.dias.forEach(d => d.linhas.forEach(l => (l.funcoes||[]).forEach(f => conta(f.pessoa, l.id+'__'+f.key))));
  (ag.porteiros||[]).forEach(p => conta(p.pessoa, p.id+'__porteiro'));
  return n > 0;
}

function htmlLinha(l, di){
  const ed = podeEditar() && !bloqueada();
  const dis = ed ? '' : 'disabled';
  const culto = cultoPorId(l.cultoId);
  const ico = culto?.icone ? `<img class="ag-ico" src="${culto.icone}" alt="">` : '<span style="width:26px"></span>';
  const opcCultos = '<option value="">— atividade livre —</option>' + S.cultos.map(c => `<option value="${c.id}" ${c.id===l.cultoId?'selected':''}>${h(c.nome)}</option>`).join('');
  let corpo = '';
  if(l.tipo === 'culto'){
    const slots = (l.funcoes||[]).map(f=>{
      const conf = slotConflita(S.agenda, f.pessoa, l.id+'__'+f.key);
      return `<div class="ag-slot ${f.pessoa?.nome ? 'cheio':''} ${conf?'conflito':''}" data-act="pick" data-d="${di}" data-l="${l.id}" data-k="${f.key}">
        <small>${h(f.label)}${conf ? ' · ⚠ repetido na semana' : ''}</small>${f.pessoa?.nome ? h(f.pessoa.nome) : '<span style="color:var(--text-dim)">escolher…</span>'}
        ${f.pessoa?.nome && ed ? `<a href="#" data-act="limpaslot" data-d="${di}" data-l="${l.id}" data-k="${f.key}" style="float:right; margin-left:8px;" title="Remover">✕</a>` : ''}</div>`;
    }).join('');
    corpo = `<div class="ag-slots">${slots}</div>
      <div style="margin-top:6px;"><label style="font-size:11.5px; color:var(--text-dim);">Funções do culto (separadas por vírgula)</label>
      <input data-f="funcoesTxt" data-d="${di}" data-l="${l.id}" value="${h((l.funcoes||[]).map(f=>f.label).join(', '))}" ${dis}></div>`;
  } else {
    corpo = `<input data-f="texto" data-d="${di}" data-l="${l.id}" value="${h(l.texto)}" placeholder="${l.tipo==='aviso' ? 'Ex: Não haverá culto — linha inteira' : 'Ex: Coordenação da professora Renata'}" ${dis}>`;
  }
  return `<div class="ag-linha">
    <div class="ag-linha-top">
      ${ico}
      <input type="time" data-f="horario" data-d="${di}" data-l="${l.id}" value="${h(l.horario)}" ${dis}>
      <input data-f="titulo" data-d="${di}" data-l="${l.id}" value="${h(l.titulo)}" placeholder="${l.tipo==='aviso' ? 'Título (opcional)' : 'Nome da atividade/culto'}" ${dis}>
      <div style="display:flex; gap:6px;">
        <select data-f="tipo" data-d="${di}" data-l="${l.id}" ${dis}>
          <option value="culto" ${l.tipo==='culto'?'selected':''}>Culto com funções</option>
          <option value="texto" ${l.tipo==='texto'?'selected':''}>Atividade com texto</option>
          <option value="aviso" ${l.tipo==='aviso'?'selected':''}>Aviso (linha inteira)</option>
        </select>
        ${l.tipo !== 'aviso' ? `<select data-f="cultoId" data-d="${di}" data-l="${l.id}" ${dis}>${opcCultos}</select>` : ''}
        ${ed ? `<button class="btn btn-sm btn-danger" data-act="dellinha" data-d="${di}" data-l="${l.id}" title="Remover linha">✕</button>` : ''}
      </div>
    </div>
    ${l.tipo !== 'aviso' ? `<input data-f="obs" data-d="${di}" data-l="${l.id}" value="${h(l.obs)}" placeholder="Observação (aparece em laranja abaixo do nome)" style="margin-bottom:6px;" ${dis}>` : ''}
    ${corpo}
  </div>`;
}

function desenharSemana(){
  const ag = S.agenda, ed = podeEditar();
  const ehBloq = bloqueada();
  const conflitos = [...resumoConflitos(ag).values()].filter(x => x.itens.length > 1);
  const hoje = hojeISO();
  const diasHtml = ag.dias.map((d,i)=>{
    ordenarLinhas(d);
    return `<div class="ag-dia">
      <div class="ag-dia-head"><b>${DIAS[i]}</b><span class="ag-data">${dm(d.data)}</span>${d.data===hoje?'<span class="tag" style="background:var(--brand-dim);color:var(--brand)">hoje</span>':''}<span class="ag-sp"></span>
        ${ed && !ehBloq ? `<button class="btn btn-sm" data-act="addlinha" data-d="${i}">+ Atividade</button>
        <button class="btn btn-sm" data-act="dupdia" data-d="${i}">Duplicar dia…</button>
        <button class="btn btn-sm" data-act="limpadia" data-d="${i}">Limpar</button>` : ''}</div>
      ${d.linhas.length ? d.linhas.map(l => htmlLinha(l, i)).join('') : '<div class="abas-hint">Sem programação — sai em branco no PDF.</div>'}
    </div>`;
  }).join('');
  const optDias = (sel)=> DIAS.map((x,i)=>`<option value="${i}" ${i===sel?'selected':''}>${x} ${dm(ag.dias[i].data)}</option>`).join('');
  const dis = (ed && !ehBloq) ? '' : 'disabled';
  const portHtml = (ag.porteiros||[]).map((p,idx)=>`<div class="ag-linha-info">
      <select data-f="portDia" data-i="${idx}" ${dis}>${optDias(p.dia)}</select>
      <div class="ag-slot ${p.pessoa?.nome?'cheio':''} ${slotConflita(ag,p.pessoa,p.id+'__porteiro')?'conflito':''}" data-act="pickport" data-i="${idx}" style="min-width:0;">${p.pessoa?.nome ? h(p.pessoa.nome) : '<span style="color:var(--text-dim)">escolher porteiro…</span>'}</div>
      ${ed && !ehBloq ? `<button class="btn btn-sm btn-danger" data-act="delport" data-i="${idx}">✕</button>` : '<span></span>'}</div>`).join('');
  const pastHtml = (ag.pastoral||[]).map((p,idx)=>`<div class="ag-linha-info">
      <select data-f="pastDia" data-i="${idx}" ${dis}>${optDias(p.dia)}</select>
      <input data-f="pastTxt" data-i="${idx}" value="${h(p.texto)}" placeholder="Ex: Pregar no Culto de Missões em Itaú/RN" ${dis}>
      ${ed && !ehBloq ? `<button class="btn btn-sm btn-danger" data-act="delpast" data-i="${idx}">✕</button>` : '<span></span>'}</div>`).join('');

  $('agConteudo').innerHTML = `
    <div class="ag-bar">
      <button class="btn btn-sm" id="agPrev">‹</button>
      <div class="ag-titulo">${tituloSemana(S.semanaIni)}</div>
      <button class="btn btn-sm" id="agNext">›</button>
      <input type="date" id="agIrData" value="${S.semanaIni}" style="width:auto;">
      <span class="ag-status ${ag.status||'rascunho'}">${ag.status === 'publicada' ? 'Publicada' : 'Rascunho'}</span>
    </div>
    <div class="ag-acoes">
      ${ed ? `<button class="btn btn-primary" id="agBtnSalvar">Salvar semana</button>` : ''}
      <button class="btn" id="agBtnPdf">Gerar PDF</button>
      ${ed ? `<button class="btn" id="agBtnPublicar">${ehBloq ? 'Reabrir para edição' : 'Marcar como publicada'}</button>` : ''}
      ${ed && !ehBloq ? `<button class="btn" id="agBtnModelo">Aplicar semana modelo</button>
      <button class="btn" id="agBtnCopiarAnt">Copiar da semana anterior</button>` : ''}
      ${ed ? `<button class="btn" id="agBtnDupSemana">Duplicar semana…</button>` : ''}
      ${ed ? `<button class="btn" id="agBtnMsgs">Gerar mensagens da semana…</button>` : ''}
    </div>
    ${ehBloq ? '<div class="ag-aviso">Agenda publicada: está travada contra edição. Use "Reabrir para edição" para alterar.</div>' : ''}
    ${conflitos.length ? `<div class="ag-aviso"><b>Atenção — participação repetida na semana</b> (apenas um aviso):<br>${conflitos.map(c => `${h(c.nome)}: ${c.itens.map(h).join(', ')}`).join('<br>')}</div>` : ''}
    <div id="agDias">${diasHtml}</div>
    <div class="card">
      <div class="ag-sec-titulo" style="margin-top:0;">Informações adicionais</div>
      <div class="grid grid-2">
        <div><div style="font-weight:600; margin-bottom:6px;">Porteiros da semana</div>${portHtml || '<div class="abas-hint">Nenhum porteiro.</div>'}
          ${ed && !ehBloq ? '<button class="btn btn-sm" data-act="addport">+ Porteiro</button>' : ''}</div>
        <div><div style="font-weight:600; margin-bottom:6px;">Agenda pastoral</div>${pastHtml || '<div class="abas-hint">Nenhum compromisso.</div>'}
          ${ed && !ehBloq ? '<button class="btn btn-sm" data-act="addpast">+ Compromisso</button> <button class="btn btn-sm" data-act="implemb">Importar lembretes da semana</button>' : ''}</div>
      </div>
    </div>`;
  ligarEventosSemana();
}

function ligarEventosSemana(){
  $('agPrev').onclick = ()=> irSemana(addDias(S.semanaIni,-7));
  $('agNext').onclick = ()=> irSemana(addDias(S.semanaIni,7));
  $('agIrData').onchange = (e)=> { if(e.target.value) irSemana(segundaDe(e.target.value)); };
  $('agBtnPdf').onclick = gerarPdf;
  if($('agBtnSalvar')) $('agBtnSalvar').onclick = ()=> comCarga(salvarSemana());
  if($('agBtnPublicar')) $('agBtnPublicar').onclick = async ()=>{
    S.agenda.status = bloqueada() ? 'rascunho' : 'publicada';
    await comCarga(salvarSemana()); desenharSemana();
  };
  if($('agBtnModelo')) $('agBtnModelo').onclick = aplicarSemanaModelo;
  if($('agBtnCopiarAnt')) $('agBtnCopiarAnt').onclick = ()=> abrirDuplicar({ modo:'semana', origem: addDias(S.semanaIni,-7), destino: S.semanaIni, fixo:true });
  if($('agBtnDupSemana')) $('agBtnDupSemana').onclick = ()=> abrirDuplicar({ modo:'semana', origem: S.semanaIni, destino: addDias(S.semanaIni,7) });
  if($('agBtnMsgs')) $('agBtnMsgs').onclick = abrirGerarMensagens;

  const cont = $('agConteudo');
  cont.onclick = (e)=>{
    const a = e.target.closest('[data-act]'); if(!a) return;
    if(a.tagName === 'A') e.preventDefault();
    const act = a.dataset.act, di = +a.dataset.d, id = a.dataset.l, key = a.dataset.k, idx = +a.dataset.i;
    if(!podeEditar() || bloqueada()) return;
    const dia = S.agenda.dias[di];
    const linha = dia?.linhas.find(x => x.id === id);
    if(act === 'addlinha'){ dia.linhas.push(novaLinha('culto')); marcarSujo(); desenharSemana(); }
    else if(act === 'dellinha'){ dia.linhas = dia.linhas.filter(x => x.id !== id); marcarSujo(); desenharSemana(); }
    else if(act === 'limpadia'){ if(confirm('Remover todas as atividades deste dia?')){ dia.linhas = []; marcarSujo(); desenharSemana(); } }
    else if(act === 'dupdia') abrirDuplicar({ modo:'dia', origem: di });
    else if(act === 'limpaslot'){ e.stopPropagation(); linha.funcoes.find(f=>f.key===key).pessoa = null; marcarSujo(); desenharSemana(); }
    else if(act === 'pick'){
      const f = linha.funcoes.find(x => x.key === key);
      abrirPicker({ funcKey: key, funcLabel: f.label, cultoId: linha.cultoId, contexto: `${linha.titulo || 'Atividade'} · ${DIAS[di]} ${dm(dia.data)}`,
        slotId: id+'__'+key, atual: f.pessoa, onEscolher: (p)=>{ f.pessoa = p; marcarSujo(); desenharSemana(); } });
    }
    else if(act === 'addport'){ S.agenda.porteiros.push({ id: uid(), dia: 0, pessoa: null }); marcarSujo(); desenharSemana(); }
    else if(act === 'delport'){ S.agenda.porteiros.splice(idx,1); marcarSujo(); desenharSemana(); }
    else if(act === 'pickport'){
      const p = S.agenda.porteiros[idx];
      abrirPicker({ funcKey:'porteiro', funcLabel:'Porteiro', cultoId:'', contexto:`Porteiros · ${DIAS[p.dia]} ${dm(S.agenda.dias[p.dia].data)}`,
        slotId: p.id+'__porteiro', atual: p.pessoa, onEscolher: (pe)=>{ p.pessoa = pe; marcarSujo(); desenharSemana(); } });
    }
    else if(act === 'addpast'){ S.agenda.pastoral.push({ id: uid(), dia: 0, texto:'' }); marcarSujo(); desenharSemana(); }
    else if(act === 'delpast'){ S.agenda.pastoral.splice(idx,1); marcarSujo(); desenharSemana(); }
    else if(act === 'implemb') importarLembretesDaSemana();
  };
  cont.oninput = (e)=>{
    const el = e.target; const f = el.dataset.f; if(!f || bloqueada()) return;
    const di = +el.dataset.d, id = el.dataset.l, idx = +el.dataset.i;
    const linha = S.agenda.dias[di]?.linhas.find(x => x.id === id);
    if(f === 'titulo') linha.titulo = el.value;
    else if(f === 'obs') linha.obs = el.value;
    else if(f === 'texto') linha.texto = el.value;
    else if(f === 'pastTxt') S.agenda.pastoral[idx].texto = el.value;
    else return;
    marcarSujo();
  };
  cont.onchange = (e)=>{
    const el = e.target; const f = el.dataset.f; if(!f || bloqueada()) return;
    const di = +el.dataset.d, id = el.dataset.l, idx = +el.dataset.i;
    const linha = S.agenda.dias[di]?.linhas.find(x => x.id === id);
    if(f === 'horario'){ linha.horario = el.value; marcarSujo(); desenharSemana(); }
    else if(f === 'tipo'){
      linha.tipo = el.value;
      if(linha.tipo === 'culto' && !(linha.funcoes||[]).length) linha.funcoes = funcoesDe(['Direção','Leitura','Pregação']);
      marcarSujo(); desenharSemana();
    }
    else if(f === 'cultoId'){
      const c = cultoPorId(el.value);
      if(c) aplicarCulto(linha, c); else linha.cultoId = '';
      marcarSujo(); desenharSemana();
    }
    else if(f === 'funcoesTxt'){
      const labels = el.value.split(',').map(s => s.trim()).filter(Boolean);
      const antigas = new Map((linha.funcoes||[]).map(x => [x.key, x.pessoa]));
      linha.funcoes = labels.map(lb => ({ key: slug(lb), label: lb, pessoa: antigas.get(slug(lb)) || null }));
      marcarSujo(); desenharSemana();
    }
    else if(f === 'portDia'){ S.agenda.porteiros[idx].dia = +el.value; marcarSujo(); desenharSemana(); }
    else if(f === 'pastDia'){ S.agenda.pastoral[idx].dia = +el.value; marcarSujo(); desenharSemana(); }
  };
}
async function irSemana(ini){
  if(S.sujo && !confirm('Há alterações não salvas nesta semana. Sair mesmo assim?')) { desenharSemana(); return; }
  S.semanaIni = ini; await comCarga(renderSemanaTela());
}

// ---------- salvar ----------
function slotsDe(ag){
  // Mapa "slot" -> pessoa, para detectar trocas e montar o índice de participações.
  const m = new Map();
  ag.dias.forEach((d,i)=> d.linhas.forEach(l => {
    if(l.tipo !== 'culto') return;
    (l.funcoes||[]).forEach(f => m.set(`${l.id}__${f.key}`, { pessoa: f.pessoa, dia:i, linha:l, funcKey:f.key, funcLabel:f.label, tipoSlot:'culto' }));
  }));
  (ag.porteiros||[]).forEach(p => m.set(`${p.id}__porteiro`, { pessoa: p.pessoa, dia:p.dia, linha:null, funcKey:'porteiro', funcLabel:'Porteiro', tipoSlot:'porteiro' }));
  return m;
}
async function sincronizarParticipacoes(ag){
  const novos = new Map();
  slotsDe(ag).forEach((s, slotId)=>{
    if(!s.pessoa?.membroId) return;
    const data = ag.dias[s.dia].data;
    novos.set(`${ag.semanaIni}__${slotId}`, { membroId: s.pessoa.membroId, funcao: s.funcKey, funcaoData: `${s.funcKey}|${data}`,
      data, cultoId: s.linha?.cultoId || '', agendaId: ag.semanaIni });
  });
  const existentes = await getDocs(query(col('participacoes'), where('agendaId','==',ag.semanaIni)));
  const ops = [];
  existentes.docs.forEach(d => { if(!novos.has(d.id)) ops.push({ del:true, id:d.id }); });
  novos.forEach((v,id)=> ops.push({ id, v }));
  for(let i=0; i<ops.length; i+=400){
    const b = writeBatch(C.db);
    ops.slice(i, i+400).forEach(o => o.del ? b.delete(docRef('participacoes', o.id)) : b.set(docRef('participacoes', o.id), o.v));
    await b.commit();
  }
  S.hist = {};   // o histórico do rodízio muda quando as escalas mudam
}
// Troca de escala: se alguém que JÁ recebeu aviso saiu de uma função, avisa quem saiu e quem entrou.
async function processarTrocas(ag, original){
  if(!original) return 0;
  const antes = slotsDe(original), depois = slotsDe(ag);
  const hoje = hojeISO();
  const ops = [];
  for(const [slotId, a] of antes){
    if(!a.pessoa?.nome) continue;
    const d = depois.get(slotId);
    const mudou = !d || !d.pessoa?.nome || (d.pessoa.membroId || d.pessoa.nome) !== (a.pessoa.membroId || a.pessoa.nome);
    if(!mudou) continue;
    const idEscala = `${ag.semanaIni}__${slotId}__escala`;
    const existia = await getDoc(docRef('mensagens', idEscala));
    if(!existia.exists()) continue;     // ninguém foi avisado antes: não há o que corrigir
    // some com avisos pendentes da pessoa antiga
    for(const t of ['escala','lembrete']){
      const r = docRef('mensagens', `${ag.semanaIni}__${slotId}__${t}`);
      const s = await getDoc(r);
      if(s.exists() && String(s.data().fila||'').startsWith('p|')) ops.push({ del:r });
    }
    const dataCulto = original.dias[a.dia].data;
    const base = { agendaId: ag.semanaIni, funcao: a.funcLabel, culto: a.linha?.titulo || (a.tipoSlot==='porteiro' ? 'Portaria' : 'Atividade'),
      dataCulto, horario: a.linha?.horario || '', criadoEm: Date.now() };
    ops.push({ set: docRef('mensagens', `${ag.semanaIni}__${slotId}__troca_saiu_${Date.now()}`), v: montarMsgDoc({
      ...base, tipo:'troca_saiu', pessoa: a.pessoa, linhaOrig: a.linha, funcKey: a.funcKey, ag: original, enviarEm: `${hoje}T08:00` }) });
    if(d?.pessoa?.nome){
      ops.push({ set: docRef('mensagens', `${ag.semanaIni}__${slotId}__troca_entrou_${Date.now()}`), v: montarMsgDoc({
        ...base, tipo:'troca_entrou', pessoa: d.pessoa, linhaOrig: d.linha, funcKey: a.funcKey, ag, enviarEm: `${hoje}T08:00` }) });
    }
  }
  if(ops.length){
    const b = writeBatch(C.db);
    ops.forEach(o => o.del ? b.delete(o.del) : b.set(o.set, o.v));
    await b.commit();
  }
  return ops.filter(o=>o.set).length;
}
async function persistirAgenda(ag, original){
  ag.atualizadoEm = Date.now();
  await setDoc(docRef('agendas', ag.semanaIni), clone(ag));
  await sincronizarParticipacoes(ag);
  return processarTrocas(ag, original);
}
async function salvarSemana(){
  try{
    const trocas = await persistirAgenda(S.agenda, S.original);
    S.original = clone(S.agenda); S.sujo = false;
    C.toast(trocas ? `Semana salva! ${trocas} aviso(s) de troca de escala criado(s) na Central de mensagens.` : 'Semana salva!');
    const b = $('agBtnSalvar'); if(b) b.classList.remove('ag-pulso');
  } catch(e){ C.toast('Erro ao salvar: ' + e.message, true); }
}

// ---------- semana modelo / duplicação ----------
function aplicarSemanaModelo(){
  let n = 0;
  S.cultos.filter(c => c.noModelo && c.diaSemana !== '' && c.diaSemana != null).forEach(c=>{
    const dia = S.agenda.dias[+c.diaSemana]; if(!dia) return;
    if(dia.linhas.some(l => l.cultoId === c.id)) return;
    const l = novaLinha('culto'); aplicarCulto(l, c); dia.linhas.push(l); n++;
  });
  if(!n){ C.toast('Nenhum culto padrão marcado como "entra na semana modelo" (ou já estão na semana).', true); return; }
  marcarSujo(); desenharSemana(); C.toast(`${n} atividade(s) adicionada(s) pela semana modelo.`);
}
function copiarLinhas(linhas, manterPessoas){
  return clone(linhas).map(l => {
    l.id = uid();
    if(!manterPessoas) (l.funcoes||[]).forEach(f => f.pessoa = null);
    return l;
  });
}
function abrirDuplicar(cfg){
  S.dup = cfg;
  const m = $('agModalDup'); const sem = cfg.modo === 'semana';
  $('agDupTitulo').textContent = sem ? 'Duplicar semana' : `Duplicar ${DIAS[cfg.origem]} ${dm(S.agenda.dias[cfg.origem].data)}`;
  $('agDupDestinoLbl').textContent = sem ? 'Semana de destino (qualquer data da semana)' : 'Dia de destino';
  $('agDupDestino').value = sem ? cfg.destino : addDias(S.agenda.dias[cfg.origem].data, 7);
  $('agDupDestino').disabled = !!cfg.fixo;
  $('agDupSubst').closest('.field').style.display = sem ? 'flex' : 'none';
  $('agDupPessoas').checked = false;
  $('agDupSubst').checked = !!cfg.fixo;
  m.classList.add('active');
}
async function confirmarDuplicar(){
  const cfg = S.dup; const destRaw = $('agDupDestino').value;
  if(!destRaw){ C.toast('Informe a data de destino.', true); return; }
  const manter = $('agDupPessoas').checked;
  $('agModalDup').classList.remove('active');
  await comCarga((async ()=>{
    try{
      if(cfg.modo === 'semana'){
        const origemIni = cfg.origem, destIni = segundaDe(destRaw), subst = $('agDupSubst').checked;
        let origem;
        if(origemIni === S.semanaIni) origem = S.agenda;
        else { const s = await getDoc(docRef('agendas', origemIni)); if(!s.exists()){ C.toast('A semana de origem ainda não tem programação.', true); return; } origem = s.data(); }
        const noAtual = destIni === S.semanaIni;
        let destino, originalDest = null;
        if(noAtual) destino = S.agenda;
        else { const s = await getDoc(docRef('agendas', destIni)); destino = s.exists() ? s.data() : novaAgendaVazia(destIni); originalDest = s.exists() ? clone(destino) : null;
          destino.dias = DIAS.map((_,i)=> (destino.dias||[])[i] || { data: addDias(destIni,i), linhas: [] }); destino.porteiros = destino.porteiros||[]; destino.pastoral = destino.pastoral||[]; }
        if(destino.status === 'publicada'){ C.toast('A semana de destino está publicada (travada). Reabra-a antes.', true); return; }
        origem.dias.forEach((d,i)=>{
          const novas = copiarLinhas(d.linhas||[], manter);
          destino.dias[i].linhas = subst ? novas : [...destino.dias[i].linhas, ...novas];
        });
        if(manter && (origem.porteiros||[]).length) destino.porteiros = subst ? clone(origem.porteiros).map(p=>({ ...p, id: uid() })) : [...destino.porteiros, ...clone(origem.porteiros).map(p=>({ ...p, id: uid() }))];
        if(noAtual){ marcarSujo(); desenharSemana(); C.toast('Semana copiada para esta tela. Revise e clique em "Salvar semana".'); }
        else { await persistirAgenda(destino, originalDest); C.toast(`Semana duplicada para ${tituloSemana(destIni)}.`); }
      } else {
        const dataDest = destRaw, destIni = segundaDe(dataDest), idx = (parseISO(dataDest).getDay()+6)%7;
        const linhas = copiarLinhas(S.agenda.dias[cfg.origem].linhas, manter);
        if(!linhas.length){ C.toast('Este dia não tem atividades para duplicar.', true); return; }
        if(destIni === S.semanaIni){
          if(bloqueada()){ C.toast('Esta semana está publicada (travada).', true); return; }
          S.agenda.dias[idx].linhas.push(...linhas); marcarSujo(); desenharSemana(); C.toast('Dia duplicado. Revise e salve a semana.');
        } else {
          const s = await getDoc(docRef('agendas', destIni));
          const destino = s.exists() ? s.data() : novaAgendaVazia(destIni);
          if(destino.status === 'publicada'){ C.toast('A semana de destino está publicada (travada).', true); return; }
          destino.dias = DIAS.map((_,i)=> (destino.dias||[])[i] || { data: addDias(destIni,i), linhas: [] }); destino.porteiros = destino.porteiros||[]; destino.pastoral = destino.pastoral||[];
          destino.dias[idx].linhas.push(...linhas);
          await persistirAgenda(destino, s.exists() ? clone(s.data()) : null);
          C.toast(`Dia duplicado para ${dmy(dataDest)} (semana de ${dm(destIni)}).`);
        }
      }
    } catch(e){ C.toast('Erro ao duplicar: ' + e.message, true); }
  })());
}

// ---------- lembretes na agenda pastoral ----------
async function importarLembretesDaSemana(){
  await garantirLembretes();
  const ini = S.semanaIni, fim = addDias(ini,6);
  let n = 0;
  S.lembretes.filter(l => l.naPastoral).forEach(l=>{
    const oc = ocorrenciaNoIntervalo(l, ini, fim); if(!oc) return;
    const idx = Math.round((parseISO(oc) - parseISO(ini)) / 86400000);
    if(S.agenda.pastoral.some(p => p.texto === l.titulo && p.dia === idx)) return;
    S.agenda.pastoral.push({ id: uid(), dia: idx, texto: l.titulo }); n++;
  });
  if(!n){ C.toast('Nenhum lembrete marcado para a agenda pastoral nesta semana.', true); return; }
  marcarSujo(); desenharSemana(); C.toast(`${n} lembrete(s) importado(s).`);
}

// ======================================================================
// RODÍZIO + SELETOR DE PESSOA
// ======================================================================
async function historico(funcKey){
  if(S.hist[funcKey]) return S.hist[funcKey];
  const ini = addDias(hojeISO(), -730);
  const todos = []; let cursor = null;
  for(let p = 0; p < 20; p++){
    const filtros = [where('funcaoData','>=',`${funcKey}|${ini}`), where('funcaoData','<',`${funcKey}|~`), orderBy('funcaoData')];
    const q = query(col('participacoes'), ...filtros, ...(cursor ? [startAfter(cursor)] : []), limit(500));
    const snaps = await getDocs(q);
    snaps.docs.forEach(d => todos.push({ id:d.id, ...d.data() }));
    if(snaps.docs.length < 500) break;
    cursor = snaps.docs[snaps.docs.length-1];
  }
  S.hist[funcKey] = todos;
  return todos;
}
// Rodízio "sem repetição": todos os habilitados participam uma vez antes de alguém repetir;
// quando o último do grupo participa, um novo ciclo começa.
export function calcularRodizio(pool, eventos, cultoId){
  const ids = new Set(pool.map(m => m.id));
  const ord = eventos.filter(e => ids.has(e.membroId)).sort((a,b)=> a.data.localeCompare(b.data));
  let feitos = new Set(); let ciclo = 1;
  const ultima = {}, ultCulto = {}, qtdCulto = {};
  ord.forEach(e=>{
    if(!ultima[e.membroId] || e.data > ultima[e.membroId]) ultima[e.membroId] = e.data;
    if(cultoId && e.cultoId === cultoId){ qtdCulto[e.membroId] = (qtdCulto[e.membroId]||0) + 1; if(!ultCulto[e.membroId] || e.data > ultCulto[e.membroId]) ultCulto[e.membroId] = e.data; }
    feitos.add(e.membroId);
    if(ids.size && feitos.size >= ids.size){ feitos = new Set(); ciclo++; }
  });
  const itens = pool.map(m => ({ m, feito: feitos.has(m.id), ultima: ultima[m.id] || '', ultCulto: ultCulto[m.id] || '', qtdCulto: qtdCulto[m.id] || 0 }));
  itens.sort((a,b)=> (a.feito - b.feito) || a.ultima.localeCompare(b.ultima) || C.normalizarTexto(a.m.exibe).localeCompare(C.normalizarTexto(b.m.exibe)));
  return { itens, feitos: feitos.size, total: ids.size, ciclo };
}
const PICK = { cfg:null, itens:[], rod:null };
async function abrirPicker(cfg){
  PICK.cfg = cfg;
  $('agPickTitulo').textContent = `${cfg.funcLabel} — ${cfg.contexto}`;
  $('agPickBusca').value = ''; $('agPickLivre').value = ''; $('agPickLivreTel').value = '';
  $('agPickLista').innerHTML = '<div class="abas-hint">Carregando…</div>';
  $('agModalPick').classList.add('active');
  try{
    const [pool, hist] = await Promise.all([carregarPool(), historico(cfg.funcKey)]);
    const fixa = FUNCOES_PADRAO.some(f => f.id === cfg.funcKey);
    const habil = pool.filter(m => !fixa || m.funcoes.includes(cfg.funcKey));
    // Remove do histórico a semana em edição (usa o que está na tela) e acrescenta as escolhas atuais da tela.
    const eventos = hist.filter(e => e.agendaId !== S.semanaIni);
    slotsDe(S.agenda).forEach((s, slotId)=>{
      if(slotId === cfg.slotId || s.funcKey !== cfg.funcKey || !s.pessoa?.membroId) return;
      eventos.push({ membroId: s.pessoa.membroId, data: S.agenda.dias[s.dia].data, cultoId: s.linha?.cultoId || '' });
    });
    PICK.rod = calcularRodizio(habil, eventos, cfg.cultoId);
    PICK.fixa = fixa; PICK.semHabil = !habil.length;
    desenharPicker();
  } catch(e){ $('agPickLista').innerHTML = `<div class="abas-hint">Erro ao carregar: ${h(e.message)}</div>`; }
}
function desenharPicker(){
  const cfg = PICK.cfg, rod = PICK.rod; if(!rod) return;
  const termo = C.normalizarTexto($('agPickBusca').value);
  const mapa = resumoConflitos(S.agenda);
  const itens = rod.itens.filter(i => !termo || C.normalizarTexto(i.m.exibe + ' ' + i.m.nome).includes(termo));
  const resumo = rod.total ? `Ciclo ${rod.ciclo}: ${rod.feitos} de ${rod.total} já participaram de "${h(cfg.funcLabel)}" — quem ainda não participou aparece primeiro.` : '';
  $('agPickResumo').innerHTML = PICK.semHabil
    ? `Ninguém está habilitado para "${h(cfg.funcLabel)}". Em <b>Fiéis</b>, marque "Participa da programação" e as funções de cada pessoa. Você ainda pode digitar um nome abaixo.`
    : resumo;
  $('agPickLista').innerHTML = itens.length ? itens.map(i=>{
    const conf = (mapa.get(i.m.id)||{itens:[]}).itens.filter(x => !x.startsWith('__'));
    const jaNaSemana = conf.length && !(conf.length === 1 && cfg.atual?.membroId === i.m.id);
    return `<div class="ag-picker-item" data-id="${i.m.id}">
      <div><b>${h(i.m.exibe)}</b>
        <small>${i.ultima ? `Última vez: ${dmy(i.ultima)}` : 'Nunca participou nesta função'}${cfg.cultoId ? ` · Neste culto: ${i.qtdCulto}x${i.ultCulto ? ' (última ' + dmy(i.ultCulto) + ')' : ''}` : ''}</small>
        ${jaNaSemana ? `<small style="color:#b26a00;">⚠ Já escalado(a) nesta semana: ${conf.map(h).join(', ')}</small>` : ''}</div>
      <span class="ag-badge ${i.feito ? 'feito' : 'novo'}">${i.feito ? 'já participou no ciclo' : 'da vez'}</span></div>`;
  }).join('') : '<div class="abas-hint">Nenhuma pessoa encontrada.</div>';
}
function escolherPessoa(p){
  const cb = PICK.cfg.onEscolher; $('agModalPick').classList.remove('active'); cb(p);
}

// ======================================================================
// PDF
// ======================================================================
async function gerarPdf(){
  try{
    const ag = clone(S.agenda);
    ag.dias.forEach(ordenarLinhas);
    const cultos = {}; S.cultos.forEach(c => { if(c.icone) cultos[c.id] = { icone: c.icone }; });
    const pdf = desenharAgendaPdf(window.jspdf.jsPDF, { agenda: ag, igreja: C.state.igrejaDados || {}, cultos, tituloSemana: tituloSemana(S.semanaIni) });
    pdf.save(`agenda_semanal_${S.semanaIni}.pdf`);
  } catch(e){ C.toast('Erro ao gerar PDF: ' + e.message, true); console.error(e); }
}

// ======================================================================
// CULTOS PADRÃO
// ======================================================================
async function renderCultos(){
  const ed = podeEditar();
  $('agConteudo').innerHTML = `
    <div class="card">
      <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:8px;">
        <div><div style="font-weight:600;">Cultos e atividades padrão</div>
        <div class="abas-hint">Nomes fixos com ícone, horário e funções. Ao escolher um culto padrão na semana, tudo já vem preenchido.</div></div>
        ${ed ? '<button class="btn btn-primary" id="agNovoCulto">+ Novo culto padrão</button>' : ''}
      </div>
      <div id="agListaCultos"></div>
    </div>`;
  const lista = $('agListaCultos');
  lista.innerHTML = S.cultos.length ? S.cultos.map(c => `
    <div class="list-row" style="align-items:center;">
      <div class="ag-grade-icones">${c.icone ? `<img class="ag-ico" style="width:34px;height:34px" src="${c.icone}">` : '<span style="width:34px"></span>'}
        <div><b>${h(c.nome)}</b><div class="abas-hint">${c.diaSemana !== '' && c.diaSemana != null ? DIAS[+c.diaSemana] + ' · ' : ''}${h(c.horario||'sem horário')} · ${h((c.funcoes||[]).join(', ') || 'Direção, Leitura, Pregação')}${c.noModelo ? ' · semana modelo' : ''}</div></div></div>
      ${ed ? `<div><button class="btn btn-sm" data-edit="${c.id}">Editar</button> <button class="btn btn-sm btn-danger" data-del="${c.id}">Excluir</button></div>` : ''}
    </div>`).join('') : '<div class="empty">Nenhum culto padrão cadastrado ainda.</div>';
  if($('agNovoCulto')) $('agNovoCulto').onclick = ()=> abrirModalCulto(null);
  lista.querySelectorAll('[data-edit]').forEach(b => b.onclick = ()=> abrirModalCulto(cultoPorId(b.dataset.edit)));
  lista.querySelectorAll('[data-del]').forEach(b => b.onclick = async ()=>{
    const c = cultoPorId(b.dataset.del);
    // Agendas guardam o próprio nome do culto; excluir só tira o ícone/pré-preenchimento dali pra frente.
    if(!confirm(`Excluir "${c.nome}"? As agendas já feitas continuam com o nome, mas perdem o ícone.`)) return;
    await deleteDoc(docRef('cultosPadrao', c.id)); S.cultos = S.cultos.filter(x => x.id !== c.id); renderCultos();
  });
}
function abrirModalCulto(c){
  S.editandoCultoId = c ? c.id : null; S.cultoIconePendente = undefined;
  $('agCultoTitulo').textContent = c ? 'Editar culto padrão' : 'Novo culto padrão';
  $('agCultoNome').value = c?.nome || ''; $('agCultoHora').value = c?.horario || '';
  $('agCultoDia').value = (c && c.diaSemana !== '' && c.diaSemana != null) ? String(c.diaSemana) : '';
  $('agCultoFuncoes').value = (c?.funcoes || ['Direção','Leitura','Pregação']).join(', ');
  $('agCultoObs').value = c?.obsPadrao || ''; $('agCultoModelo').checked = !!c?.noModelo;
  S.cultoIconeAtual = c?.icone || '';
  atualizarPreviewIconeCulto();
  $('agModalCulto').classList.add('active');
}
function atualizarPreviewIconeCulto(){
  const src = S.cultoIconePendente === undefined ? S.cultoIconeAtual : S.cultoIconePendente;
  const p = $('agCultoIconePrev'); if(src){ p.src = src; p.style.display = 'inline-block'; } else { p.removeAttribute('src'); p.style.display = 'none'; }
}
async function salvarCulto(){
  if(!C.validarObrigatorios([{ id:'agCultoNome', nome:'Nome' }])) return;
  const payload = {
    nome: $('agCultoNome').value.trim(), horario: $('agCultoHora').value || '', diaSemana: $('agCultoDia').value,
    funcoes: $('agCultoFuncoes').value.split(',').map(s=>s.trim()).filter(Boolean),
    obsPadrao: $('agCultoObs').value.trim(), noModelo: $('agCultoModelo').checked,
    icone: S.cultoIconePendente === undefined ? (S.cultoIconeAtual || '') : (S.cultoIconePendente || ''),
  };
  try{
    if(S.editandoCultoId) await setDoc(docRef('cultosPadrao', S.editandoCultoId), payload);
    else { const r = doc(col('cultosPadrao')); await setDoc(r, payload); }
    $('agModalCulto').classList.remove('active');
    S.baseCarregada = false; await carregarBase(); C.toast('Culto padrão salvo!'); renderCultos();
  } catch(e){ C.toast('Erro ao salvar: ' + e.message, true); }
}

// ======================================================================
// LEMBRETES
// ======================================================================
async function garantirLembretes(){
  if(S.lembretes) return S.lembretes;
  const snaps = await getDocs(query(col('lembretes'), orderBy('data'), limit(300)));
  S.lembretes = snaps.docs.map(d => ({ id:d.id, ...d.data() }));
  return S.lembretes;
}
// Próxima data do lembrete a partir de `desde` (anual: mesmo dia/mês).
function proximaOcorrencia(l, desde){
  if(!l.repete) return l.data >= desde ? l.data : null;
  const [, m, d] = l.data.split('-'); const ano = +desde.slice(0,4);
  for(const a of [ano, ano+1]){ const c = `${a}-${m}-${d}`; if(c >= desde) return c; }
  return null;
}
function ocorrenciaNoIntervalo(l, ini, fim){
  const o = proximaOcorrencia(l, ini); return (o && o <= fim) ? o : null;
}
async function renderLembretes(){
  await garantirLembretes();
  const ed = podeEditar(); const hoje = hojeISO();
  const itens = S.lembretes.map(l => ({ l, prox: proximaOcorrencia(l, hoje) })).sort((a,b)=> (a.prox||'9999').localeCompare(b.prox||'9999'));
  $('agConteudo').innerHTML = `
    <div class="card">
      <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:8px;">
        <div><div style="font-weight:600;">Calendário de lembretes</div>
        <div class="abas-hint">O app destaca no Painel quando chega a hora de lembrar. Também vão para o arquivo de calendário (.ics) do celular.</div></div>
        <div>${ed ? '<button class="btn btn-primary" id="agNovoLemb">+ Novo lembrete</button> ' : ''}<button class="btn" id="agIcsLemb">Baixar calendário (.ics)</button></div>
      </div>
      ${itens.length ? itens.map(({l, prox}) => `
        <div class="list-row" style="align-items:center;">
          <div><b>${h(l.titulo)}</b><div class="abas-hint">${prox ? dmy(prox) : 'já passou'}${l.repete ? ' · todo ano' : ''} · avisar ${l.antecedencia||0} dia(s) antes${l.naPastoral ? ' · sugere na Agenda Pastoral' : ''}${l.obs ? ' · ' + h(l.obs) : ''}</div></div>
          ${ed ? `<div><button class="btn btn-sm" data-edit="${l.id}">Editar</button> <button class="btn btn-sm btn-danger" data-del="${l.id}">Excluir</button></div>` : ''}
        </div>`).join('') : '<div class="empty">Nenhum lembrete cadastrado.</div>'}
    </div>`;
  if($('agNovoLemb')) $('agNovoLemb').onclick = ()=> abrirModalLemb(null);
  $('agIcsLemb').onclick = ()=> baixarIcs(false);
  $('agConteudo').querySelectorAll('[data-edit]').forEach(b => b.onclick = ()=> abrirModalLemb(S.lembretes.find(x => x.id === b.dataset.edit)));
  $('agConteudo').querySelectorAll('[data-del]').forEach(b => b.onclick = async ()=>{
    if(!confirm('Excluir este lembrete?')) return;
    await deleteDoc(docRef('lembretes', b.dataset.del)); S.lembretes = null; renderLembretes();
  });
}
function abrirModalLemb(l){
  S.editandoLembId = l ? l.id : null;
  $('agLembTitulo').textContent = l ? 'Editar lembrete' : 'Novo lembrete';
  $('agLembNome').value = l?.titulo || ''; $('agLembData').value = l?.data || hojeISO();
  $('agLembRepete').checked = !!l?.repete; $('agLembAntec').value = l?.antecedencia ?? 3;
  $('agLembObs').value = l?.obs || ''; $('agLembPast').checked = !!l?.naPastoral;
  $('agModalLemb').classList.add('active');
}
async function salvarLembrete(){
  if(!C.validarObrigatorios([{ id:'agLembNome', nome:'Título' }, { id:'agLembData', nome:'Data' }])) return;
  const payload = { titulo: $('agLembNome').value.trim(), data: $('agLembData').value, repete: $('agLembRepete').checked,
    antecedencia: Math.max(0, parseInt($('agLembAntec').value) || 0), obs: $('agLembObs').value.trim(), naPastoral: $('agLembPast').checked };
  try{
    if(S.editandoLembId) await setDoc(docRef('lembretes', S.editandoLembId), payload);
    else await setDoc(doc(col('lembretes')), payload);
    $('agModalLemb').classList.remove('active'); S.lembretes = null; C.toast('Lembrete salvo!'); renderLembretes();
  } catch(e){ C.toast('Erro ao salvar: ' + e.message, true); }
}

// ======================================================================
// MENSAGENS (WhatsApp — fase 1: central de envio assistido)
// ======================================================================
function telWa(tel){
  let d = String(tel||'').replace(/\D/g,''); if(!d) return '';
  if(d.startsWith('55') && d.length >= 12) return d;
  if(d.length === 10 || d.length === 11) return '55' + d;
  return d;
}
function preencher(modelo, v){
  return modelo.replace(/\{(\w+)\}/g, (_, k)=> (v[k] ?? ''));
}
// Texto da "equipe" que vai só para o dirigente: as OUTRAS funções do mesmo culto (porteiro não entra).
function equipeDoCulto(linha, ag){
  if(!linha) return '';
  const outras = (linha.funcoes||[]).filter(f => f.key !== 'direcao' && f.key !== 'porteiro' && f.pessoa?.nome);
  if(!outras.length) return '';
  return '\n\nQuem participa com você:\n' + outras.map(f => `• ${f.label}: ${f.pessoa.nome}`).join('\n');
}
function montarMsgDoc(o){
  const diaIdx = o.ag.dias.findIndex(d => d.data === o.dataCulto);
  const ehDirecao = o.funcKey === 'direcao';
  const v = { nome: o.pessoa.nome, funcao: o.funcao, culto: o.culto, dia: DIAS_LONGO[diaIdx] || '', data: dm(o.dataCulto),
    horario: (o.horario || '').replace(':','h') || 'horário a confirmar', equipe: ehDirecao ? equipeDoCulto(o.linhaOrig, o.ag) : '',
    igreja: C.state.igrejaDados?.nome || '' };
  return { agendaId: o.agendaId, tipo: o.tipo, nome: o.pessoa.nome, tel: o.pessoa.tel || '', membroId: o.pessoa.membroId || '',
    funcao: o.funcao, culto: o.culto, dataCulto: o.dataCulto, texto: preencher(S.modelos[o.tipo] || MODELOS_PADRAO[o.tipo], v),
    enviarEm: o.enviarEm, fila: 'p|' + o.enviarEm, criadoEm: o.criadoEm || Date.now() };
}
function abrirGerarMensagens(){
  if(S.sujo){ C.toast('Salve a semana antes de gerar as mensagens.', true); return; }
  $('agGMDataEscala').value = hojeISO(); $('agGMHoraEscala').value = '08:00'; $('agGMHoraLemb').value = '08:00';
  $('agGMEscala').checked = true; $('agGMLemb').checked = true;
  $('agModalGM').classList.add('active');
}
async function gerarMensagens(){
  const ag = S.agenda, hoje = hojeISO();
  const fazEscala = $('agGMEscala').checked, fazLemb = $('agGMLemb').checked;
  const enviarEscala = `${$('agGMDataEscala').value || hoje}T${$('agGMHoraEscala').value || '08:00'}`;
  const horaLemb = $('agGMHoraLemb').value || '08:00';
  $('agModalGM').classList.remove('active');
  await comCarga((async ()=>{
    try{
      const exist = await getDocs(query(col('mensagens'), where('agendaId','==', ag.semanaIni)));
      const ids = new Set(exist.docs.map(d => d.id));
      const novos = [];
      slotsDe(ag).forEach((s, slotId)=>{
        if(!s.pessoa?.nome) return;
        const dataCulto = ag.dias[s.dia].data;
        const culto = s.linha?.titulo || (s.tipoSlot === 'porteiro' ? 'Portaria' : 'Atividade');
        let horario = s.linha?.horario || '';
        if(s.tipoSlot === 'porteiro') horario = (ag.dias[s.dia].linhas.find(l => l.horario)?.horario) || '';
        const base = { agendaId: ag.semanaIni, funcao: s.funcLabel, culto, dataCulto, horario, pessoa: s.pessoa, linhaOrig: s.linha, funcKey: s.funcKey, ag };
        if(fazEscala && !ids.has(`${ag.semanaIni}__${slotId}__escala`) && dataCulto >= hoje)
          novos.push([`${ag.semanaIni}__${slotId}__escala`, montarMsgDoc({ ...base, tipo:'escala', enviarEm: enviarEscala })]);
        if(fazLemb && !ids.has(`${ag.semanaIni}__${slotId}__lembrete`) && dataCulto >= hoje)
          novos.push([`${ag.semanaIni}__${slotId}__lembrete`, montarMsgDoc({ ...base, tipo:'lembrete', enviarEm: `${dataCulto}T${horaLemb}` })]);
      });
      if(!novos.length){ C.toast('Nada novo para gerar (já geradas, sem pessoas escaladas ou datas passadas).', true); return; }
      for(let i=0;i<novos.length;i+=400){
        const b = writeBatch(C.db); novos.slice(i,i+400).forEach(([id,v]) => b.set(docRef('mensagens', id), v)); await b.commit();
      }
      C.toast(`${novos.length} mensagem(ns) criada(s). Veja na aba Mensagens.`);
      S.sub = 'mensagens'; renderSub();
    } catch(e){ C.toast('Erro ao gerar mensagens: ' + e.message, true); }
  })());
}
async function buscarMensagens(reiniciar){
  if(reiniciar){ S.msgPag = []; S.msgCursor = null; S.msgTemMais = false; }
  const pend = S.msgAba === 'pendentes';
  const pre = pend ? 'p' : 'e';
  const filtros = [where('fila','>=',`${pre}|`), where('fila','<',`${pre}}`), orderBy('fila', pend ? 'asc' : 'desc')];
  const q = query(col('mensagens'), ...filtros, ...(S.msgCursor ? [startAfter(S.msgCursor)] : []), limit(50));
  const snaps = await getDocs(q);
  const novos = snaps.docs.map(d => ({ id:d.id, ...d.data() }));
  S.msgPag = reiniciar ? novos : [...S.msgPag, ...novos];
  if(snaps.docs.length) S.msgCursor = snaps.docs[snaps.docs.length-1];
  S.msgTemMais = snaps.docs.length === 50;
}
async function renderMensagens(reiniciar){
  await buscarMensagens(reiniciar);
  desenharMensagens();
}
function desenharMensagens(){
  const ed = podeEditar(); const hoje = hojeISO();
  $('agConteudo').innerHTML = `
    <div class="card" style="margin-bottom:12px;">
      <div style="font-weight:600;">Central de mensagens (WhatsApp)</div>
      <div class="abas-hint" style="margin-bottom:8px;">O app não envia sozinho: na hora marcada, a mensagem aparece aqui e no Painel. Um toque abre o WhatsApp com número e texto prontos. Para o celular avisar com o app fechado, baixe o calendário (.ics).</div>
      <div style="display:flex; gap:6px; flex-wrap:wrap;">
        <button class="btn" id="agMsgIcs">Baixar calendário (.ics)</button>
        ${ed ? '<button class="btn" id="agMsgModelos">Editar textos-modelo</button>' : ''}
      </div>
    </div>
    <div class="ag-tabs"><button class="ag-tab ${S.msgAba==='pendentes'?'active':''}" data-ma="pendentes">Pendentes</button>
      <button class="ag-tab ${S.msgAba==='enviadas'?'active':''}" data-ma="enviadas">Enviadas</button></div>
    <div id="agMsgLista">${S.msgPag.length ? S.msgPag.map(m=>{
      const vencida = S.msgAba === 'pendentes' && m.enviarEm.slice(0,10) <= hoje;
      const tel = telWa(m.tel);
      return `<div class="ag-msg" style="${vencida?'border-color:#e07b00;':''}">
        <div class="ag-msg-top"><div><b>${h(m.nome)}</b> <span class="tag">${ROTULO_TIPO_MSG[m.tipo]||m.tipo}</span>
          <span class="abas-hint"> ${h(m.funcao)} · ${h(m.culto)} · ${dm(m.dataCulto)}</span></div>
          <div class="abas-hint">${S.msgAba==='pendentes' ? `enviar em ${dmy(m.enviarEm.slice(0,10))} às ${m.enviarEm.slice(11)}${vencida ? ' · <b style="color:#e07b00">hora de enviar</b>' : ''}` : `enviada em ${m.enviadoEm ? new Date(m.enviadoEm).toLocaleString('pt-BR') : ''}`}</div></div>
        <pre>${h(m.texto)}</pre>
        <div style="display:flex; gap:6px; flex-wrap:wrap; align-items:center;">
          ${S.msgAba==='pendentes' ? (tel ? `<a class="btn btn-sm btn-primary" target="_blank" rel="noopener" href="https://wa.me/${tel}?text=${encodeURIComponent(m.texto)}" data-abrir="${m.id}">Abrir no WhatsApp</a>` : '<span class="abas-hint">⚠ sem telefone — edite para adicionar</span>') : ''}
          ${ed && S.msgAba==='pendentes' ? `<button class="btn btn-sm" data-ok="${m.id}">Marcar como enviada</button><button class="btn btn-sm" data-edm="${m.id}">Editar</button>` : ''}
          ${ed ? `<button class="btn btn-sm btn-danger" data-delm="${m.id}">Excluir</button>` : ''}
        </div></div>`; }).join('') : `<div class="empty">Nenhuma mensagem ${S.msgAba}.</div>`}
      ${S.msgTemMais ? '<button class="btn" id="agMsgMais">Carregar mais</button>' : ''}</div>`;
  $('agMsgIcs').onclick = ()=> baixarIcs(true);
  if($('agMsgModelos')) $('agMsgModelos').onclick = abrirModelos;
  document.querySelectorAll('[data-ma]').forEach(b => b.onclick = async ()=>{ S.msgAba = b.dataset.ma; await comCarga(renderMensagens(true)); });
  if($('agMsgMais')) $('agMsgMais').onclick = async ()=>{ await comCarga(buscarMensagens(false)); desenharMensagens(); };
  const lista = $('agMsgLista');
  lista.querySelectorAll('[data-ok]').forEach(b => b.onclick = ()=> marcarEnviada(b.dataset.ok));
  lista.querySelectorAll('[data-delm]').forEach(b => b.onclick = async ()=>{ if(confirm('Excluir esta mensagem?')){ await deleteDoc(docRef('mensagens', b.dataset.delm)); renderMensagens(true); } });
  lista.querySelectorAll('[data-edm]').forEach(b => b.onclick = ()=> abrirEditarMsg(S.msgPag.find(x => x.id === b.dataset.edm)));
}
async function marcarEnviada(id){
  const agora = Date.now();
  await updateDoc(docRef('mensagens', id), { fila: 'e|' + String(agora).padStart(15,'0'), enviadoEm: agora });
  C.toast('Marcada como enviada.'); renderMensagens(true);
}
function abrirEditarMsg(m){
  S.editandoMsgId = m.id;
  $('agMsgTexto').value = m.texto; $('agMsgTel').value = m.tel || '';
  $('agMsgData').value = m.enviarEm.slice(0,10); $('agMsgHora').value = m.enviarEm.slice(11);
  $('agModalMsg').classList.add('active');
}
async function salvarMsg(){
  const enviarEm = `${$('agMsgData').value}T${$('agMsgHora').value || '08:00'}`;
  await updateDoc(docRef('mensagens', S.editandoMsgId), { texto: $('agMsgTexto').value, tel: $('agMsgTel').value.trim(), enviarEm, fila: 'p|' + enviarEm });
  $('agModalMsg').classList.remove('active'); C.toast('Mensagem atualizada.'); renderMensagens(true);
}
function abrirModelos(){
  ['escala','lembrete','troca_saiu','troca_entrou'].forEach(t => $('agMod_'+t).value = S.modelos[t]);
  $('agModalModelos').classList.add('active');
}
async function salvarModelos(){
  const m = {}; ['escala','lembrete','troca_saiu','troca_entrou'].forEach(t => m[t] = $('agMod_'+t).value);
  await setDoc(docRef('configAgenda','modelos'), m); S.modelos = { ...MODELOS_PADRAO, ...m };
  $('agModalModelos').classList.remove('active'); C.toast('Textos-modelo salvos (valem para as próximas mensagens).');
}

// ---------- calendário .ics ----------
function icsData(iso, hora){ return iso.replace(/-/g,'') + (hora ? 'T' + hora.replace(':','') + '00' : ''); }
function icsTxt(t){ return String(t||'').replace(/\\/g,'\\\\').replace(/;/g,'\\;').replace(/,/g,'\\,').replace(/\r?\n/g,'\\n'); }
async function baixarIcs(comMensagens){
  try{
    await garantirLembretes();
    const linhas = ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//SOFT+//Agendas//PT-BR','CALSCALE:GREGORIAN'];
    const agoraTag = new Date().toISOString().replace(/[-:]/g,'').slice(0,15) + 'Z';
    if(comMensagens){
      const snaps = await getDocs(query(col('mensagens'), where('fila','>=','p|'), where('fila','<','p}'), orderBy('fila'), limit(300)));
      snaps.docs.forEach(d=>{
        const m = d.data(); const [data, hora] = m.enviarEm.split('T');
        linhas.push('BEGIN:VEVENT', `UID:${d.id}@softplus`, `DTSTAMP:${agoraTag}`, `DTSTART:${icsData(data, hora)}`,
          `DTEND:${icsData(data, hora)}`, `SUMMARY:${icsTxt('Enviar WhatsApp: ' + m.nome + ' (' + m.funcao + ')')}`,
          `DESCRIPTION:${icsTxt(m.texto)}`, 'BEGIN:VALARM','ACTION:DISPLAY','DESCRIPTION:Enviar mensagem','TRIGGER:PT0M','END:VALARM','END:VEVENT');
      });
    } else {
      S.lembretes.forEach(l=>{
        linhas.push('BEGIN:VEVENT', `UID:lemb-${l.id}@softplus`, `DTSTAMP:${agoraTag}`, `DTSTART;VALUE=DATE:${icsData(l.data)}`,
          `SUMMARY:${icsTxt(l.titulo)}`, ...(l.obs ? [`DESCRIPTION:${icsTxt(l.obs)}`] : []), ...(l.repete ? ['RRULE:FREQ=YEARLY'] : []),
          'BEGIN:VALARM','ACTION:DISPLAY',`DESCRIPTION:${icsTxt(l.titulo)}`,`TRIGGER:-P${l.antecedencia||0}D`,'END:VALARM','END:VEVENT');
      });
    }
    linhas.push('END:VCALENDAR');
    const blob = new Blob([linhas.join('\r\n')], { type:'text/calendar;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = comMensagens ? 'mensagens_whatsapp.ics' : 'lembretes.ics'; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=> URL.revokeObjectURL(a.href), 2000);
  } catch(e){ C.toast('Erro ao gerar o calendário: ' + e.message, true); }
}

// ======================================================================
// PAINEL (cartões de aviso)
// ======================================================================
export async function renderPainelAgendas(el){
  if(!el) return;
  if(!C.temAcesso('agendas')){ el.innerHTML = ''; return; }
  try{
    const hoje = hojeISO();
    const [msgs, lembs] = await Promise.all([
      getDocs(query(col('mensagens'), where('fila','>=','p|'), where('fila','<=',`p|${hoje}T23:59`), orderBy('fila'), limit(50))),
      (async ()=>{ S.lembretes = null; return garantirLembretes(); })(),
    ]);
    const proximos = lembs.map(l => ({ l, oc: proximaOcorrencia(l, hoje) })).filter(x => x.oc && addDias(x.oc, -(x.l.antecedencia||0)) <= hoje)
      .sort((a,b)=> a.oc.localeCompare(b.oc)).slice(0,5);
    if(!msgs.docs.length && !proximos.length){ el.innerHTML = ''; return; }
    el.innerHTML = `<div class="card" style="margin-bottom:18px;">
      ${msgs.docs.length ? `<div style="display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap;">
        <div><b>${msgs.docs.length}${msgs.docs.length>=50?'+':''} mensagem(ns) para enviar hoje</b><div class="abas-hint">WhatsApp — escalas e lembretes de culto</div></div>
        <button class="btn btn-primary btn-sm" id="pnMsgAbrir">Abrir Central</button></div>` : ''}
      ${proximos.length ? `<div style="${msgs.docs.length?'margin-top:12px; ':''}"><b>Lembretes</b>${proximos.map(({l, oc}) => `<div class="list-row"><div>${h(l.titulo)}</div><div class="num" style="font-size:12.5px;">${oc===hoje ? '<b style="color:#e07b00">hoje</b>' : dmy(oc)}</div></div>`).join('')}</div>` : ''}
    </div>`;
    if($('pnMsgAbrir')) $('pnMsgAbrir').onclick = ()=> abrirAgendas('mensagens');
  } catch(e){ el.innerHTML = ''; }
}

// ======================================================================
// MODAIS (criados uma vez)
// ======================================================================
function montarModais(){
  const wrap = document.createElement('div');
  wrap.innerHTML = `
  <div class="modal-backdrop" id="agModalPick"><div class="modal" style="max-width:520px; width:96vw; max-height:90vh; overflow:auto;">
    <h3 id="agPickTitulo"></h3>
    <div class="abas-hint" id="agPickResumo" style="margin-bottom:8px;"></div>
    <input id="agPickBusca" placeholder="Buscar pelo nome…" autocomplete="off" style="margin-bottom:8px;">
    <div id="agPickLista"></div>
    <div class="ag-sec-titulo">Pessoa de fora (não cadastrada)</div>
    <div class="grid grid-2"><input id="agPickLivre" placeholder="Nome (ex: Pr. Fulano — IC Itaú)"><input id="agPickLivreTel" placeholder="Telefone (opcional)"></div>
    <div class="modal-actions">
      <button class="btn" id="agPickCancelar">Cancelar</button>
      <button class="btn" id="agPickLimpar">Limpar escolha</button>
      <button class="btn btn-primary" id="agPickUsarLivre">Usar nome digitado</button>
    </div></div></div>

  <div class="modal-backdrop" id="agModalDup"><div class="modal" style="max-width:440px;">
    <h3 id="agDupTitulo">Duplicar</h3>
    <div class="field"><label id="agDupDestinoLbl">Destino</label><input type="date" id="agDupDestino"></div>
    <div class="field"><label style="display:flex; gap:8px; align-items:center; font-weight:400;"><input type="checkbox" id="agDupPessoas" style="width:16px;height:16px;"> Copiar também as pessoas escaladas (senão, só a estrutura)</label></div>
    <div class="field" style="display:flex;"><label style="display:flex; gap:8px; align-items:center; font-weight:400;"><input type="checkbox" id="agDupSubst" style="width:16px;height:16px;"> Substituir o que já existe na semana de destino</label></div>
    <div class="modal-actions"><button class="btn" id="agDupCancelar">Cancelar</button><button class="btn btn-primary" id="agDupOk">Duplicar</button></div></div></div>

  <div class="modal-backdrop" id="agModalCulto"><div class="modal" style="max-width:480px; width:96vw; max-height:92vh; overflow:auto;">
    <h3 id="agCultoTitulo">Culto padrão</h3>
    <div class="field"><label>Nome<span class="req">*</span></label><input id="agCultoNome" placeholder="Ex: Culto de Doutrina"></div>
    <div class="field"><label>Ícone (PNG/JPG — reduzido automaticamente)</label>
      <div class="ag-grade-icones"><img id="agCultoIconePrev" class="ag-ico" style="width:44px;height:44px;display:none;"><input type="file" id="agCultoIconeFile" accept="image/*"><button class="btn btn-sm" id="agCultoIconeRem" type="button">Remover</button></div></div>
    <div class="grid grid-2">
      <div class="field"><label>Horário padrão</label><input type="time" id="agCultoHora"></div>
      <div class="field"><label>Dia da semana</label><select id="agCultoDia"><option value="">—</option>${DIAS_LONGO.map((d,i)=>`<option value="${i}">${d}</option>`).join('')}</select></div>
    </div>
    <div class="field"><label>Funções (separadas por vírgula)</label><input id="agCultoFuncoes" placeholder="Direção, Leitura, Pregação"></div>
    <div class="field"><label>Observação padrão (opcional, aparece em laranja)</label><input id="agCultoObs" placeholder="Ex: DESAFIO: Decorar e recitar um versículo"></div>
    <div class="field"><label style="display:flex; gap:8px; align-items:center; font-weight:400;"><input type="checkbox" id="agCultoModelo" style="width:16px;height:16px;"> Entra na semana modelo (precisa de dia da semana)</label></div>
    <div class="modal-actions"><button class="btn" id="agCultoCancelar">Cancelar</button><button class="btn btn-primary" id="agCultoSalvar">Salvar</button></div></div></div>

  <div class="modal-backdrop" id="agModalLemb"><div class="modal" style="max-width:440px;">
    <h3 id="agLembTitulo">Lembrete</h3>
    <div class="field"><label>Título<span class="req">*</span></label><input id="agLembNome" placeholder="Ex: Aniversário da igreja"></div>
    <div class="grid grid-2"><div class="field"><label>Data<span class="req">*</span></label><input type="date" id="agLembData"></div>
    <div class="field"><label>Avisar quantos dias antes</label><input type="number" min="0" id="agLembAntec"></div></div>
    <div class="field"><label style="display:flex; gap:8px; align-items:center; font-weight:400;"><input type="checkbox" id="agLembRepete" style="width:16px;height:16px;"> Repete todo ano</label></div>
    <div class="field"><label style="display:flex; gap:8px; align-items:center; font-weight:400;"><input type="checkbox" id="agLembPast" style="width:16px;height:16px;"> Sugerir na Agenda Pastoral da semana</label></div>
    <div class="field"><label>Observação</label><input id="agLembObs"></div>
    <div class="modal-actions"><button class="btn" id="agLembCancelar">Cancelar</button><button class="btn btn-primary" id="agLembSalvar">Salvar</button></div></div></div>

  <div class="modal-backdrop" id="agModalGM"><div class="modal" style="max-width:460px;">
    <h3>Gerar mensagens da semana</h3>
    <div class="abas-hint" style="margin-bottom:10px;">Uma mensagem por pessoa escalada. Ao dirigente vai também a equipe do culto (sem o porteiro). Mensagens já geradas não são repetidas.</div>
    <div class="field"><label style="display:flex; gap:8px; align-items:center; font-weight:400;"><input type="checkbox" id="agGMEscala" style="width:16px;height:16px;"> Aviso de escala</label>
      <div class="grid grid-2" style="margin-top:6px;"><input type="date" id="agGMDataEscala"><input type="time" id="agGMHoraEscala"></div></div>
    <div class="field"><label style="display:flex; gap:8px; align-items:center; font-weight:400;"><input type="checkbox" id="agGMLemb" style="width:16px;height:16px;"> Lembrete no dia do culto, às</label>
      <input type="time" id="agGMHoraLemb" style="margin-top:6px;"></div>
    <div class="modal-actions"><button class="btn" id="agGMCancelar">Cancelar</button><button class="btn btn-primary" id="agGMOk">Gerar</button></div></div></div>

  <div class="modal-backdrop" id="agModalMsg"><div class="modal" style="max-width:480px; width:96vw;">
    <h3>Editar mensagem</h3>
    <div class="field"><label>Texto</label><textarea id="agMsgTexto" rows="8" style="width:100%;"></textarea></div>
    <div class="field"><label>Telefone (com DDD)</label><input id="agMsgTel"></div>
    <div class="grid grid-2"><div class="field"><label>Enviar em</label><input type="date" id="agMsgData"></div><div class="field"><label>Hora</label><input type="time" id="agMsgHora"></div></div>
    <div class="modal-actions"><button class="btn" id="agMsgCancelar">Cancelar</button><button class="btn btn-primary" id="agMsgSalvar">Salvar</button></div></div></div>

  <div class="modal-backdrop" id="agModalModelos"><div class="modal" style="max-width:560px; width:96vw; max-height:92vh; overflow:auto;">
    <h3>Textos-modelo das mensagens</h3>
    <div class="abas-hint" style="margin-bottom:8px;">Variáveis: {nome} {funcao} {culto} {dia} {data} {horario} {igreja} {equipe} ({equipe} só preenche para a Direção).</div>
    <div class="field"><label>Escala</label><textarea id="agMod_escala" rows="4" style="width:100%;"></textarea></div>
    <div class="field"><label>Lembrete no dia</label><textarea id="agMod_lembrete" rows="4" style="width:100%;"></textarea></div>
    <div class="field"><label>Troca de escala — quem saiu</label><textarea id="agMod_troca_saiu" rows="3" style="width:100%;"></textarea></div>
    <div class="field"><label>Troca de escala — quem entrou</label><textarea id="agMod_troca_entrou" rows="4" style="width:100%;"></textarea></div>
    <div class="modal-actions"><button class="btn" id="agModCancelar">Cancelar</button><button class="btn btn-primary" id="agModSalvar">Salvar</button></div></div></div>`;
  while(wrap.firstChild) document.body.appendChild(wrap.firstChild);

  const fechar = (id)=> $(id).classList.remove('active');
  $('agPickCancelar').onclick = ()=> fechar('agModalPick');
  $('agPickBusca').oninput = desenharPicker;
  $('agPickLista').onclick = (e)=>{
    const it = e.target.closest('[data-id]'); if(!it) return;
    const m = S.pool.find(x => x.id === it.dataset.id);
    escolherPessoa({ membroId: m.id, nome: m.exibe, tel: m.tel || '' });
  };
  $('agPickLimpar').onclick = ()=> escolherPessoa(null);
  $('agPickUsarLivre').onclick = ()=>{
    const n = $('agPickLivre').value.trim(); if(!n){ C.toast('Digite o nome da pessoa.', true); return; }
    escolherPessoa({ membroId: '', nome: n, tel: $('agPickLivreTel').value.trim() });
  };
  $('agDupCancelar').onclick = ()=> fechar('agModalDup'); $('agDupOk').onclick = confirmarDuplicar;
  $('agCultoCancelar').onclick = ()=> fechar('agModalCulto'); $('agCultoSalvar').onclick = salvarCulto;
  $('agCultoIconeFile').onchange = async (e)=>{
    const f = e.target.files[0]; if(!f) return;
    try{ S.cultoIconePendente = await reduzirImagemPng(f); atualizarPreviewIconeCulto(); } catch(err){ C.toast(err.message, true); }
  };
  $('agCultoIconeRem').onclick = ()=>{ S.cultoIconePendente = null; $('agCultoIconeFile').value = ''; atualizarPreviewIconeCulto(); };
  $('agLembCancelar').onclick = ()=> fechar('agModalLemb'); $('agLembSalvar').onclick = salvarLembrete;
  $('agGMCancelar').onclick = ()=> fechar('agModalGM'); $('agGMOk').onclick = gerarMensagens;
  $('agMsgCancelar').onclick = ()=> fechar('agModalMsg'); $('agMsgSalvar').onclick = salvarMsg;
  $('agModCancelar').onclick = ()=> fechar('agModalModelos'); $('agModSalvar').onclick = salvarModelos;
}
