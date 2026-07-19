import { firebaseConfig } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.0/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, signOut
} from "https://www.gstatic.com/firebasejs/10.14.0/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, deleteDoc,
  collection, collectionGroup, query, where, getDocs,
  addDoc, serverTimestamp, orderBy, writeBatch
} from "https://www.gstatic.com/firebasejs/10.14.0/firebase-firestore.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const MESES = ["Janeiro","Fevereiro","Março","Abril","Maio","Junho","Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"];
const PAPEL_LABEL = { admin: "Administrador", cadastrador: "Cadastrador", leitura: "Leitura" };

const hoje = new Date();
const state = {
  user: null,
  perfil: null,
  igrejas: [],          // [{id, nome, papel}]
  igrejaAtualId: null,
  categoriasReceita: [],
  categoriasDespesa: [],
  grupos: [],
  cargos: [],
  fieis: [],
  cadTab: "categoriasReceita",
  editandoLancId: null,
  editandoFielId: null,
};

// ---------- helpers ----------
function $(id){ return document.getElementById(id); }
function fmtBRL(v){ return (v||0).toLocaleString('pt-BR', {style:'currency', currency:'BRL'}); }
function toast(msg, isError){
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast active' + (isError ? ' error' : '');
  setTimeout(()=> t.className = 'toast', 2600);
}
function igrejaAtual(){ return state.igrejas.find(i => i.id === state.igrejaAtualId); }
function papelAtual(){ const ig = igrejaAtual(); return ig ? ig.papel : null; }
function podeEditar(){ return ['admin','cadastrador'].includes(papelAtual()); }
function isAdmin(){ return papelAtual() === 'admin'; }
function competenciaKey(ano, mes){ return `${ano}-${String(mes).padStart(2,'0')}`; }

function populaMesAno(selMesId, selAnoId){
  const selMes = $(selMesId), selAno = $(selAnoId);
  selMes.innerHTML = MESES.map((m,i)=>`<option value="${i+1}">${m}</option>`).join('');
  selMes.value = hoje.getMonth()+1;
  let anos = '';
  for(let a = hoje.getFullYear()-3; a <= hoje.getFullYear()+1; a++){
    anos += `<option value="${a}" ${a===hoje.getFullYear()?'selected':''}>${a}</option>`;
  }
  selAno.innerHTML = anos;
}

// ---------- AUTH ----------
let modoCadastro = false;
$('btnAuthToggle').addEventListener('click', ()=>{
  modoCadastro = !modoCadastro;
  $('fieldNome').style.display = modoCadastro ? 'block' : 'none';
  $('btnAuthSubmit').textContent = modoCadastro ? 'Criar conta' : 'Entrar';
  $('authSub').textContent = modoCadastro ? 'Financeiro de Igrejas — criar conta' : 'Financeiro de Igrejas — entrar';
  $('authToggleText').textContent = modoCadastro ? 'Já tem conta?' : 'Ainda não tem conta?';
  $('btnAuthToggle').textContent = modoCadastro ? 'Entrar' : 'Criar conta';
  $('authError').textContent = '';
});

$('btnAuthSubmit').addEventListener('click', async ()=>{
  const email = $('inputEmail').value.trim();
  const senha = $('inputSenha').value;
  $('authError').textContent = '';
  try{
    if(modoCadastro){
      const nome = $('inputNome').value.trim();
      if(!nome){ $('authError').textContent = 'Informe seu nome.'; return; }
      const cred = await createUserWithEmailAndPassword(auth, email, senha);
      await setDoc(doc(db, 'perfis', cred.user.uid), { nome, email, criadoEm: serverTimestamp() });
    } else {
      await signInWithEmailAndPassword(auth, email, senha);
    }
  } catch(e){
    $('authError').textContent = traduzErroAuth(e.code);
  }
});

function traduzErroAuth(code){
  const map = {
    'auth/invalid-email': 'E-mail inválido.',
    'auth/user-not-found': 'Usuário não encontrado.',
    'auth/wrong-password': 'Senha incorreta.',
    'auth/invalid-credential': 'E-mail ou senha incorretos.',
    'auth/email-already-in-use': 'Este e-mail já tem uma conta. Tente entrar.',
    'auth/weak-password': 'A senha precisa ter pelo menos 6 caracteres.',
  };
  return map[code] || 'Ocorreu um erro. Tente novamente.';
}

$('btnLogout').addEventListener('click', ()=> signOut(auth));

onAuthStateChanged(auth, async (user)=>{
  if(user){
    state.user = user;
    await carregarPerfil(user);
    await resgatarConvitesPendentes(user);
    await carregarIgrejasDoUsuario(user);
    $('authScreen').style.display = 'none';
    $('appShell').className = 'active';
  } else {
    state.user = null;
    $('authScreen').style.display = 'flex';
    $('appShell').className = '';
  }
});

async function carregarPerfil(user){
  const ref = doc(db, 'perfis', user.uid);
  const snap = await getDoc(ref);
  if(snap.exists()){
    state.perfil = snap.data();
  } else {
    state.perfil = { nome: user.email.split('@')[0], email: user.email };
    await setDoc(ref, { ...state.perfil, criadoEm: serverTimestamp() });
  }
  $('userNomeChip').textContent = state.perfil.nome;
}

// Verifica se existe convite (em qualquer igreja) para o e-mail do usuário logado
// e, se existir, cria automaticamente o vínculo igrejas/{id}/usuarios/{uid}.
async function resgatarConvitesPendentes(user){
  try{
    const q = query(collectionGroup(db, 'convites'), where('email', '==', user.email));
    const snaps = await getDocs(q);
    for(const convDoc of snaps.docs){
      const igrejaId = convDoc.ref.parent.parent.id;
      const dados = convDoc.data();
      await setDoc(doc(db, 'igrejas', igrejaId, 'usuarios', user.uid), {
        uid: user.uid, nome: state.perfil.nome, email: user.email,
        papel: dados.papel, criadoEm: serverTimestamp()
      });
      await deleteDoc(convDoc.ref);
    }
  } catch(e){ console.warn('Sem convites pendentes ou índice ainda não criado:', e.message); }
}

