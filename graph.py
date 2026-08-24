import os
import sys
import json
from typing import TypedDict, Optional

import certifi
from dotenv import load_dotenv
from langchain_openai import ChatOpenAI
from langchain_mcp_adapters.client import MultiServerMCPClient
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import StateGraph, END
from langgraph.types import Command, interrupt

load_dotenv(".env")

os.environ["SSL_CERT_FILE"] = certifi.where()
os.environ["REQUESTS_CA_BUNDLE"] = certifi.where()

# OpenAI model
LLM_MODEL = os.environ.get(
    "RISK_AGENT_LLM_MODEL",
    "gpt-4o-mini"
)

# --- risk scoring thresholds
DEEP_DIVE_SCORE_THRESHOLD = 70
DEEP_DIVE_FLAG_COUNT_THRESHOLD = 3
HIGH_RISK_SCORE_THRESHOLD = 60
DRAWDOWN_SCORE_THRESHOLD = -0.25


class RiskState(TypedDict, total=False):
    ticker: str
    as_of_date: Optional[str]
    start_date: Optional[str]
    end_date: Optional[str]
    price_data: dict
    fundamentals: dict
    risk_metrics: dict
    liquidity: dict
    news: str
    risk_score: float
    risk_flags: list[str]
    requires_deep_dive: bool
    deep_dive_notes: Optional[str]
    report: str
    errors: list[str]
    human_decision: Optional[str]


def _mcp_client() -> MultiServerMCPClient:
    """Spawns the three stdio MCP servers as subprocesses."""
    return MultiServerMCPClient(
        {
            "stock_tools": {
                "command": sys.executable,
                "args": ["stock_mcp.py"],
                "transport": "stdio",
            },
            "risk_tools": {
                "command": sys.executable,
                "args": ["risk_mcp.py"],
                "transport": "stdio",
            },
            "search_tools": {
                "command": sys.executable,
                "args": ["search_mcp.py"],
                "transport": "stdio",
            },
        }
    )


async def _call_tool(tools: dict, name: str, **kwargs) -> dict:
    """Invoke an MCP tool and normalize failures."""
    tool = tools.get(name)

    if tool is None:
        return {
            "error": f"tool '{name}' not found on any connected MCP server"
        }

    try:
        result = await tool.ainvoke(kwargs)

        return (
            result
            if isinstance(result, dict)
            else {"raw": result}
        )

    except Exception as e:
        return {
            "error": f"{type(e).__name__}: {e}"
        }


def _metric_data(payload) -> dict:
    if isinstance(payload, dict):
        if "raw" in payload:
            return _metric_data(payload["raw"])
        if "text" in payload:
            return _metric_data(payload["text"])
        return payload
    if isinstance(payload, list):
        for block in payload:
            parsed = _metric_data(block)
            if parsed:
                return parsed
        return {}
    if isinstance(payload, str):
        try:
            parsed = json.loads(payload)
        except json.JSONDecodeError:
            return {}
        return parsed if isinstance(parsed, dict) else _metric_data(parsed)
    if hasattr(payload, "text"):
        return _metric_data(payload.text)
    return {}


def _text_data(payload) -> str:
    if payload is None:
        return ""
    if isinstance(payload, str):
        return payload
    if isinstance(payload, dict):
        if "raw" in payload:
            return _text_data(payload["raw"])
        if "text" in payload:
            return _text_data(payload["text"])
        return json.dumps(payload, default=str)
    if isinstance(payload, list):
        return "\n\n".join(
            text for item in payload
            if (text := _text_data(item))
        )
    if hasattr(payload, "text"):
        return _text_data(payload.text)
    return str(payload)


