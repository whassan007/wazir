import SwiftUI

// MARK: - Generic flow graph

enum FlowStatus: Equatable {
    case potential, chosen, queued, running, done, failed, retrying, skipped

    var label: String {
        switch self {
        case .potential: "Standby"
        case .chosen: "Chosen"
        case .queued: "Queued"
        case .running: "Running"
        case .done: "Done"
        case .failed: "Failed"
        case .retrying: "Retrying"
        case .skipped: "Skipped"
        }
    }

    /// Coolant colour for this state.
    var color: Color {
        switch self {
        case .potential: Color(red: 0.34, green: 0.38, blue: 0.45)
        case .chosen: Color(red: 0.38, green: 0.62, blue: 1.00)
        case .queued: Color(red: 0.45, green: 0.50, blue: 0.58)
        case .running: Color(red: 0.20, green: 0.82, blue: 1.00)
        case .done: Color(red: 0.25, green: 0.95, blue: 0.62)
        case .failed: Color(red: 1.00, green: 0.30, blue: 0.36)
        case .retrying: Color(red: 1.00, green: 0.70, blue: 0.22)
        case .skipped: Color(red: 0.36, green: 0.38, blue: 0.44)
        }
    }

    var isActive: Bool { self == .running || self == .retrying }
}

/// One block in the loop. Times share the graph's timebase (seconds).
struct FlowNode: Identifiable, Equatable {
    var id: String
    var title: String
    var subtitle: String
    var wave: Int
    var deps: [String]
    var status: FlowStatus
    /// nil while running means "progress unknown".
    var progress: Double?
    var detail: String
    var appearedAt: Double?
    var startedAt: Double?
    var finishedAt: Double?
    var machineID: String = ""
    var memoryLabel: String = ""
    var memoryFraction: Double? = nil
    var gpuLabel: String = ""
    var tokenLabel: String = ""
    var spendLabel: String = ""
}

struct FlowGraph: Equatable {
    var nodes: [FlowNode]
    var sourceLabel: String
    /// Shown under the pump, e.g. the machine and model that plans the prompt.
    var sourceSubtitle: String = ""
    /// When the pump started pushing into the root nodes.
    var sourceActiveAt: Double?
    var isActive: Bool

    static let empty = FlowGraph(nodes: [], sourceLabel: "Idle", sourceActiveAt: nil, isActive: false)
    func node(_ id: String?) -> FlowNode? { nodes.first { $0.id == id } }
}

enum FlowTheme {
    static let background = Color(red: 0.03, green: 0.035, blue: 0.055)
}

// MARK: - Layout

struct FlowLayout {
    var rects: [String: CGRect] = [:]
    var pump: CGPoint
    let pumpRadius: CGFloat = 38

    init(nodes: [FlowNode], size: CGSize) {
        let maxWave = nodes.map(\.wave).max() ?? 0
        let cols = max(maxWave + 2, 6)
        let left: CGFloat = 80
        let step = (size.width - 110 - left) / CGFloat(cols - 1)
        let blockW = min(214, step * 0.84)
        let blockH: CGFloat = 90
        let right = size.width - blockW / 2 - 24
        let realStep = (right - left) / CGFloat(cols - 1)
        pump = CGPoint(x: left, y: size.height / 2)
        guard !nodes.isEmpty else { return }
        for w in 0...maxWave {
            let col = nodes.filter { $0.wave == w }
            let n = col.count
            let gap = min(blockH + 26, (size.height - 50) / CGFloat(max(n, 1)))
            let x = left + realStep * CGFloat(w + 1)
            for (i, node) in col.enumerated() {
                let y = size.height / 2 + (CGFloat(i) - CGFloat(n - 1) / 2) * gap
                rects[node.id] = CGRect(x: x - blockW / 2, y: y - blockH / 2, width: blockW, height: blockH)
            }
        }
    }

    /// Applies the user's manual drags on top of the automatic layout.
    init(nodes: [FlowNode], size: CGSize, offsets: [String: CGSize]) {
        self.init(nodes: nodes, size: size)
        for (id, r) in rects { if let o = offsets[id] { rects[id] = r.offsetBy(dx: o.width, dy: o.height) } }
        if let o = offsets[FlowLayout.pumpID] { pump = CGPoint(x: pump.x + o.width, y: pump.y + o.height) }
    }

    static let pumpID = "__pump__"