async function carregarIgrejasDoUsuario(user){
  const q = query(collectionGroup(db, 'usuarios'), where('uid', '==', user.uid));
  const snaps = await getDocs(q);
  state.igrejas = [];
  for(const d of snaps.docs){
    const igrejaId = d.ref.parent.parent.id;
    const igrejaSnap = await getDoc(doc(db, 'igrejas', igrejaId));
    if(igrejaSnap.exists()){
      state.igrejas.push({ id: igrejaId, nome: igrejaSnap.data().nome, papel: d.data().papel });
    }
  }
  const sel = $('igrejaSwitch');
  if(state.igrejas.length === 0){
    sel.innerHTML = `<option>Nenhuma igreja ainda</option>`;
    switchView('novaIgreja');
    return;
  }
  sel.innerHTML = state.igrejas.map(i => `<option value="${i.id}">${i.nome}</option>`).join('');
  state.igrejaAtualId = state.igrejas[0].id;
  sel.value = state.igrejaAtualId;
  await onIgrejaChange();
}

$('igrejaSwitch').addEventListener('change', async (e)=>{
  state.igrejaAtualId = e.target.value;
  await onIgrejaChange();
});

async function onIgrejaChange(){
  const papel = papelAtual();
  $('papelChip').textContent = PAPEL_LABEL[papel] || '—';
  $('navUsuarios').style.display = isAdmin() ? 'flex' : 'none';
  $('navImportar').style.display = isAdmin() ? 'flex' : 'none';
  await carregarDadosDaIgreja();
  refreshViewAtual();
}

async function carregarDadosDaIgreja(){
  const id = state.igrejaAtualId;
  if(!id) return;
  const [catR, catD, grp, crg, fie] = await Promise.all([
    getDocs(collection(db, 'igrejas', id, 'categoriasReceita')),
    getDocs(collection(db, 'igrejas', id, 'categoriasDespesa')),
    getDocs(collection(db, 'igrejas', id, 'grupos')),
    getDocs(collection(db, 'igrejas', id, 'cargos')),
    getDocs(collection(db, 'igrejas', id, 'membros')),
  ]);
  state.categoriasReceita = catR.docs.map(d=>({id:d.id, ...d.data()}));
  state.categoriasDespesa = catD.docs.map(d=>({id:d.id, ...d.data()}));
  state.grupos = grp.docs.map(d=>({id:d.id, ...d.data()}));
  state.cargos = crg.docs.map(d=>({id:d.id, ...d.data()}));
  state.fieis = fie.docs.map(d=>({id:d.id, ...d.data()}));
}

// ---------- NAVEGAÇÃO ----------
document.querySelectorAll('.nav-btn[data-view]').forEach(btn=>{
  btn.addEventListener('click', ()=> switchView(btn.dataset.view));
});
function switchView(name){
  document.querySelectorAll('.nav-btn[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view===name));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-'+name));
  refreshView(name);
}
function refreshViewAtual(){
  const active = document.querySelector('.nav-btn.active');
  if(active) refreshView(active.dataset.view);
}
function refreshView(name){
  if(!state.igrejaAtualId && name !== 'novaIgreja') return;
  const map = {
    painel: renderPainel, lancamentos: renderLancamentos, fieis: renderFieis,
    cadastros: renderCadastros, relatorios: renderRelatorios, competencias: renderCompetencias,
    igreja: renderIgreja, usuarios: renderUsuarios, novaIgreja: ()=>{},
    importar: renderImportar,
  };
  if(map[name]) map[name]();
}

// ---------- NOVA IGREJA (bootstrap) ----------
$('btnCriarIgreja').addEventListener('click', async ()=>{
  const nome = $('novaIgrejaNome').value.trim();
  if(!nome){ toast('Informe o nome da igreja.', true); return; }
  try{
    const igrejaRef = await addDoc(collection(db, 'igrejas'), {
      nome, pastor:'', tesoureiro:'', endereco:'', bairro:'', cidade:'', estado:'', cep:'',
      email:'', instagram:'', cnpj:'', criadoEm: serverTimestamp()
    });
    await setDoc(doc(db, 'igrejas', igrejaRef.id, 'usuarios', state.user.uid), {
      uid: state.user.uid, nome: state.perfil.nome, email: state.user.email,
      papel: 'admin', criadoEm: serverTimestamp()
    });
    // categorias padrão, com base no que a igreja já usava
    const receitasPadrao = ['Dízimo','Oferta de Culto','Oferta Avulsa'];
    const despesasPadrao = ['Prebenda Pastoral','Contas de Consumo','Manutenção'];
    for(const n of receitasPadrao) await addDoc(collection(db,'igrejas',igrejaRef.id,'categoriasReceita'), {nome:n});
    for(const n of despesasPadrao) await addDoc(collection(db,'igrejas',igrejaRef.id,'categoriasDespesa'), {nome:n});
    $('novaIgrejaNome').value = '';
    toast('Igreja criada!');
    await carregarIgrejasDoUsuario(state.user);
    state.igrejaAtualId = igrejaRef.id;
    $('igrejaSwitch').value = igrejaRef.id;
    await onIgrejaChange();
    switchView('painel');
  } catch(e){ toast('Erro ao criar igreja: '+e.message, true); }
});

// ---------- PAINEL ----------
let painelInit = false;
async function renderPainel(){
  if(!painelInit){ populaMesAno('painelMes','painelAno'); painelInit = true;
    $('painelMes').addEventListener('change', renderPainel);
    $('painelAno').addEventListener('change', renderPainel);
  }
  $('painelIgrejaNome').textContent = igrejaAtual()?.nome || '';
  const mes = parseInt($('painelMes').value), ano = parseInt($('painelAno').value);
  const lancs = await buscarLancamentos(mes, ano);
  const receitas = lancs.filter(l=>l.tipo==='receita').reduce((s,l)=>s+l.valor,0);
  const despesas = lancs.filter(l=>l.tipo==='despesa').reduce((s,l)=>s+l.valor,0);
  $('statReceitas').textContent = fmtBRL(receitas);
  $('statDespesas').textContent = fmtBRL(despesas);
  const saldoEl = $('statSaldo');
  saldoEl.textContent = fmtBRL(receitas-despesas);
  saldoEl.className = 'stat-value num ' + (receitas-despesas >= 0 ? 'green' : 'red');

  const ultimos = [...lancs].sort((a,b)=> (b.dataStr||'').localeCompare(a.dataStr||'')).slice(0,8);
  $('painelUltimos').innerHTML = ultimos.length ? ultimos.map(l => `
    <div class="list-row">
      <div>
        <span class="tag ${l.tipo}">${l.tipo}</span>
        <span style="margin-left:8px;">${l.categoriaNome||''}${l.descricao ? ' · '+l.descricao : ''}</span>
      </div>
      <div class="num">${fmtBRL(l.valor)}</div>
    </div>`).join('') : `<div class="empty">Nenhum lançamento neste mês.</div>`;
}

