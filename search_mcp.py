import json
import sys
from mcp.server.fastmcp import FastMCP
from ddgs import DDGS

mcp = FastMCP("MarketNewsSearch")

@mcp.tool()
def search_market_news(query: str, max_results: int = 5) -> str:
    """Search for recent market news, stock updates, and financial articles."""

    print(f"[MCP SEARCH] Query: {query}", file=sys.stderr)

    try:
        results = []

        with DDGS() as ddgs:
            ddg_results = ddgs.text(
                query,
                max_results=max_results
            )

            for r in ddg_results:
                title = r.get("title", "")
                snippet = r.get("body", "")
                url = r.get("href", "")

                if title and url:
                    results.append({
                        "title": title,
                        "snippet": snippet,
                        "url": url,
                        "date": r.get("date", ""),
                    })

        print(
            f"[MCP SEARCH] Results: {len(results)}",
            file=sys.stderr
        )

        if not results:
            return json.dumps([])

        return json.dumps(results)

    except Exception as e:
        if "No results found" in str(e):
            print("[MCP SEARCH] No results found", file=sys.stderr)
            return json.dumps([])

        print(
            f"[MCP SEARCH ERROR] {type(e).__name__}: {e}",
            file=sys.stderr
        )

        return (
            f"Search tool error: "
            f"{type(e).__name__}: {e}"
        )

if __name__ == "__main__":
    mcp.run(transport="stdio")