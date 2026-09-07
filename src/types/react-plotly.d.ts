declare module "react-plotly.js" {
  import type { Component, CSSProperties } from "react"
  import type { Config, Data, Layout, PlotRelayoutEvent } from "plotly.js"

  export interface PlotParams {
    data: Data[]
    layout?: Partial<Layout>
    config?: Partial<Config>
    style?: CSSProperties
    className?: string
    useResizeHandler?: boolean
    // Fired on user-driven zoom/pan/autoscale -- added for
    // SolarSystemMap2D's manual zoom/pan tracking (see that file). This
    // hand-written shim only declares what's actually been needed so far,
    // not react-plotly.js's full real event surface.
    onRelayout?: (event: PlotRelayoutEvent) => void
  }

  export default class Plot extends Component<PlotParams> {}
}
