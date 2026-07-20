import { firebaseConfig } from "./firebase-config.js";
import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/10.14.0/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, signOut, sendPasswordResetEmail, updatePassword
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
  competenciasBloqueadas: new Set(),
  editandoLancCompetenciaOriginal: null,
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
async function carregarCompetenciasBloqueadas(){
  const snaps = await getDocs(query(collection(db,'igrejas',state.igrejaAtualId,'competencias'), where('bloqueado','==',true)));
  state.competenciasBloqueadas = new Set(snaps.docs.map(d=>d.id));
}

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

// Remove acentos e caixa para permitir busca "kennedy" encontrar "Kennedy",
// "joão" encontrar "JOÃO", etc.
function normalizarTexto(txt){
  return (txt||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();
}

// Busca fiéis em páginas de 50 (por nome, com ou sem termo de busca por
// prefixo) em vez de carregar a lista inteira de uma vez — assim a tela
// continua rápida mesmo com muitos milhares de fiéis cadastrados. A busca
// usa o campo nomeBusca (normalizado, sem acento/caixa) para encontrar o
// fiel independente de como foi digitado.
async function buscarFieisPagina(reiniciar){
  const id = state.igrejaAtualId;
  if(reiniciar){ state.fieisPagina = []; state.fieisCursor = null; state.fieisTemMais = false; }
  const termo = normalizarTexto(state.fieisBuscaAtual);
  const base = collection(db, 'igrejas', id, 'membros');
  const filtros = termo
    ? [orderBy('nomeBusca'), where('nomeBusca','>=',termo), where('nomeBusca','<=',termo+'\uf8ff')]
    : [orderBy('nomeBusca')];
  const cursorArg = state.fieisCursor ? [startAfter(state.fieisCursor)] : [];
  const q = query(base, ...filtros, ...cursorArg, limit(FIEIS_POR_PAGINA));
  const snaps = await getDocs(q);
  const novos = snaps.docs.map(d => ({ id:d.id, ...d.data() }));
  state.fieisPagina = reiniciar ? novos : [...state.fieisPagina, ...novos];
  if(snaps.docs.length) state.fieisCursor = snaps.docs[snaps.docs.length - 1];
  state.fieisTemMais = snaps.docs.length === FIEIS_POR_PAGINA;
}

// Combobox de busca de fiel (usado no formulário de lançamento e no filtro
// de relatórios) — busca por prefixo do nome direto no Firestore (sem
// diferenciar acento/caixa), sem precisar carregar a lista inteira de
// fiéis na memória do navegador.
function configurarComboboxFiel(inputBuscaId, inputHiddenId, listaId, onSelecionar){
  const inputBusca = $(inputBuscaId), inputHidden = $(inputHiddenId), lista = $(listaId);
  let timer = null;
  inputBusca.addEventListener('input', ()=>{
    inputHidden.value = '';
    clearTimeout(timer);
    const termo = normalizarTexto(inputBusca.value);
    if(!termo){ lista.classList.remove('active'); lista.innerHTML=''; return; }
    timer = setTimeout(async ()=>{
      const base = collection(db, 'igrejas', state.igrejaAtualId, 'membros');
      const q = query(base, orderBy('nomeBusca'), where('nomeBusca','>=',termo), where('nomeBusca','<=',termo+'\uf8ff'), limit(8));
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
// "Criar conta" fica escondida da tela normal — o cadastro de usuários
// agora é feito pelo admin (Usuários → Cadastrar usuário). Esse link só
// aparece se a página for aberta com ?primeiraconta=1 na URL, para o caso
// raro de precisar criar a toda primeira conta de uma instalação nova do
// zero (quando ainda não existe nenhum admin em lugar nenhum).
if(new URLSearchParams(window.location.search).get('primeiraconta') === '1'){
  $('authToggleWrap').style.display = 'flex';
}
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
    'auth/requires-recent-login': 'Por segurança, saia e entre de novo antes de trocar a senha.',
    'auth/too-many-requests': 'Muitas tentativas. Espere um pouco e tente de novo.',
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
      // Se a pessoa já tem acesso a essa igreja, NUNCA sobrescreve as
      // permissões dela — só descarta o convite antigo. Isso evita que um
      // admin se rebaixe sem querer ao criar um convite pro próprio e-mail
      // (ex: durante testes).
      const jaMembro = await getDoc(doc(db, 'igrejas', igrejaId, 'usuarios', user.uid));
      if(!jaMembro.exists()){
        await setDoc(doc(db, 'igrejas', igrejaId, 'usuarios', user.uid), {
          uid: user.uid, nome: state.perfil.nome, email: user.email,
          papel: dados.papel, abasPermitidas: abas, criadoEm: serverTimestamp()
        });
        await setDoc(doc(db, 'membrosIndice', `${igrejaId}_${user.uid}`), {
          uid: user.uid, igrejaId, igrejaNome: dados.igrejaNome || '',
          papel: dados.papel, abas, nome: state.perfil.nome, email: user.email
        });
      }
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
    return { id: dado.igrejaId, nome: dado.igrejaNome, papel: dado.papel, abas: dado.abas || TODAS_ABAS, precisaTrocarSenha: !!dado.precisaTrocarSenha };
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
  if(state.igrejas.some(i => i.precisaTrocarSenha)) abrirModalTrocarSenhaObrigatoria();
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
  await carregarCompetenciasBloqueadas();
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

function abrirModalTrocarSenhaObrigatoria(){
  $('novaSenhaObrigatoria').value = '';
  $('novaSenhaObrigatoriaConfirmar').value = '';
  $('modalTrocarSenha').classList.add('active');
}
$('btnSalvarNovaSenhaObrigatoria').addEventListener('click', async ()=>{
  const senha = $('novaSenhaObrigatoria').value;
  const confirmacao = $('novaSenhaObrigatoriaConfirmar').value;
  if(senha.length < 6){ toast('A senha precisa ter pelo menos 6 caracteres.', true); return; }
  if(senha !== confirmacao){ toast('As senhas não são iguais.', true); return; }
  const btn = $('btnSalvarNovaSenhaObrigatoria');
  btn.disabled = true;
  try{
    await updatePassword(auth.currentUser, senha);
    // Limpa a marcação em todas as igrejas onde a pessoa está.
    await Promise.all(state.igrejas.map(async (ig) => {
      try{
        await updateDoc(doc(db,'igrejas', ig.id, 'usuarios', state.user.uid), { precisaTrocarSenha: false });
        await updateDoc(doc(db,'membrosIndice', `${ig.id}_${state.user.uid}`), { precisaTrocarSenha: false });
      } catch(e){ /* segue mesmo se uma igreja falhar */ }
    }));
    state.igrejas.forEach(ig => ig.precisaTrocarSenha = false);
    $('modalTrocarSenha').classList.remove('active');
    toast('Senha atualizada com sucesso!');
  } catch(e){
    toast('Erro ao trocar senha: ' + traduzErroAuth(e.code||''), true);
  } finally {
    btn.disabled = false;
  }
});

configurarComboboxFiel('lFormFielBusca', 'lFormFiel', 'lFormFielLista');
configurarComboboxFiel('relFielBusca', 'relFiel', 'relFielLista', ()=> renderRelatorioFiel());
$('relFielDataInicio').addEventListener('change', renderRelatorioFiel);
$('relFielDataFim').addEventListener('change', renderRelatorioFiel);
$('btnLimparPeriodoFiel').addEventListener('click', ()=>{
  $('relFielDataInicio').value = ''; $('relFielDataFim').value = '';
  renderRelatorioFiel();
});
configurarComboboxFiel('igPastorBusca', 'igPastorId', 'igPastorLista');
configurarComboboxFiel('igTesoureiroBusca', 'igTesoureiroId', 'igTesoureiroLista');

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
    $('statSaldoAnterior').textContent = '—'; $('statSaldoAtual').textContent = '—';
    $('painelUltimos').innerHTML = `<div class="empty">Você não tem acesso aos lançamentos financeiros. Fale com um administrador da igreja.</div>`;
    return;
  }
  const mes = parseInt($('painelMes').value), ano = parseInt($('painelAno').value);
  const [receitas, despesas, ultimos, saldoAnterior] = await Promise.all([
    somarLancamentos(mes, ano, 'receita'),
    somarLancamentos(mes, ano, 'despesa'),
    ultimosLancamentosDoMes(mes, ano, 8),
    saldoAnteriorA(mes, ano),
  ]);
  $('statReceitas').textContent = fmtBRL(receitas);
  $('statDespesas').textContent = fmtBRL(despesas);
  const saldoEl = $('statSaldo');
  saldoEl.textContent = fmtBRL(receitas-despesas);
  saldoEl.className = 'stat-value num ' + (receitas-despesas >= 0 ? 'green' : 'red');

  $('statSaldoAnterior').textContent = fmtBRL(saldoAnterior);
  const saldoAtualEl = $('statSaldoAtual');
  const saldoAtual = saldoAnterior + (receitas - despesas);
  saldoAtualEl.textContent = fmtBRL(saldoAtual);
  saldoAtualEl.className = 'stat-value num ' + (saldoAtual >= 0 ? 'green' : 'red');
  saldoAtualEl.style.fontSize = '19px';

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

// Lê o estado atual de todos os filtros da tela de Lançamentos.
function filtrosAtivosLancamentos(){
  return {
    mes: parseInt($('lancMes').value),
    ano: parseInt($('lancAno').value),
    tipo: $('lancTipo').value,
    categoriaId: $('lancCategoriaFiltro').value,
    membroId: $('lancFielFiltro').value,
  };
}
function popularCategoriaFiltroLancamentos(){
  const sel = $('lancCategoriaFiltro');
  const atual = sel.value;
  const opts = [
    ...state.categoriasReceita.map(c => ({ id:c.id, label:`${c.nome} (Receita)` })),
    ...state.categoriasDespesa.map(c => ({ id:c.id, label:`${c.nome} (Despesa)` })),
  ];
  sel.innerHTML = '<option value="">Todas as categorias</option>' +
    opts.map(o => `<option value="${o.id}">${o.label}</option>`).join('');
  if(opts.some(o => o.id === atual)) sel.value = atual;
}
async function buscarLancamentosPagina(reiniciar){
  const id = state.igrejaAtualId;
  if(reiniciar){ state.lancPagina = []; state.lancCursor = null; state.lancTemMais = false; }
  const f = filtrosAtivosLancamentos();
  const filtros = [where('mes','==',f.mes), where('ano','==',f.ano)];
  if(f.tipo) filtros.push(where('tipo','==',f.tipo));
  if(f.categoriaId) filtros.push(where('categoriaId','==',f.categoriaId));
  if(f.membroId) filtros.push(where('membroId','==',f.membroId));
  try{
    const cursorArg = state.lancCursor ? [startAfter(state.lancCursor)] : [];
    const q = query(collection(db,'igrejas',id,'lancamentos'), ...filtros, orderBy('dataStr','desc'), ...cursorArg, limit(LANC_POR_PAGINA));
    const snaps = await getDocs(q);
    const novos = snaps.docs.map(d=>({id:d.id, ...d.data()}));
    state.lancPagina = reiniciar ? novos : [...state.lancPagina, ...novos];
    if(snaps.docs.length) state.lancCursor = snaps.docs[snaps.docs.length-1];
    state.lancTemMais = snaps.docs.length === LANC_POR_PAGINA;
  } catch(e){
    // Provavelmente falta o índice composto (mes+ano+...+dataStr) — usa
    // a busca completa do mês como respaldo, filtrando o resto na hora.
    console.warn('Paginação de lançamentos indisponível, buscando o mês inteiro:', e.message);
    let todos = await buscarLancamentos(f.mes, f.ano);
    if(f.tipo) todos = todos.filter(l=>l.tipo===f.tipo);
    if(f.categoriaId) todos = todos.filter(l=>l.categoriaId===f.categoriaId);
    if(f.membroId) todos = todos.filter(l=>l.membroId===f.membroId);
    todos.sort((a,b)=> (b.dataStr||'').localeCompare(a.dataStr||''));
    state.lancPagina = todos;
    state.lancTemMais = false;
  }
}

async function renderLancamentos(){
  if(!lancInit){
    populaMesAno('lancMes','lancAno'); lancInit = true;
    const reiniciarERecarregar = async ()=>{ await buscarLancamentosPagina(true); desenharTabelaLancamentos(); atualizarTotalizadorLancamentos(); };
    $('lancMes').addEventListener('change', reiniciarERecarregar);
    $('lancAno').addEventListener('change', reiniciarERecarregar);
    $('lancTipo').addEventListener('change', reiniciarERecarregar);
    $('lancCategoriaFiltro').addEventListener('change', reiniciarERecarregar);
    $('lancFielFiltroBusca').addEventListener('input', ()=>{ if(!$('lancFielFiltroBusca').value.trim()) reiniciarERecarregar(); });
    configurarComboboxFiel('lancFielFiltroBusca', 'lancFielFiltro', 'lancFielFiltroLista', reiniciarERecarregar);
    $('btnLimparFiltrosLanc').addEventListener('click', ()=>{
      $('lancMes').value = hoje.getMonth()+1; $('lancAno').value = hoje.getFullYear();
      $('lancTipo').value = ''; $('lancCategoriaFiltro').value = '';
      $('lancFielFiltroBusca').value = ''; $('lancFielFiltro').value = '';
      reiniciarERecarregar();
    });
    $('btnLancMais').addEventListener('click', async ()=>{ await buscarLancamentosPagina(false); desenharTabelaLancamentos(); });
  }
  popularCategoriaFiltroLancamentos();
  await buscarLancamentosPagina(true);
  desenharTabelaLancamentos();
  atualizarTotalizadorLancamentos();
}
// Soma o período/filtro inteiro (não só a página carregada na tela).
async function somarLancamentosFiltrado(f, tipo){
  const id = state.igrejaAtualId;
  const filtros = [where('mes','==',f.mes), where('ano','==',f.ano), where('tipo','==',tipo)];
  if(f.categoriaId) filtros.push(where('categoriaId','==',f.categoriaId));
  if(f.membroId) filtros.push(where('membroId','==',f.membroId));
  const q = query(collection(db,'igrejas',id,'lancamentos'), ...filtros);
  try{
    const snap = await getAggregateFromServer(q, { total: sum('valor') });
    return snap.data().total || 0;
  } catch(e){
    const docs = await getDocs(q);
    return docs.docs.reduce((s,d)=> s + (d.data().valor||0), 0);
  }
}
async function atualizarTotalizadorLancamentos(){
  const f = filtrosAtivosLancamentos();
  const [receitas, despesas] = await Promise.all([
    f.tipo === 'despesa' ? 0 : somarLancamentosFiltrado(f, 'receita'),
    f.tipo === 'receita' ? 0 : somarLancamentosFiltrado(f, 'despesa'),
  ]);
  $('lancTotalReceitas').textContent = fmtBRL(receitas);
  $('lancTotalDespesas').textContent = fmtBRL(despesas);
  const saldoEl = $('lancTotalSaldo');
  saldoEl.textContent = fmtBRL(receitas-despesas);
  saldoEl.className = 'stat-value num ' + (receitas-despesas >= 0 ? 'green' : 'red');
}

function isCompetenciaBloqueada(mes, ano){
  return state.competenciasBloqueadas.has(competenciaKey(ano, mes));
}
function desenharTabelaLancamentos(){
  const lancs = state.lancPagina;
  const editavel = podeEditarAba('lancamentos');
  $('btnNovoLancamento').style.display = editavel ? 'inline-flex' : 'none';
  $('lancEmpty').style.display = lancs.length ? 'none' : 'block';
  $('btnLancMais').style.display = state.lancTemMais ? 'inline-flex' : 'none';
  $('lancTbody').innerHTML = lancs.map(l => {
    const bloqueado = isCompetenciaBloqueada(l.mes, l.ano);
    return `
    <tr>
      <td>${l.dataStr ? formatarDataBR(l.dataStr) : '—'}</td>
      <td>${l.mes ? `${MESES[l.mes-1]}/${l.ano}` : '—'}</td>
      <td><span class="tag ${l.tipo}">${l.tipo}</span></td>
      <td>${l.categoriaNome||''}</td>
      <td>${l.descricao||'—'}</td>
      <td>${l.membroNome||'—'}</td>
      <td class="num">${fmtBRL(l.valor)}</td>
      <td>
        ${bloqueado ? '<span class="tag locked">bloqueado</span>' :
          (editavel ? `<button class="btn btn-sm" data-edit="${l.id}">Editar</button>
           <button class="btn btn-sm btn-danger" data-del="${l.id}">Excluir</button>` : '')}
      </td>
    </tr>`;
  }).join('');

  $('lancTbody').querySelectorAll('[data-edit]').forEach(b=>{
    b.addEventListener('click', ()=> abrirModalLancamento(lancs.find(l=>l.id===b.dataset.edit)));
  });
  $('lancTbody').querySelectorAll('[data-del]').forEach(b=>{
    b.addEventListener('click', async ()=>{
      const lanc = lancs.find(l=>l.id===b.dataset.del);
      if(lanc && isCompetenciaBloqueada(lanc.mes, lanc.ano)){
        toast('Esta competência está bloqueada. Desbloqueie em Competências para excluir.', true); return;
      }
      if(!confirm('Excluir este lançamento?')) return;
      await deleteDoc(doc(db,'igrejas',state.igrejaAtualId,'lancamentos', b.dataset.del));
      toast('Lançamento excluído.');
      buscarLancamentosPagina(true).then(desenharTabelaLancamentos); atualizarTotalizadorLancamentos(); renderPainel();
    });
  });
}
function formatarDataBR(iso){ const [y,m,d] = iso.split('-'); return `${d}/${m}/${y}`; }

$('btnNovoLancamento').addEventListener('click', ()=> abrirModalLancamento(null));
function abrirModalLancamento(lanc){
  state.editandoLancId = lanc ? lanc.id : null;
  state.editandoLancCompetenciaOriginal = lanc ? competenciaKey(lanc.ano, lanc.mes) : null;
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
  populaMesAno('lFormCompMes', 'lFormCompAno');
  if(lanc){
    $('lFormCompMes').value = lanc.mes;
    $('lFormCompAno').value = lanc.ano;
  } else {
    sincronizarCompetenciaComData();
  }
  $('modalLancamento').classList.add('active');
}
// Ao escolher a data num lançamento NOVO, a competência acompanha por
// padrão (mas o usuário pode mudar manualmente depois, para os casos em
// que o pagamento foi feito num mês referente a outro).
function sincronizarCompetenciaComData(){
  const dataStr = $('lFormData').value;
  if(!dataStr) return;
  const [ano, mes] = dataStr.split('-').map(Number);
  $('lFormCompMes').value = mes;
  $('lFormCompAno').value = ano;
}
$('lFormData').addEventListener('change', ()=>{ if(!state.editandoLancId) sincronizarCompetenciaComData(); });
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
  const mes = parseInt($('lFormCompMes').value), ano = parseInt($('lFormCompAno').value);
  const key = competenciaKey(ano, mes);
  if(isCompetenciaBloqueada(mes, ano)){
    toast('Esta competência está bloqueada.', true); return;
  }
  if(state.editandoLancCompetenciaOriginal && state.editandoLancCompetenciaOriginal !== key){
    const [anoOrig, mesOrig] = state.editandoLancCompetenciaOriginal.split('-').map(Number);
    if(isCompetenciaBloqueada(mesOrig, anoOrig)){
      toast('Esse lançamento pertence a uma competência bloqueada — desbloqueie antes de editar.', true); return;
    }
  }
  const lista = tipo === 'receita' ? state.categoriasReceita : state.categoriasDespesa;
  const categoriaNome = lista.find(c=>c.id===categoriaId)?.nome || '';
  const membroId = $('lFormFiel').value || null;
  const membroNome = membroId ? $('lFormFielBusca').value.trim() : '';
  const payload = {
    tipo, dataStr, mes, ano, competenciaKey: key, categoriaId, categoriaNome,
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
    $('btnReindexarFieis').addEventListener('click', reindexarBuscaFieis);
  }
  $('btnReindexarFieis').style.display = isAdmin() ? 'inline-flex' : 'none';
  if(state.fieisPagina.length === 0 && !state.fieisCursor){
    await buscarFieisPagina(true);
  }
  desenharTabelaFieis();
}
// Corrige fiéis cadastrados antes do campo de busca sem acento/caixa
// existir — sem isso, eles ficariam invisíveis nas buscas.
async function reindexarBuscaFieis(){
  const btn = $('btnReindexarFieis');
  const aviso = $('fieisReindexarAviso');
  btn.disabled = true;
  aviso.style.display = 'inline'; aviso.textContent = 'Verificando...';
  try{
    const snaps = await getDocs(collection(db,'igrejas',state.igrejaAtualId,'membros'));
    const semIndice = snaps.docs.filter(d => !d.data().nomeBusca);
    if(!semIndice.length){
      aviso.textContent = 'Tudo certo, nenhum fiel precisava de correção.';
    } else {
      aviso.textContent = `Corrigindo ${semIndice.length} fiéis...`;
      let batch = writeBatch(db), count = 0;
      for(const d of semIndice){
        batch.update(d.ref, { nomeBusca: normalizarTexto(d.data().nome) });
        count++;
        if(count % 400 === 0){ await batch.commit(); batch = writeBatch(db); }
      }
      await batch.commit();
      aviso.textContent = `${semIndice.length} fiéis corrigidos!`;
      state.fieisBuscaAtual = ''; $('fieisBusca').value = '';
      await buscarFieisPagina(true); desenharTabelaFieis();
    }
  } catch(e){
    aviso.textContent = 'Erro ao corrigir: ' + e.message;
  } finally {
    btn.disabled = false;
    setTimeout(()=>{ aviso.style.display = 'none'; }, 6000);
  }
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
      const vinculado = await existeVinculo('lancamentos', 'membroId', b.dataset.del);
      if(vinculado){ toast('Não é possível excluir: esse fiel está vinculado a um ou mais lançamentos.', true); return; }
      if(!confirm('Excluir este fiel?')) return;
      await deleteDoc(doc(db,'igrejas',state.igrejaAtualId,'membros', b.dataset.del));
      await buscarFieisPagina(true);
      toast('Fiel removido.'); desenharTabelaFieis();
    });
  });
}
// Verifica se existe algum documento em `colecao` com `campo` == `valor` —
// usado para impedir excluir um registro que está em uso em outro lugar.
async function existeVinculo(colecao, campo, valor){
  const q = query(collection(db,'igrejas',state.igrejaAtualId, colecao), where(campo,'==',valor), limit(1));
  const snap = await getDocs(q);
  return !snap.empty;
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
  $('fFormRg').value = f?.rg || '';
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
    nome, nomeBusca: normalizarTexto(nome),
    cargoId: $('fFormCargo').value || null, grupoId: $('fFormGrupo').value || null,
    telefone: $('fFormTelefone').value.trim(), email: $('fFormEmail').value.trim(),
    cpf: $('fFormCpf').value.trim(), rg: $('fFormRg').value.trim(), observacoes: $('fFormObs').value.trim(),
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
      const checagens = {
        categoriasReceita: ['lancamentos','categoriaId','está usado em algum lançamento'],
        categoriasDespesa: ['lancamentos','categoriaId','está usado em algum lançamento'],
        grupos: ['membros','grupoId','está vinculado a algum fiel'],
        cargos: ['membros','cargoId','está vinculado a algum fiel'],
      };
      const [colecao, campo, msg] = checagens[state.cadTab] || [];
      if(colecao && await existeVinculo(colecao, campo, b.dataset.del)){
        toast(`Não é possível excluir: esse item ${msg}.`, true); return;
      }
      if(!confirm('Excluir este item?')) return;
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
// Igual ao resumoAnualAgregado, mas já calcula o saldo anterior (acumulado
// desde sempre) mês a mês, para exibir/exportar como coluna.
async function resumoAnualComSaldo(ano){
  const porMes = await resumoAnualAgregado(ano);
  let acumulado = await saldoAnteriorA(1, ano);
  return porMes.map(m => {
    const saldoAnterior = acumulado;
    acumulado += (m.receitas - m.despesas);
    return { ...m, saldoAnterior };
  });
}
async function renderRelatorioAnual(){
  const ano = parseInt($('relAnoAnual').value);
  $('relAnualTabela').innerHTML = `<div class="empty">Calculando...</div>`;
  const porMes = await resumoAnualComSaldo(ano);
  let totalReceitas = 0, totalDespesas = 0;
  const linhas = porMes.map((m, i) => {
    totalReceitas += m.receitas; totalDespesas += m.despesas;
    return `<tr><td>${MESES[i]}</td><td class="num">${fmtBRL(m.saldoAnterior)}</td><td class="num">${fmtBRL(m.receitas)}</td><td class="num">${fmtBRL(m.despesas)}</td><td class="num">${fmtBRL(m.receitas-m.despesas)}</td></tr>`;
  }).join('');
  $('relAnualTabela').innerHTML = `
    <div class="table-scroll"><table>
      <thead><tr><th>Mês</th><th style="text-align:right;">Saldo Anterior</th><th style="text-align:right;">Receitas</th><th style="text-align:right;">Despesas</th><th style="text-align:right;">Saldo do Mês</th></tr></thead>
      <tbody>${linhas}</tbody>
      <tfoot><tr style="font-weight:600;"><td colspan="2">Total do ano</td><td class="num">${fmtBRL(totalReceitas)}</td><td class="num">${fmtBRL(totalDespesas)}</td><td class="num">${fmtBRL(totalReceitas-totalDespesas)}</td></tr></tfoot>
    </table></div>`;
}
// Busca todos os lançamentos de um fiel, opcionalmente filtrando por um
// período de datas (independe do mês selecionado nos outros cartões —
// pode consolidar vários anos de uma vez).
async function buscarLancamentosDoFiel(fielId){
  const q = query(collection(db,'igrejas',state.igrejaAtualId,'lancamentos'), where('membroId','==',fielId));
  const snaps = await getDocs(q);
  return snaps.docs.map(d=>({id:d.id, ...d.data()}));
}
function filtrarPorPeriodo(lancs, inicio, fim){
  let r = lancs;
  if(inicio) r = r.filter(l => (l.dataStr||'') >= inicio);
  if(fim) r = r.filter(l => (l.dataStr||'') <= fim);
  return r.sort((a,b)=> (a.dataStr||'').localeCompare(b.dataStr||''));
}
async function renderRelatorioFiel(){
  const fielId = $('relFiel').value;
  if(!fielId){ $('relFielResultado').innerHTML = ''; return; }
  const inicio = $('relFielDataInicio').value, fim = $('relFielDataFim').value;
  const lancs = filtrarPorPeriodo(await buscarLancamentosDoFiel(fielId), inicio, fim);
  const total = lancs.reduce((s,l)=>s+l.valor,0);
  const rotuloPeriodo = (inicio || fim) ? 'Total no período' : 'Total geral';
  $('relFielResultado').innerHTML = `
    <div class="list-row"><strong>${rotuloPeriodo}</strong><strong class="num">${fmtBRL(total)}</strong></div>
    ${lancs.map(l=>`<div class="list-row"><span>${formatarDataBR(l.dataStr)} · ${l.categoriaNome}</span><span class="num">${fmtBRL(l.valor)}</span></div>`).join('')}
    ${!lancs.length ? '<div class="empty">Nenhuma contribuição nesse período.</div>' : ''}
  `;
}

// ---------- COMPETÊNCIAS ----------
let compInit = false;
async function renderCompetencias(){
  if(!compInit){
    populaMesAno('compMes','compAno'); compInit = true;
    $('btnReindexarLancamentos').addEventListener('click', reindexarCompetenciaLancamentos);
  }
  $('btnToggleComp').style.display = isAdmin() ? 'inline-flex' : 'none';
  $('cardReindexarLanc').style.display = isAdmin() ? 'block' : 'none';
  const snaps = await getDocs(query(collection(db,'igrejas',state.igrejaAtualId,'competencias'), orderBy('ano','desc')));
  const lista = snaps.docs.map(d=>({id:d.id, ...d.data()})).filter(c=>c.bloqueado);
  $('compLista').innerHTML = lista.length ? lista.map(c => `
    <div class="list-row"><span>${MESES[c.mes-1]} / ${c.ano}</span><span class="tag locked">bloqueado</span></div>
  `).join('') : `<div class="empty">Nenhuma competência bloqueada ainda.</div>`;
}
// Corrige lançamentos criados antes do campo "competenciaKey" existir —
// sem isso, eles ficam de fora do cálculo de saldo anterior.
async function reindexarCompetenciaLancamentos(){
  const btn = $('btnReindexarLancamentos');
  const aviso = $('lancReindexarAviso');
  btn.disabled = true;
  aviso.style.display = 'inline'; aviso.textContent = 'Verificando...';
  try{
    const snaps = await getDocs(collection(db,'igrejas',state.igrejaAtualId,'lancamentos'));
    const semChave = snaps.docs.filter(d => !d.data().competenciaKey);
    if(!semChave.length){
      aviso.textContent = 'Tudo certo, nenhum lançamento precisava de correção.';
    } else {
      aviso.textContent = `Corrigindo ${semChave.length} lançamentos...`;
      let batch = writeBatch(db), count = 0;
      for(const d of semChave){
        const v = d.data();
        if(v.mes && v.ano){
          batch.update(d.ref, { competenciaKey: competenciaKey(v.ano, v.mes) });
          count++;
          if(count % 400 === 0){ await batch.commit(); batch = writeBatch(db); }
        }
      }
      await batch.commit();
      aviso.textContent = `${count} lançamentos corrigidos!`;
      renderPainel();
    }
  } catch(e){
    aviso.textContent = 'Erro ao corrigir: ' + e.message;
  } finally {
    btn.disabled = false;
    setTimeout(()=>{ aviso.style.display = 'none'; }, 8000);
  }
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
  await carregarCompetenciasBloqueadas();
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
  $('igNomeRelatorio').value = d.nomeRelatorio||'';
  $('igPastorBusca').value = d.pastor||''; $('igPastorId').value = d.pastorFielId||'';
  $('igTesoureiroBusca').value = d.tesoureiro||''; $('igTesoureiroId').value = d.tesoureiroFielId||'';
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
    nome: $('igNome').value.trim(), nomeRelatorio: $('igNomeRelatorio').value.trim(), cnpj: $('igCnpj').value.trim(),
    pastor: $('igPastorBusca').value.trim(), pastorFielId: $('igPastorId').value || null,
    tesoureiro: $('igTesoureiroBusca').value.trim(), tesoureiroFielId: $('igTesoureiroId').value || null,
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
function gerarSenhaAleatoria(){
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let s = '';
  for(let i=0;i<8;i++) s += chars[Math.floor(Math.random()*chars.length)];
  return s;
}
$('btnConvidarUsuario').addEventListener('click', ()=>{
  $('convFormNome').value = ''; $('convFormEmail').value=''; $('convFormPapel').value='leitura';
  $('convFormSenha').value = gerarSenhaAleatoria();
  $('convFormTrocarSenha').checked = true;
  $('convFormNome').classList.remove('input-error');
  $('convFormEmail').classList.remove('input-error');
  $('convFormSenha').classList.remove('input-error');
  $('convResultado').style.display = 'none';
  renderAbasCheckboxes('convFormAbas', TODAS_ABAS);
  $('modalConvite').classList.add('active');
});
$('btnGerarSenha').addEventListener('click', ()=>{ $('convFormSenha').value = gerarSenhaAleatoria(); });
$('btnCancelarConvite').addEventListener('click', ()=> $('modalConvite').classList.remove('active'));

// Cria a conta da pessoa direto (usando uma instância separada e temporária
// do Firebase, só para não derrubar a sessão do admin que está logado) e já
// libera o acesso na hora — sem depender de e-mail nenhum.
async function criarUsuarioDireto(nome, email, senha, papel, abas, precisaTrocarSenha){
  const appTemp = initializeApp(firebaseConfig, `criar-usuario-${Date.now()}`);
  const authTemp = getAuth(appTemp);
  try{
    const cred = await createUserWithEmailAndPassword(authTemp, email, senha);
    const novoUid = cred.user.uid;
    await setDoc(doc(db,'igrejas',state.igrejaAtualId,'usuarios', novoUid), {
      uid: novoUid, nome, email, papel, abasPermitidas: abas, precisaTrocarSenha: !!precisaTrocarSenha, criadoEm: serverTimestamp()
    });
    await setDoc(doc(db,'membrosIndice', `${state.igrejaAtualId}_${novoUid}`), {
      uid: novoUid, igrejaId: state.igrejaAtualId, igrejaNome: igrejaAtual()?.nome || '',
      papel, abas, nome, email, precisaTrocarSenha: !!precisaTrocarSenha
    });
    return { ok:true };
  } finally {
    try{ await signOut(authTemp); }catch(e){}
    try{ await deleteApp(appTemp); }catch(e){}
  }
}

$('btnSalvarConvite').addEventListener('click', async ()=>{
  if(!validarObrigatorios([
    {id:'convFormNome', nome:'Nome'}, {id:'convFormEmail', nome:'E-mail'}, {id:'convFormSenha', nome:'Senha'}
  ])) return;
  const nome = $('convFormNome').value.trim();
  const email = $('convFormEmail').value.trim().toLowerCase();
  const senha = $('convFormSenha').value;
  const papel = $('convFormPapel').value;
  const abas = lerAbasCheckboxes('convFormAbas');
  const precisaTrocarSenha = $('convFormTrocarSenha').checked;
  if(email === state.user.email.toLowerCase()){
    toast('Você já tem acesso — não é possível cadastrar seu próprio e-mail de novo.', true); return;
  }
  if(senha.length < 6){
    $('convFormSenha').classList.add('input-error');
    toast('A senha precisa ter pelo menos 6 caracteres.', true); return;
  }
  const jaMembroSnap = await getDocs(query(collection(db,'igrejas',state.igrejaAtualId,'usuarios'), where('email','==',email)));
  if(!jaMembroSnap.empty){
    toast('Essa pessoa já tem acesso a esta igreja. Use "Editar" na lista de usuários.', true); return;
  }
  const btn = $('btnSalvarConvite');
  btn.disabled = true;
  try{
    await criarUsuarioDireto(nome, email, senha, papel, abas, precisaTrocarSenha);
    $('convResultado').style.display = 'block';
    $('convResultado').innerHTML = `
      <strong>Conta criada!</strong> Passe esses dados para ${nome}:<br>
      E-mail: <strong>${email}</strong><br>
      Senha: <strong>${senha}</strong><br>
      Ela já pode entrar direto no app com "Entrar" (não precisa "Criar conta").`;
    toast('Usuário cadastrado com sucesso!');
    renderUsuarios();
  } catch(e){
    if(e.code === 'auth/email-already-in-use'){
      // A pessoa já tem conta própria (de outra igreja ou uso anterior).
      // Nesse caso, criamos um convite: quando ela entrar com a conta dela,
      // o acesso libera sozinho.
      try{
        await setDoc(doc(db,'igrejas',state.igrejaAtualId,'convites', email), {
          email, papel, abas, criadoPor: state.user.uid, criadoEm: serverTimestamp()
        });
        await setDoc(doc(db,'convitesIndice', `${state.igrejaAtualId}_${email}`), {
          email, igrejaId: state.igrejaAtualId, igrejaNome: igrejaAtual()?.nome || '', papel, abas
        });
        $('convResultado').style.display = 'block';
        $('convResultado').innerHTML = `Esse e-mail já tem uma conta no app. Criamos um convite: quando <strong>${email}</strong> entrar com a conta que já tem, o acesso a esta igreja libera sozinho.`;
        toast('Convite registrado (a pessoa já tinha conta).');
        renderUsuarios();
      } catch(e2){ toast('Erro ao registrar convite: '+e2.message, true); }
    } else {
      toast('Erro ao cadastrar: ' + traduzErroAuth(e.code || '') , true);
    }
  } finally {
    btn.disabled = false;
  }
});

function abrirModalEditarUsuario(u){
  state.editandoUsuarioUid = u.id;
  state.editandoUsuarioEmail = u.email;
  $('editUsuarioEmail').textContent = u.email;
  $('editFormNome').value = u.nome || '';
  $('editFormPapel').value = u.papel;
  $('editFormTrocarSenha').checked = !!u.precisaTrocarSenha;
  renderAbasCheckboxes('editFormAbas', u.abasPermitidas || TODAS_ABAS);
  const souEu = u.id === state.user.uid;
  $('editFormPapel').disabled = souEu;
  $('editAvisoSelf').style.display = souEu ? 'block' : 'none';
  $('modalEditarUsuario').classList.add('active');
}
$('btnCancelarEditarUsuario').addEventListener('click', ()=> $('modalEditarUsuario').classList.remove('active'));
$('btnSalvarEditarUsuario').addEventListener('click', async ()=>{
  if(!validarObrigatorios([{id:'editFormNome', nome:'Nome'}])) return;
  const uid = state.editandoUsuarioUid;
  const souEu = uid === state.user.uid;
  const nome = $('editFormNome').value.trim();
  const papel = souEu ? 'admin' : $('editFormPapel').value;
  const abas = lerAbasCheckboxes('editFormAbas');
  const precisaTrocarSenha = $('editFormTrocarSenha').checked;
  try{
    await updateDoc(doc(db,'igrejas',state.igrejaAtualId,'usuarios', uid), { nome, papel, abasPermitidas: abas, precisaTrocarSenha });
    await updateDoc(doc(db,'membrosIndice', `${state.igrejaAtualId}_${uid}`), { nome, papel, abas, precisaTrocarSenha });
    $('modalEditarUsuario').classList.remove('active');
    toast('Usuário atualizado!');
    renderUsuarios();
  } catch(e){ toast('Erro ao salvar: '+e.message, true); }
});
$('btnResetSenhaUsuario').addEventListener('click', async ()=>{
  const email = state.editandoUsuarioEmail;
  if(!confirm(`Enviar e-mail de redefinição de senha para ${email}?`)) return;
  try{
    await sendPasswordResetEmail(auth, email);
    toast('E-mail de redefinição enviado!');
  } catch(e){ toast('Erro ao enviar: ' + traduzErroAuth(e.code||''), true); }
});

// ---------- EXPORTAR (XLSX) ----------
function nomeArquivoSeguro(txt){
  return (txt||'igreja').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^\w]+/g,'_');
}

