# SOFT+ Financeiro de Igrejas

App multi-igreja de controle financeiro, com Firebase (Auth + Firestore) como backend
e hospedagem estática no GitHub Pages.

## Arquivos
- `index.html` — telas do app
- `app.js` — toda a lógica (login, Firestore, telas)
- `firebase-config.js` — chaves do seu projeto Firebase (já preenchido)
- `firestore.rules` — regras de segurança (copiar para o Console do Firebase)

## 1. Colocar as regras de segurança no ar
As regras controlam quem pode ler/escrever cada dado (isso é o que garante que
uma igreja não veja os dados da outra).

1. Vá em **console.firebase.google.com** → seu projeto → **Firestore Database** → aba **Regras**
2. Apague o conteúdo padrão e cole o conteúdo do arquivo `firestore.rules`
3. Clique em **Publicar**

## 2. Publicar no GitHub Pages
1. Crie um repositório novo no GitHub (pode ser privado ou público)
2. Suba os 4 arquivos (`index.html`, `app.js`, `firebase-config.js`, e opcionalmente
   o `firestore.rules` só como referência)
3. Vá em **Settings → Pages** do repositório
4. Em "Source", selecione a branch `main` e pasta `/ (root)`
5. Salve — em 1–2 minutos seu app estará em algo como
   `https://seu-usuario.github.io/nome-do-repo/`

⚠️ No Firebase, vá em **Authentication → Settings → Domínios autorizados** e
adicione `seu-usuario.github.io` (senão o login vai falhar por segurança).

## 3. Primeiro acesso
1. Abra o link do GitHub Pages
2. Clique em **"Criar conta"**, informe seu nome, e-mail e senha
3. Você cai direto na tela **"+ Nova Igreja"** — cadastre a primeira igreja
4. Pronto: você já é **Administrador** dela. As categorias de Dízimo, Oferta
   de Culto, Oferta Avulsa (receitas) e Prebenda Pastoral, Contas de Consumo,
   Manutenção (despesas) já vêm criadas — edite/apague como quiser em
   **Categorias e Grupos**.

## 4. Adicionando outras igrejas e usuários
- Qualquer usuário logado pode criar uma nova igreja pelo menu **"+ Nova Igreja"**
  (ele vira admin dela).
- Para dar acesso a outra pessoa numa igreja que você administra: vá em
  **Usuários → Convidar usuário**, informe o e-mail dela e o papel
  (Administrador / Cadastrador / Leitura). Quando essa pessoa criar conta (ou
  entrar, se já tiver conta) usando **esse mesmo e-mail**, o acesso é liberado
  automaticamente.
- Um mesmo usuário pode ter papéis diferentes em igrejas diferentes — o troca-igreja
  fica no topo do menu lateral.

## 5. Sobre os índices do Firestore
As consultas de "em quais igrejas eu estou" e "convite pendente pra mim"
usam coleções simples de nível raiz (`membrosIndice`, `convitesIndice`) — o
Firestore cria o índice automaticamente, sem passo manual.

Já a paginação de **Fiéis** e **Lançamentos**, o **Painel** e o **fluxo de
caixa** usam consultas um pouco mais elaboradas (filtro + ordenação, ou
soma agregada) para não precisar baixar listas inteiras. Na primeira vez
que você usar essas telas, pode aparecer no console do navegador um aviso
pedindo para criar um índice, com um link direto do Firebase — é só clicar,
confirmar, esperar cerca de 1 minuto e recarregar a página (mesmo processo
que já fizemos antes). Se algum índice desses ainda não existir, o app
automaticamente busca os dados do jeito antigo (mais lento, mas funciona)
até você criar o índice.

## 6. Exportar dados
- Na tela **Lançamentos**, o botão **"Exportar"** baixa um `.xlsx` com os
  lançamentos do mês/tipo filtrado no momento.
- Na tela **Fiéis**, o botão **"Exportar"** baixa um `.xlsx` com todos os
  fiéis cadastrados.

## 7. Importar a planilha antiga do AppSheet
Na tela **"Importar dados"** (menu lateral, só aparece para Administradores):

0. Se quiser preencher os dados na mão (em vez de usar um export real do
   AppSheet), clique em **"⬇ Baixar modelo de planilha"** — ele já vem com
   todas as abas, cabeçalhos certos, uma aba de **Instruções** explicando como
   os IDs conectam uma aba na outra (ex: qual fiel fez qual lançamento), e uma
   linha de exemplo em cada aba mostrando o preenchimento correto.