    func hit(_ p: CGPoint) -> String? {
        if hypot(p.x - pump.x, p.y - pump.y) <= pumpRadius + 6 { return Self.pumpID }
        return rects.first { $0.value.insetBy(dx: -6, dy: -6).contains(p) }?.key
    }
}

/// Pan, zoom and per-block positions the user has dragged. World → screen is `p * zoom + pan`.
struct FlowViewport: Equatable {
    var pan: CGSize = .zero
    var zoom: CGFloat = 1
    var offsets: [String: CGSize] = [:]

    func toWorld(_ p: CGPoint) -> CGPoint { CGPoint(x: (p.x - pan.width) / zoom, y: (p.y - pan.height) / zoom) }
    func toScreen(_ p: CGPoint) -> CGPoint { CGPoint(x: p.x * zoom + pan.width, y: p.y * zoom + pan.height) }

    /// Zooms about a screen point so the content under it stays put.
    mutating func zoom(to z: CGFloat, around anchor: CGPoint) {
        let nz = min(2.5, max(0.4, z))
        let w = toWorld(anchor)
        zoom = nz
        pan = CGSize(width: anchor.x - w.x * nz, height: anchor.y - w.y * nz)
    }
}

private struct Bezier {
    let a, c1, c2, b: CGPoint
    init(_ a: CGPoint, _ b: CGPoint) {
        self.a = a; self.b = b
        let dx = max(40, (b.x - a.x) * 0.55)
        c1 = CGPoint(x: a.x + dx, y: a.y)
        c2 = CGPoint(x: b.x - dx, y: b.y)
    }
    var path: Path { var p = Path(); p.move(to: a); p.addCurve(to: b, control1: c1, control2: c2); return p }
    func point(_ t: CGFloat) -> CGPoint {
        let u = 1 - t
        return CGPoint(x: u*u*u*a.x + 3*u*u*t*c1.x + 3*u*t*t*c2.x + t*t*t*b.x,
                       y: u*u*u*a.y + 3*u*u*t*c1.y + 3*u*t*t*c2.y + t*t*t*b.y)
    }
    var length: CGFloat {
        var len: CGFloat = 0, prev = a
        for i in 1...24 { let p = point(CGFloat(i) / 24); len += hypot(p.x - prev.x, p.y - prev.y); prev = p }
        return len
    }
}

// MARK: - Liquid-cooling renderer

/// `now` drives state-based animation (fills, appear), `clock` drives the continuous flow.
/// Drag empty space to pan, drag a block or the pump to move it, pinch to zoom.
/// Clicking the pump calls `onPumpTap`; `pumpPopover` is anchored to the pump.
struct FlowCanvas<Popover: View>: View {
    var graph: FlowGraph
    var now: Double
    var clock: Double
    @Binding var selection: String?
    @Binding var viewport: FlowViewport
    var pumpHint: String? = nil
    @Binding var showPumpPopover: Bool
    @ViewBuilder var pumpPopover: () -> Popover

    @State private var drag: DragState?
    @State private var zoomStart: CGFloat?
    @State private var hovering: String?

    private struct DragState {
        var target: String?  // node id, pump id, or nil for panning
        var startOffset: CGSize
        var startPan: CGSize
    }


    var body: some View {
        GeometryReader { geo in
            let layout = FlowLayout(nodes: graph.nodes, size: geo.size, offsets: viewport.offsets)
            let pumpScreen = viewport.toScreen(layout.pump)
            Canvas { ctx, size in draw(&ctx, size: size, layout: layout) }
                .contentShape(Rectangle())
                .gesture(dragGesture(layout: layout))
                .simultaneousGesture(MagnifyGesture()
                    .onChanged { v in
                        let start = zoomStart ?? viewport.zoom
                        zoomStart = start
                        viewport.zoom(to: start * v.magnification, around: v.startLocation)
                    }
                    .onEnded { _ in zoomStart = nil })
                .onContinuousHover { phase in
                    switch phase {
                    case .active(let p): hovering = layout.hit(viewport.toWorld(p))
                    case .ended: hovering = nil
                    }
                }
                .overlay(alignment: .topLeading) {
                    // Invisible anchor so the popover points at the pump wherever it has been dragged.
                    Color.clear
                        .frame(width: layout.pumpRadius * 2 * viewport.zoom, height: layout.pumpRadius * 2 * viewport.zoom)
                        .position(pumpScreen)
                        .allowsHitTesting(false)
                        .popover(isPresented: $showPumpPopover, arrowEdge: .trailing) { pumpPopover() }
                }
                .overlay(alignment: .topLeading) {
                    if let pumpHint {
                        Text(pumpHint)
                            .font(.system(size: 11, weight: .medium))
                            .padding(.horizontal, 8).padding(.vertical, 4)
                            .background(Capsule().fill(FlowStatus.running.color.opacity(0.18)))
                            .overlay(Capsule().stroke(FlowStatus.running.color.opacity(0.5)))
                            .foregroundStyle(.white)
                            .fixedSize()
                            .position(x: pumpScreen.x, y: pumpScreen.y - (layout.pumpRadius + 22) * viewport.zoom)
                            .allowsHitTesting(false)
                    }
                }
        }
    }