def build_graph(tools: dict, llm: ChatOpenAI):

    async def init(state: RiskState):
        return {
            "ticker": state["ticker"].upper(),
            "as_of_date": state.get("as_of_date"),
            "start_date": state.get("start_date"),
            "end_date": state.get("end_date"),
            "errors": []
        }


    async def fetch_price(state: RiskState):
        return {
            "price_data": await _call_tool(
                tools,
                "get_stock_price",
                ticker=state["ticker"],
                as_of_date=state.get("as_of_date"),
                start_date=state.get("start_date"),
                end_date=state.get("end_date")
            )
        }


    async def fetch_fundamentals(state: RiskState):
        return {
            "fundamentals": await _call_tool(
                tools,
                "get_stock_fundamentals",
                ticker=state["ticker"],
                as_of_date=state.get("as_of_date")
            )
        }


    async def fetch_risk_metrics(state: RiskState):
        return {
            "risk_metrics": await _call_tool(
                tools,
                "get_risk_metrics",
                ticker=state["ticker"],
                as_of_date=state.get("as_of_date"),
                start_date=state.get("start_date"),
                end_date=state.get("end_date")
            )
        }


    async def fetch_liquidity(state: RiskState):
        return {
            "liquidity": await _call_tool(
                tools,
                "get_liquidity_metrics",
                ticker=state["ticker"],
                as_of_date=state.get("as_of_date"),
                start_date=state.get("start_date"),
                end_date=state.get("end_date")
            )
        }


    async def fetch_news(state: RiskState):
        result = await _call_tool(
            tools,
            "search_market_news",
            query=f"{state['ticker']} stock risk news",
            max_results=5
        )

        return {
            "news": _text_data(result.get("raw", result.get("error", "")))
        }


    async def score_risk(state: RiskState):

        flags: list[str] = []
        score = 0.0

        risk = _metric_data(state.get("risk_metrics", {}))
        fundamentals = _metric_data(state.get("fundamentals", {}))
        liquidity = _metric_data(state.get("liquidity", {}))

        vol = risk.get("annualized_volatility")

        if vol is not None:
            score += min(vol * 100, 40)

            if vol > 0.45:
                flags.append(
                    "High annualized volatility (>45%)"
                )


        beta = risk.get("beta_vs_benchmark")

        if beta is not None:
            score += min(
                max(beta - 1, 0) * 20,
                20
            )

            if beta > 1.5:
                flags.append(
                    "Elevated beta vs benchmark (>1.5)"
                )


        max_dd = risk.get("max_drawdown_1y")

        if max_dd is not None and max_dd < DRAWDOWN_SCORE_THRESHOLD:
            score += 15

            flags.append(
                "Large max drawdown over trailing year (>25%)"
            )

        trading_days_used = risk.get("trading_days_used")
        if trading_days_used is not None and trading_days_used < 30:
            flags.append(
                "Limited price history available for risk estimates (<30 trading days)"
            )


        debt_to_equity = fundamentals.get(
            "total_debt_to_equity"
        )

        if (
            debt_to_equity is not None
            and debt_to_equity > 150
        ):
            score += 15

            flags.append(
                "High debt-to-equity ratio (>150)"
            )


        short_pct = liquidity.get(
            "short_percent_of_float"
        )

        if short_pct is not None and short_pct > 0.10:
            score += 10

            flags.append(
                "Elevated short interest (>10% of float)"
            )


        score = round(
            min(score, 100),
            1
        )

        requires_deep_dive = (
            score >= DEEP_DIVE_SCORE_THRESHOLD
            or
            len(flags) >= DEEP_DIVE_FLAG_COUNT_THRESHOLD
            or
            (trading_days_used is not None and trading_days_used < 30)
        )

        return {
            "risk_score": score,
            "risk_flags": flags,
            "requires_deep_dive": requires_deep_dive
        }


    async def join_fetches(state: RiskState):
        return {}


    def human_review(state: RiskState):
        decision = interrupt({
            "type": "high_risk_stock",
            "ticker": state["ticker"],
            "score": state.get("risk_score", 0),
            "flags": state.get("risk_flags", []),
            "message": f"{state['ticker']} is high risk. Choose whether to keep it in the comparison."
        })
        if decision not in {"keep", "remove"}:
            raise ValueError("Human decision must be 'keep' or 'remove'")
        return {"human_decision": decision}


    async def remove_high_risk(state: RiskState):
        return {"human_decision": "remove"}


    def route_after_score(state: RiskState) -> str:
        if state.get("risk_score", 0) >= HIGH_RISK_SCORE_THRESHOLD:
            return "human_review"
        return (
            "deep_dive"
            if state.get("requires_deep_dive")
            else "generate_report"
        )


    def route_after_human_review(state: RiskState) -> str:
        return "remove_high_risk" if state.get("human_decision") == "remove" else (
            "deep_dive" if state.get("requires_deep_dive") else "generate_report"
        )


    async def deep_dive(state: RiskState):

        flag_summary = "; ".join(
            state.get("risk_flags", [])
        )
        company_name = _metric_data(
            state.get("fundamentals", {})
        ).get("company_name", state["ticker"])

        query = (
            f"{company_name} {state['ticker']} recent news "
            "bankruptcy restructuring delisting lawsuit investigation "
            "leadership earnings surprise SEC filing going concern "
            "reverse split insider selling short interest guidance analyst "
            f"{flag_summary}"
        )

        result = await _call_tool(
            tools,
            "search_market_news",
            query=query,
            max_results=5
        )

        if result.get("error"):
            return {"deep_dive_notes": ""}

        research_text = _text_data(result.get("raw", ""))
        try:
            has_results = bool(json.loads(research_text))
        except (json.JSONDecodeError, TypeError):
            has_results = bool(research_text.strip())

        if not has_results:
            fallback_result = await _call_tool(
                tools,
                "search_market_news",
                query=f"{company_name} {state['ticker']} latest news earnings filings",
                max_results=5
            )
            if fallback_result.get("error"):
                return {"deep_dive_notes": ""}
            research_text = _text_data(fallback_result.get("raw", ""))

        return {
            "deep_dive_notes": research_text
        }


    async def generate_report(state: RiskState):

        risk = _metric_data(state.get("risk_metrics", {}))
        fundamentals = _metric_data(state.get("fundamentals", {}))
        liquidity = _metric_data(state.get("liquidity", {}))

        prompt = f"""
You are a financial risk analyst.

Write a fact-focused deep-dive risk report for {state['ticker']} as of {state.get('as_of_date') or 'the latest available date'}.

Risk score:
{state.get('risk_score')}/100

Risk flags:
{state.get('risk_flags')}

Fundamentals:
{fundamentals}

Risk metrics:
{risk}

Liquidity:
{liquidity}

Recent news:
{state.get('news', '')[:1500]}

Deep dive notes:
{state.get('deep_dive_notes', 'N/A')}

Write exactly 5 sections using these headings, with each heading on its own line:

### What's actually happening
Summarize the 3-4 most important recent news events and give approximate dates. Include the current legal or corporate status if bankruptcy, restructuring, delisting, or a similar event applies.

### Why the risk metrics look the way they do
For each relevant metric, give the number and explain the underlying business reason for it. Do not merely define the metric.

### Red flags
List concrete warning signs such as trading halts, reverse splits, delisting notices, going-concern language, insider selling, or high short interest, with a source and date for each supported fact.

### Scenario analysis
Give 2-3 concrete conditions that could support recovery and 2-3 concrete conditions that could drive severe loss or make the equity worthless.

### What to watch next
List specific upcoming catalysts such as earnings dates, court dates, filing deadlines, expiring warrants/options, guidance, or analyst revisions. Give expected timing only when supported; otherwise say that timing was not found.

Every factual claim from deep-dive research must include the actual article title,
direct URL, and publication date in brackets, for example: [Source title, 2026-08-20,
https://example.com/article]. Do not cite generic homepages. If a date is unavailable,
write "date not provided" rather than guessing. Clearly label your own reasoning as
"Inference:". Distinguish reported information from risk interpretation.

The deep-dive input contains search-result summaries, not guaranteed full-text access.
Do not claim an article says anything beyond its title or snippet, and say when the
available evidence is insufficient. Do not invent financial data, events, dates,
legal status, catalysts, or source citations.

Do not invent financial data.
"""

        response = await llm.ainvoke(prompt)

        return {
            "report": response.content
        }


    graph = StateGraph(RiskState)

    graph.add_node("init", init)
    graph.add_node("fetch_price", fetch_price)
    graph.add_node("fetch_fundamentals", fetch_fundamentals)
    graph.add_node("fetch_risk_metrics", fetch_risk_metrics)
    graph.add_node("fetch_liquidity", fetch_liquidity)
    graph.add_node("fetch_news", fetch_news)
    graph.add_node("join_fetches", join_fetches)
    graph.add_node("human_review", human_review)
    graph.add_node("remove_high_risk", remove_high_risk)
    graph.add_node("score_risk", score_risk)
    graph.add_node("deep_dive", deep_dive)
    graph.add_node("generate_report", generate_report)


    graph.set_entry_point("init")

    for fetch_node in [
        "fetch_price",
        "fetch_fundamentals",
        "fetch_risk_metrics",
        "fetch_liquidity",
        "fetch_news"
    ]:
        graph.add_edge(
            "init",
            fetch_node
        )

        graph.add_edge(fetch_node, "join_fetches")

    graph.add_edge("join_fetches", "score_risk")


    graph.add_conditional_edges(
        "score_risk",
        route_after_score,
        {
            "human_review": "human_review",
            "deep_dive": "deep_dive",
            "generate_report": "generate_report"
        }
    )

    graph.add_conditional_edges(
        "human_review",
        route_after_human_review,
        {
            "remove_high_risk": "remove_high_risk",
            "deep_dive": "deep_dive",
            "generate_report": "generate_report"
        }
    )

    graph.add_edge("remove_high_risk", END)

    graph.add_edge(
        "deep_dive",
        "generate_report"
    )

    graph.add_edge(
        "generate_report",
        END
    )

    return graph.compile(checkpointer=MemorySaver())


