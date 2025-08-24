// game.js - 状態管理／入力／ループ
(() => {
  // ====== 基本設定 ======
  const CONFIG = {
    COLS: 12,
    R: 18,                       // 玉半径(px)
    BOARD_ROWS: 18,              // 盤の最大行
    SHOT_SPEED: 640,             // px/sec
    CEILING_DROP_PER_SHOTS: 8,   // N発ごとに1段降下
    CLEAR_MATCH: 3,              // 同色3個以上で消去
    LEFT_MARGIN: 24, RIGHT_MARGIN: 24, TOP_MARGIN: 24, BOTTOM_MARGIN: 96
  };

  // DOM
  const cv = document.getElementById("game");
  const ctx = cv.getContext("2d");
  const cvNext = document.getElementById("next");
  const shotsLeftEl = document.getElementById("shotsLeft");
  const overlay = document.getElementById("overlay");
  const overlayText = document.getElementById("overlayText");
  const btnPause = document.getElementById("btnPause");
  const btnRetry = document.getElementById("btnRetry");
  const btnResume = document.getElementById("btnResume");
  const btnOverlayRetry = document.getElementById("btnOverlayRetry");

  // 共有ステート
  let images = {};         // avatarId -> Image()
  let avatars = [];        // [{id,file,color}]
  let palette = [];        // ["#..",...]
  let board = null;        // [row][col] -> {color, avatarId}
  let dropOffsetY = 0;     // 天井降下の累計オフセット
  let shotsUsed = 0;
  let state = "ready";     // ready | firing | settle | paused | over | clear
  let shooter = null;      // {x,y}
  let aim = {x: cv.width/2, y: CONFIG.TOP_MARGIN+180};
  let moving = null;       // 発射中の玉 {x,y,vx,vy,r,color,avatarId}
  let nextBall = null;

  // 画像読み込み
  async function loadAvatars(){
    const resp = await fetch("data/avatars.json");
    const data = await resp.json();
    palette = data.palette;
    avatars = data.avatars;

    // 画像を読み込み
    const jobs = avatars.map(a => new Promise((resolve,reject)=>{
      const img = new Image();
      img.src = a.file + "?v=1";
      img.onload = () => { images[a.id] = img; resolve(); };
      img.onerror = reject;
    }));
    await Promise.all(jobs);
  }

  // レベル読み込み（固定配置）
  async function loadLevel(){
    const resp = await fetch("data/level_001.json");
    const lvl = await resp.json();

    PXGrid.COLS = CONFIG.COLS;
    PXGrid.R = CONFIG.R;
    PXGrid.TOP_MARGIN = CONFIG.TOP_MARGIN;

    board = PXGrid.createBoard(CONFIG.BOARD_ROWS, CONFIG.COLS);

    // rowsは文字列の配列。トークンは "R G B _" 形式。
    const codeToColor = lvl.palette; // 例: {"R":"#FF4D4D", ...}
    for (let r = 0; r < lvl.rows.length; r++){
      const rowStr = lvl.rows[r];
      const tokens = rowStr.split(/\s+/).filter(Boolean);
      for (let c = 0; c < tokens.length; c++){
        const t = tokens[c];
        if (t === "_") continue;
        const color = codeToColor[t] || t; // 直接#hexでもOK
        const avatarId = pickAvatarForColor(color);
        if (c < CONFIG.COLS) board[r][c] = { color, avatarId };
      }
    }
  }

  // その色に属するアバターをラウンドロビンで選ぶ
  const rrIndex = {};
  function pickAvatarForColor(color){
    const pool = avatars.filter(a => a.color.toLowerCase() === color.toLowerCase());
    if (!pool.length) {
      // 色未登録なら全体から循環
      if (!rrIndex["_all"]) rrIndex["_all"] = 0;
      const id = poolAll()[rrIndex["_all"] % avatars.length].id;
      rrIndex["_all"]++;
      return id;
    }
    const key = `clr:${color}`;
    if (!rrIndex[key]) rrIndex[key] = 0;
    const id = pool[rrIndex[key] % pool.length].id;
    rrIndex[key]++;
    return id;
  }
  function poolAll(){ return avatars; }

  // 次弾を決める（盤面に存在する色限定）
  function makeNextBall(){
    const colors = PXGrid.existingColors(board);
    const color = colors.length ? colors[Math.floor(Math.random()*colors.length)]
                                : palette[Math.floor(Math.random()*palette.length)];
    const avatarId = pickAvatarForColor(color);
    return { color, avatarId };
  }

  // 初期化
  async function init(){
    await loadAvatars();
    await loadLevel();
    shooter = { x: cv.width/2, y: cv.height - CONFIG.BOTTOM_MARGIN };
    dropOffsetY = 0;
    shotsUsed = 0;
    state = "ready";
    moving = null;
    nextBall = makeNextBall();
    shotsLeftEl.textContent = CONFIG.CEILING_DROP_PER_SHOTS - (shotsUsed % CONFIG.CEILING_DROP_PER_SHOTS);
    hideOverlay();
    loop(0);
  }

  // 発射
  function fire(){
    if (state !== "ready" || !nextBall) return;
    const dx = aim.x - shooter.x, dy = aim.y - shooter.y;
    const len = Math.hypot(dx,dy) || 1;
    const ux = dx/len, uy = dy/len;
    moving = {
      x: shooter.x, y: shooter.y, r: CONFIG.R,
      vx: ux * CONFIG.SHOT_SPEED, vy: uy * CONFIG.SHOT_SPEED,
      color: nextBall.color, avatarId: nextBall.avatarId
    };
    state = "firing";
    nextBall = makeNextBall();
  }

  // 盤面に玉を置く
  function placeAt(row,col,ball){
    if (!PXGrid.inBounds(board,row,col)) return false;
    if (row >= board.length) return false;
    board[row][col] = { color: ball.color, avatarId: ball.avatarId };
    return true;
  }

  // 消去・浮遊塊除去
  function handleMatchesAndFalls(sr, sc){
    const cluster = PXGrid.findCluster(board, sr, sc);
    let removed = 0;
    if (cluster.length >= CONFIG.CLEAR_MATCH){
      for (const {r,c} of cluster){
        board[r][c] = null;
      }
      removed += cluster.length;

      // 浮遊塊除去：天井連結以外
      const connected = PXGrid.findCeilingConnected(board);
      for (let r = 0; r < board.length; r++){
        for (let c = 0; c < CONFIG.COLS; c++){
          const cell = board[r][c];
          if (!cell) continue;
          const key = `${r},${c}`;
          if (!connected.has(key)){
            board[r][c] = null; // 落下扱い（演出省略）
            removed++;
          }
        }
      }
    }
    return removed;
  }

  // クリア判定（盤面が空）
  function isCleared(){
    for (let r = 0; r < board.length; r++){
      for (let c = 0; c < CONFIG.COLS; c++){
        if (board[r][c]) return false;
      }
    }
    return true;
  }

  // ゲームオーバー判定（任意のセルが危険ラインを下回ったら）
  function isGameOver(){
    const bottomY = cv.height - CONFIG.BOTTOM_MARGIN;
    for (let r = 0; r < board.length; r++){
      for (let c = 0; c < CONFIG.COLS; c++){
        const cell = board[r][c];
        if (!cell) continue;
        const {x,y} = PXGrid.cellCenter(r,c,dropOffsetY);
        if (y + CONFIG.R >= bottomY) return true;
      }
    }
    return false;
  }

  // 1段降下
  function dropCeilingIfNeeded(){
    if (shotsUsed > 0 && shotsUsed % CONFIG.CEILING_DROP_PER_SHOTS === 0){
      dropOffsetY += PXGrid.ROW_H;
    }
  }

  // 入力（マウス/タッチ）
  cv.addEventListener("mousemove", e=>{
    const rect = cv.getBoundingClientRect();
    const scaleX = cv.width / rect.width;
    const scaleY = cv.height / rect.height;
    const x = (e.clientX - rect.left) * scaleX;
    const y = (e.clientY - rect.top) * scaleY;
    aim.x = x; aim.y = y;
  });
  cv.addEventListener("click", ()=> fire());
  // タッチ
  cv.addEventListener("touchstart", (e)=>{
    const t = e.touches[0];
    const rect = cv.getBoundingClientRect();
    const scaleX = cv.width / rect.width;
    const scaleY = cv.height / rect.height;
    const x = (t.clientX - rect.left) * scaleX;
    const y = (t.clientY - rect.top) * scaleY;
    aim.x = x; aim.y = y;
    e.preventDefault();
  }, {passive:false});
  cv.addEventListener("touchend", (e)=>{ fire(); e.preventDefault(); }, {passive:false});

  // ボタン
  btnPause.addEventListener("click", ()=>{
    if (state === "paused") return;
    state = "paused";
    showOverlay("PAUSED");
  });
  btnRetry.addEventListener("click", ()=> reset());
  btnResume.addEventListener("click", ()=>{
    if (state !== "paused") return;
    hideOverlay();
    state = "ready";
  });
  btnOverlayRetry.addEventListener("click", ()=> reset());

  // リセット
  async function reset(){
    await loadLevel();
    dropOffsetY = 0;
    shotsUsed = 0;
    moving = null;
    nextBall = makeNextBall();
    state = "ready";
    shotsLeftEl.textContent = CONFIG.CEILING_DROP_PER_SHOTS - (shotsUsed % CONFIG.CEILING_DROP_PER_SHOTS);
    hideOverlay();
  }

  // オーバーレイ
  function showOverlay(text){
    overlayText.textContent = text;
    overlay.classList.remove("hidden");
    // クリア/オーバーのときはResumeを隠す
    const resumeBtn = document.getElementById("btnResume");
    if (text === "GAME OVER" || text === "GAME CLEAR!"){
      resumeBtn.style.display = "none";
    } else {
      resumeBtn.style.display = "";
    }
  }
  function hideOverlay(){ overlay.classList.add("hidden"); }

  // メインループ
  let last = 0;
  function loop(ts){
    const dt = (ts - last) / 1000 || 0; // sec
    last = ts;

    // 更新
    if (state === "firing" && moving){
      // 移動
      moving.x += moving.vx * dt;
      moving.y += moving.vy * dt;

      // 反射
      PXPhys.reflectIfNeeded(moving, {
        left: CONFIG.LEFT_MARGIN,
        right: cv.width - CONFIG.RIGHT_MARGIN
      });

      // 天井HITでスナップ
      if (PXPhys.hitCeiling(moving, CONFIG.TOP_MARGIN + 24 + dropOffsetY, CONFIG.R)){
        // 行0で近い列にスナップ
        const cells = PXGrid.nearbyCells(moving.x, moving.y, dropOffsetY);
        let best = null, bestD2 = 1e15;
        for (const cell of cells){
          if (cell.row !== 0) continue;
          if (board[cell.row][cell.col]) continue;
          const ctr = PXGrid.cellCenter(cell.row, cell.col, dropOffsetY);
          const d2 = (ctr.x-moving.x)**2 + (ctr.y-moving.y)**2;
          if (d2 < bestD2){ bestD2 = d2; best = cell; }
        }
        if (best){
          placeAt(best.row, best.col, moving);
          const removed = handleMatchesAndFalls(best.row, best.col);
          moving = null;
          shotsUsed++;
          dropCeilingIfNeeded();
          state = "ready";
        } else {
          // 空きが無ければ少し下で探す
          moving.y += 1; // 小さく進める
        }
      } else {
        // 既存セルとの衝突
        const col = PXPhys.checkCollision(moving, board, dropOffsetY, CONFIG.R);
        if (col.hit){
          const snap = PXPhys.chooseSnapCell(board, dropOffsetY, CONFIG.R, moving.x, moving.y, {r:col.r, c:col.c});
          if (snap){
            placeAt(snap.row, snap.col, moving);
            const removed = handleMatchesAndFalls(snap.row, snap.col);
            moving = null;
            shotsUsed++;
            dropCeilingIfNeeded();
            state = "ready";
          } else {
            // 稀ケース: 隙間が無い → 少し戻す
            moving.x -= moving.vx * dt;
            moving.y -= moving.vy * dt;
          }
        }
      }
    }

    // 判定
    if (state !== "paused" && state !== "over" && state !== "clear"){
      if (isGameOver()){
        state = "over";
        showOverlay("GAME OVER");
      } else if (isCleared()){
        state = "clear";
        showOverlay("GAME CLEAR!");
      }
    }

    // HUD
    shotsLeftEl.textContent = CONFIG.CEILING_DROP_PER_SHOTS - (shotsUsed % CONFIG.CEILING_DROP_PER_SHOTS);

    // 描画
    ctx.clearRect(0,0,cv.width,cv.height);

    // フィールド枠（薄い）
    ctx.strokeStyle = "rgba(255,255,255,.08)";
    ctx.lineWidth = 2;
    ctx.strokeRect(CONFIG.LEFT_MARGIN, CONFIG.TOP_MARGIN, cv.width - CONFIG.LEFT_MARGIN - CONFIG.RIGHT_MARGIN, cv.height - CONFIG.TOP_MARGIN - CONFIG.BOTTOM_MARGIN);

    // 盤面
    PXRender.drawBoard(ctx, board, dropOffsetY, CONFIG.R, images);

    // 照準ガイド
    if (state === "ready"){
      PXRender.drawAimGuide(ctx, shooter.x, shooter.y, aim.x, aim.y);
    }

    // 発射中の玉
    if (moving){
      const img = images[moving.avatarId];
      PXRender.drawAvatarBubble(ctx, img, moving.x, moving.y, CONFIG.R, moving.color);
    }

    // シューター位置の目印
    ctx.fillStyle = "#fff";
    ctx.globalAlpha = .15;
    ctx.beginPath(); ctx.arc(shooter.x, shooter.y, CONFIG.R*0.9, 0, Math.PI*2); ctx.fill();
    ctx.globalAlpha = 1;

    // 次弾
    PXRender.drawNext(cvNext, nextBall, CONFIG.R, images);

    requestAnimationFrame(loop);
  }

  init();
})();