1. Escolha primeiro, no topo do menu, a igreja para a qual quer importar
2. Selecione o arquivo `.xlsx` original do AppSheet (mesmas abas: `cad_fieis`,
   `cad_grupo`, `cad_carg_func`, `cad_receitas`, `cad_despesas`, `cad_igreja`,
   `lanc_receita`, `lanc_despesa`, `bloq_competencia`)
3. Clique em **"Iniciar importação"** e acompanhe o log na tela

O que é migrado automaticamente: grupos, cargos, fiéis (com grupo/cargo já
vinculados), categorias de receita e despesa, dados cadastrais da igreja,
todos os lançamentos de receita e despesa (com categoria e fiel vinculados,
quando existirem) e os meses que já estavam bloqueados.

**Não é migrado**: comprovantes/fotos anexados (já que essa versão não usa
anexos) e o módulo de Campanhas (fica de fora por enquanto, como combinamos).

⚠️ Rode a importação **uma vez só** por igreja — rodar de novo duplica os
dados, porque cada execução cria registros novos. Se precisar refazer,
apague os lançamentos importados antes (dá pra reconhecer pelo campo interno
`importado: true` no Firestore).

## Papéis e permissões por aba
Cada usuário tem um **papel** (o que ele pode fazer) e uma lista de **abas
liberadas** (o que ele consegue ver/acessar), configurados na hora do convite
ou depois em Usuários → Editar.

**Papéis:**
- **Administrador** — acesso total: edita dados da igreja, usuários, bloqueia
  competências, lança e exclui tudo, em qualquer aba
- **Cadastrador** — lança e edita dentro das abas que tiver liberadas
- **Leitura** — só visualiza as abas liberadas, não edita nada

**Abas configuráveis por usuário:** Lançamentos, Fiéis, Categorias e Grupos,
Relatórios, Competências. Painel e Dados da Igreja (visualização) ficam
sempre visíveis para qualquer membro; Usuários e Importar dados são sempre
exclusivos de Administrador, independente da configuração.

⚠️ Relatórios usa os dados de Lançamentos — se liberar "Relatórios" pra
alguém, libere "Lançamentos" também, senão a tela fica vazia. O mesmo vale
para o formulário de lançamento vincular um fiel: sem a aba "Fiéis", esse
campo fica sem opções (mas ainda dá pra lançar sem vincular a ninguém).

Contas criadas antes dessa atualização continuam com acesso total até que um
admin ajuste as permissões delas em Usuários → Editar.

## Busca de fiéis sem diferenciar maiúscula/acento
Agora buscar "kennedy" encontra "Kennedy", "joao" encontra "João", etc.

⚠️ **Passo único e obrigatório após essa atualização**: como os fiéis
cadastrados antes dessa mudança não têm o campo novo usado pra isso, a tela
de **Fiéis** pode aparecer vazia (ou faltando gente) até você corrigir uma
vez. Vá em **Fiéis** → botão **"Corrigir busca de fiéis antigos"** (só
aparece para Administradores) → clique uma vez → pronto, não precisa
repetir depois. Fiéis novos já são salvos certinho automaticamente.

## Competência independente da data
Cada lançamento agora tem dois campos de tempo separados:
- **Data** — quando o pagamento foi de fato feito/recebido (usada para
  ordenar e exibir nas tabelas e PDFs)
- **Competência** — a que mês/ano o lançamento se refere (usada para
  filtros, painel, relatórios e bloqueio de competência)

Por padrão, a competência acompanha a data escolhida — mas dá pra mudar
manualmente, por exemplo quando um dízimo de junho é pago só em julho.

## Banner próprio de "Instalar app"
O Chrome, sozinho, só oferece a instalação escondida num menu (ícone
discreto na barra de endereço, ou dentro do menu ⋮ no celular) — a maioria
das pessoas nunca percebe que dá pra instalar. Agora, quando o navegador
sinaliza que o app pode ser instalado, aparece um banner no canto da tela
com **"Instalar o SOFT+"** e um botão — bem mais visível.

- Se a pessoa clicar em **"Instalar"**, abre a caixa de confirmação nativa
  do próprio navegador
- Se clicar no **"×"** (fechar), o banner não aparece mais pra ela
  (fica guardado no navegador dela, não incomoda de novo)
