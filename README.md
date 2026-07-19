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
Como o app usa "collection group queries" (para achar em quais igrejas um
usuário está, e resgatar convites por e-mail), a **primeira vez** que você usar
o app pode aparecer um erro no console do navegador com um link do tipo
`https://console.firebase.google.com/.../indexes?create_composite=...`.
Isso é normal: é só clicar nesse link, confirmar a criação do índice, esperar
1–2 minutos, e recarregar a página. Só precisa fazer isso uma vez.

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

## Papéis de usuário
- **Administrador** — acesso total: edita dados da igreja, usuários, bloqueia
  competências, lança e exclui tudo
- **Cadastrador** — lança e edita receitas/despesas e fiéis, mas não mexe em
  usuários nem em competências bloqueadas
- **Leitura** — só visualiza, não edita nada

## Limitações desta primeira versão (dá pra evoluir depois)
- Sem upload de comprovantes/fotos (decidimos deixar de fora por enquanto)
- Sem módulo de Campanhas (fica para uma fase 2)
- Remover o acesso de um usuário não cancela a conta dele, só o vínculo com
  aquela igreja
- Não há recuperação de senha na tela (dá pra adicionar um botão "Esqueci
  minha senha" facilmente se precisar)
