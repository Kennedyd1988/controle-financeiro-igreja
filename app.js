import { firebaseConfig } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.0/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, signOut
} from "https://www.gstatic.com/firebasejs/10.14.0/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, deleteDoc,
  collection, query, where, getDocs, limit, startAfter,
  addDoc, serverTimestamp, orderBy, writeBatch,
  getAggregateFromServer, sum
} from "https://www.gstatic.com/firebasejs/10.14.0/firebase-firestore.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const MESES = ["Janeiro","Fevereiro","Março","Abril","Maio","Junho","Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"];
const PAPEL_LABEL = { admin: "Administrador", cadastrador: "Cadastrador", leitura: "Leitura" };

// Abas que podem ser liberadas/bloqueadas individualmente por usuário.
// Painel e Dados da Igreja (visualização) ficam sempre visíveis para quem é
// membro; Usuários e Importar dados são sempre exclusivos de Administrador.
const ABAS_CONFIGURAVEIS = [
  { id: 'lancamentos', label: 'Lançamentos' },
  { id: 'fieis', label: 'Fiéis' },
  { id: 'cadastros', label: 'Categorias e Grupos' },
  { id: 'relatorios', label: 'Relatórios' },
  { id: 'competencias', label: 'Competências' },
];
const TODAS_ABAS = ABAS_CONFIGURAVEIS.map(a => a.id);

