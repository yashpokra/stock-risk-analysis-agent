import { useRef, useState } from "react";
import { jsPDF } from "jspdf";
import {
  RadarChart, PolarGrid, PolarAngleAxis, Radar,
  ResponsiveContainer,
} from "recharts";
import { X, TrendingUp, TrendingDown, AlertTriangle, FileText, Plus, RotateCcw, CalendarDays } from "lucide-react";

const TICKER_LIST = [
  { symbol: "AAPL", name: "Apple Inc." },
  { symbol: "MSFT", name: "Microsoft Corporation" },
  { symbol: "GOOGL", name: "Alphabet Inc." },
  { symbol: "AMZN", name: "Amazon.com, Inc." },
  { symbol: "NVDA", name: "NVIDIA Corporation" },
  { symbol: "META", name: "Meta Platforms, Inc." },
  { symbol: "TSLA", name: "Tesla, Inc." },
  { symbol: "AVGO", name: "Broadcom Inc." },
  { symbol: "AMD", name: "Advanced Micro Devices" },
  { symbol: "NFLX", name: "Netflix, Inc." },
  { symbol: "JPM", name: "JPMorgan Chase & Co." },
  { symbol: "BAC", name: "Bank of America Corp." },
  { symbol: "V", name: "Visa Inc." },
  { symbol: "MA", name: "Mastercard Incorporated" },
  { symbol: "UNH", name: "UnitedHealth Group" },
  { symbol: "JNJ", name: "Johnson & Johnson" },
  { symbol: "XOM", name: "Exxon Mobil Corporation" },
  { symbol: "WMT", name: "Walmart Inc." },
  { symbol: "PG", name: "Procter & Gamble Co." },
  { symbol: "KO", name: "The Coca-Cola Company" },
  { symbol: "DIS", name: "The Walt Disney Company" },
  { symbol: "PLTR", name: "Palantir Technologies" },
  { symbol: "COIN", name: "Coinbase Global, Inc." },
  { symbol: "SOFI", name: "SoFi Technologies" },
  { symbol: "GME", name: "GameStop Corp." },
  { symbol: "BBY", name: "Best Buy Co., Inc." },
  { symbol: "BBBY", name: "Bed Bath & Beyond, Inc." },
];

const RISK_COLORS = { low: "#6f8f72", mid: "#b8874b", high: "#b76745", crit: "#9d4f4f" };
const SERIES = ["#8f5c3e", "#c47a4a", "#6f8f72", "#7c6a9a", "#b05d5d"];
const ANALYSIS_CACHE = new Map();

const NVDA = {
  ticker: "NVDA",
  price_data: { raw: [{ type: "text", text: '{"symbol":"NVDA","last_price":214.72,"previous_close":217.05,"currency":"USD"}' }] },
  fundamentals: { raw: [{ type: "text", text: '{"symbol":"NVDA","company_name":"NVIDIA Corporation","forward_pe":16.5,"trailing_pe":32.88,"profit_margins":0.6297,"revenue_growth":0.852,"total_debt_to_equity":6.56,"market_cap":5200733011968}' }] },
  risk_metrics: { raw: [{ type: "text", text: '{"symbol":"NVDA","annualized_volatility":0.3677,"beta_vs_benchmark":1.887,"benchmark":"^GSPC","max_drawdown_1y":-0.2021,"value_at_risk_95_daily":-0.0378,"trading_days_used":250}' }] },
  liquidity: { raw: [{ type: "text", text: '{"symbol":"NVDA","avg_daily_volume_1mo":116840657,"shares_outstanding":24221000000,"float_shares":23226192000,"short_percent_of_float":0.0126}' }] },
  report: "NVIDIA carries a moderate risk profile driven by elevated market beta of 1.89, nearly twice the S&P 500's sensitivity to broad market moves. Exceptional fundamentals - 63% profit margins and 85% revenue growth - provide a meaningful counterweight to that volatility.\n\nAnnualized volatility of 36.8% is the dominant score driver. The trailing drawdown of -20.2% stayed below the 30% penalty threshold, and debt-to-equity of 6.6 reflects a clean balance sheet relative to the semiconductor sector.\n\nLiquidity is world-class: roughly 117M shares trade daily against a 23B float, and short interest sits at a negligible 1.3%.\n\nTakeaway: a high-growth, highly liquid name whose main risk is beta exposure rather than balance-sheet or liquidity fragility."
};

function parseRaw(data) {
  if (!data) return {};
  if (typeof data === "string") {
    try { return JSON.parse(data); } catch { return {}; }
  }
  const blocks = data.raw || (Array.isArray(data) ? data : []);
  for (const b of blocks) {
    if (b && b.type === "text") {
      try { return typeof b.text === "string" ? JSON.parse(b.text) : b.text; } catch {}
    }
  }
  return typeof data === "object" && !Array.isArray(data) ? data : {};
}

function scoreColor(score) {
  if (score < 35) return "#d8c4a8";
  if (score < 60) return "#d8894d";
  if (score < 80) return "#b9543d";
  return "#7f2f32";
}

