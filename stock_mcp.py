from mcp.server.fastmcp import FastMCP
from datetime import datetime, timedelta
import math
import yfinance as yf

# Initialize FastMCP Server
mcp = FastMCP("StockFinancialData")

@mcp.tool()
def get_stock_fundamentals(ticker: str, as_of_date: str | None = None) -> dict:
    """Fetch current or latest reported fundamental metrics as of a date."""
    stock = yf.Ticker(ticker)
    info = stock.info
    if not as_of_date:
        return {
            "symbol": ticker.upper(),
            "company_name": info.get("shortName"),
            "forward_pe": info.get("forwardPE"),
            "trailing_pe": info.get("trailingPE"),
            "profit_margins": info.get("profitMargins"),
            "revenue_growth": info.get("revenueGrowth"),
            "total_debt_to_equity": info.get("debtToEquity"),
            "market_cap": info.get("marketCap")
        }

    target = datetime.strptime(as_of_date, "%Y-%m-%d")
    financials = stock.quarterly_financials
    balance_sheet = stock.quarterly_balance_sheet

    def eligible_columns(frame):
        return sorted(
            [column for column in frame.columns if column.to_pydatetime() <= target],
            reverse=True
        ) if not frame.empty else []

    financial_columns = eligible_columns(financials)
    balance_columns = eligible_columns(balance_sheet)
    financial_column = financial_columns[0] if financial_columns else None
    balance_column = balance_columns[0] if balance_columns else None

    def value(frame, row, column):
        if column is None or row not in frame.index:
            return None
        result = frame.at[row, column]
        return None if result is None or (isinstance(result, float) and math.isnan(result)) else float(result)

    revenue = value(financials, "Total Revenue", financial_column)
    net_income = value(financials, "Net Income", financial_column)
    prior_revenue = value(financials, "Total Revenue", financial_columns[4]) if len(financial_columns) > 4 else None
    debt = value(balance_sheet, "Total Debt", balance_column)
    equity = value(balance_sheet, "Stockholders Equity", balance_column)
    shares = value(balance_sheet, "Ordinary Shares Number", balance_column)
    price_history = stock.history(start=target - timedelta(days=7), end=target + timedelta(days=1))
    close = float(price_history["Close"].iloc[-1]) if not price_history.empty else None

    return {
        "symbol": ticker.upper(),
        "company_name": info.get("shortName"),
        "forward_pe": None,
        "trailing_pe": None,
        "profit_margins": net_income / revenue if revenue else None,
        "revenue_growth": revenue / prior_revenue - 1 if revenue and prior_revenue else None,
        "total_debt_to_equity": debt / equity * 100 if debt is not None and equity else None,
        "market_cap": close * shares if close is not None and shares is not None else None,
        "shares_outstanding": shares,
        "reported_period_end": financial_column.strftime("%Y-%m-%d") if financial_column is not None else None,
        "as_of_date": as_of_date,
    }

@mcp.tool()
def get_stock_price(ticker: str, as_of_date: str | None = None, start_date: str | None = None, end_date: str | None = None) -> dict:
    """Fetch real-time pricing information for a given stock ticker."""
    stock = yf.Ticker(ticker)
    selected_end = end_date or as_of_date
    if selected_end:
        target = datetime.strptime(selected_end, "%Y-%m-%d")
        same_day = start_date and start_date == selected_end
        history_start = target - timedelta(days=5) if same_day else (
            datetime.strptime(start_date, "%Y-%m-%d") if start_date else target - timedelta(days=5)
        )
        history = stock.history(start=history_start, end=target + timedelta(days=1))
        if history.empty:
            history = stock.history(period="max")
            if not history.empty and getattr(history.index, "tz", None) is not None:
                history.index = history.index.tz_localize(None)
            if not history.empty:
                history = history[history.index < target + timedelta(days=1)]
        if history.empty:
            return {"error": f"No price data available for {ticker} on or before {selected_end}"}
        row = history.iloc[-1]
        previous = history.iloc[-2]["Close"] if len(history) > 1 else None
        comparison_row = history.iloc[0] if start_date else history.iloc[-2] if len(history) > 1 else None
        start_close = comparison_row["Close"] if comparison_row is not None else None
        return {
            "symbol": ticker.upper(),
            "last_price": round(float(row["Close"]), 2),
            "previous_close": round(float(previous), 2) if previous is not None else None,
            "start_close": round(float(start_close), 2) if start_close is not None else None,
            "end_close": round(float(row["Close"]), 2),
            "currency": "USD",
            "as_of_date": row.name.strftime("%Y-%m-%d"),
            "period_start_date": comparison_row.name.strftime("%Y-%m-%d") if comparison_row is not None else None,
            "period_end_date": row.name.strftime("%Y-%m-%d"),
            "start_date": start_date,
            "end_date": end_date,
        }
    fast_info = stock.fast_info
    return {
        "symbol": ticker.upper(),
        "last_price": round(fast_info.get("lastPrice", 0), 2),
        "previous_close": round(fast_info.get("previousClose", 0), 2),
        "currency": fast_info.get("currency")
    }

if __name__ == "__main__":
    mcp.run(transport="stdio")