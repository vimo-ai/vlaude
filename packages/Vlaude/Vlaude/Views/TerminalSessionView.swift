//
//  TerminalSessionView.swift
//  Vlaude
//
//  Full terminal session view: connects to pty-daemon via WebSocket,
//  displays terminal output in MetalTerminalView, and sends keyboard
//  input back to the PTY.
//
//  Flow:
//  1. User enters host address (or uses discovered host)
//  2. WebSocket connects to ws://<host>:7685
//  3. Lists available sessions, user picks one (or creates new)
//  4. Attaches — binary frames flow bidirectionally
//

import SwiftUI
import Combine

// MARK: - Terminal Session View

struct TerminalSessionView: View {
    @StateObject private var wsClient = TerminalWebSocketClient()
    @State private var hostInput: String = ""
    @State private var portInput: String = "7685"
    @State private var errorMessage: String?
    @State private var showSessionPicker = false

    /// Tracks whether the current attach was via takeover (for status display)
    @State private var didTakeOver = false

    /// Bridge for sending PTY output data to the terminal renderer
    private let terminalBridge = TerminalViewBridge()

    var body: some View {
        ZStack {
            // Terminal rendering layer (always present, may be black if not attached)
            terminalLayer

            // Overlay UI based on connection state
            switch wsClient.connectionState {
            case .disconnected:
                connectOverlay

            case .connecting, .reconnecting:
                connectingOverlay

            case .connected:
                sessionPickerOverlay

            case .attached:
                // Terminal is active — show status bar overlay at top
                attachedOverlay
            }
        }
        .ignoresSafeArea(.container, edges: .bottom)
        .navigationTitle("Remote Terminal")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .navigationBarTrailing) {
                connectionStatusIcon
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in
            // Keyboard appeared — terminal view handles this via first responder
        }
    }

    // MARK: - Terminal Layer

    private var terminalLayer: some View {
        SugarloafTerminalView(
            onInput: { data in
                wsClient.sendInput(data)
            },
            onScaleChange: { scale in
                // Could notify sugarloaf to adjust font size
                NSLog("[TerminalSession] scale changed: %.2f", scale)
            },
            onScroll: { deltaY in
                // Could send scroll-back commands if supported
                NSLog("[TerminalSession] scroll delta: %.1f", deltaY)
            },
            autoFocus: wsClient.attachedSessionId != nil,
            bridge: terminalBridge
        )
    }

    // MARK: - Connect Overlay

    private var connectOverlay: some View {
        ZStack {
            Color.black.opacity(0.9)
                .ignoresSafeArea()

            VStack(spacing: 24) {
                Image(systemName: "terminal")
                    .font(.system(size: 48))
                    .foregroundColor(.green)

                Text("Remote Terminal")
                    .font(.title2)
                    .fontWeight(.bold)
                    .foregroundColor(.white)

                Text("Connect to your Mac's pty-daemon")
                    .font(.subheadline)
                    .foregroundColor(.gray)

                VStack(spacing: 12) {
                    HStack {
                        TextField("Host (e.g., 192.168.1.100)", text: $hostInput)
                            .textFieldStyle(.roundedBorder)
                            .keyboardType(.URL)
                            .autocorrectionDisabled()
                            .textInputAutocapitalization(.never)

                        Text(":")
                            .foregroundColor(.gray)

                        TextField("Port", text: $portInput)
                            .textFieldStyle(.roundedBorder)
                            .keyboardType(.numberPad)
                            .frame(width: 70)
                    }
                    .padding(.horizontal, 24)

                    if let error = errorMessage {
                        Text(error)
                            .font(.caption)
                            .foregroundColor(.red)
                    }

                    Button(action: connectToDaemon) {
                        HStack {
                            Image(systemName: "link")
                            Text("Connect")
                        }
                        .font(.headline)
                        .foregroundColor(.white)
                        .frame(width: 160, height: 44)
                        .background(hostInput.isEmpty ? Color.gray : Color.blue)
                        .cornerRadius(22)
                    }
                    .disabled(hostInput.isEmpty)
                }
            }
        }
    }

    // MARK: - Connecting Overlay

    private var connectingOverlay: some View {
        ZStack {
            Color.black.opacity(0.9)
                .ignoresSafeArea()

            VStack(spacing: 20) {
                ProgressView()
                    .progressViewStyle(CircularProgressViewStyle(tint: .green))
                    .scaleEffect(1.5)

                if case .reconnecting(let attempt) = wsClient.connectionState {
                    Text("Reconnecting... (attempt \(attempt))")
                        .font(.headline)
                        .foregroundColor(.white)
                } else {
                    Text("Connecting to \(hostInput)...")
                        .font(.headline)
                        .foregroundColor(.white)
                }

                Button("Cancel") {
                    wsClient.disconnect()
                }
                .foregroundColor(.red)
            }
        }
    }

    // MARK: - Session Picker Overlay

    private var sessionPickerOverlay: some View {
        ZStack {
            Color.black.opacity(0.85)
                .ignoresSafeArea()

            VStack(spacing: 16) {
                HStack {
                    Text("PTY Sessions")
                        .font(.title3)
                        .fontWeight(.bold)
                        .foregroundColor(.white)

                    Spacer()

                    Button(action: { wsClient.listSessions() }) {
                        Image(systemName: "arrow.clockwise")
                            .foregroundColor(.green)
                    }
                }
                .padding(.horizontal, 20)

                if wsClient.availableSessions.isEmpty {
                    VStack(spacing: 12) {
                        Text("No active sessions")
                            .foregroundColor(.gray)

                        Button(action: createNewSession) {
                            HStack {
                                Image(systemName: "plus.circle.fill")
                                Text("Create New Session")
                            }
                            .font(.headline)
                            .foregroundColor(.white)
                            .frame(height: 44)
                            .frame(maxWidth: .infinity)
                            .background(Color.green.opacity(0.8))
                            .cornerRadius(12)
                        }
                        .padding(.horizontal, 20)
                    }
                    .padding(.top, 40)
                } else {
                    ScrollView {
                        VStack(spacing: 8) {
                            ForEach(wsClient.availableSessions) { session in
                                PTYSessionRow(
                                    session: session,
                                    isTakingOver: wsClient.isTakingOver,
                                    onAttach: {
                                        didTakeOver = false
                                        wsClient.attachSession(sessionId: session.id)
                                    },
                                    onTakeOver: {
                                        takeOverSession(sessionId: session.id)
                                    }
                                )
                            }
                        }
                        .padding(.horizontal, 20)
                    }

                    Button(action: createNewSession) {
                        HStack {
                            Image(systemName: "plus.circle.fill")
                            Text("New Session")
                        }
                        .font(.headline)
                        .foregroundColor(.white)
                        .frame(height: 44)
                        .frame(maxWidth: .infinity)
                        .background(Color.green.opacity(0.8))
                        .cornerRadius(12)
                    }
                    .padding(.horizontal, 20)
                }

                Spacer()

                Button(action: { wsClient.disconnect() }) {
                    Text("Disconnect")
                        .foregroundColor(.red)
                }
                .padding(.bottom, 20)
            }
            .padding(.top, 20)
        }
        .onAppear {
            wsClient.listSessions()
        }
    }

    // MARK: - Attached Overlay (minimal status bar)

    private var attachedOverlay: some View {
        VStack {
            // Translucent status bar at top
            HStack(spacing: 8) {
                Circle()
                    .fill(Color.green)
                    .frame(width: 8, height: 8)

                if let sid = wsClient.attachedSessionId {
                    Text(String(sid.prefix(8)))
                        .font(.caption)
                        .foregroundColor(.white.opacity(0.8))
                }

                Text("\(wsClient.attachedCols)x\(wsClient.attachedRows)")
                    .font(.caption)
                    .foregroundColor(.white.opacity(0.6))

                // Takeover indicator
                if didTakeOver {
                    Text("已接管 from ETerm")
                        .font(.caption2)
                        .fontWeight(.medium)
                        .foregroundColor(.orange)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Color.orange.opacity(0.2))
                        .cornerRadius(4)
                }

                Spacer()

                // Release button when session was taken over
                if didTakeOver {
                    Button(action: releaseCurrentSession) {
                        HStack(spacing: 4) {
                            Image(systemName: "arrow.uturn.backward")
                                .font(.caption2)
                            Text("释放")
                                .font(.caption2)
                        }
                        .foregroundColor(.yellow)
                    }
                    .padding(.trailing, 4)
                }

                Button(action: { wsClient.detachSession() }) {
                    Image(systemName: "rectangle.portrait.and.arrow.right")
                        .font(.caption)
                        .foregroundColor(.orange)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(.ultraThinMaterial.opacity(0.6))

            Spacer()
        }
    }

    // MARK: - Connection Status Icon

    private var connectionStatusIcon: some View {
        Group {
            switch wsClient.connectionState {
            case .disconnected:
                Image(systemName: "wifi.slash")
                    .foregroundColor(.red)
            case .connecting, .reconnecting:
                ProgressView()
                    .scaleEffect(0.7)
            case .connected:
                if wsClient.isTakingOver {
                    ProgressView()
                        .scaleEffect(0.7)
                } else {
                    Image(systemName: "wifi")
                        .foregroundColor(.yellow)
                }
            case .attached:
                if didTakeOver {
                    Image(systemName: "wifi.circle.fill")
                        .foregroundColor(.orange)
                } else {
                    Image(systemName: "wifi")
                        .foregroundColor(.green)
                }
            }
        }
    }

    // MARK: - Actions

    private func connectToDaemon() {
        errorMessage = nil
        let port = UInt16(portInput) ?? 7685
        wsClient.connect(host: hostInput, port: port)

        // Feed PTY output bytes into the terminal emulator for rendering.
        // The bridge forwards data to MetalTerminalView -> sugarloaf_ios_write_pty FFI,
        // which parses ANSI sequences via Crosswords. The next render frame picks up
        // the updated grid content automatically.
        let bridge = terminalBridge
        wsClient.onPtyOutput = { data in
            bridge.writePtyData(data)
        }

        wsClient.onSessionEnded = { sessionId in
            NSLog("[TerminalSession] session ended: %@", sessionId)
        }

        wsClient.onControlResponse = { response in
            switch response {
            case .attachReady(_, let cols, let rows, _, let snapshot):
                // 1. Set grid to correct dimensions
                bridge.resizeGrid(cols: UInt32(cols), rows: UInt32(rows))
                // 2. Replay ring buffer history to reconstruct terminal state
                if let snapshot = snapshot,
                   let data = Data(base64Encoded: snapshot) {
                    bridge.writePtyData(data)
                }
                // 3. Force SIGWINCH so running programs redraw
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                    self.wsClient.updateWinsize(cols: cols, rows: rows)
                }
            case .winsizeUpdated:
                break
            case .error(let msg):
                NSLog("[TerminalSession] control error: %@", msg)
            default:
                break
            }
        }
    }

    private func createNewSession() {
        wsClient.createSession(cols: 80, rows: 24)

        // After creation, auto-attach to the newly created session.
        // The onControlResponse callback is set to handle both create and error.
        let client = wsClient
        let bridge = terminalBridge
        client.onControlResponse = { response in
            switch response {
            case .created(let sessionId):
                client.attachSession(sessionId: sessionId)
            case .attachReady(_, let cols, let rows, _, let snapshot):
                bridge.resizeGrid(cols: UInt32(cols), rows: UInt32(rows))
                if let snapshot = snapshot,
                   let data = Data(base64Encoded: snapshot) {
                    bridge.writePtyData(data)
                }
            case .error:
                // Error is already logged by the WebSocket client
                break
            default:
                break
            }
        }
    }

    /// Force-detach ETerm from the session and attach iPhone instead
    private func takeOverSession(sessionId: String) {
        let bridge = terminalBridge
        let client = wsClient

        client.onControlResponse = { response in
            switch response {
            case .attachReady(_, let cols, let rows, _, let snapshot):
                // 1. Set grid to correct dimensions
                bridge.resizeGrid(cols: UInt32(cols), rows: UInt32(rows))
                // 2. Replay ring buffer history to reconstruct terminal state
                if let snapshot = snapshot,
                   let data = Data(base64Encoded: snapshot) {
                    bridge.writePtyData(data)
                }
                self.didTakeOver = true
                // 3. Force SIGWINCH so running programs redraw
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                    client.updateWinsize(cols: cols, rows: rows)
                }
            case .error(let msg):
                NSLog("[TerminalSession] takeover error: %@", msg)
            default:
                break
            }
        }

        client.takeOverSession(sessionId: sessionId)
    }

    /// Release a taken-over session back (detach iPhone, let ETerm re-attach)
    private func releaseCurrentSession() {
        guard let sid = wsClient.attachedSessionId else { return }
        didTakeOver = false
        wsClient.releaseSession(sessionId: sid)
    }
}