function computeScore(state) {
  const r = parseRaw(state.risk_metrics), f = parseRaw(state.fundamentals), l = parseRaw(state.liquidity);
  let score = 0; const flags = [];
  const vol = r.annualized_volatility;
  if (vol != null) { score += Math.min(vol * 100, 40); if (vol > 0.45) flags.push("High volatility (>45% annualized)"); }
  const beta = r.beta_vs_benchmark;
  if (beta != null) { score += Math.min(Math.max(beta - 1, 0) * 20, 20); if (beta > 1.5) flags.push("Elevated beta (>1.5x benchmark)"); }
  const dd = r.max_drawdown_1y;
  if (dd != null && dd < -0.25) { score += 15; flags.push("Max drawdown exceeds 25%"); }
  const tradingDays = r.trading_days_used;
  if (tradingDays != null && tradingDays < 30) flags.push("Limited price history (<30 trading days)");
  const dte = f.total_debt_to_equity;
  if (dte != null && dte > 150) { score += 15; flags.push("High debt-to-equity (>150)"); }
  const sp = l.short_percent_of_float;
  if (sp != null && sp > 0.10) { score += 10; flags.push("Short interest above 10% of float"); }
  return { score: Math.min(parseFloat(score.toFixed(1)), 100), flags };
}

function tier(s) { return s < 35 ? "low" : s < 60 ? "mid" : s < 80 ? "high" : "crit"; }
function tierLabel(s) { return { low: "Low risk", mid: "Moderate risk", high: "High risk", crit: "Severe risk" }[tier(s)]; }
function tierColor(s) { return RISK_COLORS[tier(s)]; }

function fmtPrice(n) { return n != null ? "$" + parseFloat(n).toFixed(2) : "-"; }
function fmtPct(n, d = 1) { return n != null ? (n * 100).toFixed(d) + "%" : "-"; }
function fmtCap(n) { if (!n) return "-"; return n >= 1e12 ? "$" + (n / 1e12).toFixed(2) + "T" : n >= 1e9 ? "$" + (n / 1e9).toFixed(1) + "B" : "$" + (n / 1e6).toFixed(0) + "M"; }
function fmtVol(n) { if (!n) return "-"; return n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n.toLocaleString(); }
function fmtNum(n, d = 2) { return n != null ? parseFloat(n).toFixed(d) : "-"; }

function cleanReportText(text) {
  return text
    .replace(/â€”|â€“|—|–/g, "-")
    .replace(/Â·/g, "|")
    .replace(/â€¦/g, "...")
    .trim();
}

function reportBlocks(report) {
  const defaultHeadings = [
    "What's actually happening",
    "Why the risk metrics look the way they do",
    "Red flags",
    "Scenario analysis",
    "What to watch next",
  ];
  return cleanReportText(report || "No report available.")
    .split(/\n\s*\n/)
    .filter(Boolean)
    .map((block, index) => {
      const lines = block.split("\n").map(line => line.trim()).filter(Boolean);
      const heading = lines[0].match(/^#{1,6}\s+(.+)$/);
      return heading
        ? { heading: defaultHeadings[index] || heading[1], body: lines.slice(1).join(" ") }
        : { heading: defaultHeadings[index] || null, body: lines.join(" ") };
    });
}

function displayText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function deepDiveArticles(value) {
  if (!value) return [];
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed.filter(article => article && article.url) : [];
  } catch {
    return [];
  }
}

function downloadReportPdf(state) {
  const { score, flags } = computeScore(state);
  const fund = parseRaw(state.fundamentals);
  const risk = parseRaw(state.risk_metrics);
  const liquidity = parseRaw(state.liquidity);
  const pdf = new jsPDF({ unit: "pt", format: "letter" });
  const margin = 48;
  const pageWidth = pdf.internal.pageSize.getWidth();
  let y = 54;

  pdf.setTextColor(36, 26, 20);
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(20);
  pdf.text(`${state.ticker} risk report`, margin, y);
  y += 22;
  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(10);
  pdf.setTextColor(112, 89, 74);
  pdf.text(`${score.toFixed(1)} / 100 - ${tierLabel(score)}`, margin, y);
  y += 28;

  const addText = (text, size = 11, bold = false, color = [55, 42, 32]) => {
    pdf.setFont("helvetica", bold ? "bold" : "normal");
    pdf.setFontSize(size);
    pdf.setTextColor(...color);
    const lines = pdf.splitTextToSize(text, pageWidth - margin * 2);
    if (y + lines.length * (size + 4) > 740) { pdf.addPage(); y = 54; }
    pdf.text(lines, margin, y);
    y += lines.length * (size + 4) + 10;
  };

  addText("Key metrics", 12, true);
  addText(`Market cap: ${fmtCap(fund.market_cap)}   Forward P/E: ${fmtNum(fund.forward_pe, 1)}   Volatility: ${fmtPct(risk.annualized_volatility)}   Beta: ${fmtNum(risk.beta_vs_benchmark, 2)}   Avg volume: ${fmtVol(liquidity.avg_daily_volume_1mo)}`);
  if (flags.length) addText(`Risk flags: ${flags.join("; ")}`, 10, false, [127, 47, 50]);
  reportBlocks(state.report).forEach(block => {
    if (block.heading) addText(block.heading, 12, true);
    addText(block.body);
  });
  pdf.save(`${state.ticker}-risk-report.pdf`);
}

