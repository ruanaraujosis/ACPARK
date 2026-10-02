// Núcleo do quadro de assinatura, compartilhado pelo MyEstoque (devolução de avaria e
// inventário) e pelo MyControl (assinatura do colaborador).
//
// Só o desenho mora aqui: traço, limpeza, detecção de tinta e exportação em PNG. O que cada
// tela faz com a assinatura (qual campo preenche, o que habilita) fica com ela.
//
// Eventos de PONTEIRO (mouse, dedo e caneta com o mesmo código) e `touch-action: none` no
// canvas, para o dedo desenhar em vez de rolar a página. A conversão de escala (posição na tela
// -> pixel interno do canvas) continua obrigatória: o canvas nasce 720x220 e o CSS o exibe com
// outra largura; sem a conta, o traço sai deslocado do dedo.
export function ligarQuadroDeAssinatura(canvas, { aoDesenhar } = {}) {
  const ctx = canvas.getContext("2d");
  let desenhando = false;
  let temTinta = false;
  let ponteiroAtivo = null;

  // Garante o toque desenhando mesmo se a folha de estilo da tela esquecer
  canvas.style.touchAction = "none";

  // Fundo branco e o estilo do traço
  const limpar = () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = "#005f68";
    // O canvas nasce em 720x220, mas quase sempre é exibido menor via CSS (width:100%) --
    // reduzido, um traço de 4px de espessura própria fica fino demais na tela.
    ctx.lineWidth = 7;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    temTinta = false;
    aoDesenhar?.(false);
  };

  // Converte a posição do ponteiro para a escala interna do canvas: o CSS pode exibi-lo com
  // largura diferente da declarada, e sem essa conta o traço sai deslocado do cursor.
  const ponto = (evento) => {
    const area = canvas.getBoundingClientRect();
    return {
      x: ((evento.clientX - area.left) / area.width) * canvas.width,
      y: ((evento.clientY - area.top) / area.height) * canvas.height
    };
  };

  // Começa um traço (só o ponteiro principal: um segundo dedo não risca a assinatura)
  const comecar = (evento) => {
    if (!evento.isPrimary || (evento.pointerType === "mouse" && evento.button !== 0)) return;
    evento.preventDefault();
    desenhando = true;
    ponteiroAtivo = evento.pointerId;
    // Captura: o traço continua mesmo se o dedo/mouse sair do canvas no meio
    canvas.setPointerCapture?.(evento.pointerId);
    const p = ponto(evento);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
  };

  // Continua o traço
  const mover = (evento) => {
    if (!desenhando || evento.pointerId !== ponteiroAtivo) return;
    evento.preventDefault();
    const p = ponto(evento);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    temTinta = true;
    aoDesenhar?.(true);
  };

  // Termina o traço (soltou, cancelou ou perdeu a captura)
  const terminar = (evento) => {
    if (evento && ponteiroAtivo !== null && evento.pointerId !== ponteiroAtivo) return;
    desenhando = false;
    ponteiroAtivo = null;
  };

  limpar();
  canvas.addEventListener("pointerdown", comecar);
  canvas.addEventListener("pointermove", mover);
  canvas.addEventListener("pointerup", terminar);
  canvas.addEventListener("pointercancel", terminar);
  canvas.addEventListener("lostpointercapture", terminar);

  return {
    limpar,
    temTinta: () => temTinta,
    comoPng: () => canvas.toDataURL("image/png"),
    // Arquivo PNG (para enviar ao storage em vez de gravar base64 no banco)
    comoBlob: () => new Promise((resolve) => canvas.toBlob(resolve, "image/png"))
  };
}
