// Geração do PDF da Agenda Semanal — função pura (sem Firebase), para poder
// ser testada fora do navegador. Recebe o construtor do jsPDF e os dados já
// prontos; devolve o objeto jsPDF. O layout reproduz o modelo em Word da igreja
// (cabeçalho com logo, faixa azul-clara de título, barra azul à esquerda de
// cada dia, datas em laranja, "Informações adicionais" e rodapé com marca d'água).

// Ícones do modelo (calendário e informações), embutidos para não depender
// de arquivos externos nem de rede ao gerar o PDF.
const ICONE_CALENDARIO = 'data:image/png;base64,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';
const ICONE_INFO = 'data:image/png;base64,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';

const DIAS_CURTO = ['SEG','TER','QUA','QUI','SEX','SAB','DOM'];
const ROTULOS_PADRAO = ['direcao','leitura','pregacao'];

function hexParaRgb(hex, padrao){
  const m = /^#?([0-9a-f]{6})$/i.exec((hex||'').trim());
  const h = m ? m[1] : padrao;
  return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)];
}
function misturar(rgb, com, t){ return rgb.map((v,i)=> Math.round(v*(1-t) + com[i]*t)); }
function dataBR(iso){ const [a,m,d] = iso.split('-'); return `${d}/${m}`; }