// MARK: - Session Row

private struct PTYSessionRow: View {
    let session: PTYSessionInfo
    let isTakingOver: Bool
    let onAttach: () -> Void
    let onTakeOver: () -> Void

    /// Whether this session is occupied by ETerm (or another local client)
    private var isAttached: Bool {
        session.state == "Attached"
    }

    /// State display info: (label, color, icon)
    private var stateDisplay: (label: String, color: Color, icon: String) {
        switch session.state {
        case "Attached":
            return ("ETerm 占用中", .orange, "person.fill")
        case "Active":
            return ("活跃", .green, "bolt.fill")
        case "Idle":
            return ("空闲", .gray, "moon.fill")
        default:
            return (session.state, .gray, "circle.fill")
        }
    }

    var body: some View {
        HStack(spacing: 12) {
            // State icon replaces simple circle
            Image(systemName: stateDisplay.icon)
                .font(.caption)
                .foregroundColor(stateDisplay.color)
                .frame(width: 16, height: 16)

            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(String(session.id.prefix(8)))
                        .font(.system(.body, design: .monospaced))
                        .foregroundColor(.white)

                    // State badge
                    Text(stateDisplay.label)
                        .font(.caption2)
                        .fontWeight(.medium)
                        .foregroundColor(stateDisplay.color)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .background(stateDisplay.color.opacity(0.15))
                        .cornerRadius(4)
                }

                HStack(spacing: 8) {
                    Text("\(session.cols)x\(session.rows)")
                        .font(.caption2)
                        .foregroundColor(.gray)

                    Text("PID: \(session.child_pid)")
                        .font(.caption2)
                        .foregroundColor(.gray)

                    Text(formatAge(session.last_active_secs_ago))
                        .font(.caption2)
                        .foregroundColor(.gray)
                }
            }