# ---------------------------------------------
# Cached singletons: the MCP subprocesses, tool
# list, LLM client, and compiled graph are all
# expensive to (re)create, so build them once and
# reuse across requests instead of per-ticker.
# ---------------------------------------------
_app_cache = None
_app_lock = None


async def _get_app():
    global _app_cache, _app_lock

    import asyncio

    if _app_lock is None:
        _app_lock = asyncio.Lock()

    if _app_cache is not None:
        return _app_cache

    async with _app_lock:
        if _app_cache is not None:
            return _app_cache

        client = _mcp_client()
        tool_list = await client.get_tools()
        tools = {t.name: t for t in tool_list}

        llm = ChatOpenAI(
            model=LLM_MODEL,
            temperature=0.2,
        )

        _app_cache = build_graph(tools, llm)
        return _app_cache


async def run_analysis(ticker: str, as_of_date: str | None = None, start_date: str | None = None, end_date: str | None = None, thread_id: str | None = None, decision: str | None = None) -> dict:

    app = await _get_app()

    config = {"configurable": {"thread_id": thread_id or f"{ticker}:{start_date}:{end_date}"}}
    input_data = Command(resume=decision) if decision else {
        "ticker": ticker,
        "as_of_date": as_of_date,
        "start_date": start_date,
        "end_date": end_date
    }
    final_state = await app.ainvoke(input_data, config=config)
    pending = final_state.get("__interrupt__")
    if pending:
        return {
            "status": "interrupted",
            "thread_id": config["configurable"]["thread_id"],
            "interrupt": pending[0].value,
        }
    if final_state.get("human_decision") == "remove":
        return {
            "status": "removed",
            "ticker": final_state.get("ticker", ticker),
            "risk_score": final_state.get("risk_score", 0),
            "risk_flags": final_state.get("risk_flags", []),
        }
    final_state["status"] = "completed"
    return final_state