- Se o app já estiver instalado, o banner nunca aparece

⚠️ No **iPhone/iPad (Safari)**, esse banner não aparece — a Apple não deixa
navegadores acionarem esse convite automaticamente lá. Nesses aparelhos, a
instalação continua sendo manual: Compartilhar → "Adicionar à Tela de
Início". Posso adicionar uma dica na tela pra usuários de iPhone se
for importante pro seu público.

## Atalho de "Novo lançamento" no Painel
Botão **"+ Novo lançamento"** direto no Painel, pra não precisar ir até a
aba de Lançamentos só pra lançar algo rápido. Abre o mesmo formulário de
sempre — e, ao salvar, o app já leva direto pra aba de Lançamentos (pra
conferir/continuar lançando por lá). Só aparece pra quem tem permissão de
editar Lançamentos (Leitura não vê o botão).

## Correção: data de hoje errada à noite (bug de fuso horário)
O preenchimento automático de "hoje" nos formulários (Lançamento, Campanha)
usava um método que converte a data pra UTC antes de formatar. Como o
Brasil fica atrás do UTC, isso fazia o app "pular" pro dia seguinte à
noite (a partir de mais ou menos 21h, dependendo do fuso). Corrigido —
agora usa sempre a data local do aparelho, sem essa conversão. Não mexi na
importação de planilha, que já estava correta (lida com datas digitadas no
Excel, não com "agora").

## Botão fixo de instalar (em vez de banner por tempo)
Achei o motivo real do banner nunca aparecer: faltava um `id` num elemento
de HTML que o JavaScript tentava atualizar — isso quebrava a função
silenciosamente toda vez que era chamada. Corrigido.

Além disso, troquei a abordagem: em vez de depender de um banner que só
aparece se o navegador cooperar (ou depois de um tempo), agora tem um
**botão fixo "📲 Instalar app"**, sempre visível:
- Na tela de **login**, logo abaixo do card
- Dentro do app, no **rodapé do menu lateral**, acima do "Sair"

Clicando: usa a instalação nativa do navegador se ela estiver disponível,
ou mostra o passo a passo manual (diferente pra iPhone e Android/desktop)
se não estiver. O botão some sozinho se o app já estiver instalado.

## Correções: menu não rolava no celular, e banner de instalar
Achei o motivo real do botão "Sair" sumir no celular: o menu lateral
cresceu bastante (Painel, Lançamentos, Fiéis, Categorias, Relatórios,
Competências, Campanhas, Igreja, Usuários, Importar...) e, no celular, ele
não tinha rolagem — o conteúdo que não cabia na tela ficava simplesmente
invisível, sem como chegar até o "Sair" lá embaixo. Corrigido: agora o menu
rola normalmente quando tem mais itens do que cabe na tela.

Também troquei o banner de "Instalar app": antes, fechar com o "×"
escondia ele **para sempre** (fica guardado permanentemente no navegador).
Agora esconder é só **pra aquela visita** — da próxima vez que abrir o app,
ele aparece de novo (a não ser que o app já esteja instalado). Além disso,
se o navegador não avisar automaticamente que dá pra instalar (acontece
bastante no Android por regras internas do Chrome, e sempre no iPhone),
depois de alguns segundos aparece um aviso com o passo a passo manual —
assim ninguém fica sem saber que existe essa opção, em nenhum aparelho.

## Ícones no menu lateral
Trocado as bolinhas por ícones específicos de cada aba (Painel, Lançamentos,
Fiéis, Categorias, Relatórios, Competências, Campanhas, Igreja, Usuários,
Importar, Nova Igreja) — mais fácil de reconhecer rapidamente cada seção.

## Logo oficial do SOFT+
Troquei o "S+" genérico que eu tinha desenhado (só um placeholder) pela
logo de verdade que vocês me mandaram — aparece agora na tela de login, no
topo do menu lateral, no menu mobile, no ícone do app instalado (PWA) e no
favicon da aba do navegador.

Arquivos novos: `logo-horizontal.png`, `logo-simbolo.png`, e os três
`icon-*.png` foram **substituídos** (mesmo nome de antes, conteúdo novo).

## Ordem alfabética nas listas de cadastro
Passou a ser padrão em todo o app: **Categorias de Receita/Despesa,
Grupos, Cargos** (tanto na tela de Categorias e Grupos quanto nos selects
que usam essas listas em outros formulários — Lançamento, filtro de
Lançamentos, cadastro de Fiel), além de **Usuários**, **Convites
pendentes** e **Campanhas**.