async function buscarLancamentos(mes, ano){
  const id = state.igrejaAtualId;
  const q = query(collection(db,'igrejas', id, 'lancamentos'), where('mes','==',mes), where('ano','==',ano));
  const snaps = await getDocs(q);
  return snaps.docs.map(d => ({id:d.id, ...d.data()}));
}

// ---------- LANÇAMENTOS ----------
let lancInit = false;
async function renderLancamentos(){
  if(!lancInit){
    populaMesAno('lancMes','lancAno'); lancInit = true;
    $('lancMes').addEventListener('change', renderLancamentos);
    $('lancAno').addEventListener('change', renderLancamentos);
    $('lancTipo').addEventListener('change', renderLancamentos);
  }
  const mes = parseInt($('lancMes').value), ano = parseInt($('lancAno').value);
  const tipoFiltro = $('lancTipo').value;
  let lancs = await buscarLancamentos(mes, ano);
  if(tipoFiltro) lancs = lancs.filter(l=>l.tipo===tipoFiltro);
  lancs.sort((a,b)=> (b.dataStr||'').localeCompare(a.dataStr||''));

  const editavel = podeEditar();
  $('btnNovoLancamento').style.display = editavel ? 'inline-flex' : 'none';
  $('lancEmpty').style.display = lancs.length ? 'none' : 'block';
  $('lancTbody').innerHTML = lancs.map(l => `
    <tr>
      <td>${l.dataStr ? formatarDataBR(l.dataStr) : '—'}</td>
      <td><span class="tag ${l.tipo}">${l.tipo}</span></td>
      <td>${l.categoriaNome||''}</td>
      <td>${l.descricao||'—'}</td>
      <td>${l.membroNome||'—'}</td>
      <td class="num">${fmtBRL(l.valor)}</td>
      <td>
        ${l.bloqueado ? '<span class="tag locked">bloqueado</span>' :
          (editavel ? `<button class="btn btn-sm" data-edit="${l.id}">Editar</button>
           <button class="btn btn-sm btn-danger" data-del="${l.id}">Excluir</button>` : '')}
      </td>
    </tr>`).join('');

  $('lancTbody').querySelectorAll('[data-edit]').forEach(b=>{
    b.addEventListener('click', ()=> abrirModalLancamento(lancs.find(l=>l.id===b.dataset.edit)));
  });
  $('lancTbody').querySelectorAll('[data-del]').forEach(b=>{
    b.addEventListener('click', async ()=>{
      if(!confirm('Excluir este lançamento?')) return;
      await deleteDoc(doc(db,'igrejas',state.igrejaAtualId,'lancamentos', b.dataset.del));
      toast('Lançamento excluído.');
      renderLancamentos(); renderPainel();
    });
  });
}
function formatarDataBR(iso){ const [y,m,d] = iso.split('-'); return `${d}/${m}/${y}`; }

$('btnNovoLancamento').addEventListener('click', ()=> abrirModalLancamento(null));
function abrirModalLancamento(lanc){
  state.editandoLancId = lanc ? lanc.id : null;
  $('modalLancTitulo').textContent = lanc ? 'Editar lançamento' : 'Novo lançamento';
  $('lFormTipo').value = lanc ? lanc.tipo : 'receita';
  $('lFormData').value = lanc ? lanc.dataStr : new Date().toISOString().slice(0,10);
  $('lFormDescricao').value = lanc ? (lanc.descricao||'') : '';
  $('lFormValor').value = lanc ? lanc.valor : '';
  popularCategoriaSelect();
  popularFielSelect();
  $('lFormCategoria').value = lanc ? lanc.categoriaId : '';
  $('lFormFiel').value = lanc ? (lanc.membroId||'') : '';
  $('modalLancamento').classList.add('active');
}
$('lFormTipo').addEventListener('change', popularCategoriaSelect);
function popularCategoriaSelect(){
  const tipo = $('lFormTipo').value;
  const lista = tipo === 'receita' ? state.categoriasReceita : state.categoriasDespesa;
  $('lFormCategoria').innerHTML = lista.map(c=>`<option value="${c.id}">${c.nome}</option>`).join('');
  $('lFormFielWrap').style.display = tipo === 'receita' ? 'block' : 'none';
}
function popularFielSelect(){
  $('lFormFiel').innerHTML = '<option value="">—</option>' + state.fieis.map(f=>`<option value="${f.id}">${f.nome}</option>`).join('');
}
$('btnCancelarLanc').addEventListener('click', ()=> $('modalLancamento').classList.remove('active'));
$('btnSalvarLanc').addEventListener('click', async ()=>{
  const tipo = $('lFormTipo').value;
  const dataStr = $('lFormData').value;
  const categoriaId = $('lFormCategoria').value;
  const valor = parseFloat($('lFormValor').value);
  if(!dataStr || !categoriaId || isNaN(valor)){ toast('Preencha data, categoria e valor.', true); return; }
  const [ano, mes] = dataStr.split('-').map(Number);
  const key = competenciaKey(ano, mes);
  const compSnap = await getDoc(doc(db,'igrejas',state.igrejaAtualId,'competencias', key));
  if(compSnap.exists() && compSnap.data().bloqueado && !state.editandoLancId){
    toast('Esta competência está bloqueada.', true); return;
  }
  const lista = tipo === 'receita' ? state.categoriasReceita : state.categoriasDespesa;
  const categoriaNome = lista.find(c=>c.id===categoriaId)?.nome || '';
  const membroId = $('lFormFiel').value || null;
  const membroNome = membroId ? state.fieis.find(f=>f.id===membroId)?.nome || '' : '';
  const payload = {
    tipo, dataStr, mes, ano, categoriaId, categoriaNome,
    descricao: $('lFormDescricao').value.trim(), valor,
    membroId, membroNome, bloqueado: false,
    criadoPor: state.user.uid, criadoPorNome: state.perfil.nome, atualizadoEm: serverTimestamp()
  };
  try{
    if(state.editandoLancId){
      await updateDoc(doc(db,'igrejas',state.igrejaAtualId,'lancamentos',state.editandoLancId), payload);
    } else {
      payload.criadoEm = serverTimestamp();
      await addDoc(collection(db,'igrejas',state.igrejaAtualId,'lancamentos'), payload);
    }
    $('modalLancamento').classList.remove('active');
    toast('Lançamento salvo!');
    renderLancamentos(); renderPainel();
  } catch(e){ toast('Erro ao salvar: '+e.message, true); }
});

