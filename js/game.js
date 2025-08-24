// game.js - 状態管理／入力／ループ（タッチ操作：押しっぱで左右スライド照準→離して発射）

(() => {
  // ====== 基本設定 ======
  const CONFIG = {
    COLS: 12,
    R: 18,                       // 玉半径(px)
    BOARD_ROWS: 18,              // 盤の最大行
    SHOT_SPEED: 640,             // px/sec
    CEILING_DROP_PER_SHOTS: 8,   // N発ごとに1段降下
    CLEAR_MATCH: 3,              // 同色3個以上で消去
    LEFT_MARGIN: 24, RIGHT_MARGIN: 24, TOP_MARGIN: 24, BOTTOM_MARGIN: 96,

    AIM_Y_OFFSET_MOBILE: 160,    // モバイル時：狙い点の固定高さ（シューターから上方向の距離）
    MIN_AIM_ANGLE_DEG: 7         // 最小射角（水平に近すぎるのを防ぐ）
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
  let images = {};         // avatarId -> HTMLImageElement
  let avatars = [];        // [{id,file,color}]
  let palette = [];        // ["#..",...]
  let board = null;        // [row][col] -> {color, avatarId}
  let dropOffsetY = 0;     // 天井降下の累計オフセット
  let shotsUsed = 0;
  let state = "ready";     // ready | firing | settle | paused | over | clear
  let shooter = null;      // {x,y}
  let aim = {x: 0, y: 0};  // 照準点
  let moving = null;       // 発射中の玉 {x,y,vx,vy,r,color,avatarId}
  let nextBall = null;

  // タッチ状態
  let touchAiming = false;
  let activeTouchId = null;

  // ====== 画像ローダー（noroi,png 等のファイル名にも対応） ======
  const BLOB_URLS = [];
  window.addEventListener("unload", () => { BLOB_URLS.forEach(u => URL.revokeObjectURL(u)); });

  function guessMimeFromName(name){
    const mDot = name.match(/\.([a-zA-Z0-9]+)(?:\?.*)?$/);
    const mComma = name.match(/,([a-zA-Z0-9]+)$/);
    const ext = (mDot && mDot[1]) || (mComma && mComma[1]) || "";
    const lower = ext.toLowerCase();
    if (lower === "png")  return "image/png";
    if (lower === "jpg" || lower === "jpeg") return "image/jpeg";
    if (lower === "webp") return "image/webp";
    if (lower === "gif")  return "image/gif";
    return "";
  }

  function loadImageSmart(url){
    return new Promise(async (resolve, reject) => {
      const hasDotExt = /\.[a-zA-Z0-9]+(?:\?.*)?$/.test(url);
      if (hasDotExt) {
        const img = new Image();
        img.src = url + (url.includes("?") ? "" : "?v=1");
        img.onload = () => resolve(img);
        img.onerror = (e) => reject(e);
        return;
      }
      try{
        const res = await fetch(url, { cache: "reload" });
        const buf = await res.arrayBuffer();
        const mime = guessMimeFromName(url) || "image/png";
        const blob = new Blob([buf], { type: mime });
        const objUrl = URL.createObjectURL(blob);
        BLOB_URLS.push(objUrl);
        const img = new Image();
        img.src = objUrl;
        img.onload = () => resolve(img);
        img.onerror = (e) => reject(e);
      }catch(err){
        reject(err);
      }
    });
  }

  // ====== データ読み込み ======
  async function loadAvatars(){
    const resp = await fetch("data/avatars.json");
    const data = await resp.json();
    palette = data.palette;
    avatars = data.avatars;

    const jobs = avatars.map(a =>
      loadImageSmart(a.file).then(img => { images[a.id] = img; })
    );
    await Promise.all(jobs);
  }

  async function loadLevel(){
    const resp = await fetch("data/level_001.json");
    const lvl = await resp.json();

    PXGrid.COLS = CONFIG.COLS;
    PXGrid.R = CONFIG.R;
    PXGrid.TOP_MARGIN = CONFIG.TOP_MARGIN;

    board = PXGrid.createBoard(CONFIG.BOARD_ROWS, CONFIG.COLS);

    const codeToColor = lvl.palette;
    for (let r = 0; r < lvl.rows.length; r++){
      const tokens = lvl.rows[r].split(/\s+/).filter(Boolean);
      for (let c = 0; c < tokens.length; c++){
        const t = tokens[c];
        if (t === "_") continue;
        const color = codeToColor[t] || t;
        const avatarId = pickAvatarForColor(color);
        if (c < CONFIG.COLS) board[r][c] = { color, avatarId };
      }
    }
  }

  // 色→アバター（ラウンドロビン）
  const rrIndex = {};
  function pickAvatarForColor(color){
    const pool = avatars.filter(a => a.color.toLowerCase() === color.toLowerCase());
    if (!pool.length) {
      if (!rrIndex["_all"]) rrIndex["_all"] = 0;
      const id = avatars[rrIndex["_all"] % avatars.length].id;
      rrIndex["_all"]++;
      return id;
    }
    const key = `clr:${color}`;
    if (!rrIndex[key]) rrIndex[key] = 0;
    const id = pool[rrIndex[key] % pool.length].id;
    rrIndex[key]++;
    return id;
  }

  // 次弾（盤に存在する色限定）
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
    aim.x = shooter.x;
    aim.y = shooter.y - CONFIG.AIM_Y_OFFSET_MOBILE;
    dropOffsetY = 0;
    shotsUsed = 0;
    state = "ready";
    moving = null;
    nextBall = makeNextBall();
    shotsLeftEl.textContent = CONFIG.CEILING_DROP_PER_SHOTS - (shotsUsed % CONFIG.CEILING_DROP_PER_SHOTS);
    hideOverlay();
    loop(0);
  }

  // ====== 入力（PCマウス） ======
  cv.addEventListener("mousemove", e=>{
    if (touchAiming) return; // タッチ中はマウスを無視
    const {x,y} = clientToCanvas(e.clientX, e.clientY);
    aim.x = clampAimX(x);
    aim.y = Math.min(y, shooter.y - 12); // なるべく上方向に
  });
  cv.addEventListener("click", ()=>{
    if (state === "ready") fire();
  });

  // ====== 入力（モバイルタッチ：押しっぱ→左右スライド→指を離して発射） ======
  cv.addEventListener("touchstart", (e)=>{
    if (e.changedTouches.length === 0) return;
    const t = e.changedTouches[0];
    const {x} = clientToCanvas(t.clientX, t.clientY);
    touchAiming = true;
    activeTouchId = t.identifier;
    // 照準はY固定（画面比で打ちやすい高さ）
    aim.x = clampAimX(x);
    aim.y = shooter.y - CONFIG.AIM_Y_OFFSET_MOBILE;
    e.preventDefault();
  }, {passive:false});

  cv.addEventListener("touchmove", (e)=>{
    if (!touchAiming) return;
    // アクティブな指のみ追う
    const t = findTouch(e.changedTouches, activeTouchId);
    if (!t) return;
    const {x} = clientToCanvas(t.clientX, t.clientY);
    aim.x = clampAimX(x);
    aim.y = shooter.y - CONFIG.AIM_Y_OFFSET_MOBILE;
    e.preventDefault();
  }, {passive:false});

  cv.addEventListener("touchend", (e)=>{
    if (!touchAiming) return;
    const t = findTouch(e.changedTouches, activeTouchId);
    if (!t) return;
    touchAiming = false;
    activeTouchId = null;
    // 指を離したら発射
    if (state === "ready") fire();
    e.preventDefault();
  }, {passive:false});

  cv.addEventListener("touchcancel", (e)=>{
    if (!touchAiming) return;
    const t = findTouch(e.changedTouches, activeTouchId);
    if (!t) return;
    touchAiming = false;
    activeTouchId = null;
    e.preventDefault();
  }, {passive:false});

  function findTouch(touchList, id){
    for (let i=0;i<touchList.length;i++){
      if (touchList[i].identifier === id) return touchList[i];
    }
    return null;
  }

  // 画面座標→キャンバス座標
  function clientToCanvas(clientX, clientY){
    const rect = cv.getBoundingClientRect();
    const scaleX = cv.width / rect.width;
    const scaleY = cv.height / rect.height;
    return {
      x: (clientX - rect.left) * scaleX,
      y: (clientY - rect.top) * scaleY
    };
  }

  // 狙いXの範囲をフィールド内に制限（壁反射直後の無理角度を避ける）
  function clampAimX(x){
    const minX = CONFIG.LEFT_MARGIN + CONFIG.R;
    const maxX = cv.width - CONFIG.RIGHT_MARGIN - CONFIG.R;
    return Math.min(maxX, Math.max(minX, x));
  }

  // 最小射角の適用（水平に近すぎるのを防ぐ）
  function applyMinAngle(vx, vy){
    // 角度（水平からの偏角）
    const angle = Math.atan2(-vy, vx); // 上向きを正にしたいので -vy
    const min = CONFIG.MIN_AIM_ANGLE_DEG * Math.PI / 180;
    const sign = angle < 0 ? -1 : 1;
    if (Math.abs(angle) < min){
      const a = sign * min;
      const speed = Math.hypot(vx, vy) || 1;
      return { vx: Math.cos(a) * speed, vy: -Math.sin(a) * speed };
    }
    return { vx, vy };
  }

  // 発射
  function fire(){
    if (state !== "ready" || !nextBall) return;

    // ベクトル（シューター→狙い）
    let dx = aim.x - shooter.x;
    let dy = aim.y - shooter.y;
    // 上方向限定（万一dyが0以上なら少し上に）
    if (dy >= -4) dy = -4;

    const len = Math.hypot(dx,dy) || 1;
    let vx = (dx/len) * CONFIG.SHOT_SPEED;
    let vy = (dy/len) * CONFIG.SHOT_SPEED;

    // 最小射角の適用
    ({vx, vy} = applyMinAngle(vx, vy));

    moving = {
      x: shooter.x, y: shooter.y, r: CONFIG.R,
      vx, vy,
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
      for (const {r,c} of cluster){ board[r][c] = null; }
      removed += cluster.length;

      const connected = PXGrid.findCeilingConnected(board);
      for (let r = 0; r < board.length; r++){
        for (let c = 0; c < CONFIG.COLS; c++){
          const cell = board[r][c];
          if (!cell) continue;
          const key = `${r},${c}`;
          if (!connected.has(key)){
            board[r][c] = null; // 落下（演出省略）
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

  // ゲームオーバー判定
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
    const dt = (ts - last) / 1000 || 0;
    last = ts;

    if (state === "firing" && moving){
      // 移動
      moving.x += moving.vx * dt;
      moving.y += moving.vy * dt;

      // 壁反射
      PXPhys.reflectIfNeeded(moving, {
        left: CONFIG.LEFT_MARGIN,
        right: cv.width - CONFIG.RIGHT_MARGIN
      });

      // 天井HITでスナップ
      if (PXPhys.hitCeiling(moving, CONFIG.TOP_MARGIN + 24 + dropOffsetY, CONFIG.R)){
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
          handleMatchesAndFalls(best.row, best.col);
          moving = null;
          shotsUsed++;
          dropCeilingIfNeeded();
          state = "ready";
        } else {
          moving.y += 1;
        }
      } else {
        // 既存セルとの衝突
        const col = PXPhys.checkCollision(moving, board, dropOffsetY, CONFIG.R);
        if (col.hit){
          const snap = PXPhys.chooseSnapCell(board, dropOffsetY, CONFIG.R, moving.x, moving.y, {r:col.r, c:col.c});
          if (snap){
            placeAt(snap.row, snap.col, moving);
            handleMatchesAndFalls(snap.row, snap.col);
            moving = null;
            shotsUsed++;
            dropCeilingIfNeeded();
            state = "ready";
          } else {
            // まれに隙間無し。少し戻して再計算
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

    // フィールド枠
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

    // シューター位置目印
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
