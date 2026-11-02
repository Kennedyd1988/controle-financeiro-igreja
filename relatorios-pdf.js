// Relatórios em PDF do SOFT+ Financeiro de Igrejas — visual único para todos.
//
// Este módulo NÃO conhece Firebase nem a tela: recebe os dados já prontos e
// devolve o objeto jsPDF (quem chama decide salvar). Por isso dá para testar
// em Node, com dados de exemplo, sem abrir o app.
//
// Decisões de design (por quê):
// - Paleta de baixa saturação (ardósia, sálvia, rosé fosco, dourado fosco):
//   o azul/vermelho vivos anteriores cansavam a leitura e saíam "gritando"
//   na impressão.
// - Visual Law: o essencial vem primeiro (cartões de indicadores + barras
//   comparativas), depois o detalhe. Cor tem sentido fixo: verde = entrada,
//   rosé = saída, ardósia = saldo/neutro.
// - Fluxo contínuo: nada é forçado a caber numa página. Se passar, quebra
//   sozinho, refaz o cabeçalho da igreja, repete o cabeçalho das tabelas e
//   numera as páginas. A assinatura aparece UMA vez, no final.
// - Cabeçalhos de tabela centralizados; valores alinhados à direita.

export const TEMA = {
  tinta:        [43, 51, 64],     // texto do corpo (cinza-azulado, não preto puro)
  mudo:         [100, 110, 125],  // rótulos e textos de apoio
  barraIgreja:  [62, 77, 102],    // barra com o nome da igreja
  barraPeriodo: [236, 239, 245],  // faixa do período
  faixaSecao:   [86, 102, 128],   // título de cada seção
  cabReceita:   [112, 130, 160],  // cabeçalho das tabelas de entrada
  cabDespesa:   [168, 118, 118],  // cabeçalho das tabelas de saída
  dourado:      [150, 124, 78],
  verde:        [110, 154, 126],  // entradas
  rose:         [176, 122, 122],  // saídas
  totalAzul:    [231, 236, 244],
  totalVerde:   [224, 235, 227],
  totalRosa:    [244, 230, 228],
  cartao:       [244, 246, 249],
  zebra:        [248, 249, 251],
  linha:        [217, 222, 230],
  negativo:     [150, 70, 70],
  positivo:     [70, 120, 90],
};
const T = TEMA;
const FIM_UTIL = 285;   // mm: coincide com a margem inferior (12 mm) das tabelas; a numeração fica abaixo, em 291