function RingGauge({ score, size = 76 }) {
  const r = size * 0.407, cx = size / 2, cy = size / 2;
  const circ = 2 * Math.PI * r;
  const dash = (score / 100) * circ;
  const col = tierColor(score);
  const strokeWidth = size * 0.079;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="#eadfce" strokeWidth={strokeWidth} />
      <circle cx={cx} cy={cy} r={r} fill="none" stroke={col} strokeWidth={strokeWidth}
        strokeDasharray={`${dash} ${circ}`} strokeLinecap="round"
        transform={`rotate(-90 ${cx} ${cy})`} />
      <text x={cx} y={cy - size * 0.026} textAnchor="middle" fontSize={size * 0.21} fontWeight={600} fill="#241A14">{score.toFixed(0)}</text>
      <text x={cx} y={cy + size * 0.158} textAnchor="middle" fontSize={size * 0.105} fill="#8b7564">/100</text>
    </svg>
  );
}

function StatRow({ label, value, tone }) {
  const toneColor = tone === "up" ? "text-emerald-400" : tone === "down" ? "text-red-400" : "text-zinc-100";
  return (
    <div className="flex items-baseline justify-between py-1.5 border-b border-zinc-800/70 last:border-0">
      <span className="text-[12px] text-zinc-500">{label}</span>
      <span className={`text-[12px] font-medium tabular-nums ${toneColor}`}>{value}</span>
    </div>
  );
}