Duas listas ficaram de fora de propósito, porque ordenar alfabeticamente
as deixaria menos úteis:
- **Lançamentos** (tabela) e "Últimos lançamentos" do Painel — continuam
  por data, já que são histórico/atividade recente
- **Receitas/Despesas por categoria** nos Relatórios — continua por valor
  (do maior pro menor), pra facilitar ver o que mais pesa no caixa

Se quiser que algum desses dois também vire alfabético, é só pedir.

## Exportar/Importar em Campanhas
- **Exportar lista** (tela Campanhas): planilha com todas as campanhas —
  nome, tipo, status, responsável, datas, meta, total arrecadado/gasto e saldo
- **Exportar** (dentro de uma campanha): planilha com os lançamentos
  daquela campanha específica
- **Importar planilha** (dentro de uma campanha, só Admin, só com a
  campanha ativa): clique em **"Baixar modelo de planilha"** pra pegar o
  arquivo certo (com aba de instruções), preencha, e envie de volta em
  "Importar planilha". Os lançamentos entram direto na campanha que
  estiver aberta. Se preencher "Nome do Fiel", o app tenta achar
  automaticamente um fiel já cadastrado com esse nome (sem diferenciar
  acento/maiúscula); se não achar, guarda só o nome digitado, sem vínculo.

## Módulo de Campanhas (novo!)
Nova aba **Campanhas**, 100% separada da tesouraria geral (não entra no
saldo anterior nem nos relatórios da igreja — como combinamos).

**Lista de campanhas**: cards com nome, tipo (Arrecadação / Venda de algo /
Compra coletiva / Outro), status (Ativa/Encerrada), responsável, e barra de
progresso quando tem meta financeira definida. Filtro por status.

**Dentro de uma campanha**: totais de entrada/saída/saldo, barra de
progresso da meta, lançamentos com Tipo, Categoria (texto livre — "Doação",
"Venda de rifa nº 12", "Material de construção"...), Data, Valor,
Descrição e Fiel (opcional, com a mesma busca inteligente de sempre).

**Encerrar campanha**: trava novos lançamentos (igual o bloqueio de
competência) — dá pra reabrir se precisar. Só Admin/Cadastrador com acesso
à aba Campanhas conseguem encerrar/reabrir.

**Exportar PDF**: relação de entradas (ordem alfabética por fiel) + relação
de saídas (por data) + totais + saldo final + assinatura de Pastor/Tesoureiro
— mesmo estilo dos outros relatórios.

**Excluir campanha**: só é permitido se ela ainda não tiver nenhum
lançamento (evita perder histórico por engano).

**Permissões**: "Campanhas" entrou na lista de abas configuráveis por
usuário (Usuários → Cadastrar/Editar) — dá pra liberar só pra quem
realmente cuida dos projetos da igreja, sem dar acesso à tesouraria geral.

## Limpeza de usuários removidos, senha esquecida, e nome da igreja sempre atualizado

**Exclusão de usuário mais completa**: ao remover o acesso de alguém, o app
agora também apaga o registro de perfil (nome/e-mail) que ficava
"escondido" depois que a pessoa perdia acesso a todas as igrejas. Uma
ressalva honesta: isso **não** apaga a conta de login da pessoa no
Firebase — tecnicamente, ela ainda existiria (e-mail/senha), mas sem
nenhum acesso a nenhuma igreja, o que na prática equivale a não ter conta
nenhuma. Apagar a conta de login de verdade exigiria um servidor próprio
(Cloud Function do Firebase), que este app não usa hoje — posso implementar
se um dia isso for importante (envolve ativar o plano pago do Firebase,
sem custo real dentro do uso esperado, mas com cartão cadastrado).

**"Esqueci minha senha"**: novo link na tela de login. A pessoa informa o
e-mail e recebe uma mensagem de redefinição — mesmo mecanismo já usado em
"Editar usuário", só que agora acessível pra quem nem consegue entrar.

**Nome da igreja sempre atualizado pra todo mundo**: em vez de "copiar" o
nome da igreja pra cada usuário e depender de alguém atualizar essa cópia,
o app agora busca o nome **direto e na hora** sempre que alguém entra —
então qualquer alteração feita por um admin já aparece certa pra todos os
outros usuários, sem esperar nada.