// ---------- FIÉIS ----------
function renderFieis(){
  const editavel = podeEditar();
  $('btnNovoFiel').style.display = editavel ? 'inline-flex' : 'none';
  $('fieisEmpty').style.display = state.fieis.length ? 'none' : 'block';
  const fieis = [...state.fieis].sort((a,b)=> (a.nome||'').localeCompare(b.nome||''));
  $('fieisTbody').innerHTML = fieis.map(f => `
    <tr>
      <td>${f.nome}</td>
      <td>${cargoNome(f.cargoId)}</td>
      <td>${grupoNome(f.grupoId)}</td>
      <td>${f.telefone||'—'}</td>
      <td>${editavel ? `<button class="btn btn-sm" data-edit="${f.id}">Editar</button>
        <button class="btn btn-sm btn-danger" data-del="${f.id}">Excluir</button>` : ''}</td>
    </tr>`).join('');
  $('fieisTbody').querySelectorAll('[data-edit]').forEach(b=>{
    b.addEventListener('click', ()=> abrirModalFiel(state.fieis.find(f=>f.id===b.dataset.edit)));
  });
  $('fieisTbody').querySelectorAll('[data-del]').forEach(b=>{
    b.addEventListener('click', async ()=>{
      if(!confirm('Excluir este fiel?')) return;
      await deleteDoc(doc(db,'igrejas',state.igrejaAtualId,'membros', b.dataset.del));
      await carregarDadosDaIgreja();
      toast('Fiel removido.'); renderFieis();
    });
  });
}
function cargoNome(id){ return state.cargos.find(c=>c.id===id)?.nome || '—'; }
function grupoNome(id){ return state.grupos.find(g=>g.id===id)?.nome || '—'; }

$('btnNovoFiel').addEventListener('click', ()=> abrirModalFiel(null));
function abrirModalFiel(f){
  state.editandoFielId = f ? f.id : null;
  $('modalFielTitulo').textContent = f ? 'Editar fiel' : 'Novo fiel';
  $('fFormNome').value = f?.nome || '';
  $('fFormTelefone').value = f?.telefone || '';
  $('fFormEmail').value = f?.email || '';
  $('fFormCpf').value = f?.cpf || '';
  $('fFormObs').value = f?.observacoes || '';
  $('fFormCargo').innerHTML = '<option value="">—</option>' + state.cargos.map(c=>`<option value="${c.id}">${c.nome}</option>`).join('');
  $('fFormGrupo').innerHTML = '<option value="">—</option>' + state.grupos.map(g=>`<option value="${g.id}">${g.nome}</option>`).join('');
  $('fFormCargo').value = f?.cargoId || '';
  $('fFormGrupo').value = f?.grupoId || '';
  $('modalFiel').classList.add('active');
}
$('btnCancelarFiel').addEventListener('click', ()=> $('modalFiel').classList.remove('active'));
$('btnSalvarFiel').addEventListener('click', async ()=>{
  const nome = $('fFormNome').value.trim();
  if(!nome){ toast('Informe o nome.', true); return; }
  const payload = {
    nome, cargoId: $('fFormCargo').value || null, grupoId: $('fFormGrupo').value || null,
    telefone: $('fFormTelefone').value.trim(), email: $('fFormEmail').value.trim(),
    cpf: $('fFormCpf').value.trim(), observacoes: $('fFormObs').value.trim(),
  };
  try{
    if(state.editandoFielId){
      await updateDoc(doc(db,'igrejas',state.igrejaAtualId,'membros',state.editandoFielId), payload);
    } else {
      await addDoc(collection(db,'igrejas',state.igrejaAtualId,'membros'), payload);
    }
    $('modalFiel').classList.remove('active');
    await carregarDadosDaIgreja();
    toast('Fiel salvo!'); renderFieis();
  } catch(e){ toast('Erro ao salvar: '+e.message, true); }
});

// ---------- CADASTROS (categorias/grupos/cargos) ----------
document.querySelectorAll('.tab-btn').forEach(b=>{
  b.addEventListener('click', ()=>{
    document.querySelectorAll('.tab-btn').forEach(x=>x.classList.remove('active'));
    b.classList.add('active');
    state.cadTab = b.dataset.tab;
    renderCadastros();
  });
});
function renderCadastros(){
  const editavel = podeEditar();
  const lista = state[state.cadTab];
  $('cadNovoNome').parentElement.style.display = editavel ? 'flex' : 'none';
  $('cadLista').innerHTML = lista.length ? lista.map(item => `
    <div class="list-row">
      <span>${item.nome}</span>
      ${editavel ? `<button class="btn btn-sm btn-danger" data-del="${item.id}">Excluir</button>` : ''}
    </div>`).join('') : `<div class="empty">Nenhum item cadastrado.</div>`;
  $('cadLista').querySelectorAll('[data-del]').forEach(b=>{
    b.addEventListener('click', async ()=>{
      await deleteDoc(doc(db,'igrejas',state.igrejaAtualId, state.cadTab, b.dataset.del));
      await carregarDadosDaIgreja();
      toast('Item removido.'); renderCadastros();
    });
  });
}
$('btnCadAdd').addEventListener('click', async ()=>{
  const nome = $('cadNovoNome').value.trim();
  if(!nome){ return; }
  await addDoc(collection(db,'igrejas',state.igrejaAtualId, state.cadTab), {nome});
  $('cadNovoNome').value = '';
  await carregarDadosDaIgreja();
  toast('Item adicionado!'); renderCadastros();
});

// ---------- RELATÓRIOS ----------
let relInit = false;
async function renderRelatorios(){
  if(!relInit){
    populaMesAno('relMes','relAno'); relInit = true;
    $('relMes').addEventListener('change', renderRelatorios);
    $('relAno').addEventListener('change', renderRelatorios);
    $('relFiel').addEventListener('change', renderRelatorioFiel);
  }
  $('relFiel').innerHTML = '<option value="">Selecione um fiel...</option>' +
    [...state.fieis].sort((a,b)=>a.nome.localeCompare(b.nome)).map(f=>`<option value="${f.id}">${f.nome}</option>`).join('');

  const mes = parseInt($('relMes').value), ano = parseInt($('relAno').value);
  const lancs = await buscarLancamentos(mes, ano);
  $('relReceitas').innerHTML = agruparPorCategoria(lancs.filter(l=>l.tipo==='receita'));
  $('relDespesas').innerHTML = agruparPorCategoria(lancs.filter(l=>l.tipo==='despesa'));
  renderRelatorioFiel();
}
function agruparPorCategoria(lancs){
  const grupos = {};
  lancs.forEach(l => { grupos[l.categoriaNome] = (grupos[l.categoriaNome]||0) + l.valor; });
  const entradas = Object.entries(grupos).sort((a,b)=>b[1]-a[1]);
  if(!entradas.length) return `<div class="empty">Sem lançamentos neste mês.</div>`;
  return entradas.map(([nome,total]) => `
    <div class="list-row"><span>${nome}</span><span class="num">${fmtBRL(total)}</span></div>`).join('');
}
async function renderRelatorioFiel(){
  const fielId = $('relFiel').value;
  if(!fielId){ $('relFielResultado').innerHTML = ''; return; }
  const mes = parseInt($('relMes').value), ano = parseInt($('relAno').value);
  const lancs = (await buscarLancamentos(mes, ano)).filter(l=>l.membroId===fielId);
  const total = lancs.reduce((s,l)=>s+l.valor,0);
  $('relFielResultado').innerHTML = `
    <div class="list-row"><strong>Total no mês</strong><strong class="num">${fmtBRL(total)}</strong></div>
    ${lancs.map(l=>`<div class="list-row"><span>${formatarDataBR(l.dataStr)} · ${l.categoriaNome}</span><span class="num">${fmtBRL(l.valor)}</span></div>`).join('')}
    ${!lancs.length ? '<div class="empty">Nenhuma contribuição neste mês.</div>' : ''}
  `;
}