            Spacer()

            // Action button: "Take Over" for Attached sessions, normal "Attach" otherwise
            if isAttached {
                Button(action: onTakeOver) {
                    HStack(spacing: 4) {
                        if isTakingOver {
                            ProgressView()
                                .scaleEffect(0.6)
                                .frame(width: 16, height: 16)
                        } else {
                            Image(systemName: "hand.raised.fill")
                                .font(.caption)
                        }
                        Text("接管")
                            .font(.caption)
                            .fontWeight(.medium)
                    }
                    .foregroundColor(.white)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(Color.orange)
                    .cornerRadius(8)
                }
                .disabled(isTakingOver)
            } else {
                Button(action: onAttach) {
                    Image(systemName: "arrow.right.circle.fill")
                        .foregroundColor(.green)
                        .font(.title3)
                }
            }
        }
        .padding(12)
        .background(isAttached ? Color.orange.opacity(0.06) : Color.white.opacity(0.08))
        .cornerRadius(10)
        .overlay(
            // Subtle border for attached sessions
            RoundedRectangle(cornerRadius: 10)
                .strokeBorder(isAttached ? Color.orange.opacity(0.3) : Color.clear, lineWidth: 1)
        )
    }

    private func formatAge(_ seconds: UInt64) -> String {
        if seconds < 60 { return "\(seconds)s ago" }
        if seconds < 3600 { return "\(seconds / 60)m ago" }
        return "\(seconds / 3600)h ago"
    }
}

// MARK: - TerminalDemoView (backwards compatibility)

struct TerminalDemoView: View {
    var body: some View {
        TerminalSessionView()
    }
}
