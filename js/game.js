// game.js - ランダム初期配置 + サウンド対応 + Autoplay解禁 + モバイル操作 + 発射/付着SFX

(() => {
  // ====== 基本設定 ======
  const CONFIG = {
    COLS: 12,
    R: 18,
    BOARD_ROWS: 18,
    SHOT_SPEED: 640,
    CEILING_DROP_PER_SHOTS: 8,   // N発ごとに1段降下
    CLEAR_MATCH: 3,              // 同色3個以上で消去
    LEFT_MARGIN: 24, RIGHT_MARGIN: 24, TOP_MARGIN: 24, BOTTOM_MARGIN: 96,

    AIM_Y_OFFSET_MOBILE: 160,    // モバイルの狙いY固定オフセット
    MIN_AIM_ANGLE_DEG: 7,        // 水平すぎを防ぐ最小射角（度）

    INIT_ROWS: 6,                // 初期段数（難易度）
    EMPTY_RATE: 0.1              // 空マス率（難易度）
  };

  // ====== DOM ======
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

  // ====== ステート ======
  let images = {};         // avatarId -> HTMLImageElement
  let avatars = [];        // [{id,file,color}]
  let palette = [];        // ["#..",...]
  let board = null;        // [row][col] -> {color, avatarId} | null
  let dropOffsetY = 0;     // 天井降下オフセット
  let shotsUsed = 0;
  let state = "ready";     // ready | firing | paused | over | clear
  let shooter = null;      // {x,y}
  let aim = {x: 0, y: 0};  // 照準点
  let moving = null;       // 発射中の玉 {x,y,vx,vy,r,color,avatarId}
  let nextBall = null;

  // タッチ状態
  let touchAiming = false;
  let activeTouchId = null;

  // ====== サウンド ======
  let bgm;
  let audioUnlocked = false;

  function playBGM(){
    if (!bgm){
      bgm = new Audio("assets/sound/bgm.mp3"); // フォルダは sound
      bgm.loop = true;
      bgm.volume = 0.4;
    }
    bgm.play().catch(()=>{ /* ユーザー操作前は失敗する */ });
  }
  function stopBGM(){ if (bgm) bgm.pause(); }

  // 共通の発射音
  function playShotSfx(){
    const snd = new Audio("assets/sound/shot.mp3");
    snd.volume = 0.5;
    snd.play().catch(()=>{});
  }
  // 付着（スナップ）音
  function playHitSfx(){
    const snd = new Audio("assets/sound/hit.mp3");
    snd.volume = 0.6;
    snd.play().catch(()=>{});
  }

  // 個別ボイス（発射）
  function playFireVoice(avatarId){
    const snd = new Audio(`assets/sound/fire_${avatarId}.mp3`);
    snd.volume = 0.7;
    snd.play().catch(()=>{});
  }
  // 個別ボイス（消滅）
  function playClearVoice(avatarId){
    const snd = new Audio(`assets/sound/clear_${avatarId}.mp3`);
    snd.volume = 0.8;
    snd.play().catch(()=>{});
  }

  // ★ 最初のユーザー操作でオーディオを解禁
  function unlockAudio(){
    if (audioUnlocked) return;
    audioUnlocked = true;
    playBGM();
    // 以後不要なのでリスナー解除
    document.removeEventListener("pointerdown", unlockAudio);
    document.removeEventListener("keydown", unlockAudio);
    document.removeEventListener("touchend", unlockAudio, {passive:false});
    cv.removeEventListener("click", unlockAudio);
    cv.removeEventListener("touchstart", unlockAudio, {passive:false});
  }
  document.addEventListener("pointerdown", unlockAudio);
  document.addEventListener("keydown", unlockAudio);
  document.addEventListener("touchend", unlockAudio, {passive:false});
  cv.addEventListener("click", unlockAudio);
  cv.addEventListener("touchstart", unlockAudio, {passive:false});

  // ====== 画像ローダー（カンマ拡張子にも対応） ======
  const BLOB_URLS = [];
  window.addEventListener("unload", () => { BLOB_URLS.forEach(u => URL.revokeObjectURL(u)); });

  function guessMimeFromName(name){
    const mDot = name.match(/\.([a-zA-Z0-9]+)(?:\?.*)?$/);
    const mComma = name.match(/,([a-zA-Z0-9]+)$/);
    const ext = (mDot && mDot[1]) || (mComma && mComma[1]) || "";
    const lower = (ext || "").toLowerCase();
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
      }catch(err){ reject(err); }
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

  // ====== ランダム初期配置 ======
  async function loadLevel(){
    board = PXGrid.createBoard(CONFIG.BOARD_ROWS, CONFIG.COLS);
    for (let r = 0; r < CONFIG.INIT_ROWS; r++){
      for (let c = 0; c < CONFIG.COLS; c++){
        if (Math.random() < CONFIG.EMPTY_RATE) continue; // 空マス
        const avatar = avatars[Math.floor(Math.random() * avatars.length)];
        board[r][c] = { color: avatar.color, avatarId: avatar.id };
      }
    }
  }

  // 次弾：盤に存在する色から選択（無ければpaletteから）
  function makeNextBall(){
    const colors = PXGrid.existingColors(board);
    const color = colors.length
      ? colors[Math.floor(Math.random()*colors.length)]
      : palette[Math.floor(Math.random()*palette.length)];
    const pool = avatars.filter(a => a.color.toLowerCase() === color.toLowerCase());
    const avatar = pool.length
      ? pool[Math.floor(Math.random() * pool.length)]
      : avatars[Math.floor(Math.random() * avatars.length)];
    return { color: avatar.color, avatarId: avatar.id };
  }

  // ====== 初期化 ======
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
    // BGMは unlockAudio で開始する
    loop(0);
  }

  // ====== 入力（PCマウス） ======
  cv.addEventListener("mousemove", e=>{
    if (touchAiming) return; // タッチ中は無視
    const {x,y} = clientToCanvas(e.clientX, e.clientY);
    aim.x = clampAimX(x);
    aim.y = Math.min(y, shooter.y - 12);
  });
  cv.addEventListener("click", ()=>{ if (state === "ready") fire(); });

  // ====== 入力（モバイル：押しっぱ→左右スライド→離して発射） ======
  cv.addEventListener("touchstart", (e)=>{
    if (e.changedTouches.length === 0) return;
    const t = e.changedTouches[0];
    const {x} = clientToCanvas(t.clientX, t.clientY);
    touchAiming = true;
    activeTouchId = t.identifier;
    aim.x = clampAimX(x);
    aim.y = shooter.y - CONFIG.AIM_Y_OFFSET_MOBILE;
    e.preventDefault();
  }, {passive:false});

  cv.addEventListener("touchmove", (e)=>{
    if (!touchAiming) return;
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

  // ====== ユーティリティ ======
  function clientToCanvas(clientX, clientY){
    const rect = cv.getBoundingClientRect();
    const scaleX = cv.width / rect.width;
    const scaleY = cv.height / rect.height;
    return { x: (clientX - rect.left) * scaleX, y: (clientY - rect.top) * scaleY };
  }

  function clampAimX(x){
    const minX = CONFIG.LEFT_MARGIN + CONFIG.R;
    const maxX = cv.width - CONFIG.RIGHT_MARGIN - CONFIG.R;
    return Math.min(maxX, Math.max(minX, x));
  }

  function applyMinAngle(vx, vy){
    const angle = Math.atan2(-vy, vx);
    const min = CONFIG.MIN_AIM_ANGLE_DEG * Math.PI / 180;
    const sign = angle < 0 ? -1 : 1;
    if (Math.abs(angle) < min){
      const a = sign * min;
      const speed = Math.hypot(vx, vy) || 1;
      return { vx: Math.cos(a) * speed, vy: -Math.sin(a) * speed };
    }
    return { vx, vy };
  }

  // ====== 発射 ======
  function fire(){
    if (state !== "ready" || !nextBall) return;
    let dx = aim.x - shooter.x;
    let dy = aim.y - shooter.y;
    if (dy >= -4) dy = -4; // 上方向限定
    const len = Math.hypot(dx,dy) || 1;
    let vx = (dx/len) * CONFIG.SHOT_SPEED;
    let vy = (dy/len) * CONFIG.SHOT_SPEED;
    ({vx, vy} = applyMinAngle(vx, vy));
    moving = {
      x: shooter.x, y: shooter.y, r: CONFIG.R,
      vx, vy,
      color: nextBall.color, avatarId: nextBall.avatarId
    };
    state = "firing";

    // 共通発射音 + 個別ボイス
    playShotSfx();
    playFireVoice(nextBall.avatarId);

    nextBall = makeNextBall();
  }

  // ====== 配置・消去 ======
  function placeAt(row,col,ball){
    if (!PXGrid.inBounds(board,row,col)) return false;
    if (row >= board.length) return false;
    board[row][col] = { color: ball.color, avatarId: ball.avatarId };
    return true;
  }

  function handleMatchesAndFalls(sr, sc){
    const cluster = PXGrid.findCluster(board, sr, sc);
    if (cluster.length >= CONFIG.CLEAR_MATCH){
      for (const {r,c} of cluster){
        if (board[r][c]){
          playClearVoice(board[r][c].avatarId);
          board[r][c] = null;
        }
      }
      // 天井連結以外を落とす
      const connected = PXGrid.findCeilingConnected(board);
      for (let r = 0; r < board.length; r++){
        for (let c = 0; c < PXGrid.COLS; c++){
          const cell = board[r][c];
          if (!cell) continue;
          const key = `${r},${c}`;
          if (!connected.has(key)){
            playClearVoice(cell.avatarId); // 落下もボイスOK
            board[r][c] = null;
          }
        }
      }
    }
  }

  // ====== 判定 ======
  function isCleared(){
    for (let r = 0; r < board.length; r++){
      for (let c = 0; c < PXGrid.COLS; c++){
        if (board[r][c]) return false;
      }
    }
    return true;
  }

  function isGameOver(){
    const bottomY = cv.height - CONFIG.BOTTOM_MARGIN;
    for (let r = 0; r < board.length; r++){
      for (let c = 0; c < PXGrid.COLS; c++){
        const cell = board[r][c];
        if (!cell) continue;
        const {x,y} = PXGrid.cellCenter(r,c,dropOffsetY);
        if (y + CONFIG.R >= bottomY) return true;
      }
    }
    return false;
  }

  function dropCeilingIfNeeded(){
    if (shotsUsed > 0 && shotsUsed % CONFIG.CEILING_DROP_PER_SHOTS === 0){
      dropOffsetY += PXGrid.ROW_H;
    }
  }

  // ====== UIボタン ======
  btnPause.addEventListener("click", ()=>{
    if (state === "paused") return;
    state = "paused";
    stopBGM();
    showOverlay("PAUSED");
  });
  btnRetry.addEventListener("click", ()=> reset());
  btnResume.addEventListener("click", ()=>{
    if (state !== "paused") return;
    hideOverlay();
    state = "ready";
    if (audioUnlocked) playBGM();
  });
  btnOverlayRetry.addEventListener("click", ()=> reset());

  async function reset(){
    await loadLevel();
    dropOffsetY = 0;
    shotsUsed = 0;
    moving = null;
    nextBall = makeNextBall();
    state = "ready";
    shotsLeftEl.textContent = CONFIG.CEILING_DROP_PER_SHOTS - (shotsUsed % CONFIG.CEILING_DROP_PER_SHOTS);
    hideOverlay();
    if (audioUnlocked) playBGM();
  }

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

  // ====== メインループ ======
  let last = 0;
  function loop(ts){
    const dt = (ts - last) / 1000 || 0;
    last = ts;

    if (state === "firing" && moving){
      // 位置更新
      moving.x += moving.vx * dt;
      moving.y += moving.vy * dt;

      // 壁反射
      PXPhys.reflectIfNeeded(moving, {
        left: CONFIG.LEFT_MARGIN,
        right: cv.width - CONFIG.RIGHT_MARGIN
      });

      // 天井ヒット → スナップして結合
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

          // ★付着音
          playHitSfx();

          handleMatchesAndFalls(best.row, best.col);
          moving = null;
          shotsUsed++;
          dropCeilingIfNeeded();
          state = "ready";
        } else {
          // まれに最適スナップ無しの場合の微調整
          moving.y += 1;
        }
      } else {
        // 既存セルと衝突
        const col = PXPhys.checkCollision(moving, board, dropOffsetY, CONFIG.R);
        if (col.hit){
          const snap = PXPhys.chooseSnapCell(board, dropOffsetY, CONFIG.R, moving.x, moving.y, {r:col.r, c:col.c});
          if (snap){
            placeAt(snap.row, snap.col, moving);

            // ★付着音
            playHitSfx();

            handleMatchesAndFalls(snap.row, snap.col);
            moving = null;
            shotsUsed++;
            dropCeilingIfNeeded();
            state = "ready";
          } else {
            // 一歩戻して再評価（衝突分離の保険）
            moving.x -= moving.vx * dt;
            moving.y -= moving.vy * dt;
          }
        }
      }
    }

    // 進行中のステータス判定
    if (state !== "paused" && state !== "over" && state !== "clear"){
      if (isGameOver()){
        state = "over";
        stopBGM();
        showOverlay("GAME OVER");
      } else if (isCleared()){
        state = "clear";
        stopBGM();
        showOverlay("GAME CLEAR!");
      }
    }

    // HUD
    shotsLeftEl.textContent = CONFIG.CEILING_DROP_PER_SHOTS - (shotsUsed % CONFIG.CEILING_DROP_PER_SHOTS);

    // 描画
    ctx.clearRect(0,0,cv.width,cv.height);

    // フィールドの薄い枠
    ctx.strokeStyle = "rgba(255,255,255,.08)";
    ctx.lineWidth = 2;
    ctx.strokeRect(
      CONFIG.LEFT_MARGIN,
      CONFIG.TOP_MARGIN,
      cv.width - CONFIG.LEFT_MARGIN - CONFIG.RIGHT_MARGIN,
      cv.height - CONFIG.TOP_MARGIN - CONFIG.BOTTOM_MARGIN
    );

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

  // ====== 起動 ======
  init();
})();