// ---------- COMPETÊNCIAS ----------
let compInit = false;
async function renderCompetencias(){
  if(!compInit){
    populaMesAno('compMes','compAno'); compInit = true;
  }
  $('btnToggleComp').style.display = isAdmin() ? 'inline-flex' : 'none';
  const snaps = await getDocs(query(collection(db,'igrejas',state.igrejaAtualId,'competencias'), orderBy('ano','desc')));
  const lista = snaps.docs.map(d=>({id:d.id, ...d.data()})).filter(c=>c.bloqueado);
  $('compLista').innerHTML = lista.length ? lista.map(c => `
    <div class="list-row"><span>${MESES[c.mes-1]} / ${c.ano}</span><span class="tag locked">bloqueado</span></div>
  `).join('') : `<div class="empty">Nenhuma competência bloqueada ainda.</div>`;
}
$('btnToggleComp').addEventListener('click', async ()=>{
  const mes = parseInt($('compMes').value), ano = parseInt($('compAno').value);
  const key = competenciaKey(ano, mes);
  const ref = doc(db,'igrejas',state.igrejaAtualId,'competencias', key);
  const snap = await getDoc(ref);
  const bloqueadoAtual = snap.exists() && snap.data().bloqueado;
  await setDoc(ref, {
    mes, ano, bloqueado: !bloqueadoAtual,
    bloqueadoPor: state.user.uid, bloqueadoEm: serverTimestamp()
  });
  toast(!bloqueadoAtual ? 'Competência bloqueada.' : 'Competência desbloqueada.');
  renderCompetencias();
});

// ---------- IGREJA ----------
async function renderIgreja(){
  const snap = await getDoc(doc(db,'igrejas',state.igrejaAtualId));
  const d = snap.data() || {};
  $('igNome').value = d.nome||''; $('igCnpj').value = d.cnpj||'';
  $('igPastor').value = d.pastor||''; $('igTesoureiro').value = d.tesoureiro||'';
  $('igEmail').value = d.email||''; $('igInstagram').value = d.instagram||'';
  $('igEndereco').value = d.endereco||''; $('igBairro').value = d.bairro||'';
  $('igCidade').value = d.cidade||''; $('igEstado').value = d.estado||''; $('igCep').value = d.cep||'';
  const editavel = isAdmin();
  document.querySelectorAll('#view-igreja input').forEach(i => i.disabled = !editavel);
  $('btnSalvarIgreja').style.display = editavel ? 'inline-flex' : 'none';
}
$('btnSalvarIgreja').addEventListener('click', async ()=>{
  const payload = {
    nome: $('igNome').value.trim(), cnpj: $('igCnpj').value.trim(),
    pastor: $('igPastor').value.trim(), tesoureiro: $('igTesoureiro').value.trim(),
    email: $('igEmail').value.trim(), instagram: $('igInstagram').value.trim(),
    endereco: $('igEndereco').value.trim(), bairro: $('igBairro').value.trim(),
    cidade: $('igCidade').value.trim(), estado: $('igEstado').value.trim(), cep: $('igCep').value.trim(),
  };
  try{
    await updateDoc(doc(db,'igrejas',state.igrejaAtualId), payload);
    toast('Dados da igreja atualizados!');
    await carregarIgrejasDoUsuario(state.user);
  } catch(e){ toast('Erro ao salvar: '+e.message, true); }
});

// ---------- USUÁRIOS ----------
async function renderUsuarios(){
  const usuariosSnap = await getDocs(collection(db,'igrejas',state.igrejaAtualId,'usuarios'));
  $('usuariosTbody').innerHTML = usuariosSnap.docs.map(d=>{
    const u = d.data();
    const souEu = d.id === state.user.uid;
    return `<tr>
      <td>${u.nome}${souEu ? ' (você)' : ''}</td><td>${u.email}</td>
      <td><span class="papel-badge">${PAPEL_LABEL[u.papel]}</span></td>
      <td>${!souEu ? `<button class="btn btn-sm btn-danger" data-del="${d.id}">Remover</button>` : ''}</td>
    </tr>`;
  }).join('');
  $('usuariosTbody').querySelectorAll('[data-del]').forEach(b=>{
    b.addEventListener('click', async ()=>{
      if(!confirm('Remover o acesso deste usuário a esta igreja?')) return;
      await deleteDoc(doc(db,'igrejas',state.igrejaAtualId,'usuarios', b.dataset.del));
      toast('Acesso removido.'); renderUsuarios();
    });
  });

  const convitesSnap = await getDocs(collection(db,'igrejas',state.igrejaAtualId,'convites'));
  $('convitesLista').innerHTML = convitesSnap.docs.length ? convitesSnap.docs.map(d=>{
    const c = d.data();
    return `<div class="list-row"><span>${c.email} — <span class="papel-badge">${PAPEL_LABEL[c.papel]}</span></span>
      <button class="btn btn-sm btn-danger" data-cancel="${d.id}">Cancelar</button></div>`;
  }).join('') : `<div class="empty">Nenhum convite pendente.</div>`;
  $('convitesLista').querySelectorAll('[data-cancel]').forEach(b=>{
    b.addEventListener('click', async ()=>{
      await deleteDoc(doc(db,'igrejas',state.igrejaAtualId,'convites', b.dataset.cancel));
      toast('Convite cancelado.'); renderUsuarios();
    });
  });
}
$('btnConvidarUsuario').addEventListener('click', ()=>{
  $('convFormEmail').value=''; $('convFormPapel').value='leitura';
  $('modalConvite').classList.add('active');
});
$('btnCancelarConvite').addEventListener('click', ()=> $('modalConvite').classList.remove('active'));
$('btnSalvarConvite').addEventListener('click', async ()=>{
  const email = $('convFormEmail').value.trim().toLowerCase();
  const papel = $('convFormPapel').value;
  if(!email){ toast('Informe o e-mail.', true); return; }
  try{
    await setDoc(doc(db,'igrejas',state.igrejaAtualId,'convites', email), {
      email, papel, criadoPor: state.user.uid, criadoEm: serverTimestamp()
    });
    $('modalConvite').classList.remove('active');
    toast('Convite criado! Peça para a pessoa entrar no app com esse e-mail.');
    renderUsuarios();
  } catch(e){ toast('Erro ao convidar: '+e.message, true); }
});

