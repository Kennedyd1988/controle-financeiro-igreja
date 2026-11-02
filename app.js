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

import { iniciarAgendas, renderAgendas, resetarAgendas, renderPainelAgendas, FUNCOES_PADRAO } from "./agendas.js?v=16";

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
  { id: 'campanhas', label: 'Campanhas' },
  { id: 'financeiro', label: 'Financeiro (contas, extrato e conciliação)' },
  { id: 'agendas', label: 'Agendas semanais (programação, escalas e mensagens)' },
];
const TODAS_ABAS = ABAS_CONFIGURAVEIS.map(a => a.id);

const hoje = new Date();
// Formata uma data no fuso horário LOCAL do aparelho (não em UTC). Usar
// toISOString() aqui seria um erro clássico: ele converte pra UTC antes de
// formatar, o que "pula" pro dia seguinte à noite em fusos atrás do UTC
// (como o Brasil) — por isso essa função existe.
function dataLocalISO(d){
  d = d || new Date();
  const ano = d.getFullYear();
  const mes = String(d.getMonth()+1).padStart(2,'0');
  const dia = String(d.getDate()).padStart(2,'0');
  return `${ano}-${mes}-${dia}`;
}
const state = {
  user: null,
  perfil: null,
  igrejas: [],          // [{id, nome, papel, abas}]
  igrejaAtualId: null,
  podeCriarIgreja: false, // só quem é administrador de alguma igreja cria igrejas (ver verificarPodeCriarIgreja)
  origemAdminId: null,    // uma igreja onde o usuário é admin; a regra do Firestore confere
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
  logoTopoPendente: null, marcaPendente: null,
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
  lancModalOrigemPainel: false,
  campanhas: [],
  contas: [],
  campanhaAtualId: null,
  campanhaAtualDados: null,
  editandoCampanhaId: null,
  editandoCampLancId: null,
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
function iniciais(nome){
  const partes = (nome||'').trim().split(/\s+/).filter(Boolean);
  if(!partes.length) return '—';
  return partes.length === 1 ? partes[0].slice(0,2).toUpperCase() : (partes[0][0] + partes[partes.length-1][0]).toUpperCase();
}
// Barra fina no topo indicando que dados estão sendo buscados no Firestore —
// evita telas em branco durante trocas de aba/igreja sem feedback nenhum.
let loadingDepth = 0;
function mostrarCarregando(){
  loadingDepth++;
  const bar = $('loadingBar');
  bar.classList.remove('done');
  bar.classList.add('active');
}
function esconderCarregando(){
  loadingDepth = Math.max(0, loadingDepth - 1);
  if(loadingDepth > 0) return;
  const bar = $('loadingBar');
  bar.classList.remove('active');
  bar.classList.add('done');
  setTimeout(()=>{ bar.classList.remove('done'); }, 300);
}
async function comCarregando(promessa){
  mostrarCarregando();
  try{ return await promessa; }
  finally{ esconderCarregando(); }
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

// Ordena em ordem alfabética (ignorando acento/maiúscula), usado em toda
// lista de cadastro/seleção do app (categorias, grupos, cargos, usuários,
// campanhas...). Não se aplica a listas de lançamentos/histórico, que
// continuam por data, nem ao resumo de receitas/despesas por categoria dos
// relatórios, que continua por valor (mais útil pra enxergar o que mais
// pesa no caixa).
function ordenarPorNome(lista, campo){
  const chave = campo || 'nome';
  return [...lista].sort((a,b) => (a[chave]||'').localeCompare(b[chave]||'', 'pt-BR', {sensitivity:'base'}));
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

$('btnEsqueciSenha').addEventListener('click', async ()=>{
  let email = $('inputEmail').value.trim();
  if(!email){
    email = (prompt('Digite o e-mail da sua conta:') || '').trim();
  }
  if(!email){ return; }
  $('authError').textContent = '';
  try{
    await sendPasswordResetEmail(auth, email);
    $('authError').style.color = 'var(--green)';
    $('authError').textContent = `Enviamos um link de redefinição para ${email}. Verifique também a caixa de spam.`;
  } catch(e){
    $('authError').style.color = '';
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
$('btnSairSeletorIgreja').addEventListener('click', ()=> signOut(auth));

onAuthStateChanged(auth, async (user)=>{
  if(user){
    mostrarCarregando();
    state.user = user;
    await carregarPerfil(user);
    await resgatarConvitesPendentes(user);
    await buscarListaIgrejasDoUsuario(user);
    esconderCarregando();
    $('authScreen').style.display = 'none';
    if(state.igrejas.length === 0){
      $('appShell').className = 'active';
      switchView('novaIgreja');
    } else if(state.igrejas.length === 1){
      state.igrejaAtualId = state.igrejas[0].id;
      $('igrejaSwitch').value = state.igrejaAtualId;
      $('appShell').className = 'active';
      await onIgrejaChange();
      if(state.igrejas.some(i => i.precisaTrocarSenha)) abrirModalTrocarSenhaObrigatoria();
    } else {
      mostrarSeletorDeIgreja();
    }
  } else {
    state.user = null;
    $('authScreen').style.display = 'flex';
    $('appShell').className = '';
    if($('selecionarIgrejaScreen')) $('selecionarIgrejaScreen').style.display = 'none';
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
  $('userAvatar').textContent = iniciais(state.perfil.nome);
}

// Verifica se existe convite (em qualquer igreja) para o e-mail do usuário logado,
// consultando o índice "convitesIndice" (coleção de nível raiz — evitamos
// collectionGroup, que o Firestore trata de forma mais restrita nas regras).
// Retorna os nomes das igrejas onde o acesso foi liberado agora. Cada convite
// tem seu próprio try/catch: antes, um convite com problema derrubava o laço
// inteiro e os demais ficavam pendentes sem nenhum aviso.
async function resgatarConvitesPendentes(user){
  const liberadas = [];
  try{
    const q = query(collection(db, 'convitesIndice'), where('email', '==', user.email));
    const snaps = await getDocs(q);
    for(const convDoc of snaps.docs){
     try{
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
        liberadas.push(dados.igrejaNome || 'nova igreja');
      }
      await deleteDoc(doc(db, 'igrejas', igrejaId, 'convites', user.email));
      await deleteDoc(convDoc.ref);
     } catch(e){ console.warn('Convite não resgatado:', e.message); }
    }
  } catch(e){ console.warn('Sem convites pendentes:', e.message); }
  return liberadas;
}

// O resgate normal só roda no login; quem já estava com o app aberto (ou
// instalado, sessão eterna) nunca via a igreja nova. Por isso também roda ao
// voltar para o app (no máximo a cada 30s) e pelo botão "Atualizar acessos".
let convitesVerificando = false, convitesUltimaVerificacao = 0;
async function atualizarConvitesAgora(manual){
  if(!state.user || convitesVerificando) return;
  convitesVerificando = true;
  convitesUltimaVerificacao = Date.now();
  try{
    const novas = await resgatarConvitesPendentes(state.user);
    if(novas.length){
      await buscarListaIgrejasDoUsuario(state.user);
      if(state.igrejaAtualId) $('igrejaSwitch').value = state.igrejaAtualId;
      toast('Novo acesso liberado: ' + novas.join(', ') + '. Escolha no seletor de igreja.');
    } else if(manual){
      toast('Nenhum convite novo.');
    }
  } catch(e){
    if(manual) toast('Erro ao verificar convites: ' + e.message, true);
  } finally { convitesVerificando = false; }
}
document.addEventListener('visibilitychange', ()=>{
  if(document.visibilityState === 'visible' && state.igrejaAtualId && Date.now() - convitesUltimaVerificacao > 30000){
    atualizarConvitesAgora(false);
  }
});

// Busca em quais igrejas o usuário está, consultando o índice "membrosIndice"
// (coleção de nível raiz, uma consulta simples e direta por uid).
// Só busca a lista de igrejas do usuário (sem entrar em nenhuma) — usado
// no login, antes de mostrar a tela de escolher a igreja.
async function buscarListaIgrejasDoUsuario(user){
  const q = query(collection(db, 'membrosIndice'), where('uid', '==', user.uid));
  const snaps = await getDocs(q);
  // Busca o nome ATUAL de cada igreja (em vez de confiar só no que estava
  // salvo no índice, que só é atualizado por quem editou por último) —
  // assim o menu de troca de igreja sempre mostra o nome certo pra todo
  // mundo, não só pra quem fez a alteração.
  state.igrejas = await Promise.all(snaps.docs.map(async (d) => {
    const dado = d.data();
    let nome = dado.igrejaNome;
    let logo = null;
    try{
      const igSnap = await getDoc(doc(db,'igrejas', dado.igrejaId));
      if(igSnap.exists()){
        if(igSnap.data().nome) nome = igSnap.data().nome;
        logo = igSnap.data().logo || null;
      }
    } catch(e){ /* usa o nome salvo no índice como respaldo */ }
    return { id: dado.igrejaId, nome, logo, papel: dado.papel, abas: dado.abas || TODAS_ABAS, precisaTrocarSenha: !!dado.precisaTrocarSenha };
  }));
  const sel = $('igrejaSwitch');
  sel.innerHTML = state.igrejas.length
    ? state.igrejas.map(i => `<option value="${i.id}">${i.nome}</option>`).join('')
    : `<option>Nenhuma igreja ainda</option>`;
  await verificarPodeCriarIgreja(user);
}

// Só administradores criam igrejas: quem é admin de ALGUMA igreja neste
// momento. Nada é gravado à parte — a regra do Firestore confere o papel
// atual na igreja informada em "origemAdminId", então rebaixar alguém tira
// o direito na hora. A interface só esconde o botão; quem barra é a regra.
async function verificarPodeCriarIgreja(user){
  const adminEm = state.igrejas.find(i => i.papel === 'admin');
  state.origemAdminId = adminEm ? adminEm.id : null;
  const pode = !!adminEm;
  state.podeCriarIgreja = pode;
  const nav = $('navNovaIgreja');
  if(nav) nav.style.display = pode ? 'flex' : 'none';
}

// Tela "Nova igreja": formulário para admin; aviso + "Verificar convites" para os demais.
function renderNovaIgreja(){
  const pode = state.podeCriarIgreja;
  $('novaIgrejaForm').style.display = pode ? 'block' : 'none';
  $('novaIgrejaBloqueada').style.display = pode ? 'none' : 'block';
  const desc = document.querySelector('#view-novaIgreja .view-desc');
  const tit = document.querySelector('#view-novaIgreja .view-title');
  if(tit) tit.textContent = pode ? 'Cadastrar nova igreja' : 'Aguardando acesso';
  if(desc) desc.textContent = pode ? 'Você se torna administrador dela automaticamente' : 'Peça ao administrador para liberar o seu e-mail';
}

// Procura convites agora, sem precisar sair e entrar (o resgate normal só
// roda no login — por isso quem já estava logado ficava preso nesta tela).
$('btnVerificarConvites').addEventListener('click', async ()=>{
  const btn = $('btnVerificarConvites');
  btn.disabled = true;
  try{
    await resgatarConvitesPendentes(state.user);
    await buscarListaIgrejasDoUsuario(state.user);
    if(state.igrejas.length === 0){ toast('Nenhum convite encontrado ainda.', true); return; }
    state.igrejaAtualId = state.igrejas[0].id;
    $('igrejaSwitch').value = state.igrejaAtualId;
    await onIgrejaChange();
    switchView('painel');
    toast('Acesso liberado!');
  } catch(e){ toast('Erro ao verificar convites: ' + e.message, true); }
  finally { btn.disabled = false; }
});
$('btnSairSemIgreja').addEventListener('click', ()=> signOut(auth));
$('btnAtualizarConvites').addEventListener('click', async ()=>{
  const b = $('btnAtualizarConvites');
  b.disabled = true;
  await atualizarConvitesAgora(true);
  b.disabled = false;
});

// Recarrega a lista e mantém a igreja atual selecionada — usado durante o
// uso normal do app (depois de criar igreja, editar nome, importar, etc.),
// não no primeiro login (que passa pela tela de escolha).
async function carregarIgrejasDoUsuario(user){
  await buscarListaIgrejasDoUsuario(user);
  if(state.igrejas.length === 0){
    switchView('novaIgreja');
    return;
  }
  if(!state.igrejaAtualId || !state.igrejas.some(i => i.id === state.igrejaAtualId)){
    state.igrejaAtualId = state.igrejas[0].id;
  }
  $('igrejaSwitch').value = state.igrejaAtualId;
  await onIgrejaChange();
  if(state.igrejas.some(i => i.precisaTrocarSenha)) abrirModalTrocarSenhaObrigatoria();
}

// Tela de "escolher em qual igreja entrar", mostrada no login quando o
// usuário tem acesso a mais de uma igreja.
function mostrarSeletorDeIgreja(){
  const lista = [...state.igrejas].sort((a,b) =>
    (a.nome||'').localeCompare(b.nome||'', 'pt-BR', {sensitivity:'base'}));
  $('seletorIgrejaLista').innerHTML = lista.map(i => `
    <button class="seletor-igreja-card" type="button" data-id="${i.id}">
      <img class="seletor-igreja-logo" src="${i.logo || 'logo-simbolo.png'}" alt="">
      <span class="seletor-igreja-nome">${i.nome}</span>
      <span class="papel-badge">${PAPEL_LABEL[i.papel] || i.papel}</span>
    </button>`).join('');
  $('seletorIgrejaLista').querySelectorAll('[data-id]').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      state.igrejaAtualId = btn.dataset.id;
      $('igrejaSwitch').value = state.igrejaAtualId;
      $('selecionarIgrejaScreen').style.display = 'none';
      $('appShell').className = 'active';
      mostrarCarregando();
      await onIgrejaChange();
      esconderCarregando();
      if(state.igrejas.some(i => i.precisaTrocarSenha)) abrirModalTrocarSenhaObrigatoria();
    });
  });
  $('selecionarIgrejaScreen').style.display = 'flex';
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
  state.campanhas = []; state.campanhaAtualId = null; state.campanhaAtualDados = null;
  resetarAgendas();   // cultos padrão/lembretes/rodízio são por igreja
  mostrarCarregando();
  await carregarDadosDaIgreja();
  await carregarCompetenciasBloqueadas();
  esconderCarregando();
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
  const [igSnap, catR, catD, grp, crg, ctas] = await Promise.all([
    getDoc(doc(db, 'igrejas', id)).catch(()=>({ exists:()=>false })),
    temCadastros ? buscarSeguro(getDocs(collection(db,'igrejas',id,'categoriasReceita')), []) : [],
    temCadastros ? buscarSeguro(getDocs(collection(db,'igrejas',id,'categoriasDespesa')), []) : [],
    temCadastros ? buscarSeguro(getDocs(collection(db,'igrejas',id,'grupos')), []) : [],
    temCadastros ? buscarSeguro(getDocs(collection(db,'igrejas',id,'cargos')), []) : [],
    (temAcesso('lancamentos') || temAcesso('financeiro')) ? buscarSeguro(getDocs(collection(db,'igrejas',id,'contas')), []) : [],
  ]);
  state.igrejaDados = igSnap.exists() ? igSnap.data() : {};
  state.categoriasReceita = catR;
  state.categoriasDespesa = catD;
  state.grupos = grp;
  state.cargos = crg;
  state.contas = ctas;
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
configurarComboboxFiel('campFormResponsavelBusca', 'campFormResponsavelId', 'campFormResponsavelLista');
configurarComboboxFiel('campLancFormFielBusca', 'campLancFormFiel', 'campLancFormFielLista');

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
    igreja: renderIgreja, usuarios: renderUsuarios, novaIgreja: renderNovaIgreja,
    importar: renderImportar, campanhas: renderCampanhas, financeiro: renderFinanceiro, agendas: renderAgendas,
  };
  if(map[name]) comCarregando(Promise.resolve(map[name]()));
}

// ---------- NOVA IGREJA (bootstrap) ----------
$('btnCriarIgreja').addEventListener('click', async ()=>{
  if(!state.podeCriarIgreja){ toast('Apenas administradores podem criar igrejas.', true); return; }
  if(!validarObrigatorios([{id:'novaIgrejaNome', nome:'Nome da igreja'}])) return;
  const nome = $('novaIgrejaNome').value.trim();
  const btnCriar = $('btnCriarIgreja');
  btnCriar.disabled = true;   // evita duas igrejas por duplo toque
  try{
    // bootstrapPendente: permite ao criador gravar o PRÓPRIO vínculo de admin
    // (regra do Firestore) uma única vez; é desligado logo depois.
    const igrejaRef = await addDoc(collection(db, 'igrejas'), {
      nome, pastor:'', tesoureiro:'', endereco:'', bairro:'', cidade:'', estado:'', cep:'',
      email:'', instagram:'', cnpj:'', logo:null, criadoEm: serverTimestamp(),
      criadoPor: state.user.uid, origemAdminId: state.origemAdminId, bootstrapPendente: true
    });
    await setDoc(doc(db, 'igrejas', igrejaRef.id, 'usuarios', state.user.uid), {
      uid: state.user.uid, nome: state.perfil.nome, email: state.user.email,
      papel: 'admin', abasPermitidas: TODAS_ABAS, criadoEm: serverTimestamp()
    });
    await updateDoc(doc(db, 'igrejas', igrejaRef.id), { bootstrapPendente: false });
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
  finally { btnCriar.disabled = false; }
});

// ---------- EXCLUIR IGREJA ----------
// Subcoleções simples (sem filhos) apagadas em lotes antes da igreja em si —
// o Firestore NÃO apaga subcoleções junto com o documento pai, e sem esta
// limpeza ficariam dados órfãos (e pagos) para sempre.
const SUBCOLECOES_IGREJA = [
  'membros','grupos','cargos','categoriasReceita','categoriasDespesa','contas','competencias',
  'cultosPadrao','agendas','participacoes','lembretes','mensagens','configAgenda'
];

// Apaga todos os docs de uma coleção, 400 por lote.
async function apagarColecaoEmLotes(caminho){
  for(;;){
    const snap = await getDocs(query(collection(db, ...caminho), limit(400)));
    if(snap.empty) return;
    const batch = writeBatch(db);
    snap.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
    if(snap.size < 400) return;
  }
}

// Regra de negócio: igreja com QUALQUER lançamento (geral ou de campanha) não
// pode ser excluída. Retorna null se está livre, ou o motivo do bloqueio.
async function motivoBloqueioExclusao(igrejaId){
  const lanc = await getDocs(query(collection(db,'igrejas',igrejaId,'lancamentos'), limit(1)));
  if(!lanc.empty) return 'Esta igreja possui lançamentos. Só é possível excluir uma igreja sem nenhum lançamento.';
  const camps = await getDocs(collection(db,'igrejas',igrejaId,'campanhas'));
  for(const c of camps.docs){
    const l = await getDocs(query(collection(db,'igrejas',igrejaId,'campanhas',c.id,'lancamentos'), limit(1)));
    if(!l.empty) return `A campanha "${c.data().nome || c.id}" possui lançamentos. Só é possível excluir uma igreja sem nenhum lançamento.`;
  }
  return null;
}

$('btnExcluirIgreja').addEventListener('click', async ()=>{
  if(!isAdmin()){ toast('Apenas administradores podem excluir a igreja.', true); return; }
  // Sem igreja onde seja admin, a pessoa perderia o direito de criar outra
  // (e o de excluir): por isso a última igreja de um administrador não sai.
  if(state.igrejas.filter(i => i.papel === 'admin').length <= 1){
    toast('Esta é a sua única igreja como administrador. Crie outra antes de excluir esta.', true); return;
  }
  const btn = $('btnExcluirIgreja');
  btn.disabled = true; btn.textContent = 'Verificando...';
  try{
    const motivo = await motivoBloqueioExclusao(state.igrejaAtualId);
    if(motivo){ toast(motivo, true); return; }
    const usrs = await getDocs(collection(db,'igrejas',state.igrejaAtualId,'usuarios'));
    const outros = usrs.size - 1;
    $('excIgrejaResumo').innerHTML = `Você vai excluir <b>${igrejaAtual()?.nome || ''}</b>, que não tem nenhum lançamento.` +
      (outros > 0 ? ` <b>${outros}</b> outro(s) usuário(s) perderão o acesso.` : '') +
      ` Fiéis, categorias, agendas e demais cadastros serão apagados. Não há como desfazer.`;
    $('excIgrejaNomeConf').value = ''; $('excIgrejaNomeConf').classList.remove('input-error');
    $('modalExcluirIgreja').classList.add('active');
  } catch(e){ toast('Erro ao verificar a igreja: ' + e.message, true); }
  finally { btn.disabled = false; btn.textContent = 'Excluir igreja'; }
});
$('btnCancelarExcIgreja').addEventListener('click', ()=> $('modalExcluirIgreja').classList.remove('active'));

$('btnConfirmarExcIgreja').addEventListener('click', async ()=>{
  const id = state.igrejaAtualId;
  const nome = (igrejaAtual()?.nome || '').trim();
  if($('excIgrejaNomeConf').value.trim() !== nome){
    $('excIgrejaNomeConf').classList.add('input-error');
    toast('O nome digitado não confere com o da igreja.', true); return;
  }
  if(!isAdmin()){ toast('Apenas administradores podem excluir a igreja.', true); return; }
  const btn = $('btnConfirmarExcIgreja');
  btn.disabled = true; btn.textContent = 'Excluindo...';
  try{
    // Reconfere na hora: um lançamento pode ter entrado desde que o modal abriu.
    const motivo = await motivoBloqueioExclusao(id);
    if(motivo){ toast(motivo, true); $('modalExcluirIgreja').classList.remove('active'); return; }

    // 1) cadastros e agendas
    for(const sub of SUBCOLECOES_IGREJA) await apagarColecaoEmLotes(['igrejas', id, sub]);
    // campanhas (sem lançamentos, garantido acima)
    await apagarColecaoEmLotes(['igrejas', id, 'campanhas']);
    // 2) convites pendentes + índice. O índice é apagado doc a doc com
    // try/catch: apagar doc inexistente é negado pela regra e derrubaria o lote.
    const convs = await getDocs(collection(db,'igrejas',id,'convites'));
    for(const c of convs.docs){
      try{ await deleteDoc(doc(db,'convitesIndice', `${id}_${c.id}`)); }catch(e){}
      await deleteDoc(c.ref);
    }
    // 3) vínculos dos OUTROS usuários (enquanto você ainda é admin); o seu fica por último
    const usrs = await getDocs(collection(db,'igrejas',id,'usuarios'));
    for(const u of usrs.docs){
      if(u.id === state.user.uid) continue;
      try{ await deleteDoc(doc(db,'membrosIndice', `${id}_${u.id}`)); }catch(e){}
      await deleteDoc(u.ref);
    }
    // 4) a igreja, e só então o seu próprio vínculo
    await deleteDoc(doc(db,'igrejas',id));
    try{ await deleteDoc(doc(db,'membrosIndice', `${id}_${state.user.uid}`)); }catch(e){}
    try{ await deleteDoc(doc(db,'igrejas',id,'usuarios', state.user.uid)); }catch(e){}

    $('modalExcluirIgreja').classList.remove('active');
    toast('Igreja excluída.');
    state.igrejaAtualId = null;
    await carregarIgrejasDoUsuario(state.user);
    if(state.igrejas.length) switchView('painel');
  } catch(e){
    // Exclusão é idempotente: se parou no meio, é só tentar de novo.
    toast('Erro ao excluir: ' + e.message + ' — tente novamente.', true);
  } finally {
    btn.disabled = false; btn.textContent = 'Excluir definitivamente';
  }
});

// ---------- PAINEL ----------
let painelInit = false;
async function renderPainel(){
  if(!painelInit){ populaMesAno('painelMes','painelAno'); painelInit = true;
    $('painelMes').addEventListener('change', renderPainel);
    $('painelAno').addEventListener('change', renderPainel);
    $('btnNovoLancamentoPainel').addEventListener('click', ()=>{
      state.lancModalOrigemPainel = true;
      abrirModalLancamento(null);
    });
  }
  $('painelIgrejaNome').textContent = igrejaAtual()?.nome || '';
  renderPainelAgendas($('painelAgendas'));   // avisos de mensagens/lembretes do dia (não bloqueia o resto)
  $('btnNovoLancamentoPainel').style.display = podeEditarAba('lancamentos') ? 'inline-flex' : 'none';
  if(!temAcesso('lancamentos')){
    $('statReceitas').textContent = '—'; $('statDespesas').textContent = '—'; $('statSaldo').textContent = '—';
    $('statSaldoAnterior').textContent = '—'; $('statSaldoAtual').textContent = '—';
    $('painelUltimos').innerHTML = `<div class="empty">Você não tem acesso aos lançamentos financeiros. Fale com um administrador da igreja.</div>`;
    return;
  }
  const mes = parseInt($('painelMes').value), ano = parseInt($('painelAno').value);
  // Igrejas Caebeiras: o Painel segue a mesma regra do relatório mensal geral
  // (saldo inicial cadastrado + tipos "fora do geral" excluídos). Antes ele somava
  // tudo desde o início e divergia do PDF e do banco.
  const caeb = !!state.igrejaDados?.caebeira;
  const fora = caeb ? tiposForaDoGeral() : new Set();
  let receitas, despesas, saldoAnterior;
  const [ultimos, saldoAnt] = await Promise.all([
    ultimosLancamentosDoMes(mes, ano, 8),
    caeb ? saldoAnteriorGeral(mes, ano) : saldoAnteriorA(mes, ano),
  ]);
  saldoAnterior = saldoAnt;
  if(fora.size){
    // Mês inteiro (limitado a um mês) para poder descartar os tipos excluídos.
    const doMes = await buscarLancamentos(mes, ano);
    receitas = 0; despesas = 0;
    doMes.forEach(l => {
      if(fora.has(l.categoriaId)) return;
      if(l.tipo === 'receita') receitas += (l.valor||0); else if(l.tipo === 'despesa') despesas += (l.valor||0);
    });
  } else {
    [receitas, despesas] = await Promise.all([ somarLancamentos(mes, ano, 'receita'), somarLancamentos(mes, ano, 'despesa') ]);
  }
  $('statReceitas').textContent = fmtBRL(receitas);
  $('statDespesas').textContent = fmtBRL(despesas);
  const saldoEl = $('statSaldo');
  saldoEl.textContent = fmtBRL(receitas-despesas);
  saldoEl.className = 'stat-value num ' + (receitas-despesas >= 0 ? 'green' : 'red');

  // Saldo real no banco (por data), só quando há conta cadastrada e o mês é posterior ao saldo inicial.
  const cardBanco = $('painelBancoCard');
  const fimDoMes = iniProxMesISO(ano, mes);
  const contasDoMes = (state.contas||[]).filter(c => c.dataSaldo && fimDoMes > c.dataSaldo);
  let saldoBanco = null;
  if(contasDoMes.length){
    try{
      const parciais = await Promise.all(contasDoMes.map(c => saldoDaContaAntesDe(c, fimDoMes, false)));
      saldoBanco = parciais.reduce((x,y)=>x+y, 0);
    } catch(e){ console.warn('Saldo bancário indisponível no Painel:', e.message); }
  }
  if(saldoBanco === null){ cardBanco.style.display = 'none'; }
  else {
    cardBanco.style.display = '';
    const bEl = $('statSaldoBanco');
    bEl.textContent = fmtBRL(saldoBanco);
    bEl.className = 'stat-value num ' + (saldoBanco >= 0 ? 'green' : 'red');
    const dif = saldoBanco - (saldoAnterior + receitas - despesas);
    $('statSaldoBancoNota').textContent = Math.abs(dif) < 0.005
      ? 'Bate com o saldo atual do relatório.'
      : `Diferença para o saldo atual: ${fmtBRL(dif)} (lançamentos de outra competência ou fora do relatório).`;
  }

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
        <span style="font-size:11px; color:var(--text-dim);"> · ${(l.dataStr||'').split('-').reverse().join('/')}${l.conciliado ? ' ✓' : ''}</span>
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
    ...ordenarPorNome(state.categoriasReceita).map(c => ({ id:c.id, label:`${c.nome} (Receita)` })),
    ...ordenarPorNome(state.categoriasDespesa).map(c => ({ id:c.id, label:`${c.nome} (Despesa)` })),
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
    const conciliado = !!l.conciliado;
    const nomeConta = l.contaId ? (state.contas.find(c=>c.id===l.contaId)?.nome || '') : '';
    return `
    <tr>
      <td>${l.dataStr ? formatarDataBR(l.dataStr) : '—'}</td>
      <td>${l.mes ? `${MESES[l.mes-1]}/${l.ano}` : '—'}</td>
      <td><span class="tag ${l.tipo}">${l.tipo}</span></td>
      <td>${l.categoriaNome||''}${nomeConta ? `<div class="abas-hint">🏦 ${nomeConta}</div>` : ''}</td>
      <td>${l.descricao||'—'}</td>
      <td>${l.membroNome||'—'}</td>
      <td class="num">${fmtBRL(l.valor)}</td>
      <td>
        ${bloqueado ? '<span class="tag locked">bloqueado</span>' : conciliado ? '<span class="tag locked" title="Desconcilie em Financeiro para editar">conciliado</span>' :
          (editavel ? `<button class="btn btn-sm" data-edit="${l.id}">Editar</button>
           <button class="btn btn-sm btn-danger" data-del="${l.id}">Excluir</button>` : '')}
        ${editavel ? `<button class="btn btn-sm" data-dup="${l.id}" title="Criar um novo lançamento a partir deste">Duplicar</button>` : ''}
      </td>
    </tr>`;
  }).join('');

  $('lancTbody').querySelectorAll('[data-edit]').forEach(b=>{
    b.addEventListener('click', ()=>{ state.lancModalOrigemPainel = false; abrirModalLancamento(lancs.find(l=>l.id===b.dataset.edit)); });
  });
  // Duplicar abre o formulário como lançamento NOVO, já preenchido com os dados
  // do original (inclusive nos bloqueados/conciliados, pois a cópia é um registro
  // independente: não herda conciliação nem origem automática da CAEB).
  $('lancTbody').querySelectorAll('[data-dup]').forEach(b=>{
    b.addEventListener('click', ()=>{ state.lancModalOrigemPainel = false; abrirModalLancamento(lancs.find(l=>l.id===b.dataset.dup), true); });
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

$('btnNovoLancamento').addEventListener('click', ()=>{ state.lancModalOrigemPainel = false; abrirModalLancamento(null); });
function abrirModalLancamento(lanc, duplicar = false){
  state.editandoLancId = (lanc && !duplicar) ? lanc.id : null;
  state.editandoLancCompetenciaOriginal = (lanc && !duplicar) ? competenciaKey(lanc.ano, lanc.mes) : null;
  $('modalLancTitulo').textContent = duplicar ? 'Duplicar lançamento' : lanc ? 'Editar lançamento' : 'Novo lançamento';
  $('lFormTipo').value = lanc ? lanc.tipo : 'receita';
  $('lFormData').value = lanc ? lanc.dataStr : dataLocalISO();
  $('lFormDescricao').value = lanc ? (lanc.descricao||'') : '';
  $('lFormValor').value = lanc ? lanc.valor : '';
  popularCategoriaSelect();
  $('lFormCategoria').value = lanc ? lanc.categoriaId : '';
  // Conta só aparece (e só é obrigatória) quando a igreja já cadastrou alguma.
  const contasOrd = ordenarPorNome(state.contas);
  $('lFormContaWrap').style.display = contasOrd.length ? 'block' : 'none';
  $('lFormConta').innerHTML = `<option value="">Selecione...</option>` + contasOrd.map(c=>`<option value="${c.id}">${c.nome}</option>`).join('');
  $('lFormConta').value = lanc ? (lanc.contaId||'') : (contasOrd.find(c=>c.principal)?.id || '');
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
  const lista = ordenarPorNome(tipo === 'receita' ? state.categoriasReceita : state.categoriasDespesa);
  $('lFormCategoria').innerHTML = lista.map(c=>`<option value="${c.id}">${c.nome}</option>`).join('');
  $('lFormFielWrap').style.display = tipo === 'receita' ? 'block' : 'none';
}
$('btnCancelarLanc').addEventListener('click', ()=> $('modalLancamento').classList.remove('active'));
$('btnSalvarLanc').addEventListener('click', async ()=>{
  if(!validarObrigatorios([
    {id:'lFormData', nome:'Data'}, {id:'lFormCategoria', nome:'Categoria'}, {id:'lFormValor', nome:'Valor'},
    ...(state.contas.length ? [{id:'lFormConta', nome:'Conta'}] : [])
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
    ...camposConta($('lFormConta').value || null, dataStr, tipo, valor),
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
    if(state.lancModalOrigemPainel){
      state.lancModalOrigemPainel = false;
      switchView('lancamentos');
    } else {
      renderLancamentos(); renderPainel();
    }
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
  $('fFormCargo').innerHTML = '<option value="">—</option>' + ordenarPorNome(state.cargos).map(c=>`<option value="${c.id}">${c.nome}</option>`).join('');
  $('fFormGrupo').innerHTML = '<option value="">—</option>' + ordenarPorNome(state.grupos).map(g=>`<option value="${g.id}">${g.nome}</option>`).join('');
  $('fFormCargo').value = f?.cargoId || '';
  $('fFormGrupo').value = f?.grupoId || '';
  // Programação (agendas): nome curto que aparece na escala e funções habilitadas para o rodízio
  $('fFormNomeProg').value = f?.nomeProg || '';
  $('fFormParticipaProg').checked = !!f?.participaProg;
  $('fFormFuncoesProg').innerHTML = FUNCOES_PADRAO.map(fn => `<label style="display:flex; gap:6px; align-items:center; font-weight:400;"><input type="checkbox" data-fn="${fn.id}" style="width:15px;height:15px;" ${(f?.funcoesProg||[]).includes(fn.id)?'checked':''}> ${fn.label}</label>`).join('');
  $('fFormFuncoesProgBox').style.display = $('fFormParticipaProg').checked ? 'block' : 'none';
  $('modalFiel').classList.add('active');
}
$('fFormParticipaProg').addEventListener('change', ()=>{ $('fFormFuncoesProgBox').style.display = $('fFormParticipaProg').checked ? 'block' : 'none'; });
$('btnCancelarFiel').addEventListener('click', ()=> $('modalFiel').classList.remove('active'));
$('btnSalvarFiel').addEventListener('click', async ()=>{
  if(!validarObrigatorios([{id:'fFormNome', nome:'Nome'}])) return;
  const nome = $('fFormNome').value.trim();
  const payload = {
    nome, nomeBusca: normalizarTexto(nome),
    cargoId: $('fFormCargo').value || null, grupoId: $('fFormGrupo').value || null,
    telefone: $('fFormTelefone').value.trim(), email: $('fFormEmail').value.trim(),
    cpf: $('fFormCpf').value.trim(), rg: $('fFormRg').value.trim(), observacoes: $('fFormObs').value.trim(),
    nomeProg: $('fFormNomeProg').value.trim(), participaProg: $('fFormParticipaProg').checked,
    funcoesProg: [...document.querySelectorAll('#fFormFuncoesProg [data-fn]')].filter(c=>c.checked).map(c=>c.dataset.fn),
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
  const lista = ordenarPorNome(state[state.cadTab]);
  $('cadNovoNome').parentElement.style.display = editavel ? 'flex' : 'none';
  const caebeira = !!state.igrejaDados?.caebeira;
  // Controles CAEB só aparecem em igreja Caebeira; nas demais a tela é idêntica à de antes.
  const controleGeral = (item) => `<label class="caeb-check" style="font-size:12px;"><input type="checkbox" data-geral="${item.id}" ${item.geralEntra !== false ? 'checked' : ''}> Entra no relatório geral</label>`;
  const controleCaeb = (item) => {
    if(!caebeira || !editavel) return '';
    if(state.cadTab === 'categoriasDespesa'){
      const p = item.caebPapel || '';
      return `<select class="caeb-sel" data-caeb-papel="${item.id}">
        <option value="" ${p===''?'selected':''}>Fora do cálculo CAEB</option>
        <option value="coberta" ${p==='coberta'?'selected':''}>Despesa coberta pela CAEB</option>
        <option value="contribuicao" ${p==='contribuicao'?'selected':''}>Contribuição à CAEB (%)</option>
        <option value="ajuda" ${p==='ajuda'?'selected':''}>Ajuda fixa (limpeza/ceia)</option>
      </select>` + controleGeral(item);
    }
    if(state.cadTab === 'categoriasReceita'){
      return `<label class="caeb-check" style="font-size:12px;"><input type="checkbox" data-caeb-repasse="${item.id}" ${receitaEntraNaCaeb(item)?'checked':''}> Entra no relatório da CAEB</label>` + controleGeral(item);
    }
    return '';
  };
  $('cadLista').innerHTML = lista.length ? lista.map(item => `
    <div class="list-row" style="gap:10px; flex-wrap:wrap;">
      <span style="flex:1; min-width:140px;">${item.nome}</span>
      ${controleCaeb(item)}
      ${editavel ? `<button class="btn btn-sm" data-ren="${item.id}">Editar</button><button class="btn btn-sm btn-danger" data-del="${item.id}">Excluir</button>` : ''}
    </div>`).join('') : `<div class="empty">Nenhum item cadastrado.</div>`;
  $('cadLista').querySelectorAll('[data-geral]').forEach(chk=>{
    chk.addEventListener('change', async ()=>{
      try{
        await updateDoc(doc(db,'igrejas',state.igrejaAtualId,state.cadTab,chk.dataset.geral), { geralEntra: chk.checked });
        await carregarDadosDaIgreja(); toast('Tipo atualizado.'); renderCadastros();
      } catch(e){ toast('Erro ao salvar: '+e.message, true); }
    });
  });
  $('cadLista').querySelectorAll('[data-ren]').forEach(b=>{
    b.addEventListener('click', ()=> renomearItemCadastro(b.dataset.ren));
  });
  $('cadLista').querySelectorAll('[data-caeb-papel]').forEach(sel=>{
    sel.addEventListener('change', async ()=>{
      const valor = sel.value;
      // Só pode haver um tipo "contribuição" e um "ajuda": o botão de gerar precisa saber
      // exatamente em qual tipo lançar, sem adivinhar.
      if(valor === 'contribuicao' || valor === 'ajuda'){
        const outro = state.categoriasDespesa.find(c => c.id !== sel.dataset.caebPapel && c.caebPapel === valor);
        if(outro){ toast(`Já existe um tipo com esse papel: "${outro.nome}". Mude o outro para "Fora do cálculo" antes.`, true); renderCadastros(); return; }
      }
      try{
        await updateDoc(doc(db,'igrejas',state.igrejaAtualId,'categoriasDespesa',sel.dataset.caebPapel), { caebPapel: valor });
        await carregarDadosDaIgreja(); toast('Tipo atualizado.'); renderCadastros();
      } catch(e){ toast('Erro ao salvar: '+e.message, true); }
    });
  });
  $('cadLista').querySelectorAll('[data-caeb-repasse]').forEach(chk=>{
    chk.addEventListener('change', async ()=>{
      try{
        await updateDoc(doc(db,'igrejas',state.igrejaAtualId,'categoriasReceita',chk.dataset.caebRepasse), { caebEntra: chk.checked });
        await carregarDadosDaIgreja(); toast('Tipo atualizado.'); renderCadastros();
      } catch(e){ toast('Erro ao salvar: '+e.message, true); }
    });
  });
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
// Renomeia um item de Categorias e Grupos. Grupos e cargos são lidos "frescos"
// pelo ID (nada a propagar). Já os lançamentos guardam uma cópia do nome da
// categoria (categoriaNome), usada nos relatórios e na regra de dízimo — por
// isso, ao renomear uma categoria, atualizamos também os lançamentos dela.
// Os que o servidor não deixa alterar (competência bloqueada ou conciliados)
// ficam com o nome antigo e o usuário é avisado.
async function renomearItemCadastro(id){
  const colecao = state.cadTab;
  const item = state[colecao].find(i => i.id === id);
  if(!item) return;
  const entrada = prompt('Novo nome:', item.nome);
  if(entrada === null) return;
  const novo = entrada.trim();
  if(!novo){ toast('O nome não pode ficar vazio.', true); return; }
  if(novo === item.nome) return;
  if(state[colecao].some(i => i.id !== id && normalizarTexto(i.nome) === normalizarTexto(novo))){
    toast('Já existe um item com esse nome.', true); return;
  }
  const ehCategoria = colecao === 'categoriasReceita' || colecao === 'categoriasDespesa';
  toast('Processando...');
  try{
    await updateDoc(doc(db,'igrejas',state.igrejaAtualId,colecao,id), { nome: novo });
    let atualizados = 0, ignorados = 0;
    if(ehCategoria){
      const snaps = await getDocs(query(collection(db,'igrejas',state.igrejaAtualId,'lancamentos'), where('categoriaId','==',id)));
      const pendentes = snaps.docs.filter(d => d.data().categoriaNome !== novo);
      const alvo = pendentes.filter(d => !state.competenciasBloqueadas.has(d.data().competenciaKey) && !d.data().conciliado);
      ignorados = pendentes.length - alvo.length;
      for(let i = 0; i < alvo.length; i += 400){
        const batch = writeBatch(db);
        alvo.slice(i, i+400).forEach(d => batch.update(d.ref, { categoriaNome: novo }));
        await batch.commit();
      }
      atualizados = alvo.length;
    }
    await carregarDadosDaIgreja();
    renderCadastros();
    toast(ignorados
      ? `Renomeado. ${atualizados} lançamento(s) atualizados; ${ignorados} em competência bloqueada ou conciliados mantêm o nome antigo.`
      : 'Renomeado!', false);
  } catch(e){ console.error(e); toast('Erro ao renomear: '+e.message, true); }
}
$('btnCadAdd').addEventListener('click', async ()=>{
  const nome = $('cadNovoNome').value.trim();
  if(!nome){ return; }
  await addDoc(collection(db,'igrejas',state.igrejaAtualId, state.cadTab), {nome});
  $('cadNovoNome').value = '';
  await carregarDadosDaIgreja();
  toast('Item adicionado!'); renderCadastros();
});


// ---------- FINANCEIRO (contas, extrato, conciliação) ----------
// Por que campos "extras" no lançamento (contaData, contaEntrada, contaSaida,
// contaDataConc): o Firestore só indexa sozinho filtros em UM campo. Juntar
// "conta = X" com "data entre A e B" exigiria índice composto manual. Então
// guardamos a chave "contaId|AAAA-MM-DD" num único campo de texto e fazemos
// um único filtro de intervalo nele (e a soma é feita no servidor, via
// agregação). contaDataConc só existe quando o lançamento está conciliado,
// o que permite somar só os conciliados com o mesmo truque.
function camposConta(contaId, dataStr, tipo, valor){
  if(!contaId || !dataStr) return { contaId:null, contaData:null, contaEntrada:0, contaSaida:0 };
  return {
    contaId, contaData: `${contaId}|${dataStr}`,
    contaEntrada: tipo === 'receita' ? valor : 0,
    contaSaida: tipo === 'despesa' ? valor : 0,
  };
}
const pad2 = (n) => String(n).padStart(2,'0');
function iniMesISO(ano, mes){ return `${ano}-${pad2(mes)}-01`; }
function iniProxMesISO(ano, mes){ return mes === 12 ? `${ano+1}-01-01` : `${ano}-${pad2(mes+1)}-01`; }
const maiorData = (a,b) => a > b ? a : b;

async function somaConta(conta, deIncl, ateExcl, conciliados){
  if(ateExcl <= deIncl) return { entradas:0, saidas:0 };
  const campo = conciliados ? 'contaDataConc' : 'contaData';
  const q = query(collection(db,'igrejas',state.igrejaAtualId,'lancamentos'),
    where(campo,'>=',`${conta.id}|${deIncl}`), where(campo,'<',`${conta.id}|${ateExcl}`));
  try{
    const snap = await getAggregateFromServer(q, { e: sum('contaEntrada'), s: sum('contaSaida') });
    return { entradas: snap.data().e || 0, saidas: snap.data().s || 0 };
  } catch(e){
    const docs = await getDocs(q);
    return docs.docs.reduce((t,d)=>({ entradas: t.entradas+(d.data().contaEntrada||0), saidas: t.saidas+(d.data().contaSaida||0) }), { entradas:0, saidas:0 });
  }
}
// Saldo imediatamente ANTES de "ateExcl" (saldo inicial + movimentos desde a data do saldo inicial).
async function saldoDaContaAntesDe(conta, ateExcl, conciliados){
  const s = await somaConta(conta, conta.dataSaldo, ateExcl, conciliados);
  return (conta.saldoInicial||0) + s.entradas - s.saidas;
}
async function movimentosDaConta(conta, deIncl, ateExcl){
  const q = query(collection(db,'igrejas',state.igrejaAtualId,'lancamentos'),
    where('contaData','>=',`${conta.id}|${deIncl}`), where('contaData','<',`${conta.id}|${ateExcl}`), orderBy('contaData'));
  const snaps = await getDocs(q);
  return snaps.docs.map(d => ({ id:d.id, ...d.data() }));
}
const historicoDoMov = (l) => [l.categoriaNome, l.descricao, l.membroNome].filter(Boolean).join(' - ');

let finInit = false, finAba = 'contas';
function opcoesContas(){ return ordenarPorNome(state.contas).map(c=>`<option value="${c.id}">${c.nome}</option>`).join(''); }
async function renderFinanceiro(){
  if(!finInit){
    finInit = true;
    populaMesAno('finExtMes','finExtAno'); populaMesAno('finConcMes','finConcAno');
    let anos = '';
    for(let y = hoje.getFullYear()-3; y <= hoje.getFullYear()+1; y++) anos += `<option value="${y}" ${y===hoje.getFullYear()?'selected':''}>${y}</option>`;
    $('finSaldosAno').innerHTML = anos;
    document.querySelectorAll('.fin-tab').forEach(b => b.addEventListener('click', ()=>{ finAba = b.dataset.fin; renderFinanceiro(); }));
    ['finSaldosConta','finSaldosAno'].forEach(id => $(id).addEventListener('change', desenharSaldosMensais));
    ['finExtConta','finExtMes','finExtAno'].forEach(id => $(id).addEventListener('change', renderExtrato));
    ['finConcConta','finConcMes','finConcAno','finConcFiltro'].forEach(id => $(id).addEventListener('change', renderConciliacao));
    $('finConcSaldoBanco').addEventListener('input', atualizarVereditoConciliacao);
    $('btnNovaConta').addEventListener('click', ()=> abrirModalConta(null));
    $('btnCancelarConta').addEventListener('click', ()=> $('modalConta').classList.remove('active'));
    $('btnSalvarConta').addEventListener('click', salvarConta);
    $('btnPdfExtrato').addEventListener('click', gerarPdfExtrato);
    $('btnAtribuirConta').addEventListener('click', atribuirContaEmLote);
    $('btnConcMarcarTodos').addEventListener('click', ()=> marcarVisiveis(true));
    $('btnConcDesmarcarTodos').addEventListener('click', ()=> marcarVisiveis(false));
  }
  document.querySelectorAll('.fin-tab').forEach(b => b.classList.toggle('active', b.dataset.fin === finAba));
  ['contas','extrato','concil'].forEach(n => $('finSec-'+n).style.display = (n === finAba) ? 'block' : 'none');
  // contas são relidas aqui para refletir mudanças feitas em outra aba/aparelho
  state.contas = await buscarSeguro(getDocs(collection(db,'igrejas',state.igrejaAtualId,'contas')), state.contas);
  const ops = opcoesContas();
  ['finSaldosConta','finExtConta','finConcConta','finAtribConta'].forEach(id => {
    const atual = $(id).value; $(id).innerHTML = ops || '<option value="">Nenhuma conta cadastrada</option>';
    if(atual && state.contas.some(c=>c.id===atual)) $(id).value = atual;
  });
  const editavel = podeEditarAba('financeiro');
  $('btnNovaConta').style.display = editavel ? 'inline-flex' : 'none';
  $('finAtribCard').style.display = (editavel && podeEditarAba('lancamentos')) ? 'block' : 'none';
  if(finAba === 'contas'){ desenharListaContas(); await desenharSaldosMensais(); }
  else if(finAba === 'extrato') await renderExtrato();
  else await renderConciliacao();
}

function contaPorId(id){ return state.contas.find(c=>c.id===id); }
function desenharListaContas(){
  const editavel = podeEditarAba('financeiro');
  const lista = ordenarPorNome(state.contas);
  $('finContasLista').innerHTML = lista.length ? lista.map(c => `
    <div class="list-row" style="gap:10px; flex-wrap:wrap;">
      <span style="flex:1; min-width:180px;"><b>${c.nome}</b>${c.principal ? ' <span class="tag locked">principal</span>' : ''}
        <div class="abas-hint">${c.tipo === 'caixa' ? 'Caixa (dinheiro)' : [c.banco, c.finalConta ? 'final '+c.finalConta : ''].filter(Boolean).join(' · ') || 'Conta bancária'}
        · saldo inicial ${fmtBRL(c.saldoInicial||0)} em ${formatarDataBR(c.dataSaldo)}</div></span>
      ${editavel ? `<button class="btn btn-sm" data-conta-edit="${c.id}">Editar</button><button class="btn btn-sm btn-danger" data-conta-del="${c.id}">Excluir</button>` : ''}
    </div>`).join('') : `<div class="empty">Nenhuma conta cadastrada. Cadastre a conta bancária (e, se quiser, um "Caixa") para começar.</div>`;
  $('finContasLista').querySelectorAll('[data-conta-edit]').forEach(b => b.addEventListener('click', ()=> abrirModalConta(contaPorId(b.dataset.contaEdit))));
  $('finContasLista').querySelectorAll('[data-conta-del]').forEach(b => b.addEventListener('click', async ()=>{
    if(await existeVinculo('lancamentos','contaId', b.dataset.contaDel)){
      toast('Não é possível excluir: essa conta tem lançamentos vinculados.', true); return;
    }
    if(!confirm('Excluir esta conta?')) return;
    await deleteDoc(doc(db,'igrejas',state.igrejaAtualId,'contas', b.dataset.contaDel));
    toast('Conta excluída.'); renderFinanceiro();
  }));
}
function abrirModalConta(c){
  state.editandoContaId = c ? c.id : null;
  $('modalContaTitulo').textContent = c ? 'Editar conta' : 'Nova conta';
  $('cNome').value = c?.nome || ''; $('cTipo').value = c?.tipo || 'banco';
  $('cBanco').value = c?.banco || ''; $('cFinal').value = c?.finalConta || '';
  $('cSaldoInicial').value = c ? (c.saldoInicial ?? 0) : '';
  $('cDataSaldo').value = c?.dataSaldo || '';
  $('cPrincipal').checked = !!c?.principal || (!c && !state.contas.length);
  $('modalConta').classList.add('active');
}
async function salvarConta(){
  if(!validarObrigatorios([{id:'cNome',nome:'Nome da conta'},{id:'cSaldoInicial',nome:'Saldo inicial'},{id:'cDataSaldo',nome:'Data do saldo inicial'}])) return;
  const btn = $('btnSalvarConta'); btn.disabled = true;
  const payload = {
    nome: $('cNome').value.trim(), tipo: $('cTipo').value, banco: $('cBanco').value.trim(),
    finalConta: $('cFinal').value.trim(), saldoInicial: parseFloat($('cSaldoInicial').value) || 0,
    dataSaldo: $('cDataSaldo').value, principal: $('cPrincipal').checked,
  };
  try{
    const colRef = collection(db,'igrejas',state.igrejaAtualId,'contas');
    let id = state.editandoContaId;
    if(id) await updateDoc(doc(colRef,id), payload); else id = (await addDoc(colRef, { ...payload, criadoEm: serverTimestamp() })).id;
    if(payload.principal){
      // só uma conta principal por igreja
      const outras = state.contas.filter(c => c.id !== id && c.principal);
      if(outras.length){ const b = writeBatch(db); outras.forEach(o => b.update(doc(colRef,o.id), { principal:false })); await b.commit(); }
    }
    $('modalConta').classList.remove('active'); toast('Conta salva!'); await carregarDadosDaIgreja(); renderFinanceiro();
  } catch(e){ toast('Erro ao salvar: '+e.message, true); }
  finally { btn.disabled = false; }
}

async function desenharSaldosMensais(){
  const conta = contaPorId($('finSaldosConta').value);
  if(!conta){ $('finSaldosTabela').innerHTML = `<div class="empty">Cadastre uma conta para ver os saldos.</div>`; return; }
  $('finSaldosTabela').innerHTML = '<div class="empty">Calculando...</div>';
  const ano = parseInt($('finSaldosAno').value);
  const meses = await Promise.all(Array.from({length:12}, async (_,i) => {
    const ini = iniMesISO(ano, i+1), fim = iniProxMesISO(ano, i+1);
    const de = maiorData(ini, conta.dataSaldo);
    const mov = await somaConta(conta, de, fim, false);
    const anterior = await saldoDaContaAntesDe(conta, de);
    return { mes:i+1, anterior: ini < conta.dataSaldo && fim <= conta.dataSaldo ? null : (ini < conta.dataSaldo ? conta.saldoInicial||0 : anterior), ...mov };
  }));
  $('finSaldosTabela').innerHTML = `<div class="table-scroll"><table>
    <thead><tr><th>Mês</th><th style="text-align:right;">Saldo inicial</th><th style="text-align:right;">Entradas</th><th style="text-align:right;">Saídas</th><th style="text-align:right;">Saldo final</th></tr></thead>
    <tbody>${meses.map(m => m.anterior === null
      ? `<tr><td>${MESES[m.mes-1]}</td><td colspan="4" style="color:var(--text-dim);">anterior à data do saldo inicial</td></tr>`
      : `<tr><td>${MESES[m.mes-1]}</td><td class="num" style="text-align:right;">${fmtBRL(m.anterior)}</td><td class="num green" style="text-align:right;">${fmtBRL(m.entradas)}</td><td class="num red" style="text-align:right;">${fmtBRL(m.saidas)}</td><td class="num" style="text-align:right;"><b>${fmtBRL(m.anterior + m.entradas - m.saidas)}</b></td></tr>`).join('')}</tbody></table></div>`;
}

// ----- Extrato -----
async function montarExtrato(conta, mes, ano){
  const ini = iniMesISO(ano, mes), fim = iniProxMesISO(ano, mes);
  const de = maiorData(ini, conta.dataSaldo);
  const anterior = ini <= conta.dataSaldo ? (conta.saldoInicial||0) : await saldoDaContaAntesDe(conta, ini);
  const movs = fim <= conta.dataSaldo ? [] : await movimentosDaConta(conta, de, fim);
  let saldo = anterior, entradas = 0, saidas = 0;
  const linhas = movs.map(l => {
    saldo += (l.contaEntrada||0) - (l.contaSaida||0); entradas += l.contaEntrada||0; saidas += l.contaSaida||0;
    return { ...l, saldo };
  });
  return { anterior, entradas, saidas, final: anterior + entradas - saidas, linhas };
}
async function renderExtrato(){
  const conta = contaPorId($('finExtConta').value);
  if(!conta){ $('finExtResumo').innerHTML = ''; $('finExtTbody').innerHTML = `<tr><td colspan="6" class="empty">Cadastre uma conta para ver o extrato.</td></tr>`; return; }
  const mes = parseInt($('finExtMes').value), ano = parseInt($('finExtAno').value);
  $('finExtTbody').innerHTML = `<tr><td colspan="6" class="empty">Carregando...</td></tr>`;
  const ex = await montarExtrato(conta, mes, ano);
  $('finExtResumo').innerHTML = `
    <div><div class="stat-label">Saldo anterior</div><div class="num">${fmtBRL(ex.anterior)}</div></div>
    <div><div class="stat-label">Entradas</div><div class="num green">${fmtBRL(ex.entradas)}</div></div>
    <div><div class="stat-label">Saídas</div><div class="num red">${fmtBRL(ex.saidas)}</div></div>
    <div><div class="stat-label">Saldo final</div><div class="num"><b>${fmtBRL(ex.final)}</b></div></div>`;
  $('finExtTbody').innerHTML = ex.linhas.length ? ex.linhas.map(l => `<tr>
      <td>${formatarDataBR(l.dataStr)}</td><td>${historicoDoMov(l)}</td>
      <td class="num green" style="text-align:right;">${l.contaEntrada ? fmtBRL(l.contaEntrada) : ''}</td>
      <td class="num red" style="text-align:right;">${l.contaSaida ? fmtBRL(l.contaSaida) : ''}</td>
      <td class="num" style="text-align:right;">${fmtBRL(l.saldo)}</td>
      <td>${l.conciliado ? '<span class="tag locked">conciliado</span>' : ''}</td></tr>`).join('')
    : `<tr><td colspan="6" class="empty">Nenhum movimento nesta conta no mês.</td></tr>`;
}
async function gerarPdfExtrato(){
  const conta = contaPorId($('finExtConta').value);
  if(!conta){ toast('Cadastre uma conta primeiro.', true); return; }
  const btn = $('btnPdfExtrato'); btn.disabled = true; toast('Gerando PDF...');
  try{
    const mes = parseInt($('finExtMes').value), ano = parseInt($('finExtAno').value);
    const ex = await montarExtrato(conta, mes, ano);
    const { jsPDF } = window.jspdf; const pdf = new jsPDF();
    const titulo = `EXTRATO — ${conta.nome.toUpperCase()} — ${MESES[mes-1].toUpperCase()}/${ano}`;
    let y = cabecalhoRelatorioPdf(pdf, titulo);
    const corpo = [
      ['', 'SALDO ANTERIOR', '', '', fmtBRL(ex.anterior)],
      ...ex.linhas.map(l => [formatarDataBR(l.dataStr), historicoDoMov(l), l.contaEntrada ? fmtBRL(l.contaEntrada) : '', l.contaSaida ? fmtBRL(l.contaSaida) : '', fmtBRL(l.saldo)]),
      ['', 'SALDO FINAL', fmtBRL(ex.entradas), fmtBRL(ex.saidas), fmtBRL(ex.final)],
    ];
    pdf.autoTable({ startY:y, head:[['Data','Histórico','Entrada','Saída','Saldo']], body: corpo, theme:'grid',
      styles:{fontSize:7.5, cellPadding:1.4}, headStyles:{fillColor:[13,79,196]}, margin:{left:14,right:14,bottom:12},
      columnStyles:{2:{halign:'right'},3:{halign:'right'},4:{halign:'right'}},
      didParseCell:(d)=>{ if(d.row.index === 0 || d.row.index === corpo.length-1) d.cell.styles.fontStyle = 'bold'; } });
    const ySig = garantirEspaco(pdf, pdf.lastAutoTable.finalY + 15, 9, titulo);
    desenharAssinaturas(pdf, ySig);
    pdf.save(nomeArquivoPdf(`extrato_${nomeArquivoSeguro(conta.nome)}_${MESES[mes-1]}_${ano}`));
    toast('PDF gerado!');
  } catch(e){ console.error('Erro ao gerar extrato:', e); toast('Erro ao gerar o PDF: '+e.message, true); }
  finally { btn.disabled = false; }
}

// ----- Conciliação -----
let finConcLista = [], finConcSaldos = null;
async function renderConciliacao(){
  const conta = contaPorId($('finConcConta').value);
  const editavel = podeEditarAba('financeiro');
  $('btnConcMarcarTodos').style.display = $('btnConcDesmarcarTodos').style.display = editavel ? 'inline-flex' : 'none';
  if(!conta){ $('finConcResumo').innerHTML = ''; $('finConcTbody').innerHTML = `<tr><td colspan="5" class="empty">Cadastre uma conta para conciliar.</td></tr>`; finConcLista = []; return; }
  const mes = parseInt($('finConcMes').value), ano = parseInt($('finConcAno').value);
  $('finConcTbody').innerHTML = `<tr><td colspan="5" class="empty">Carregando...</td></tr>`;
  const ini = iniMesISO(ano, mes), fim = iniProxMesISO(ano, mes);
  finConcLista = fim <= conta.dataSaldo ? [] : await movimentosDaConta(conta, maiorData(ini, conta.dataSaldo), fim);
  // Saldo do sistema x saldo só dos conciliados, ambos ao fim do mês.
  const [sistema, conciliado] = await Promise.all([saldoDaContaAntesDe(conta, fim, false), saldoDaContaAntesDe(conta, fim, true)]);
  finConcSaldos = { sistema, conciliado };
  desenharConciliacao();
}
function desenharConciliacao(){
  const editavel = podeEditarAba('financeiro');
  const filtro = $('finConcFiltro').value;
  const visiveis = finConcLista.filter(l => filtro === 'pendentes' ? !l.conciliado : filtro === 'conciliados' ? !!l.conciliado : true);
  const pend = finConcLista.filter(l => !l.conciliado);
  const liq = (l) => (l.contaEntrada||0) - (l.contaSaida||0);
  $('finConcResumo').innerHTML = `
    <div><div class="stat-label">Saldo no sistema (fim do mês)</div><div class="num">${fmtBRL(finConcSaldos.sistema)}</div></div>
    <div><div class="stat-label">Saldo conciliado</div><div class="num"><b>${fmtBRL(finConcSaldos.conciliado)}</b></div></div>
    <div><div class="stat-label">Pendentes no mês</div><div class="num">${pend.length}</div></div>
    <div><div class="stat-label">Valor líquido pendente (todo o histórico)</div><div class="num">${fmtBRL(finConcSaldos.sistema - finConcSaldos.conciliado)}</div></div>`;
  $('finConcTbody').innerHTML = visiveis.length ? visiveis.map(l => `<tr>
      <td><input type="checkbox" data-conc="${l.id}" ${l.conciliado ? 'checked' : ''} ${editavel ? '' : 'disabled'}></td>
      <td>${formatarDataBR(l.dataStr)}</td><td>${historicoDoMov(l)}</td>
      <td class="num green" style="text-align:right;">${l.contaEntrada ? fmtBRL(l.contaEntrada) : ''}</td>
      <td class="num red" style="text-align:right;">${l.contaSaida ? fmtBRL(l.contaSaida) : ''}</td></tr>`).join('')
    : `<tr><td colspan="5" class="empty">Nenhum lançamento para mostrar.</td></tr>`;
  $('finConcTbody').querySelectorAll('[data-conc]').forEach(chk => chk.addEventListener('change', async ()=>{
    chk.disabled = true;
    await aplicarConciliacao([finConcLista.find(l=>l.id===chk.dataset.conc)], chk.checked);
  }));
  atualizarVereditoConciliacao();
}
function atualizarVereditoConciliacao(){
  const v = $('finConcSaldoBanco').value;
  if(v === '' || !finConcSaldos){ $('finConcVeredito').innerHTML = ''; return; }
  const dif = Math.round((parseFloat(v) - finConcSaldos.conciliado) * 100) / 100;
  $('finConcVeredito').innerHTML = dif === 0
    ? `<span class="fin-ok">✓ Bateu! O extrato confere com o saldo conciliado.</span>`
    : `<span class="fin-erro">Diferença de ${fmtBRL(dif)} (extrato - conciliado). Confira os lançamentos ainda não marcados.</span>`;
}
async function aplicarConciliacao(lancs, marcar){
  const alvo = lancs.filter(l => l && !!l.conciliado !== marcar);
  if(!alvo.length) return;
  try{
    for(let i = 0; i < alvo.length; i += 400){
      const batch = writeBatch(db);
      alvo.slice(i, i+400).forEach(l => batch.update(doc(db,'igrejas',state.igrejaAtualId,'lancamentos',l.id), {
        conciliado: marcar, contaDataConc: marcar ? l.contaData : null,
        conciliadoEm: marcar ? serverTimestamp() : null, conciliadoPor: marcar ? state.user.uid : null,
      }));
      await batch.commit();
    }
    toast(marcar ? 'Conciliado!' : 'Conciliação desfeita.');
  } catch(e){ toast('Erro ao conciliar: '+e.message, true); }
  await renderConciliacao();
}
async function marcarVisiveis(marcar){
  const filtro = $('finConcFiltro').value;
  const visiveis = finConcLista.filter(l => filtro === 'pendentes' ? !l.conciliado : filtro === 'conciliados' ? !!l.conciliado : true);
  if(!visiveis.length) return;
  if(marcar && !confirm(`Marcar ${visiveis.length} lançamento(s) como conciliado(s)?`)) return;
  if(!marcar && !confirm(`Desfazer a conciliação de ${visiveis.length} lançamento(s)?`)) return;
  await aplicarConciliacao(visiveis, marcar);
}

// Atribui conta aos lançamentos antigos (só os que ainda não têm conta e cuja
// competência não está bloqueada — o servidor recusaria a edição).
async function atribuirContaEmLote(){
  const conta = contaPorId($('finAtribConta').value);
  const de = $('finAtribDe').value, ate = $('finAtribAte').value;
  if(!conta){ toast('Escolha a conta.', true); return; }
  if(!de || !ate || de > ate){ toast('Informe o intervalo de competências (de/até).', true); return; }
  const btn = $('btnAtribuirConta'); btn.disabled = true; toast('Processando...');
  try{
    const snaps = await getDocs(query(collection(db,'igrejas',state.igrejaAtualId,'lancamentos'),
      where('competenciaKey','>=',de), where('competenciaKey','<=',ate)));
    const todos = snaps.docs.filter(d => !d.data().contaId && d.data().dataStr);
    const alvo = todos.filter(d => !state.competenciasBloqueadas.has(d.data().competenciaKey));
    const bloqueados = todos.length - alvo.length;
    if(!alvo.length){ $('finAtribAviso').textContent = `Nenhum lançamento sem conta para atribuir${bloqueados ? ` (${bloqueados} em competência bloqueada)` : ''}.`; return; }
    if(!confirm(`Atribuir "${conta.nome}" a ${alvo.length} lançamento(s) sem conta?`)) return;
    for(let i = 0; i < alvo.length; i += 400){
      const batch = writeBatch(db);
      alvo.slice(i, i+400).forEach(d => { const v = d.data(); batch.update(d.ref, camposConta(conta.id, v.dataStr, v.tipo, v.valor)); });
      await batch.commit();
    }
    $('finAtribAviso').textContent = `${alvo.length} lançamento(s) atribuídos.${bloqueados ? ` ${bloqueados} ficaram de fora por estarem em competência bloqueada.` : ''}`;
    toast('Conta atribuída!');
  } catch(e){ console.error(e); toast('Erro: '+e.message, true); }
  finally { btn.disabled = false; }
}

// ---------- SALDOS ANTERIORES SEPARADOS (igrejas Caebeiras) ----------
// Na igreja Caebeira o relatório geral e o relatório da CAEB têm saldo anterior
// próprio, cada um acumulando só o que entra nele. Ambos aceitam um saldo
// inicial manual a partir de uma competência (para acertar o começo); sem
// competência informada, acumulam desde o primeiro lançamento.
function tiposForaDoGeral(){
  return new Set([...state.categoriasReceita, ...state.categoriasDespesa].filter(c => c.geralEntra === false).map(c => c.id));
}
async function lancamentosAteCompetencia(chaveIni, chaveFimExcl){
  const col = collection(db,'igrejas',state.igrejaAtualId,'lancamentos');
  const filtros = [where('competenciaKey','<',chaveFimExcl)];
  if(chaveIni) filtros.push(where('competenciaKey','>=',chaveIni));
  const snaps = await getDocs(query(col, ...filtros));
  return snaps.docs.map(d => d.data());
}
async function saldoAnteriorGeral(mes, ano){
  const ig = state.igrejaDados || {};
  const chave = competenciaKey(ano, mes), ini = ig.geralSaldoDesde || null;
  if(ini && chave < ini) return 0;
  const fora = tiposForaDoGeral();
  const docs = await lancamentosAteCompetencia(ini, chave);
  let s = ini ? (ig.geralSaldoInicial || 0) : 0;
  docs.forEach(v => {
    if(fora.has(v.categoriaId)) return;
    if(v.tipo === 'receita') s += (v.valor||0); else if(v.tipo === 'despesa') s -= (v.valor||0);
  });
  return s;
}
// Saldo da CAEB: todas as receitas (inclusive repasses já recebidos) menos as
// despesas dentro do cálculo da CAEB. Com o repasse lançado pelo valor bruto, o
// saldo volta a zero a cada mês; déficit ainda não repassado fica negativo.
async function saldoAnteriorCaeb(mes, ano){
  const ig = state.igrejaDados || {};
  const chave = competenciaKey(ano, mes), ini = ig.caebSaldoDesde || null;
  if(ini && chave < ini) return 0;
  const papelDe = {}; state.categoriasDespesa.forEach(c => { if(c.caebPapel) papelDe[c.id] = true; });
  const docs = await lancamentosAteCompetencia(ini, chave);
  let s = ini ? (ig.caebSaldoInicial || 0) : 0;
  docs.forEach(v => {
    if(v.tipo === 'receita') s += (v.valor||0);
    else if(v.tipo === 'despesa' && papelDe[v.categoriaId]) s -= (v.valor||0);
  });
  return s;
}

// ---------- CAEB ----------
// Um tipo de receita "entra no relatório da CAEB" por padrão. O campo novo
// caebEntra (marcado no cadastro) manda; se ele não existir, vale o
// comportamento antigo: entra, a menos que estivesse marcado como repasse
// (caebRepasse). Assim nada que já estava configurado muda de resultado.
function receitaEntraNaCaeb(cat){
  if(cat.caebEntra !== undefined) return !!cat.caebEntra;
  return !cat.caebRepasse;
}
// Calcula o que a CAEB cobre em uma competência. Regra: só entram as despesas
// dos tipos marcados manualmente (papel coberta/contribuição/ajuda), e as
// receitas dos tipos marcados como "não entra no relatório da CAEB" ficam FORA da base —
// senão o próprio repasse reduziria o valor que a CAEB precisa cobrir.
function calcularCaeb(lancs, saldoAnterior = 0){
  const papelDe = {}; state.categoriasDespesa.forEach(c => { if(c.caebPapel) papelDe[c.id] = c.caebPapel; });
  const repasseIds = new Set(state.categoriasReceita.filter(c => !receitaEntraNaCaeb(c)).map(c => c.id));
  const receitas = lancs.filter(l => l.tipo === 'receita');
  const receitasBase = receitas.filter(l => !repasseIds.has(l.categoriaId));
  const repasses = receitas.filter(l => repasseIds.has(l.categoriaId));
  const despCaeb = lancs.filter(l => l.tipo === 'despesa' && papelDe[l.categoriaId])
    .sort((a,b)=>(a.dataStr||'').localeCompare(b.dataStr||''));
  const soma = (l) => l.reduce((s,x)=> s + (x.valor||0), 0);
  const totalReceitas = soma(receitasBase), totalDespesas = soma(despCaeb), totalRepasse = soma(repasses);
  const totalContribuicao = soma(despCaeb.filter(l => papelDe[l.categoriaId] === 'contribuicao'));
  const resultado = totalReceitas - totalDespesas;
  // O saldo anterior da CAEB (déficit ainda não repassado ou sobra) entra na
  // conta: o que a CAEB precisa cobrir é o déficit ACUMULADO, não só o do mês.
  const saldoAcumulado = saldoAnterior + resultado;
  const aCobrir = saldoAcumulado < 0 ? -saldoAcumulado : 0;
  // Repasse "líquido": a CAEB cobre o déficit bruto (que já inclui a contribuição
  // da igreja como despesa), mas a igreja devolve essa contribuição à CAEB —
  // então o dinheiro que de fato precisa sair da CAEB é o bruto menos a contribuição.
  // Negativo = é a igreja que fica devendo à CAEB.
  return { receitasBase, repasses, despCaeb, totalReceitas, totalDespesas, totalRepasse, totalContribuicao,
    resultado, saldoAnterior, saldoAcumulado, aCobrir, excedente: saldoAcumulado > 0 ? saldoAcumulado : 0, liquido: aCobrir - totalContribuicao };
}
async function renderCaebCard(lancs, mes, ano){
  const card = $('cardCaeb');
  const ativo = !!state.igrejaDados?.caebeira;
  card.style.display = ativo ? 'block' : 'none';
  if(!ativo) return;
  const c = calcularCaeb(lancs, await saldoAnteriorCaeb(mes, ano));
  const linha = (rotulo, valor, cor) => `<div class="list-row"><span>${rotulo}</span><span class="num ${cor||''}">${fmtBRL(valor)}</span></div>`;
  $('relCaebResumo').innerHTML =
    linha('Receitas computáveis (sem repasse da CAEB)', c.totalReceitas, 'green') +
    linha('Despesas dentro do cálculo CAEB', c.totalDespesas, 'red') +
    linha('Resultado do mês', c.resultado) +
    linha('Saldo anterior da CAEB', c.saldoAnterior) +
    linha(c.saldoAcumulado < 0 ? '<b>Valor a ser coberto pela CAEB (bruto)</b>' : '<b>Saldo acumulado (sem necessidade de cobertura)</b>', c.saldoAcumulado < 0 ? c.aCobrir : c.excedente) +
    linha('(-) Contribuição à CAEB já incluída nas despesas', c.totalContribuicao) +
    linha(c.liquido >= 0 ? '<b>Valor líquido que a CAEB precisa repassar</b>' : '<b>Valor líquido que a igreja deve à CAEB</b>', Math.abs(c.liquido)) +
    linha('Repasse da CAEB já lançado como receita no mês', c.totalRepasse);
}
// Gera (ou atualiza) os lançamentos reais da contribuição percentual e da
// ajuda fixa. Usa ID fixo por competência para nunca duplicar: apertar o botão
// de novo apenas recalcula (útil se entrou receita nova depois).
$('btnGerarCaeb').addEventListener('click', async ()=>{
  const btn = $('btnGerarCaeb');
  if(!podeEditarAba('lancamentos')){ toast('Você não tem permissão para lançar.', true); return; }
  const mes = parseInt($('relMes').value), ano = parseInt($('relAno').value);
  const key = competenciaKey(ano, mes);
  const ig = state.igrejaDados || {};
  if(ig.caebDesde && key < ig.caebDesde){ toast(`A igreja só é Caebeira a partir de ${ig.caebDesde}.`, true); return; }
  if(isCompetenciaBloqueada(mes, ano)){ toast('Esta competência está bloqueada.', true); return; }
  const tipoContrib = state.categoriasDespesa.find(c => c.caebPapel === 'contribuicao');
  const tipoAjuda = state.categoriasDespesa.find(c => c.caebPapel === 'ajuda');
  const pct = ig.caebPercentual || 0, ajuda = ig.caebAjudaFixa || 0;
  if(pct > 0 && !tipoContrib){ toast('Marque um tipo de despesa como "Contribuição à CAEB (%)" em Categorias e Grupos.', true); return; }
  if(ajuda > 0 && !tipoAjuda){ toast('Marque um tipo de despesa como "Ajuda fixa" em Categorias e Grupos.', true); return; }
  if(!(pct > 0) && !(ajuda > 0)){ toast('Informe o percentual e/ou a ajuda fixa em Dados da Igreja.', true); return; }
  btn.disabled = true; toast('Processando...');
  try{
    const lancs = await buscarLancamentos(mes, ano);
    const repasseIds = new Set(state.categoriasReceita.filter(c => !receitaEntraNaCaeb(c)).map(c => c.id));
    const base = lancs.filter(l => l.tipo === 'receita' && !repasseIds.has(l.categoriaId)).reduce((s,l)=>s+(l.valor||0),0);
    const itens = [];
    if(pct > 0) itens.push({ id:`caeb-contribuicao-${key}`, cat:tipoContrib, origem:'caeb-contribuicao', valor: Math.round(base*pct)/100, desc:`Contribuição CAEB ${pct}% sobre ${fmtBRL(base)}`, pct, base });
    if(ajuda > 0) itens.push({ id:`caeb-ajuda-${key}`, cat:tipoAjuda, origem:'caeb-ajuda', valor: ajuda, desc:'Ajuda fixa CAEB (limpeza e santa ceia)' });
    const ultimoDia = new Date(ano, mes, 0).getDate();
    const dataStr = `${ano}-${String(mes).padStart(2,'0')}-${String(ultimoDia).padStart(2,'0')}`;
    let gerados = 0;
    for(const it of itens){
      if(!(it.valor > 0)) continue;
      const ref = doc(db,'igrejas',state.igrejaAtualId,'lancamentos',it.id);
      const existente = await getDoc(ref);
      if(existente.exists() && !confirm(`Já existe "${it.desc.split(' sobre')[0]}" nesta competência (${fmtBRL(existente.data().valor)}). Atualizar com o valor recalculado (${fmtBRL(it.valor)})?`)) continue;
      const payload = {
        tipo:'despesa', dataStr, mes, ano, competenciaKey:key, categoriaId:it.cat.id, categoriaNome:it.cat.nome,
        descricao: it.desc, valor: it.valor, membroId:null, membroNome:'', bloqueado:false,
        origem: it.origem, caebPercentual: it.pct ?? null, caebBase: it.base ?? null,
        ...camposConta(state.contas.find(c=>c.principal)?.id || null, dataStr, 'despesa', it.valor),
        criadoPor: state.user.uid, criadoPorNome: state.perfil.nome, atualizadoEm: serverTimestamp()
      };
      if(!existente.exists()) payload.criadoEm = serverTimestamp();
      await setDoc(ref, payload, { merge: true });
      gerados++;
    }
    toast(gerados ? 'Lançamentos da CAEB gerados/atualizados!' : 'Nada foi alterado.');
    renderRelatorios(); renderPainel();
  } catch(e){
    console.error('Erro ao gerar CAEB:', e);
    toast('Erro ao gerar: '+e.message, true);
  } finally { btn.disabled = false; }
});

// Gera o lançamento de receita "Repasse da CAEB" pelo valor BRUTO a cobrir
// (já com contribuição e ajuda lançadas). É um botão separado, e não parte do
// anterior, de propósito: o repasse só deve ser registrado quando o dinheiro
// realmente chegar (e a conciliação bancária confirma isso depois). O tipo de
// receita do repasse fica fora da base (não entra no relatório), então não há
// circularidade no cálculo.
$('btnGerarRepasseCaeb').addEventListener('click', async ()=>{
  const btn = $('btnGerarRepasseCaeb');
  if(!podeEditarAba('lancamentos')){ toast('Você não tem permissão para lançar.', true); return; }
  const mes = parseInt($('relMes').value), ano = parseInt($('relAno').value);
  const key = competenciaKey(ano, mes);
  if(isCompetenciaBloqueada(mes, ano)){ toast('Esta competência está bloqueada.', true); return; }
  // O tipo do repasse é escolhido em Dados da Igreja; sem escolha, só vale se
  // houver exatamente um tipo fora do relatório da CAEB.
  const escolhido = state.categoriasReceita.find(c => c.id === state.igrejaDados?.caebTipoRepasseId);
  const fora = state.categoriasReceita.filter(c => !receitaEntraNaCaeb(c));
  const tipos = escolhido ? [escolhido] : fora;
  if(tipos.length !== 1){ toast('Escolha o "Tipo de receita do repasse da CAEB" em Dados da Igreja.', true); return; }
  btn.disabled = true; toast('Processando...');
  try{
    const lancs = await buscarLancamentos(mes, ano);
    const c = calcularCaeb(lancs, await saldoAnteriorCaeb(mes, ano));
    const idAuto = `caeb-repasse-${key}`;
    if(!(c.aCobrir > 0)){ toast('Não há déficit a cobrir neste mês. Gere antes a contribuição e a ajuda, se ainda não gerou.', true); return; }
    const manual = c.repasses.filter(l => l.id !== idAuto).reduce((s,l)=>s+(l.valor||0),0);
    if(manual > 0 && !confirm(`Já existem ${fmtBRL(manual)} de repasse lançados manualmente neste mês. Gerar mesmo assim mais ${fmtBRL(c.aCobrir)}?`)) return;
    const ref = doc(db,'igrejas',state.igrejaAtualId,'lancamentos',idAuto);
    const existente = await getDoc(ref);
    const pergunta = existente.exists()
      ? `Já existe um repasse gerado (${fmtBRL(existente.data().valor)}). Atualizar para ${fmtBRL(c.aCobrir)}?`
      : `Lançar ${fmtBRL(c.aCobrir)} como receita "${tipos[0].nome}" em ${MESES[mes-1]}/${ano}? Faça isso quando o repasse for realmente recebido.`;
    if(!confirm(pergunta)) return;
    const ultimoDia = new Date(ano, mes, 0).getDate();
    const dataStr = `${ano}-${pad2(mes)}-${pad2(ultimoDia)}`;
    const payload = {
      tipo:'receita', dataStr, mes, ano, competenciaKey:key, categoriaId:tipos[0].id, categoriaNome:tipos[0].nome,
      descricao:'Repasse CAEB (cobertura do déficit do mês)', valor: c.aCobrir, membroId:null, membroNome:'', bloqueado:false,
      origem:'caeb-repasse',
      ...camposConta(state.contas.find(x=>x.principal)?.id || null, dataStr, 'receita', c.aCobrir),
      criadoPor: state.user.uid, criadoPorNome: state.perfil.nome, atualizadoEm: serverTimestamp()
    };
    if(!existente.exists()) payload.criadoEm = serverTimestamp();
    await setDoc(ref, payload, { merge: true });
    toast('Repasse lançado!');
    renderRelatorios(); renderPainel();
  } catch(e){ console.error('Erro ao gerar repasse CAEB:', e); toast('Erro ao gerar: '+e.message, true); }
  finally { btn.disabled = false; }
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
  $('relReceitas').innerHTML = agruparPorCategoria(lancs.filter(l=>l.tipo==='receita'), 'green');
  $('relDespesas').innerHTML = agruparPorCategoria(lancs.filter(l=>l.tipo==='despesa'), 'red');
  renderRelatorioFiel();
  renderRelatorioAnual();
  renderCaebCard(lancs, mes, ano);
}
function agruparPorCategoria(lancs, cor){
  const grupos = {};
  lancs.forEach(l => { grupos[l.categoriaNome] = (grupos[l.categoriaNome]||0) + l.valor; });
  const entradas = Object.entries(grupos).sort((a,b)=>b[1]-a[1]);
  if(!entradas.length) return `<div class="empty">Sem lançamentos neste mês.</div>`;
  return entradas.map(([nome,total]) => `
    <div class="list-row"><span>${nome}</span><span class="num ${cor}">${fmtBRL(total)}</span></div>`).join('');
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
    const saldoMes = m.receitas - m.despesas;
    const corSaldoMes = saldoMes >= 0 ? 'green' : 'red';
    const corSaldoAnterior = m.saldoAnterior >= 0 ? 'green' : 'red';
    return `<tr><td>${MESES[i]}</td><td class="num ${corSaldoAnterior}">${fmtBRL(m.saldoAnterior)}</td><td class="num green">${fmtBRL(m.receitas)}</td><td class="num red">${fmtBRL(m.despesas)}</td><td class="num ${corSaldoMes}">${fmtBRL(saldoMes)}</td></tr>`;
  }).join('');
  const corTotalSaldo = (totalReceitas-totalDespesas) >= 0 ? 'green' : 'red';
  $('relAnualTabela').innerHTML = `
    <div class="table-scroll"><table>
      <thead><tr><th>Mês</th><th style="text-align:right;">Saldo Anterior</th><th style="text-align:right;">Receitas</th><th style="text-align:right;">Despesas</th><th style="text-align:right;">Saldo do Mês</th></tr></thead>
      <tbody>${linhas}</tbody>
      <tfoot><tr style="font-weight:600;"><td colspan="2">Total do ano</td><td class="num green">${fmtBRL(totalReceitas)}</td><td class="num red">${fmtBRL(totalDespesas)}</td><td class="num ${corTotalSaldo}">${fmtBRL(totalReceitas-totalDespesas)}</td></tr></tfoot>
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
    <div class="list-row"><strong>${rotuloPeriodo}</strong><strong class="num green">${fmtBRL(total)}</strong></div>
    ${lancs.map(l=>`<div class="list-row"><span>${formatarDataBR(l.dataStr)} · ${l.categoriaNome}</span><span class="num green">${fmtBRL(l.valor)}</span></div>`).join('')}
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
  if(!lista.length){
    $('compLista').innerHTML = `<div class="empty">Nenhuma competência bloqueada ainda.</div>`;
    return;
  }
  // Agrupa por ano (accordion) — sem isso, a lista fica uma parede de texto
  // conforme os anos passam e mais meses vão sendo bloqueados.
  const porAno = {};
  lista.forEach(c => { if(!porAno[c.ano]) porAno[c.ano] = []; porAno[c.ano].push(c); });
  const anos = Object.keys(porAno).map(Number).sort((a,b)=> b-a);
  $('compLista').innerHTML = anos.map((ano, i) => {
    const meses = porAno[ano].sort((a,b)=> a.mes-b.mes);
    return `
    <div class="year-group ${i===0 ? 'open' : ''}">
      <button type="button" class="year-header" data-ano="${ano}">
        <span class="year-header-left">
          <svg class="year-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
          <span class="serif">${ano}</span>
        </span>
        <span class="year-count">${meses.length} ${meses.length===1 ? 'mês bloqueado' : 'meses bloqueados'}</span>
      </button>
      <div class="year-body">
        ${meses.map(c => `<div class="list-row"><span>${MESES[c.mes-1]}</span><span class="tag locked">bloqueado</span></div>`).join('')}
      </div>
    </div>`;
  }).join('');
  $('compLista').querySelectorAll('.year-header').forEach(btn=>{
    btn.addEventListener('click', ()=> btn.closest('.year-group').classList.toggle('open'));
  });
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

// ---------- CAMPANHAS ----------
function labelTipoCampanha(tipo){
  return { arrecadacao:'Arrecadação', venda:'Venda de algo', compra:'Compra coletiva', outro:'Outro' }[tipo] || tipo;
}
async function somarCampanha(campanhaId, tipo){
  const q = query(collection(db,'igrejas',state.igrejaAtualId,'campanhas',campanhaId,'lancamentos'), where('tipo','==',tipo));
  try{
    const snap = await getAggregateFromServer(q, { total: sum('valor') });
    return snap.data().total || 0;
  } catch(e){
    const docs = await getDocs(q);
    return docs.docs.reduce((s,d)=> s + (d.data().valor||0), 0);
  }
}
async function campanhaTemLancamentos(campanhaId){
  const snap = await getDocs(query(collection(db,'igrejas',state.igrejaAtualId,'campanhas',campanhaId,'lancamentos'), limit(1)));
  return !snap.empty;
}
async function carregarCampanhas(){
  const snaps = await getDocs(collection(db,'igrejas',state.igrejaAtualId,'campanhas'));
  state.campanhas = snaps.docs.map(d=>({id:d.id, ...d.data()}));
}

let campanhasInit = false;
async function renderCampanhas(){
  if(!campanhasInit){
    campanhasInit = true;
    $('campanhasFiltroStatus').addEventListener('change', desenharListaCampanhas);
    $('btnVoltarCampanhas').addEventListener('click', ()=> switchView('campanhas'));
  }
  await carregarCampanhas();
  await desenharListaCampanhas();
}
async function desenharListaCampanhas(){
  const editavel = podeEditarAba('campanhas');
  $('btnNovaCampanha').style.display = editavel ? 'inline-flex' : 'none';
  const filtro = $('campanhasFiltroStatus').value;
  let lista = state.campanhas;
  if(filtro) lista = lista.filter(c=>c.status===filtro);
  lista = ordenarPorNome(lista);
  $('campanhasEmpty').style.display = lista.length ? 'none' : 'block';

  const comMeta = lista.filter(c=>c.meta);
  const totaisEntrada = await Promise.all(comMeta.map(c => somarCampanha(c.id, 'entrada')));
  const mapaArrecadado = {};
  comMeta.forEach((c,i)=> mapaArrecadado[c.id] = totaisEntrada[i]);

  $('campanhasLista').innerHTML = lista.map(c => {
    const arrecadado = mapaArrecadado[c.id] || 0;
    const progresso = c.meta ? Math.min(100, Math.round((arrecadado/c.meta)*100)) : null;
    return `
    <div class="campanha-card" data-id="${c.id}">
      <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:12px;">
        <div>
          <div style="font-weight:600; font-size:15px;">${c.nome}</div>
          <div style="font-size:12.5px; color:var(--text-dim); margin-top:2px;">${labelTipoCampanha(c.tipo)}${c.descricao ? ' · '+c.descricao : ''}${c.responsavelNome ? ' · Resp.: '+c.responsavelNome : ''}</div>
        </div>
        <span class="tag ${c.status}">${c.status === 'ativa' ? 'Ativa' : 'Encerrada'}</span>
      </div>
      ${c.meta ? `
      <div style="display:flex; justify-content:space-between; font-size:11.5px; color:var(--text-dim); margin-top:10px;">
        <span>${fmtBRL(arrecadado)} arrecadado</span><span>meta ${fmtBRL(c.meta)}</span>
      </div>
      <div class="campanha-progress"><div class="campanha-progress-fill" style="width:${progresso}%;"></div></div>
      ` : ''}
      ${editavel ? `<button class="btn btn-sm btn-danger" data-del-campanha="${c.id}" style="margin-top:10px;" type="button">Excluir</button>` : ''}
    </div>`;
  }).join('');

  $('campanhasLista').querySelectorAll('.campanha-card').forEach(el=>{
    el.addEventListener('click', (e)=>{
      if(e.target.closest('[data-del-campanha]')) return;
      abrirDetalheCampanha(el.dataset.id);
    });
  });
  $('campanhasLista').querySelectorAll('[data-del-campanha]').forEach(btn=>{
    btn.addEventListener('click', async (e)=>{
      e.stopPropagation();
      const id = btn.dataset.delCampanha;
      if(await campanhaTemLancamentos(id)){ toast('Não é possível excluir: essa campanha já tem lançamentos.', true); return; }
      if(!confirm('Excluir esta campanha?')) return;
      await deleteDoc(doc(db,'igrejas',state.igrejaAtualId,'campanhas', id));
      toast('Campanha excluída.'); await carregarCampanhas(); desenharListaCampanhas();
    });
  });
}

$('btnNovaCampanha').addEventListener('click', ()=> abrirModalCampanha(null));
function abrirModalCampanha(c){
  state.editandoCampanhaId = c ? c.id : null;
  $('modalCampanhaTitulo').textContent = c ? 'Editar campanha' : 'Nova campanha';
  $('campFormNome').value = c?.nome || '';
  $('campFormDescricao').value = c?.descricao || '';
  $('campFormTipo').value = c?.tipo || 'arrecadacao';
  $('campFormMeta').value = c?.meta || '';
  $('campFormResponsavelBusca').value = c?.responsavelNome || '';
  $('campFormResponsavelId').value = c?.responsavelFielId || '';
  $('campFormDataInicio').value = c?.dataInicio || dataLocalISO();
  $('campFormDataFim').value = c?.dataFim || '';
  $('modalCampanha').classList.add('active');
}
$('btnCancelarCampanha').addEventListener('click', ()=> $('modalCampanha').classList.remove('active'));
$('btnSalvarCampanha').addEventListener('click', async ()=>{
  if(!validarObrigatorios([{id:'campFormNome', nome:'Nome'}, {id:'campFormDataInicio', nome:'Data de início'}])) return;
  const payload = {
    nome: $('campFormNome').value.trim(),
    descricao: $('campFormDescricao').value.trim(),
    tipo: $('campFormTipo').value,
    meta: $('campFormMeta').value ? parseFloat($('campFormMeta').value) : null,
    responsavelFielId: $('campFormResponsavelId').value || null,
    responsavelNome: $('campFormResponsavelId').value ? $('campFormResponsavelBusca').value.trim() : '',
    dataInicio: $('campFormDataInicio').value,
    dataFim: $('campFormDataFim').value || null,
  };
  try{
    if(state.editandoCampanhaId){
      await updateDoc(doc(db,'igrejas',state.igrejaAtualId,'campanhas',state.editandoCampanhaId), payload);
    } else {
      payload.status = 'ativa';
      payload.criadoPor = state.user.uid; payload.criadoEm = serverTimestamp();
      await addDoc(collection(db,'igrejas',state.igrejaAtualId,'campanhas'), payload);
    }
    $('modalCampanha').classList.remove('active');
    toast('Campanha salva!');
    await carregarCampanhas(); desenharListaCampanhas();
  } catch(e){ toast('Erro ao salvar: '+e.message, true); }
});

async function abrirDetalheCampanha(id){
  state.campanhaAtualId = id;
  document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
  document.getElementById('view-campanhaDetalhe').classList.add('active');
  await renderCampanhaDetalhe();
}

let campDetalheInit = false;
async function renderCampanhaDetalhe(){
  if(!campDetalheInit){
    campDetalheInit = true;
    $('campLancTipoFiltro').addEventListener('change', carregarELancamentosCampanha);
    $('btnNovoLancCampanha').addEventListener('click', ()=> abrirModalCampLanc(null));
    $('btnEncerrarCampanha').addEventListener('click', toggleEncerrarCampanha);
    $('btnPdfCampanha').addEventListener('click', gerarPdfCampanha);
    $('btnExportarCampLanc').addEventListener('click', exportarLancamentosCampanha);
    $('btnImportarCampLanc').addEventListener('click', abrirModalImportarCampanha);
  }
  const snap = await getDoc(doc(db,'igrejas',state.igrejaAtualId,'campanhas',state.campanhaAtualId));
  if(!snap.exists()){ switchView('campanhas'); return; }
  state.campanhaAtualDados = { id: snap.id, ...snap.data() };
  const c = state.campanhaAtualDados;
  $('campDetNome').textContent = c.nome;
  $('campDetDescricao').textContent = [labelTipoCampanha(c.tipo), c.responsavelNome ? 'Responsável: '+c.responsavelNome : null].filter(Boolean).join(' · ');
  const podeGerenciar = podeEditarAba('campanhas');
  $('btnEncerrarCampanha').style.display = podeGerenciar ? 'inline-flex' : 'none';
  $('btnEncerrarCampanha').textContent = c.status === 'ativa' ? 'Encerrar campanha' : 'Reabrir campanha';
  $('btnNovoLancCampanha').style.display = (podeGerenciar && c.status === 'ativa') ? 'inline-flex' : 'none';
  $('btnImportarCampLanc').style.display = (isAdmin() && c.status === 'ativa') ? 'inline-flex' : 'none';

  await carregarELancamentosCampanha();
}

async function carregarELancamentosCampanha(){
  const c = state.campanhaAtualDados;
  const tipoFiltro = $('campLancTipoFiltro').value;
  const snaps = await getDocs(collection(db,'igrejas',state.igrejaAtualId,'campanhas',c.id,'lancamentos'));
  let lancs = snaps.docs.map(d=>({id:d.id, ...d.data()}));
  const totalEntradas = lancs.filter(l=>l.tipo==='entrada').reduce((s,l)=>s+l.valor,0);
  const totalSaidas = lancs.filter(l=>l.tipo==='saida').reduce((s,l)=>s+l.valor,0);
  $('campDetTotalEntradas').textContent = fmtBRL(totalEntradas);
  $('campDetTotalSaidas').textContent = fmtBRL(totalSaidas);
  const saldoEl = $('campDetSaldo');
  saldoEl.textContent = fmtBRL(totalEntradas-totalSaidas);
  saldoEl.className = 'stat-value num ' + (totalEntradas-totalSaidas>=0?'green':'red');

  if(c.meta){
    $('campDetProgressoCard').style.display = 'block';
    $('campDetArrecadado').textContent = fmtBRL(totalEntradas);
    $('campDetMeta').textContent = fmtBRL(c.meta);
    $('campDetProgressoFill').style.width = Math.min(100, Math.round((totalEntradas/c.meta)*100)) + '%';
  } else {
    $('campDetProgressoCard').style.display = 'none';
  }

  if(tipoFiltro) lancs = lancs.filter(l=>l.tipo===tipoFiltro);
  lancs.sort((a,b)=> (b.data||'').localeCompare(a.data||''));
  const editavel = podeEditarAba('campanhas') && c.status === 'ativa';
  $('campLancEmpty').style.display = lancs.length ? 'none' : 'block';
  $('campLancTbody').innerHTML = lancs.map(l => `
    <tr>
      <td>${l.data ? formatarDataBR(l.data) : '—'}</td>
      <td><span class="tag ${l.tipo==='entrada'?'receita':'despesa'}">${l.tipo==='entrada'?'entrada':'saída'}</span></td>
      <td>${l.categoria||''}</td>
      <td>${l.descricao||'—'}</td>
      <td>${l.fielNome||'—'}</td>
      <td class="num">${fmtBRL(l.valor)}</td>
      <td>${editavel ? `<button class="btn btn-sm" data-edit="${l.id}">Editar</button>
        <button class="btn btn-sm btn-danger" data-del="${l.id}">Excluir</button>` : ''}</td>
    </tr>`).join('');
  $('campLancTbody').querySelectorAll('[data-edit]').forEach(b=>{
    b.addEventListener('click', ()=> abrirModalCampLanc(lancs.find(l=>l.id===b.dataset.edit)));
  });
  $('campLancTbody').querySelectorAll('[data-del]').forEach(b=>{
    b.addEventListener('click', async ()=>{
      if(!confirm('Excluir este lançamento?')) return;
      await deleteDoc(doc(db,'igrejas',state.igrejaAtualId,'campanhas',c.id,'lancamentos', b.dataset.del));
      toast('Lançamento excluído.'); await carregarELancamentosCampanha();
    });
  });
}

function abrirModalCampLanc(l){
  state.editandoCampLancId = l ? l.id : null;
  $('modalCampLancTitulo').textContent = l ? 'Editar lançamento' : 'Novo lançamento';
  $('campLancFormTipo').value = l ? l.tipo : 'entrada';
  $('campLancFormCategoria').value = l?.categoria || '';
  $('campLancFormData').value = l ? l.data : dataLocalISO();
  $('campLancFormValor').value = l ? l.valor : '';
  $('campLancFormDescricao').value = l?.descricao || '';
  $('campLancFormFiel').value = l?.fielId || '';
  $('campLancFormFielBusca').value = l?.fielNome || '';
  $('campLancFormFielLista').classList.remove('active');
  $('modalCampLanc').classList.add('active');
}
$('btnCancelarCampLanc').addEventListener('click', ()=> $('modalCampLanc').classList.remove('active'));
$('btnSalvarCampLanc').addEventListener('click', async ()=>{
  if(!validarObrigatorios([
    {id:'campLancFormCategoria', nome:'Categoria'}, {id:'campLancFormData', nome:'Data'}, {id:'campLancFormValor', nome:'Valor'}
  ])) return;
  const valor = parseFloat($('campLancFormValor').value);
  if(isNaN(valor) || valor <= 0){ $('campLancFormValor').classList.add('input-error'); toast('Informe um valor válido.', true); return; }
  const c = state.campanhaAtualDados;
  if(c.status !== 'ativa'){ toast('Essa campanha está encerrada — reabra antes de lançar.', true); return; }
  const payload = {
    tipo: $('campLancFormTipo').value,
    categoria: $('campLancFormCategoria').value.trim(),
    data: $('campLancFormData').value,
    valor,
    descricao: $('campLancFormDescricao').value.trim(),
    fielId: $('campLancFormFiel').value || null,
    fielNome: $('campLancFormFiel').value ? $('campLancFormFielBusca').value.trim() : '',
  };
  try{
    if(state.editandoCampLancId){
      await updateDoc(doc(db,'igrejas',state.igrejaAtualId,'campanhas',c.id,'lancamentos',state.editandoCampLancId), payload);
    } else {
      payload.criadoPor = state.user.uid; payload.criadoPorNome = state.perfil.nome; payload.criadoEm = serverTimestamp();
      await addDoc(collection(db,'igrejas',state.igrejaAtualId,'campanhas',c.id,'lancamentos'), payload);
    }
    $('modalCampLanc').classList.remove('active');
    toast('Lançamento salvo!');
    await carregarELancamentosCampanha();
  } catch(e){ toast('Erro ao salvar: '+e.message, true); }
});

async function toggleEncerrarCampanha(){
  const c = state.campanhaAtualDados;
  const novoStatus = c.status === 'ativa' ? 'encerrada' : 'ativa';
  const msg = novoStatus === 'encerrada'
    ? 'Encerrar esta campanha? Não será mais possível lançar nela até reabrir.'
    : 'Reabrir esta campanha?';
  if(!confirm(msg)) return;
  await updateDoc(doc(db,'igrejas',state.igrejaAtualId,'campanhas',c.id), { status: novoStatus });
  toast(novoStatus === 'encerrada' ? 'Campanha encerrada.' : 'Campanha reaberta.');
  await renderCampanhaDetalhe();
}

async function gerarPdfCampanha(){
  const c = state.campanhaAtualDados;
  const btn = $('btnPdfCampanha');
  btn.disabled = true; toast('Gerando PDF...');
  try{
    const snaps = await getDocs(collection(db,'igrejas',state.igrejaAtualId,'campanhas',c.id,'lancamentos'));
    const lancs = snaps.docs.map(d=>({id:d.id, ...d.data()}));
    const entradas = [...lancs.filter(l=>l.tipo==='entrada')].sort((a,b) => {
      const na = (a.fielNome||'').trim(), nb = (b.fielNome||'').trim();
      if(!na && !nb) return 0;
      if(!na) return 1;
      if(!nb) return -1;
      return na.localeCompare(nb, 'pt-BR');
    });
    const saidas = lancs.filter(l=>l.tipo==='saida').sort((a,b)=>(a.data||'').localeCompare(b.data||''));
    const totalEntradas = entradas.reduce((s,l)=>s+l.valor,0);
    const totalSaidas = saidas.reduce((s,l)=>s+l.valor,0);

    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF();
    const titulo = `CAMPANHA — ${c.nome.toUpperCase()}`;
    let y = cabecalhoRelatorioPdf(pdf, titulo);

    y = faixaTitulo(pdf, y, 'RELAÇÃO DE ENTRADAS');
    const linhasEntradas = entradas.map((l,i)=>[i+1, l.fielNome||'—', l.categoria||'', formatarDataBR(l.data), fmtBRL(l.valor)]);
    pdf.autoTable({
      startY:y, head:[['N°','Nome','Categoria','Data','Valor']],
      body: linhasEntradas.length ? linhasEntradas : [['—','Nenhuma entrada registrada','','','']],
      theme:'grid', styles:{fontSize:7, cellPadding:1.3}, headStyles:{fillColor:[13,79,196], fontSize:7},
      columnStyles:{4:{halign:'right'}}, margin:{left:14,right:14,bottom:12}
    });
    y = pdf.lastAutoTable.finalY + 2;
    y = garantirEspaco(pdf, y, 8.5, titulo);
    y = faixaTotal(pdf, y, 'TOTAL DE ENTRADAS (R$)', totalEntradas, [200,230,210]);

    y = garantirEspaco(pdf, y, 25, titulo);
    y = faixaTitulo(pdf, y, 'RELAÇÃO DE SAÍDAS');
    const linhasSaidas = saidas.map((l,i)=>[i+1, l.categoria||'', l.descricao||'', formatarDataBR(l.data), fmtBRL(l.valor)]);
    pdf.autoTable({
      startY:y, head:[['N°','Categoria','Descrição','Data','Valor']],
      body: linhasSaidas.length ? linhasSaidas : [['—','Nenhuma saída registrada','','','']],
      theme:'grid', styles:{fontSize:7, cellPadding:1.3}, headStyles:{fillColor:[199,63,63], fontSize:7},
      columnStyles:{4:{halign:'right'}}, margin:{left:14,right:14,bottom:12}
    });
    y = pdf.lastAutoTable.finalY + 2;
    y = garantirEspaco(pdf, y, 8.5, titulo);
    y = faixaTotal(pdf, y, 'TOTAL DE SAÍDAS (R$)', totalSaidas, [248,215,215]);
    y = garantirEspaco(pdf, y, 8.5, titulo);
    y = faixaTotal(pdf, y, 'SALDO DA CAMPANHA (R$)', totalEntradas-totalSaidas, [220,230,245]);

    y = garantirEspaco(pdf, y, 19, titulo);
    desenharAssinaturas(pdf, y + 10);

    pdf.save(nomeArquivoPdf(`campanha_${nomeArquivoSeguro(c.nome)}`));
    toast('PDF gerado!');
  } catch(e){
    console.error('Erro ao gerar PDF da campanha:', e);
    toast('Erro ao gerar o PDF: ' + e.message, true);
  } finally {
    btn.disabled = false;
  }
}

// ---------- CAMPANHAS: EXPORTAR / IMPORTAR ----------
$('btnExportarCampanhas').addEventListener('click', async ()=>{
  if(!state.campanhas.length){ toast('Nenhuma campanha para exportar.', true); return; }
  toast('Preparando exportação...');
  const campanhasOrdenadas = ordenarPorNome(state.campanhas);
  const totaisEntrada = await Promise.all(campanhasOrdenadas.map(c => somarCampanha(c.id,'entrada')));
  const totaisSaida = await Promise.all(campanhasOrdenadas.map(c => somarCampanha(c.id,'saida')));
  const linhas = campanhasOrdenadas.map((c,i) => ({
    Nome: c.nome, Tipo: labelTipoCampanha(c.tipo), Status: c.status==='ativa'?'Ativa':'Encerrada',
    Responsável: c.responsavelNome || '', 'Data Início': c.dataInicio ? formatarDataBR(c.dataInicio) : '',
    'Data Fim': c.dataFim ? formatarDataBR(c.dataFim) : '',
    Meta: c.meta || '', 'Total Entradas': totaisEntrada[i], 'Total Saídas': totaisSaida[i],
    Saldo: totaisEntrada[i]-totaisSaida[i],
  }));
  const ws = XLSX.utils.json_to_sheet(linhas);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Campanhas');
  XLSX.writeFile(wb, `campanhas_${nomeArquivoSeguro(igrejaAtual()?.nome)}.xlsx`);
  toast('Exportado!');
});

async function exportarLancamentosCampanha(){
  const c = state.campanhaAtualDados;
  const snaps = await getDocs(collection(db,'igrejas',state.igrejaAtualId,'campanhas',c.id,'lancamentos'));
  const lancs = snaps.docs.map(d=>({id:d.id, ...d.data()})).sort((a,b)=>(a.data||'').localeCompare(b.data||''));
  if(!lancs.length){ toast('Nenhum lançamento para exportar.', true); return; }
  const linhas = lancs.map(l => ({
    Data: l.data ? formatarDataBR(l.data) : '', Tipo: l.tipo==='entrada'?'Entrada':'Saída',
    Categoria: l.categoria||'', Descrição: l.descricao||'', Fiel: l.fielNome||'', Valor: l.valor,
  }));
  const ws = XLSX.utils.json_to_sheet(linhas);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Lançamentos');
  XLSX.writeFile(wb, `campanha_${nomeArquivoSeguro(c.nome)}.xlsx`);
  toast('Exportado!');
}

function abrirModalImportarCampanha(){
  $('importCampNome').textContent = state.campanhaAtualDados?.nome || '';
  $('importCampLog').textContent = '';
  $('importCampArquivo').value = '';
  $('modalImportarCampanha').classList.add('active');
}
$('btnCancelarImportarCampanha').addEventListener('click', ()=> $('modalImportarCampanha').classList.remove('active'));

$('btnBaixarModeloCampanha').addEventListener('click', ()=>{
  const wb = XLSX.utils.book_new();
  const instrucoes = [
    ['Como preencher esta planilha'],
    [''],
    ['1. Uma linha por lançamento, na aba "lancamentos_campanha". Apague a linha de exemplo antes'],
    ['   de importar de verdade.'],
    ['2. "Tipo" deve ser exatamente "entrada" ou "saida" (sem acento).'],
    ['3. "Data" deve estar em formato de data do Excel.'],
    ['4. "Nome do Fiel" é opcional — se preencher, o app tenta achar um fiel já cadastrado com esse'],
    ['   nome (sem diferenciar acento/maiúscula). Se não encontrar, guarda só o nome digitado, sem'],
    ['   vincular ao cadastro.'],
    ['5. "Categoria" é texto livre, ex: "Doação", "Venda de rifa nº 12", "Material de construção".'],
    ['6. Os lançamentos importados entram direto na campanha que estiver aberta no momento do envio.'],
  ];
  const wsInstrucoes = XLSX.utils.aoa_to_sheet(instrucoes);
  wsInstrucoes['!cols'] = [{wch: 100}];
  XLSX.utils.book_append_sheet(wb, wsInstrucoes, 'Instruções');

  const ws = XLSX.utils.json_to_sheet([
    { Tipo:'entrada', Categoria:'Doação', Data: new Date(2025,0,10), Valor:100, 'Nome do Fiel':'João da Silva', Descrição:'' },
    { Tipo:'saida', Categoria:'Material de construção', Data: new Date(2025,0,15), Valor:250, 'Nome do Fiel':'', Descrição:'Compra de cimento' },
  ]);
  ws['!cols'] = [{wch:10},{wch:26},{wch:14},{wch:10},{wch:22},{wch:26}];
  XLSX.utils.book_append_sheet(wb, ws, 'lancamentos_campanha');

  XLSX.writeFile(wb, 'modelo_importacao_campanha.xlsx');
  toast('Modelo baixado!');
});

$('btnImportarCampanhaConfirmar').addEventListener('click', async ()=>{
  const c = state.campanhaAtualDados;
  const file = $('importCampArquivo').files[0];
  if(!file){ toast('Selecione o arquivo .xlsx primeiro.', true); return; }
  const btn = $('btnImportarCampanhaConfirmar');
  btn.disabled = true; btn.textContent = 'Importando...';
  $('importCampLog').textContent = '';
  const logImportCamp = (msg) => {
    const el = $('importCampLog'); el.textContent += msg + '\n'; el.scrollTop = el.scrollHeight;
  };
  try{
    logImportCamp('Lendo planilha...');
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type:'array', cellDates:true });
    const sheet = wb.Sheets['lancamentos_campanha'];
    const linhasBrutas = sheet ? XLSX.utils.sheet_to_json(sheet, { defval: null }) : [];
    const linhas = linhasBrutas.filter(l =>
      l['Tipo'] && l['Data'] instanceof Date && typeof l['Valor'] === 'number' &&
      ['entrada','saida'].includes((l['Tipo']||'').toString().trim().toLowerCase())
    );
    logImportCamp(`Encontrados ${linhas.length} lançamentos válidos na aba "lancamentos_campanha".`);
    let total = 0;
    for(const l of linhas){
      const tipo = l['Tipo'].toString().trim().toLowerCase();
      let fielId = null, fielNome = '';
      const nomeDigitado = (l['Nome do Fiel']||'').toString().trim();
      if(nomeDigitado){
        const termo = normalizarTexto(nomeDigitado);
        try{
          const q = query(collection(db,'igrejas',state.igrejaAtualId,'membros'), orderBy('nomeBusca'), where('nomeBusca','>=',termo), where('nomeBusca','<=',termo+'\uf8ff'), limit(1));
          const snap = await getDocs(q);
          if(!snap.empty){ fielId = snap.docs[0].id; fielNome = snap.docs[0].data().nome; }
          else fielNome = nomeDigitado;
        } catch(e){ fielNome = nomeDigitado; }
      }
      await addDoc(collection(db,'igrejas',state.igrejaAtualId,'campanhas',c.id,'lancamentos'), {
        tipo, categoria: (l['Categoria']||'').toString().trim(),
        data: l['Data'].toISOString().slice(0,10), valor: l['Valor'],
        descricao: (l['Descrição']||'').toString().trim(),
        fielId, fielNome,
        criadoPor: state.user.uid, criadoPorNome: state.perfil.nome, criadoEm: serverTimestamp(), importado: true,
      });
      total++;
      if(total % 20 === 0) logImportCamp(`  ...${total} importados`);
    }
    logImportCamp(`\n✅ ${total} lançamentos importados com sucesso!`);
    toast('Importação concluída!');
    await carregarELancamentosCampanha();
  } catch(e){
    logImportCamp('\n❌ Erro: ' + e.message);
    toast('Erro na importação — veja o log.', true);
  } finally {
    btn.disabled = false; btn.textContent = 'Iniciar importação';
  }
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
// Versão para imagens grandes do cabeçalho/marca d'água do PDF: preenche o fundo
// de branco (JPEG não tem transparência — sem isso PNG transparente vira preto)
// e reduz a qualidade até caber ~350KB, porque tudo isso mora no documento da
// igreja (limite do Firestore: 1MB por documento).
function redimensionarImagemBranco(file, maxLado = 1000, qualidade = 0.9){
  return new Promise((resolve, reject)=>{
    if(!file.type.startsWith('image/')){ reject(new Error('Selecione um arquivo de imagem.')); return; }
    const reader = new FileReader();
    reader.onload = (e)=>{
      const img = new Image();
      img.onload = ()=>{
        const f = Math.min(1, maxLado / Math.max(img.width, img.height));
        const w = Math.round(img.width*f), h = Math.round(img.height*f);
        const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
        const cx = cv.getContext('2d'); cx.fillStyle = '#fff'; cx.fillRect(0,0,w,h); cx.drawImage(img,0,0,w,h);
        let q = qualidade, url = cv.toDataURL('image/jpeg', q);
        while(url.length*0.75 > 350*1024 && q > 0.4){ q -= 0.1; url = cv.toDataURL('image/jpeg', q); }
        resolve(url);
      };
      img.onerror = ()=> reject(new Error('Não foi possível ler a imagem.'));
      img.src = e.target.result;
    };
    reader.onerror = ()=> reject(new Error('Não foi possível ler o arquivo.'));
    reader.readAsDataURL(file);
  });
}
function atualizarPreviewImgPdf(){
  [['igLogoTopoPreview', state.logoTopoPendente], ['igMarcaPreview', state.marcaPendente]].forEach(([id, src])=>{
    const p = $(id); if(src){ p.src = src; p.style.display = 'block'; } else { p.removeAttribute('src'); p.style.display = 'none'; }
  });
}
$('igLogoTopoFile').addEventListener('change', async (e)=>{
  const f = e.target.files[0]; if(!f) return;
  try{ state.logoTopoPendente = await redimensionarImagemBranco(f, 1000, 0.9); atualizarPreviewImgPdf(); } catch(err){ toast(err.message, true); }
});
$('igMarcaFile').addEventListener('change', async (e)=>{
  const f = e.target.files[0]; if(!f) return;
  try{ state.marcaPendente = await redimensionarImagemBranco(f, 1200, 0.85); atualizarPreviewImgPdf(); } catch(err){ toast(err.message, true); }
});
$('btnRemoverLogoTopo').addEventListener('click', ()=>{ state.logoTopoPendente = null; $('igLogoTopoFile').value = ''; atualizarPreviewImgPdf(); });
$('btnRemoverMarca').addEventListener('click', ()=>{ state.marcaPendente = null; $('igMarcaFile').value = ''; atualizarPreviewImgPdf(); });

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
  state.logoTopoPendente = d.logoTopo || null; state.marcaPendente = d.marcaDagua || null; atualizarPreviewImgPdf();
  $('igMarcaOpacidade').value = d.marcaOpacidade ?? 15; $('igMarcaTamanho').value = d.marcaTamanho || 'media'; $('igLogoTopoTamanho').value = d.logoTopoTamanho || 'media';
  $('igCorPrimaria').value = d.corPrimaria || '#156082'; $('igCorDestaque').value = d.corDestaque || '#F69238';
  $('igContatoNome').value = d.contatoNome || ''; $('igContatoTelefone').value = d.contatoTelefone || '';
  $('igNome').value = d.nome||''; $('igCnpj').value = d.cnpj||'';
  $('igNomeRelatorio').value = d.nomeRelatorio||'';
  $('igPastorBusca').value = d.pastor||''; $('igPastorId').value = d.pastorFielId||'';
  $('igTesoureiroBusca').value = d.tesoureiro||''; $('igTesoureiroId').value = d.tesoureiroFielId||'';
  $('igEmail').value = d.email||''; $('igInstagram').value = d.instagram||'';
  $('igEndereco').value = d.endereco||''; $('igBairro').value = d.bairro||'';
  $('igCidade').value = d.cidade||''; $('igEstado').value = d.estado||''; $('igCep').value = d.cep||'';
  $('igCaebeira').checked = !!d.caebeira;
  $('igCaebDesde').value = d.caebDesde || '';
  $('igCaebPercentual').value = d.caebPercentual ?? '';
  $('igCaebAjudaFixa').value = d.caebAjudaFixa ?? '';
  $('igCaebTipoRepasse').innerHTML = `<option value="">Selecione...</option>` + ordenarPorNome(state.categoriasReceita).map(c=>`<option value="${c.id}">${c.nome}</option>`).join('');
  $('igCaebTipoRepasse').value = d.caebTipoRepasseId || '';
  $('igGeralSaldoInicial').value = d.geralSaldoInicial ?? ''; $('igGeralSaldoDesde').value = d.geralSaldoDesde || '';
  $('igCaebSaldoInicial').value = d.caebSaldoInicial ?? ''; $('igCaebSaldoDesde').value = d.caebSaldoDesde || '';
  $('igCaebCampos').style.display = d.caebeira ? 'block' : 'none';
  const editavel = isAdmin();
  document.querySelectorAll('#view-igreja input').forEach(i => i.disabled = !editavel);
  $('btnSalvarIgreja').style.display = editavel ? 'inline-flex' : 'none';
  $('igExcluirCard').style.display = editavel ? 'block' : 'none';
  $('btnRemoverLogo').style.display = editavel ? 'inline-flex' : 'none';
  $('btnRemoverLogoTopo').style.display = editavel ? 'inline-flex' : 'none';
  $('btnRemoverMarca').style.display = editavel ? 'inline-flex' : 'none';
}
// Nome da igreja é sempre buscado "fresco" em igrejas/{id} no login (ver
// carregarIgrejasDoUsuario) — por isso não precisamos mais propagar essa
// mudança manualmente pra cada usuário aqui.
$('igCaebeira').addEventListener('change', ()=>{
  $('igCaebCampos').style.display = $('igCaebeira').checked ? 'block' : 'none';
});
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
    // Identidade visual e contatos da agenda semanal em PDF (cada igreja define os seus)
    logoTopo: state.logoTopoPendente || null, marcaDagua: state.marcaPendente || null,
    marcaTamanho: $('igMarcaTamanho').value || 'media', logoTopoTamanho: $('igLogoTopoTamanho').value || 'media',
    marcaOpacidade: Math.min(60, Math.max(3, parseInt($('igMarcaOpacidade').value) || 15)),
    corPrimaria: $('igCorPrimaria').value || '#156082', corDestaque: $('igCorDestaque').value || '#F69238',
    contatoNome: $('igContatoNome').value.trim(), contatoTelefone: $('igContatoTelefone').value.trim(),
    // CAEB (campos opcionais — igrejas antigas simplesmente não os têm)
    caebeira: $('igCaebeira').checked,
    caebDesde: $('igCaebDesde').value || null,
    caebPercentual: $('igCaebPercentual').value === '' ? null : parseFloat($('igCaebPercentual').value),
    caebAjudaFixa: $('igCaebAjudaFixa').value === '' ? null : parseFloat($('igCaebAjudaFixa').value),
    caebTipoRepasseId: $('igCaebTipoRepasse').value || null,
    geralSaldoInicial: $('igGeralSaldoInicial').value === '' ? null : parseFloat($('igGeralSaldoInicial').value),
    geralSaldoDesde: $('igGeralSaldoDesde').value || null,
    caebSaldoInicial: $('igCaebSaldoInicial').value === '' ? null : parseFloat($('igCaebSaldoInicial').value),
    caebSaldoDesde: $('igCaebSaldoDesde').value || null,
  };
  try{
    await updateDoc(doc(db,'igrejas',state.igrejaAtualId), payload);
    // Ainda atualiza o próprio índice (não é mais estritamente necessário,
    // já que agora buscamos o nome fresco a cada login, mas mantém o
    // seletor de igreja já certo sem precisar recarregar a página).
    await updateDoc(doc(db,'membrosIndice', `${state.igrejaAtualId}_${state.user.uid}`), { igrejaNome: payload.nome });
    state.igrejaDados = { ...state.igrejaDados, ...payload };
    aplicarLogoSidebar();
    toast('Dados da igreja atualizados!');
    await carregarIgrejasDoUsuario(state.user);
  } catch(e){ toast('Erro ao salvar: '+e.message, true); }
});

// ---------- USUÁRIOS ----------
async function renderUsuarios(){
  const usuariosSnap = await getDocs(collection(db,'igrejas',state.igrejaAtualId,'usuarios'));
  const usuarios = ordenarPorNome(usuariosSnap.docs.map(d => ({ id: d.id, ...d.data() })));
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
      const uidRemovido = b.dataset.del;
      await deleteDoc(doc(db,'igrejas',state.igrejaAtualId,'usuarios', uidRemovido));
      await deleteDoc(doc(db,'membrosIndice', `${state.igrejaAtualId}_${uidRemovido}`));
      // Limpa também o registro de perfil (nome/e-mail) que não fica mais
      // vinculado a nenhuma igreja — evita deixar sobra "escondida" no banco.
      // Isso não afeta a conta de login da pessoa em si (ela continua
      // existindo no Firebase — apagar isso de verdade exigiria um
      // servidor próprio, que este app não usa).
      try{ await deleteDoc(doc(db,'perfis', uidRemovido)); } catch(e){ /* ok se não der, é só um cache de nome */ }
      toast('Acesso removido.'); renderUsuarios();
    });
  });

  const convitesSnap = await getDocs(collection(db,'igrejas',state.igrejaAtualId,'convites'));
  const convites = ordenarPorNome(convitesSnap.docs.map(d=>({id:d.id, ...d.data()})), 'email');
  $('convitesLista').innerHTML = convites.length ? convites.map(c => `
    <div class="list-row"><span>${c.email} — <span class="papel-badge">${PAPEL_LABEL[c.papel]}</span></span>
      <button class="btn btn-sm btn-danger" data-cancel="${c.id}">Cancelar</button></div>`
  ).join('') : `<div class="empty">Nenhum convite pendente.</div>`;
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
  const q = query(collection(db,'igrejas',state.igrejaAtualId,'membros'), orderBy('nomeBusca'), limit(5000));
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

// Página de receitas nominais (dizimistas + ofertas), igual à do relatório
// mensal. Reaproveitada pelo relatório CAEB, que só muda o conjunto de
// receitas recebido (sem o repasse da CAEB) e o rótulo do total.
function ordenarPorFielNome(lista){
  return [...lista].sort((a,b) => {
    const na = (a.membroNome||'').trim(), nb = (b.membroNome||'').trim();
    if(!na && !nb) return 0;
    if(!na) return 1;
    if(!nb) return -1;
    return na.localeCompare(nb, 'pt-BR');
  });
}
function desenharPaginaReceitas(pdf, tituloPeriodo, receitas, rotuloEntradas = 'TOTAL DE ENTRADAS DO MÊS (R$)', comAssinatura = true){
  const dizimos = receitas.filter(l => ehDizimo(l.categoriaNome));
  const ofertas = receitas.filter(l => !ehDizimo(l.categoriaNome));
  const totalDizimos = dizimos.reduce((s,l)=>s+l.valor,0);
  const totalOfertas = ofertas.reduce((s,l)=>s+l.valor,0);
  const totalEntradasPg = totalDizimos + totalOfertas;
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
  y = faixaTotal(pdf, y, rotuloEntradas, totalEntradasPg, [200,230,210]);

  // Só abre página nova pra assinatura se realmente não couber (raro,
  // meses com volume bem fora do comum) — refaz o cabeçalho pra não
  // deixar uma página "solta" sem contexto.
  if(!comAssinatura) return y + 4; // relatório CAEB: segue com as despesas e assina só no fim
  y = garantirEspaco(pdf, y, 19, tituloPeriodo);
  y = desenharAssinaturas(pdf, y + 10);
  return y;
}

$('btnPdfMensal').addEventListener('click', async ()=>{
  const btn = $('btnPdfMensal');
  btn.disabled = true; toast('Gerando PDF...');
  try{
    const mes = parseInt($('relMes').value), ano = parseInt($('relAno').value);
    // Igreja Caebeira: tipos desmarcados em "Entra no relatório geral" ficam de fora
    // deste PDF (e do saldo anterior dele). Nas demais igrejas nada muda.
    const caebeira = !!state.igrejaDados?.caebeira;
    const foraDoGeral = tiposForaDoGeral();
    const lancs = (await buscarLancamentos(mes, ano)).filter(l => !(caebeira && foraDoGeral.has(l.categoriaId)));
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
    const saldoAnterior = caebeira ? await saldoAnteriorGeral(mes, ano) : await saldoAnteriorA(mes, ano);
    const saldoMes = totalEntradas - totalSaidas;

    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF();
    const tituloPeriodo = `RELATÓRIO DO MÊS DE ${MESES[mes-1].toUpperCase()} DE ${ano}`;

    // ---- PÁGINA 1: dizimistas + ofertas (por ordem alfabética do fiel) ----
    let y = desenharPaginaReceitas(pdf, tituloPeriodo, receitas, 'TOTAL DE ENTRADAS DO MÊS (R$)', false);

    // ---- Despesas (por data) + balanço final, em fluxo contínuo ----
    // Antes as despesas sempre abriam página nova porque o modelo vinha de uma
    // planilha Excel, que não conseguia gerar tudo junto. Aqui o relatório é
    // contínuo: só quebra quando não couber (garantirEspaco recria o cabeçalho),
    // e a assinatura aparece uma única vez, no final.
    y = garantirEspaco(pdf, y, 25, tituloPeriodo);
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

    y = garantirEspaco(pdf, y, 65, tituloPeriodo);
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
    const idxDestaque = linhasBalanco.length - 1;
    // Saldo financeiro REAL: o que a(s) conta(s) tinham de fato ao fim do mês
    // (por data do lançamento, como o extrato do banco). Difere do saldo acima
    // quando há lançamentos de outra competência ou tipos fora deste relatório.
    // Contas só aparecem se a igreja as cadastrou e o mês é posterior ao saldo inicial.
    const fimDoMes = iniProxMesISO(ano, mes);
    const contasDoMes = ordenarPorNome(state.contas).filter(c => c.dataSaldo && fimDoMes > c.dataSaldo);
    if(contasDoMes.length){
      const saldosContas = await Promise.all(contasDoMes.map(c => saldoDaContaAntesDe(c, fimDoMes, false)));
      contasDoMes.forEach((c,i) => linhasBalanco.push([`Saldo financeiro real - ${c.nome} (fim do mês)`, fmtBRL(saldosContas[i])]));
      if(contasDoMes.length > 1) linhasBalanco.push(['Saldo financeiro real - total das contas', fmtBRL(saldosContas.reduce((s,v)=>s+v,0))]);
    }
    pdf.autoTable({
      startY:y, body: linhasBalanco, theme:'grid', styles:{fontSize:8.5, cellPadding:2}, margin:{bottom:12},
      columnStyles:{0:{fontStyle:'bold'}, 1:{halign:'right'}},
      didParseCell: (data)=>{ if(data.row.index === idxDestaque) data.row.cells[0].styles.fillColor = data.row.cells[1].styles.fillColor = [210,235,215]; }
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

$('btnPdfCaeb').addEventListener('click', async ()=>{
  const btn = $('btnPdfCaeb');
  btn.disabled = true; toast('Gerando PDF...');
  try{
    const mes = parseInt($('relMes').value), ano = parseInt($('relAno').value);
    const lancs = await buscarLancamentos(mes, ano);
    const c = calcularCaeb(lancs, await saldoAnteriorCaeb(mes, ano));
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF();
    const titulo = `RELATÓRIO CAEB — ${MESES[mes-1].toUpperCase()} DE ${ano}`;
    // Mesma relação nominal do relatório mensal, mas só com as
    // receitas computáveis (repasse da CAEB fora).
    // Despesas e apuração vêm logo abaixo, sem quebra de página forçada, e a
    // assinatura aparece uma única vez, no final (garantirEspaco só quebra
    // se realmente não couber).
    let y = desenharPaginaReceitas(pdf, titulo, ordenarPorFielNome(c.receitasBase), 'TOTAL DE RECEITAS COMPUTÁVEIS (R$)', false);
    y = garantirEspaco(pdf, y, 25, titulo);
    y = faixaTitulo(pdf, y, 'DESPESAS DENTRO DO CÁLCULO DA CAEB');
    const linhasD = c.despCaeb.map((l,i)=>[i+1, [l.categoriaNome, l.descricao].filter(Boolean).join(' - '), formatarDataBR(l.dataStr), fmtBRL(l.valor)]);
    pdf.autoTable({ startY:y, head:[['N°','Descrição da despesa','Data','Valor (R$)']],
      body: linhasD.length ? linhasD : [['—','Nenhuma despesa CAEB neste mês.','','']],
      theme:'grid', styles:{fontSize:6.5, cellPadding:1.2}, headStyles:{fillColor:[199,63,63], fontSize:6.5}, columnStyles:{3:{halign:'right'}}, margin:{left:14,right:14,bottom:12} });
    y = garantirEspaco(pdf, pdf.lastAutoTable.finalY + 2, 8.5, titulo);
    y = faixaTotal(pdf, y, 'TOTAL DE DESPESAS CAEB (R$)', c.totalDespesas, [248,215,215]);

    y = garantirEspaco(pdf, y, 95, titulo);
    y = faixaTitulo(pdf, y, 'APURAÇÃO DA CAEB');
    // Só caracteres ASCII/latinos nos rótulos: o símbolo "-" não existe na fonte do PDF.
    const linhasB = [
      ['Receitas computáveis (sem repasse da CAEB)', fmtBRL(c.totalReceitas)],
      ['Despesas dentro do cálculo CAEB', fmtBRL(c.totalDespesas)],
      ['Resultado do mês (receitas - despesas)', fmtBRL(c.resultado)],
      ['Saldo anterior da CAEB', fmtBRL(c.saldoAnterior)],
      ['Saldo acumulado (saldo anterior + resultado)', fmtBRL(c.saldoAcumulado)],
      ['Valor a ser coberto pela CAEB (bruto)', fmtBRL(c.aCobrir)],
      ['(-) Contribuição à CAEB, já incluída nas despesas', fmtBRL(c.totalContribuicao)],
      [c.liquido >= 0 ? 'VALOR LÍQUIDO A SER REPASSADO PELA CAEB' : 'VALOR LÍQUIDO A SER REPASSADO À CAEB', fmtBRL(Math.abs(c.liquido))],
    ];
    pdf.autoTable({ startY:y, body: linhasB, theme:'grid', styles:{fontSize:8.5, cellPadding:2}, margin:{bottom:12},
      columnStyles:{0:{fontStyle:'bold'}, 1:{halign:'right'}},
      didParseCell:(data)=>{ if(data.row.index === 7) data.row.cells[0].styles.fillColor = data.row.cells[1].styles.fillColor = [210,235,215]; } });
    y = garantirEspaco(pdf, pdf.lastAutoTable.finalY + 10, 20, titulo);
    desenharAssinaturas(pdf, y);
    pdf.save(nomeArquivoPdf(`relatorio_caeb_${MESES[mes-1]}_${ano}`));
    toast('PDF gerado!');
  } catch(e){
    console.error('Erro ao gerar PDF CAEB:', e);
    toast('Erro ao gerar o PDF: ' + e.message, true);
  } finally { btn.disabled = false; }
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

// ---------- PWA: instalar o app ----------
// Em vez de depender só do navegador avisar sozinho (o que nem sempre
// acontece — regras internas do Chrome, e nunca no iPhone), agora tem um
// botão fixo "Instalar app" na tela de login e dentro do menu lateral,
// sempre visível (a não ser que o app já esteja instalado). Clicando: usa
// a instalação nativa se o navegador oferecer, ou mostra o passo a passo
// manual se não oferecer.
let promptInstalacaoEvento = null;
const CHAVE_DISMISS_INSTALL = 'softplus_install_dismissed_sessao';

function appJaInstalado(){
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}
function jaFechouNestaSessao(){
  try{ return sessionStorage.getItem(CHAVE_DISMISS_INSTALL) === '1'; } catch(err){ return false; }
}
function marcarFechadoNestaSessao(){
  try{ sessionStorage.setItem(CHAVE_DISMISS_INSTALL, '1'); } catch(err){ /* sem problema se não der pra guardar */ }
}
function esconderBannerInstalar(){
  $('instalarBanner').classList.remove('active');
}
function mostrarBannerInstalar(textoHtml, mostrarBotaoInstalar){
  $('instalarBannerTexto').innerHTML = textoHtml;
  $('btnInstalarApp').style.display = mostrarBotaoInstalar ? 'inline-flex' : 'none';
  $('instalarBanner').classList.add('active');
}
function atualizarBotoesInstalarFixos(){
  const escondido = appJaInstalado() ? 'none' : 'inline-flex';
  if($('btnInstalarLogin')) $('btnInstalarLogin').style.display = escondido;
  if($('btnInstalarSidebar')) $('btnInstalarSidebar').style.display = escondido;
}
async function acionarInstalacao(){
  if(promptInstalacaoEvento){
    promptInstalacaoEvento.prompt();
    const resultado = await promptInstalacaoEvento.userChoice;
    promptInstalacaoEvento = null;
    if(resultado.outcome === 'accepted') atualizarBotoesInstalarFixos();
    return;
  }
  const ehIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
  const instrucao = ehIOS
    ? '<strong>Como instalar</strong>No iPhone/iPad: toque em Compartilhar <span style="font-weight:600;">⬆</span> e depois em "Adicionar à Tela de Início".'
    : '<strong>Como instalar</strong>Toque no menu (⋮ ou ≡) do navegador e escolha "Instalar app" ou "Adicionar à tela inicial". No computador, procure o ícone de instalar na barra de endereço.';
  mostrarBannerInstalar(instrucao, false);
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  promptInstalacaoEvento = e;
  if(!appJaInstalado() && !jaFechouNestaSessao()){
    mostrarBannerInstalar(
      '<strong>Instalar o SOFT+</strong>Acesso rápido, direto da tela inicial do seu celular.',
      true
    );
  }
});

$('btnInstalarApp').addEventListener('click', async () => {
  esconderBannerInstalar();
  if(!promptInstalacaoEvento) return;
  promptInstalacaoEvento.prompt();
  await promptInstalacaoEvento.userChoice;
  promptInstalacaoEvento = null;
});
$('btnFecharInstalarBanner').addEventListener('click', () => {
  esconderBannerInstalar();
  marcarFechadoNestaSessao();
});
$('btnInstalarLogin').addEventListener('click', acionarInstalacao);
$('btnInstalarSidebar').addEventListener('click', acionarInstalacao);

window.addEventListener('appinstalled', () => {
  esconderBannerInstalar();
  marcarFechadoNestaSessao();
  atualizarBotoesInstalarFixos();
});

atualizarBotoesInstalarFixos();

// ---------- NAVEGAÇÃO POR SETAS (mês e ano) ----------
// Complementa as listas de seleção: "‹ Janeiro ›  ‹ 2026 ›". Instalado uma vez
// só, envolvendo os selects que já existem (populaMesAno só troca as opções,
// então as setas continuam valendo). Se o ano pedido ainda não existe na lista,
// a opção é criada na hora, para dar para navegar além do intervalo inicial.
function garantirOpcaoAno(selAno, ano){
  if(![...selAno.options].some(o => parseInt(o.value) === ano)){
    const op = document.createElement('option'); op.value = ano; op.textContent = ano;
    selAno.appendChild(op);
    [...selAno.options].sort((x,y)=>x.value-y.value).forEach(o => selAno.appendChild(o));
  }
}
function mudarAno(selAno, delta){
  const novo = parseInt(selAno.value) + delta;
  garantirOpcaoAno(selAno, novo);
  selAno.value = novo;
}
function envolverComSetas(sel, aoClicar){
  if(!sel || sel.dataset.setas) return;
  sel.dataset.setas = '1';
  const caixa = document.createElement('span');
  caixa.className = 'mes-nav';
  if(sel.style.flex){ caixa.style.flex = sel.style.flex; sel.style.flex = '1'; }
  sel.parentNode.insertBefore(caixa, sel);
  const mk = (txt, delta, rotulo) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'seta-nav'; b.textContent = txt; b.title = rotulo; b.setAttribute('aria-label', rotulo);
    b.addEventListener('click', ()=>{ aoClicar(delta); sel.dispatchEvent(new Event('change', { bubbles:true })); });
    return b;
  };
  caixa.append(mk('‹', -1, 'Anterior'), sel, mk('›', 1, 'Próximo'));
}
function instalarSetasMesAno(idMes, idAno){
  const selMes = $(idMes), selAno = $(idAno);
  if(selMes){
    envolverComSetas(selMes, (delta)=>{
      let i = selMes.selectedIndex + delta;
      if(i < 0){ i = 11; mudarAno(selAno, -1); }
      else if(i > 11){ i = 0; mudarAno(selAno, 1); }
      selMes.selectedIndex = i;
    });
  }
  instalarSetasAno(idAno);
}
function instalarSetasAno(idAno){
  const selAno = $(idAno);
  envolverComSetas(selAno, (delta)=> mudarAno(selAno, delta));
}
// Os eventos "change" disparados pelas setas passam pelos mesmos ouvintes
// das listas, então cada tela recarrega sozinha.
[['painelMes','painelAno'],['lancMes','lancAno'],['relMes','relAno'],['compMes','compAno'],
 ['finExtMes','finExtAno'],['finConcMes','finConcAno'],['lFormCompMes','lFormCompAno']]
  .forEach(([m,y]) => instalarSetasMesAno(m, y));
['relAnoAnual','finSaldosAno'].forEach(instalarSetasAno);


// ---------- Agendas semanais (módulo separado em agendas.js) ----------
iniciarAgendas({
  db, state, toast, comCarregando, temAcesso, podeEditarAba, normalizarTexto, ordenarPorNome,
  dataLocalISO, validarObrigatorios, switchView,
});