    private func dragGesture(layout: FlowLayout) -> some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { v in
                if drag == nil {
                    let target = layout.hit(viewport.toWorld(v.startLocation))
                    drag = DragState(target: target, startOffset: target.flatMap { viewport.offsets[$0] } ?? .zero,
                                     startPan: viewport.pan)
                }
                guard let d = drag, hypot(v.translation.width, v.translation.height) > 3 else { return }
                if let t = d.target {
                    viewport.offsets[t] = CGSize(width: d.startOffset.width + v.translation.width / viewport.zoom,
                                                 height: d.startOffset.height + v.translation.height / viewport.zoom)
                } else {
                    viewport.pan = CGSize(width: d.startPan.width + v.translation.width,
                                          height: d.startPan.height + v.translation.height)
                }
            }
            .onEnded { v in
                defer { drag = nil }
                guard hypot(v.translation.width, v.translation.height) <= 3 else { return }
                // A click, not a drag.
                switch layout.hit(viewport.toWorld(v.startLocation)) {
                case FlowLayout.pumpID?: showPumpPopover = true
                case let id: selection = id
                }
            }
    }

    private func draw(_ ctx: inout GraphicsContext, size: CGSize, layout: FlowLayout) {
        ctx.fill(Path(CGRect(origin: .zero, size: size)), with: .color(FlowTheme.background))
        // Grid dots move with the pan and zoom so dragging feels anchored.
        var dots = Path()
        let spacing = 28 * viewport.zoom
        let ox = viewport.pan.width.truncatingRemainder(dividingBy: spacing)
        let oy = viewport.pan.height.truncatingRemainder(dividingBy: spacing)
        for x in stride(from: ox - spacing, to: size.width, by: spacing) {
            for y in stride(from: oy - spacing, to: size.height, by: spacing) {
                dots.addEllipse(in: CGRect(x: x - 0.8, y: y - 0.8, width: 1.6, height: 1.6))
            }
        }
        ctx.fill(dots, with: .color(.white.opacity(0.045)))
        ctx.translateBy(x: viewport.pan.width, y: viewport.pan.height)
        ctx.scaleBy(x: viewport.zoom, y: viewport.zoom)

        let byID = Dictionary(graph.nodes.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })

        for node in graph.nodes {
            guard let to = layout.rects[node.id] else { continue }
            let inlet = CGPoint(x: to.minX, y: to.midY)
            if node.deps.isEmpty {
                let out = CGPoint(x: layout.pump.x + layout.pumpRadius, y: layout.pump.y)
                drawTube(&ctx, Bezier(out, inlet), activatedAt: graph.sourceActiveAt, target: node, appear: appear(node))
            }
            for d in node.deps {
                guard let src = byID[d], let from = layout.rects[d] else { continue }
                drawTube(&ctx, Bezier(CGPoint(x: from.maxX, y: from.midY), inlet), activatedAt: src.finishedAt,
                         target: node, appear: min(appear(node), appear(src)))
            }
        }
        drawPump(&ctx, at: layout.pump, radius: layout.pumpRadius)
        for node in graph.nodes {
            if let r = layout.rects[node.id] { drawBlock(&ctx, node: node, rect: r) }
        }
        if graph.nodes.isEmpty {
            ctx.draw(Text("Nothing flowing yet").font(.system(size: 14)).foregroundColor(.white.opacity(0.4)),
                     at: CGPoint(x: size.width / 2, y: size.height / 2))
        }
    }

    private func appear(_ n: FlowNode) -> Double {
        guard let t = n.appearedAt else { return 1 }
        return min(1, max(0, (now - t) / 0.6))
    }

    private func drawTube(_ ctx: inout GraphicsContext, _ bz: Bezier, activatedAt: Double?, target: FlowNode, appear: Double) {
        guard appear > 0 else { return }
        let path = bz.path
        ctx.opacity = appear
        ctx.stroke(path, with: .color(Color(white: 0.17)), style: StrokeStyle(lineWidth: 17, lineCap: .round))
        ctx.stroke(path, with: .color(Color(white: 0.055)), style: StrokeStyle(lineWidth: 13, lineCap: .round))

        if let activatedAt, target.status != .skipped {
            let fill = CGFloat(min(1, max(0, (now - activatedAt) / 0.9)))
            let (color, speed, intensity): (Color, Double, Double) = {
                switch target.status {
                case .running: (FlowStatus.running.color, 90, 1)
                case .retrying: (FlowStatus.retrying.color, 70, 1)
                case .failed: (FlowStatus.failed.color, 0, 0.55 + 0.45 * abs(sin(clock * 5)))
                case .done: (FlowStatus.done.color, 14, 0.45)
                case .chosen: (FlowStatus.chosen.color, 18, 0.55)
                case .potential: (FlowStatus.potential.color, 0, 0.15)
                case .queued, .skipped: (FlowStatus.running.color, 4, 0.4) // pooled, waiting
                }
            }()
            if fill > 0 {
                let liquid = path.trimmedPath(from: 0, to: fill)
                ctx.drawLayer { l in
                    l.addFilter(.blur(radius: 8))
                    l.stroke(liquid, with: .color(color.opacity(0.55 * intensity)),
                             style: StrokeStyle(lineWidth: 16, lineCap: .round))
                }
                ctx.stroke(liquid, with: .color(color.opacity(0.35 + 0.5 * intensity)),
                           style: StrokeStyle(lineWidth: 8, lineCap: .round))
                ctx.stroke(liquid, with: .color(.white.opacity(0.32 * intensity)),
                           style: StrokeStyle(lineWidth: 2.4, lineCap: .round, dash: [5, 23],
                                              dashPhase: CGFloat(-clock * speed)))
                if speed > 20 {
                    let len = Double(bz.length)
                    for k in 0..<3 {
                        let f = CGFloat((clock * speed / len + Double(k) / 3).truncatingRemainder(dividingBy: 1)) * fill
                        let p = bz.point(f)
                        ctx.drawLayer { l in
                            l.addFilter(.blur(radius: 3))
                            l.fill(Path(ellipseIn: CGRect(x: p.x - 5, y: p.y - 5, width: 10, height: 10)), with: .color(color))
                        }
                        ctx.fill(Path(ellipseIn: CGRect(x: p.x - 2.6, y: p.y - 2.6, width: 5.2, height: 5.2)),
                                 with: .color(.white.opacity(0.9)))
                    }
                }
            }
        }
        ctx.stroke(path.applying(CGAffineTransform(translationX: 0, y: -4)),
                   with: .color(.white.opacity(0.07)), style: StrokeStyle(lineWidth: 1.5, lineCap: .round))
        ctx.opacity = 1
    }

    private func drawPump(_ ctx: inout GraphicsContext, at c: CGPoint, radius: CGFloat) {
        let col = graph.isActive ? FlowStatus.running.color : FlowStatus.queued.color
        let disc = Path(ellipseIn: CGRect(x: c.x - radius, y: c.y - radius, width: radius * 2, height: radius * 2))
        if graph.isActive {
            ctx.drawLayer { l in
                l.addFilter(.blur(radius: 16))
                l.fill(disc, with: .color(col.opacity(0.35 + 0.1 * sin(clock * 3))))
            }
        }
        ctx.fill(disc, with: .color(Color(red: 0.07, green: 0.08, blue: 0.11)))
        ctx.stroke(disc, with: .color(col.opacity(0.8)), lineWidth: 2)
        let angle = graph.isActive ? clock * 4 : 0
        var blades = Path()
        for i in 0..<6 {
            let a = angle + Double(i) * .pi / 3
            blades.move(to: CGPoint(x: c.x + cos(a) * 7, y: c.y + sin(a) * 7))
            blades.addQuadCurve(to: CGPoint(x: c.x + cos(a + 0.5) * (radius - 9), y: c.y + sin(a + 0.5) * (radius - 9)),
                                control: CGPoint(x: c.x + cos(a + 0.1) * radius * 0.6, y: c.y + sin(a + 0.1) * radius * 0.6))
        }
        ctx.stroke(blades, with: .color(col.opacity(0.9)), style: StrokeStyle(lineWidth: 3, lineCap: .round))
        ctx.fill(Path(ellipseIn: CGRect(x: c.x - 6, y: c.y - 6, width: 12, height: 12)), with: .color(col))
        if hovering == FlowLayout.pumpID {
            ctx.stroke(Path(ellipseIn: CGRect(x: c.x - radius - 5, y: c.y - radius - 5, width: radius * 2 + 10, height: radius * 2 + 10)),
                       with: .color(.white.opacity(0.35)), style: StrokeStyle(lineWidth: 1.5, dash: [4, 4]))
        }
        ctx.draw(Text(graph.sourceLabel).font(.system(size: 12, weight: .semibold)).foregroundColor(.white.opacity(0.85)),
                 at: CGPoint(x: c.x, y: c.y + radius + 16))
        if !graph.sourceSubtitle.isEmpty {
            ctx.draw(Text(Self.clip(graph.sourceSubtitle, 34)).font(.system(size: 10, design: .monospaced))
                        .foregroundColor(.white.opacity(0.5)),
                     at: CGPoint(x: c.x, y: c.y + radius + 31))
        }
    }

    private func drawBlock(_ ctx: inout GraphicsContext, node: FlowNode, rect r0: CGRect) {
        let a = appear(node)
        guard a > 0 else { return }
        let s = 0.85 + 0.15 * a
        let r = CGRect(x: r0.midX - r0.width * s / 2, y: r0.midY - r0.height * s / 2,
                       width: r0.width * s, height: r0.height * s)
        ctx.opacity = a * (node.status == .skipped ? 0.55 : 1)
        let col = node.status.color
        let shape = Path(roundedRect: r, cornerRadius: 14, style: .continuous)
        let selected = selection == node.id || hovering == node.id && selection == nil

        if node.status.isActive || node.status == .failed || selected {
            ctx.drawLayer { l in
                l.addFilter(.blur(radius: 14))
                l.fill(shape, with: .color(col.opacity(selected ? 0.5 : 0.22 + 0.12 * sin(clock * 3))))
            }
        }
        ctx.fill(shape, with: .color(Color(red: 0.065, green: 0.075, blue: 0.10)))

        let level: Double = switch node.status {
        case .done: 1
        case .running, .retrying: node.progress ?? (0.4 + 0.08 * sin(clock * 2))
        case .failed: node.progress ?? 0.5
        case .potential, .chosen, .queued, .skipped: 0
        }
        if level > 0 {
            var inner = ctx
            inner.clip(to: shape)
            let y0 = r.maxY - r.height * CGFloat(level)
            let amp: CGFloat = node.status.isActive ? 2.6 : 0.8
            var wave = Path()
            wave.move(to: CGPoint(x: r.minX, y: r.maxY))
            for x in stride(from: r.minX, through: r.maxX, by: 4) {
                wave.addLine(to: CGPoint(x: x, y: y0 + amp * CGFloat(sin(Double(x) / 13 + clock * 3.5))))
            }
            wave.addLine(to: CGPoint(x: r.maxX, y: r.maxY))
            wave.closeSubpath()
            inner.fill(wave, with: .linearGradient(Gradient(colors: [col.opacity(0.42), col.opacity(0.12)]),
                                                   startPoint: CGPoint(x: r.midX, y: y0),
                                                   endPoint: CGPoint(x: r.midX, y: r.maxY)))
        }
        if node.status == .potential {
            ctx.stroke(shape, with: .color(col.opacity(selected ? 0.9 : 0.45)),
                       style: StrokeStyle(lineWidth: selected ? 2 : 1.2, dash: [5, 4]))
        } else {
            ctx.stroke(shape, with: .color(col.opacity(selected ? 1 : 0.6)), lineWidth: selected ? 2 : 1.2)
        }

        for p in [CGPoint(x: r.minX, y: r.midY), CGPoint(x: r.maxX, y: r.midY)] {
            ctx.fill(Path(ellipseIn: CGRect(x: p.x - 6, y: p.y - 6, width: 12, height: 12)), with: .color(Color(white: 0.28)))
            ctx.fill(Path(ellipseIn: CGRect(x: p.x - 3, y: p.y - 3, width: 6, height: 6)), with: .color(Color(white: 0.1)))
        }

        let maxChars = Int(r.width / 8.2)
        ctx.draw(Text(Self.clip(node.title, maxChars)).font(.system(size: 13, weight: .semibold)).foregroundColor(.white),
                 at: CGPoint(x: r.minX + 14, y: r.minY + 16), anchor: .leading)
        ctx.draw(Text(Self.clip(node.subtitle, Int(r.width / 6.8)))
                    .font(.system(size: 11, design: .monospaced)).foregroundColor(.white.opacity(0.5)),
                 at: CGPoint(x: r.minX + 14, y: r.minY + 33), anchor: .leading)
        let label = Text(node.status.label).font(.system(size: 11, weight: .medium)).foregroundColor(col)
        let detail = Text(node.detail.isEmpty ? "" : "  " + Self.clip(node.detail, Int(r.width / 6.8) - 9))
            .font(.system(size: 11, design: .monospaced)).foregroundColor(.white.opacity(0.6))
        let status = Text("\(label)\(detail)")
        ctx.draw(status, at: CGPoint(x: r.minX + 14, y: r.minY + 50), anchor: .leading)
        let telemetryParts = [node.memoryLabel, node.gpuLabel, node.tokenLabel, node.spendLabel].filter { !$0.isEmpty }
        if !telemetryParts.isEmpty {
            let barRect = CGRect(x: r.minX + 14, y: r.minY + 66, width: r.width - 28, height: 3)
            ctx.fill(Path(roundedRect: barRect, cornerRadius: 1.5), with: .color(.white.opacity(0.08)))
            if let mf = node.memoryFraction {
                let fillW = max(2, barRect.width * CGFloat(min(1, max(0, mf))))
                ctx.fill(Path(roundedRect: CGRect(x: barRect.minX, y: barRect.minY, width: fillW, height: 3), cornerRadius: 1.5),
                         with: .color(mf > 0.85 ? .orange : col.opacity(0.85)))
            }
            ctx.draw(Text(Self.clip(telemetryParts.joined(separator: " · "), Int(r.width / 5.8)))
                        .font(.system(size: 9.5, design: .monospaced)).foregroundColor(.white.opacity(0.65)),
                     at: CGPoint(x: r.minX + 14, y: r.minY + 78), anchor: .leading)
        }
        ctx.opacity = 1
    }

    static func clip(_ s: String, _ n: Int) -> String { FlowText.clip(s, n) }
}