// Mede e desenha a agenda. `esc` reduz fontes/espaçamentos quando a semana
// tem muitas linhas, para caber numa página só (como no modelo).
export function desenharAgendaPdf(JsPDF, dados){
  const { agenda, igreja = {}, cultos = {}, tituloSemana = '' } = dados;
  const pdf = new JsPDF({ unit:'mm', format:'a4' });
  const AZUL = hexParaRgb(igreja.corPrimaria, '156082');
  const LARANJA = hexParaRgb(igreja.corDestaque, 'F69238');
  const CLARO = misturar(AZUL, [255,255,255], 0.86);
  const AZUL_ESCURO = misturar(AZUL, [0,0,0], 0.35);
  const PRETO = [0,0,0];

  const X0 = 10, LARG = 190;
  const COL = { data:17, hora:18, ativ:64.5, f:[30,30,30.5] };
  const xData = X0, xHora = xData + COL.data, xAtiv = xHora + COL.hora;
  const xF = [xAtiv + COL.ativ]; xF.push(xF[0]+COL.f[0]); xF.push(xF[1]+COL.f[1]);
  const xFim = X0 + LARG;
  const LIMITE_BAIXO = 266;       // acima do rodapé
  const PT = 0.3528;              // mm por ponto
  const lh = (fs)=> fs * PT * 1.22;

  // ---------- helpers de desenho ----------
  const cor = (c)=> pdf.setTextColor(c[0],c[1],c[2]);
  function celula(x, y, w, h, fill){
    if(fill){ pdf.setFillColor(fill[0],fill[1],fill[2]); pdf.rect(x,y,w,h,'F'); }
    pdf.setDrawColor(0); pdf.setLineWidth(0.22); pdf.rect(x,y,w,h,'S');
  }
  function fonte(estilo, tam){ pdf.setFont('helvetica', estilo); pdf.setFontSize(tam); }
  function quebrar(txt, larg, estilo, tam){
    fonte(estilo, tam);
    return String(txt||'').split('\n').flatMap(l => l === '' ? [''] : pdf.splitTextToSize(l, larg));
  }

  // ---------- imagens ----------
  function formatoImg(src){ return /^data:image\/png/i.test(src) ? 'PNG' : 'JPEG'; }
  function dimensoes(src){ const p = pdf.getImageProperties(src); return { w:p.width, h:p.height }; }
  function imagemCaixa(src, cx, y, maxW, maxH){
    try{
      const { w, h } = dimensoes(src);
      let dw = maxW, dh = dw * h / w;
      if(dh > maxH){ dh = maxH; dw = dh * w / h; }
      pdf.addImage(src, formatoImg(src), cx - dw/2, y, dw, dh);
      return dh;
    } catch(e){ return 0; }
  }

  function marcaDagua(){
    if(!igreja.marcaDagua) return;
    try{
      const { w, h } = dimensoes(igreja.marcaDagua);
      let dw = 190, dh = dw * h / w;
      if(dh > 135){ dh = 135; dw = dh * w / h; }
      const op = Math.min(1, Math.max(0.03, (igreja.marcaOpacidade ?? 15) / 100));
      pdf.saveGraphicsState();
      pdf.setGState(new pdf.GState({ opacity: op }));
      pdf.addImage(igreja.marcaDagua, formatoImg(igreja.marcaDagua), 105 - dw/2, 268 - dh, dw, dh);
      pdf.restoreGraphicsState();
    } catch(e){ /* segue sem marca d'água */ }
  }

  // ---------- cabeçalho / faixas ----------
  function faixaTitulo(y, titulo, sub, icone){
    try{ pdf.addImage(icone, 'PNG', 44, y-1.5, 16, 16); } catch(e){}
    pdf.setFillColor(CLARO[0],CLARO[1],CLARO[2]); pdf.rect(62, y, 138, 6.6, 'F');
    pdf.setFillColor(AZUL[0],AZUL[1],AZUL[2]); pdf.rect(62, y, 1.2, 6.6, 'F');
    fonte('bold', 11.5); cor(PRETO); pdf.text(titulo, 65, y+4.8);
    if(sub){
      fonte('bold', 8.8); cor(LARANJA);
      const tw = pdf.getTextWidth(sub);
      pdf.text(sub, 100, y+11.2, { align:'center' });
      pdf.setFillColor(AZUL[0],AZUL[1],AZUL[2]); pdf.rect(100 + tw/2 + 2.5, y+7.6, 1.2, 4.6, 'F');
    }
    cor(PRETO);
  }
  function cabecalhoPagina(primeira){
    let y = 4;
    if(igreja.logoTopo){
      const dh = imagemCaixa(igreja.logoTopo, 105, y, 120, 34);
      y += dh || 0;
    } else if(igreja.logo){
      const dh = imagemCaixa(igreja.logo, 105, y, 24, 24);
      y += (dh || 0) + 1;
      fonte('bold', 11); cor(AZUL);
      const nome = igreja.nomeRelatorio || igreja.nome || '';
      pdf.text(nome, 105, y+3, { align:'center', maxWidth: 180 });
      y += 6; cor(PRETO);
    } else {
      // Sem logo cadastrada: usa o nome da igreja como cabeçalho (evita um buraco em branco no topo).
      fonte('bold', 17); cor(AZUL);
      pdf.text(igreja.nomeRelatorio || igreja.nome || '', 105, 18, { align:'center', maxWidth: 180 });
      y = 22; cor(PRETO);
    }
    y = Math.max(y + 3, (igreja.logoTopo || igreja.logo) ? 38 : 28);
    if(!primeira) y = 30;
    faixaTitulo(y, 'AGENDA DE ATIVIDADES SEMANAIS', tituloSemana, ICONE_CALENDARIO);
    return y + 16.5;
  }
  function cabecalhoTabela(y){
    const h = 5.6;
    const rot = [['Data',xData,COL.data],['Horário',xHora,COL.hora],['Atividade/Culto',xAtiv,COL.ativ],
      ['Direção',xF[0],COL.f[0]],['Leitura',xF[1],COL.f[1]],['Pregação',xF[2],COL.f[2]]];
    rot.forEach(([t,x,w])=>{ celula(x,y,w,h,CLARO); fonte('bold',9.5); cor(PRETO); pdf.text(t, x+w/2, y+h/2+1.2, {align:'center'}); });
    return y + h + 2.2;
  }

  // ---------- rodapé ----------
  function iconeRodape(tipo, x, y){
    // Ícones simples desenhados em vetor (não dependem de imagens externas).
    pdf.setDrawColor(AZUL[0],AZUL[1],AZUL[2]); pdf.setFillColor(AZUL[0],AZUL[1],AZUL[2]); pdf.setLineWidth(0.35);
    const s = 4.2;
    if(tipo === 'pin'){ pdf.circle(x+s/2, y+s/2-0.4, 1.5, 'F'); pdf.triangle(x+s/2-1.2, y+s/2+0.3, x+s/2+1.2, y+s/2+0.3, x+s/2, y+s, 'F'); }
    else if(tipo === 'doc'){ pdf.rect(x+0.8, y+0.2, s-1.6, s-0.4, 'S'); pdf.line(x+1.6,y+1.5,x+s-1.6,y+1.5); pdf.line(x+1.6,y+2.5,x+s-1.6,y+2.5); }
    else if(tipo === 'insta'){ pdf.roundedRect(x+0.3, y+0.3, s-0.6, s-0.6, 1, 1, 'S'); pdf.circle(x+s/2, y+s/2, 1, 'S'); }
    else if(tipo === 'fone'){ pdf.roundedRect(x+1.1, y+0.1, s-2.2, s-0.2, 0.7, 0.7, 'S'); pdf.circle(x+s/2, y+s-0.9, 0.3, 'F'); }
    else if(tipo === 'mail'){ pdf.rect(x+0.2, y+0.9, s-0.4, s-1.8, 'S'); pdf.line(x+0.2,y+0.9,x+s/2,y+s/2+0.4); pdf.line(x+s-0.2,y+0.9,x+s/2,y+s/2+0.4); }
  }
  function rodape(){
    const fim = [igreja.endereco, igreja.bairro, [igreja.cidade, igreja.estado].filter(Boolean).join('/')].filter(Boolean).join(', ');
    const endereco = fim ? fim + (igreja.cep ? `. CEP: ${igreja.cep}` : '') : '';
    const fone = [igreja.contatoTelefone, igreja.contatoNome].filter(Boolean).join(' - ');
    const itens = [
      { t:'pin', txt:endereco, x:20, y:271, larg:180 },
      { t:'doc', txt: igreja.cnpj ? `CNPJ: ${igreja.cnpj}` : '', x:20, y:277.4, larg:85 },
      { t:'fone', txt: fone, x:110, y:277.4, larg:92 },
      { t:'insta', txt: igreja.instagram ? (String(igreja.instagram).startsWith('@') ? igreja.instagram : '@'+igreja.instagram) : '', x:20, y:283.2, larg:85 },
      { t:'mail', txt: igreja.email || '', x:110, y:283.2, larg:92 },
    ];
    itens.forEach(it=>{
      if(!it.txt) return;
      iconeRodape(it.t, it.x, it.y);
      fonte('normal', 8.2); cor([40,40,40]);
      pdf.text(it.txt, it.x + 5.2, it.y + 3.2, { maxWidth: it.larg - 5.5 });
    });
    // Faixa inferior: tom principal da igreja com um trecho mais escuro à esquerda.
    pdf.setFillColor(AZUL[0],AZUL[1],AZUL[2]); pdf.rect(0, 290.4, 210, 6.6, 'F');
    pdf.setFillColor(AZUL_ESCURO[0],AZUL_ESCURO[1],AZUL_ESCURO[2]);
    pdf.lines([[34,0],[-4,6.6],[-30,0]], 0, 290.4, [1,1], 'F', true);
    cor(PRETO);
  }

  // ---------- medição das linhas ----------
  const ehPadrao = (l)=> l.tipo === 'culto' && (l.funcoes||[]).length === 3 && (l.funcoes||[]).every((f,i)=> f.key === ROTULOS_PADRAO[i]);

  // Quebra de texto "Rótulo: valor" em segmentos para negritar o rótulo.
  function linhasTexto(txt, larg, tam){
    const saida = [];
    String(txt||'').split('\n').forEach(orig=>{
      const m = /^([^:]{1,32}:)\s*(.*)$/.exec(orig);
      fonte('normal', tam);
      const pedacos = pdf.splitTextToSize(orig, larg);
      pedacos.forEach((p, i)=>{
        if(i === 0 && m && p.startsWith(m[1])) saida.push({ pre:m[1], resto: p.slice(m[1].length).replace(/^\s+/,'') });
        else saida.push({ pre:'', resto:p });
      });
    });
    return saida;
  }

  function medirLinha(l, esc){
    const fs = 9.6*esc, fo = 8.8*esc, pad = 1.2*esc;
    const iconeLarg = (l.cultoId && cultos[l.cultoId]?.icone) ? 6.5*esc : 0;
    const larguraAtiv = COL.ativ - 2*pad - (iconeLarg ? iconeLarg + 1.5 : 0);
    const partes = [];
    if(l.tipo === 'aviso'){
      partes.push({ lns: quebrar(l.texto || l.titulo || '', COL.ativ + COL.f[0]+COL.f[1]+COL.f[2] - 2*pad, 'bold', fs), est:'bold', tam:fs, cor:PRETO });
    } else {
      if(l.titulo) partes.push({ lns: quebrar(l.titulo, larguraAtiv, 'normal', fs), est:'normal', tam:fs, cor:PRETO });
      if(l.obs) partes.push({ lns: quebrar(l.obs, larguraAtiv, 'bolditalic', fo), est:'bolditalic', tam:fo, cor:LARANJA, sub:true });
    }
    let altAtiv = partes.reduce((s,p)=> s + p.lns.length*lh(p.tam), 0);
    // Células de função
    let celulasF = [], altF = 0, textoMesclado = null;
    if(l.tipo === 'culto'){
      if(ehPadrao(l)){
        celulasF = l.funcoes.map((f,i)=>({ x:xF[i], w:COL.f[i], lns: quebrar(f.pessoa?.nome||'', COL.f[i]-2*pad, 'normal', fs), rotulo:'' }));
      } else if(l.funcoes && l.funcoes.length){
        const n = l.funcoes.length, area = COL.f[0]+COL.f[1]+COL.f[2], w = area/n;
        celulasF = l.funcoes.map((f,i)=>({ x:xF[0]+i*w, w, rotulo: f.label + ':', lns: quebrar(f.pessoa?.nome||'', w-2*pad, 'normal', fs) }));
      } else {
        celulasF = [{ x:xF[0], w:COL.f[0]+COL.f[1]+COL.f[2], lns:[], rotulo:'' }];
      }
      altF = Math.max(0, ...celulasF.map(c => (c.rotulo?1:0)*lh(fs) + c.lns.length*lh(fs)));
    } else if(l.tipo === 'texto'){
      const w = COL.f[0]+COL.f[1]+COL.f[2];
      textoMesclado = { x:xF[0], w, lns: linhasTexto(l.texto, w-2*pad, fs) };
      altF = textoMesclado.lns.length*lh(fs);
    }
    const minH = 10*esc;
    const h = Math.max(minH, Math.max(altAtiv, altF) + 2*pad + 0.6);
    return { h, partes, celulasF, textoMesclado, iconeLarg, fs, fo, pad, altAtiv, altF };
  }
  // Linha vazia (dia sem programação) mantém as células em branco.
  const LINHA_VAZIA = { tipo:'vazio', funcoes:[] };

  function desenharLinha(l, m, y, blocoComHora){
    const h = m.h, pad = m.pad, fs = m.fs;
    // células base
    celula(xHora, y, COL.hora, h);
    if(l.tipo === 'aviso'){ celula(xAtiv, y, xFim - xAtiv, h); }
    else {
      celula(xAtiv, y, COL.ativ, h);
      if(l.tipo === 'texto'){ celula(xF[0], y, xFim - xF[0], h); }
      else if(l.tipo === 'culto' && !ehPadrao(l) && m.celulasF.length){
        // Funções personalizadas: as células seguem a divisão real (antes eram sempre 3 e o texto cruzava as linhas).
        m.celulasF.forEach(c => celula(c.x, y, c.w, h));
      }
      else { [0,1,2].forEach(i => celula(xF[i], y, COL.f[i], h)); }
    }
    // horário
    if(l.horario){ fonte('normal', fs); cor(PRETO); pdf.text(String(l.horario).replace(':','h'), xHora+COL.hora/2, y+h/2+fs*PT*0.33, { align:'center' }); }
    // atividade
    if(l.tipo === 'aviso'){
      const w = xFim - xAtiv, p = m.partes[0];
      if(p){ fonte('bold', p.tam); cor(PRETO); const tot = p.lns.length*lh(p.tam); let yy = y + (h - tot)/2;
        p.lns.forEach(t=>{ pdf.text(t, xAtiv + w/2, yy, { align:'center', baseline:'top' }); yy += lh(p.tam); }); }
    } else {
      const areaX = xAtiv + (m.iconeLarg ? m.iconeLarg + 1.5 + pad : 0);
      const areaW = COL.ativ - (m.iconeLarg ? m.iconeLarg + 1.5 + pad : 0);
      if(m.iconeLarg){ try{ pdf.addImage(cultos[l.cultoId].icone, 'PNG', xAtiv+1.4, y+(h-m.iconeLarg)/2, m.iconeLarg, m.iconeLarg); }catch(e){} }
      const tot = m.partes.reduce((s,p)=> s + p.lns.length*lh(p.tam), 0);
      let yy = y + (h - tot)/2;
      m.partes.forEach(p=>{
        fonte(p.est, p.tam); cor(p.cor);
        p.lns.forEach(t=>{
          const cx = areaX + areaW/2;
          pdf.text(t, cx, yy, { align:'center', baseline:'top' });
          if(p.sub && t){ const tw = pdf.getTextWidth(t); pdf.setDrawColor(p.cor[0],p.cor[1],p.cor[2]); pdf.setLineWidth(0.25);
            pdf.line(cx - tw/2, yy + p.tam*PT*0.98, cx + tw/2, yy + p.tam*PT*0.98); }
          yy += lh(p.tam);
        });
      });
      cor(PRETO);
    }
    // funções
    m.celulasF.forEach(c=>{
      if(!c.lns.length && !c.rotulo) return;
      const tot = (c.rotulo?1:0)*lh(fs) + c.lns.length*lh(fs);
      let yy = y + (h - tot)/2;
      if(c.rotulo){ fonte('normal', fs); cor(PRETO); pdf.text(c.rotulo, c.x + c.w/2, yy, { align:'center', baseline:'top' }); yy += lh(fs); }
      fonte('normal', fs); cor(PRETO);
      c.lns.forEach(t=>{ pdf.text(t, c.x + c.w/2, yy, { align:'center', baseline:'top' }); yy += lh(fs); });
    });
    if(m.textoMesclado){
      const t = m.textoMesclado; const tot = t.lns.length*lh(fs); let yy = y + (h - tot)/2;
      t.lns.forEach(seg=>{
        let wPre = 0, wRes = 0;
        if(seg.pre){ fonte('bold', fs); wPre = pdf.getTextWidth(seg.pre + ' '); }
        fonte('normal', fs); wRes = pdf.getTextWidth(seg.resto);
        let x = t.x + t.w/2 - (wPre + wRes)/2; cor(PRETO);
        if(seg.pre){ fonte('bold', fs); pdf.text(seg.pre + ' ', x, yy, { baseline:'top' }); x += wPre; }
        fonte('normal', fs); pdf.text(seg.resto, x, yy, { baseline:'top' });
        yy += lh(fs);
      });
    }
  }

  function desenharBloco(dia, i, y, blocos){
    const total = blocos.reduce((s,b)=> s + b.m.h, 0);
    // coluna do dia
    celula(xData, y, COL.data, total);
    pdf.setFillColor(AZUL[0],AZUL[1],AZUL[2]); pdf.rect(xData, y, 1.3, total, 'F');
    const vazio = blocos.length === 1 && blocos[0].l.tipo === 'vazio';
    const tam = vazio ? 8.6 : 10.4;
    fonte('bold', tam); cor(PRETO);
    const dataTxt = dataBR(dia.data);
    const th = lh(tam) + lh(tam-0.4);
    let yy = y + (total - th)/2;
    pdf.text(DIAS_CURTO[i], xData + COL.data/2 + 0.6, yy, { align:'center', baseline:'top' });
    fonte('bold', tam-0.4); cor(LARANJA);
    pdf.text(dataTxt, xData + COL.data/2 + 0.6, yy + lh(tam), { align:'center', baseline:'top' });
    cor(PRETO);
    let yl = y;
    blocos.forEach(b=>{ desenharLinha(b.l, b.m, yl); yl += b.m.h; });
    return total;
  }

  // ---------- informações adicionais ----------
  const portRows = (agenda.porteiros||[]).filter(p => p.pessoa?.nome || p.dia != null).sort((a,b)=> a.dia - b.dia);
  const pastRows = (agenda.pastoral||[]).filter(p => (p.texto||'').trim()).sort((a,b)=> a.dia - b.dia);
  function medirInfo(esc){
    const fs = 9.4*esc, pad = 1.1*esc;
    const wP = 51, wD = 12.5, xPast = 66, wPast = 134, wDp = 14;
    const rowsN = Math.max(3, portRows.length, pastRows.length);
    const linhas = [];
    for(let i=0;i<rowsN;i++){
      const pr = portRows[i], ps = pastRows[i];
      const ln1 = pr ? quebrar(pr.pessoa?.nome||'', wP - wD - 2*pad, 'normal', fs) : [];
      const ln2 = ps ? quebrar(ps.texto, wPast - wDp - 2*pad, 'normal', fs) : [];
      const h = Math.max(6.3*esc, Math.max(ln1.length, ln2.length)*lh(fs) + 2*pad);
      linhas.push({ pr, ps, ln1, ln2, h });
    }
    const total = 16.5 + 5.8 + 0.8 + linhas.reduce((s,l)=> s+l.h, 0);
    return { fs, pad, wP, wD, xPast, wPast, wDp, linhas, total };
  }
  function desenharInfo(y, inf){
    faixaTitulo(y, 'INFORMAÇÕES ADICIONAIS', 'Porteiros da Semana e Agenda Pastoral', ICONE_INFO);
    y += 17;
    const hh = 5.6;
    celula(X0, y, inf.wP, hh, CLARO); fonte('bold', 9.4); cor(PRETO); pdf.text('Porteiros da Semana', X0 + inf.wP/2, y + hh/2 + 1.2, { align:'center' });
    celula(inf.xPast, y, inf.wPast, hh, CLARO); pdf.text('Agenda Pastoral', inf.xPast + inf.wPast/2, y + hh/2 + 1.2, { align:'center' });
    y += hh + 0.8;
    inf.linhas.forEach(l=>{
      // Porteiros
      celula(X0, y, inf.wD, l.h); celula(X0 + inf.wD, y, inf.wP - inf.wD, l.h);
      if(l.pr){
        fonte('bold', inf.fs); cor(PRETO); pdf.text(DIAS_CURTO[l.pr.dia] || '', X0 + inf.wD/2, y + l.h/2 + inf.fs*PT*0.33, { align:'center' });
        fonte('normal', inf.fs); let yy = y + (l.h - l.ln1.length*lh(inf.fs))/2;
        l.ln1.forEach(t=>{ pdf.text(t, X0 + inf.wD + 1.6, yy, { baseline:'top' }); yy += lh(inf.fs); });
      }
      // Pastoral (com barra azul à esquerda)
      celula(inf.xPast, y, inf.wDp, l.h); celula(inf.xPast + inf.wDp, y, inf.wPast - inf.wDp, l.h);
      pdf.setFillColor(AZUL[0],AZUL[1],AZUL[2]); pdf.rect(inf.xPast, y, 1.2, l.h, 'F');
      if(l.ps){
        fonte('bold', inf.fs); cor(PRETO); pdf.text(DIAS_CURTO[l.ps.dia] || '', inf.xPast + inf.wDp/2 + 0.5, y + l.h/2 + inf.fs*PT*0.33, { align:'center' });
        fonte('normal', inf.fs); let yy = y + (l.h - l.ln2.length*lh(inf.fs))/2;
        l.ln2.forEach(t=>{ pdf.text(t, inf.xPast + inf.wDp + 1.6, yy, { baseline:'top' }); yy += lh(inf.fs); });
      }
      y += l.h;
    });
    return y;
  }

  // ---------- montagem ----------
  const dias = (agenda.dias || []).slice(0,7);
  function montarBlocos(esc){
    return dias.map((dia, i)=>{
      const ls = (dia.linhas && dia.linhas.length) ? dia.linhas : [LINHA_VAZIA];
      return { dia, i, blocos: ls.map(l => ({ l, m: medirLinha(l, esc) })) };
    });
  }
  let esc = 1;
  // Ordem das camadas: cabeçalho, marca d'água (por baixo da tabela), rodapé, tabela.
  const yTabela = cabecalhoPagina(true);
  marcaDagua();
  rodape();
  const alturaTabela = (bl)=> bl.reduce((s,b)=> s + b.blocos.reduce((a,x)=> a + x.m.h, 0), 0) + 3.2*Math.max(0, bl.length-1) + 7.8;
  let blocosDia = montarBlocos(esc), inf = medirInfo(esc);
  // Reduz a escala (até um mínimo legível) para caber em uma página só.
  while(esc > 0.72 && yTabela + alturaTabela(blocosDia) + 4 + inf.total > LIMITE_BAIXO){
    esc = Math.round((esc - 0.04)*100)/100;
    blocosDia = montarBlocos(esc); inf = medirInfo(esc);
  }
  let y = cabecalhoTabela(yTabela);
  const gap = 3.2*esc;
  blocosDia.forEach((b, idx)=>{
    const altBloco = b.blocos.reduce((s,x)=> s + x.m.h, 0);
    if(y + altBloco > LIMITE_BAIXO && idx > 0){
      pdf.addPage(); marcaDagua(); rodape();
      const yy = cabecalhoPagina(false); y = cabecalhoTabela(yy);
    }
    desenharBloco(b.dia, b.i, y, b.blocos);
    y += altBloco + gap;
  });
  y -= gap; y += 4;
  if(y + inf.total > LIMITE_BAIXO + 2){ pdf.addPage(); marcaDagua(); rodape(); y = 12; }
  desenharInfo(y, inf);
  return pdf;
}