$('btnExportarLanc').addEventListener('click', async ()=>{
  const f = filtrosAtivosLancamentos();
  let lancs = await buscarLancamentos(f.mes, f.ano);
  if(f.tipo) lancs = lancs.filter(l=>l.tipo===f.tipo);
  if(f.categoriaId) lancs = lancs.filter(l=>l.categoriaId===f.categoriaId);
  if(f.membroId) lancs = lancs.filter(l=>l.membroId===f.membroId);
  if(!lancs.length){ toast('Nada para exportar com esse filtro.', true); return; }
  lancs.sort((a,b)=> (a.dataStr||'').localeCompare(b.dataStr||''));
  const linhas = lancs.map(l => ({
    Data: l.dataStr ? formatarDataBR(l.dataStr) : '',
    Competência: l.mes ? `${MESES[l.mes-1]}/${l.ano}` : '',
    Tipo: l.tipo === 'receita' ? 'Receita' : 'Despesa',
    Categoria: l.categoriaNome || '',
    Descrição: l.descricao || '',
    Fiel: l.membroNome || '',
    Valor: l.valor,
    Bloqueado: isCompetenciaBloqueada(l.mes, l.ano) ? 'Sim' : 'Não'
  }));
  const ws = XLSX.utils.json_to_sheet(linhas);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Lançamentos');
  XLSX.writeFile(wb, `lancamentos_${nomeArquivoSeguro(igrejaAtual()?.nome)}_${MESES[f.mes-1]}_${f.ano}.xlsx`);
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
    Telefone: f.telefone || '', Email: f.email || '', CPF: f.cpf || '', RG: f.rg || '', Observações: f.observacoes || ''
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
    ['   Pode ser texto ou número, mas prefira TEXTO (formate a coluna como Texto no Excel) para evitar'],
    ['   que o Excel corte zeros à esquerda (ex: "007" virar 7) e desalinhe as referências entre abas.'],
    ['3. Nas abas lanc_receita e lanc_despesa, "Descrição da Receita"/"Descrição da Despesa" devem conter o ID da'],
    ['   categoria correspondente (aba cad_receitas / cad_despesas), não o nome escrito.'],
    ['4. "Nome do Fiel" (aba lanc_receita) deve conter o ID do fiel (aba cad_fieis), não o nome escrito.'],
    ['5. "Grupos e Ministérios" (aba cad_fieis) deve conter o ID do grupo (aba cad_grupo).'],
    ['6. "Cargo/Função" (aba cad_fieis) pode ser texto livre, ex: "Pastor", "Membro" — não precisa ser um ID.'],
    ['   Se você marcar aqui exatamente "Pastor" ou "Tesoureiro", ainda assim precisa indicar quem é o'],
    ['   Pastor/Tesoureiro na aba cad_igreja também (item 7) — é de lá que o app pega a assinatura dos PDFs.'],
    ['7. "Responsável (Pastor)" e "Tesoureiro" (aba cad_igreja) devem conter o ID do fiel correspondente —'],
    ['   é esse vínculo que faz o nome aparecer sozinho como assinatura nos relatórios em PDF.'],
    ['8. "Nome para Relatório" (aba cad_igreja) é opcional — é o nome que aparece no topo dos PDFs.'],
    ['   Se deixar em branco, o app usa o mesmo nome do campo "Igreja".'],
    ['9. A coluna "Data" (lanc_receita/lanc_despesa) deve estar em formato de data do Excel.'],
    ['10. "Competência", no formato "(01) Janeiro", "(02) Fevereiro"... define o MÊS DE REFERÊNCIA do'],
    ['    lançamento no app (pode ser diferente do mês da "Data", quando o pagamento foi feito depois).'],
    ['    Se deixar em branco, o app usa o mês da própria Data.'],
    ['11. "Bloqueio" / "Bloqueado?": deixe em branco se não estiver bloqueado, ou escreva'],
    ['    "Bloqueado para Edição" se estiver.'],
    ['12. Não precisa preencher todas as abas — só as que for usar.'],
    ['13. Comprovantes/fotos anexados e a logo da igreja não são importados por planilha — a logo pode ser'],
    ['    enviada depois, direto na tela "Dados da Igreja" do app (aceita PNG/JPG).'],
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
    { ID:'I1', Igreja:'Igreja Exemplo', 'Nome para Relatório':'IGREJA DE CRISTO EM EXEMPLO/RN', 'Responsável (Pastor)':'F1', Tesoureiro:'F2', 'Endereço':'Rua Principal, 100', Bairro:'Centro', Cidade:'Cidade Exemplo', Estado:'RN', Cep:'59000-000', 'E-mail':'contato@igreja.com', Instagram:'@igrejaexemplo', CNPJ:'00.000.000/0001-00' },
  ], [8, 22, 30, 18, 14, 26, 14, 18, 8, 12, 22, 18, 20]);

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