export const fmtBRL = (v) => (v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const dataBR = (iso) => { if(!iso) return ''; const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}`; };
const soma = (lista, campo) => lista.reduce((s, l) => s + (l[campo] || 0), 0);
const pct = (a, b) => (b > 0 ? (a / b * 100).toFixed(1).replace('.', ',') + '%' : '—');
const cortar = (t, n) => { t = String(t ?? ''); return t.length > n ? t.slice(0, n - 3) + '...' : t; };
const ehDizimo = (nome) => (nome || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().includes('dizimo');

// ---------------------------------------------------------------------------
// Construtor: devolve "R", um pequeno kit de desenho que controla a posição
// vertical (R.y) e a paginação.
// ---------------------------------------------------------------------------
function novoRelatorio(JsPDF, igreja, titulo){
  const pdf = new JsPDF();
  const R = { pdf, y: 40 };
  const paginasComCabecalho = new Set();
  const nomeBarra = (igreja.nomeRelatorio || igreja.nome || 'Igreja').toUpperCase();

  // Cabeçalho padrão (logo, nome do departamento, barra da igreja, barra do período).
  R.cabecalho = () => {
    paginasComCabecalho.add(pdf.getCurrentPageInfo().pageNumber);
    let x = 14;
    if(igreja.logo){
      try{ pdf.addImage(igreja.logo, 'JPEG', 14, 6, 16, 16); x = 34; } catch(e){ /* segue sem logo */ }
    }
    pdf.setFontSize(11); pdf.setFont(undefined, 'bold'); pdf.setTextColor(...T.barraIgreja);
    pdf.text('RELATÓRIO FINANCEIRO DA IGREJA', x, 12);
    pdf.setFontSize(8); pdf.setFont(undefined, 'normal'); pdf.setTextColor(...T.dourado);
    pdf.text('Departamento de Tesouraria', x, 17);
    pdf.setFillColor(...T.barraIgreja); pdf.rect(14, 24, 182, 6.5, 'F');
    pdf.setTextColor(255); pdf.setFontSize(9.5); pdf.setFont(undefined, 'bold');
    pdf.text(nomeBarra, 105, 28.6, { align: 'center' });
    pdf.setFillColor(...T.barraPeriodo); pdf.rect(14, 31, 182, 6, 'F');
    pdf.setFontSize(9); pdf.setTextColor(...T.barraIgreja);
    pdf.text(titulo, 105, 35.3, { align: 'center' });
    pdf.setTextColor(...T.tinta); pdf.setFont(undefined, 'normal');
    R.y = 40;
    return 40;
  };
  R.novaPagina = () => { pdf.addPage(); return R.cabecalho(); };
  // Garante "h" mm livres; senão abre página nova (já com cabeçalho).
  R.garantir = (h) => { if(R.y + h > FIM_UTIL) R.novaPagina(); return R.y; };

  R.legenda = (texto) => {
    pdf.setFontSize(8); pdf.setTextColor(...T.mudo); pdf.text(texto, 14, R.y + 3);
    pdf.setTextColor(...T.tinta); R.y += 6;
  };

  // Título de seção. "reserva" evita deixar o título sozinho no pé da página.
  R.faixa = (texto, reserva = 24) => {
    R.garantir(reserva);
    pdf.setFillColor(...T.faixaSecao); pdf.rect(14, R.y, 182, 6, 'F');
    pdf.setTextColor(255); pdf.setFontSize(9); pdf.setFont(undefined, 'bold');
    pdf.text(texto, 105, R.y + 4.3, { align: 'center' });
    pdf.setTextColor(...T.tinta); pdf.setFont(undefined, 'normal');
    R.y += 6;
  };
  R.total = (texto, valor, cor) => {
    R.garantir(8.5);
    pdf.setFillColor(...cor); pdf.rect(14, R.y, 182, 6, 'F');
    pdf.setFontSize(9); pdf.setFont(undefined, 'bold'); pdf.setTextColor(...T.tinta);
    pdf.text(texto, 18, R.y + 4.3); pdf.text(fmtBRL(valor), 192, R.y + 4.3, { align: 'right' });
    pdf.setFont(undefined, 'normal');
    R.y += 8.5;
  };

  // Tabela com paginação contínua: repete o cabeçalho da tabela e redesenha o
  // cabeçalho da igreja em cada página nova (margin.top = 40 reserva o espaço).
  R.tabela = ({ head, body, cab, fonte = 6.5, pad = 0.85, colunas = {}, esq = 14, dir = 14, aoParsear, soDesenhar, semZebra }) => {
    pdf.autoTable({
      startY: R.y, head: head ? [head] : undefined, body, theme: 'grid',
      styles: { fontSize: fonte, cellPadding: pad, textColor: T.tinta, lineColor: T.linha, lineWidth: 0.15 },
      alternateRowStyles: semZebra ? {} : { fillColor: T.zebra },
      headStyles: { fillColor: cab, textColor: 255, fontStyle: 'bold', fontSize: fonte, halign: 'center' },
      columnStyles: colunas,
      margin: { top: 40, bottom: 12, left: esq, right: dir },
      didParseCell: aoParsear,
      // d.pageNumber do autoTable é relativo à tabela (começa em 1 mesmo que ela
      // comece na página 2); por isso a página real vem do próprio jsPDF.
      didDrawPage: () => { if(!paginasComCabecalho.has(pdf.getCurrentPageInfo().pageNumber)) R.cabecalho(); },
    });
    const fim = pdf.lastAutoTable.finalY;
    if(!soDesenhar) R.y = fim + 2;
    return fim;
  };

  // Resumo visual: cartões de indicadores + barras proporcionais.
  // cartoes: [{ rot, val, sub, cor, corVal }]   barras: [{ rot, valor, cor, texto }]
  R.resumo = ({ cartoes, barras = [] }) => {
    R.garantir(16 + 3.5 + barras.length * 5 + 4);
    const y = R.y, n = cartoes.length, folga = 4, larg = (182 - folga * (n - 1)) / n;
    cartoes.forEach((c, i) => {
      const x = 14 + i * (larg + folga);
      pdf.setFillColor(...T.cartao); pdf.rect(x, y, larg, 16, 'F');
      pdf.setFillColor(...c.cor);    pdf.rect(x, y, 1.6, 16, 'F');
      pdf.setFont(undefined, 'normal'); pdf.setFontSize(6.8); pdf.setTextColor(...T.mudo);
      pdf.text(cortar(c.rot, n > 3 ? 30 : 40), x + 5, y + 4.6);
      pdf.setFont(undefined, 'bold'); pdf.setFontSize(n > 3 ? 11.5 : 12.5); pdf.setTextColor(...(c.corVal || T.tinta));
      pdf.text(c.val, x + 5, y + 10.4);
      pdf.setFont(undefined, 'normal'); pdf.setFontSize(6.2); pdf.setTextColor(...T.mudo);
      if(c.sub) pdf.text(cortar(c.sub, n > 3 ? 36 : 52), x + 5, y + 14);
    });
    const y2 = y + 19.5, max = Math.max(...barras.map(b => b.valor), 0.01), W = 110;
    barras.forEach((b, i) => {
      const yy = y2 + i * 5, w = Math.max(W * b.valor / max, 0.8);
      pdf.setFont(undefined, 'normal'); pdf.setFontSize(6.8); pdf.setTextColor(...T.mudo);
      pdf.text(cortar(b.rot, 24), 14, yy + 2.4);
      pdf.setFillColor(...b.cor); pdf.rect(46, yy, w, 3, 'F');
      pdf.setFont(undefined, 'bold'); pdf.setTextColor(...T.tinta);
      pdf.text(b.texto || fmtBRL(b.valor), 46 + w + 2, yy + 2.4);
    });
    pdf.setFont(undefined, 'normal');
    R.y = y2 + barras.length * 5 + 2.5;
  };

  // Gráfico de colunas agrupadas por mês (relatório anual).
  R.graficoMensal = ({ meses, corA, corB, legA, legB }) => {
    R.garantir(46);
    const y0 = R.y, base = y0 + 34, altMax = 26, slot = 182 / meses.length, larg = 4.6;
    const max = Math.max(...meses.map(m => Math.max(m.a, m.b)), 0.01);
    pdf.setFontSize(6.8); pdf.setTextColor(...T.mudo);
    pdf.setFillColor(...corA); pdf.rect(14, y0 + 1, 3, 3, 'F'); pdf.text(legA, 18.5, y0 + 3.4);
    pdf.setFillColor(...corB); pdf.rect(48, y0 + 1, 3, 3, 'F'); pdf.text(legB, 52.5, y0 + 3.4);
    pdf.setDrawColor(...T.linha); pdf.setLineWidth(0.2); pdf.line(14, base, 196, base);
    meses.forEach((m, i) => {
      const x = 14 + i * slot + (slot - 2 * larg - 0.8) / 2;
      const ha = altMax * m.a / max, hb = altMax * m.b / max;
      pdf.setFillColor(...corA); if(ha > 0) pdf.rect(x, base - ha, larg, ha, 'F');
      pdf.setFillColor(...corB); if(hb > 0) pdf.rect(x + larg + 0.8, base - hb, larg, hb, 'F');
      pdf.setFontSize(6.2); pdf.setTextColor(...T.mudo);
      pdf.text(m.rot, 14 + i * slot + slot / 2, base + 4, { align: 'center' });
    });
    pdf.setTextColor(...T.tinta);
    R.y = y0 + 40;
  };

  // Assinaturas: uma única vez, no final do relatório.
  R.assinaturas = () => {
    R.garantir(16);   // linha em y+6, nome em y+10,5 e cargo em y+15
    const y = R.y + 6;
    pdf.setFontSize(8.5); pdf.setDrawColor(...T.tinta); pdf.setLineWidth(0.2); pdf.setTextColor(...T.tinta);
    pdf.line(30, y, 90, y); pdf.line(120, y, 180, y);
    pdf.text(igreja.pastor || '—', 60, y + 4.5, { align: 'center' });
    pdf.text('Pastor', 60, y + 9, { align: 'center' });
    pdf.text(igreja.tesoureiro || '—', 150, y + 4.5, { align: 'center' });
    pdf.text('Tesoureiro', 150, y + 9, { align: 'center' });
    R.y = y + 10;
  };

  // Numeração só quando o relatório tem mais de uma página.
  R.finalizar = () => {
    const n = pdf.getNumberOfPages();
    if(n > 1){
      for(let i = 1; i <= n; i++){
        pdf.setPage(i); pdf.setFontSize(7); pdf.setTextColor(...T.mudo);
        pdf.text(`Página ${i} de ${n}`, 105, 291, { align: 'center' });
      }
    }
    return pdf;
  };

  R.cabecalho();
  return R;
}

// ---------------------------------------------------------------------------
// Blocos reaproveitados
// ---------------------------------------------------------------------------

// Dizimistas (duas colunas quando cabem na página; senão uma só, que quebra
// página normalmente) + ofertas + total de entradas.
function secaoReceitas(R, receitas, rotuloEntradas){
  const dizimos = receitas.filter(l => ehDizimo(l.categoriaNome));
  const ofertas = receitas.filter(l => !ehDizimo(l.categoriaNome));
  const totalD = soma(dizimos, 'valor'), totalO = soma(ofertas, 'valor');

  R.faixa('RELAÇÃO DE DIZIMISTAS E SEUS VALORES');
  const linhas = dizimos.map((l, i) => [i + 1, l.membroNome || '—', dataBR(l.dataStr), fmtBRL(l.valor)]);
  if(!linhas.length){
    R.legenda('Nenhum dízimo registrado neste mês.');
  } else {
    const head = ['N°', 'Nome', 'Data', 'Valor'], colunas = { 3: { halign: 'right' } };
    const metade = Math.ceil(linhas.length / 2);
    // 4,4 mm por linha + cabeçalho; folga de 8 mm porque é uma estimativa.
    const altura = (metade + 1) * 4.4 + 8;
    if(linhas.length >= 4 && R.y + altura <= FIM_UTIL){
      const y0 = R.y;
      const f1 = R.tabela({ head, body: linhas.slice(0, metade), cab: T.cabReceita, colunas, esq: 14, dir: 106, soDesenhar: true });
      R.y = y0;
      const f2 = R.tabela({ head, body: linhas.slice(metade), cab: T.cabReceita, colunas, esq: 106, dir: 14, soDesenhar: true });
      R.y = Math.max(f1, f2) + 2;
    } else {
      R.tabela({ head, body: linhas, cab: T.cabReceita, colunas });
    }
  }
  R.total('TOTAL DE DÍZIMOS (R$)', totalD, T.totalAzul);

  R.faixa('RELAÇÃO DE OFERTAS');
  const linhasO = ofertas.map((l, i) => [i + 1, l.membroNome || '', [l.categoriaNome, l.descricao].filter(Boolean).join(' - '), dataBR(l.dataStr), fmtBRL(l.valor)]);
  R.tabela({
    head: ['N°', 'Nome do ofertante', 'Tipo de oferta', 'Data', 'Valor'],
    body: linhasO.length ? linhasO : [['—', 'Nenhuma oferta registrada neste mês.', '', '', '']],
    cab: T.cabReceita, colunas: { 4: { halign: 'right' } },
  });
  R.total('TOTAL DE OFERTAS (R$)', totalO, T.totalAzul);
  R.total(rotuloEntradas, totalD + totalO, T.totalVerde);
  return { totalD, totalO, total: totalD + totalO };
}

function secaoDespesas(R, titulo, despesas, rotuloTotal, vazio){
  R.y += 2;
  R.faixa(titulo);
  const linhas = despesas.map((l, i) => [i + 1, [l.categoriaNome, l.descricao].filter(Boolean).join(' - '), dataBR(l.dataStr), fmtBRL(l.valor)]);
  R.tabela({
    head: ['N°', 'Descrição da despesa', 'Data', 'Valor (R$)'],
    body: linhas.length ? linhas : [['—', vazio, '', '']],
    cab: T.cabDespesa, colunas: { 3: { halign: 'right' } },
  });
  R.total(rotuloTotal, soma(despesas, 'valor'), T.totalRosa);
}

// Tabela rótulo/valor (balanço, apuração). Reserva também o espaço da
// assinatura, para o fechamento do relatório não ficar separado dela.
function secaoChaveValor(R, titulo, linhas, { destaque = linhas.length - 1, negativos = [], classico = false } = {}){
  // Fluxo contínuo: reserva só o título e as 3 primeiras linhas (evita título órfão);
  // se o resto não couber, a tabela segue na página seguinte, e a assinatura
  // se posiciona logo depois do fechamento (R.assinaturas faz a própria checagem).
  R.garantir(6 + Math.min(3, linhas.length) * (classico ? 6.7 : 5.9) + 2);
  R.faixa(titulo, 0);
  R.tabela({
    body: linhas, fonte: 8.5, pad: classico ? 1.4 : 1.15, semZebra: classico, colunas: { 0: { fontStyle: 'bold' }, 1: { halign: 'right' } },
    aoParsear: (d) => {
      if(d.section !== 'body') return;
      if(d.row.index === destaque){ d.cell.styles.fillColor = T.totalVerde; d.cell.styles.fontStyle = 'bold'; }
      if(negativos.includes(d.row.index) && d.column.index === 1) d.cell.styles.textColor = T.negativo;
    },
  });
}

const corSaldo = (v) => (v < 0 ? T.negativo : T.positivo);

// ---------------------------------------------------------------------------
// Relatórios
// ---------------------------------------------------------------------------

// dados: { igreja, titulo, receitas, despesas, saldoAnterior, linhasContas:[[rotulo, valor]] }
export function pdfMensal(JsPDF, d){
  const R = novoRelatorio(JsPDF, d.igreja, d.titulo);
  const dizimos = d.receitas.filter(l => ehDizimo(l.categoriaNome));
  const totalD = soma(dizimos, 'valor');
  const entradas = soma(d.receitas, 'valor'), totalO = entradas - totalD;
  const saidas = soma(d.despesas, 'valor'), saldo = entradas - saidas;

  R.y += 1;
  R.resumo({
    cartoes: [
      { rot: 'Entradas do mês', val: fmtBRL(entradas), sub: `Dízimos ${pct(totalD, entradas)}  |  Ofertas ${pct(totalO, entradas)}`, cor: T.verde },
      { rot: 'Saídas do mês', val: fmtBRL(saidas), sub: `${d.despesas.length} despesas  |  ${pct(saidas, entradas)} das entradas`, cor: T.rose },
      { rot: 'Saldo do mês', val: fmtBRL(saldo), sub: saldo < 0 ? 'Saídas maiores que as entradas' : 'Entradas maiores que as saídas', cor: T.faixaSecao, corVal: corSaldo(saldo) },
    ],
    barras: [{ rot: 'Entradas', valor: entradas, cor: T.verde }, { rot: 'Saídas', valor: saidas, cor: T.rose }],
  });
  secaoReceitas(R, d.receitas, 'TOTAL DE ENTRADAS DO MÊS (R$)');
  secaoDespesas(R, 'RELAÇÃO DE DESPESAS', d.despesas, 'TOTAL DE DESPESAS (R$)', 'Nenhuma despesa registrada neste mês.');

  const linhas = [
    ['Saldo do mês', fmtBRL(saldo)],
    ['Saldo anterior', fmtBRL(d.saldoAnterior)],
    ...(d.linhasContas || []).map(([r, v]) => [r, fmtBRL(v)]),
    ['Saldo para o próximo mês', fmtBRL(d.saldoAnterior + saldo)],
  ];
  // O destaque verde fica no saldo para o próximo mês, que NÃO é a última
  // linha quando há contas bancárias listadas depois dele.
  const idxProx = linhas.findIndex(l => l[0] === 'Saldo para o próximo mês');
  secaoChaveValor(R, 'BALANÇO FINAL', linhas, { destaque: idxProx, negativos: saldo < 0 ? [0] : [] });
  R.assinaturas();
  return R.finalizar();
}

// dados: { igreja, titulo, receitasBase, despCaeb, c:{...calcularCaeb} }
export function pdfCaeb(JsPDF, d){
  const R = novoRelatorio(JsPDF, d.igreja, d.titulo);
  const c = d.c;
  R.y += 1;
  R.resumo({
    cartoes: [
      { rot: 'Receitas computáveis', val: fmtBRL(c.totalReceitas), sub: 'sem o repasse da CAEB', cor: T.verde },
      { rot: 'Despesas no cálculo', val: fmtBRL(c.totalDespesas), sub: `${d.despCaeb.length} despesas`, cor: T.rose },
      { rot: 'Resultado do mês', val: fmtBRL(c.resultado), sub: c.resultado < 0 ? 'Despesas maiores' : 'Receitas maiores', cor: T.faixaSecao, corVal: corSaldo(c.resultado) },
      { rot: c.liquido >= 0 ? 'A receber da CAEB' : 'A repassar à CAEB', val: fmtBRL(Math.abs(c.liquido)), sub: 'valor líquido', cor: T.dourado },
    ],
    barras: [{ rot: 'Receitas', valor: c.totalReceitas, cor: T.verde }, { rot: 'Despesas', valor: c.totalDespesas, cor: T.rose }],
  });
  secaoReceitas(R, d.receitasBase, 'TOTAL DE RECEITAS COMPUTÁVEIS (R$)');
  secaoDespesas(R, 'DESPESAS DENTRO DO CÁLCULO DA CAEB', d.despCaeb, 'TOTAL DE DESPESAS CAEB (R$)', 'Nenhuma despesa CAEB neste mês.');
  // Só caracteres latinos nos rótulos: o símbolo "−" não existe na fonte do PDF.
  const linhas = [
    ['Receitas computáveis', fmtBRL(c.totalReceitas)],
    ['Despesas computáveis', fmtBRL(c.totalDespesas)],
    ['Resultado do mês', fmtBRL(c.resultado)],
    ['Valor a ser coberto pela CAEB', fmtBRL(c.aCobrir)],
    ['Contribuição à CAEB', fmtBRL(c.totalContribuicao)],
    [c.liquido >= 0 ? 'VALOR LÍQUIDO A SER REPASSADO PELA CAEB' : 'VALOR LÍQUIDO A SER REPASSADO À CAEB', fmtBRL(Math.abs(c.liquido))],
  ];
  // Apuração mantida no formato anterior (sem zebra, linhas mais espaçadas), a pedido.
  secaoChaveValor(R, 'APURAÇÃO DA CAEB', linhas, { destaque: linhas.length - 1, classico: true });
  R.assinaturas();
  return R.finalizar();
}

// dados: { igreja, titulo, meses:[{ nome, saldoAnterior, receitas, despesas }] }
export function pdfAnual(JsPDF, d){
  const R = novoRelatorio(JsPDF, d.igreja, d.titulo);
  const totalR = soma(d.meses, 'receitas'), totalD = soma(d.meses, 'despesas'), saldo = totalR - totalD;
  R.y += 1;
  R.resumo({
    cartoes: [
      { rot: 'Receitas do ano', val: fmtBRL(totalR), sub: `média de ${fmtBRL(totalR / 12)} por mês`, cor: T.verde },
      { rot: 'Despesas do ano', val: fmtBRL(totalD), sub: `${pct(totalD, totalR)} das receitas`, cor: T.rose },
      { rot: 'Saldo do ano', val: fmtBRL(saldo), sub: saldo < 0 ? 'Despesas maiores que as receitas' : 'Receitas maiores que as despesas', cor: T.faixaSecao, corVal: corSaldo(saldo) },
    ],
  });
  R.graficoMensal({
    meses: d.meses.map(m => ({ rot: m.nome.slice(0, 3), a: m.receitas, b: m.despesas })),
    corA: T.verde, corB: T.rose, legA: 'Receitas', legB: 'Despesas',
  });
  R.faixa('FLUXO DE CAIXA MENSAL');
  const linhas = d.meses.map(m => [m.nome, fmtBRL(m.saldoAnterior), fmtBRL(m.receitas), fmtBRL(m.despesas), fmtBRL(m.receitas - m.despesas)]);
  linhas.push(['Total', '', fmtBRL(totalR), fmtBRL(totalD), fmtBRL(saldo)]);
  R.tabela({
    head: ['Mês', 'Saldo anterior', 'Receitas', 'Despesas', 'Saldo do mês'], body: linhas, cab: T.cabReceita, fonte: 8.5, pad: 1.6,
    colunas: { 1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' } },
    aoParsear: (x) => { if(x.section === 'body' && x.row.index === linhas.length - 1){ x.cell.styles.fontStyle = 'bold'; x.cell.styles.fillColor = T.totalAzul; } },
  });
  R.assinaturas();
  return R.finalizar();
}

// dados: { igreja, titulo, periodoTexto, lancs:[{ dataStr, categoriaNome, valor }] }
export function pdfFiel(JsPDF, d){
  const R = novoRelatorio(JsPDF, d.igreja, d.titulo);
  const total = soma(d.lancs, 'valor');
  const porCategoria = {};
  d.lancs.forEach(l => { const k = l.categoriaNome || 'Sem categoria'; porCategoria[k] = (porCategoria[k] || 0) + l.valor; });
  const topo = Object.entries(porCategoria).sort((a, b) => b[1] - a[1]).slice(0, 5);

  R.legenda(d.periodoTexto);
  R.resumo({
    cartoes: [
      { rot: 'Total contribuído', val: fmtBRL(total), sub: d.periodoTexto.replace('Período: ', ''), cor: T.verde },
      { rot: 'Contribuições', val: String(d.lancs.length), sub: 'lançamentos no período', cor: T.faixaSecao },
      { rot: 'Média por contribuição', val: fmtBRL(d.lancs.length ? total / d.lancs.length : 0), sub: 'valor médio', cor: T.dourado },
    ],
    barras: topo.map(([nome, v]) => ({ rot: nome, valor: v, cor: T.verde, texto: `${fmtBRL(v)}  (${pct(v, total)})` })),
  });
  R.faixa('RELAÇÃO DE CONTRIBUIÇÕES');
  const linhas = d.lancs.map(l => [dataBR(l.dataStr), l.categoriaNome || '', fmtBRL(l.valor)]);
  R.tabela({
    head: ['Data', 'Categoria', 'Valor'], body: linhas.length ? linhas : [['—', 'Nenhuma contribuição registrada', '—']],
    cab: T.cabReceita, fonte: 7.5, pad: 1.1, colunas: { 2: { halign: 'right' } },
  });
  R.total('TOTAL GERAL (R$)', total, T.totalVerde);
  R.assinaturas();
  return R.finalizar();
}

// dados: { igreja, titulo, ex:{ anterior, entradas, saidas, final, linhas:[{ dataStr, historico, contaEntrada, contaSaida, saldo }] } }
export function pdfExtrato(JsPDF, d){
  const R = novoRelatorio(JsPDF, d.igreja, d.titulo);
  const ex = d.ex;
  R.y += 1;
  R.resumo({
    cartoes: [
      { rot: 'Saldo anterior', val: fmtBRL(ex.anterior), cor: T.faixaSecao },
      { rot: 'Entradas', val: fmtBRL(ex.entradas), sub: pct(ex.entradas, ex.entradas + ex.saidas) + ' da movimentação', cor: T.verde },
      { rot: 'Saídas', val: fmtBRL(ex.saidas), sub: pct(ex.saidas, ex.entradas + ex.saidas) + ' da movimentação', cor: T.rose },
      { rot: 'Saldo final', val: fmtBRL(ex.final), cor: T.dourado, corVal: corSaldo(ex.final) },
    ],
    barras: [{ rot: 'Entradas', valor: ex.entradas, cor: T.verde }, { rot: 'Saídas', valor: ex.saidas, cor: T.rose }],
  });
  R.faixa('MOVIMENTAÇÃO DA CONTA');
  const corpo = [
    ['', 'SALDO ANTERIOR', '', '', fmtBRL(ex.anterior)],
    ...ex.linhas.map(l => [dataBR(l.dataStr), l.historico, l.contaEntrada ? fmtBRL(l.contaEntrada) : '', l.contaSaida ? fmtBRL(l.contaSaida) : '', fmtBRL(l.saldo)]),
    ['', 'SALDO FINAL', fmtBRL(ex.entradas), fmtBRL(ex.saidas), fmtBRL(ex.final)],
  ];
  R.tabela({
    head: ['Data', 'Histórico', 'Entrada', 'Saída', 'Saldo'], body: corpo, cab: T.cabReceita, fonte: 7.5, pad: 1.1,
    colunas: { 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' } },
    aoParsear: (x) => {
      if(x.section !== 'body') return;
      if(x.row.index === 0) x.cell.styles.fontStyle = 'bold';
      if(x.row.index === corpo.length - 1){ x.cell.styles.fontStyle = 'bold'; x.cell.styles.fillColor = T.totalAzul; }
    },
  });
  R.assinaturas();
  return R.finalizar();
}

// dados: { igreja, titulo, campanha:{ nome, meta }, entradas:[{ fielNome, categoria, data, valor }], saidas:[{ categoria, descricao, data, valor }] }
export function pdfCampanha(JsPDF, d){
  const R = novoRelatorio(JsPDF, d.igreja, d.titulo);
  const totalE = soma(d.entradas, 'valor'), totalS = soma(d.saidas, 'valor'), saldo = totalE - totalS;
  const meta = d.campanha.meta || 0;
  const barras = [{ rot: 'Entradas', valor: totalE, cor: T.verde }, { rot: 'Saídas', valor: totalS, cor: T.rose }];
  if(meta) barras.push({ rot: 'Meta', valor: meta, cor: T.faixaSecao, texto: `${fmtBRL(meta)}  (${pct(totalE, meta)} atingido)` });
  R.y += 1;
  R.resumo({
    cartoes: [
      { rot: 'Entradas', val: fmtBRL(totalE), sub: `${d.entradas.length} contribuições`, cor: T.verde },
      { rot: 'Saídas', val: fmtBRL(totalS), sub: `${d.saidas.length} despesas`, cor: T.rose },
      { rot: 'Saldo da campanha', val: fmtBRL(saldo), sub: saldo < 0 ? 'Saídas maiores que as entradas' : 'Entradas maiores que as saídas', cor: T.faixaSecao, corVal: corSaldo(saldo) },
    ],
    barras,
  });
  R.faixa('RELAÇÃO DE ENTRADAS');
  const le = d.entradas.map((l, i) => [i + 1, l.fielNome || '—', l.categoria || '', dataBR(l.data), fmtBRL(l.valor)]);
  R.tabela({
    head: ['N°', 'Nome', 'Categoria', 'Data', 'Valor'], body: le.length ? le : [['—', 'Nenhuma entrada registrada', '', '', '']],
    cab: T.cabReceita, fonte: 7, pad: 0.95, colunas: { 4: { halign: 'right' } },
  });
  R.total('TOTAL DE ENTRADAS (R$)', totalE, T.totalVerde);

  R.y += 2;
  R.faixa('RELAÇÃO DE SAÍDAS');
  const ls = d.saidas.map((l, i) => [i + 1, l.categoria || '', l.descricao || '', dataBR(l.data), fmtBRL(l.valor)]);
  R.tabela({
    head: ['N°', 'Categoria', 'Descrição', 'Data', 'Valor'], body: ls.length ? ls : [['—', 'Nenhuma saída registrada', '', '', '']],
    cab: T.cabDespesa, fonte: 7, pad: 0.95, colunas: { 4: { halign: 'right' } },
  });
  R.total('TOTAL DE SAÍDAS (R$)', totalS, T.totalRosa);
  R.total('SALDO DA CAMPANHA (R$)', saldo, T.totalAzul);
  R.assinaturas();
  return R.finalizar();
}