// ---------- EXPORTAR (XLSX) ----------
function nomeArquivoSeguro(txt){
  return (txt||'igreja').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^\w]+/g,'_');
}

$('btnExportarLanc').addEventListener('click', async ()=>{
  const mes = parseInt($('lancMes').value), ano = parseInt($('lancAno').value);
  const tipoFiltro = $('lancTipo').value;
  let lancs = await buscarLancamentos(mes, ano);
  if(tipoFiltro) lancs = lancs.filter(l=>l.tipo===tipoFiltro);
  if(!lancs.length){ toast('Nada para exportar neste período.', true); return; }
  lancs.sort((a,b)=> (a.dataStr||'').localeCompare(b.dataStr||''));
  const linhas = lancs.map(l => ({
    Data: l.dataStr ? formatarDataBR(l.dataStr) : '',
    Tipo: l.tipo === 'receita' ? 'Receita' : 'Despesa',
    Categoria: l.categoriaNome || '',
    Descrição: l.descricao || '',
    Fiel: l.membroNome || '',
    Valor: l.valor,
    Bloqueado: l.bloqueado ? 'Sim' : 'Não'
  }));
  const ws = XLSX.utils.json_to_sheet(linhas);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Lançamentos');
  XLSX.writeFile(wb, `lancamentos_${nomeArquivoSeguro(igrejaAtual()?.nome)}_${MESES[mes-1]}_${ano}.xlsx`);
  toast('Exportado!');
});

$('btnExportarFieis').addEventListener('click', ()=>{
  if(!state.fieis.length){ toast('Nenhum fiel para exportar.', true); return; }
  const linhas = [...state.fieis].sort((a,b)=>a.nome.localeCompare(b.nome)).map(f => ({
    Nome: f.nome, Cargo: cargoNome(f.cargoId), Grupo: grupoNome(f.grupoId),
    Telefone: f.telefone || '', Email: f.email || '', CPF: f.cpf || '', Observações: f.observacoes || ''
  }));
  const ws = XLSX.utils.json_to_sheet(linhas);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Fiéis');
  XLSX.writeFile(wb, `fieis_${nomeArquivoSeguro(igrejaAtual()?.nome)}.xlsx`);
  toast('Exportado!');
});

// ---------- IMPORTAR (migração da planilha do AppSheet) ----------
function renderImportar(){
  $('importIgrejaNome').textContent = igrejaAtual()?.nome || '';
  $('importLog').textContent = '';
}

$('btnBaixarModelo').addEventListener('click', ()=>{
  const wb = XLSX.utils.book_new();

  const instrucoes = [
    ['Como preencher esta planilha'],
    [''],
    ['1. Preencha uma linha por registro em cada aba. Apague as linhas de exemplo antes de importar de verdade.'],
    ['2. A coluna "ID" é um código único que você escolhe (ex: F1, F2, G1...) — use-o para ligar as abas entre si.'],
    ['3. Nas abas lanc_receita e lanc_despesa, "Descrição da Receita"/"Descrição da Despesa" devem conter o ID da'],
    ['   categoria correspondente (aba cad_receitas / cad_despesas), não o nome escrito.'],
    ['4. "Nome do Fiel" (aba lanc_receita) deve conter o ID do fiel (aba cad_fieis), não o nome escrito.'],
    ['5. "Grupos e Ministérios" (aba cad_fieis) deve conter o ID do grupo (aba cad_grupo).'],
    ['6. "Cargo/Função" (aba cad_fieis) pode ser texto livre, ex: "Pastor", "Membro" — não precisa ser um ID.'],
    ['7. "Responsável (Pastor)" e "Tesoureiro" (aba cad_igreja) devem conter o ID do fiel correspondente.'],
    ['8. A coluna "Data" (lanc_receita/lanc_despesa) deve estar em formato de data do Excel.'],
    ['9. "Competência" é só informativa, no formato "(01) Janeiro", "(02) Fevereiro"... O mês real usado pelo'],
    ['   app é sempre extraído da coluna "Data".'],
    ['10. "Bloqueio" / "Bloqueado?": deixe em branco se não estiver bloqueado, ou escreva'],
    ['    "Bloqueado para Edição" se estiver.'],
    ['11. Não precisa preencher todas as abas — só as que for usar.'],
    ['12. Comprovantes e fotos anexados não são importados nesta versão do app.'],
  ];
  const wsInstrucoes = XLSX.utils.aoa_to_sheet(instrucoes);
  wsInstrucoes['!cols'] = [{wch: 100}];
  XLSX.utils.book_append_sheet(wb, wsInstrucoes, 'Instruções');

  function addSheet(nomeAba, linhas, largura){
    const ws = XLSX.utils.json_to_sheet(linhas);
    if(largura) ws['!cols'] = largura.map(w => ({wch: w}));
    XLSX.utils.book_append_sheet(wb, ws, nomeAba);
  }

  addSheet('cad_grupo', [
    { ID:'G1', 'Nome do Grupo':'Jovens' },
    { ID:'G2', 'Nome do Grupo':'Senhoras' },
  ], [8, 24]);

  addSheet('cad_carg_func', [
    { ID:'C1', 'Descrição do Cargo/Função':'Pastor' },
    { ID:'C2', 'Descrição do Cargo/Função':'Membro' },
  ], [8, 28]);

  addSheet('cad_fieis', [
    { ID:'F1', Nome:'João da Silva', 'Cargo/Função':'Pastor', 'Data de Filiação':'', Telefone:'84999999999', Email:'joao@email.com', RG:'', CPF:'', 'Grupos e Ministérios':'G1', Observações:'' },
    { ID:'F2', Nome:'Maria Souza', 'Cargo/Função':'Membro', 'Data de Filiação':'', Telefone:'', Email:'', RG:'', CPF:'', 'Grupos e Ministérios':'G2', Observações:'' },
  ], [8, 22, 16, 16, 16, 22, 10, 14, 20, 20]);

  addSheet('cad_receitas', [
    { ID:'R1', Receitas:'Dízimo', valor:'' },
    { ID:'R2', Receitas:'Oferta de Culto', valor:'' },
  ], [8, 24, 10]);

  addSheet('cad_despesas', [
    { ID:'D1', Despesas:'Prebenda Pastoral', valor:'' },
    { ID:'D2', Despesas:'Contas de Consumo', valor:'' },
  ], [8, 24, 10]);

  addSheet('cad_igreja', [
    { ID:'I1', Igreja:'Igreja Exemplo', 'Responsável (Pastor)':'F1', Tesoureiro:'F2', 'Endereço':'Rua Principal, 100', Bairro:'Centro', Cidade:'Cidade Exemplo', Estado:'RN', Cep:'59000-000', 'E-mail':'contato@igreja.com', Instagram:'@igrejaexemplo', CNPJ:'00.000.000/0001-00' },
  ], [8, 22, 18, 14, 26, 14, 18, 8, 12, 22, 18, 20]);

  addSheet('lanc_receita', [
    { ID:'LR1', Data: new Date(2025,0,5), 'Competência':'(01) Janeiro', 'Descrição da Receita':'R1', Detalhamento:'', Valor:100, 'Nome do Fiel':'F1', Ano:2025, Concatenar:'', Bloqueio:'', 'Comprovante da Receita':'', 'Anexar Foto':'', 'Anexar Arquivo':'' },
  ], [8, 12, 16, 20, 16, 10, 14, 8, 12, 22, 10, 10]);

  addSheet('lanc_despesa', [
    { ID:'LD1', Data: new Date(2025,0,10), 'Competência':'(01) Janeiro', 'Descrição da Despesa':'D1', Detalhamento:'', Valor:50, Ano:2025, Concatenar:'', Bloqueio:'', 'Comprovante da Despesa':'', 'Anexar Foto':'', 'Anexar Arquivo':'' },
  ], [8, 12, 16, 20, 16, 10, 8, 12, 22, 10, 10]);

  addSheet('bloq_competencia', [
    { ID:'BC1', 'Mês Competência':'(01) Janeiro', 'Ano Competência':2025, Concatenar:'', 'Bloqueado?':'' },
  ], [8, 18, 16, 14, 20]);

  XLSX.writeFile(wb, 'modelo_importacao_soft_financeiro.xlsx');
  toast('Modelo baixado!');
});