## Revisão: quebra de página automática nos PDFs
Conferi os três relatórios em PDF (mensal, anual, do fiel). As tabelas em si
(receitas, ofertas, despesas, extrato) já pulavam de página sozinhas
quando não cabiam mais — isso é automático da biblioteca de tabelas. O que
**não** tinha essa proteção eram os elementos desenhados à parte: as
barras de título/total coloridas e o bloco de assinatura. Corrigido: agora,
antes de desenhar qualquer um desses elementos, o app verifica se ainda
sobra espaço na página atual e, se não sobrar, pula pra próxima
automaticamente (recriando o cabeçalho do relatório, pra nenhuma página
ficar "solta" sem contexto). Vale pros três relatórios — inclusive o
extrato por fiel, que é o que mais cresce com o tempo (histórico de anos).

## App instalável no Android (PWA)
O app agora pode ser **instalado** no celular como se fosse um app de
verdade — ícone próprio na tela inicial, abre em tela cheia (sem barra do
navegador), funciona bem em conexão fraca.

**Arquivos novos que precisam ir pro GitHub** (mesma pasta dos outros):
`manifest.json`, `sw.js`, `icon-192.png`, `icon-512.png`, `icon-512-maskable.png`

**Como instalar no Android:**
1. Abra o link do app no **Chrome** do celular
2. Vai aparecer um banner "Adicionar à tela inicial" (ou toque no menu ⋮
   → "Instalar app" / "Adicionar à tela inicial")
3. Pronto — abre um ícone próprio, como qualquer outro app

**Como funcionam as atualizações:** toda vez que você atualizar os arquivos
no GitHub, na próxima vez que alguém abrir o app **com internet**, ele
busca a versão mais nova sozinho — não precisa desinstalar nem reinstalar
nada. Só em caso de estar completamente offline é que ele mostra a última
versão que tinha guardado.

**Ícone**: gerei um ícone simples com "S+" na cor azul do app como ponto de
partida. Se quiser trocar por um de verdade (com a logo da sua igreja ou
outra arte), é só substituir os três arquivos `icon-*.png` por imagens do
mesmo tamanho (192x192 e 512x512 pixels, formato PNG).

## Lote de ajustes (ordenação, bloqueio, senha, exclusão)

**Ordenação e alinhamento**
- Relatório mensal: lançamentos de receita (dízimos e ofertas) em ordem
  alfabética pelo nome do fiel; despesas continuam por data
- Valores monetários alinhados à direita em todos os relatórios em PDF e
  também nas telas do app (tabelas, painel, listas)

**Bloqueio de competência — bug corrigido**
Antes, bloquear um mês só impedia *criar* lançamento novo — editar ou
excluir um lançamento já existente continuava funcionando normalmente
mesmo com o mês bloqueado (e a regra de segurança do Firestore checava um
campo que nunca era preenchido de verdade). Corrigido dos dois lados
(app e regras): agora editar e excluir também são bloqueados enquanto a
competência estiver fechada — inclusive tentando mover um lançamento para
dentro de um mês bloqueado.
⚠️ Assim como o "saldo anterior", isso depende do campo `competenciaKey`
em cada lançamento — use o botão "Corrigir lançamentos antigos" (tela
Competências) se ainda não tiver rodado essa correção.

**Relatório por fiel — filtro por período**
Agora tem campos "De" / "Até" (datas), consolidando o período inteiro
mesmo que passe de um ano — independente do mês selecionado nos outros
cartões da tela. Deixando em branco, mostra o histórico completo.

**Login e senhas**
- "Criar conta" foi removida da tela de login — cadastro agora é sempre
  feito pelo administrador (Usuários → Cadastrar usuário). Se um dia
  precisar criar a primeiríssima conta de uma instalação nova do zero,
  abra `index.html?primeiraconta=1` pra reativar temporariamente essa opção.
- Ao cadastrar um usuário novo, dá pra marcar **"Pedir para a pessoa
  trocar a senha no primeiro acesso"** — na primeira vez que ela entrar,
  o app pede pra ela escolher uma senha nova antes de liberar qualquer tela.
- Em "Editar usuário": agora dá pra editar o nome, marcar/desmarcar a
  troca de senha obrigatória, e (pra contas que já existem) enviar um
  e-mail de redefinição de senha pela própria pessoa escolher uma nova.
  Não é possível definir a senha de outra pessoa diretamente por aqui —
  é uma limitação real do Firebase sem um servidor próprio por trás; o
  e-mail de redefinição é o caminho seguro que existe sem precisar disso.

