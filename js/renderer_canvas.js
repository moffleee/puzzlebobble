// renderer_canvas.js - Canvas描画（盤面・アイコン・UI）
(() => {
  const Renderer = {};

  // 画像を丸く切り抜いて外周リングで描画（画像が無ければ色塗りのフォールバック）
  Renderer.drawAvatarBubble = (ctx, img, x, y, r, ringColor) => {
    ctx.save();
    // 背景（フォールバック塗り）
    const grdBg = ctx.createRadialGradient(x - r*0.4, y - r*0.4, r*0.1, x, y, r);
    grdBg.addColorStop(0, ringColor);
    grdBg.addColorStop(1, "#000000");
    ctx.globalAlpha = 0.3;
    ctx.fillStyle = grdBg;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI*2); ctx.fill();
    ctx.globalAlpha = 1;

    // 画像があれば丸抜きで描画
    if (img && img.complete) {
      ctx.save();
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI*2); ctx.clip();
      ctx.drawImage(img, x - r, y - r, r*2, r*2);
      ctx.restore();
    }

    // リング
    ctx.lineWidth = Math.max(2, r * 0.12);
    ctx.strokeStyle = ringColor;
    ctx.beginPath(); ctx.arc(x, y, r - ctx.lineWidth * 0.5, 0, Math.PI*2); ctx.stroke();

    // ハイライト
    ctx.globalAlpha = 0.12;
    const grd = ctx.createRadialGradient(x - r*0.4, y - r*0.4, r*0.1, x, y, r);
    grd.addColorStop(0, "#fff"); grd.addColorStop(1, "transparent");
    ctx.fillStyle = grd; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI*2); ctx.fill();
    ctx.globalAlpha = 1;
  };

  // 盤面全体を描画
  Renderer.drawBoard = (ctx, board, dropOffsetY, R, imageMap) => {
    for (let r = 0; r < board.length; r++){
      for (let c = 0; c < PXGrid.COLS; c++){
        const cell = board[r][c];
        if (!cell) continue;
        const {x,y} = PXGrid.cellCenter(r, c, dropOffsetY);
        const img = imageMap[cell.avatarId];
        Renderer.drawAvatarBubble(ctx, img, x, y, R, cell.color);
      }
    }
  };

  // 照準ガイド（点線）
  Renderer.drawAimGuide = (ctx, fromX, fromY, toX, toY) => {
    const dx = toX - fromX, dy = toY - fromY;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    const dash = 10, gap = 6, total = 420;
    let t = 0;
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,.35)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    while (t < total){
      const sx = fromX + ux * t;
      const sy = fromY + uy * t;
      const ex = fromX + ux * Math.min(t+dash, total);
      const ey = fromY + uy * Math.min(t+dash, total);
      ctx.moveTo(sx,sy); ctx.lineTo(ex,ey);
      t += dash + gap;
    }
    ctx.stroke();
    ctx.restore();
  };

  // 次弾プレビュー
  Renderer.drawNext = (canvas, nextBall, R, imageMap) => {
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0,0,canvas.width,canvas.height);
    if (!nextBall) return;
    const img = imageMap[nextBall.avatarId];
    const x = canvas.width/2, y = canvas.height/2;
    Renderer.drawAvatarBubble(ctx, img, x, y, R, nextBall.color);
  };

  // クリア/オーバーを軽く強調
  Renderer.flashText = (ctx, text, w, h) => {
    ctx.save();
    ctx.fillStyle = "rgba(0,0,0,.35)";
    ctx.fillRect(0,0,w,h);
    ctx.font = "bold 48px system-ui, -apple-system, 'Segoe UI'";
    ctx.fillStyle = "#fff";
    ctx.textAlign = "center";
    ctx.fillText(text, w/2, h/2);
    ctx.restore();
  };

  window.PXRender = Renderer;
})();
