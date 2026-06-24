import { createChart, IChartApi, ColorType } from "lightweight-charts";
import { useEffect, useRef } from "react";

type Zone = { low: number; high: number; mid: number; touches: number };
type Candle = { time: number; open: number; high: number; low: number; close: number };

/** Price-axis precision matched to the instrument (same buckets as the table):
 *  forex 4 dp, JPY 3 dp, BTC/ETH/SOL 2 dp, sub-€1 coins (XRP/DOGE) 5 dp. */
function priceFormat(symbol: string): { precision: number; minMove: number } {
  if (symbol.includes("JPY")) return { precision: 3, minMove: 0.001 };
  if (symbol === "XRPUSD" || symbol === "DOGEUSD") return { precision: 5, minMove: 0.00001 };
  if (["BTCUSD", "ETHUSD", "SOLUSD"].includes(symbol)) return { precision: 2, minMove: 0.01 };
  return { precision: 4, minMove: 0.0001 };   // forex
}

export function ChartPanel({ candles, zones, symbol }:
                           { candles: Candle[]; zones: Zone[]; symbol: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi>();

  useEffect(() => {
    if (!ref.current) return;
    const chart = createChart(ref.current, {
      height: 460,
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "#0e1117" }, textColor: "#c9d1d9" },
      grid: { vertLines: { color: "#1b1f27" }, horzLines: { color: "#1b1f27" } },
      timeScale: { timeVisible: true },
    });
    chartRef.current = chart;
    const series = chart.addCandlestickSeries({
      upColor: "#3fb950", downColor: "#f85149",
      wickUpColor: "#3fb950", wickDownColor: "#f85149", borderVisible: false,
      priceFormat: { type: "price", ...priceFormat(symbol) },
    });
    series.setData(candles as any);

    // Areas of interest → edge lines (red = resistance edge, green = support edge,
    // amber dashed = mid / best entry). Touch count shown on the upper edge.
    zones.forEach((z) => {
      series.createPriceLine({ price: z.high, color: "#f85149", lineWidth: 1, title: `▼ ${z.touches}` });
      series.createPriceLine({ price: z.mid, color: "#d29922", lineWidth: 1, lineStyle: 2, title: "mid" });
      series.createPriceLine({ price: z.low, color: "#3fb950", lineWidth: 1, title: "▲" });
    });

    return () => chart.remove();
  }, [candles, zones, symbol]);

  return <div ref={ref} style={{ width: "100%" }} />;
}
