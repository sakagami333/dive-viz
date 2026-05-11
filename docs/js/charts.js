/**
 * Dive Log Visualizer — メインロジック
 * 依存: Leaflet.js (地図タブのみ CDN から読み込み)
 */

const App = (() => {
  let _data = null;
  let _map = null;
  let _activeTab = "list";

  // -----------------------------------------------------------------------
  // 初期化
  // -----------------------------------------------------------------------
  async function init() {
    showLoading(true);
    try {
      const res = await fetch("data.json");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      _data = await res.json();
    } catch (e) {
      showError(`data.json の読み込みに失敗しました: ${e.message}`);
      return;
    } finally {
      showLoading(false);
    }

    renderSummary(_data);
    renderDiveList(_data.dives, _data.sites);
    setupTabs();

    const ts = _data.generated_at
      ? new Date(_data.generated_at).toLocaleString("ja-JP")
      : "";
    if (ts) document.getElementById("updated-at").textContent = `更新: ${ts}`;
  }

  // -----------------------------------------------------------------------
  // サマリーカード
  // -----------------------------------------------------------------------
  function renderSummary(data) {
    const s = data.summary || {};
    setValue("stat-total", s.total_dives ?? "—");
    setValue("stat-time", s.total_time_min != null
      ? `${Math.floor(s.total_time_min / 60)}h ${Math.round(s.total_time_min % 60)}m`
      : "—");
    setValue("stat-maxdepth", s.max_depth_m != null ? `${s.max_depth_m} m` : "—");
    setValue("stat-sites", s.unique_sites ?? "—");

    if (s.date_range?.first && s.date_range?.last) {
      setValue("stat-period",
        `${s.date_range.first.slice(0, 7)} 〜 ${s.date_range.last.slice(0, 7)}`);
    }
  }

  // -----------------------------------------------------------------------
  // ダイブ一覧
  // -----------------------------------------------------------------------
  function renderDiveList(dives, sites) {
    const tbody = document.getElementById("dive-tbody");
    tbody.innerHTML = "";

    const sorted = [...dives].sort((a, b) =>
      (b.date + b.time).localeCompare(a.date + a.time)
    );

    sorted.forEach(d => {
      const tr = document.createElement("tr");
      tr.dataset.dive = JSON.stringify(d);
      tr.innerHTML = `
        <td class="num">${d.number ?? "—"}</td>
        <td>${d.date ?? "—"}</td>
        <td class="site-cell">${escHtml(d.site_name || "不明")}</td>
        <td class="num">${d.max_depth_m != null ? d.max_depth_m + " m" : "—"}</td>
        <td class="num">${d.duration_min != null ? d.duration_min + " min" : "—"}</td>
        <td class="num">${d.water_temp_c != null ? d.water_temp_c + " ℃" : "—"}</td>
        <td>${renderStars(d.rating)}</td>
      `;
      tr.addEventListener("click", () => openProfile(d));
      tbody.appendChild(tr);
    });

    setupSearch(sorted);
  }

  function renderStars(rating) {
    if (!rating) return "—";
    return "★".repeat(rating) + "☆".repeat(5 - rating);
  }

  function setupSearch(dives) {
    const input = document.getElementById("search-input");
    input.addEventListener("input", () => {
      const q = input.value.toLowerCase();
      document.querySelectorAll("#dive-tbody tr").forEach(tr => {
        const d = JSON.parse(tr.dataset.dive);
        const text = [d.site_name, d.date, ...(d.tags || []), d.notes]
          .join(" ").toLowerCase();
        tr.style.display = text.includes(q) ? "" : "none";
      });
    });
  }

  // -----------------------------------------------------------------------
  // 深度プロファイル
  // -----------------------------------------------------------------------
  function openProfile(dive) {
    switchTab("profile");
    drawProfile(dive);
    renderDiveDetail(dive);
  }

  function renderDiveDetail(d) {
    document.getElementById("profile-title").textContent =
      `#${d.number ?? "?"} ${d.date} ${d.site_name ? "— " + d.site_name : ""}`;
    document.getElementById("profile-meta").innerHTML = [
      d.max_depth_m != null ? `最大深度: <b>${d.max_depth_m} m</b>` : "",
      d.duration_min != null ? `潜水時間: <b>${d.duration_min} min</b>` : "",
      d.water_temp_c != null ? `水温: <b>${d.water_temp_c} ℃</b>` : "",
      d.dc_model ? `DC: ${escHtml(d.dc_model)}` : "",
      d.tags?.length ? `タグ: ${d.tags.map(escHtml).join(", ")}` : "",
      d.notes ? `<span class="notes">${escHtml(d.notes)}</span>` : "",
    ].filter(Boolean).join(" &nbsp;|&nbsp; ");
  }

  function drawProfile(dive) {
    const canvas = document.getElementById("profile-canvas");
    const ctx = canvas.getContext("2d");
    const W = canvas.width = canvas.offsetWidth;
    const H = canvas.height = 280;

    ctx.clearRect(0, 0, W, H);

    const profile = dive.profile || [];
    if (profile.length < 2) {
      ctx.fillStyle = "#666";
      ctx.font = "14px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("プロファイルデータなし", W / 2, H / 2);
      return;
    }

    const PAD = { top: 20, right: 20, bottom: 40, left: 55 };
    const maxT = Math.max(...profile.map(p => p.time_s ?? 0));
    const maxD = Math.max(...profile.map(p => p.depth_m ?? 0)) * 1.1;

    const toX = t => PAD.left + (t / maxT) * (W - PAD.left - PAD.right);
    const toY = d => PAD.top + (d / maxD) * (H - PAD.top - PAD.bottom);

    // 背景グラデーション
    const grad = ctx.createLinearGradient(0, PAD.top, 0, H - PAD.bottom);
    grad.addColorStop(0, "rgba(0, 120, 200, 0.6)");
    grad.addColorStop(1, "rgba(0, 30, 80, 0.9)");

    // プロファイル面
    ctx.beginPath();
    ctx.moveTo(toX(profile[0].time_s ?? 0), toY(0));
    profile.forEach(p => {
      if (p.time_s != null && p.depth_m != null)
        ctx.lineTo(toX(p.time_s), toY(p.depth_m));
    });
    ctx.lineTo(toX(maxT), toY(0));
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // プロファイル輪郭線
    ctx.beginPath();
    let first = true;
    profile.forEach(p => {
      if (p.time_s == null || p.depth_m == null) return;
      first ? ctx.moveTo(toX(p.time_s), toY(p.depth_m))
             : ctx.lineTo(toX(p.time_s), toY(p.depth_m));
      first = false;
    });
    ctx.strokeStyle = "#5bf";
    ctx.lineWidth = 2;
    ctx.stroke();

    // 温度ライン（あれば）
    const hasTempData = profile.some(p => p.temp_c != null);
    if (hasTempData) {
      const temps = profile.filter(p => p.temp_c != null);
      const minT = Math.min(...temps.map(p => p.temp_c));
      const maxTt = Math.max(...temps.map(p => p.temp_c));
      const toYt = t => PAD.top + (1 - (t - minT) / ((maxTt - minT) || 1)) * (H - PAD.top - PAD.bottom);
      ctx.beginPath();
      let fp = true;
      temps.forEach(p => {
        fp ? ctx.moveTo(toX(p.time_s), toYt(p.temp_c))
           : ctx.lineTo(toX(p.time_s), toYt(p.temp_c));
        fp = false;
      });
      ctx.strokeStyle = "#fa0";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    drawAxis(ctx, W, H, PAD, maxT, maxD);
  }

  function drawAxis(ctx, W, H, PAD, maxT, maxD) {
    ctx.strokeStyle = "#aaa";
    ctx.lineWidth = 1;
    ctx.fillStyle = "#ccc";
    ctx.font = "11px sans-serif";

    // Y 軸（深度）
    const depthSteps = niceSteps(maxD, 5);
    depthSteps.forEach(d => {
      const y = PAD.top + (d / maxD) * (H - PAD.top - PAD.bottom);
      ctx.beginPath();
      ctx.moveTo(PAD.left, y);
      ctx.lineTo(W - PAD.right, y);
      ctx.globalAlpha = 0.25;
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.textAlign = "right";
      ctx.fillText(`${d}m`, PAD.left - 5, y + 4);
    });

    // X 軸（時間）
    const timeSteps = niceSteps(maxT / 60, 6).map(v => v * 60);
    timeSteps.forEach(t => {
      const x = PAD.left + (t / maxT) * (W - PAD.left - PAD.right);
      ctx.beginPath();
      ctx.moveTo(x, PAD.top);
      ctx.lineTo(x, H - PAD.bottom);
      ctx.globalAlpha = 0.25;
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.textAlign = "center";
      ctx.fillText(`${Math.round(t / 60)}min`, x, H - PAD.bottom + 14);
    });

    // 軸ラベル
    ctx.save();
    ctx.translate(14, H / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = "center";
    ctx.fillStyle = "#aaa";
    ctx.fillText("深度 (m)", 0, 0);
    ctx.restore();
  }

  // -----------------------------------------------------------------------
  // 統計グラフ
  // -----------------------------------------------------------------------
  function renderStats(data) {
    if (!data) return;
    drawDivesPerYear(data.dives);
    drawDepthHistogram(data.dives);
    drawMonthlyChart(data.dives);
  }

  function drawDivesPerYear(dives) {
    const canvas = document.getElementById("chart-year");
    const counts = {};
    dives.forEach(d => {
      const y = (d.date || "").slice(0, 4);
      if (y) counts[y] = (counts[y] || 0) + 1;
    });
    const labels = Object.keys(counts).sort();
    const values = labels.map(y => counts[y]);
    drawBarChart(canvas, labels, values, "年別ダイブ数", "#1a8fe3");
  }

  function drawDepthHistogram(dives) {
    const canvas = document.getElementById("chart-depth");
    const bins = {};
    const STEP = 5;
    dives.forEach(d => {
      if (d.max_depth_m == null) return;
      const bin = Math.floor(d.max_depth_m / STEP) * STEP;
      const label = `${bin}–${bin + STEP}m`;
      bins[label] = (bins[label] || 0) + 1;
    });
    // 深度順でソート
    const sorted = Object.entries(bins).sort((a, b) => {
      const na = parseInt(a[0]);
      const nb = parseInt(b[0]);
      return na - nb;
    });
    drawBarChart(canvas, sorted.map(e => e[0]), sorted.map(e => e[1]),
      "深度分布 (5m 刻み)", "#0e9e6e");
  }

  function drawMonthlyChart(dives) {
    const canvas = document.getElementById("chart-month");
    const counts = Array(12).fill(0);
    dives.forEach(d => {
      const m = parseInt((d.date || "").slice(5, 7));
      if (m >= 1 && m <= 12) counts[m - 1]++;
    });
    const labels = ["1月","2月","3月","4月","5月","6月",
                    "7月","8月","9月","10月","11月","12月"];
    drawBarChart(canvas, labels, counts, "月別ダイブ数", "#d4621a");
  }

  function drawBarChart(canvas, labels, values, title, color) {
    const W = canvas.width = canvas.offsetWidth;
    const H = canvas.height = 220;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, W, H);

    const PAD = { top: 30, right: 15, bottom: 45, left: 45 };
    const maxV = Math.max(...values, 1);
    const barW = (W - PAD.left - PAD.right) / labels.length;

    ctx.fillStyle = "#ddd";
    ctx.font = "bold 12px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(title, W / 2, 18);

    const steps = niceSteps(maxV, 5);
    steps.forEach(v => {
      const y = PAD.top + (1 - v / maxV) * (H - PAD.top - PAD.bottom);
      ctx.beginPath();
      ctx.moveTo(PAD.left, y);
      ctx.lineTo(W - PAD.right, y);
      ctx.strokeStyle = "rgba(255,255,255,0.1)";
      ctx.stroke();
      ctx.fillStyle = "#999";
      ctx.font = "10px sans-serif";
      ctx.textAlign = "right";
      ctx.fillText(v, PAD.left - 4, y + 3);
    });

    labels.forEach((label, i) => {
      const x = PAD.left + i * barW;
      const barH = (values[i] / maxV) * (H - PAD.top - PAD.bottom);
      const y = PAD.top + (H - PAD.top - PAD.bottom) - barH;

      ctx.fillStyle = color;
      ctx.fillRect(x + 2, y, barW - 4, barH);

      if (values[i] > 0) {
        ctx.fillStyle = "#fff";
        ctx.font = "10px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(values[i], x + barW / 2, y - 3);
      }

      ctx.fillStyle = "#aaa";
      ctx.font = barW < 28 ? "8px sans-serif" : "10px sans-serif";
      ctx.textAlign = "center";
      ctx.save();
      if (label.length > 5) {
        ctx.translate(x + barW / 2, H - PAD.bottom + 14);
        ctx.rotate(-Math.PI / 6);
        ctx.fillText(label, 0, 0);
      } else {
        ctx.fillText(label, x + barW / 2, H - PAD.bottom + 14);
      }
      ctx.restore();
    });
  }

  // -----------------------------------------------------------------------
  // 地図
  // -----------------------------------------------------------------------
  function initMap(data) {
    if (_map) return;

    _map = L.map("map").setView([35.0, 135.0], 5);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/">OpenStreetMap</a>',
      maxZoom: 18,
    }).addTo(_map);

    const siteMap = {};
    data.dives.forEach(d => {
      if (!d.site_uuid) return;
      siteMap[d.site_uuid] = siteMap[d.site_uuid] || { dives: [], ...data.sites[d.site_uuid] };
      siteMap[d.site_uuid].dives.push(d);
    });

    const bounds = [];
    Object.entries(siteMap).forEach(([uuid, site]) => {
      if (!site.gps) return;
      const [lat, lon] = site.gps;
      bounds.push([lat, lon]);

      const popup = `
        <b>${escHtml(site.name || "不明")}</b><br>
        ダイブ数: ${site.dives.length}<br>
        最終潜水: ${site.dives[site.dives.length - 1]?.date ?? "—"}<br>
        最大深度: ${Math.max(...site.dives.map(d => d.max_depth_m || 0))} m
      `;

      L.circleMarker([lat, lon], {
        radius: 6 + Math.min(site.dives.length * 1.5, 14),
        fillColor: "#1a8fe3",
        color: "#fff",
        weight: 2,
        opacity: 1,
        fillOpacity: 0.85,
      }).bindPopup(popup).addTo(_map);
    });

    if (bounds.length > 0) {
      _map.fitBounds(bounds, { padding: [30, 30] });
    }

    // 地図タブ切替時にサイズを再計算
    setTimeout(() => _map.invalidateSize(), 100);
  }

  // -----------------------------------------------------------------------
  // タブ切替
  // -----------------------------------------------------------------------
  function setupTabs() {
    document.querySelectorAll(".tab-btn").forEach(btn => {
      btn.addEventListener("click", () => switchTab(btn.dataset.tab));
    });
  }

  function switchTab(tab) {
    _activeTab = tab;
    document.querySelectorAll(".tab-btn").forEach(b =>
      b.classList.toggle("active", b.dataset.tab === tab));
    document.querySelectorAll(".tab-pane").forEach(p =>
      p.classList.toggle("active", p.id === `tab-${tab}`));

    if (tab === "stats" && _data) renderStats(_data);
    if (tab === "map" && _data) initMap(_data);
    if (tab === "profile") {
      const canvas = document.getElementById("profile-canvas");
      if (canvas._dive) drawProfile(canvas._dive);
    }
  }

  // -----------------------------------------------------------------------
  // ユーティリティ
  // -----------------------------------------------------------------------
  function niceSteps(max, count) {
    const raw = max / count;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const nice = [1, 2, 5, 10].map(f => f * mag).find(s => s >= raw) || mag;
    const steps = [];
    for (let v = nice; v <= max * 1.01; v += nice) steps.push(Math.round(v * 100) / 100);
    return steps;
  }

  function setValue(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  }

  function escHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function showLoading(on) {
    const el = document.getElementById("loading");
    if (el) el.style.display = on ? "block" : "none";
  }

  function showError(msg) {
    const el = document.getElementById("error-msg");
    if (el) { el.textContent = msg; el.style.display = "block"; }
  }

  return { init };
})();

document.addEventListener("DOMContentLoaded", App.init);
