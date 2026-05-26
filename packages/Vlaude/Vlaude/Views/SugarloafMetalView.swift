import SwiftUI
import UIKit
import QuartzCore
import Metal

private func mlog(_ msg: String) {
    NSLog("[MetalTerminalView] %@", msg)
}

// MARK: - MetalTerminalView

/// Metal-backed terminal view with keyboard input and touch gesture support.
/// - Tap: focus the view (show software keyboard)
/// - Pinch: zoom (adjust content scale)
/// - Pan (two-finger): terminal scrollback
/// - Software keyboard: captured via UITextInput protocol
/// - Hardware keyboard: captured via UIKeyCommand overrides
class MetalTerminalView: UIView, UITextInput, TerminalKeyResponder {

    // MARK: - Metal / Sugarloaf

    private var sugarloafHandle: UnsafeMutableRawPointer?
    private var displayLink: CADisplayLink?

    override class var layerClass: AnyClass {
        CAMetalLayer.self
    }

    var metalLayer: CAMetalLayer {
        layer as! CAMetalLayer
    }

    // MARK: - Input Callback

    /// Called when the user types something (software or hardware keyboard).
    /// The host should forward this data to TerminalWebSocketClient.sendInput(_:).
    var onInput: ((Data) -> Void)?

    /// Called when a pinch gesture changes the font scale factor.
    /// Parameter: the new cumulative scale factor (starts at 1.0).
    var onScaleChange: ((CGFloat) -> Void)?

    /// Called when a two-finger pan gesture scrolls.
    /// Parameter: vertical delta in points (positive = scroll up / back in history).
    var onScroll: ((CGFloat) -> Void)?

    // MARK: - State

    private var contentScale: CGFloat = 1.0
    private var _isFocused = false

    // MARK: - UITextInput Plumbing

    // These are required by UITextInput but largely unused for terminal input.
    // The terminal doesn't have a traditional text model — we just capture keystrokes.

    var markedTextRange: UITextRange?
    var markedTextStyle: [NSAttributedString.Key: Any]?
    var selectedTextRange: UITextRange?
    var beginningOfDocument: UITextPosition { TerminalTextPosition(offset: 0) }
    var endOfDocument: UITextPosition { TerminalTextPosition(offset: 0) }
    var inputDelegate: (any UITextInputDelegate)?
    var tokenizer: any UITextInputTokenizer { UITextInputStringTokenizer(textInput: self) }
    var hasText: Bool { false }

    // MARK: - Initialization

    override init(frame: CGRect) {
        super.init(frame: frame)
        commonInit()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        commonInit()
    }