**Proteção contra exclusão indevida**
Não deixa mais excluir: um **fiel** vinculado a algum lançamento, uma
**categoria** de receita/despesa usada em algum lançamento, ou um
**grupo/cargo** vinculado a algum fiel. Aparece um aviso explicando o
motivo em vez de excluir e deixar dado "orfão" no sistema. (Essa proteção
é feita pelo app — é proteção de integridade dos dados, não uma regra de
segurança do Firestore, que não consegue fazer esse tipo de verificação.)

## Correção: saldo anterior inconsistente com a Competência
Havia um bug real: "Saldo anterior" era calculado pela **Data** do
lançamento, enquanto o resto do app (totais do mês, relatórios) usa a
**Competência**. Como esses dois campos podem ser diferentes (ex: pago em
fevereiro, referente a janeiro), os números não batiam entre telas.
Corrigido — agora tudo usa Competência, sem exceção.

⚠️ **Passo único**: como lançamentos criados antes dessa correção não têm o
campo novo necessário, vá em **Competências** → botão **"Corrigir
lançamentos antigos"** (só aparece para Administradores) → clique uma vez.
Lançamentos novos já são salvos certinho automaticamente.

## Filtros de Lançamentos
A tela de Lançamentos agora filtra por **Competência** (mês/ano), **Tipo**
(receita/despesa), **Categoria** e **Fiel** — todos combináveis ao mesmo
tempo. O botão "Exportar" respeita os mesmos filtros ativos na tela. Um
botão **"Limpar filtros"** volta tudo pro mês atual, sem nenhum filtro extra.

## Revisão de campos entre formulários, importação e exportação
Conferência completa pra garantir que nada fica "escondido" numa importação:
- Adicionado o campo **RG** ao formulário de Fiéis e à exportação em Excel
  (a planilha antiga já trazia esse dado, mas o app não tinha onde mostrar)
- A importação agora vincula **Pastor e Tesoureiro ao cadastro do fiel de
  verdade** (antes só trazia o nome como texto solto, sem o vínculo que
  alimenta a assinatura automática dos PDFs)
- Nova coluna opcional **"Nome para Relatório"** na aba `cad_igreja` do
  modelo — se não preencher, o app usa o mesmo nome do campo "Igreja"
- A logo da igreja não é importável por planilha (é imagem) — segue sendo
  enviada manualmente em Dados da Igreja, depois da importação

**Sobre o ID da planilha**: pode ser qualquer texto ou número, desde que o
mesmo valor seja usado nas duas pontas (ex: o ID do fiel em `cad_fieis`
precisa ser idêntico ao valor usado em "Nome do Fiel" de `lanc_receita`).
Recomendação: formate a coluna ID como **Texto** no Excel, para não perder
zeros à esquerda se usar IDs numéricos.

## Cadastro direto de usuário (sem e-mail)
O app nunca chegou a enviar e-mails de verdade — o antigo "convite" só
liberava o acesso quando a pessoa entrava com aquele e-mail específico, o
que confundia. Agora, em **Usuários → "+ Cadastrar usuário"**, o
administrador:
1. Digita nome, e-mail e uma senha temporária (tem um botão "Gerar" pra
   sugerir uma)
2. Escolhe papel e abas
3. Clica em Cadastrar — a conta já é criada e o acesso já libera na hora
4. Passa o e-mail e a senha pra pessoa (WhatsApp, papel, o que for) — ela
   entra direto, sem precisar "criar conta"

Se o e-mail digitado já tiver uma conta própria no app (de outra igreja, por
exemplo), o sistema detecta isso automaticamente e cai de volta no modelo de
convite antigo (a pessoa entra com a conta que já tem, e o acesso libera
sozinho) — nesse caso específico ainda não tem como o admin definir a senha
dela, já que a conta já existe.

## Totais e saldo anterior
- **Lançamentos**: agora mostra o total de receitas, despesas e saldo do
  período filtrado, acima da tabela
- **Painel**: mostra também o saldo anterior (tudo antes do mês selecionado)
  e o saldo atual acumulado
- **Fluxo de caixa anual** (tela e PDF): ganhou uma coluna de saldo
  anterior mês a mês