// Extrai o número do mês do texto "Competência" da planilha antiga, ex:
// "(01) Janeiro" -> 1. Se não conseguir, usa o mês da própria Data.
function mesDaCompetencia(textoCompetencia, dataObjRespaldo){
  const m = (textoCompetencia||'').toString().match(/\((\d+)\)/);
  if(m) return parseInt(m[1]);
  return dataObjRespaldo ? dataObjRespaldo.getMonth() + 1 : null;
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
      const nomeFiel = f['Nome'] || '';
      const ref = await addDoc(collection(db,'igrejas',igrejaId,'membros'), {
        nome: nomeFiel, nomeBusca: normalizarTexto(nomeFiel),
        cargoId: cargoId || null,
        grupoId: grupoRef ? grupoRef.id : null,
        telefone: f['Telefone'] != null ? String(f['Telefone']) : '',
        email: f['Email'] || '',
        cpf: f['CPF'] != null ? String(f['CPF']) : '',
        rg: f['RG'] != null ? String(f['RG']) : '',
        observacoes: f['Observações'] || '',
      });
      mapFiel[f.ID] = { id: ref.id, nome: nomeFiel };
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
      const pastorFiel = ig['Responsável (Pastor)'] ? mapFiel[ig['Responsável (Pastor)']] : null;
      const tesoureiroFiel = ig['Tesoureiro'] ? mapFiel[ig['Tesoureiro']] : null;
      const nomeIgreja = ig['Igreja'] || igrejaAtual().nome;
      await updateDoc(doc(db,'igrejas',igrejaId), {
        nome: nomeIgreja,
        nomeRelatorio: (ig['Nome para Relatório'] || nomeIgreja || '').toString(),
        pastor: pastorFiel?.nome || '', pastorFielId: pastorFiel?.id || null,
        tesoureiro: tesoureiroFiel?.nome || '', tesoureiroFielId: tesoureiroFiel?.id || null,
        endereco: ig['Endereço'] || '', bairro: ig['Bairro'] || '', cidade: ig['Cidade'] || '',
        estado: ig['Estado'] || '', cep: ig['Cep'] != null ? String(ig['Cep']) : '',
        email: ig['E-mail'] || '', instagram: ig['Instagram'] || '',
        cnpj: ig['CNPJ'] != null ? String(ig['CNPJ']) : '',
      });
      logImport('✓ Dados da igreja atualizados (incluindo assinatura de Pastor/Tesoureiro)');
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
        const mes = mesDaCompetencia(r['Competência'], dataObj);
        const cat = r['Descrição da Receita'] ? mapCatReceita[r['Descrição da Receita']] : null;
        const fiel = r['Nome do Fiel'] ? mapFiel[r['Nome do Fiel']] : null;
        return {
          tipo: 'receita', dataStr: dataObj.toISOString().slice(0,10), mes, ano, competenciaKey: competenciaKey(ano, mes),
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
        const mes = mesDaCompetencia(r['Competência'], dataObj);
        const cat = r['Descrição da Despesa'] ? mapCatDespesa[r['Descrição da Despesa']] : null;
        return {
          tipo: 'despesa', dataStr: dataObj.toISOString().slice(0,10), mes, ano, competenciaKey: competenciaKey(ano, mes),
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
function ehDizimo(nomeCategoria){
  const n = (nomeCategoria||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
  return n.includes('dizimo');
}
function nomeCabecalhoRelatorio(){
  return (state.igrejaDados.nomeRelatorio || igrejaAtual()?.nome || 'Igreja').toUpperCase();
}
// Desenha o cabeçalho padrão dos relatórios em PDF: logo, nome da igreja e
// uma barra com o título do período. Retorna o Y onde o conteúdo pode começar.
function cabecalhoRelatorioPdf(pdf, tituloBarra){
  const logo = state.igrejaDados.logo;
  let x = 14;
  if(logo){
    try{ pdf.addImage(logo, 'JPEG', 14, 6, 16, 16); x = 34; } catch(e){ /* segue sem logo */ }
  }
  pdf.setFontSize(11); pdf.setFont(undefined,'bold'); pdf.setTextColor(13,79,196);
  pdf.text('RELATÓRIO FINANCEIRO DA IGREJA', x, 12);
  pdf.setFontSize(8); pdf.setFont(undefined,'normal'); pdf.setTextColor(180,120,20);
  pdf.text('Departamento de Tesouraria', x, 17);
  pdf.setTextColor(0);

  pdf.setFillColor(13,79,196);
  pdf.rect(14, 24, 182, 6.5, 'F');
  pdf.setTextColor(255); pdf.setFontSize(9.5); pdf.setFont(undefined,'bold');
  pdf.text(nomeCabecalhoRelatorio(), 105, 28.6, { align:'center' });

  pdf.setFillColor(230,238,252);
  pdf.rect(14, 31, 182, 6, 'F');
  pdf.setFontSize(9); pdf.setTextColor(13,79,196);
  pdf.text(tituloBarra, 105, 35.3, { align:'center' });
  pdf.setTextColor(0); pdf.setFont(undefined,'normal');
  return 40;
}
function faixaTitulo(pdf, y, texto){
  pdf.setFillColor(30,41,59);
  pdf.rect(14, y, 182, 6, 'F');
  pdf.setTextColor(255); pdf.setFontSize(9); pdf.setFont(undefined,'bold');
  pdf.text(texto, 105, y+4.3, { align:'center' });
  pdf.setTextColor(0); pdf.setFont(undefined,'normal');
  return y + 6;
}
function faixaTotal(pdf, y, texto, valor, cor){
  pdf.setFillColor(...(cor||[220,235,245]));
  pdf.rect(14, y, 182, 6, 'F');
  pdf.setFontSize(9); pdf.setFont(undefined,'bold');
  pdf.text(texto, 18, y+4.3);
  pdf.text(fmtBRL(valor), 192, y+4.3, { align:'right' });
  pdf.setFont(undefined,'normal');
  return y + 8.5;
}
function desenharAssinaturas(pdf, y){
  const pastor = state.igrejaDados.pastor || '';
  const tesoureiro = state.igrejaDados.tesoureiro || '';
  pdf.setFontSize(8.5);
  pdf.setDrawColor(0);
  pdf.line(30, y, 90, y);
  pdf.line(120, y, 180, y);
  pdf.text(pastor || '—', 60, y+4.5, { align:'center' });
  pdf.text('Pastor', 60, y+9, { align:'center' });
  pdf.text(tesoureiro || '—', 150, y+4.5, { align:'center' });
  pdf.text('Tesoureiro', 150, y+9, { align:'center' });
  return y + 9;
}
// Garante que ainda cabe "alturaMin" mm antes do fim da página; se não
// couber, abre página nova e já redesenha o cabeçalho padrão do relatório
// (assim nenhuma barra de título/total fica cortada ou "solta" sem
// contexto no topo de uma página). Usado antes de qualquer elemento
// desenhado na mão (faixaTitulo/faixaTotal/assinaturas) — as tabelas do
// autoTable já paginam sozinhas.
function garantirEspaco(pdf, y, alturaMin, tituloBarra){
  if(y + alturaMin > 283){
    pdf.addPage();
    return cabecalhoRelatorioPdf(pdf, tituloBarra);
  }
  return y;
}
// Soma tudo o que aconteceu ANTES da data informada (para o "saldo anterior")
// Soma tudo o que aconteceu ANTES da data informada (para o "saldo
// anterior"). Usa um único filtro de intervalo (dataStr < limite), que o
// Firestore sempre indexa sozinho — assim nunca depende de criar um índice
// composto manualmente.
// Soma tudo o que aconteceu em competências ANTERIORES à informada (não
// pela Data do pagamento — pela Competência, que é o critério usado em
// todo o resto do app). Usa um único filtro de intervalo sobre o campo
// "competenciaKey" (texto "AAAA-MM"), que o Firestore sempre indexa
// sozinho, sem precisar de índice composto manual.
async function saldoAnteriorA(mes, ano){
  const id = state.igrejaAtualId;
  const chaveLimite = competenciaKey(ano, mes);
  const q = query(collection(db,'igrejas',id,'lancamentos'), where('competenciaKey','<',chaveLimite));
  const snaps = await getDocs(q);
  let receitas = 0, despesas = 0;
  snaps.docs.forEach(d => {
    const v = d.data();
    if(v.tipo === 'receita') receitas += (v.valor||0);
    else if(v.tipo === 'despesa') despesas += (v.valor||0);
  });
  return receitas - despesas;
}
function nomeArquivoPdf(prefixo){
  return `${prefixo}_${nomeArquivoSeguro(igrejaAtual()?.nome)}_${Date.now()}.pdf`;
}

$('btnPdfMensal').addEventListener('click', async ()=>{
  const btn = $('btnPdfMensal');
  btn.disabled = true; toast('Gerando PDF...');
  try{
    const mes = parseInt($('relMes').value), ano = parseInt($('relAno').value);
    const lancs = await buscarLancamentos(mes, ano);
    const ordenarPorFiel = (lista) => [...lista].sort((a,b) => {
      const na = (a.membroNome||'').trim(), nb = (b.membroNome||'').trim();
      if(!na && !nb) return 0;
      if(!na) return 1;
      if(!nb) return -1;
      return na.localeCompare(nb, 'pt-BR');
    });
    const receitas = ordenarPorFiel(lancs.filter(l=>l.tipo==='receita'));
    const despesas = lancs.filter(l=>l.tipo==='despesa').sort((a,b)=>(a.dataStr||'').localeCompare(b.dataStr||''));
    const dizimos = receitas.filter(l => ehDizimo(l.categoriaNome));
    const ofertas = receitas.filter(l => !ehDizimo(l.categoriaNome));
    const totalDizimos = dizimos.reduce((s,l)=>s+l.valor,0);
    const totalOfertas = ofertas.reduce((s,l)=>s+l.valor,0);
    const totalEntradas = totalDizimos + totalOfertas;
    const totalSaidas = despesas.reduce((s,l)=>s+l.valor,0);
    const saldoAnterior = await saldoAnteriorA(mes, ano);
    const saldoMes = totalEntradas - totalSaidas;

    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF();
    const tituloPeriodo = `RELATÓRIO DO MÊS DE ${MESES[mes-1].toUpperCase()} DE ${ano}`;

    // ---- PÁGINA 1: dizimistas + ofertas (por ordem alfabética do fiel) ----
    let y = cabecalhoRelatorioPdf(pdf, tituloPeriodo);
    y = faixaTitulo(pdf, y, 'RELAÇÃO DE DIZIMISTAS E SEUS VALORES');

    const linhasDizimos = dizimos.map((l,i) => [i+1, l.membroNome||'—', formatarDataBR(l.dataStr), fmtBRL(l.valor)]);
    if(linhasDizimos.length){
      const metade = Math.ceil(linhasDizimos.length/2);
      const colEsq = linhasDizimos.slice(0, metade), colDir = linhasDizimos.slice(metade);
      const opcoes = { head:[['N°','Nome','Data','Valor']], theme:'grid', styles:{fontSize:6.5, cellPadding:1}, headStyles:{fillColor:[13,79,196], fontSize:6.5}, columnStyles:{3:{halign:'right'}}, margin:{bottom:12} };
      pdf.autoTable({ ...opcoes, startY:y, body:colEsq, margin:{...opcoes.margin, left:14, right:106} });
      let y1 = pdf.lastAutoTable.finalY;
      let y2 = y1;
      if(colDir.length){
        pdf.autoTable({ ...opcoes, startY:y, body:colDir, margin:{...opcoes.margin, left:106, right:14} });
        y2 = pdf.lastAutoTable.finalY;
      }
      y = Math.max(y1,y2) + 2;
    } else {
      pdf.setFontSize(8); pdf.text('Nenhum dízimo registrado neste mês.', 14, y+5); y += 9;
    }
    y = garantirEspaco(pdf, y, 8.5, tituloPeriodo);
    y = faixaTotal(pdf, y, 'TOTAL DE DÍZIMOS (R$)', totalDizimos);

    y = garantirEspaco(pdf, y, 25, tituloPeriodo);
    y = faixaTitulo(pdf, y, 'RELAÇÃO DE OFERTAS');
    const linhasOfertas = ofertas.map((l,i) => [
      i+1, l.membroNome||'', [l.categoriaNome, l.descricao].filter(Boolean).join(' - '), formatarDataBR(l.dataStr), fmtBRL(l.valor)
    ]);
    pdf.autoTable({
      startY:y, head:[['N°','Nome do ofertante','Tipo de oferta','Data','Valor']],
      body: linhasOfertas.length ? linhasOfertas : [['—','Nenhuma oferta registrada neste mês.','','','']],
      theme:'grid', styles:{fontSize:6.5, cellPadding:1.2}, headStyles:{fillColor:[13,79,196], fontSize:6.5},
      columnStyles:{4:{halign:'right'}}, margin:{left:14,right:14,bottom:12}
    });
    y = pdf.lastAutoTable.finalY + 2;
    y = garantirEspaco(pdf, y, 8.5, tituloPeriodo);
    y = faixaTotal(pdf, y, 'TOTAL DE OFERTAS (R$)', totalOfertas);
    y = garantirEspaco(pdf, y, 8.5, tituloPeriodo);
    y = faixaTotal(pdf, y, 'TOTAL DE ENTRADAS DO MÊS (R$)', totalEntradas, [200,230,210]);

    // Só abre página nova pra assinatura se realmente não couber (raro,
    // meses com volume bem fora do comum) — refaz o cabeçalho pra não
    // deixar uma página "solta" sem contexto.
    y = garantirEspaco(pdf, y, 19, tituloPeriodo);
    y = desenharAssinaturas(pdf, y + 10);

    // ---- PÁGINA(S) SEGUINTE(S): despesas (por data) + balanço final ----
    // Sempre em página própria, para manter a separação clara do modelo —
    // mas só isso; o conteúdo em si já está compacto o bastante para caber
    // numa única página em qualquer mês de volume normal.
    pdf.addPage();
    y = cabecalhoRelatorioPdf(pdf, tituloPeriodo);
    y = faixaTitulo(pdf, y, 'RELAÇÃO DE DESPESAS');
    const linhasDespesas = despesas.map((l,i) => [i+1, [l.categoriaNome, l.descricao].filter(Boolean).join(' - '), formatarDataBR(l.dataStr), fmtBRL(l.valor)]);
    pdf.autoTable({
      startY:y, head:[['N°','Descrição da despesa','Data','Valor (R$)']],
      body: linhasDespesas.length ? linhasDespesas : [['—','Nenhuma despesa registrada neste mês.','','']],
      theme:'grid', styles:{fontSize:6.5, cellPadding:1.2}, headStyles:{fillColor:[199,63,63], fontSize:6.5},
      columnStyles:{3:{halign:'right'}}, margin:{left:14,right:14,bottom:12}
    });
    y = pdf.lastAutoTable.finalY + 2;
    y = garantirEspaco(pdf, y, 8.5, tituloPeriodo);
    y = faixaTotal(pdf, y, 'TOTAL DE DESPESAS (R$)', totalSaidas, [248,215,215]);

    y = garantirEspaco(pdf, y, 55, tituloPeriodo);
    y = faixaTitulo(pdf, y, 'BALANÇO FINAL');
    const percentual = totalEntradas > 0 ? ((totalSaidas/totalEntradas)*100).toFixed(2)+'%' : '—';
    const linhasBalanco = [
      ['Total de entradas do mês', fmtBRL(totalEntradas)],
      ['Total de saídas do mês', fmtBRL(totalSaidas)],
      ['Percentual despesa/receita', percentual],
      ['Saldo do mês', fmtBRL(saldoMes)],
      ['Saldo anterior', fmtBRL(saldoAnterior)],
      ['Saldo para o próximo mês', fmtBRL(saldoAnterior + saldoMes)],
    ];
    pdf.autoTable({
      startY:y, body: linhasBalanco, theme:'grid', styles:{fontSize:8.5, cellPadding:2}, margin:{bottom:12},
      columnStyles:{0:{fontStyle:'bold'}, 1:{halign:'right'}},
      didParseCell: (data)=>{ if(data.row.index === linhasBalanco.length-1) data.row.cells[0].styles.fillColor = data.row.cells[1].styles.fillColor = [210,235,215]; }
    });
    y = pdf.lastAutoTable.finalY + 10;
    y = garantirEspaco(pdf, y, 9, tituloPeriodo);
    desenharAssinaturas(pdf, y);

    pdf.save(nomeArquivoPdf(`relatorio_mensal_${MESES[mes-1]}_${ano}`));
    toast('PDF gerado!');
  } catch(e){
    console.error('Erro ao gerar PDF mensal:', e);
    toast('Erro ao gerar o PDF: ' + e.message, true);
  } finally {
    btn.disabled = false;
  }
});

$('btnPdfAnual').addEventListener('click', async ()=>{
  const btn = $('btnPdfAnual');
  btn.disabled = true; toast('Gerando PDF...');
  try{
    const ano = parseInt($('relAnoAnual').value);
    const porMes = await resumoAnualComSaldo(ano);
    let totalR = 0, totalD = 0;
    const linhas = porMes.map((m,i)=>{
      totalR += m.receitas; totalD += m.despesas;
      return [MESES[i], fmtBRL(m.saldoAnterior), fmtBRL(m.receitas), fmtBRL(m.despesas), fmtBRL(m.receitas-m.despesas)];
    });
    linhas.push(['Total', '', fmtBRL(totalR), fmtBRL(totalD), fmtBRL(totalR-totalD)]);

    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF();
    const tituloAnual = `FLUXO DE CAIXA ANUAL — ${ano}`;
    const y = cabecalhoRelatorioPdf(pdf, tituloAnual);
    pdf.autoTable({
      startY: y, head:[['Mês','Saldo Anterior','Receitas','Despesas','Saldo do Mês']], body: linhas,
      theme:'grid', headStyles:{fillColor:[13,79,196]}, margin:{left:14,right:14,bottom:12},
      columnStyles:{1:{halign:'right'}, 2:{halign:'right'}, 3:{halign:'right'}, 4:{halign:'right'}},
      didParseCell: (data)=>{ if(data.row.index === linhas.length-1) data.cell.styles.fontStyle = 'bold'; }
    });
    const yAssinatura = garantirEspaco(pdf, pdf.lastAutoTable.finalY + 15, 9, tituloAnual);
    desenharAssinaturas(pdf, yAssinatura);
    pdf.save(nomeArquivoPdf(`fluxo_anual_${ano}`));
    toast('PDF gerado!');
  } catch(e){
    console.error('Erro ao gerar PDF anual:', e);
    toast('Erro ao gerar o PDF: ' + e.message, true);
  } finally {
    btn.disabled = false;
  }
});

$('btnPdfFiel').addEventListener('click', async ()=>{
  const fielId = $('relFiel').value;
  if(!fielId){ toast('Selecione um fiel primeiro.', true); return; }
  const btn = $('btnPdfFiel');
  btn.disabled = true; toast('Gerando PDF...');
  try{
    const nomeFiel = $('relFielBusca').value.trim();
    const inicio = $('relFielDataInicio').value, fim = $('relFielDataFim').value;
    const lancs = filtrarPorPeriodo(await buscarLancamentosDoFiel(fielId), inicio, fim);
    const total = lancs.reduce((s,l)=>s+l.valor,0);
    const periodoTexto = (inicio || fim)
      ? `Período: ${inicio ? formatarDataBR(inicio) : 'início'} até ${fim ? formatarDataBR(fim) : 'hoje'}`
      : 'Período: todo o histórico';

    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF();
    const tituloExtrato = `EXTRATO DE CONTRIBUIÇÕES — ${nomeFiel.toUpperCase()}`;
    const y = cabecalhoRelatorioPdf(pdf, tituloExtrato);
    pdf.setFontSize(8.5); pdf.setTextColor(100); pdf.text(periodoTexto, 14, y-3); pdf.setTextColor(0);
    const linhas = lancs.map(l => [formatarDataBR(l.dataStr), l.categoriaNome||'', fmtBRL(l.valor)]);
    pdf.autoTable({
      startY: y, head:[['Data','Categoria','Valor']], body: linhas.length?linhas:[['—','Nenhuma contribuição registrada','—']],
      theme:'grid', headStyles:{fillColor:[13,79,196]}, columnStyles:{2:{halign:'right'}}, margin:{left:14,right:14,bottom:12}
    });
    let yFinal = garantirEspaco(pdf, pdf.lastAutoTable.finalY + 15, 24, tituloExtrato);
    pdf.setFontSize(11); pdf.setFont(undefined,'bold');
    pdf.text(`Total geral: ${fmtBRL(total)}`, 14, yFinal);
    pdf.setFont(undefined,'normal');
    desenharAssinaturas(pdf, yFinal + 15);

    pdf.save(nomeArquivoPdf(`extrato_${nomeArquivoSeguro(nomeFiel)}`));
    toast('PDF gerado!');
  } catch(e){
    console.error('Erro ao gerar PDF do fiel:', e);
    toast('Erro ao gerar o PDF: ' + e.message, true);
  } finally {
    btn.disabled = false;
  }
});

// ---------- PWA: registra o service worker ----------
// Assim o app pode ser instalado no celular (ícone próprio, tela cheia) e
// funciona offline pra abrir a tela de login. Atualizações são detectadas
// sozinhas na próxima vez que o app abrir com internet.
if('serviceWorker' in navigator){
  window.addEventListener('load', ()=>{
    navigator.serviceWorker.register('./sw.js').catch(()=>{ /* offline na primeira visita, sem problema */ });
  });
}