enum FlowText {
    static func clip(_ s: String, _ n: Int) -> String { s.count > n ? String(s.prefix(max(1, n - 1))) + "…" : s }
}

/// Gantt strip: one row per node on a shared clock.
struct FlowTimelineStrip: View {
    var graph: FlowGraph
    var now: Double

    var body: some View {
        Canvas { ctx, size in
            ctx.fill(Path(CGRect(origin: .zero, size: size)), with: .color(FlowTheme.background))
            let starts = graph.nodes.compactMap(\.startedAt)
            guard let t0 = (starts + [graph.sourceActiveAt].compactMap { $0 }).min() else { return }
            let end = max(graph.nodes.compactMap(\.finishedAt).max() ?? now, graph.isActive ? now : 0)
            let total = max(end - t0, 10)
            let labelW: CGFloat = 150
            let rowH = min(16, (size.height - 16) / CGFloat(max(graph.nodes.count, 1)))
            for (i, n) in graph.nodes.enumerated() {
                let y = 8 + CGFloat(i) * rowH
                ctx.draw(Text(FlowText.clip(n.title, 22)).font(.system(size: 10)).foregroundColor(.white.opacity(0.55)),
                         at: CGPoint(x: 16, y: y + rowH / 2), anchor: .leading)
                let track = CGRect(x: labelW, y: y + 3, width: size.width - labelW - 16, height: max(2, rowH - 6))
                ctx.fill(Path(roundedRect: track, cornerRadius: 3), with: .color(.white.opacity(0.04)))
                guard let s = n.startedAt else { continue }
                let e = n.finishedAt ?? now
                let bar = CGRect(x: track.minX + track.width * CGFloat((s - t0) / total), y: track.minY,
                                 width: max(2, track.width * CGFloat((e - s) / total)), height: track.height)
                ctx.fill(Path(roundedRect: bar, cornerRadius: 3), with: .color(n.status.color.opacity(0.8)))
            }
        }
    }
}
