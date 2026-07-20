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

## Personalizar com a logo da igreja
Em Dados da Igreja, o admin pode enviar uma imagem (PNG/JPG) que é
redimensionada automaticamente no navegador e aparece no topo do menu
lateral. Como decidimos não usar o Firebase Storage (que exige plano pago),
a logo fica guardada como texto (base64) dentro do próprio documento da
igreja no Firestore — funciona bem para logos simples, mas não é indicado
para fotos grandes ou de altíssima resolução.

## Exportar relatórios em PDF
Na tela Relatórios:
- **PDF do mês** — fluxo de caixa do mês selecionado, com receitas e despesas
  por categoria e o saldo
- **PDF do ano** — fluxo de caixa anual, mês a mês, com totais
- **PDF do fiel** — extrato completo de contribuições de um fiel específico
  (todos os lançamentos vinculados a ele, com total geral)

Todos os PDFs saem com o nome e a logo da igreja (se configurada) no
cabeçalho.

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