const hoje = new Date();
const state = {
  user: null,
  perfil: null,
  igrejas: [],          // [{id, nome, papel, abas}]
  igrejaAtualId: null,
  igrejaDados: {},       // dados completos da igreja atual (inclui logo)
  categoriasReceita: [],
  categoriasDespesa: [],
  grupos: [],
  cargos: [],
  fieis: [],
  cadTab: "categoriasReceita",
  editandoLancId: null,
  editandoFielId: null,
  editandoUsuarioUid: null,
  logoPendente: undefined, // undefined = não mexeu; null = removida; string = nova
  fieisPagina: [],     // fiéis carregados na tela atual (paginado)
  fieisCursor: null,   // último doc da página, para "carregar mais"
  fieisTemMais: false,
  fieisBuscaAtual: '',
  lancPagina: [],
  lancCursor: null,
  lancTemMais: false,
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
function abasAtual(){ const ig = igrejaAtual(); return (ig && Array.isArray(ig.abas)) ? ig.abas : TODAS_ABAS; }
function temAcesso(aba){ return isAdmin() || abasAtual().includes(aba); }
function podeEditar(){ return ['admin','cadastrador'].includes(papelAtual()); }
function podeEditarAba(aba){ return temAcesso(aba) && podeEditar(); }
function isAdmin(){ return papelAtual() === 'admin'; }
function competenciaKey(ano, mes){ return `${ano}-${String(mes).padStart(2,'0')}`; }

// Validação simples de campos obrigatórios: destaca em vermelho e avisa.
function validarObrigatorios(campos){
  let faltando = [];
  for(const c of campos){
    const el = $(c.id);
    const vazio = !el.value || !el.value.toString().trim();
    el.classList.toggle('input-error', vazio);
    if(vazio) faltando.push(c.nome);
  }
  if(faltando.length){ toast('Preencha: ' + faltando.join(', '), true); return false; }
  return true;
}

function renderAbasCheckboxes(containerId, selecionadas){
  const lista = selecionadas || TODAS_ABAS;
  $(containerId).innerHTML = ABAS_CONFIGURAVEIS.map(a => `
    <label><input type="checkbox" value="${a.id}" ${lista.includes(a.id) ? 'checked' : ''}> ${a.label}</label>
  `).join('');
}
function lerAbasCheckboxes(containerId){
  return Array.from($(containerId).querySelectorAll('input[type=checkbox]:checked')).map(i => i.value);
}

const FIEIS_POR_PAGINA = 50;

// Busca fiéis em páginas de 50 (por nome, com ou sem termo de busca por
// prefixo) em vez de carregar a lista inteira de uma vez — assim a tela
// continua rápida mesmo com muitos milhares de fiéis cadastrados.
async function buscarFieisPagina(reiniciar){
  const id = state.igrejaAtualId;
  if(reiniciar){ state.fieisPagina = []; state.fieisCursor = null; state.fieisTemMais = false; }
  const termo = state.fieisBuscaAtual.trim();
  const base = collection(db, 'igrejas', id, 'membros');
  const filtros = termo
    ? [orderBy('nome'), where('nome','>=',termo), where('nome','<=',termo+'\uf8ff')]
    : [orderBy('nome')];
  const cursorArg = state.fieisCursor ? [startAfter(state.fieisCursor)] : [];
  const q = query(base, ...filtros, ...cursorArg, limit(FIEIS_POR_PAGINA));
  const snaps = await getDocs(q);
  const novos = snaps.docs.map(d => ({ id:d.id, ...d.data() }));
  state.fieisPagina = reiniciar ? novos : [...state.fieisPagina, ...novos];
  if(snaps.docs.length) state.fieisCursor = snaps.docs[snaps.docs.length - 1];
  state.fieisTemMais = snaps.docs.length === FIEIS_POR_PAGINA;
}

// Combobox de busca de fiel (usado no formulário de lançamento e no filtro
// de relatórios) — busca por prefixo do nome direto no Firestore, sem
// precisar carregar a lista inteira de fiéis na memória do navegador.
function configurarComboboxFiel(inputBuscaId, inputHiddenId, listaId, onSelecionar){
  const inputBusca = $(inputBuscaId), inputHidden = $(inputHiddenId), lista = $(listaId);
  let timer = null;
  inputBusca.addEventListener('input', ()=>{
    inputHidden.value = '';
    clearTimeout(timer);
    const termo = inputBusca.value.trim();
    if(!termo){ lista.classList.remove('active'); lista.innerHTML=''; return; }
    timer = setTimeout(async ()=>{
      const base = collection(db, 'igrejas', state.igrejaAtualId, 'membros');
      const q = query(base, orderBy('nome'), where('nome','>=',termo), where('nome','<=',termo+'\uf8ff'), limit(8));
      let snaps;
      try{ snaps = await getDocs(q); } catch(e){ return; }
      const itens = snaps.docs.map(d => ({ id:d.id, nome:d.data().nome }));
      lista.innerHTML = itens.length
        ? itens.map(f => `<div class="combo-item" data-id="${f.id}" data-nome="${f.nome}">${f.nome}</div>`).join('')
        : `<div class="combo-item vazio">Nenhum fiel encontrado</div>`;
      lista.classList.add('active');
      lista.querySelectorAll('.combo-item[data-id]').forEach(item=>{
        item.addEventListener('click', ()=>{
          inputBusca.value = item.dataset.nome;
          inputHidden.value = item.dataset.id;
          lista.classList.remove('active');
          if(onSelecionar) onSelecionar(item.dataset.id, item.dataset.nome);
        });
      });
    }, 300);
  });
  document.addEventListener('click', (e)=>{
    if(!inputBusca.contains(e.target) && !lista.contains(e.target)) lista.classList.remove('active');
  });
}

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

// Verifica se existe convite (em qualquer igreja) para o e-mail do usuário logado,
// consultando o índice "convitesIndice" (coleção de nível raiz — evitamos
// collectionGroup, que o Firestore trata de forma mais restrita nas regras).
async function resgatarConvitesPendentes(user){
  try{
    const q = query(collection(db, 'convitesIndice'), where('email', '==', user.email));
    const snaps = await getDocs(q);
    for(const convDoc of snaps.docs){
      const dados = convDoc.data();
      const igrejaId = dados.igrejaId;
      const abas = dados.abas || TODAS_ABAS;
      await setDoc(doc(db, 'igrejas', igrejaId, 'usuarios', user.uid), {
        uid: user.uid, nome: state.perfil.nome, email: user.email,
        papel: dados.papel, abasPermitidas: abas, criadoEm: serverTimestamp()
      });
      await setDoc(doc(db, 'membrosIndice', `${igrejaId}_${user.uid}`), {
        uid: user.uid, igrejaId, igrejaNome: dados.igrejaNome || '',
        papel: dados.papel, abas, nome: state.perfil.nome, email: user.email
      });
      await deleteDoc(doc(db, 'igrejas', igrejaId, 'convites', user.email));
      await deleteDoc(convDoc.ref);
    }
  } catch(e){ console.warn('Sem convites pendentes:', e.message); }
}

// Busca em quais igrejas o usuário está, consultando o índice "membrosIndice"
// (coleção de nível raiz, uma consulta simples e direta por uid).
async function carregarIgrejasDoUsuario(user){
  const q = query(collection(db, 'membrosIndice'), where('uid', '==', user.uid));
  const snaps = await getDocs(q);
  state.igrejas = snaps.docs.map(d => {
    const dado = d.data();
    return { id: dado.igrejaId, nome: dado.igrejaNome, papel: dado.papel, abas: dado.abas || TODAS_ABAS };
  });
  const sel = $('igrejaSwitch');
  if(state.igrejas.length === 0){
    sel.innerHTML = `<option>Nenhuma igreja ainda</option>`;
    switchView('novaIgreja');
    return;
  }
  sel.innerHTML = state.igrejas.map(i => `<option value="${i.id}">${i.nome}</option>`).join('');
  if(!state.igrejaAtualId || !state.igrejas.some(i => i.id === state.igrejaAtualId)){
    state.igrejaAtualId = state.igrejas[0].id;
  }
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
  ABAS_CONFIGURAVEIS.forEach(a => {
    const btn = document.querySelector(`.nav-btn[data-view="${a.id}"]`);
    if(btn) btn.style.display = temAcesso(a.id) ? 'flex' : 'none';
  });
  // reseta paginação/busca de fiéis, senão mostraria dados da igreja anterior
  state.fieisPagina = []; state.fieisCursor = null; state.fieisTemMais = false; state.fieisBuscaAtual = '';
  if($('fieisBusca')) $('fieisBusca').value = '';
  await carregarDadosDaIgreja();
  aplicarLogoSidebar();
  // se a aba atualmente aberta não é mais acessível, volta pro painel
  const ativo = document.querySelector('.nav-btn.active');
  if(ativo && ativo.style.display === 'none') switchView('painel');
  refreshViewAtual();
}

async function buscarSeguro(promessa, vazio){
  try{ const snap = await promessa; return snap.docs.map(d=>({id:d.id, ...d.data()})); }
  catch(e){ return vazio; }
}
async function carregarDadosDaIgreja(){
  const id = state.igrejaAtualId;
  if(!id) return;
  const temCadastros = temAcesso('cadastros');
  const [igSnap, catR, catD, grp, crg] = await Promise.all([
    getDoc(doc(db, 'igrejas', id)).catch(()=>({ exists:()=>false })),
    temCadastros ? buscarSeguro(getDocs(collection(db,'igrejas',id,'categoriasReceita')), []) : [],
    temCadastros ? buscarSeguro(getDocs(collection(db,'igrejas',id,'categoriasDespesa')), []) : [],
    temCadastros ? buscarSeguro(getDocs(collection(db,'igrejas',id,'grupos')), []) : [],
    temCadastros ? buscarSeguro(getDocs(collection(db,'igrejas',id,'cargos')), []) : [],
  ]);
  state.igrejaDados = igSnap.exists() ? igSnap.data() : {};
  state.categoriasReceita = catR;
  state.categoriasDespesa = catD;
  state.grupos = grp;
  state.cargos = crg;
  // Fiéis não são mais carregados por inteiro aqui — a lista cresce sem
  // limite com o tempo, então cada tela busca só o que precisa (ver
  // buscarFieisPagina e a busca com combobox).
}

function aplicarLogoSidebar(){
  const logo = state.igrejaDados.logo;
  const img = $('sidebarLogo');
  if(logo){ img.src = logo; img.style.display = 'inline-block'; }
  else { img.style.display = 'none'; }
}

configurarComboboxFiel('lFormFielBusca', 'lFormFiel', 'lFormFielLista');
configurarComboboxFiel('relFielBusca', 'relFiel', 'relFielLista', ()=> renderRelatorioFiel());

// ---------- MENU MOBILE (gaveta) ----------
function abrirMenuMobile(){
  $('sidebar').classList.add('open');
  $('sidebarOverlay').classList.add('active');
}
function fecharMenuMobile(){
  $('sidebar').classList.remove('open');
  $('sidebarOverlay').classList.remove('active');
}
$('btnMenuMobile').addEventListener('click', abrirMenuMobile);
$('sidebarOverlay').addEventListener('click', fecharMenuMobile);

// ---------- NAVEGAÇÃO ----------
document.querySelectorAll('.nav-btn[data-view]').forEach(btn=>{
  btn.addEventListener('click', ()=>{ switchView(btn.dataset.view); fecharMenuMobile(); });
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
  if(!validarObrigatorios([{id:'novaIgrejaNome', nome:'Nome da igreja'}])) return;
  const nome = $('novaIgrejaNome').value.trim();
  try{
    const igrejaRef = await addDoc(collection(db, 'igrejas'), {
      nome, pastor:'', tesoureiro:'', endereco:'', bairro:'', cidade:'', estado:'', cep:'',
      email:'', instagram:'', cnpj:'', logo:null, criadoEm: serverTimestamp()
    });
    await setDoc(doc(db, 'igrejas', igrejaRef.id, 'usuarios', state.user.uid), {
      uid: state.user.uid, nome: state.perfil.nome, email: state.user.email,
      papel: 'admin', abasPermitidas: TODAS_ABAS, criadoEm: serverTimestamp()
    });
    await setDoc(doc(db, 'membrosIndice', `${igrejaRef.id}_${state.user.uid}`), {
      uid: state.user.uid, igrejaId: igrejaRef.id, igrejaNome: nome,
      papel: 'admin', abas: TODAS_ABAS, nome: state.perfil.nome, email: state.user.email
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
  if(!temAcesso('lancamentos')){
    $('statReceitas').textContent = '—'; $('statDespesas').textContent = '—'; $('statSaldo').textContent = '—';
    $('painelUltimos').innerHTML = `<div class="empty">Você não tem acesso aos lançamentos financeiros. Fale com um administrador da igreja.</div>`;
    return;
  }
  const mes = parseInt($('painelMes').value), ano = parseInt($('painelAno').value);
  const [receitas, despesas, ultimos] = await Promise.all([
    somarLancamentos(mes, ano, 'receita'),
    somarLancamentos(mes, ano, 'despesa'),
    ultimosLancamentosDoMes(mes, ano, 8),
  ]);
  $('statReceitas').textContent = fmtBRL(receitas);
  $('statDespesas').textContent = fmtBRL(despesas);
  const saldoEl = $('statSaldo');
  saldoEl.textContent = fmtBRL(receitas-despesas);
  saldoEl.className = 'stat-value num ' + (receitas-despesas >= 0 ? 'green' : 'red');

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

// Busca só os últimos N lançamentos do mês (para o Painel), em vez de baixar
// o mês inteiro. Se o índice necessário ainda não existir, recorre à busca
// completa do mês como respaldo (mesmo comportamento de antes).
async function ultimosLancamentosDoMes(mes, ano, qtde){
  const id = state.igrejaAtualId;
  try{
    const q = query(collection(db,'igrejas', id, 'lancamentos'),
      where('mes','==',mes), where('ano','==',ano), orderBy('dataStr','desc'), limit(qtde));
    const snaps = await getDocs(q);
    return snaps.docs.map(d => ({id:d.id, ...d.data()}));
  } catch(e){
    const todos = await buscarLancamentos(mes, ano);
    return todos.sort((a,b)=> (b.dataStr||'').localeCompare(a.dataStr||'')).slice(0, qtde);
  }
}

// ---------- LANÇAMENTOS ----------
const LANC_POR_PAGINA = 50;
let lancInit = false;

async function buscarLancamentosPagina(reiniciar){
  const id = state.igrejaAtualId;
  if(reiniciar){ state.lancPagina = []; state.lancCursor = null; state.lancTemMais = false; }
  const mes = parseInt($('lancMes').value), ano = parseInt($('lancAno').value);
  const tipoFiltro = $('lancTipo').value;
  const filtros = [where('mes','==',mes), where('ano','==',ano)];
  if(tipoFiltro) filtros.push(where('tipo','==',tipoFiltro));
  try{
    const cursorArg = state.lancCursor ? [startAfter(state.lancCursor)] : [];
    const q = query(collection(db,'igrejas',id,'lancamentos'), ...filtros, orderBy('dataStr','desc'), ...cursorArg, limit(LANC_POR_PAGINA));
    const snaps = await getDocs(q);
    const novos = snaps.docs.map(d=>({id:d.id, ...d.data()}));
    state.lancPagina = reiniciar ? novos : [...state.lancPagina, ...novos];
    if(snaps.docs.length) state.lancCursor = snaps.docs[snaps.docs.length-1];
    state.lancTemMais = snaps.docs.length === LANC_POR_PAGINA;
  } catch(e){
    // Provavelmente falta o índice composto (mes+ano[+tipo]+dataStr) — usa
    // a busca completa do mês como respaldo, igual ao comportamento anterior.
    console.warn('Paginação de lançamentos indisponível, buscando o mês inteiro:', e.message);
    let todos = await buscarLancamentos(mes, ano);
    if(tipoFiltro) todos = todos.filter(l=>l.tipo===tipoFiltro);
    todos.sort((a,b)=> (b.dataStr||'').localeCompare(a.dataStr||''));
    state.lancPagina = todos;
    state.lancTemMais = false;
  }
}

async function renderLancamentos(){
  if(!lancInit){
    populaMesAno('lancMes','lancAno'); lancInit = true;
    const reiniciarERecarregar = async ()=>{ await buscarLancamentosPagina(true); desenharTabelaLancamentos(); };
    $('lancMes').addEventListener('change', reiniciarERecarregar);
    $('lancAno').addEventListener('change', reiniciarERecarregar);
    $('lancTipo').addEventListener('change', reiniciarERecarregar);
    $('btnLancMais').addEventListener('click', async ()=>{ await buscarLancamentosPagina(false); desenharTabelaLancamentos(); });
  }
  await buscarLancamentosPagina(true);
  desenharTabelaLancamentos();
}

function desenharTabelaLancamentos(){
  const lancs = state.lancPagina;
  const editavel = podeEditarAba('lancamentos');
  $('btnNovoLancamento').style.display = editavel ? 'inline-flex' : 'none';
  $('lancEmpty').style.display = lancs.length ? 'none' : 'block';
  $('btnLancMais').style.display = state.lancTemMais ? 'inline-flex' : 'none';
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
      buscarLancamentosPagina(true).then(desenharTabelaLancamentos); renderPainel();
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
  $('lFormCategoria').value = lanc ? lanc.categoriaId : '';
  $('lFormFiel').value = lanc ? (lanc.membroId||'') : '';
  $('lFormFielBusca').value = lanc ? (lanc.membroNome||'') : '';
  $('lFormFielLista').classList.remove('active');
  $('modalLancamento').classList.add('active');
}
$('lFormTipo').addEventListener('change', popularCategoriaSelect);
function popularCategoriaSelect(){
  const tipo = $('lFormTipo').value;
  const lista = tipo === 'receita' ? state.categoriasReceita : state.categoriasDespesa;
  $('lFormCategoria').innerHTML = lista.map(c=>`<option value="${c.id}">${c.nome}</option>`).join('');
  $('lFormFielWrap').style.display = tipo === 'receita' ? 'block' : 'none';
}
$('btnCancelarLanc').addEventListener('click', ()=> $('modalLancamento').classList.remove('active'));
$('btnSalvarLanc').addEventListener('click', async ()=>{
  if(!validarObrigatorios([
    {id:'lFormData', nome:'Data'}, {id:'lFormCategoria', nome:'Categoria'}, {id:'lFormValor', nome:'Valor'}
  ])) return;
  const tipo = $('lFormTipo').value;
  const dataStr = $('lFormData').value;
  const categoriaId = $('lFormCategoria').value;
  const valor = parseFloat($('lFormValor').value);
  if(isNaN(valor) || valor <= 0){ $('lFormValor').classList.add('input-error'); toast('Informe um valor válido.', true); return; }
  const [ano, mes] = dataStr.split('-').map(Number);
  const key = competenciaKey(ano, mes);
  const compSnap = await getDoc(doc(db,'igrejas',state.igrejaAtualId,'competencias', key));
  if(compSnap.exists() && compSnap.data().bloqueado && !state.editandoLancId){
    toast('Esta competência está bloqueada.', true); return;
  }
  const lista = tipo === 'receita' ? state.categoriasReceita : state.categoriasDespesa;
  const categoriaNome = lista.find(c=>c.id===categoriaId)?.nome || '';
  const membroId = $('lFormFiel').value || null;
  const membroNome = membroId ? $('lFormFielBusca').value.trim() : '';
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
let fieisInit = false;
async function renderFieis(){
  if(!fieisInit){
    fieisInit = true;
    let timerBusca = null;
    $('fieisBusca').addEventListener('input', ()=>{
      clearTimeout(timerBusca);
      timerBusca = setTimeout(async ()=>{
        state.fieisBuscaAtual = $('fieisBusca').value;
        await buscarFieisPagina(true);
        desenharTabelaFieis();
      }, 350);
    });
    $('btnFieisMais').addEventListener('click', async ()=>{
      await buscarFieisPagina(false);
      desenharTabelaFieis();
    });
  }
  if(state.fieisPagina.length === 0 && !state.fieisCursor){
    await buscarFieisPagina(true);
  }
  desenharTabelaFieis();
}
function desenharTabelaFieis(){
  const editavel = podeEditarAba('fieis');
  $('btnNovoFiel').style.display = editavel ? 'inline-flex' : 'none';
  const fieis = state.fieisPagina;
  $('fieisEmpty').style.display = fieis.length ? 'none' : 'block';
  $('btnFieisMais').style.display = state.fieisTemMais ? 'inline-flex' : 'none';
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
    b.addEventListener('click', ()=> abrirModalFiel(fieis.find(f=>f.id===b.dataset.edit)));
  });
  $('fieisTbody').querySelectorAll('[data-del]').forEach(b=>{
    b.addEventListener('click', async ()=>{
      if(!confirm('Excluir este fiel?')) return;
      await deleteDoc(doc(db,'igrejas',state.igrejaAtualId,'membros', b.dataset.del));
      await buscarFieisPagina(true);
      toast('Fiel removido.'); desenharTabelaFieis();
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
  if(!validarObrigatorios([{id:'fFormNome', nome:'Nome'}])) return;
  const nome = $('fFormNome').value.trim();
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
    await buscarFieisPagina(true);
    toast('Fiel salvo!'); desenharTabelaFieis();
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
  const editavel = podeEditarAba('cadastros');
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
    let anos = '';
    for(let a = hoje.getFullYear()-3; a <= hoje.getFullYear()+1; a++){
      anos += `<option value="${a}" ${a===hoje.getFullYear()?'selected':''}>${a}</option>`;
    }
    $('relAnoAnual').innerHTML = anos;
    $('relAnoAnual').addEventListener('change', renderRelatorioAnual);
  }

  if(!temAcesso('lancamentos')){
    $('relReceitas').innerHTML = $('relDespesas').innerHTML = `<div class="empty">Sem acesso aos lançamentos.</div>`;
    $('relAnualTabela').innerHTML = ''; $('relFielResultado').innerHTML = '';
    return;
  }
  const mes = parseInt($('relMes').value), ano = parseInt($('relAno').value);
  const lancs = await buscarLancamentos(mes, ano);
  $('relReceitas').innerHTML = agruparPorCategoria(lancs.filter(l=>l.tipo==='receita'));
  $('relDespesas').innerHTML = agruparPorCategoria(lancs.filter(l=>l.tipo==='despesa'));
  renderRelatorioFiel();
  renderRelatorioAnual();
}
function agruparPorCategoria(lancs){
  const grupos = {};
  lancs.forEach(l => { grupos[l.categoriaNome] = (grupos[l.categoriaNome]||0) + l.valor; });
  const entradas = Object.entries(grupos).sort((a,b)=>b[1]-a[1]);
  if(!entradas.length) return `<div class="empty">Sem lançamentos neste mês.</div>`;
  return entradas.map(([nome,total]) => `
    <div class="list-row"><span>${nome}</span><span class="num">${fmtBRL(total)}</span></div>`).join('');
}
// Soma receitas ou despesas de um mês direto no servidor (agregação),
// sem baixar os documentos — muito mais leve para meses/anos com muitos
// lançamentos. Se a agregação não estiver disponível por algum motivo,
// recorre à soma manual como respaldo.
async function somarLancamentos(mes, ano, tipo){
  const id = state.igrejaAtualId;
  const q = query(collection(db,'igrejas', id, 'lancamentos'),
    where('mes','==',mes), where('ano','==',ano), where('tipo','==',tipo));
  try{
    const snap = await getAggregateFromServer(q, { total: sum('valor') });
    return snap.data().total || 0;
  } catch(e){
    const docs = await getDocs(q);
    return docs.docs.reduce((s,d)=> s + (d.data().valor||0), 0);
  }
}
async function resumoAnualAgregado(ano){
  const promessas = [];
  for(let mes=1; mes<=12; mes++){
    promessas.push(Promise.all([
      somarLancamentos(mes, ano, 'receita'),
      somarLancamentos(mes, ano, 'despesa'),
    ]));
  }
  const resultados = await Promise.all(promessas);
  return resultados.map(([receitas,despesas]) => ({ receitas, despesas }));
}
async function renderRelatorioAnual(){
  const ano = parseInt($('relAnoAnual').value);
  $('relAnualTabela').innerHTML = `<div class="empty">Calculando...</div>`;
  const porMes = await resumoAnualAgregado(ano);
  let totalReceitas = 0, totalDespesas = 0;
  const linhas = porMes.map((m, i) => {
    totalReceitas += m.receitas; totalDespesas += m.despesas;
    return `<tr><td>${MESES[i]}</td><td class="num">${fmtBRL(m.receitas)}</td><td class="num">${fmtBRL(m.despesas)}</td><td class="num">${fmtBRL(m.receitas-m.despesas)}</td></tr>`;
  }).join('');
  $('relAnualTabela').innerHTML = `
    <div class="table-scroll"><table>
      <thead><tr><th>Mês</th><th>Receitas</th><th>Despesas</th><th>Saldo</th></tr></thead>
      <tbody>${linhas}</tbody>
      <tfoot><tr style="font-weight:600;"><td>Total</td><td class="num">${fmtBRL(totalReceitas)}</td><td class="num">${fmtBRL(totalDespesas)}</td><td class="num">${fmtBRL(totalReceitas-totalDespesas)}</td></tr></tfoot>
    </table></div>`;
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
// Redimensiona a imagem no navegador (canvas) e devolve como base64 —
// assim não precisamos do Firebase Storage (que exigiria plano pago) só
// para guardar uma logo pequena.
function redimensionarImagem(file, maxSize = 240, qualidade = 0.82){
  return new Promise((resolve, reject)=>{
    if(!file.type.startsWith('image/')){ reject(new Error('Selecione um arquivo de imagem.')); return; }
    if(file.size > 8*1024*1024){ reject(new Error('Imagem muito grande (máx. 8MB).')); return; }
    const reader = new FileReader();
    reader.onload = (e)=>{
      const img = new Image();
      img.onload = ()=>{
        let w = img.width, h = img.height;
        if(w > h){ if(w > maxSize){ h = Math.round(h * maxSize/w); w = maxSize; } }
        else { if(h > maxSize){ w = Math.round(w * maxSize/h); h = maxSize; } }
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', qualidade));
      };
      img.onerror = ()=> reject(new Error('Não foi possível ler a imagem.'));
      img.src = e.target.result;
    };
    reader.onerror = ()=> reject(new Error('Não foi possível ler o arquivo.'));
    reader.readAsDataURL(file);
  });
}
function atualizarPreviewLogo(){
  const prev = $('igLogoPreview');
  if(state.logoPendente){ prev.src = state.logoPendente; }
  else { prev.removeAttribute('src'); }
}
$('igLogoFile').addEventListener('change', async (e)=>{
  const file = e.target.files[0];
  if(!file) return;
  try{
    state.logoPendente = await redimensionarImagem(file);
    atualizarPreviewLogo();
  } catch(err){ toast(err.message, true); }
});
$('btnRemoverLogo').addEventListener('click', ()=>{
  state.logoPendente = null;
  $('igLogoFile').value = '';
  atualizarPreviewLogo();
});

async function renderIgreja(){
  const snap = await getDoc(doc(db,'igrejas',state.igrejaAtualId));
  const d = snap.data() || {};
  state.logoPendente = d.logo || null;
  atualizarPreviewLogo();
  $('igNome').value = d.nome||''; $('igCnpj').value = d.cnpj||'';
  $('igPastor').value = d.pastor||''; $('igTesoureiro').value = d.tesoureiro||'';
  $('igEmail').value = d.email||''; $('igInstagram').value = d.instagram||'';
  $('igEndereco').value = d.endereco||''; $('igBairro').value = d.bairro||'';
  $('igCidade').value = d.cidade||''; $('igEstado').value = d.estado||''; $('igCep').value = d.cep||'';
  const editavel = isAdmin();
  document.querySelectorAll('#view-igreja input').forEach(i => i.disabled = !editavel);
  $('btnSalvarIgreja').style.display = editavel ? 'inline-flex' : 'none';
  $('btnRemoverLogo').style.display = editavel ? 'inline-flex' : 'none';
}
$('btnSalvarIgreja').addEventListener('click', async ()=>{
  if(!validarObrigatorios([{id:'igNome', nome:'Nome da igreja'}])) return;
  const payload = {
    nome: $('igNome').value.trim(), cnpj: $('igCnpj').value.trim(),
    pastor: $('igPastor').value.trim(), tesoureiro: $('igTesoureiro').value.trim(),
    email: $('igEmail').value.trim(), instagram: $('igInstagram').value.trim(),
    endereco: $('igEndereco').value.trim(), bairro: $('igBairro').value.trim(),
    cidade: $('igCidade').value.trim(), estado: $('igEstado').value.trim(), cep: $('igCep').value.trim(),
    logo: state.logoPendente || null,
  };
  try{
    await updateDoc(doc(db,'igrejas',state.igrejaAtualId), payload);
    await updateDoc(doc(db,'membrosIndice', `${state.igrejaAtualId}_${state.user.uid}`), {
      igrejaNome: payload.nome
    });
    state.igrejaDados = { ...state.igrejaDados, ...payload };
    aplicarLogoSidebar();
    toast('Dados da igreja atualizados!');
    await carregarIgrejasDoUsuario(state.user);
  } catch(e){ toast('Erro ao salvar: '+e.message, true); }
});

// ---------- USUÁRIOS ----------
async function renderUsuarios(){
  const usuariosSnap = await getDocs(collection(db,'igrejas',state.igrejaAtualId,'usuarios'));
  const usuarios = usuariosSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  $('usuariosTbody').innerHTML = usuarios.map(u=>{
    const souEu = u.id === state.user.uid;
    return `<tr>
      <td>${u.nome}${souEu ? ' (você)' : ''}</td><td>${u.email}</td>
      <td><span class="papel-badge">${PAPEL_LABEL[u.papel]}</span></td>
      <td>
        <button class="btn btn-sm" data-editar="${u.id}">Editar</button>
        ${!souEu ? `<button class="btn btn-sm btn-danger" data-del="${u.id}">Remover</button>` : ''}
      </td>
    </tr>`;
  }).join('');
  $('usuariosTbody').querySelectorAll('[data-editar]').forEach(b=>{
    b.addEventListener('click', ()=> abrirModalEditarUsuario(usuarios.find(u=>u.id===b.dataset.editar)));
  });
  $('usuariosTbody').querySelectorAll('[data-del]').forEach(b=>{
    b.addEventListener('click', async ()=>{
      if(!confirm('Remover o acesso deste usuário a esta igreja?')) return;
      await deleteDoc(doc(db,'igrejas',state.igrejaAtualId,'usuarios', b.dataset.del));
      await deleteDoc(doc(db,'membrosIndice', `${state.igrejaAtualId}_${b.dataset.del}`));
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
      await deleteDoc(doc(db,'convitesIndice', `${state.igrejaAtualId}_${b.dataset.cancel}`));
      toast('Convite cancelado.'); renderUsuarios();
    });
  });
}
$('btnConvidarUsuario').addEventListener('click', ()=>{
  $('convFormEmail').value=''; $('convFormPapel').value='leitura';
  $('convFormEmail').classList.remove('input-error');
  renderAbasCheckboxes('convFormAbas', TODAS_ABAS);
  $('modalConvite').classList.add('active');
});
$('btnCancelarConvite').addEventListener('click', ()=> $('modalConvite').classList.remove('active'));
$('btnSalvarConvite').addEventListener('click', async ()=>{
  if(!validarObrigatorios([{id:'convFormEmail', nome:'E-mail'}])) return;
  const email = $('convFormEmail').value.trim().toLowerCase();
  const papel = $('convFormPapel').value;
  const abas = lerAbasCheckboxes('convFormAbas');
  try{
    await setDoc(doc(db,'igrejas',state.igrejaAtualId,'convites', email), {
      email, papel, abas, criadoPor: state.user.uid, criadoEm: serverTimestamp()
    });
    await setDoc(doc(db,'convitesIndice', `${state.igrejaAtualId}_${email}`), {
      email, igrejaId: state.igrejaAtualId, igrejaNome: igrejaAtual()?.nome || '', papel, abas
    });
    $('modalConvite').classList.remove('active');
    toast('Convite criado! Peça para a pessoa entrar no app com esse e-mail.');
    renderUsuarios();
  } catch(e){ toast('Erro ao convidar: '+e.message, true); }
});

function abrirModalEditarUsuario(u){
  state.editandoUsuarioUid = u.id;
  $('editUsuarioNome').textContent = `${u.nome} — ${u.email}`;
  $('editFormPapel').value = u.papel;
  renderAbasCheckboxes('editFormAbas', u.abasPermitidas || TODAS_ABAS);
  $('modalEditarUsuario').classList.add('active');
}
$('btnCancelarEditarUsuario').addEventListener('click', ()=> $('modalEditarUsuario').classList.remove('active'));
$('btnSalvarEditarUsuario').addEventListener('click', async ()=>{
  const uid = state.editandoUsuarioUid;
  const papel = $('editFormPapel').value;
  const abas = lerAbasCheckboxes('editFormAbas');
  try{
    await updateDoc(doc(db,'igrejas',state.igrejaAtualId,'usuarios', uid), { papel, abasPermitidas: abas });
    await updateDoc(doc(db,'membrosIndice', `${state.igrejaAtualId}_${uid}`), { papel, abas });
    $('modalEditarUsuario').classList.remove('active');
    toast('Permissões atualizadas!');
    renderUsuarios();
  } catch(e){ toast('Erro ao salvar: '+e.message, true); }
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

$('btnExportarFieis').addEventListener('click', async ()=>{
  toast('Preparando exportação...');
  const q = query(collection(db,'igrejas',state.igrejaAtualId,'membros'), orderBy('nome'), limit(5000));
  const snaps = await getDocs(q);
  const todos = snaps.docs.map(d=>({id:d.id, ...d.data()}));
  if(!todos.length){ toast('Nenhum fiel para exportar.', true); return; }
  const linhas = todos.map(f => ({
    Nome: f.nome, Cargo: cargoNome(f.cargoId), Grupo: grupoNome(f.grupoId),
    Telefone: f.telefone || '', Email: f.email || '', CPF: f.cpf || '', Observações: f.observacoes || ''
  }));
  const ws = XLSX.utils.json_to_sheet(linhas);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Fiéis');
  XLSX.writeFile(wb, `fieis_${nomeArquivoSeguro(igrejaAtual()?.nome)}.xlsx`);
  toast(snaps.docs.length === 5000 ? 'Exportado (limite de 5000 fiéis por vez)!' : 'Exportado!');
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

// ---------- EXPORTAR PDF (fluxo de caixa) ----------
function novoPdf(subtitulo1, subtitulo2){
  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF();
  const nomeIgreja = igrejaAtual()?.nome || 'Igreja';
  const logo = state.igrejaDados.logo;
  let x = 14;
  if(logo){
    try{ pdf.addImage(logo, 'JPEG', 14, 10, 18, 18); x = 36; } catch(e){ /* segue sem logo */ }
  }
  pdf.setFontSize(14);
  pdf.text(nomeIgreja, x, 17);
  pdf.setFontSize(10);
  pdf.setTextColor(110);
  if(subtitulo1) pdf.text(subtitulo1, x, 23);
  if(subtitulo2) pdf.text(subtitulo2, x, 28);
  pdf.setTextColor(0);
  pdf.setDrawColor(215,228,240);
  pdf.line(14, 33, 196, 33);
  return pdf;
}
function nomeArquivoPdf(prefixo){
  return `${prefixo}_${nomeArquivoSeguro(igrejaAtual()?.nome)}_${Date.now()}.pdf`;
}

$('btnPdfMensal').addEventListener('click', async ()=>{
  const mes = parseInt($('relMes').value), ano = parseInt($('relAno').value);
  const lancs = await buscarLancamentos(mes, ano);
  const receitas = lancs.filter(l=>l.tipo==='receita');
  const despesas = lancs.filter(l=>l.tipo==='despesa');
  const totalR = receitas.reduce((s,l)=>s+l.valor,0);
  const totalD = despesas.reduce((s,l)=>s+l.valor,0);

  const pdf = novoPdf('Fluxo de Caixa Mensal', `${MESES[mes-1]} de ${ano}`);
  let y = 40;
  pdf.setFontSize(11); pdf.text('Receitas por categoria', 14, y); y += 4;
  const linhasR = Object.entries(receitas.reduce((acc,l)=>{ acc[l.categoriaNome]=(acc[l.categoriaNome]||0)+l.valor; return acc; },{}))
    .sort((a,b)=>b[1]-a[1]).map(([n,v])=>[n, fmtBRL(v)]);
  pdf.autoTable({ startY:y, head:[['Categoria','Valor']], body: linhasR.length?linhasR:[['—','—']], theme:'striped', headStyles:{fillColor:[13,79,196]}, margin:{left:14,right:14} });
  y = pdf.lastAutoTable.finalY + 10;

  pdf.setFontSize(11); pdf.text('Despesas por categoria', 14, y); y += 4;
  const linhasD = Object.entries(despesas.reduce((acc,l)=>{ acc[l.categoriaNome]=(acc[l.categoriaNome]||0)+l.valor; return acc; },{}))
    .sort((a,b)=>b[1]-a[1]).map(([n,v])=>[n, fmtBRL(v)]);
  pdf.autoTable({ startY:y, head:[['Categoria','Valor']], body: linhasD.length?linhasD:[['—','—']], theme:'striped', headStyles:{fillColor:[199,63,63]}, margin:{left:14,right:14} });
  y = pdf.lastAutoTable.finalY + 10;

  pdf.setFontSize(11);
  pdf.text(`Total de receitas: ${fmtBRL(totalR)}`, 14, y); y += 6;
  pdf.text(`Total de despesas: ${fmtBRL(totalD)}`, 14, y); y += 6;
  pdf.setFont(undefined, 'bold');
  pdf.text(`Saldo do mês: ${fmtBRL(totalR-totalD)}`, 14, y);
  pdf.setFont(undefined, 'normal');

  pdf.save(nomeArquivoPdf(`fluxo_mensal_${MESES[mes-1]}_${ano}`));
  toast('PDF gerado!');
});

$('btnPdfAnual').addEventListener('click', async ()=>{
  const ano = parseInt($('relAnoAnual').value);
  toast('Gerando PDF...');
  const porMes = await resumoAnualAgregado(ano);
  let totalR = 0, totalD = 0;
  const linhas = porMes.map((m,i)=>{
    totalR += m.receitas; totalD += m.despesas;
    return [MESES[i], fmtBRL(m.receitas), fmtBRL(m.despesas), fmtBRL(m.receitas-m.despesas)];
  });
  linhas.push(['Total', fmtBRL(totalR), fmtBRL(totalD), fmtBRL(totalR-totalD)]);

  const pdf = novoPdf('Fluxo de Caixa Anual', `Ano de ${ano}`);
  pdf.autoTable({
    startY: 40, head:[['Mês','Receitas','Despesas','Saldo']], body: linhas,
    theme:'striped', headStyles:{fillColor:[13,79,196]}, margin:{left:14,right:14},
    didParseCell: (data)=>{ if(data.row.index === linhas.length-1) data.cell.styles.fontStyle = 'bold'; }
  });
  pdf.save(nomeArquivoPdf(`fluxo_anual_${ano}`));
  toast('PDF gerado!');
});

$('btnPdfFiel').addEventListener('click', async ()=>{
  const fielId = $('relFiel').value;
  if(!fielId){ toast('Selecione um fiel primeiro.', true); return; }
  const nomeFiel = $('relFielBusca').value.trim();
  const q = query(collection(db,'igrejas',state.igrejaAtualId,'lancamentos'), where('membroId','==',fielId));
  const snaps = await getDocs(q);
  const lancs = snaps.docs.map(d=>({id:d.id, ...d.data()})).sort((a,b)=> (a.dataStr||'').localeCompare(b.dataStr||''));
  const total = lancs.reduce((s,l)=>s+l.valor,0);

  const pdf = novoPdf('Extrato de Contribuições', nomeFiel);
  const linhas = lancs.map(l => [formatarDataBR(l.dataStr), l.categoriaNome||'', fmtBRL(l.valor)]);
  pdf.autoTable({
    startY: 40, head:[['Data','Categoria','Valor']], body: linhas.length?linhas:[['—','Nenhuma contribuição registrada','—']],
    theme:'striped', headStyles:{fillColor:[13,79,196]}, margin:{left:14,right:14}
  });
  const y = pdf.lastAutoTable.finalY + 10;
  pdf.setFontSize(11); pdf.setFont(undefined,'bold');
  pdf.text(`Total geral: ${fmtBRL(total)}`, 14, y);
  pdf.setFont(undefined,'normal');

  pdf.save(nomeArquivoPdf(`extrato_${nomeArquivoSeguro(fiel?.nome)}`));
  toast('PDF gerado!');
});