function logImport(msg){
  const el = $('importLog');
  el.textContent += msg + '\n';
  el.scrollTop = el.scrollHeight;
}

function linhasDaAba(wb, nomeAba, campoObrigatorio){
  const sheet = wb.Sheets[nomeAba];
  if(!sheet) return [];
  const linhas = XLSX.utils.sheet_to_json(sheet, { defval: null });
  return linhas.filter(l => l['ID'] && (!campoObrigatorio || l[campoObrigatorio] !== null));
}

async function commitEmLotes(colRefFn, itens, transform){
  let batch = writeBatch(db);
  let count = 0, total = 0;
  for(const item of itens){
    const payload = transform(item);
    if(!payload) continue;
    batch.set(doc(colRefFn()), payload);
    count++; total++;
    if(count >= 400){ await batch.commit(); batch = writeBatch(db); count = 0; logImport(`  ...${total} processados`); }
  }
  if(count > 0) await batch.commit();
  return total;
}

$('btnImportar').addEventListener('click', async ()=>{
  if(!isAdmin()){ toast('Só administradores podem importar.', true); return; }
  const file = $('importArquivo').files[0];
  if(!file){ toast('Selecione o arquivo .xlsx primeiro.', true); return; }
  const btn = $('btnImportar');
  btn.disabled = true; btn.textContent = 'Importando...';
  $('importLog').textContent = '';
  const igrejaId = state.igrejaAtualId;

  try{
    logImport('Lendo planilha...');
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array', cellDates: true });

    // 1) Grupos
    const mapGrupo = {};
    const grupos = linhasDaAba(wb, 'cad_grupo', 'Nome do Grupo');
    for(const g of grupos){
      const ref = await addDoc(collection(db,'igrejas',igrejaId,'grupos'), { nome: g['Nome do Grupo'] || '' });
      mapGrupo[g.ID] = { id: ref.id, nome: g['Nome do Grupo'] || '' };
    }
    logImport(`✓ ${grupos.length} grupos importados`);

    // 2) Cargos (lista de referência, casados por nome)
    const mapCargoPorNome = {};
    const cargos = linhasDaAba(wb, 'cad_carg_func', 'Descrição do Cargo/Função');
    for(const c of cargos){
      const nome = (c['Descrição do Cargo/Função'] || '').toString().trim();
      if(!nome) continue;
      const ref = await addDoc(collection(db,'igrejas',igrejaId,'cargos'), { nome });
      mapCargoPorNome[nome.toLowerCase()] = ref.id;
    }
    logImport(`✓ ${cargos.length} cargos importados`);

    // 3) Fiéis
    const mapFiel = {};
    const fieis = linhasDaAba(wb, 'cad_fieis', 'Nome');
    for(const f of fieis){
      const nomeCargo = (f['Cargo/Função'] || '').toString().trim();
      let cargoId = nomeCargo ? mapCargoPorNome[nomeCargo.toLowerCase()] : null;
      if(nomeCargo && !cargoId){
        const ref = await addDoc(collection(db,'igrejas',igrejaId,'cargos'), { nome: nomeCargo });
        cargoId = ref.id;
        mapCargoPorNome[nomeCargo.toLowerCase()] = cargoId;
      }
      const grupoRef = f['Grupos e Ministérios'] ? mapGrupo[f['Grupos e Ministérios']] : null;
      const ref = await addDoc(collection(db,'igrejas',igrejaId,'membros'), {
        nome: f['Nome'] || '',
        cargoId: cargoId || null,
        grupoId: grupoRef ? grupoRef.id : null,
        telefone: f['Telefone'] != null ? String(f['Telefone']) : '',
        email: f['Email'] || '',
        cpf: f['CPF'] != null ? String(f['CPF']) : '',
        rg: f['RG'] != null ? String(f['RG']) : '',
        observacoes: f['Observações'] || '',
      });
      mapFiel[f.ID] = { id: ref.id, nome: f['Nome'] || '' };
    }
    logImport(`✓ ${fieis.length} fiéis importados`);

    // 4) Categorias de receita
    const mapCatReceita = {};
    const catsReceita = linhasDaAba(wb, 'cad_receitas', 'Receitas');
    for(const c of catsReceita){
      const nome = c['Receitas'] || '';
      if(!nome) continue;
      const ref = await addDoc(collection(db,'igrejas',igrejaId,'categoriasReceita'), { nome });
      mapCatReceita[c.ID] = { id: ref.id, nome };
    }
    logImport(`✓ ${catsReceita.length} categorias de receita importadas`);

    // 5) Categorias de despesa
    const mapCatDespesa = {};
    const catsDespesa = linhasDaAba(wb, 'cad_despesas', 'Despesas');
    for(const c of catsDespesa){
      const nome = c['Despesas'] || '';
      if(!nome) continue;
      const ref = await addDoc(collection(db,'igrejas',igrejaId,'categoriasDespesa'), { nome });
      mapCatDespesa[c.ID] = { id: ref.id, nome };
    }
    logImport(`✓ ${catsDespesa.length} categorias de despesa importadas`);

    // 6) Dados da igreja
    const igrejaRows = linhasDaAba(wb, 'cad_igreja', 'Igreja');
    if(igrejaRows.length){
      const ig = igrejaRows[0];
      const pastorNome = ig['Responsável (Pastor)'] ? (mapFiel[ig['Responsável (Pastor)']]?.nome || '') : '';
      const tesoureiroNome = ig['Tesoureiro'] ? (mapFiel[ig['Tesoureiro']]?.nome || '') : '';
      await updateDoc(doc(db,'igrejas',igrejaId), {
        nome: ig['Igreja'] || igrejaAtual().nome,
        pastor: pastorNome, tesoureiro: tesoureiroNome,
        endereco: ig['Endereço'] || '', bairro: ig['Bairro'] || '', cidade: ig['Cidade'] || '',
        estado: ig['Estado'] || '', cep: ig['Cep'] != null ? String(ig['Cep']) : '',
        email: ig['E-mail'] || '', instagram: ig['Instagram'] || '',
        cnpj: ig['CNPJ'] != null ? String(ig['CNPJ']) : '',
      });
      logImport('✓ Dados da igreja atualizados');
    }

    // 7) Lançamentos de receita (em lotes)
    const receitaRows = linhasDaAba(wb, 'lanc_receita', 'Valor');
    logImport(`Importando ${receitaRows.length} receitas...`);
    const totalReceitas = await commitEmLotes(
      () => collection(db,'igrejas',igrejaId,'lancamentos'),
      receitaRows,
      (r) => {
        const dataObj = r['Data'] instanceof Date ? r['Data'] : null;
        if(!dataObj || typeof r['Valor'] !== 'number') return null;
        const ano = r['Ano'] ? Math.round(r['Ano']) : dataObj.getFullYear();
        const mes = dataObj.getMonth() + 1;
        const cat = r['Descrição da Receita'] ? mapCatReceita[r['Descrição da Receita']] : null;
        const fiel = r['Nome do Fiel'] ? mapFiel[r['Nome do Fiel']] : null;
        return {
          tipo: 'receita', dataStr: dataObj.toISOString().slice(0,10), mes, ano,
          categoriaId: cat ? cat.id : null, categoriaNome: cat ? cat.nome : '',
          descricao: r['Detalhamento'] || '', valor: r['Valor'],
          membroId: fiel ? fiel.id : null, membroNome: fiel ? fiel.nome : '',
          bloqueado: !!r['Bloqueio'],
          criadoPor: state.user.uid, criadoPorNome: state.perfil.nome,
          criadoEm: serverTimestamp(), importado: true,
        };
      }
    );
    logImport(`✓ ${totalReceitas} receitas importadas`);

    // 8) Lançamentos de despesa (em lotes)
    const despesaRows = linhasDaAba(wb, 'lanc_despesa', 'Valor');
    logImport(`Importando ${despesaRows.length} despesas...`);
    const totalDespesas = await commitEmLotes(
      () => collection(db,'igrejas',igrejaId,'lancamentos'),
      despesaRows,
      (r) => {
        const dataObj = r['Data'] instanceof Date ? r['Data'] : null;
        if(!dataObj || typeof r['Valor'] !== 'number') return null;
        const ano = r['Ano'] ? Math.round(r['Ano']) : dataObj.getFullYear();
        const mes = dataObj.getMonth() + 1;
        const cat = r['Descrição da Despesa'] ? mapCatDespesa[r['Descrição da Despesa']] : null;
        return {
          tipo: 'despesa', dataStr: dataObj.toISOString().slice(0,10), mes, ano,
          categoriaId: cat ? cat.id : null, categoriaNome: cat ? cat.nome : '',
          descricao: r['Detalhamento'] || '', valor: r['Valor'],
          membroId: null, membroNome: '',
          bloqueado: !!r['Bloqueio'],
          criadoPor: state.user.uid, criadoPorNome: state.perfil.nome,
          criadoEm: serverTimestamp(), importado: true,
        };
      }
    );
    logImport(`✓ ${totalDespesas} despesas importadas`);

    // 9) Competências bloqueadas
    const bloqRows = linhasDaAba(wb, 'bloq_competencia', 'Mês Competência');
    const jaProcessado = new Set();
    let totalComp = 0;
    for(const b of bloqRows){
      const mesTxt = b['Mês Competência'];
      const ano = b['Ano Competência'] ? Math.round(b['Ano Competência']) : null;
      if(!mesTxt || !ano) continue;
      const match = mesTxt.match(/\((\d+)\)/);
      const mesNum = match ? parseInt(match[1]) : null;
      if(!mesNum) continue;
      const key = competenciaKey(ano, mesNum);
      if(jaProcessado.has(key)) continue;
      jaProcessado.add(key);
      await setDoc(doc(db,'igrejas',igrejaId,'competencias', key), {
        mes: mesNum, ano,
        bloqueado: (b['Bloqueado?'] || '').toString().includes('Bloqueado'),
        bloqueadoPor: state.user.uid, bloqueadoEm: serverTimestamp(),
      });
      totalComp++;
    }
    logImport(`✓ ${totalComp} competências importadas`);

    logImport('\n✅ Importação concluída com sucesso!');
    toast('Importação concluída!');
    await carregarDadosDaIgreja();
    await carregarIgrejasDoUsuario(state.user);
  } catch(e){
    logImport('\n❌ Erro durante a importação: ' + e.message);
    toast('Erro na importação — veja o log.', true);
  } finally {
    btn.disabled = false; btn.textContent = 'Iniciar importação';
  }
});