## Personalizar com a logo da igreja
Em Dados da Igreja, o admin pode enviar uma imagem (PNG/JPG) que é
redimensionada automaticamente no navegador e aparece no topo do menu
lateral e no cabeçalho dos PDFs. Como decidimos não usar o Firebase Storage
(que exige plano pago), a logo fica guardada como texto (base64) dentro do
próprio documento da igreja no Firestore — funciona bem para logos simples,
mas não é indicado para fotos grandes ou de altíssima resolução.

Também em Dados da Igreja:
- **Nome para cabeçalho dos relatórios** — o nome que aparece no topo dos
  PDFs pode ser diferente do "Nome da igreja" usado no menu (útil para um
  nome mais formal, com sigla da denominação, etc.)
- **Pastor** e **Tesoureiro** — agora são escolhidos buscando entre os
  fiéis já cadastrados (em vez de texto livre), e os nomes escolhidos
  aparecem automaticamente como assinatura no rodapé de todo relatório em
  PDF

## Exportar relatórios em PDF
Na tela Relatórios:
- **PDF do mês** — no formato "relatório de tesouraria de igreja": relação
  de dizimistas (separada de ofertas), totais, relação de despesas, balanço
  final (com saldo anterior calculado automaticamente a partir do
  histórico) e assinatura de Pastor/Tesoureiro
- **PDF do ano** — fluxo de caixa anual, mês a mês, com totais
- **PDF do fiel** — extrato completo de contribuições de um fiel específico

Uma categoria de receita entra em "Dízimos" se o nome dela contiver a
palavra "dízimo" (ex: "Dízimo", "Dízimos"); qualquer outra categoria de
receita entra em "Ofertas" automaticamente — não precisa configurar nada
além do nome da categoria.

## Preparado para crescer (paginação e agregação)
- **Fiéis**: a lista carrega 50 por vez ("Carregar mais"), com busca por
  nome — não baixa mais todo mundo de uma vez
- **Lançamentos**: a tabela também carrega 50 por vez dentro do mês/filtro
  escolhido
- **Painel**: os totais do mês são calculados por soma agregada direto no
  Firestore, sem baixar cada lançamento
- **Fluxo de caixa anual** (tela e PDF): também usa soma agregada por mês,
  em vez de baixar o ano inteiro de uma vez
- Os campos "Fiel" (no lançamento e nos relatórios) agora são de busca —
  digite o nome e escolha, em vez de rolar uma lista enorme
- Exportar Fiéis (XLSX) busca os dados na hora, com limite de 5.000 por vez

Com isso, o app aguenta tranquilamente milhares de fiéis e anos de histórico
de lançamentos sem ficar lento.

## Se você ficar sem nenhum Administrador (ficou travado)
Corrigimos um bug em que criar um convite para o **próprio e-mail** (ex: ao
testar a função de convite) podia rebaixar sua própria conta sem querer no
próximo login. Isso não deve mais acontecer (o app agora bloqueia convidar
seu próprio e-mail, bloqueia convidar quem já tem acesso, e nunca mais
sobrescreve um vínculo já existente).

Se isso já aconteceu com você antes dessa correção, conserte manualmente:
1. Console do Firebase → **Firestore Database** → aba **Dados**
2. Abra `igrejas` → clique na sua igreja → subcoleção `usuarios` → ache o
   documento com seu e-mail (o ID do documento é o seu UID) → mude o campo
   `papel` para `admin`
3. Ainda na raiz, abra a coleção `membrosIndice` → ache o documento cujo ID
   começa com o ID da sua igreja e termina com o seu UID → mude o campo
   `papel` para `admin` também
4. Saia do app e entre de novo

## Limitações desta primeira versão (dá pra evoluir depois)
- Sem upload de comprovantes/fotos nos lançamentos (decidimos deixar de fora
  por enquanto — mas a logo da igreja já funciona, como descrito acima)
- Sem módulo de Campanhas (fica para uma fase 2)
- Remover o acesso de um usuário não cancela a conta dele, só o vínculo com
  aquela igreja
- Não há recuperação de senha na tela (dá pra adicionar um botão "Esqueci
  minha senha" facilmente se precisar)
- Se um admin renomear a igreja, o nome que aparece no menu de troca de
  igreja de **outros** usuários só atualiza da próxima vez que eles renovarem
  o próprio vínculo (o dono da alteração já vê atualizado na hora). É um
  detalhe cosmético, não afeta os dados financeiros.