function TickerCard({ state, onRemove, onViewReport, expanded }) {
  const [cardWidth, setCardWidth] = useState(null);
  const [cardHeight, setCardHeight] = useState(null);
  const [cardPosition, setCardPosition] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const resizeStart = useRef(null);
  const dragStart = useRef(null);
  const price = parseRaw(state.price_data);
  const fund = parseRaw(state.fundamentals);
  const risk = parseRaw(state.risk_metrics);
  const liq = parseRaw(state.liquidity);
  const { score, flags } = computeScore(state);
  const col = tierColor(score);
  const startClose = price.start_close ?? price.previous_close;
  const endClose = price.end_close ?? price.last_price;
  const change = endClose != null && startClose != null ? endClose - startClose : null;
  const changePct = change != null && startClose ? (change / startClose * 100) : null;
  const up = change > 0;
  const cardScale = cardWidth ? Math.min(Math.max(cardWidth / 300, 0.9), 2) : 1;

  function startDrag(event) {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragStart.current = { pointerX: event.clientX, pointerY: event.clientY, x: cardPosition.x, y: cardPosition.y };
    setDragging(true);
  }

  function dragCard(event) {
    if (!dragStart.current) return;
    setCardPosition({
      x: dragStart.current.x + event.clientX - dragStart.current.pointerX,
      y: dragStart.current.y + event.clientY - dragStart.current.pointerY,
    });
  }

  function endDrag(event) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    dragStart.current = null;
    setDragging(false);
  }

  function startResize(event) {
    event.currentTarget.setPointerCapture(event.pointerId);
    const card = event.currentTarget.closest(".ticker-card");
    resizeStart.current = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      width: cardWidth || card.offsetWidth,
      height: cardHeight || card.offsetHeight,
    };
  }

  function resizeCard(event) {
    if (!resizeStart.current) return;
    setCardWidth(Math.min(Math.max(resizeStart.current.width + event.clientX - resizeStart.current.pointerX, 250), window.innerWidth));
    setCardHeight(Math.min(Math.max(resizeStart.current.height + event.clientY - resizeStart.current.pointerY, 360), window.innerHeight * 2));
  }

  function endResize(event) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    resizeStart.current = null;
  }

  return (
    <div className={`ticker-card bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden flex flex-col ${dragging ? "is-dragging" : ""}`} style={{ width: cardWidth ? `${cardWidth}px` : undefined, height: cardHeight ? `${cardHeight}px` : undefined, transform: `translate(${cardPosition.x}px, ${cardPosition.y}px)`, zIndex: dragging ? 10 : undefined, "--card-scale": cardScale }}>
      <div className="card-drag-header px-5 pt-5 pb-4 flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-lg font-semibold text-zinc-50 tracking-tight font-mono">{state.ticker}</span>
            <span className="text-[10px] font-medium uppercase tracking-wider px-1.5 py-0.5 rounded"
              style={{ color: col, backgroundColor: col + "1a" }}>{tierLabel(score)}</span>
          </div>
          <div className="text-[11px] text-zinc-500 mt-0.5 truncate max-w-[160px]">{fund.company_name || "-"}</div>
        </div>
        <button onClick={onRemove} aria-label="Remove ticker" className="text-zinc-600 hover:text-zinc-300 transition-colors p-1 -mr-1 -mt-1">
          <X size={14} />
        </button>
      </div>

      <div className="px-5 pb-5 flex items-center justify-between">
        <div>
          <div className="text-2xl font-semibold tabular-nums text-zinc-50 tracking-tight">{fmtPrice(endClose)}</div>
          {change != null && (
            <>
              <div className="text-[11px] text-zinc-500 mt-1">Start close {fmtPrice(startClose)}</div>
              <div className="text-[11px] text-zinc-500">End close {fmtPrice(endClose)}</div>
              <div className={`flex items-center gap-1 text-[11px] mt-1 ${up ? "text-emerald-400" : "text-red-400"}`}>
                {up ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
                {changePct.toFixed(2)}%
              </div>
            </>
          )}
        </div>
        <RingGauge score={score} size={Math.round(76 * cardScale)} />
      </div>

      {flags.length > 0 && (
        <div className="px-5 pb-4 flex flex-col gap-1.5">
          {flags.map((f, i) => (
            <div key={i} className="flex items-start gap-1.5 text-[11px] text-amber-400/90 bg-amber-400/10 rounded-md px-2 py-1.5">
              <AlertTriangle size={12} className="mt-[1px] flex-shrink-0" />
              <span>{f}</span>
            </div>
          ))}
        </div>
      )}

      <div className="metric-section border-t border-zinc-800 px-5 py-4">
        <div className="text-[10px] font-medium text-zinc-500 uppercase tracking-widest mb-2">Fundamentals</div>
        <StatRow label="Market cap (daily)" value={fmtCap(fund.market_cap)} />
        <StatRow label="Forward P/E (forward)" value={fmtNum(fund.forward_pe, 1)} />
        <StatRow label="Profit margin (reported)" value={fmtPct(fund.profit_margins)} tone="up" />
        <StatRow label="Revenue growth (YoY)" value={fmtPct(fund.revenue_growth)} tone="up" />
        <StatRow label="Debt / equity (reported)" value={fmtNum(fund.total_debt_to_equity, 1)} />
      </div>

      <div className="metric-section border-t border-zinc-800 px-5 py-4">
        <div className="text-[10px] font-medium text-zinc-500 uppercase tracking-widest mb-2">Risk metrics (1Y)</div>
        <StatRow label="Volatility (1Y)" value={fmtPct(risk.annualized_volatility)} />
        <StatRow label="Beta vs S&P 500 (1Y)" value={fmtNum(risk.beta_vs_benchmark, 2)} />
        <StatRow label="Max drawdown (1Y)" value={fmtPct(risk.max_drawdown_1y)} tone="down" />
        <StatRow label="VaR 95% (daily)" value={fmtPct(risk.value_at_risk_95_daily, 2)} tone="down" />
      </div>

      <div className="metric-section border-t border-zinc-800 px-5 py-4">
        <div className="text-[10px] font-medium text-zinc-500 uppercase tracking-widest mb-2">Liquidity</div>
        <StatRow label="Avg daily volume (30D)" value={fmtVol(liq.avg_daily_volume_1mo)} />
        <StatRow label="Short % of float (reported)" value={liq.short_percent_of_float == null ? "-" : fmtPct(liq.short_percent_of_float, 2)} />
      </div>

      <button onClick={onViewReport} className="report-toggle border-t border-zinc-800 px-4 py-3 text-[12px] text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/50 transition-colors flex items-center justify-center gap-1.5">
        <FileText size={13} />
        {expanded ? "Hide report" : "View analyst report"}
      </button>
      {expanded && <ReportPanel state={state} />}
      <div className="card-move-zones" aria-label="Move card">
        {["top", "right", "bottom", "left"].map(side => (
          <button
            key={side}
            type="button"
            className={`card-move-handle card-move-${side}`}
            aria-label={`Move card from ${side} side`}
            title="Move card"
            onPointerDown={startDrag}
            onPointerMove={dragCard}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          />
        ))}
      </div>
      <div className="card-corner-controls">
        <button
          type="button"
          className="card-resize-handle"
          aria-label="Resize card"
          title="Resize card"
          onPointerDown={startResize}
          onPointerMove={resizeCard}
          onPointerUp={endResize}
          onPointerCancel={endResize}
        />
      </div>
    </div>
  );
}

