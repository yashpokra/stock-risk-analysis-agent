from mcp.server.fastmcp import FastMCP
from datetime import datetime, timedelta
import yfinance as yf
import numpy as np

# Initialize FastMCP Server
mcp = FastMCP("RiskMetrics")


@mcp.tool()
def get_risk_metrics(ticker: str, benchmark: str = "^GSPC", as_of_date: str | None = None, start_date: str | None = None, end_date: str | None = None) -> dict:
    """Compute quantitative risk metrics for a stock over the trailing year:
    annualized volatility, beta vs a benchmark index, max drawdown, and
    95%% historical Value-at-Risk (daily). Use this for anything requiring
    computed risk, not just raw price/fundamentals."""
    try:
        selected_end = end_date or as_of_date
        history_end = datetime.strptime(selected_end, "%Y-%m-%d") + timedelta(days=1) if selected_end else None
        history_start = datetime.strptime(start_date, "%Y-%m-%d") if start_date else (history_end - timedelta(days=365) if history_end else None)
        stock = yf.Ticker(ticker)
        hist = stock.history(start=history_start, end=history_end) if history_end else stock.history(period="1y")
        if history_end and len(hist) < 30:
            trailing_start = history_end - timedelta(days=365)
            hist = stock.history(start=trailing_start, end=history_end)

        # Delisted or recently relisted symbols may not provide a full year.
        # Use all available history up to the selected date instead of silently
        # converting missing risk data into a zero score.
        if history_end and len(hist) < 10:
            hist = stock.history(period="max")
            if not hist.empty and getattr(hist.index, "tz", None) is not None:
                hist.index = hist.index.tz_localize(None)
            if not hist.empty:
                hist = hist[hist.index < history_end]

        if hist.empty or len(hist) < 10:
            return {"error": f"Not enough price history for {ticker}"}

        returns = hist["Close"].pct_change().dropna()
        ann_vol = float(returns.std() * np.sqrt(252))

        benchmark_ticker = yf.Ticker(benchmark)
        bench_hist = benchmark_ticker.history(start=history_start, end=history_end) if history_end else benchmark_ticker.history(period="1y")
        if history_end and len(bench_hist) < 10:
            bench_hist = benchmark_ticker.history(start=trailing_start, end=history_end)
        if history_end and len(bench_hist) < 10:
            bench_hist = benchmark_ticker.history(period="max")
            if not bench_hist.empty and getattr(bench_hist.index, "tz", None) is not None:
                bench_hist.index = bench_hist.index.tz_localize(None)
            if not bench_hist.empty:
                bench_hist = bench_hist[bench_hist.index < history_end]
        bench_returns = bench_hist["Close"].pct_change().dropna()

        aligned = returns.align(bench_returns, join="inner")
        stock_r, bench_r = aligned[0].values, aligned[1].values
        if len(stock_r) > 5 and np.var(bench_r) > 0:
            cov_matrix = np.cov(stock_r, bench_r)
            beta = float(cov_matrix[0][1] / cov_matrix[1][1])
        else:
            beta = None

        cum_returns = (1 + returns).cumprod()
        running_max = cum_returns.cummax()
        drawdown = (cum_returns - running_max) / running_max
        max_drawdown = float(drawdown.min())

        var_95_daily = float(returns.quantile(0.05))

        return {
            "symbol": ticker.upper(),
            "annualized_volatility": round(ann_vol, 4),
            "beta_vs_benchmark": round(beta, 3) if beta is not None else None,
            "benchmark": benchmark,
            "max_drawdown_1y": round(max_drawdown, 4),
            "value_at_risk_95_daily": round(var_95_daily, 4),
            "trading_days_used": int(len(returns)),
            "as_of_date": as_of_date,
            "start_date": start_date,
            "end_date": end_date,
        }
    except Exception as e:
        return {"error": f"{type(e).__name__}: {e}"}


@mcp.tool()
def get_liquidity_metrics(ticker: str, as_of_date: str | None = None, start_date: str | None = None, end_date: str | None = None) -> dict:
    """Fetch liquidity-related metrics: average daily volume, shares outstanding,
    and float, used to flag thinly-traded / concentration risk."""
    try:
        stock = yf.Ticker(ticker)
        info = stock.info
        selected_end = end_date or as_of_date
        if selected_end:
            history_end = datetime.strptime(selected_end, "%Y-%m-%d") + timedelta(days=1)
            history_start = datetime.strptime(start_date, "%Y-%m-%d") if start_date else history_end - timedelta(days=30)
            hist = stock.history(start=history_start, end=history_end)
        else:
            hist = stock.history(period="1mo")
        avg_volume_1mo = float(hist["Volume"].mean()) if not hist.empty else None
        short_percent_of_float = info.get("shortPercentOfFloat")
        # Yahoo occasionally returns a placeholder zero for NYSE short-interest data.
        # Do not present that placeholder as a verified zero to the risk UI.
        if short_percent_of_float == 0:
            short_percent_of_float = None

        return {
            "symbol": ticker.upper(),
            "avg_daily_volume_1mo": round(avg_volume_1mo, 0) if avg_volume_1mo else None,
            "shares_outstanding": info.get("sharesOutstanding"),
            "float_shares": info.get("floatShares"),
            "short_percent_of_float": short_percent_of_float,
            "as_of_date": as_of_date,
            "start_date": start_date,
            "end_date": end_date,
        }
    except Exception as e:
        return {"error": f"{type(e).__name__}: {e}"}


if __name__ == "__main__":
    mcp.run(transport="stdio")