    private func commonInit() {
        isUserInteractionEnabled = true
        isMultipleTouchEnabled = true

        // Tap to focus
        let tap = UITapGestureRecognizer(target: self, action: #selector(handleTap(_:)))
        addGestureRecognizer(tap)

        // Pinch to zoom
        let pinch = UIPinchGestureRecognizer(target: self, action: #selector(handlePinch(_:)))
        addGestureRecognizer(pinch)

        // Two-finger pan for scrollback
        let pan = UIPanGestureRecognizer(target: self, action: #selector(handlePan(_:)))
        pan.minimumNumberOfTouches = 2
        pan.maximumNumberOfTouches = 2
        addGestureRecognizer(pan)
    }

    // MARK: - First Responder

    override var canBecomeFirstResponder: Bool { true }

    override func becomeFirstResponder() -> Bool {
        let result = super.becomeFirstResponder()
        if result {
            _isFocused = true
            mlog("became first responder (keyboard visible)")
        }
        return result
    }

    override func resignFirstResponder() -> Bool {
        let result = super.resignFirstResponder()
        if result {
            _isFocused = false
            mlog("resigned first responder")
        }
        return result
    }

    override var isFocused: Bool { _isFocused }

    // MARK: - Software Keyboard (UITextInput)

    func insertText(_ text: String) {
        let data = TerminalInputHandler.bytesForText(text)
        onInput?(data)
    }

    func deleteBackward() {
        onInput?(TerminalInputHandler.backspace)
    }

    // UITextInput required stubs — terminal has no text model to query

    func text(in range: UITextRange) -> String? { nil }

    func replace(_ range: UITextRange, withText text: String) {
        // Forward replacement as regular input
        insertText(text)
    }

    func setMarkedText(_ markedText: String?, selectedRange: NSRange) {
        // IME marked text — send immediately for terminal
        if let text = markedText, !text.isEmpty {
            insertText(text)
        }
    }

    func unmarkText() {}

    func textRange(from fromPosition: UITextPosition, to toPosition: UITextPosition) -> UITextRange? { nil }

    func position(from position: UITextPosition, offset: Int) -> UITextPosition? {
        TerminalTextPosition(offset: 0)
    }

    func position(from position: UITextPosition, in direction: UITextLayoutDirection, offset: Int) -> UITextPosition? {
        TerminalTextPosition(offset: 0)
    }

    func compare(_ position: UITextPosition, to other: UITextPosition) -> ComparisonResult { .orderedSame }

    func offset(from: UITextPosition, to toPosition: UITextPosition) -> Int { 0 }

    func position(within range: UITextRange, farthestIn direction: UITextLayoutDirection) -> UITextPosition? { nil }

    func characterRange(byExtending position: UITextPosition, in direction: UITextLayoutDirection) -> UITextRange? { nil }

    func baseWritingDirection(for position: UITextPosition, in direction: UITextStorageDirection) -> NSWritingDirection { .leftToRight }

    func setBaseWritingDirection(_ writingDirection: NSWritingDirection, for range: UITextRange) {}

    func firstRect(for range: UITextRange) -> CGRect { .zero }

    func caretRect(for position: UITextPosition) -> CGRect {
        // Return a rect near the bottom of the view so the keyboard doesn't
        // obscure the terminal content more than necessary.
        CGRect(x: 0, y: bounds.height - 2, width: 2, height: 16)
    }

    func selectionRects(for range: UITextRange) -> [UITextSelectionRect] { [] }

    func closestPosition(to point: CGPoint) -> UITextPosition? {
        TerminalTextPosition(offset: 0)
    }

    func closestPosition(to point: CGPoint, within range: UITextRange) -> UITextPosition? {
        TerminalTextPosition(offset: 0)
    }

    func characterRange(at point: CGPoint) -> UITextRange? { nil }

    // MARK: - Hardware Keyboard (UIKeyCommand)

    override var keyCommands: [UIKeyCommand]? {
        TerminalInputHandler.terminalKeyCommands()
    }

    @objc func handleTerminalKeyCommand(_ sender: UIKeyCommand) {
        if let data = TerminalInputHandler.bytesForKeyCommand(sender) {
            onInput?(data)
        }
    }

    // MARK: - Gesture Handlers

    @objc private func handleTap(_ gesture: UITapGestureRecognizer) {
        if !isFirstResponder {
            becomeFirstResponder()
        }
    }

    private var panOffsetX: CGFloat = 0
    private var panOffsetY: CGFloat = 0

    @objc private func handlePinch(_ gesture: UIPinchGestureRecognizer) {
        switch gesture.state {
        case .changed:
            contentScale *= gesture.scale
            contentScale = max(0.5, min(contentScale, 5.0))
            gesture.scale = 1.0
            updateRenderTransform()
            onScaleChange?(contentScale)

        case .ended, .cancelled:
            mlog("pinch ended, scale=\(contentScale)")

        default:
            break
        }
    }

    private var lastPanX: CGFloat = 0
    private var lastPanY: CGFloat = 0

    @objc private func handlePan(_ gesture: UIPanGestureRecognizer) {
        switch gesture.state {
        case .began:
            lastPanX = 0
            lastPanY = 0

        case .changed:
            let translation = gesture.translation(in: self)
            panOffsetX += translation.x - lastPanX
            panOffsetY += translation.y - lastPanY
            lastPanX = translation.x
            lastPanY = translation.y
            updateRenderTransform()
            onScroll?(translation.y - lastPanY)

        default:
            lastPanX = 0
            lastPanY = 0
        }
    }

    private func updateRenderTransform() {
        setRenderTransform(
            userScale: Float(contentScale),
            offsetX: Float(panOffsetX),
            offsetY: Float(panOffsetY)
        )
    }

    // MARK: - Keyboard Appearance

    override var textInputContextIdentifier: String? { "terminal" }

    // Use a dark keyboard appearance
    var keyboardAppearance: UIKeyboardAppearance { .dark }

    var keyboardType: UIKeyboardType {
        get { .default }
        set {}
    }

    var autocorrectionType: UITextAutocorrectionType {
        get { .no }
        set {}
    }

    var autocapitalizationType: UITextAutocapitalizationType {
        get { .none }
        set {}
    }

    var smartQuotesType: UITextSmartQuotesType {
        get { .no }
        set {}
    }

    var smartDashesType: UITextSmartDashesType {
        get { .no }
        set {}
    }

    var smartInsertDeleteType: UITextSmartInsertDeleteType {
        get { .no }
        set {}
    }

    var spellCheckingType: UITextSpellCheckingType {
        get { .no }
        set {}
    }

    // MARK: - PTY Data Bridge

    /// Feed raw PTY output bytes to the terminal emulator (Crosswords ANSI parser).
    /// Called from the WebSocket client when binary frames arrive.
    func writePtyData(_ data: Data) {
        guard let handle = sugarloafHandle else { return }
        data.withUnsafeBytes { rawBuffer in
            guard let ptr = rawBuffer.baseAddress?.assumingMemoryBound(to: UInt8.self) else { return }
            sugarloaf_ios_write_pty(handle, ptr, rawBuffer.count)
        }
    }

    /// Resize the terminal grid to new column/row dimensions.
    func resizeGrid(cols: UInt32, rows: UInt32) {
        guard let handle = sugarloafHandle else { return }
        sugarloaf_ios_resize_grid(handle, cols, rows)
    }

    /// Set the render transform (user scale + pan offset).
    func setRenderTransform(userScale: Float, offsetX: Float, offsetY: Float) {
        guard let handle = sugarloafHandle else { return }
        sugarloaf_ios_set_transform(handle, userScale, offsetX, offsetY)
    }

    // MARK: - Metal Rendering

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

// MARK: - UITextInput Helpers

/// Minimal UITextPosition implementation for UITextInput conformance
private class TerminalTextPosition: UITextPosition {
    let offset: Int
    init(offset: Int) {
        self.offset = offset
        super.init()
    }
}

/// Minimal UITextRange implementation for UITextInput conformance
private class TerminalTextRange: UITextRange {
    private let _start: TerminalTextPosition
    private let _end: TerminalTextPosition

    override var start: UITextPosition { _start }
    override var end: UITextPosition { _end }
    override var isEmpty: Bool { _start.offset == _end.offset }

    init(start: Int, end: Int) {
        _start = TerminalTextPosition(offset: start)
        _end = TerminalTextPosition(offset: end)
        super.init()
    }
}

// MARK: - TerminalViewBridge

/// Bridge object that allows SwiftUI parents to send PTY data to the
/// underlying MetalTerminalView. Create one, pass it to SugarloafTerminalView,
/// then call writePtyData/resizeGrid from the parent.
class TerminalViewBridge {
    fileprivate weak var metalView: MetalTerminalView?

    /// Feed raw PTY output bytes to the terminal renderer.
    func writePtyData(_ data: Data) {
        metalView?.writePtyData(data)
    }

    /// Resize the terminal grid dimensions.
    func resizeGrid(cols: UInt32, rows: UInt32) {
        metalView?.resizeGrid(cols: cols, rows: rows)
    }

    /// Set the render transform (user pinch zoom + pan offset).
    func setTransform(userScale: Float, offsetX: Float, offsetY: Float) {
        metalView?.setRenderTransform(userScale: userScale, offsetX: offsetX, offsetY: offsetY)
    }
}

// MARK: - SugarloafTerminalView (SwiftUI Bridge)

struct SugarloafTerminalView: UIViewRepresentable {
    /// Callback: keyboard/touch input data to send to PTY
    var onInput: ((Data) -> Void)?
    /// Callback: pinch-to-zoom scale change
    var onScaleChange: ((CGFloat) -> Void)?
    /// Callback: two-finger scroll delta
    var onScroll: ((CGFloat) -> Void)?
    /// Whether the view should automatically become first responder
    var autoFocus: Bool = false
    /// Bridge for feeding PTY data into the terminal renderer
    var bridge: TerminalViewBridge?

    func makeUIView(context: Context) -> MetalTerminalView {
        let view = MetalTerminalView()
        view.backgroundColor = UIColor(red: 0.1, green: 0.1, blue: 0.12, alpha: 1.0)
        view.onInput = onInput
        view.onScaleChange = onScaleChange
        view.onScroll = onScroll

        // Connect the bridge to the underlying Metal view
        bridge?.metalView = view

        if autoFocus {
            // Delay to allow view hierarchy to settle
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                view.becomeFirstResponder()
            }
        }

        return view
    }

    func updateUIView(_ uiView: MetalTerminalView, context: Context) {
        uiView.onInput = onInput
        uiView.onScaleChange = onScaleChange
        uiView.onScroll = onScroll

        // Re-connect bridge in case the view was recreated
        bridge?.metalView = uiView
    }
}