function ReportPanel({ state }) {
  const { score, flags } = computeScore(state);
  const col = tierColor(score);
  const blocks = reportBlocks(state.report);
  const deepDiveNotes = displayText(state.deep_dive_notes);
  const deepDiveArticlesList = deepDiveArticles(state.deep_dive_notes);
  const hasDeepDiveResearch = deepDiveArticlesList.length > 0 || (
    deepDiveNotes && deepDiveNotes !== "N/A" && deepDiveNotes !== "[]"
  );
  return (
    <div className="report-panel bg-zinc-900 border-t border-zinc-800 p-5">
      <div className="flex items-start justify-between gap-3 mb-5">
        <div className="flex items-center gap-3">
        <div className="w-1 h-7 rounded-full" style={{ backgroundColor: col }} />
        <div>
          <div className="text-[13px] font-medium text-zinc-100">{state.ticker} - analyst report</div>
          <div className="text-[11px] text-zinc-500">{score.toFixed(1)}/100 | {tierLabel(score)}</div>
        </div>
        </div>
        <button type="button" onClick={() => downloadReportPdf(state)} className="pdf-button text-[11px] font-medium rounded-md px-2.5 py-1.5">Download PDF</button>
      </div>
      {flags.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-4">
          {flags.map((f, i) => (
            <span key={i} className="text-[11px] text-amber-400/90 bg-amber-400/10 px-2 py-1 rounded-md flex items-center gap-1">
              <AlertTriangle size={11} />{f}
            </span>
          ))}
        </div>
      )}
      {hasDeepDiveResearch && (
        <section className="deep-dive-panel mb-5">
          <div className="deep-dive-label">Deep-dive research completed</div>
          {deepDiveArticlesList.length > 0 ? (
            <>
              <div className="deep-dive-articles">
              {deepDiveArticlesList.map((article, index) => (
                <article className="deep-dive-article" key={`${article.url}-${index}`}>
                  <a href={article.url} target="_blank" rel="noreferrer">
                    {article.title || "Open article"}
                  </a>
                  {article.date && <div className="deep-dive-date">Published: {article.date}</div>}
                </article>
              ))}
              </div>
              <p className="deep-dive-summary">
                The analyst report below uses these article summaries together with the measured risk flags and metrics to explain why the stock requires caution.
              </p>
            </>
          ) : (
            <p className="deep-dive-notes">{deepDiveNotes}</p>
          )}
          <p className="deep-dive-watchlist">
            Pay attention to upcoming company news, earnings, guidance, filings, and analyst revisions.
          </p>
        </section>
      )}
      <div className="space-y-4">
        {blocks.map((block, i) => (
          <section key={i}>
            {block.heading && <h4 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-zinc-200 mb-1.5">{block.heading}</h4>}
            <p className="text-[13.5px] leading-[1.75] text-zinc-400">{block.body}</p>
          </section>
        ))}
      </div>
    </div>
  );
}

