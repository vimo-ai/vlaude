import SwiftUI
import UIKit
import QuartzCore
import Metal

private func mlog(_ msg: String) {
    NSLog("[MetalTerminalView] %@", msg)
}

class MetalTerminalView: UIView {
    private var sugarloafHandle: UnsafeMutableRawPointer?
    private var displayLink: CADisplayLink?

    override class var layerClass: AnyClass {
        CAMetalLayer.self
    }

    var metalLayer: CAMetalLayer {
        layer as! CAMetalLayer
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        guard let window = window else {
            mlog("removed from window, stopping")
            stopRendering()
            return
        }

        let scale = window.screen.scale
        metalLayer.contentsScale = scale
        metalLayer.device = MTLCreateSystemDefaultDevice()
        metalLayer.pixelFormat = .bgra8Unorm
        metalLayer.maximumDrawableCount = 3
        metalLayer.framebufferOnly = false

        mlog("didMoveToWindow: bounds=\(bounds), scale=\(scale), device=\(String(describing: metalLayer.device))")

        initSugarloafIfNeeded(scale: scale)
        startRendering()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let scale = window?.screen.scale ?? UIScreen.main.scale

        if sugarloafHandle == nil && bounds.width > 0 && bounds.height > 0 {
            mlog("layoutSubviews: retry init, bounds=\(bounds)")
            initSugarloafIfNeeded(scale: scale)
        }

        if let handle = sugarloafHandle, bounds.width > 0 && bounds.height > 0 {
            metalLayer.drawableSize = CGSize(
                width: bounds.width * scale,
                height: bounds.height * scale
            )
            sugarloaf_ios_resize(handle, Float(bounds.width), Float(bounds.height))
        }
    }

    private func initSugarloafIfNeeded(scale: CGFloat) {
        guard sugarloafHandle == nil, bounds.width > 0, bounds.height > 0 else {
            return
        }

        metalLayer.drawableSize = CGSize(
            width: bounds.width * scale,
            height: bounds.height * scale
        )

        let viewPtr = Unmanaged.passUnretained(self).toOpaque()
        mlog("sugarloaf_ios_create: viewPtr=\(viewPtr), size=\(bounds.width)x\(bounds.height), scale=\(scale)")
        sugarloafHandle = sugarloaf_ios_create(
            viewPtr,
            Float(bounds.width),
            Float(bounds.height),
            Float(scale)
        )
        mlog("sugarloaf_ios_create returned: handle=\(sugarloafHandle != nil ? "OK" : "NULL")")
    }

    private func startRendering() {
        guard displayLink == nil else { return }
        let link = CADisplayLink(target: self, selector: #selector(renderFrame))
        link.preferredFrameRateRange = CAFrameRateRange(minimum: 30, maximum: 60, preferred: 60)
        link.add(to: .main, forMode: .common)
        displayLink = link
        mlog("displayLink started")
    }

    private func stopRendering() {
        displayLink?.invalidate()
        displayLink = nil
    }

    private var renderLogCount = 0

    @objc private func renderFrame() {
        guard let handle = sugarloafHandle else { return }
        let ok = sugarloaf_ios_render(handle)
        renderLogCount += 1
        if renderLogCount <= 5 || renderLogCount % 120 == 0 {
            NSLog("[MetalTerminalView] render #%d result=%@", renderLogCount, ok ? "true" : "false")
        }
    }

    deinit {
        stopRendering()
        if let handle = sugarloafHandle {
            sugarloaf_ios_destroy(handle)
        }
    }
}

struct SugarloafTerminalView: UIViewRepresentable {
    func makeUIView(context: Context) -> MetalTerminalView {
        let view = MetalTerminalView()
        view.backgroundColor = UIColor(red: 0.1, green: 0.1, blue: 0.12, alpha: 1.0)
        return view
    }

    func updateUIView(_ uiView: MetalTerminalView, context: Context) {}
}

struct TerminalDemoView: View {
    var body: some View {
        SugarloafTerminalView()
            .ignoresSafeArea()
            .navigationTitle("Terminal")
            .navigationBarTitleDisplayMode(.inline)
    }
}