function ScoreBarChart({ stocks }) {
  const data = stocks.map((s, i) => {
    const { score } = computeScore(s);
    return { ticker: s.ticker, score, fill: scoreColor(score) };
  });
  return (
    <div className="score-chart" role="img" aria-label="Vertical risk score chart by ticker">
      <div className="score-chart-scale" aria-hidden="true">
        {[100, 75, 50, 25, 0].map(value => <span key={value}>{value}</span>)}
      </div>
      <div className="score-chart-plot">
        <div className="score-chart-grid" aria-hidden="true">
          {[100, 75, 50, 25, 0].map(value => <span key={value} style={{ bottom: `${value}%` }} />)}
        </div>
        <div className="score-columns">
          {data.map(d => (
            <div className="score-column" key={d.ticker}>
              <span className="score-column-value">{d.score.toFixed(1)}</span>
              <div className="score-column-track">
                <div className="score-column-fill" style={{ height: `${d.score}%`, backgroundColor: d.fill }} />
              </div>
              <span className="score-column-label font-mono">{d.ticker}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function comparisonSummary(stocks) {
  if (!stocks.length) return null;
  const ranked = stocks.map(stock => {
    const risk = parseRaw(stock.risk_metrics);
    const fundamentals = parseRaw(stock.fundamentals);
    const liquidity = parseRaw(stock.liquidity);
    const { score } = computeScore(stock);
    const quality = [
      fundamentals.profit_margins,
      fundamentals.revenue_growth,
      fundamentals.market_cap ? Math.min(fundamentals.market_cap / 1e12, 1) : null,
    ].filter(value => value != null).reduce((total, value) => total + value, 0);
    const riskData = [
      risk.annualized_volatility,
      risk.beta_vs_benchmark,
      risk.max_drawdown_1y == null ? null : Math.abs(risk.max_drawdown_1y),
      risk.value_at_risk_95_daily == null ? null : Math.abs(risk.value_at_risk_95_daily),
      fundamentals.total_debt_to_equity == null ? null : Math.min(fundamentals.total_debt_to_equity / 150, 1),
      liquidity.short_percent_of_float == null ? null : Math.min(liquidity.short_percent_of_float / 0.1, 1),
    ].filter(value => value != null);
    const riskAverage = riskData.length ? riskData.reduce((total, value) => total + value, 0) / riskData.length : 1;
    const preferenceScore = score + riskAverage * 5 - quality * 5;
    return { stock, risk, fundamentals, liquidity, score, quality, preferenceScore };
  }).sort((left, right) => left.preferenceScore - right.preferenceScore);
  const preferred = ranked[0];
  const { stock, risk, fundamentals, liquidity } = preferred;
  const strengths = [];
  if (fundamentals.profit_margins != null) strengths.push(`${fmtPct(fundamentals.profit_margins)} profit margin`);
  if (fundamentals.revenue_growth != null) strengths.push(`${fmtPct(fundamentals.revenue_growth)} revenue growth`);
  if (risk.annualized_volatility != null) strengths.push(`${fmtPct(risk.annualized_volatility)} volatility`);
  if (liquidity.avg_daily_volume_1mo != null) strengths.push(`${fmtVol(liquidity.avg_daily_volume_1mo)} average daily volume`);
  return {
    preferred: stock.ticker,
    score: preferred.score,
    details: strengths.slice(0, 3).join(", "),
    compared: ranked.length,
  };
}

function RiskRadarChart({ stocks }) {
  const dims = ["Beta", "Volatility", "Drawdown", "Margin", "Growth"];
  const data = dims.map(dim => {
    const row = { dim };
    stocks.forEach(s => {
      const r = parseRaw(s.risk_metrics), f = parseRaw(s.fundamentals);
      let v = 0;
      if (dim === "Beta") v = Math.min((r.beta_vs_benchmark || 0) / 3, 1);
      if (dim === "Volatility") v = Math.min((r.annualized_volatility || 0) / 0.8, 1);
      if (dim === "Drawdown") v = Math.min(Math.abs(r.max_drawdown_1y || 0) / 0.6, 1);
      if (dim === "Margin") v = Math.min(f.profit_margins || 0, 1);
      if (dim === "Growth") v = Math.min(Math.max(f.revenue_growth || 0, 0) / 1.5, 1);
      row[s.ticker] = parseFloat((v * 100).toFixed(1));
    });
    return row;
  });

  return (
    <div>
      <div className="flex flex-wrap gap-3 mb-3">
        {stocks.map((s, i) => (
          <span key={s.ticker} className="flex items-center gap-1.5 text-[12px] text-zinc-400">
            <span className="w-2 h-2 rounded-full" style={{ backgroundColor: SERIES[i % SERIES.length] }} />
            {s.ticker}
          </span>
        ))}
      </div>
      <ResponsiveContainer width="100%" height={260}>
        <RadarChart data={data} outerRadius="75%">
          <PolarGrid stroke="#d9cabb" />
          <PolarAngleAxis dataKey="dim" tick={{ fill: "#6f594a", fontSize: 11 }} />
          {stocks.map((s, i) => (
            <Radar key={s.ticker} name={s.ticker} dataKey={s.ticker}
              stroke={SERIES[i % SERIES.length]} fill={SERIES[i % SERIES.length]} fillOpacity={0.12} strokeWidth={2} />
          ))}
        </RadarChart>
      </ResponsiveContainer>
    </div>
  );
}

function CompareTable({ stocks }) {
  const rows = [
    { label: "Price", fn: s => fmtPrice(parseRaw(s.price_data).last_price) },
    { label: "Market cap", fn: s => fmtCap(parseRaw(s.fundamentals).market_cap) },
    { label: "Forward P/E", fn: s => fmtNum(parseRaw(s.fundamentals).forward_pe, 1) },
    { label: "Profit margin", fn: s => fmtPct(parseRaw(s.fundamentals).profit_margins) },
    { label: "Revenue growth", fn: s => fmtPct(parseRaw(s.fundamentals).revenue_growth) },
    { label: "Debt / equity", fn: s => fmtNum(parseRaw(s.fundamentals).total_debt_to_equity, 1) },
    { label: "Volatility (1Y)", fn: s => fmtPct(parseRaw(s.risk_metrics).annualized_volatility) },
    { label: "Beta", fn: s => fmtNum(parseRaw(s.risk_metrics).beta_vs_benchmark, 2) },
    { label: "Max drawdown", fn: s => fmtPct(parseRaw(s.risk_metrics).max_drawdown_1y) },
    { label: "VaR 95% daily", fn: s => fmtPct(parseRaw(s.risk_metrics).value_at_risk_95_daily, 2) },
    { label: "Avg daily volume", fn: s => fmtVol(parseRaw(s.liquidity).avg_daily_volume_1mo) },
    { label: "Short % of float", fn: s => { const value = parseRaw(s.liquidity).short_percent_of_float; return value == null ? "-" : fmtPct(value, 2); } },
  ];
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[12px] border-collapse">
        <thead>
          <tr className="border-b border-zinc-800">
            <th className="text-left font-normal text-zinc-500 py-2 px-4 sticky left-0 bg-zinc-900">Metric</th>
            {stocks.map(s => {
              const { score } = computeScore(s);
              return (
                <th key={s.ticker} className="text-right font-medium py-2 px-3 min-w-[92px] text-zinc-100">
                  <div className="font-mono">{s.ticker}</div>
                  <div className="text-[10px] font-normal" style={{ color: tierColor(score) }}>{score.toFixed(0)}/100</div>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={row.label} className={`border-b border-zinc-800/60 ${ri % 2 === 1 ? "bg-zinc-800/20" : ""}`}>
              <td className="py-2 px-4 text-zinc-500 sticky left-0" style={{ backgroundColor: ri % 2 === 1 ? "#f5ede2" : "#FAF5EC" }}>{row.label}</td>
              {stocks.map(s => (
                <td key={s.ticker} className="py-2 px-3 text-right tabular-nums text-zinc-200">{row.fn(s)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function App() {
  const [stocks, setStocks] = useState([NVDA]);
  const [layoutReset, setLayoutReset] = useState(0);
  const [input, setInput] = useState("");
  const [selectedDate, setSelectedDate] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [view, setView] = useState("cards");
  const [expandedReports, setExpandedReports] = useState(() => new Set());
  const [pendingReview, setPendingReview] = useState(null);

  function toggleReport(ticker) {
    setExpandedReports(previous => {
      const next = new Set(previous);
      if (next.has(ticker)) next.delete(ticker);
      else next.add(ticker);
      return next;
    });
  }

  function resetDashboard() {
    setStocks([NVDA]);
    setExpandedReports(new Set());
    setInput("");
    setSelectedDate("");
    setError("");
    setPendingReview(null);
    setLayoutReset(previous => previous + 1);
  }

  async function requestAnalysis(ticker, date, threadId, decision) {
    const cacheKey = `${ticker}:${date || "latest"}`;
    if (!decision && ANALYSIS_CACHE.has(cacheKey)) return ANALYSIS_CACHE.get(cacheKey);
    let res;
    try {
      res = await fetch("http://127.0.0.1:8001/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticker, as_of_date: date || null, thread_id: threadId || null, decision: decision || null })
      });
    } catch {
      throw new Error("Analysis server is unavailable. Start the backend on port 8001 and try again.");
    }
    if (!res.ok) {
      const details = await res.json().catch(() => ({}));
      throw new Error(details.detail || "Request failed");
    }
    const result = await res.json();
    ANALYSIS_CACHE.set(cacheKey, result);
    return result;
  }

  function changeDate(event) {
    setSelectedDate(event.target.value);
    setError("");
  }

  async function analyzeDate(event) {
    event.preventDefault();
    if (!selectedDate) {
      setError("Choose a date.");
      return;
    }
    if (!stocks.length) return;
    setLoading(true);
    setError("");
    try {
      await continueAnalysis(stocks, 0, []);
    } catch (err) {
      setError(err.message || "Couldn't refresh metrics for that date.");
    } finally {
      setLoading(false);
    }
  }

  async function continueAnalysis(stockList, index, analyzedStocks) {
    if (index >= stockList.length) {
      setStocks(analyzedStocks);
      return;
    }
    const result = await requestAnalysis(stockList[index].ticker, selectedDate);
    if (result.status === "interrupted") {
      setPendingReview({ mode: "date", stockList, index, analyzedStocks, ...result });
      return;
    }
    if (result.status !== "removed") analyzedStocks.push(result);
    await continueAnalysis(stockList, index + 1, analyzedStocks);
  }

  async function addTicker(event) {
    event.preventDefault();
    const t = input.trim().toUpperCase();
    if (!t) return;
    if (!selectedDate) {
      setError("Choose a date before adding a stock.");
      return;
    }
    if (stocks.find(s => s.ticker === t)) { setError("Already added."); return; }
    setLoading(true); setError("");
    try {
      const parsed = await requestAnalysis(t, selectedDate);
      if (parsed.status === "interrupted") {
        setPendingReview({ mode: "add", ticker: t, ...parsed });
      } else if (parsed.status !== "removed") {
        setStocks(prev => [...prev, parsed]);
        setInput("");
      }
    } catch (err) { setError(err.message || "Couldn't load that ticker. Check the backend and symbol."); }
    finally { setLoading(false); }
  }

  async function resolveReview(decision) {
    if (!pendingReview) return;
    setLoading(true);
    setError("");
    try {
      const result = await requestAnalysis(
        pendingReview.interrupt.ticker,
        selectedDate,
        pendingReview.thread_id,
        decision
      );
      setPendingReview(null);
      if (pendingReview.mode === "add") {
        if (result.status !== "removed") {
          setStocks(previous => [...previous, result]);
          setInput("");
        }
        return;
      }
      const analyzedStocks = [...pendingReview.analyzedStocks];
      if (result.status !== "removed") analyzedStocks.push(result);
      await continueAnalysis(pendingReview.stockList, pendingReview.index + 1, analyzedStocks);
    } catch (err) {
      setError(err.message || "Couldn't apply that decision.");
    } finally {
      setLoading(false);
    }
  }
  const TABS = [
    { id: "cards", label: "Cards" },
    { id: "compare", label: "Compare" },
    { id: "radar", label: "Radar" },
  ];

  return (
    <div className="dashboard-shell bg-zinc-950 min-h-full text-zinc-100 -m-4 p-5 rounded-2xl">
      <div className="dashboard-header text-center mb-2">
        <h2 className="text-[25px] font-semibold text-zinc-50 tracking-tight">Stock Risk Comparator</h2>
      </div>
      <p className="text-center text-[14px] text-zinc-500 mb-5">Compare risk profiles, fundamentals, and liquidity across tickers.</p>

      <div className="control-bar flex items-center gap-2 mb-5 flex-wrap">
        <form onSubmit={addTicker} className="ticker-picker flex items-center gap-1.5 bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-1.5">
          <select
            value={input}
            onChange={e => { setInput(e.target.value); setError(""); }}
            disabled={loading}
            className="bg-transparent border-none outline-none text-[13px] tracking-wide text-zinc-100 w-52"
          >
            <option value="">Choose a stock...</option>
            {TICKER_LIST.map(stock => <option key={stock.symbol} value={stock.symbol}>{stock.symbol} - {stock.name}</option>)}
          </select>
          <button
            type="submit"
            disabled={loading || !input.trim()}
            className="flex items-center gap-1 text-[12px] font-medium bg-zinc-100 text-zinc-900 rounded-md px-2.5 py-1 hover:bg-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Plus size={13} />
            {loading ? "Loading..." : "Add Stock"}
          </button>
        </form>
        <div className="date-picker flex items-center gap-2 rounded-lg px-3 py-2 text-[12px]">
          <CalendarDays size={14} aria-hidden="true" />
          <span className="date-picker-label">Date</span>
          <input
            type="date"
            value={selectedDate}
            onChange={changeDate}
            disabled={loading}
            aria-label="Metrics date"
          />
        </div>
        {error && <span className="text-[12px] text-red-400">{error}</span>}

        <div className="view-switcher ml-auto flex gap-1 bg-zinc-900 border border-zinc-800 rounded-lg p-1">
          {TABS.map(tab => (
            <button
              key={tab.id}
              onClick={() => setView(tab.id)}
              className={`text-[12px] px-3 py-1 rounded-md transition-colors ${
                view === tab.id ? "bg-zinc-100 text-zinc-900 font-medium" : "text-zinc-400 hover:text-zinc-100"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div className="control-actions flex flex-col items-stretch gap-1">
          <button
            type="button"
            onClick={resetDashboard}
            className="reset-button flex items-center justify-center gap-1.5 rounded-md px-3 py-2 text-[12px] font-medium"
            title="Reset cards, sizes, and positions"
          >
            <RotateCcw size={13} />
            Reset
          </button>
          <button
            type="button"
            onClick={analyzeDate}
            disabled={loading || !selectedDate}
            className="analyze-button flex items-center justify-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <CalendarDays size={12} />
            {loading ? "Analyzing..." : "Analyze Date"}
          </button>
        </div>
      </div>

      {view === "cards" && (
        <div className="stock-grid grid gap-4">
          {stocks.map((s, i) => (
            <div key={`${s.ticker}-${layoutReset}`}>
              <TickerCard
                state={s}
                onRemove={() => {
                  setStocks(prev => prev.filter((_, j) => j !== i));
                  setExpandedReports(previous => {
                    const next = new Set(previous);
                    next.delete(s.ticker);
                    return next;
                  });
                }}
                onViewReport={() => toggleReport(s.ticker)}
                expanded={expandedReports.has(s.ticker)}
              />
            </div>
          ))}
        </div>
      )}

      {view === "compare" && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
          <div className="p-4 border-b border-zinc-800">
            <div className="text-[12px] font-medium text-zinc-300 mb-1">Risk score comparison</div>
            <div className="text-[11px] text-zinc-500 mb-3">Higher scores indicate greater measured risk.</div>
            {(() => {
              const summary = comparisonSummary(stocks);
              return summary && (
                <div className="comparison-summary mb-4 rounded-lg px-3 py-2.5">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-300">Measured preference</div>
                  <div className="text-[15px] font-semibold text-zinc-100 mt-1">
                    {summary.preferred} has the strongest measured profile among these {summary.compared} stocks.
                  </div>
                  <div className="text-[12px] text-zinc-400 mt-1">
                    Risk score: {summary.score.toFixed(1)}/100{summary.details ? ` | ${summary.details}` : ""}. Lower scores indicate less measured risk.
                  </div>
                </div>
              );
            })()}
            <ScoreBarChart stocks={stocks} />
          </div>
          <CompareTable stocks={stocks} />
        </div>
      )}

      {view === "radar" && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
          <div className="text-[12px] text-zinc-500 mb-1">Multi-dimensional comparison</div>
          <RiskRadarChart stocks={stocks} />
        </div>
      )}

      {pendingReview && (
        <div className="hitl-backdrop" role="presentation">
          <div className="hitl-dialog" role="alertdialog" aria-modal="true" aria-labelledby="high-risk-title">
            <AlertTriangle size={28} className="hitl-icon" aria-hidden="true" />
            <div>
              <h3 id="high-risk-title">High-risk stock detected</h3>
              <p>{pendingReview.interrupt.message}</p>
              <div className="hitl-score">Risk score: {Number(pendingReview.interrupt.score).toFixed(1)}/100</div>
              <ul>
                {pendingReview.interrupt.flags.map(flag => <li key={flag}>{flag}</li>)}
              </ul>
            </div>
            <div className="hitl-actions">
              <button type="button" onClick={() => resolveReview("remove")} disabled={loading}>Remove stock</button>
              <button type="button" onClick={() => resolveReview("keep")} disabled={loading}>Keep and continue</button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}


